// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallDisplay } from "@/agent/types";
import ToolCallApproval from "./ToolCallApproval";

const approvalMocks = vi.hoisted(() => ({
  resolveWorktreeApprovalMock: vi.fn(),
  resolveWorktreeSetupActionMock: vi.fn(),
  resolveBranchReleaseActionMock: vi.fn(),
  resolveApprovalMock: vi.fn(),
  setApprovalReasonMock: vi.fn(),
}));

const useAgentsMocks = vi.hoisted(() => ({
  stopAgentMock: vi.fn(),
  stopRunningExecToolCallMock: vi.fn(async () => true),
}));

const execMocks = vi.hoisted(() => ({
  execRunMock: vi.fn(),
}));

const clipboardMock = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

vi.mock("@/agent/approvals", () => ({
  resolveApproval: (...args: unknown[]) => approvalMocks.resolveApprovalMock(...args),
  resolveBranchReleaseAction: (...args: unknown[]) =>
    approvalMocks.resolveBranchReleaseActionMock(...args),
  resolveWorktreeApproval: (...args: unknown[]) =>
    approvalMocks.resolveWorktreeApprovalMock(...args),
  resolveWorktreeSetupAction: (...args: unknown[]) =>
    approvalMocks.resolveWorktreeSetupActionMock(...args),
  setApprovalReason: (...args: unknown[]) => approvalMocks.setApprovalReasonMock(...args),
}));

vi.mock("@/agent/useAgents", () => ({
  useStopAgent: () => useAgentsMocks.stopAgentMock,
  useStopRunningExecToolCall: () => useAgentsMocks.stopRunningExecToolCallMock,
}));

vi.mock("@/agent/tools/exec", () => ({
  execRun: (...args: unknown[]) => execMocks.execRunMock(...args),
}));

function makeExecRunResult(
  overrides: Partial<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> = {},
) {
  return {
    ok: true as const,
    data: {
      command: "git",
      args: [],
      cwd: "/tmp/worktree",
      exitCode: overrides.exitCode ?? 0,
      durationMs: 12,
      stdout: overrides.stdout ?? "",
      stderr: overrides.stderr ?? "",
      truncatedStdout: false,
      truncatedStderr: false,
    },
  };
}

function makeWorktreeToolCall(
  overrides: Partial<ToolCallDisplay> = {},
): ToolCallDisplay {
  return {
    id: "tc-1",
    tool: "git_worktree_init",
    args: {
      suggestedBranch: "feature/setup",
      repoSlug: "owner/repo",
      branch: "feature/setup",
      worktreePath: "/tmp/worktree",
      setupCommand: "npm install",
      setupPhase: "setup_failed",
    },
    result: {
      path: "/tmp/worktree",
      branch: "feature/setup",
      setup: {
        status: "failed_pending",
        cwd: "/tmp/worktree",
        stdout: "partial output",
        stderr: "install failed",
        errorMessage: "Setup command exited with code 1.",
      },
    },
    status: "awaiting_setup_action",
    ...overrides,
  };
}

