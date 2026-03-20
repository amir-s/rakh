import type { ToolCallDisplay } from "@/agent/types";
import type { BadgeVariant } from "@/components/ui";

export interface CompactToolBadge {
  label: string;
  variant: BadgeVariant;
  title?: string;
}

function getResultRecord(result: unknown): Record<string, unknown> | null {
  return result !== null && typeof result === "object"
    ? (result as Record<string, unknown>)
    : null;
}

export function getExecCommandBadge(
  tc: Pick<ToolCallDisplay, "tool" | "status" | "result">,
): CompactToolBadge | null {
  if (tc.tool !== "exec_run" && tc.tool !== "codex_commandExecution") {
    return null;
  }

  if (
    tc.status === "pending" ||
    tc.status === "awaiting_approval" ||
    tc.status === "awaiting_worktree" ||
    tc.status === "awaiting_branch_release" ||
    tc.status === "awaiting_setup_action" ||
    tc.status === "running" ||
    tc.status === "denied"
  ) {
    return null;
  }

  const result = getResultRecord(tc.result);

  if (tc.status === "error") {
    const message =
      result && typeof result.message === "string" ? result.message : undefined;
    return {
      label: "FAILED",
      variant: "danger",
      title: message,
    };
  }

  if (!result) return null;

  const terminatedByUser = result.terminatedByUser === true;
  const exitCode =
    typeof result.exitCode === "number" ? result.exitCode : undefined;

  if (terminatedByUser) {
    return {
      label: "STOPPED",
      variant: "muted",
      title:
        exitCode === undefined
          ? "Command stopped"
          : `Command stopped with exit code ${exitCode}`,
    };
  }

  if (exitCode === 0) {
    return {
      label: "SUCCESS",
      variant: "success",
      title: "Command exited with code 0",
    };
  }

  if (exitCode !== undefined) {
    return {
      label: "FAILED",
      variant: "danger",
      title: `Command exited with code ${exitCode}`,
    };
  }

  return null;
}
