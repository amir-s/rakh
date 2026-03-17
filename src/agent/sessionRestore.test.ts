import { beforeEach, describe, expect, it, vi } from "vitest";

const persistenceMock = vi.hoisted(() => ({
  loadArchivedSessions: vi.fn(),
  restoreSession: vi.fn(),
}));

const todosMock = vi.hoisted(() => ({
  loadSessionTodos: vi.fn(),
}));

vi.mock("./persistence", async () => {
  const actual = await vi.importActual<typeof import("./persistence")>(
    "./persistence",
  );

  return {
    ...actual,
    loadArchivedSessions: (...args: unknown[]) =>
      persistenceMock.loadArchivedSessions(...args),
    restoreSession: (...args: unknown[]) =>
      persistenceMock.restoreSession(...args),
  };
});

vi.mock("./tools/todos", () => ({
  loadSessionTodos: (...args: unknown[]) => todosMock.loadSessionTodos(...args),
}));

import { agentAtomFamily, jotaiStore } from "./atoms";
import { providersAtom } from "./db";
import { registerDynamicModels } from "./modelCatalog";
import type { PersistedSession } from "./persistence";
import { summarizeSessionUsage } from "./sessionStats";
import {
  focusOrOpenPersistedSession,
  hydratePersistedSession,
  restoreArchivedTab,
  restoreMostRecentArchivedTab,
} from "./sessionRestore";

function makeSession(
  id: string,
  overrides: Partial<PersistedSession> = {},
): PersistedSession {
  return {
    id,
    label: "Workspace",
    icon: "folder",
    mode: "workspace",
    tabTitle: "Ship tab restore",
    cwd: "/repo",
    projectPath: "/repo",
    setupCommand: "npm install",
    model: "openai/gpt-5.2",
    turnCount: 0,
    planMarkdown: "plan",
    planVersion: 2,
    planUpdatedAt: 100,
    chatMessages: JSON.stringify([{ role: "user", content: "hello" }]),
    apiMessages: JSON.stringify([{ role: "assistant", content: "world" }]),
    reviewEdits: JSON.stringify([{ filePath: "src/App.tsx" }]),
    queuedMessages: JSON.stringify([
      { id: "queue-1", content: "follow up after restart", createdAtMs: 123 },
    ]),
    queueState: "draining",
    archived: true,
    pinned: true,
    createdAt: 1,
    updatedAt: 2,
    worktreePath: "/repo/.worktree",
    worktreeBranch: "codex/branch",
    worktreeDeclined: true,
    showDebug: true,
    advancedOptions: JSON.stringify({
      reasoningVisibility: "detailed",
      reasoningEffort: "high",
      latencyCostProfile: "fast",
    }),
    communicationProfile: "pragmatic",
    ...overrides,
    llmUsageLedger: overrides.llmUsageLedger ?? "[]",
  };
}