describe("ToolCallApproval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    approvalMocks.resolveApprovalMock.mockReset();
    approvalMocks.resolveBranchReleaseActionMock.mockReset();
    approvalMocks.resolveWorktreeApprovalMock.mockReset();
    approvalMocks.resolveWorktreeSetupActionMock.mockReset();
    approvalMocks.setApprovalReasonMock.mockReset();
    useAgentsMocks.stopAgentMock.mockReset();
    useAgentsMocks.stopRunningExecToolCallMock.mockReset();
    useAgentsMocks.stopRunningExecToolCallMock.mockResolvedValue(true);
    execMocks.execRunMock.mockReset();
    execMocks.execRunMock.mockResolvedValue(
      makeExecRunResult({ stdout: "origin/main\n" }),
    );
    clipboardMock.writeText.mockReset();
    clipboardMock.writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardMock.writeText },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("auto-continues a failed setup after five seconds", () => {
    render(
      <ToolCallApproval
        toolCall={makeWorktreeToolCall()}
        tabId="tab-1"
        onOpenProjectSettings={vi.fn()}
      />,
    );

    screen.getByText("SETUP FAILED");
    screen.getByText("partial output");
    screen.getByText("install failed");
    expect(screen.getByText(/Continuing without setup in/i).textContent).toContain(
      "5s",
    );

    act(() => {
      vi.advanceTimersByTime(5200);
    });

    expect(approvalMocks.resolveWorktreeSetupActionMock).toHaveBeenCalledWith(
      "tab-1",
      "tc-1",
      "continue",
    );
  });

  it("pauses auto-continue and opens project settings when editing the command", () => {
    const onOpenProjectSettings = vi.fn();

    render(
      <ToolCallApproval
        toolCall={makeWorktreeToolCall()}
        tabId="tab-1"
        onOpenProjectSettings={onOpenProjectSettings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "EDIT COMMAND" }));

    expect(onOpenProjectSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Auto-continue paused/i)).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(5200);
    });

    expect(approvalMocks.resolveWorktreeSetupActionMock).not.toHaveBeenCalled();
  });

  it("renders MCP tool calls with a friendly server and tool label", () => {
    render(
      <ToolCallApproval
        toolCall={{
          id: "tc-mcp",
          tool: "mcp_filesystem_read_file",
          args: { path: "README.md" },
          mcp: {
            serverId: "filesystem",
            serverName: "Filesystem",
            toolName: "read_file",
            toolTitle: "Read File",
          },
          status: "awaiting_approval",
        }}
        tabId="tab-1"
        onOpenProjectSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("MCP / Filesystem / Read File")).not.toBeNull();
    expect(
      screen
        .getByText("MCP / Filesystem / Read File")
        .closest(".msg-card")
        ?.getAttribute("data-chat-attention-target"),
    ).toBe("approval");
  });

  it("copies the branch and conflicting checkout from the branch release card", async () => {
    render(
      <ToolCallApproval
        toolCall={{
          id: "tc-lease",
          tool: "workspace_writeFile",
          args: { path: "src/app.ts" },
          result: {
            branch: "feat/handoff",
            path: "/tmp/worktree",
            blockingPath: "/Users/amir/code/rakh",
            message:
              "fatal: 'feat/handoff' is already checked out at '/Users/amir/code/rakh'",
            instructions: [
              "Release `feat/handoff` in `/Users/amir/code/rakh` with `git switch --detach` or `git switch <other-branch>`.",
              "Then retry once the branch is no longer checked out elsewhere.",
            ],
          },
          status: "awaiting_branch_release",
        }}
        tabId="tab-1"
      />,
    );

    expect(screen.getByText("RELEASE SESSION BRANCH")).not.toBeNull();
    expect(screen.queryByText(/fatal:/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy session branch" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Copy conflicting checkout path" }),
      );
      await Promise.resolve();
    });

    expect(clipboardMock.writeText).toHaveBeenNthCalledWith(1, "feat/handoff");
    expect(clipboardMock.writeText).toHaveBeenNthCalledWith(
      2,
      "/Users/amir/code/rakh",
    );
  });

  it("runs an inline release command and retries automatically on success", async () => {
    execMocks.execRunMock
      .mockResolvedValueOnce(makeExecRunResult({ stdout: "origin/trunk\n" }))
      .mockResolvedValueOnce(makeExecRunResult());

    render(
      <ToolCallApproval
        toolCall={{
          id: "tc-lease",
          tool: "workspace_writeFile",
          args: { path: "src/app.ts" },
          result: {
            branch: "feat/handoff",
            path: "/tmp/worktree",
            blockingPath: "/Users/amir/code/rakh",
          },
          status: "awaiting_branch_release",
        }}
        tabId="tab-1"
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("git switch trunk")).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "SWITCH" }));
      await Promise.resolve();
    });

    expect(execMocks.execRunMock).toHaveBeenNthCalledWith(
      2,
      "/Users/amir/code/rakh",
      expect.objectContaining({
        command: "git",
        args: ["switch", "trunk"],
      }),
    );
    expect(approvalMocks.resolveBranchReleaseActionMock).toHaveBeenCalledWith(
      "tab-1",
      "tc-lease",
      "retry",
    );
  });

  it("renders the loop-limit guard prompt with continue and stop actions", () => {
    render(
      <ToolCallApproval
        toolCall={{
          id: "tc-loop-limit",
          tool: "agent_loop_limit_guard",
          args: {
            currentIteration: 41,
            remainingTurns: 10,
            warningThreshold: 40,
            hardLimit: 50,
          },
          status: "awaiting_approval",
        }}
        tabId="tab-1"
      />,
    );

    expect(screen.getByText("LOOP LIMIT")).not.toBeNull();
    expect(
      screen.getAllByText(
        (_content, element) =>
          element?.tagName === "P" &&
          (element.textContent?.includes("iteration 41") ?? false),
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/10 turns remain/i)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "CONTINUE" }));
    expect(approvalMocks.resolveApprovalMock).toHaveBeenCalledWith(
      "tab-1",
      "tc-loop-limit",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "STOP" }));
    expect(approvalMocks.resolveApprovalMock).toHaveBeenCalledWith(
      "tab-1",
      "tc-loop-limit",
      false,
    );
  });
});
