import { stepCountIs, streamText, tool as aiTool } from "ai";
import { z } from "zod";
import { createChildLogContext } from "@/logging/client";
import type { LogContext } from "@/logging/types";

import { estimateContextUsage } from "../contextUsage";
import { getModelCatalogEntry } from "../modelCatalog";
import {
  buildToolGatewayArtifactResult,
  selectHugeOutputThreshold,
  stripToolGatewayInputFields,
  type ToolGatewayArtifactRef,
  type ToolGatewayConfig,
  type ToolGatewayConfigProvider,
  type ToolGatewayExecutionOrigin,
  type ToolGatewayOriginalFormat,
  type ToolGatewaySourceKind,
  type ToolGatewayStateSnapshot,
} from "../toolGateway";
import {
  getToolArtifact,
  searchToolArtifact,
  createToolArtifact,
} from "../tools/toolArtifacts";
import type { ToolCallDisplay, ToolResult } from "../types";
import type { ProviderInstance } from "../db";
import type { McpToolRegistration } from "../mcp";

import { writeRunnerLog } from "./logging";
import {
  buildProviderOptions,
  resolveLanguageModel,
} from "./providerOptions";
import { mapApiMessagesToModelMessages, type JsonValue } from "./utils";
import type { RecordLlmUsageInput } from "../sessionStats";

const TOOL_GATEWAY_ARTIFACT_NOTE =
  "Raw tool output stored as a temporary tool artifact. Use agent_tool_artifact_get or agent_tool_artifact_search to inspect it.";

export interface ToolGatewayExecutorResult {
  result: ToolResult<unknown>;
  finalStatus?: ToolCallDisplay["status"];
}

type ToolGatewayExecutor = (
  args: Record<string, unknown>,
) => Promise<ToolGatewayExecutorResult>;

export interface ExecuteThroughToolGatewayOptions {
  tabId: string;
  runId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  rawArgs: Record<string, unknown>;
  currentModelId: string;
  contextLength?: number;
  apiMessages: Array<{ role: string; content?: string | null }>;
  providers: ProviderInstance[];
  providerOptions?: Record<string, Record<string, JsonValue>>;
  advancedOptions?: Parameters<typeof buildProviderOptions>[1];
  logContext: LogContext;
  updateToolCallById: (patch: Partial<ToolCallDisplay>) => void;
  recordLlmUsage?: (input: RecordLlmUsageInput) => void;
  localExecutor: ToolGatewayExecutor;
  syntheticExecutors?: Partial<Record<string, ToolGatewayExecutor>>;
  mcpExecutor?: ToolGatewayExecutor;
  mcpTool?: McpToolRegistration;
  executionOrigin?: ToolGatewayExecutionOrigin;
  configProvider?: ToolGatewayConfigProvider;
}

function defaultToolGatewayConfig(): ToolGatewayConfig {
  return {
    hugeOutput: {
      enabled: true,
      defaultThresholdBytes: 64 * 1024,
      thresholdBands: [
        { minContextUsagePct: 90, maxBytes: 16 * 1024 },
        { minContextUsagePct: 75, maxBytes: 32 * 1024 },
      ],
    },
    summary: {
      enabled: true,
      modelStrategy: "parent",
      maxSummaryChars: 320,
      maxSteps: 5,
      toolArtifactGetMaxBytes: 12_000,
      toolArtifactSearchMaxMatches: 8,
      toolArtifactSearchContextLines: 1,
    },
  };
}

export const defaultToolGatewayConfigProvider: ToolGatewayConfigProvider = {
  getConfig: () => defaultToolGatewayConfig(),
};

function resolveSourceKind(
  toolName: string,
  mcpTool: McpToolRegistration | undefined,
  syntheticExecutors: ExecuteThroughToolGatewayOptions["syntheticExecutors"],
): ToolGatewaySourceKind {
  if (mcpTool) return "mcp";
  if (syntheticExecutors?.[toolName]) return "synthetic";
  return "local";
}

function buildStateSnapshot(
  options: ExecuteThroughToolGatewayOptions,
  intention: string | undefined,
  sourceKind: ToolGatewaySourceKind,
  executionOrigin: ToolGatewayExecutionOrigin,
): ToolGatewayStateSnapshot {
  const usage = estimateContextUsage(options.apiMessages as never[]);
  const contextUsagePct =
    usage && options.contextLength
      ? Math.min(100, (usage.estimatedTokens / options.contextLength) * 100)
      : undefined;

  return {
    tabId: options.tabId,
    runId: options.runId,
    agentId: options.agentId,
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    modelId: options.currentModelId,
    sourceKind,
    executionOrigin,
    ...(intention ? { intention } : {}),
    ...(options.contextLength ? { contextLength: options.contextLength } : {}),
    ...(typeof contextUsagePct === "number" ? { contextUsagePct } : {}),
    ...(usage?.estimatedTokens ? { estimatedTokens: usage.estimatedTokens } : {}),
    ...(usage?.estimatedBytes ? { estimatedBytes: usage.estimatedBytes } : {}),
  };
}

