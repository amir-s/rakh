import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockAgentState = {
  config: {
    cwd: string;
    model: string;
    worktreePath?: string;
    worktreeBranch?: string;
    worktreeDeclined?: boolean;
  };
  chatMessages: Array<{
    id: string;
    role: "assistant" | "user";
    content: string;
    timestamp: number;
    toolCalls?: Array<{
      id: string;
      tool: string;
      args: Record<string, unknown>;
      status:
        | "pending"
        | "awaiting_approval"
        | "awaiting_worktree"
        | "running"
        | "done"
        | "error"
        | "denied";
    }>;
  }>;
  status: "idle" | "thinking" | "working" | "done" | "error";
  apiMessages: unknown[];
  streamingContent: string | null;
  plan: { markdown: string; updatedAtMs: number; version: number };
  todos: unknown[];
  error: string | null;
  errorDetails: unknown;
  tabTitle: string;
  reviewEdits: unknown[];
  autoApproveEdits: boolean;
  autoApproveCommands: "no" | "agent" | "yes";
};

const {
  invokeMock,
  requestWorktreeApprovalMock,
  states,
  getAgentStateMock,
  patchAgentStateMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  requestWorktreeApprovalMock: vi.fn(),
  states: {} as Record<string, MockAgentState>,
  getAgentStateMock: vi.fn(),
  patchAgentStateMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../approvals", () => ({
  requestWorktreeApproval: (...args: unknown[]) =>
    requestWorktreeApprovalMock(...args),
}));

vi.mock("../atoms", () => ({
  getAgentState: (...args: unknown[]) => getAgentStateMock(...args),
  patchAgentState: (...args: unknown[]) => patchAgentStateMock(...args),
}));

import { gitWorktreeInit } from "./git";

function setWindowHome(home?: string): void {
  if (home) {
    (
      globalThis as unknown as {
        window: { __EVE_HOME__?: string };
      }
    ).window = { __EVE_HOME__: home };
  } else {
    (globalThis as unknown as { window?: unknown }).window = undefined;
  }
}

function makeState(overrides?: Partial<MockAgentState>): MockAgentState {
  return {
    status: "idle",
    config: { cwd: "/repo", model: "openai/gpt-5.2" },
    chatMessages: [
      {
        id: "msg-1",
        role: "assistant",
        content: "",
        timestamp: 1,
        toolCalls: [
          {
            id: "tc-1",
            tool: "git_worktree_init",
            args: {},
            status: "pending",
          },
        ],
      },
    ],
    apiMessages: [],
    streamingContent: null,
    plan: { markdown: "", updatedAtMs: 0, version: 0 },
    todos: [],
    error: null,
    errorDetails: null,
    tabTitle: "",
    reviewEdits: [],
    autoApproveEdits: false,
    autoApproveCommands: "no",
    ...overrides,
  };
}

function setState(tabId: string, state?: Partial<MockAgentState>): void {
  states[tabId] = makeState(state);
}

