import { getAgentState } from "../atoms";
import { requestBranchReleaseAction } from "../approvals";
import { getBranchReleaseInstructions, switchToGitBranch } from "../tools/git";
import type { ToolResult, ToolCallDisplay } from "../types";

import { isRecord } from "./utils";

const worktreeLeaseCheckPromises = new Map<
  string,
  Promise<Extract<ToolResult<unknown>, { ok: false }> | null>
>();

export function isManagedWorktreeWriteTool(toolName: string): boolean {
  return toolName === "workspace_writeFile" || toolName === "workspace_editFile";
}

export async function ensureManagedWorktreeLease(
  tabId: string,
  toolCallId: string,
  updateToolCallById: (patch: Partial<ToolCallDisplay>) => void,
): Promise<Extract<ToolResult<unknown>, { ok: false }> | null> {
  const state = getAgentState(tabId);
  const worktreePath = state.config.worktreePath?.trim();
  const worktreeBranch = state.config.worktreeBranch?.trim();
  if (!worktreePath || !worktreeBranch) return null;

  const existing = worktreeLeaseCheckPromises.get(tabId);
  if (existing) return existing;

  let promise: Promise<Extract<ToolResult<unknown>, { ok: false }> | null>;
  promise = (async () => {
    while (true) {
      const switchResult = await switchToGitBranch(worktreePath, worktreeBranch);
      if (switchResult.ok) return null;

      const details = switchResult.error.details;
      if (
        !isRecord(details) ||
        details.reason !== "branch_checked_out_elsewhere"
      ) {
        return switchResult;
      }

      const blockingPath =
        typeof details.blockingPath === "string"
          ? details.blockingPath
          : undefined;
      updateToolCallById({
        status: "awaiting_branch_release",
        result: {
          branch: worktreeBranch,
          path: worktreePath,
          blockingPath,
          message: switchResult.error.message,
          instructions: getBranchReleaseInstructions(
            worktreeBranch,
            blockingPath,
          ),
        },
      });

      const { action } = await requestBranchReleaseAction(tabId, toolCallId);
      if (action === "retry") {
        continue;
      }

      return {
        ok: false as const,
        error: {
          code: "RUN_ABORTED" as const,
          message:
            "User aborted while the session branch was checked out elsewhere.",
          details: {
            branch: worktreeBranch,
            path: worktreePath,
            ...(blockingPath ? { blockingPath } : {}),
          },
        },
      };
    }
  })().finally(() => {
    if (worktreeLeaseCheckPromises.get(tabId) === promise) {
      worktreeLeaseCheckPromises.delete(tabId);
    }
  });

  worktreeLeaseCheckPromises.set(tabId, promise);
  return promise;
}
