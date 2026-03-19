import type { McpToolRegistration } from "../mcp";
import type { ApiMessage, ToolCallDisplay, ToolResult } from "../types";
import type { LogContext } from "@/logging/types";

import { writeRunnerLog } from "./logging";

export interface ToolExecutorResult {
  result: ToolResult<unknown>;
  finalStatus?: ToolCallDisplay["status"];
  followupApiMessages?: ApiMessage[];
}

export type ToolExecutor = (
  args: Record<string, unknown>,
) => Promise<ToolExecutorResult>;

interface ExecuteToolCallOptions {
  toolName: string;
  rawArgs: Record<string, unknown>;
  logContext: LogContext;
  updateToolCallById: (patch: Partial<ToolCallDisplay>) => void;
  localExecutor: ToolExecutor;
  syntheticExecutors?: Partial<Record<string, ToolExecutor>>;
  mcpExecutor?: ToolExecutor;
  mcpTool?: McpToolRegistration;
}

function resolveSourceKind(
  toolName: string,
  mcpTool: McpToolRegistration | undefined,
  syntheticExecutors: ExecuteToolCallOptions["syntheticExecutors"],
): "local" | "mcp" | "synthetic" {
  if (mcpTool) return "mcp";
  if (syntheticExecutors?.[toolName]) return "synthetic";
  return "local";
}

function writeToolCompletionLog(
  result: ToolResult<unknown>,
  finalStatus: ToolCallDisplay["status"],
  toolName: string,
  sourceKind: "local" | "mcp" | "synthetic",
  logContext: LogContext,
): void {
  writeRunnerLog({
    level: result.ok ? "info" : "error",
    tags: ["frontend", "agent-loop", "tool-calls"],
    event: result.ok ? "runner.tool.end" : "runner.tool.error",
    message: result.ok
      ? `Tool ${toolName} completed`
      : `Tool ${toolName} failed`,
    kind: result.ok ? "end" : "error",
    data: result.ok
      ? { sourceKind, finalStatus }
      : { sourceKind, finalStatus, ...result.error },
    context: logContext,
  });
}

export async function executeToolCall(
  options: ExecuteToolCallOptions,
): Promise<ToolExecutorResult> {
  const sourceKind = resolveSourceKind(
    options.toolName,
    options.mcpTool,
    options.syntheticExecutors,
  );
  const executor =
    sourceKind === "mcp"
      ? options.mcpExecutor
      : sourceKind === "synthetic"
        ? options.syntheticExecutors?.[options.toolName]
        : options.localExecutor;

  if (!executor) {
    const result = {
      ok: false as const,
      error: {
        code: "INTERNAL" as const,
        message: `No executor registered for ${options.toolName}`,
      },
    };
    options.updateToolCallById({
      status: "error",
      result: result.error,
    });
    writeToolCompletionLog(
      result,
      "error",
      options.toolName,
      sourceKind,
      options.logContext,
    );
    return { result };
  }

  const executed = await executor(options.rawArgs);
  const result = executed.result;
  const finalStatus = executed.finalStatus ?? (result.ok ? "done" : "error");

  options.updateToolCallById({
    status: finalStatus,
    result: result.ok ? result.data : result.error,
  });
  writeToolCompletionLog(
    result,
    finalStatus,
    options.toolName,
    sourceKind,
    options.logContext,
  );

  return {
    result,
    ...(executed.followupApiMessages
      ? { followupApiMessages: executed.followupApiMessages }
      : {}),
  };
}
