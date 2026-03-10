import { beforeEach, describe, expect, it, vi } from "vitest";

type MockAgentState = {
  config: {
    cwd: string;
    model: string;
    setupCommand?: string;
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
        | "awaiting_setup_action"
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
  requestWorktreeSetupActionMock,
  execRunMock,
  states,
  getAgentStateMock,
  patchAgentStateMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  requestWorktreeApprovalMock: vi.fn(),
  requestWorktreeSetupActionMock: vi.fn(),
  execRunMock: vi.fn(),
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
  requestWorktreeSetupAction: (...args: unknown[]) =>
    requestWorktreeSetupActionMock(...args),
}));

vi.mock("../atoms", () => ({
  getAgentState: (...args: unknown[]) => getAgentStateMock(...args),
  patchAgentState: (...args: unknown[]) => patchAgentStateMock(...args),
}));

vi.mock("./exec", () => ({
  execRun: (...args: unknown[]) => execRunMock(...args),
}));

import { gitWorktreeInit } from "./git";

function setNavigatorPlatform(value: string) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: value },
  });
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
    requestWorktreeSetupActionMock.mockReset();
    execRunMock.mockReset();
    getAgentStateMock.mockReset();
    patchAgentStateMock.mockReset();
    setNavigatorPlatform("MacIntel");

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
    const toolArgs = states.tab.chatMessages[0].toolCalls?.[0].args;
    expect(toolStatus).toBe("awaiting_worktree");
    expect(toolArgs).toMatchObject({ suggestedBranch: "feature", repoSlug: "repo" });
  });

  it("creates a worktree with sanitized branch name on approval", async () => {
    setState("tab");

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
      .mockResolvedValueOnce({
        path: "/backend/worktrees/owner/repo/feature-name",
        branch: "feature-name",
      });
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
        path: "/backend/worktrees/owner/repo/feature-name",
        branch: "feature-name",
        setup: { status: "not_configured" },
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "git_worktree_add", {
      repoPath: "/tmp/repo",
      repoSlug: "owner/repo",
      branch: "feature-name",
    });
    const homeLookupCalls = invokeMock.mock.calls.filter(
      ([command, payload]) =>
        command === "exec_run" &&
        typeof payload === "object" &&
        payload !== null &&
        "command" in payload &&
        (payload as { command?: string }).command === "sh",
    );
    expect(homeLookupCalls).toHaveLength(0);
    expect(states.tab.config.cwd).toBe(
      "/backend/worktrees/owner/repo/feature-name",
    );
    expect(states.tab.config.worktreePath).toBe(
      "/backend/worktrees/owner/repo/feature-name",
    );
    expect(states.tab.config.worktreeBranch).toBe("feature-name");
  });

  it("uses the backend-returned worktree path verbatim", async () => {
    setState("tab");

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
      .mockResolvedValueOnce({
        path: "/custom/root/worktrees/owner/repo/feature",
        branch: "feature",
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
        path: "/custom/root/worktrees/owner/repo/feature",
        branch: "feature",
        setup: { status: "not_configured" },
      },
    });
    expect(states.tab.config.cwd).toBe(
      "/custom/root/worktrees/owner/repo/feature",
    );
  });

  it("runs the saved setup command inside the new worktree and returns success metadata", async () => {
    setState("tab", {
      config: {
        cwd: "/repo",
        model: "openai/gpt-5.2",
        setupCommand: "npm install",
      },
    });

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
      .mockResolvedValueOnce({
        path: "/backend/worktrees/owner/repo/feature-name",
        branch: "feature-name",
      });
    requestWorktreeApprovalMock.mockResolvedValueOnce({
      approved: true,
      branchName: "Feature Name!!",
    });
    execRunMock.mockResolvedValueOnce({
      ok: true,
      data: {
        command: "sh",
        args: ["-lc", "npm install"],
        cwd: "/backend/worktrees/owner/repo/feature-name",
        exitCode: 0,
        durationMs: 3210,
        stdout: "installed",
        stderr: "",
        truncatedStdout: false,
        truncatedStderr: false,
      },
    });

    const result = await gitWorktreeInit("tab", "tc-1", "/repo", {
      suggestedBranch: "ignored-on-approve",
    });

    expect(execRunMock).toHaveBeenCalledWith(
      "/backend/worktrees/owner/repo/feature-name",
      {
        command: "sh",
        args: ["-lc", "npm install"],
        runId: "tc-1",
      },
      undefined,
    );
    expect(result).toEqual({
      ok: true,
      data: {
        path: "/backend/worktrees/owner/repo/feature-name",
        branch: "feature-name",
        setup: {
          status: "success",
          command: "npm install",
          cwd: "/backend/worktrees/owner/repo/feature-name",
          attemptCount: 1,
          exitCode: 0,
          durationMs: 3210,
          stdout: "installed",
          stderr: "",
          truncatedStdout: false,
          truncatedStderr: false,
          terminatedByUser: undefined,
        },
      },
    });
  });

  it("continues without setup when the command fails and the user chooses continue", async () => {
    setState("tab", {
      config: {
        cwd: "/repo",
        model: "openai/gpt-5.2",
        setupCommand: "npm install",
      },
    });

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
      .mockResolvedValueOnce({
        path: "/backend/worktrees/owner/repo/feature",
        branch: "feature",
      });
    requestWorktreeApprovalMock.mockResolvedValueOnce({
      approved: true,
      branchName: "feature",
    });
    execRunMock.mockResolvedValueOnce({
      ok: true,
      data: {
        command: "sh",
        args: ["-lc", "npm install"],
        cwd: "/backend/worktrees/owner/repo/feature",
        exitCode: 1,
        durationMs: 1500,
        stdout: "partial",
        stderr: "install failed",
        truncatedStdout: false,
        truncatedStderr: false,
      },
    });
    requestWorktreeSetupActionMock.mockResolvedValueOnce({ action: "continue" });

    const result = await gitWorktreeInit("tab", "tc-1", "/repo", {
      suggestedBranch: "feature",
    });

    expect(requestWorktreeSetupActionMock).toHaveBeenCalledWith("tab", "tc-1");
    expect(states.tab.chatMessages[0].toolCalls?.[0]).toMatchObject({
      status: "awaiting_setup_action",
      args: {
        setupPhase: "setup_failed",
        setupAttemptCount: 1,
      },
      result: {
        path: "/backend/worktrees/owner/repo/feature",
        branch: "feature",
        setup: expect.objectContaining({
          status: "failed_pending",
          errorMessage: "Setup command exited with code 1.",
        }),
      },
    });
    expect(result).toEqual({
      ok: true,
      data: {
        path: "/backend/worktrees/owner/repo/feature",
        branch: "feature",
        setup: {
          status: "failed_continued",
          command: "npm install",
          cwd: "/backend/worktrees/owner/repo/feature",
          attemptCount: 1,
          exitCode: 1,
          durationMs: 1500,
          stdout: "partial",
          stderr: "install failed",
          truncatedStdout: false,
          truncatedStderr: false,
          terminatedByUser: undefined,
          errorMessage: "Setup command exited with code 1.",
        },
      },
    });
  });

  it("retries the setup command after a failure and returns the successful retry", async () => {
    setState("tab", {
      config: {
        cwd: "/repo",
        model: "openai/gpt-5.2",
        setupCommand: "npm install",
      },
    });

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
      .mockResolvedValueOnce({
        path: "/backend/worktrees/owner/repo/feature",
        branch: "feature",
      });
    requestWorktreeApprovalMock.mockResolvedValueOnce({
      approved: true,
      branchName: "feature",
    });
    execRunMock
      .mockResolvedValueOnce({
        ok: true,
        data: {
          command: "sh",
          args: ["-lc", "npm install"],
          cwd: "/backend/worktrees/owner/repo/feature",
          exitCode: 1,
          durationMs: 1200,
          stdout: "",
          stderr: "first failure",
          truncatedStdout: false,
          truncatedStderr: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          command: "sh",
          args: ["-lc", "npm install"],
          cwd: "/backend/worktrees/owner/repo/feature",
          exitCode: 0,
          durationMs: 900,
          stdout: "done",
          stderr: "",
          truncatedStdout: false,
          truncatedStderr: false,
        },
      });
    requestWorktreeSetupActionMock.mockResolvedValueOnce({ action: "retry" });

    const onSetupOutput = vi.fn();
    const result = await gitWorktreeInit(
      "tab",
      "tc-1",
      "/repo",
      { suggestedBranch: "feature" },
      onSetupOutput,
    );

    expect(execRunMock).toHaveBeenCalledTimes(2);
    expect(onSetupOutput).toHaveBeenCalledWith(
      "stdout",
      "\nRetrying setup command (attempt 2)...\n",
    );
    expect(result).toEqual({
      ok: true,
      data: {
        path: "/backend/worktrees/owner/repo/feature",
        branch: "feature",
        setup: {
          status: "success",
          command: "npm install",
          cwd: "/backend/worktrees/owner/repo/feature",
          attemptCount: 2,
          exitCode: 0,
          durationMs: 900,
          stdout: "done",
          stderr: "",
          truncatedStdout: false,
          truncatedStderr: false,
          terminatedByUser: undefined,
        },
      },
    });
  });

  it("returns RUN_ABORTED when the user aborts after setup failure", async () => {
    setState("tab", {
      config: {
        cwd: "/repo",
        model: "openai/gpt-5.2",
        setupCommand: "npm install",
      },
    });

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
      .mockResolvedValueOnce({
        path: "/backend/worktrees/owner/repo/feature",
        branch: "feature",
      });
    requestWorktreeApprovalMock.mockResolvedValueOnce({
      approved: true,
      branchName: "feature",
    });
    execRunMock.mockResolvedValueOnce({
      ok: true,
      data: {
        command: "sh",
        args: ["-lc", "npm install"],
        cwd: "/backend/worktrees/owner/repo/feature",
        exitCode: 2,
        durationMs: 700,
        stdout: "",
        stderr: "bad state",
        truncatedStdout: false,
        truncatedStderr: false,
      },
    });
    requestWorktreeSetupActionMock.mockResolvedValueOnce({ action: "abort" });

    const result = await gitWorktreeInit("tab", "tc-1", "/repo", {
      suggestedBranch: "feature",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "RUN_ABORTED",
        message: "User aborted the agent run after setup failed.",
        details: {
          path: "/backend/worktrees/owner/repo/feature",
          branch: "feature",
          setup: {
            status: "failed_pending",
            command: "npm install",
            cwd: "/backend/worktrees/owner/repo/feature",
            attemptCount: 1,
            exitCode: 2,
            durationMs: 700,
            stdout: "",
            stderr: "bad state",
            truncatedStdout: false,
            truncatedStderr: false,
            terminatedByUser: undefined,
            errorMessage: "Setup command exited with code 2.",
          },
        },
      },
    });
  });

  it("returns INTERNAL when git_worktree_add fails", async () => {
    setState("tab");

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
