import { jotaiStore, getAgentState } from "../atoms";
import { commandListAtom } from "../db";
import {
  listDoingTodos,
  parseToolMutationPolicy,
  stripToolMutationPolicyFields,
} from "../mutationPolicy";
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
import type { ToolExecutorResult } from "./executeToolCall";
import {
  ensureManagedWorktreeLease,
  isManagedWorktreeWriteTool,
} from "./worktreeLease";
import { writeRunnerLog } from "./logging";
import { recordTodoMutation, resolveTodoOwner } from "../tools/todos";

function shouldStreamToolOutput(toolName: string): boolean {
  return toolName === "exec_run" || toolName === "git_worktree_init";
}

interface ExecuteLocalToolOptions {
  tabId: string;
  runId: string;
  agentId: string;
  currentTurn: number;
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
): Promise<ToolExecutorResult> {
  const {
    tabId,
    runId,
    agentId,
    currentTurn,
    toolCallId,
    toolName,
    preArgs,
    args,
    logContext,
    updateToolCallById,
  } = opts;

  const preCwd = getAgentState(tabId).config.cwd;
  const mutationPolicy = parseToolMutationPolicy(toolName, preArgs);

  if (mutationPolicy && !mutationPolicy.ok) {
    updateToolCallById({
      status: "error",
      result: mutationPolicy.error,
    });
    return { result: mutationPolicy };
  }

  if (mutationPolicy?.data.todoHandling.mode === "track_active") {
    const doingTodos = listDoingTodos(getAgentState(tabId).todos);
    if (doingTodos.length !== 1) {
      const result = {
        ok: false as const,
        error: {
          code: "CONFLICT" as const,
          message:
            doingTodos.length === 0
              ? "Exactly one active todo is required before tracked mutations can run."
              : "Tracked mutations are blocked because multiple active todos were found.",
        },
      };
      updateToolCallById({
        status: "error",
        result: result.error,
      });
      return { result };
    }
  }

  updateToolCallById({ status: "running" });

  if (isManagedWorktreeWriteTool(toolName)) {
    const leaseError = await ensureManagedWorktreeLease(
      tabId,
      toolCallId,
      toolName,
      logContext,
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
    writeRunnerLog({
      level: "info",
      tags: ["frontend", "agent-loop", "tool-calls"],
      event: "runner.tool.approval.waiting",
      message: `Tool ${toolName} waiting for approval`,
      data: {
        dangerous: approvalResult.dangerous,
      },
      context: logContext,
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
      writeRunnerLog({
        level: "warn",
        tags: ["frontend", "agent-loop", "tool-calls"],
        event: "runner.tool.approval.denied",
        message: `Tool ${toolName} was denied`,
        kind: "error",
        data: {
          ...(reason ? { reason } : {}),
        },
        context: logContext,
      });
      return { result: deniedResult, finalStatus: "denied" };
    }
    writeRunnerLog({
      level: "info",
      tags: ["frontend", "agent-loop", "tool-calls"],
      event: "runner.tool.approval.approved",
      message: `Tool ${toolName} was approved`,
      context: logContext,
    });
  }

  const currentCwd = getAgentState(tabId).config.cwd;
  const executionArgs = stripToolMutationPolicyFields(args);
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
    executionArgs,
    toolCallId,
    callbacks,
    {
      runId,
      agentId,
      currentTurn,
      logContext,
    },
  );

  if (result.ok && mutationPolicy?.data.todoHandling.mode === "track_active") {
    const trackedPaths =
      toolName === "workspace_writeFile" || toolName === "workspace_editFile"
        ? (typeof preArgs.path === "string" ? [preArgs.path] : [])
        : (mutationPolicy.data.todoHandling.touchedPaths ?? []);

    await recordTodoMutation(tabId, {
      actor: resolveTodoOwner(agentId),
      turn: currentTurn,
      tool: toolName,
      toolCallId,
      mutationIntent: mutationPolicy.data.mutationIntent,
      paths: trackedPaths,
    });
  }

  return { result };
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