function toArtifactPayload(data: unknown): {
  content: string;
  originalFormat: ToolGatewayOriginalFormat;
} {
  if (typeof data === "string") {
    return { content: data, originalFormat: "text" };
  }

  try {
    return {
      content: JSON.stringify(data, null, 2) ?? "null",
      originalFormat: "json",
    };
  } catch {
    return {
      content: String(data),
      originalFormat: "text",
    };
  }
}

function trimSummaryText(summary: string, maxChars: number): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

async function summarizeArtifactReference(
  reference: ToolGatewayArtifactRef,
  config: ToolGatewayConfig["summary"],
  options: ExecuteThroughToolGatewayOptions,
  stateSnapshot: ToolGatewayStateSnapshot,
): Promise<string | null> {
  const summaryModelId =
    config.modelStrategy === "override" && config.overrideModelId
      ? config.overrideModelId
      : options.currentModelId;
  const summaryModelEntry = getModelCatalogEntry(summaryModelId);
  if (!summaryModelEntry) {
    writeRunnerLog({
      level: "warn",
      tags: ["frontend", "agent-loop", "tool-calls", "system"],
      event: "runner.toolgateway.summary.skip",
      message: "Skipping tool artifact summary because the configured model is unavailable",
      data: {
        toolName: options.toolName,
        toolCallId: options.toolCallId,
        modelId: summaryModelId,
        reason: "unknown-model",
      },
      context: options.logContext,
    });
    return null;
  }

  let providerOptions = options.providerOptions;
  if (summaryModelId !== options.currentModelId) {
    providerOptions = buildProviderOptions(
      summaryModelEntry.owned_by ?? null,
      options.advancedOptions,
      summaryModelEntry.sdk_id?.trim(),
    );
  }

  const childContext = createChildLogContext(options.logContext, {
    parentId: options.logContext.parentId,
  });
  const startedAt = Date.now();
  options.updateToolCallById({ gatewayPhase: "summarizing" });
  writeRunnerLog({
    level: "info",
    tags: ["frontend", "agent-loop", "tool-calls", "system"],
    event: "runner.toolgateway.summary.start",
    message: "Summarizing artifactized tool output",
    kind: "start",
    data: {
      toolName: options.toolName,
      toolCallId: options.toolCallId,
      artifactId: reference.artifactId,
      modelId: summaryModelId,
      modelStrategy: config.modelStrategy,
    },
    context: childContext,
  });

  try {
    const model = resolveLanguageModel(summaryModelId, options.providers);
    const result = streamText({
      model,
      messages: mapApiMessagesToModelMessages([
        {
          role: "system",
          content:
            "You summarize temporary tool artifacts for another coding agent. " +
            "Use only the available tools to inspect the artifact. " +
            "Return plain text only, at most two short sentences, aligned with the supplied intention. " +
            "Do not mention policies, artifact ids, or unavailable details.",
        },
        {
          role: "user",
          content:
            `Tool: ${options.toolName}\n` +
            `Artifact ID: ${reference.artifactId}\n` +
            `Original format: ${reference.originalFormat}\n` +
            (typeof reference.lineCount === "number"
              ? `Artifact lines: ${reference.lineCount}\n`
              : "") +
            `Intention: ${stateSnapshot.intention ?? "Summarize the most relevant details."}`,
        },
      ]),
      tools: {
        agent_tool_artifact_get: aiTool({
          description: "Read a bounded slice of a temporary tool artifact by line range.",
          inputSchema: z.object({
            artifactId: z.string(),
            range: z
              .object({
                startLine: z.number().int().positive(),
                endLine: z.number().int().positive(),
              })
              .optional(),
            maxBytes: z.number().int().positive().optional(),
          }),
          execute: async (input) => {
            const output = await getToolArtifact(
              {
                artifactId: input.artifactId,
                range: input.range,
                maxBytes: Math.min(
                  input.maxBytes ?? config.toolArtifactGetMaxBytes,
                  config.toolArtifactGetMaxBytes,
                ),
              },
              childContext,
            );
            if (!output.ok) {
              throw new Error(output.error.message);
            }
            return output.data;
          },
        }),
        agent_tool_artifact_search: aiTool({
          description:
            "Search a temporary tool artifact with a regex and return small contextual matches.",
          inputSchema: z.object({
            artifactId: z.string(),
            pattern: z.string(),
            caseSensitive: z.boolean().optional(),
            maxMatches: z.number().int().positive().optional(),
            contextLines: z.number().int().min(0).optional(),
          }),
          execute: async (input) => {
            const output = await searchToolArtifact(
              {
                artifactId: input.artifactId,
                pattern: input.pattern,
                caseSensitive: input.caseSensitive,
                maxMatches: Math.min(
                  input.maxMatches ?? config.toolArtifactSearchMaxMatches,
                  config.toolArtifactSearchMaxMatches,
                ),
                contextLines: Math.min(
                  input.contextLines ?? config.toolArtifactSearchContextLines,
                  config.toolArtifactSearchContextLines,
                ),
              },
              childContext,
            );
            if (!output.ok) {
              throw new Error(output.error.message);
            }
            return output.data;
          },
        }),
      },
      stopWhen: stepCountIs(config.maxSteps),
      ...(providerOptions ? { providerOptions } : {}),
    });

    const [usage, summaryText] = await Promise.all([result.totalUsage, result.text]);
    const text = trimSummaryText(summaryText, config.maxSummaryChars);
    if (usage) {
      options.recordLlmUsage?.({
        modelId: summaryModelId,
        actorKind: "internal",
        actorId: "context-compaction-summary",
        actorLabel: "Context compaction",
        operation: "artifact summary",
        usage,
      });
    }
    if (!text) {
      return null;
    }

    writeRunnerLog({
      level: "info",
      tags: ["frontend", "agent-loop", "tool-calls", "system"],
      event: "runner.toolgateway.summary.end",
      message: "Artifactized tool output summary ready",
      kind: "end",
      durationMs: Math.max(0, Date.now() - startedAt),
      data: {
        toolName: options.toolName,
        toolCallId: options.toolCallId,
        artifactId: reference.artifactId,
        modelId: summaryModelId,
      },
      context: childContext,
    });
    return text;
  } catch (error) {
    writeRunnerLog({
      level: "warn",
      tags: ["frontend", "agent-loop", "tool-calls", "system"],
      event: "runner.toolgateway.summary.error",
      message: "Failed to summarize artifactized tool output",
      kind: "error",
      durationMs: Math.max(0, Date.now() - startedAt),
      data: {
        toolName: options.toolName,
        toolCallId: options.toolCallId,
        artifactId: reference.artifactId,
        error,
      },
      context: childContext,
    });
    return null;
  } finally {
    options.updateToolCallById({ gatewayPhase: undefined });
  }
}