describe("sessionRestore", () => {
  beforeEach(() => {
    persistenceMock.loadArchivedSessions.mockReset();
    persistenceMock.restoreSession.mockReset();
    todosMock.loadSessionTodos.mockReset();
    jotaiStore.set(providersAtom, []);
    registerDynamicModels([]);
  });

  it("restores an archived session into agent state and the tab strip", async () => {
    const session = makeSession("restore-session-1");
    const addTabWithId = vi.fn();

    persistenceMock.restoreSession.mockResolvedValue(undefined);
    todosMock.loadSessionTodos.mockResolvedValue([
      {
        id: "todo-1",
        title: "ship",
        state: "todo",
        owner: "main",
        createdTurn: 1,
        updatedTurn: 1,
        lastTouchedTurn: 1,
        filesTouched: [],
        thingsLearned: [],
        criticalInfo: [],
        mutationLog: [],
      },
    ]);

    await restoreArchivedTab(session, addTabWithId);

    expect(persistenceMock.restoreSession).toHaveBeenCalledWith(session);
    expect(addTabWithId).toHaveBeenCalledWith({
      id: session.id,
      label: session.label,
      icon: session.icon,
      pinned: true,
      status: "idle",
      mode: "workspace",
    });

    const state = jotaiStore.get(agentAtomFamily(session.id));
    expect(state.status).toBe("idle");
    expect(state.tabTitle).toBe(session.tabTitle);
    expect(state.config).toMatchObject({
      cwd: session.cwd,
      projectPath: session.projectPath,
      setupCommand: session.setupCommand,
      model: session.model,
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch,
      worktreeDeclined: session.worktreeDeclined,
      advancedOptions: {
        reasoningVisibility: "detailed",
        reasoningEffort: "high",
        latencyCostProfile: "fast",
      },
    });
    expect(state.plan).toEqual({
      markdown: session.planMarkdown,
      version: session.planVersion,
      updatedAtMs: session.planUpdatedAt,
    });
    expect(state.chatMessages).toEqual([{ role: "user", content: "hello" }]);
    expect(state.apiMessages).toEqual([{ role: "assistant", content: "world" }]);
    expect(state.todos).toEqual([
      {
        id: "todo-1",
        title: "ship",
        state: "todo",
        owner: "main",
        createdTurn: 1,
        updatedTurn: 1,
        lastTouchedTurn: 1,
        filesTouched: [],
        thingsLearned: [],
        criticalInfo: [],
        mutationLog: [],
      },
    ]);
    expect(state.reviewEdits).toEqual([{ filePath: "src/App.tsx" }]);
    expect(state.queuedMessages).toEqual([
      { id: "queue-1", content: "follow up after restart", createdAtMs: 123 },
    ]);
    expect(state.queueState).toBe("paused");
    expect(state.showDebug).toBe(true);
  });

  it("refreshes live model metadata while hydrating restored sessions", () => {
    jotaiStore.set(providersAtom, [
      {
        id: "provider-compatible",
        name: "my-gateway",
        type: "openai-compatible",
        apiKey: "",
        baseUrl: "http://localhost:11434/v1",
        cachedModels: [
          {
            id: "meta/llama-3.3-70b",
            cost: { input: 0.15, output: 0.6 },
            limit: { context: 131072 },
          },
        ],
      },
    ]);

    const session = makeSession("restore-session-6", {
      model: "my-gateway/meta/llama-3.3-70b",
      llmUsageLedger: JSON.stringify([
        {
          id: "usage-1",
          timestamp: 1,
          modelId: "my-gateway/meta/llama-3.3-70b",
          actorKind: "main",
          actorId: "main",
          actorLabel: "Rakh",
          operation: "assistant turn",
          inputTokens: 1000,
          noCacheInputTokens: 1000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 500,
          reasoningTokens: 0,
          totalTokens: 1500,
        },
      ]),
    });

    hydratePersistedSession(session, { todos: [] });

    const state = jotaiStore.get(agentAtomFamily(session.id));
    const summary = summarizeSessionUsage(state.llmUsageLedger);

    expect(state.config.contextLength).toBe(131072);
    expect(summary?.costStatus).toBe("complete");
    expect(summary?.knownCostUsd).toBeCloseTo(0.00045, 8);
  });

  it("restores the most recent archived session from the archived list", async () => {
    const mostRecent = makeSession("restore-session-2");
    const older = makeSession("restore-session-3");
    const addTabWithId = vi.fn();

    persistenceMock.loadArchivedSessions.mockResolvedValue([mostRecent, older]);
    persistenceMock.restoreSession.mockResolvedValue(undefined);
    todosMock.loadSessionTodos.mockResolvedValue([]);

    const restored = await restoreMostRecentArchivedTab(addTabWithId);

    expect(restored).toEqual(mostRecent);
    expect(persistenceMock.restoreSession).toHaveBeenCalledWith(mostRecent);
    expect(addTabWithId).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there are no archived sessions to restore", async () => {
    const addTabWithId = vi.fn();

    persistenceMock.loadArchivedSessions.mockResolvedValue([]);

    const restored = await restoreMostRecentArchivedTab(addTabWithId);

    expect(restored).toBeNull();
    expect(persistenceMock.restoreSession).not.toHaveBeenCalled();
    expect(addTabWithId).not.toHaveBeenCalled();
  });

  it("focuses an already-open tab instead of restoring it again", async () => {
    const session = makeSession("restore-session-4");
    const addTabWithId = vi.fn();
    const setActiveTab = vi.fn();

    const result = await focusOrOpenPersistedSession(session, {
      addTabWithId,
      setActiveTab,
      tabs: [{ id: session.id, label: "Workspace", icon: "folder", status: "idle", mode: "workspace" }],
    });

    expect(result).toBe("focused");
    expect(setActiveTab).toHaveBeenCalledWith(session.id);
    expect(persistenceMock.restoreSession).not.toHaveBeenCalled();
    expect(addTabWithId).not.toHaveBeenCalled();
  });

  it("opens a non-archived persisted session without calling restoreSession", async () => {
    const session = makeSession("restore-session-5", { archived: false });
    const addTabWithId = vi.fn();
    const setActiveTab = vi.fn();
    todosMock.loadSessionTodos.mockResolvedValue([]);

    const result = await focusOrOpenPersistedSession(session, {
      addTabWithId,
      setActiveTab,
      tabs: [],
    });

    expect(result).toBe("opened");
    expect(persistenceMock.restoreSession).not.toHaveBeenCalled();
    expect(addTabWithId).toHaveBeenCalledWith({
      id: session.id,
      label: session.label,
      icon: session.icon,
      pinned: true,
      status: "idle",
      mode: "workspace",
    });
    expect(setActiveTab).not.toHaveBeenCalled();
  });
});
