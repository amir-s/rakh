import { beforeEach, describe, expect, it } from "vitest";
import {
  cancelAllApprovals,
  consumeApprovalReason,
  requestApproval,
  requestWorktreeApproval,
  requiresApproval,
  resolveApproval,
  resolveWorktreeApproval,
  setApprovalReason,
} from "./approvals";

describe("approvals - requiresApproval", () => {
  it("should never require approval for inline tools", () => {
    expect(requiresApproval("workspace_listDir", false, "no")).toBe(false);
    expect(requiresApproval("agent_title_set", false, "no")).toBe(false);
    expect(requiresApproval("agent_artifact_create", false, "no")).toBe(false);
    expect(requiresApproval("agent_artifact_version", false, "no")).toBe(false);
    expect(requiresApproval("agent_artifact_get", false, "no")).toBe(false);
    expect(requiresApproval("agent_artifact_list", false, "no")).toBe(false);
  });

  it("should respect autoApproveEdits flag", () => {
    // Without flag
    expect(requiresApproval("workspace_writeFile", false, "no")).toBe(true);
    expect(requiresApproval("workspace_editFile", false, "no")).toBe(true);
    // With flag
    expect(requiresApproval("workspace_writeFile", true, "no")).toBe(false);
    expect(requiresApproval("workspace_editFile", true, "no")).toBe(false);
  });

  it("should always auto-approve commands when mode is yes", () => {
    expect(requiresApproval("exec_run", false, "yes")).toBe(false);
    expect(
      requiresApproval(
        "exec_run",
        false,
        "yes",
        { requireUserApproval: true } as Record<string, unknown>,
      ),
    ).toBe(false);
  });

  it("should always require command approval when mode is no", () => {
    expect(requiresApproval("exec_run", false, "no")).toBe(true);
    expect(
      requiresApproval(
        "exec_run",
        false,
        "no",
        { requireUserApproval: false } as Record<string, unknown>,
      ),
    ).toBe(true);
  });

  it("should respect agent command hint in mode=agent", () => {
    expect(
      requiresApproval(
        "exec_run",
        false,
        "agent",
        { requireUserApproval: true } as Record<string, unknown>,
      ),
    ).toBe(true);
    expect(
      requiresApproval(
        "exec_run",
        false,
        "agent",
        { requireUserApproval: false } as Record<string, unknown>,
      ),
    ).toBe(false);
  });

  it("should default to requiring approval when mode=agent and hint is missing/invalid", () => {
    expect(requiresApproval("exec_run", false, "agent")).toBe(true);
    expect(
      requiresApproval(
        "exec_run",
        false,
        "agent",
        { requireUserApproval: "yes please" } as Record<string, unknown>,
      ),
    ).toBe(true);
  });

  it("should default to requiring approval for unknown tools", () => {
    expect(requiresApproval("unknown_dangerous_tool", true, "yes")).toBe(true);
  });

  it("should not auto-approve unrelated tool categories", () => {
    expect(requiresApproval("exec_run", true, "no")).toBe(true);
    expect(requiresApproval("workspace_writeFile", false, "yes")).toBe(true);
  });
});

describe("approvals - resolver lifecycle", () => {
  beforeEach(() => {
    cancelAllApprovals();
  });

  it("resolves a pending approval exactly once", async () => {
    const pending = requestApproval("call-1");
    resolveApproval("call-1", true);
    await expect(pending).resolves.toBe(true);

    // no-op after resolver is consumed
    resolveApproval("call-1", false);
  });

  it("denies all pending approvals when canceled", async () => {
    const pendingA = requestApproval("call-a");
    const pendingB = requestApproval("call-b");
    cancelAllApprovals();

    await expect(pendingA).resolves.toBe(false);
    await expect(pendingB).resolves.toBe(false);
  });

  it("stores and consumes trimmed approval reasons", () => {
    setApprovalReason("call-r", "  needs confirmation  ");
    expect(consumeApprovalReason("call-r")).toBe("needs confirmation");
    expect(consumeApprovalReason("call-r")).toBeUndefined();
  });

  it("ignores blank approval reasons", () => {
    setApprovalReason("call-empty", "   ");
    expect(consumeApprovalReason("call-empty")).toBeUndefined();
  });

  it("supports worktree approval and cancellation fallback", async () => {
    const approved = requestWorktreeApproval("wt-1");
    resolveWorktreeApproval("wt-1", true, "codex/feature-1");
    await expect(approved).resolves.toEqual({
      approved: true,
      branchName: "codex/feature-1",
    });

    const canceled = requestWorktreeApproval("wt-2");
    cancelAllApprovals();
    await expect(canceled).resolves.toEqual({
      approved: false,
      branchName: "",
    });
  });
});