async function applyHugeOutputPolicy(
  result: ToolResult<unknown>,
  config: ToolGatewayConfig,
  options: ExecuteThroughToolGatewayOptions,
  stateSnapshot: ToolGatewayStateSnapshot,
): Promise<{
  result: ToolResult<unknown>;
  artifactRef: ToolGatewayArtifactRef | null;
}> {
  if (!result.ok || !config.hugeOutput.enabled) {
    return { result, artifactRef: null };
  }

  const payload = toArtifactPayload(result.data);
  const payloadBytes = new TextEncoder().encode(payload.content).length;
  const thresholdBytes = selectHugeOutputThreshold(
    config.hugeOutput,
    stateSnapshot.contextUsagePct,
  );

  if (payloadBytes <= thresholdBytes) {
    writeRunnerLog({
      level: "debug",
      tags: ["frontend", "agent-loop", "tool-calls", "system"],
      event: "runner.toolgateway.huge-output.skip",
      message: "Tool output stayed inline",
      data: {
        toolName: options.toolName,
        toolCallId: options.toolCallId,
        sizeBytes: payloadBytes,
        thresholdBytes,
        contextUsagePct: stateSnapshot.contextUsagePct,
      },
      context: options.logContext,
    });
    return { result, artifactRef: null };
  }

  const created = await createToolArtifact(
    {
      runId: options.runId,
      tabId: options.tabId,
      agentId: options.agentId,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      sourceKind: stateSnapshot.sourceKind,
      policyId: "huge-output",
      originalFormat: payload.originalFormat,
      content: payload.content,
      ...(stateSnapshot.intention ? { intention: stateSnapshot.intention } : {}),
    },
    options.logContext,
  );

  if (!created.ok) {
    writeRunnerLog({
      level: "warn",
      tags: ["frontend", "agent-loop", "tool-calls", "system"],
      event: "runner.toolgateway.huge-output.error",
      message: "Failed to artifactize large tool output",
      kind: "error",
      data: {
        toolName: options.toolName,
        toolCallId: options.toolCallId,
        sizeBytes: payloadBytes,
        thresholdBytes,
        error: created.error,
      },
      context: options.logContext,
    });
    return { result, artifactRef: null };
  }

  const artifactRef: ToolGatewayArtifactRef = {
    kind: "artifact-ref",
    artifactId: created.data.artifactId,
    originalTool: options.toolName,
    sizeBytes: created.data.sizeBytes,
    lineCount: created.data.lineCount,
    originalFormat: created.data.originalFormat,
    appliedPolicies: ["huge-output"],
    note: TOOL_GATEWAY_ARTIFACT_NOTE,
  };

  writeRunnerLog({
    level: "info",
    tags: ["frontend", "agent-loop", "tool-calls", "system"],
    event: "runner.toolgateway.huge-output.artifactized",
    message: "Large tool output was stored as a tool artifact",
    kind: "event",
    data: {
      toolName: options.toolName,
      toolCallId: options.toolCallId,
      artifactId: artifactRef.artifactId,
      sizeBytes: payloadBytes,
      thresholdBytes,
      contextUsagePct: stateSnapshot.contextUsagePct,
    },
    context: options.logContext,
  });

  return {
    result: buildToolGatewayArtifactResult(artifactRef),
    artifactRef,
  };
}

