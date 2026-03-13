import { jotaiStore, getAgentState } from "../atoms";
import { commandListAtom } from "../db";
import {
  dispatchTool,
  validateTool,
  type DispatchCallbacks,
} from "../tools";
import {
  requiresApproval,
  requestApproval,
  consumeApprovalReason,
} from "../approvals";
import type {
  EditFileChange,
} from "../tools/workspace";
import type {
  ToolCallDisplay,
  ToolResult,
} from "../types";
import { buildEditFileDiffFiles, buildWriteFileDiffFiles } from "@/components/patchDiffFiles";
import { serializeDiff } from "@/components/diffSerialization";
import type { LogContext } from "@/logging/types";

import { writeRunnerLog } from "./logging";
import { parseArgs } from "./utils";
import {
  ensureManagedWorktreeLease,
  isManagedWorktreeWriteTool,
} from "./worktreeLease";

function shouldStreamToolOutput(toolName: string): boolean {
  return toolName === "exec_run" || toolName === "git_worktree_init";
}

interface ExecuteLocalToolOptions {
  tabId: string;
  runId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  preArgs: Record<string, unknown>;
  args: Record<string, unknown>;
  logContext: LogContext;
  updateToolCallById: (patch: Partial<ToolCallDisplay>) => void;
  logEventPrefix?: "runner.tool" | "runner.subagent.tool";
  logMessageName?: string;
}

export async function executeLocalTool(
  opts: ExecuteLocalToolOptions,
): Promise<ToolResult<unknown>> {
  const {
    tabId,
    runId,
    agentId,
    toolCallId,
    toolName,
    preArgs,
    args,
    logContext,
    updateToolCallById,
    logEventPrefix = "runner.tool",
    logMessageName = toolName,
  } = opts;

  const preCwd = getAgentState(tabId).config.cwd;

  updateToolCallById({ status: "running" });

  if (isManagedWorktreeWriteTool(toolName)) {
    const leaseError = await ensureManagedWorktreeLease(
      tabId,
      toolCallId,
      updateToolCallById,
    );
    if (leaseError) {
      updateToolCallById({
        status: "error",
        result: leaseError.error,
      });
      return leaseError;
    }
  }

  const validationResult = await validateTool(
    tabId,
    preCwd,
    toolName,
    preArgs,
  );
  if (validationResult && !validationResult.ok) {
    updateToolCallById({
      status: "error",
      result: validationResult.error,
    });
    return validationResult;
  }

  if (toolName === "workspace_editFile") {
    const path = typeof preArgs.path === "string" ? preArgs.path : null;
    const changes = Array.isArray(preArgs.changes)
      ? (preArgs.changes as EditFileChange[])
      : null;
    if (path && changes) {
      const diffs = await buildEditFileDiffFiles(path, changes, preCwd);
      if (diffs) {
        updateToolCallById({
          originalDiffFiles: diffs.map(serializeDiff),
        });
      }
    }
  } else if (toolName === "workspace_writeFile") {
    const path = typeof preArgs.path === "string" ? preArgs.path : null;
    const content =
      typeof preArgs.content === "string" ? preArgs.content : "";
    const overwrite = preArgs.overwrite === true;
    if (path) {
      const diffs = await buildWriteFileDiffFiles(
        path,
        content,
        overwrite,
        preCwd,
      );
      if (diffs) {
        updateToolCallById({
          originalDiffFiles: diffs.map(serializeDiff),
        });
      }
    }
  }

  const state = getAgentState(tabId);
  const approvalResult = requiresApproval(
    toolName,
    state.autoApproveEdits,
    state.autoApproveCommands,
    preArgs,
    jotaiStore.get(commandListAtom),
  );
  if (approvalResult.required) {
    updateToolCallById({
      status: "awaiting_approval",
      dangerous: approvalResult.dangerous,
    });

    const approved = await requestApproval(tabId, toolCallId);
    if (!approved) {
      const reason = consumeApprovalReason(tabId, toolCallId);
      const deniedResult = {
        ok: false as const,
        error: {
          code: "PERMISSION_DENIED" as const,
          message: reason ?? "Tool call denied by user",
        },
      };
      updateToolCallById({ status: "denied" });
      return deniedResult;
    }
  }

  const currentCwd = getAgentState(tabId).config.cwd;
  let streamBuf = "";
  const callbacks: DispatchCallbacks | undefined = shouldStreamToolOutput(toolName)
    ? {
        onExecOutput: (_stream, data) => {
          streamBuf += data;
          updateToolCallById({ streamingOutput: streamBuf });
        },
      }
    : undefined;

  const result = await dispatchTool(
    tabId,
    currentCwd,
    toolName,
    args,
    toolCallId,
    callbacks,
    {
      runId,
      agentId,
      logContext,
    },
  );

  updateToolCallById({
    status: result.ok ? "done" : "error",
    result: result.ok ? result.data : result.error,
  });
  writeRunnerLog({
    level: result.ok ? "info" : "error",
    tags: ["frontend", "agent-loop", "tool-calls"],
    event: result.ok ? `${logEventPrefix}.end` : `${logEventPrefix}.error`,
    message: result.ok
      ? `${logMessageName} completed`
      : `${logMessageName} failed`,
    kind: result.ok ? "end" : "error",
    data: result.ok ? result.data : result.error,
    context: logContext,
  });

  return result;
}

export function buildPendingToolDisplay(
  toolCallId: string,
  toolName: string,
  rawArgs: unknown,
): ToolCallDisplay {
  return {
    id: toolCallId,
    tool: toolName,
    args: parseArgs(rawArgs),
    status: "pending",
  };
}
