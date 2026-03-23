import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../types";

const {
  globalCommunicationProfileAtomMock,
  profilesAtomMock,
  jotaiStoreMock,
  tauriInvokeMock,
  loadSavedProjectForWorkspaceMock,
} = vi.hoisted(() => ({
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T14:00:00.000Z"));

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
    jotaiStoreMock.get.mockReset();
    tauriInvokeMock.mockReset();
    loadSavedProjectForWorkspaceMock.mockReset();
  });

  it("builds the session prompt from current startup state when no system prompt exists", async () => {
    const state = makeState();

    const prompt = await buildMainSystemPromptForState(state);

    expect(prompt).toContain("Workspace root: /repo");
    expect(prompt).toContain("Use pnpm in this repo.");
    expect(prompt).toContain("Be pragmatic.");
    expect(prompt).not.toContain("TOOL IO CONTEXT COMPACTION");
  });

  it("reuses the existing system prompt verbatim when forceRefresh is not requested", async () => {
    const initialPrompt = await buildMainSystemPromptForState(makeState());
    const state = makeState({
      config: {
        cwd: "/repo/worktree",
        model: "openai/gpt-5.2",
        communicationProfile: "friendly",
      },
      apiMessages: [{ role: "system", content: initialPrompt }],
    });

    projectLearnedFacts = [
      { id: "fact_pnpm", text: "Use pnpm in this repo." },
      { id: "fact_tauri", text: "The backend uses Tauri." },
    ];
    workspaceCapabilities = {
      isGitRepo: false,
      hasAgentsFile: false,
      hasSkillsDir: false,
    };
    const prompt = await buildMainSystemPromptForState(state);

    expect(prompt).toBe(initialPrompt);
    expect(prompt).toContain("Workspace root: /repo");
    expect(prompt).not.toContain("/repo/worktree");
    expect(prompt).not.toContain("The backend uses Tauri.");
    expect(prompt).toContain("Be pragmatic.");
  });

  it("rebuilds the existing system prompt when forceRefresh is requested", async () => {
    const initialPrompt = await buildMainSystemPromptForState(makeState());
    const state = makeState({
      config: {
        cwd: "/repo/worktree",
        model: "openai/gpt-5.2",
        communicationProfile: "friendly",
      },
      apiMessages: [{ role: "system", content: initialPrompt }],
    });

    projectLearnedFacts = [
      { id: "fact_pnpm", text: "Use pnpm in this repo." },
      { id: "fact_tauri", text: "The backend uses Tauri." },
    ];
    workspaceCapabilities = {
      isGitRepo: false,
      hasAgentsFile: false,
      hasSkillsDir: false,
    };
    const prompt = await buildMainSystemPromptForState(state, {
      forceRefresh: true,
    });

    expect(prompt).not.toBe(initialPrompt);
    expect(prompt).toContain("Workspace root: /repo/worktree");
    expect(prompt).toContain("The backend uses Tauri.");
    expect(prompt).toContain("Use a warmer tone.");
    expect(prompt).not.toContain("TOOL IO CONTEXT COMPACTION");
  });
});