async function applySummaryPolicy(
  currentResult: ToolResult<unknown>,
  artifactRef: ToolGatewayArtifactRef | null,
  config: ToolGatewayConfig,
  options: ExecuteThroughToolGatewayOptions,
  stateSnapshot: ToolGatewayStateSnapshot,
): Promise<ToolResult<unknown>> {
  if (
    !currentResult.ok ||
    !artifactRef ||
    !config.summary.enabled ||
    !stateSnapshot.intention
  ) {
    return currentResult;
  }

  const summary = await summarizeArtifactReference(
    artifactRef,
    config.summary,
    options,
    stateSnapshot,
  );
  if (!summary) {
    return currentResult;
  }

  return buildToolGatewayArtifactResult({
    ...artifactRef,
    appliedPolicies: ["huge-output", "summary"],
    summary,
  });
}

function writeGatewayCompletionLog(
  result: ToolResult<unknown>,
  finalStatus: ToolCallDisplay["status"],
  options: ExecuteThroughToolGatewayOptions,
  sourceKind: ToolGatewaySourceKind,
  stateSnapshot: ToolGatewayStateSnapshot,
): void {
  writeRunnerLog({
    level: result.ok ? "info" : "error",
    tags: ["frontend", "agent-loop", "tool-calls"],
    event: result.ok ? "runner.tool.end" : "runner.tool.error",
    message: result.ok
      ? `${options.toolName} completed`
      : `${options.toolName} failed`,
    kind: result.ok ? "end" : "error",
    data: result.ok
      ? {
          sourceKind,
          finalStatus,
          contextUsagePct: stateSnapshot.contextUsagePct,
        }
      : result.error,
    context: options.logContext,
  });
}

export async function executeThroughToolGateway(
  options: ExecuteThroughToolGatewayOptions,
): Promise<ToolResult<unknown>> {
  const executionOrigin = options.executionOrigin ?? "agent";
  const sourceKind = resolveSourceKind(
    options.toolName,
    options.mcpTool,
    options.syntheticExecutors,
  );
  const { strippedArgs, intention } = stripToolGatewayInputFields(options.rawArgs);
  const stateSnapshot = buildStateSnapshot(
    options,
    intention,
    sourceKind,
    executionOrigin,
  );
  const configProvider =
    options.configProvider ?? defaultToolGatewayConfigProvider;
  const config = configProvider.getConfig({
    toolName: options.toolName,
    sourceKind,
    stateSnapshot,
  });

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
    writeGatewayCompletionLog(result, "error", options, sourceKind, stateSnapshot);
    return result;
  }

  const executed = await executor(strippedArgs);
  let result = executed.result;

  if (executionOrigin === "agent" && result.ok) {
    const hugeOutput = await applyHugeOutputPolicy(
      result,
      config,
      options,
      stateSnapshot,
    );
    result = await applySummaryPolicy(
      hugeOutput.result,
      hugeOutput.artifactRef,
      config,
      options,
      stateSnapshot,
    );
  }

  const finalStatus =
    executed.finalStatus ?? (result.ok ? "done" : "error");
  options.updateToolCallById({
    status: finalStatus,
    result: result.ok ? result.data : result.error,
  });
  writeGatewayCompletionLog(result, finalStatus, options, sourceKind, stateSnapshot);

  return result;
}