describe("gitWorktreeInit", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    requestWorktreeApprovalMock.mockReset();
    getAgentStateMock.mockReset();
    patchAgentStateMock.mockReset();

    for (const key of Object.keys(states)) {
      delete states[key];
    }

    getAgentStateMock.mockImplementation((tabId: unknown) => states[String(tabId)]);
    patchAgentStateMock.mockImplementation(
      (
        tabId: unknown,
        patch:
          | Partial<MockAgentState>
          | ((prev: MockAgentState) => MockAgentState),
      ) => {
        const key = String(tabId);
        const prev = states[key];
        states[key] =
          typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      },
    );

    setWindowHome();
  });

  afterEach(() => {
    setWindowHome();
  });

  it("returns alreadyExists when a worktree is already configured", async () => {
    setState("tab", {
      config: {
        cwd: "/repo",
        model: "openai/gpt-5.2",
        worktreePath: "/wt/path",
        worktreeBranch: "codex/already",
      },
    });

    const result = await gitWorktreeInit("tab", "tc-1", "/repo", {
      suggestedBranch: "feature",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        alreadyExists: true,
        path: "/wt/path",
        branch: "codex/already",
      },
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(requestWorktreeApprovalMock).not.toHaveBeenCalled();
  });

  it("returns declined when user previously declined worktree creation", async () => {
    setState("tab", {
      config: {
        cwd: "/repo",
        model: "openai/gpt-5.2",
        worktreeDeclined: true,
      },
    });

    const result = await gitWorktreeInit("tab", "tc-1", "/repo", {
      suggestedBranch: "feature",
    });

    expect(result).toEqual({ ok: true, data: { declined: true } });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(requestWorktreeApprovalMock).not.toHaveBeenCalled();
  });

  it("returns INVALID_ARGUMENT when cwd is not a git repository", async () => {
    setState("tab");
    invokeMock.mockResolvedValueOnce({
      exitCode: 128,
      stdout: "",
      stderr: "fatal",
    });

    const result = await gitWorktreeInit("tab", "tc-1", "/repo", {
      suggestedBranch: "feature",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
      },
    });
    expect(requestWorktreeApprovalMock).not.toHaveBeenCalled();
  });

  it("marks config as declined when user rejects approval", async () => {
    setState("tab");
    setWindowHome("/Users/test");

    invokeMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "/tmp/repo\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "no remote",
      });
    requestWorktreeApprovalMock.mockResolvedValueOnce({
      approved: false,
      branchName: "",
    });

    const result = await gitWorktreeInit("tab", "tc-1", "/repo", {
      suggestedBranch: "feature",
    });

    expect(result).toEqual({ ok: true, data: { declined: true } });
    expect(states.tab.config.worktreeDeclined).toBe(true);
    const toolStatus = states.tab.chatMessages[0].toolCalls?.[0].status;
    expect(toolStatus).toBe("awaiting_worktree");
  });

  it("creates a worktree with sanitized branch name on approval", async () => {
    setState("tab");
    setWindowHome("/Users/test");

    invokeMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "/tmp/repo\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "git@github.com:owner/repo.git\n",
        stderr: "",
      })
      .mockResolvedValueOnce({});
    requestWorktreeApprovalMock.mockResolvedValueOnce({
      approved: true,
      branchName: "Feature Name!!",
    });

    const result = await gitWorktreeInit("tab", "tc-1", "/repo", {
      suggestedBranch: "ignored-on-approve",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        path: "/Users/test/.rakh/worktrees/owner/repo/feature-name",
        branch: "feature-name",
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "git_worktree_add", {
      repoPath: "/tmp/repo",
      worktreePath: "/Users/test/.rakh/worktrees/owner/repo/feature-name",
      branch: "feature-name",
    });
    expect(states.tab.config.cwd).toBe(
      "/Users/test/.rakh/worktrees/owner/repo/feature-name",
    );
    expect(states.tab.config.worktreePath).toBe(
      "/Users/test/.rakh/worktrees/owner/repo/feature-name",
    );
    expect(states.tab.config.worktreeBranch).toBe("feature-name");
  });

  it("trims trailing slash from worktree cwd", async () => {
    setState("tab");
    setWindowHome("/Users/test/");

    invokeMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "/tmp/repo\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "git@github.com:owner/repo.git\n",
        stderr: "",
      });
    requestWorktreeApprovalMock.mockResolvedValueOnce({
      approved: true,
      branchName: "feature",
    });

    const result = await gitWorktreeInit("tab", "tc-1", "/repo", {
      suggestedBranch: "feature",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        path: "/Users/test/.rakh/worktrees/owner/repo/feature",
        branch: "feature",
      },
    });
    expect(states.tab.config.cwd).toBe(
      "/Users/test/.rakh/worktrees/owner/repo/feature",
    );
  });

  it("returns INTERNAL when git_worktree_add fails", async () => {
    setState("tab");
    setWindowHome("/Users/test");

    invokeMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "/tmp/repo\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "https://github.com/acme/repo.git\n",
        stderr: "",
      })
      .mockRejectedValueOnce(new Error("creation failed"));

    requestWorktreeApprovalMock.mockResolvedValueOnce({
      approved: true,
      branchName: "feature",
    });

    const result = await gitWorktreeInit("tab", "tc-1", "/repo", {
      suggestedBranch: "feature",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INTERNAL",
      },
    });
    expect(String((result as { ok: false; error: { message: string } }).error.message)).toContain(
      "Failed to create worktree",
    );
  });
});
