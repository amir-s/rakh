// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallDisplay } from "@/agent/types";
import ToolCallApproval from "./ToolCallApproval";

const approvalMocks = vi.hoisted(() => ({
  resolveWorktreeApprovalMock: vi.fn(),
  resolveWorktreeSetupActionMock: vi.fn(),
  resolveApprovalMock: vi.fn(),
  setApprovalReasonMock: vi.fn(),
}));

const useAgentsMocks = vi.hoisted(() => ({
  stopAgentMock: vi.fn(),
  stopRunningExecToolCallMock: vi.fn(async () => true),
}));

vi.mock("@/agent/approvals", () => ({
  resolveApproval: (...args: unknown[]) => approvalMocks.resolveApprovalMock(...args),
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
    approvalMocks.resolveWorktreeApprovalMock.mockReset();
    approvalMocks.resolveWorktreeSetupActionMock.mockReset();
    approvalMocks.setApprovalReasonMock.mockReset();
    useAgentsMocks.stopAgentMock.mockReset();
    useAgentsMocks.stopRunningExecToolCallMock.mockReset();
    useAgentsMocks.stopRunningExecToolCallMock.mockResolvedValue(true);
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
  });
});
