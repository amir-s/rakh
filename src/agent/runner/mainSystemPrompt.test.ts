import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../types";

const {
  toolContextCompactionEnabledAtomMock,
  globalCommunicationProfileAtomMock,
  profilesAtomMock,
  jotaiStoreMock,
  tauriInvokeMock,
  loadSavedProjectForWorkspaceMock,
} = vi.hoisted(() => ({
  toolContextCompactionEnabledAtomMock: {
    kind: "tool-context-compaction-enabled-atom",
  },
  globalCommunicationProfileAtomMock: {
    kind: "global-communication-profile-atom",
  },
  profilesAtomMock: { kind: "profiles-atom" },
  jotaiStoreMock: {
    get: vi.fn(),
  },
  tauriInvokeMock: vi.fn(),
  loadSavedProjectForWorkspaceMock: vi.fn(),
}));

vi.mock("../atoms", () => ({
  jotaiStore: jotaiStoreMock,
  toolContextCompactionEnabledAtom: toolContextCompactionEnabledAtomMock,
  globalCommunicationProfileAtom: globalCommunicationProfileAtomMock,
}));

vi.mock("../db", () => ({
  profilesAtom: profilesAtomMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => tauriInvokeMock(...args),
}));

vi.mock("@/projects", async () => {
  const actual = await vi.importActual<typeof import("@/projects")>("@/projects");
  return {
    ...actual,
    loadSavedProjectForWorkspace: (...args: unknown[]) =>
      loadSavedProjectForWorkspaceMock(...args),
  };
});

import {
  buildMainSystemPromptForState,
  clearMainSystemPromptCache,
} from "./mainSystemPrompt";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    status: "idle",
    config: {
      cwd: "/repo",
      model: "openai/gpt-5.2",
      communicationProfile: "pragmatic",
    },
    turnCount: 0,
    chatMessages: [],
    apiMessages: [],
    streamingContent: null,
    plan: { markdown: "", updatedAtMs: 0, version: 0 },
    todos: [],
    error: null,
    errorDetails: null,
    errorAction: null,
    tabTitle: "",
    reviewEdits: [],
    autoApproveEdits: false,
    autoApproveCommands: "no",
    groupInlineToolCallsOverride: null,
    queuedMessages: [],
    queueState: "idle",
    llmUsageLedger: [],
    loopLimitWarning: null,
    ...overrides,
  };
}

