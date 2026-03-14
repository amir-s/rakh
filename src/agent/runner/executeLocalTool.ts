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

import { parseArgs } from "./utils";
import {
  ensureManagedWorktreeLease,
  isManagedWorktreeWriteTool,
} from "./worktreeLease";
import { stripToolGatewayInputFields } from "../toolGateway";
import type { ToolGatewayExecutorResult } from "./toolGateway";

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
): Promise<ToolGatewayExecutorResult> {
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
      return { result: leaseError };
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
    return { result: validationResult };
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
      return { result: deniedResult, finalStatus: "denied" };
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

  return { result };
}

export function buildPendingToolDisplay(
  toolCallId: string,
  toolName: string,
  rawArgs: unknown,
): ToolCallDisplay {
  const parsedArgs = parseArgs(rawArgs);
  const { strippedArgs } = stripToolGatewayInputFields(parsedArgs);
  return {
    id: toolCallId,
    tool: toolName,
    args: strippedArgs,
    status: "pending",
  };
}
