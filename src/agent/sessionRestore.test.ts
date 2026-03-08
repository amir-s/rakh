import { beforeEach, describe, expect, it, vi } from "vitest";

const persistenceMock = vi.hoisted(() => ({
  loadArchivedSessions: vi.fn(),
  restoreSession: vi.fn(),
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

import { agentAtomFamily, jotaiStore } from "./atoms";
import type { PersistedSession } from "./persistence";
import {
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
    model: "openai/gpt-5.2",
    planMarkdown: "plan",
    planVersion: 2,
    planUpdatedAt: 100,
    chatMessages: JSON.stringify([{ role: "user", content: "hello" }]),
    apiMessages: JSON.stringify([{ role: "assistant", content: "world" }]),
    todos: JSON.stringify([{ id: "todo-1", text: "ship", status: "todo" }]),
    reviewEdits: JSON.stringify([{ filePath: "src/App.tsx" }]),
    archived: true,
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
    ...overrides,
  };
}

describe("sessionRestore", () => {
  beforeEach(() => {
    persistenceMock.loadArchivedSessions.mockReset();
    persistenceMock.restoreSession.mockReset();
  });

  it("restores an archived session into agent state and the tab strip", async () => {
    const session = makeSession("restore-session-1");
    const addTabWithId = vi.fn();

    persistenceMock.restoreSession.mockResolvedValue(undefined);

    await restoreArchivedTab(session, addTabWithId);

    expect(persistenceMock.restoreSession).toHaveBeenCalledWith(session);
    expect(addTabWithId).toHaveBeenCalledWith({
      id: session.id,
      label: session.label,
      icon: session.icon,
      status: "idle",
      mode: "workspace",
    });

    const state = jotaiStore.get(agentAtomFamily(session.id));
    expect(state.status).toBe("idle");
    expect(state.tabTitle).toBe(session.tabTitle);
    expect(state.config).toMatchObject({
      cwd: session.cwd,
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
    expect(state.todos).toEqual([{ id: "todo-1", text: "ship", status: "todo" }]);
    expect(state.reviewEdits).toEqual([{ filePath: "src/App.tsx" }]);
    expect(state.showDebug).toBe(true);
  });

  it("restores the most recent archived session from the archived list", async () => {
    const mostRecent = makeSession("restore-session-2");
    const older = makeSession("restore-session-3");
    const addTabWithId = vi.fn();

    persistenceMock.loadArchivedSessions.mockResolvedValue([mostRecent, older]);
    persistenceMock.restoreSession.mockResolvedValue(undefined);

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
});