describe("buildMainSystemPromptForState", () => {
  let toolContextCompactionEnabled = true;
  let profiles = [
    {
      id: "pragmatic",
      name: "Pragmatic",
      promptSnippet: "Be pragmatic.",
    },
    {
      id: "friendly",
      name: "Friendly",
      promptSnippet: "Use a warmer tone.",
    },
  ];
  let projectLearnedFacts = [{ id: "fact_pnpm", text: "Use pnpm in this repo." }];
  let workspaceCapabilities = {
    isGitRepo: true,
    hasAgentsFile: true,
    hasSkillsDir: true,
  };

  beforeEach(() => {
    clearMainSystemPromptCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T14:00:00.000Z"));

    toolContextCompactionEnabled = true;
    profiles = [
      {
        id: "pragmatic",
        name: "Pragmatic",
        promptSnippet: "Be pragmatic.",
      },
      {
        id: "friendly",
        name: "Friendly",
        promptSnippet: "Use a warmer tone.",
      },
    ];
    projectLearnedFacts = [
      { id: "fact_pnpm", text: "Use pnpm in this repo." },
    ];
    workspaceCapabilities = {
      isGitRepo: true,
      hasAgentsFile: true,
      hasSkillsDir: true,
    };

    jotaiStoreMock.get.mockImplementation((atom: unknown) => {
      if (atom === toolContextCompactionEnabledAtomMock) {
        return toolContextCompactionEnabled;
      }
      if (atom === globalCommunicationProfileAtomMock) {
        return "pragmatic";
      }
      if (atom === profilesAtomMock) {
        return profiles;
      }
      return null;
    });

    tauriInvokeMock.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "exec_run") {
          return { exitCode: workspaceCapabilities.isGitRepo ? 0 : 1 };
        }
        if (command === "stat_file") {
          if (args?.path === "/repo/AGENTS.md") {
            return {
              exists: workspaceCapabilities.hasAgentsFile,
              kind: workspaceCapabilities.hasAgentsFile ? "file" : undefined,
            };
          }
          if (args?.path === "/repo/.agents/skills") {
            return {
              exists: workspaceCapabilities.hasSkillsDir,
              kind: workspaceCapabilities.hasSkillsDir ? "dir" : undefined,
            };
          }
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    );

    loadSavedProjectForWorkspaceMock.mockImplementation(async () => ({
      path: "/repo",
      name: "Repo",
      icon: "folder",
      learnedFacts: projectLearnedFacts,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    clearMainSystemPromptCache();
    jotaiStoreMock.get.mockReset();
    tauriInvokeMock.mockReset();
    loadSavedProjectForWorkspaceMock.mockReset();
  });

  it("reuses identical prompt bytes across unchanged turns", async () => {
    const state = makeState();

    const firstPrompt = await buildMainSystemPromptForState("tab-stable", state);

    vi.setSystemTime(new Date("2026-03-19T18:45:00.000Z"));
    const secondPrompt = await buildMainSystemPromptForState("tab-stable", state);

    expect(secondPrompt).toBe(firstPrompt);
    expect(secondPrompt).toContain(
      "Current UTC timestamp: 2026-03-19T14:00:00.000Z",
    );
  });

  it("reuses the persisted runtime snapshot after cache reset", async () => {
    const state = makeState();
    const firstPrompt = await buildMainSystemPromptForState("tab-restore", state);

    clearMainSystemPromptCache("tab-restore");
    vi.setSystemTime(new Date("2026-03-20T09:30:00.000Z"));

    const restoredState = makeState({
      apiMessages: [{ role: "system", content: firstPrompt }],
    });
    const restoredPrompt = await buildMainSystemPromptForState(
      "tab-restore",
      restoredState,
    );

    expect(restoredPrompt).toBe(firstPrompt);
    expect(restoredPrompt).toContain(
      "Current UTC timestamp: 2026-03-19T14:00:00.000Z",
    );
  });

  it("invalidates the cached prompt when project memory changes", async () => {
    const state = makeState();
    const firstPrompt = await buildMainSystemPromptForState("tab-memory", state);

    projectLearnedFacts = [
      { id: "fact_pnpm", text: "Use pnpm in this repo." },
      { id: "fact_tauri", text: "The backend uses Tauri." },
    ];
    vi.setSystemTime(new Date("2026-03-19T20:00:00.000Z"));

    const secondPrompt = await buildMainSystemPromptForState("tab-memory", state);

    expect(secondPrompt).not.toBe(firstPrompt);
    expect(secondPrompt).toContain("The backend uses Tauri.");
    expect(secondPrompt).toContain(
      "Current UTC timestamp: 2026-03-19T14:00:00.000Z",
    );
  });

  it("invalidates the cached prompt when the communication profile changes", async () => {
    const state = makeState();
    const firstPrompt = await buildMainSystemPromptForState("tab-profile", state);

    const nextState = makeState({
      config: {
        ...state.config,
        communicationProfile: "friendly",
      },
    });
    vi.setSystemTime(new Date("2026-03-19T20:00:00.000Z"));

    const secondPrompt = await buildMainSystemPromptForState(
      "tab-profile",
      nextState,
    );

    expect(secondPrompt).not.toBe(firstPrompt);
    expect(firstPrompt).toContain("Be pragmatic.");
    expect(secondPrompt).toContain("Use a warmer tone.");
    expect(secondPrompt).toContain(
      "Current UTC timestamp: 2026-03-19T14:00:00.000Z",
    );
  });

  it("invalidates the cached prompt when tool-context compaction changes", async () => {
    const state = makeState();
    const firstPrompt = await buildMainSystemPromptForState(
      "tab-compaction",
      state,
    );

    toolContextCompactionEnabled = false;
    vi.setSystemTime(new Date("2026-03-19T20:00:00.000Z"));

    const secondPrompt = await buildMainSystemPromptForState(
      "tab-compaction",
      state,
    );

    expect(secondPrompt).not.toBe(firstPrompt);
    expect(firstPrompt).toContain("TOOL IO CONTEXT COMPACTION");
    expect(secondPrompt).not.toContain("TOOL IO CONTEXT COMPACTION");
    expect(secondPrompt).toContain(
      "Current UTC timestamp: 2026-03-19T14:00:00.000Z",
    );
  });

  it("invalidates the cached prompt when workspace capabilities change", async () => {
    const state = makeState();
    const firstPrompt = await buildMainSystemPromptForState(
      "tab-capabilities",
      state,
    );

    workspaceCapabilities = {
      isGitRepo: false,
      hasAgentsFile: false,
      hasSkillsDir: false,
    };
    vi.setSystemTime(new Date("2026-03-19T20:00:00.000Z"));

    const secondPrompt = await buildMainSystemPromptForState(
      "tab-capabilities",
      state,
    );

    expect(secondPrompt).not.toBe(firstPrompt);
    expect(firstPrompt).toContain("GIT ISOLATION");
    expect(firstPrompt).toContain("Check AGENTS.md in the root");
    expect(firstPrompt).toContain("Check .agents/skills");
    expect(secondPrompt).not.toContain("GIT ISOLATION");
    expect(secondPrompt).not.toContain("Check AGENTS.md in the root");
    expect(secondPrompt).not.toContain("Check .agents/skills");
    expect(secondPrompt).toContain(
      "Current UTC timestamp: 2026-03-19T14:00:00.000Z",
    );
  });
});
