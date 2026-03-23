import { tool as aiTool } from "ai";
import { z } from "zod";
import {
  getAgentState,
  jotaiStore,
  patchAgentState,
  toolContextCompactionEnabledAtom,
  toolContextCompactionThresholdKbAtom,
} from "../atoms";
import {
  AGENT_LOOP_LIMIT_TOOL_NAME,
  AGENT_LOOP_NEAR_LIMIT_WINDOW,
  type AgentLoopSettings,
} from "../loopLimits";
import {
  mcpSettingsAtom,
  callMcpTool,
  extractMcpToolErrorMessage,
  shutdownMcpRun,
} from "../mcp";
import { getModelCatalogEntry } from "../modelCatalog";
import { requestApproval, consumeApprovalReason, requestUserInput } from "../approvals";
import { getSubagent } from "../subagents";
import { buildToolDefinitions } from "../tools";
import { buildConversationCard, type CardAddInput } from "../tools/agentControl";
import type { ProviderInstance } from "../db";
import type {
  ApiMessage,
  ConversationCard,
  ToolCallDisplay,
  ToolErrorCode,
  ToolResult,
} from "../types";
import type { LogContext } from "@/logging/types";

import { appendChatMessage, createConversationCardAccumulator } from "./chatState";
import { isCurrentRunId } from "./abortRegistry";
import {
  buildPendingToolDisplay,
  executeLocalTool,
} from "./executeLocalTool";
import { executeToolCall } from "./executeToolCall";
import {
  createToolLogContext,
  nextLogId,
  writeRunnerLog,
} from "./logging";
import { maybeArtifactizeMcpToolResult } from "./mcpArtifacts";
import {
  type MainAgentMcpRuntime,
  prepareMainAgentMcpRuntime,
} from "./mcpRuntime";
import { recordLlmUsage } from "../sessionStats";
import { buildProviderOptions, resolveLanguageModel } from "./providerOptions";
import { streamTurn } from "./streamTurn";
import { runSubagentLoop } from "./subagentLoop";
import {
  isRunAbortedToolResult,
  parseArgs,
  RunAbortedError,
  serializeToolResultForModel,
} from "./utils";
import {
  applyToolIoReplacements,
  buildToolIoReplacementDisplay,
  buildToolIoReplacementPrompt,
  createPendingToolIoReplacement,
  DELAYED_TOOL_IO_REPLACEMENT_ENABLED,
  MAX_TOOL_CONTEXT_NOTE_CHARS,
  mergeToolContextCompactionDisplay,
  RetryableToolIoReplacementError,
  TOOL_IO_REPLACEMENT_TOOL_NAME,
  type PendingToolIoReplacement,
  toolContextCompactionThresholdKbToBytes,
  validateToolIoReplacementPayload,
} from "./toolContextCompaction";
import { maybeRunAutomaticMainContextCompaction } from "./mainContextCompaction";

function buildToolCallDisplay(
  toolCallId: string,
  toolName: string,
  rawArgs: unknown,
  mcpToolsByName: MainAgentMcpRuntime["toolsByName"],
): ToolCallDisplay {
  const registration = mcpToolsByName[toolName];
  const base = buildPendingToolDisplay(toolCallId, toolName, rawArgs);
  return registration
    ? {
        ...base,
        mcp: {
          serverId: registration.serverId,
          serverName: registration.serverName,
          toolName: registration.toolName,
          ...(registration.toolTitle ? { toolTitle: registration.toolTitle } : {}),
        },
      }
    : base;
}

function writeToolApprovalLog(input: {
  event: "waiting" | "approved" | "denied";
  toolName: string;
  context: LogContext;
  data?: Record<string, unknown>;
}): void {
  writeRunnerLog({
    level: input.event === "denied" ? "warn" : "info",
    tags: ["frontend", "agent-loop", "tool-calls"],
    event: `runner.tool.approval.${input.event}`,
    message:
      input.event === "waiting"
        ? `Tool ${input.toolName} waiting for approval`
        : input.event === "approved"
          ? `Tool ${input.toolName} was approved`
          : `Tool ${input.toolName} was denied`,
    ...(input.event === "denied" ? { kind: "error" as const } : {}),
    ...(input.data ? { data: input.data } : {}),
    context: input.context,
  });
}

function writeUserInputLifecycleLog(input: {
  event: "waiting" | "received" | "skipped";
  context: LogContext;
  data?: Record<string, unknown>;
}): void {
  writeRunnerLog({
    level: input.event === "skipped" ? "warn" : "info",
    tags: ["frontend", "agent-loop", "tool-calls"],
    event: `runner.tool.user-input.${input.event}`,
    message:
      input.event === "waiting"
        ? "Tool user_input waiting for a user response"
        : input.event === "received"
          ? "Tool user_input received a user response"
          : "Tool user_input was skipped by the user",
    ...(input.event === "skipped" ? { kind: "error" as const } : {}),
    ...(input.data ? { data: input.data } : {}),
    context: input.context,
  });
}

function updateSyntheticToolCall(
  tabId: string,
  toolCallId: string,
  patch: Partial<ToolCallDisplay>,
): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    chatMessages: prev.chatMessages.map((message) =>
      message.toolCalls
        ? {
            ...message,
            toolCalls: message.toolCalls.map((toolCall) =>
              toolCall.id === toolCallId
                ? {
                    ...toolCall,
                    ...patch,
                  }
                : toolCall,
            ),
          }
        : message,
    ),
  }));
}

function appendLoopLimitApprovalCard(input: {
  tabId: string;
  runId: string;
  traceId?: string;
  currentIteration: number;
  remainingTurns: number;
  warningThreshold: number;
  hardLimit: number;
}): string {
  const toolCallId = `loop-limit-${input.runId}-${input.currentIteration}`;

  appendChatMessage(input.tabId, {
    id: toolCallId,
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    toolCalls: [
      {
        id: toolCallId,
        tool: AGENT_LOOP_LIMIT_TOOL_NAME,
        args: {
          currentIteration: input.currentIteration,
          remainingTurns: input.remainingTurns,
          warningThreshold: input.warningThreshold,
          hardLimit: input.hardLimit,
        },
        status: "awaiting_approval",
      },
    ],
  });

  return toolCallId;
}

interface PreparedConversationCardToolCall {
  card: ConversationCard;
  result: {
    ok: true;
    data: { cardId: string; kind: ConversationCard["kind"] };
  };
}

const TOOL_IO_REPLACEMENT_TOOL_DEFINITION = aiTool({
  description:
    "Internal runner maintenance tool. Replace oversized raw tool IO from the previous turn with concise notes for future context.",
  inputSchema: z.object({
    replacements: z.array(z.object({
      toolCallId: z.string().describe("Pending tool call ID to replace"),
      inputNote: z
        .string()
        .max(MAX_TOOL_CONTEXT_NOTE_CHARS)
        .describe("Concise factual replacement for the tool input"),
      outputNote: z
        .string()
        .max(MAX_TOOL_CONTEXT_NOTE_CHARS)
        .describe("Concise factual replacement for the tool output"),
    })).min(1),
  }),
});

function prepareConversationCardToolCall(
  rawArgs: Record<string, unknown>,
): { ok: true; data: PreparedConversationCardToolCall } | {
  ok: false;
  result: Extract<ToolResult<unknown>, { ok: false }>;
} {
  const built = buildConversationCard(rawArgs as CardAddInput);
  if (!built.ok) {
    return { ok: false, result: built };
  }
  return {
    ok: true,
    data: {
      card: built.data.card,
      result: {
        ok: true,
        data: {
          cardId: built.data.cardId,
          kind: built.data.kind,
        },
      },
    },
  };
}

function applyToolIoReplacementDisplays(
  prev: ReturnType<typeof getAgentState>,
  pendingByToolCallId: ReadonlyMap<string, PendingToolIoReplacement>,
  replacements: readonly {
    toolCallId: string;
    inputNote: string;
    outputNote: string;
  }[],
): ReturnType<typeof getAgentState> {
  const replacementById = new Map(
    replacements.map((replacement) => [replacement.toolCallId, replacement] as const),
  );

  return {
    ...prev,
    chatMessages: prev.chatMessages.map((message) =>
      message.toolCalls
        ? {
            ...message,
            toolCalls: message.toolCalls.map((toolCall) => {
              const replacement = replacementById.get(toolCall.id);
              const pending = replacement
                ? pendingByToolCallId.get(toolCall.id)
                : undefined;
              if (!replacement || !pending) return toolCall;
              return {
                ...toolCall,
                contextCompaction: mergeToolContextCompactionDisplay(
                  toolCall.contextCompaction,
                  buildToolIoReplacementDisplay(pending, replacement),
                ),
              };
            }),
          }
        : message,
    ),
  };
}

export async function maybeRunForcedToolIoReplacementTurn(input: {
  tabId: string;
  signal: AbortSignal;
  runId: string;
  iteration: number;
  modelId: string;
  languageModel: Awaited<ReturnType<typeof resolveLanguageModel>>;
  providerOptions?: ReturnType<typeof buildProviderOptions>;
  debugEnabled: boolean;
  logContext: LogContext;
  pendingByToolCallId: Map<string, PendingToolIoReplacement>;
}): Promise<"skipped" | "compacted"> {
  const pending = [...input.pendingByToolCallId.values()];
  if (!DELAYED_TOOL_IO_REPLACEMENT_ENABLED || pending.length === 0) {
    return "skipped";
  }

  const internalLogContext: LogContext = {
    ...input.logContext,
    parentId: nextLogId(`tool-io-replacement:${input.runId}:${input.iteration}`),
    depth: (input.logContext.depth ?? 1) + 1,
  };
  writeRunnerLog({
    id: internalLogContext.parentId,
    level: "info",
    tags: ["frontend", "agent-loop", "system"],
    event: "runner.tool-io-replacement.start",
    message: "Forced tool IO replacement turn started",
    kind: "start",
    data: {
      iteration: input.iteration,
      pendingCount: pending.length,
      toolCallIds: pending.map((entry) => entry.toolCallId),
    },
    context: input.logContext,
  });

  const streamed = await streamTurn({
    tabId: input.tabId,
    signal: input.signal,
    modelId: input.modelId,
    model: input.languageModel,
    messages: [
      ...getAgentState(input.tabId).apiMessages,
      {
        role: "user" as const,
        content: buildToolIoReplacementPrompt(pending),
      },
    ],
    tools: {
      [TOOL_IO_REPLACEMENT_TOOL_NAME]: TOOL_IO_REPLACEMENT_TOOL_DEFINITION,
    },
    toolChoice: {
      type: "tool",
      toolName: TOOL_IO_REPLACEMENT_TOOL_NAME,
    },
    debugEnabled: input.debugEnabled,
    logContext: internalLogContext,
    providerOptions: input.providerOptions,
    appendToChat: false,
    toPendingToolCalls: () => undefined,
    usageMetadata: {
      actorKind: "internal",
      actorId: "main",
      actorLabel: "Rakh",
      operation: "tool io replacement",
    },
    onRecordUsage: (usage) => recordLlmUsage(input.tabId, usage),
  });

  const replacementCall = streamed.parsedToolCalls[0];
  if (
    streamed.parsedToolCalls.length !== 1 ||
    replacementCall?.function.name !== TOOL_IO_REPLACEMENT_TOOL_NAME
  ) {
    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.tool-io-replacement.invalid-call",
      message: "Forced tool IO replacement turn returned an unexpected tool call payload",
      kind: "error",
      data: {
        parsedToolCallCount: streamed.parsedToolCalls.length,
        toolNames: streamed.parsedToolCalls.map((call) => call.function.name),
      },
      context: internalLogContext,
    });
    throw new RetryableToolIoReplacementError(
      "Internal tool IO replacement turn did not return the required tool call.",
      {
        failure: "invalid-call",
        pendingToolCallIds: pending.map((entry) => entry.toolCallId),
        replacementCallId: replacementCall?.id,
      },
    );
  }

  const replacementArgs = parseArgs(replacementCall.function.arguments);
  const validated = validateToolIoReplacementPayload(
    replacementArgs,
    input.pendingByToolCallId,
  );
  if (!validated.ok) {
    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.tool-io-replacement.invalid-payload",
      message: "Forced tool IO replacement turn returned invalid replacement notes",
      kind: "error",
      data: {
        validationError: validated.message,
        replacementCallId: replacementCall.id,
        replacementArgs,
      },
      context: internalLogContext,
    });
    throw new RetryableToolIoReplacementError(validated.message, {
      failure: "invalid-payload",
      pendingToolCallIds: pending.map((entry) => entry.toolCallId),
      replacementCallId: replacementCall.id,
      validationError: validated.message,
    });
  }

  patchAgentState(input.tabId, (prev) =>
    applyToolIoReplacementDisplays(
      {
        ...prev,
        apiMessages: applyToolIoReplacements(
          prev.apiMessages,
          validated.replacements,
          input.pendingByToolCallId,
        ),
      },
      input.pendingByToolCallId,
      validated.replacements,
    ),
  );

  for (const replacement of validated.replacements) {
    input.pendingByToolCallId.delete(replacement.toolCallId);
  }

  writeRunnerLog({
    level: "info",
    tags: ["frontend", "agent-loop", "system"],
    event: "runner.tool-io-replacement.end",
    message: "Forced tool IO replacement turn completed",
    kind: "end",
    data: {
      iteration: input.iteration,
      replacedToolCallIds: validated.replacements.map(
        (replacement) => replacement.toolCallId,
      ),
    },
    context: internalLogContext,
  });

  return "compacted";
}

export async function agentLoop(
  tabId: string,
  signal: AbortSignal,
  modelId: string,
  providers: ProviderInstance[],
  debugEnabled: boolean,
  runId: string,
  currentTurn: number,
  runLogContext: LogContext,
  loopSettings: AgentLoopSettings,
): Promise<void> {
  const languageModel = resolveLanguageModel(modelId, providers);
  const modelEntry = getModelCatalogEntry(modelId);
  const provider = modelEntry?.owned_by ?? null;
  const advancedOpts = getAgentState(tabId).config.advancedOptions;
  const providerOptions = buildProviderOptions(
    provider,
    advancedOpts,
    modelEntry?.sdk_id?.trim(),
  );
  const mcpRuntime = await prepareMainAgentMcpRuntime(
    tabId,
    runId,
    getAgentState(tabId).config.cwd,
    runLogContext,
  );
  const warningThreshold = loopSettings.warningThreshold;
  const hardLimit = loopSettings.hardLimit;
  let nearLimitConfirmed = false;
  const pendingToolIoReplacements = new Map<string, PendingToolIoReplacement>();

  try {
    for (let iteration = 0; iteration < hardLimit; iteration++) {
      if (signal.aborted) return;
      const currentIteration = iteration + 1;
      const remainingTurns = hardLimit - iteration;
      const warningState = getAgentState(tabId).loopLimitWarning;
      const warningAlreadyTracked = warningState?.runId === runId;
      const isNearLimit = remainingTurns <= AGENT_LOOP_NEAR_LIMIT_WINDOW;

      if (isNearLimit && !nearLimitConfirmed) {
        patchAgentState(tabId, { loopLimitWarning: null });
        const toolCallId = appendLoopLimitApprovalCard({
          tabId,
          runId,
          traceId: runLogContext.traceId,
          currentIteration,
          remainingTurns,
          warningThreshold,
          hardLimit,
        });
        writeRunnerLog({
          level: "warn",
          tags: ["frontend", "agent-loop", "system"],
          event: "runner.loop.limit.pause.waiting",
          message: "Main agent loop paused near the configured hard limit",
          kind: "error",
          data: {
            currentIteration,
            remainingTurns,
            warningThreshold,
            hardLimit,
          },
          context: runLogContext,
        });
        const approved = await requestApproval(tabId, toolCallId);
        if (signal.aborted || !isCurrentRunId(tabId, runId)) return;

        if (!approved) {
          updateSyntheticToolCall(tabId, toolCallId, {
            status: "denied",
            result: {
              action: "stop",
              currentIteration,
              remainingTurns,
              hardLimit,
            },
          });
          writeRunnerLog({
            level: "warn",
            tags: ["frontend", "agent-loop", "system"],
            event: "runner.loop.limit.pause.stopped",
            message: "Main agent loop was stopped from the near-limit prompt",
            kind: "error",
            data: {
              currentIteration,
              remainingTurns,
              warningThreshold,
              hardLimit,
            },
            context: runLogContext,
          });
          patchAgentState(tabId, {
            status: "error",
            error: `Stopped near configured loop hard limit (${hardLimit} turns)`,
            errorAction: null,
            errorDetails: null,
            loopLimitWarning: null,
            streamingContent: null,
          });
          return;
        }

        nearLimitConfirmed = true;
        updateSyntheticToolCall(tabId, toolCallId, {
          status: "done",
          result: {
            action: "continue",
            currentIteration,
            remainingTurns,
            hardLimit,
          },
        });
        writeRunnerLog({
          level: "info",
          tags: ["frontend", "agent-loop", "system"],
          event: "runner.loop.limit.pause.continued",
          message: "Main agent loop resumed from the near-limit prompt",
          data: {
            currentIteration,
            remainingTurns,
            warningThreshold,
            hardLimit,
          },
          context: runLogContext,
        });
      } else if (currentIteration > warningThreshold && !warningAlreadyTracked) {
        patchAgentState(tabId, {
          loopLimitWarning: {
            runId,
            currentIteration,
            warningThreshold,
            hardLimit,
            dismissed: false,
          },
        });
        writeRunnerLog({
          level: "warn",
          tags: ["frontend", "agent-loop", "system"],
          event: "runner.loop.limit.warning",
          message: "Main agent loop crossed the configured warning threshold",
          data: {
            currentIteration,
            warningThreshold,
            hardLimit,
          },
          context: runLogContext,
        });
      }

      const toolContextCompactionEnabled =
        jotaiStore.get(toolContextCompactionEnabledAtom) !== false;

      if (iteration > 0) {
        if (toolContextCompactionEnabled && pendingToolIoReplacements.size > 0) {
          await maybeRunForcedToolIoReplacementTurn({
            tabId,
            signal,
            runId,
            iteration,
            modelId,
            languageModel,
            providerOptions,
            debugEnabled,
            logContext: runLogContext,
            pendingByToolCallId: pendingToolIoReplacements,
          });
          if (signal.aborted || !isCurrentRunId(tabId, runId)) return;
        }

        const autoCompactionResult =
          await maybeRunAutomaticMainContextCompaction({
            tabId,
            signal,
            runId,
            currentTurn,
            logContext: runLogContext,
          });
        if (autoCompactionResult.status === "compacted") {
          writeRunnerLog({
            level: "info",
            tags: ["frontend", "agent-loop", "system"],
            event: "runner.context-compaction.auto.triggered",
            message:
              "Automatic context compaction ran before the next assistant iteration",
            data: {
              source: "iteration",
              iteration,
              trigger: autoCompactionResult.trigger,
            },
            context: runLogContext,
          });
        } else if (autoCompactionResult.status === "failed") {
          writeRunnerLog({
            level: "warn",
            tags: ["frontend", "agent-loop", "system"],
            event: "runner.context-compaction.auto.failed",
            message:
              "Automatic context compaction failed before the next assistant iteration",
            data: {
              source: "iteration",
              iteration,
              trigger: autoCompactionResult.trigger,
              error:
                autoCompactionResult.error ?? autoCompactionResult.message,
            },
            context: runLogContext,
          });
        }
      }

      const turnStartedAtMs = Date.now();
      const currentApiMessages = getAgentState(tabId).apiMessages;
      const toolDefinitions = {
        ...buildToolDefinitions(),
        ...mcpRuntime.toolDefinitions,
      };
      const turnStartId = nextLogId(`turn:${runId}:${iteration}`);
      const turnContext: LogContext = {
        ...runLogContext,
        parentId: turnStartId,
        depth: (runLogContext.depth ?? 1) + 1,
      };
      writeRunnerLog({
        id: turnStartId,
        level: "info",
        tags: ["frontend", "agent-loop", "messages"],
        event: "runner.turn.start",
        message: `Main turn ${iteration} started`,
        kind: "start",
        expandable: true,
        data: {
          iteration,
          apiMessageCount: currentApiMessages.length,
          modelId,
        },
        context: runLogContext,
      });

      const streamed = await streamTurn({
        tabId,
        signal,
        modelId,
        model: languageModel,
        messages: currentApiMessages,
        tools: toolDefinitions,
        debugEnabled,
        logContext: turnContext,
        providerOptions,
        statusWhileStreaming: "thinking",
        toPendingToolCalls: (toolCalls) =>
          toolCalls.length > 0
            ? toolCalls.map((tc) =>
                buildToolCallDisplay(
                  tc.id,
                  tc.function.name,
                  tc.function.arguments,
                  mcpRuntime.toolsByName,
                ),
              )
            : undefined,
        usageMetadata: {
          actorKind: "main",
          actorId: "main",
          actorLabel: "Rakh",
          operation: "assistant turn",
        },
        onRecordUsage: (input) => recordLlmUsage(tabId, input),
      });

      const turnDurationMs = Math.max(0, Date.now() - turnStartedAtMs);
      writeRunnerLog({
        level: "info",
        tags: ["frontend", "agent-loop", "messages"],
        event: "runner.turn.end",
        message: `Main turn ${iteration} completed`,
        kind: "end",
        durationMs: turnDurationMs,
        data: {
          iteration,
          toolCallCount: streamed.parsedToolCalls.length,
          assistantTextChars: streamed.text.length,
          assistantReasoningChars: streamed.reasoning.length,
          reasoningDurationMs: streamed.reasoningDurationMs ?? undefined,
        },
        context: turnContext,
      });

      patchAgentState(tabId, (prev) => ({
        ...prev,
        apiMessages: [...prev.apiMessages, streamed.assistantApiMsg],
      }));

      if (streamed.parsedToolCalls.length === 0) {
        patchAgentState(tabId, { status: "idle" });
        return;
      }

      patchAgentState(tabId, { status: "working" });

      const turnCardAccumulator = createConversationCardAccumulator(
        tabId,
        streamed.assistantChatId,
        streamed.parsedToolCalls,
      );

      const toolResults = await Promise.all(
        streamed.parsedToolCalls.map(async (tc) => {
          const tcId = tc.id;
          const rawArgs = parseArgs(tc.function.arguments);
          const toolLog = createToolLogContext(turnContext, tcId, tc.function.name);
          writeRunnerLog({
            id: toolLog.startId,
            level: "info",
            tags: ["frontend", "agent-loop", "tool-calls"],
            event: "runner.tool.start",
            message: `Tool ${tc.function.name} queued`,
            kind: "start",
            expandable: true,
            data: {
              toolName: tc.function.name,
              args: rawArgs,
            },
            context: {
              ...turnContext,
              correlationId: tcId,
              depth: turnContext.depth ?? 2,
            },
          });

          function updateToolCallById(patch: Partial<ToolCallDisplay>): void {
            if (signal.aborted || !isCurrentRunId(tabId, runId)) return;
            patchAgentState(tabId, (prev) => ({
              ...prev,
              chatMessages: prev.chatMessages.map((m) =>
                m.toolCalls
                  ? {
                      ...m,
                      toolCalls: m.toolCalls.map((t) =>
                        t.id === tcId
                          ? {
                              ...t,
                              ...patch,
                              ...(patch.contextCompaction
                                ? {
                                    contextCompaction:
                                      mergeToolContextCompactionDisplay(
                                        t.contextCompaction,
                                        patch.contextCompaction,
                                      ),
                                  }
                                : {}),
                            }
                          : t,
                      ),
                    }
                  : m,
              ),
            }));
          }

          const mcpTool = mcpRuntime.toolsByName[tc.function.name];
          const artifactizeReturnedFiles =
            jotaiStore.get(mcpSettingsAtom)?.artifactizeReturnedFiles === true;

          const executed = await executeToolCall({
            toolName: tc.function.name,
            rawArgs,
            logContext: toolLog.context,
            updateToolCallById,
            mcpTool,
            syntheticExecutors: {
              agent_subagent_call: async (args) => {
                const subagentId =
                  typeof args.subagentId === "string" ? args.subagentId : "";
                const subagentMessage =
                  typeof args.message === "string" ? args.message : "";
                const subagentDef = getSubagent(subagentId);

                if (!subagentDef) {
                  updateToolCallById({
                    status: "error",
                    result: {
                      code: "NOT_FOUND",
                      message: `Unknown subagent "${subagentId}"`,
                    },
                  });
                  return {
                    result: {
                      ok: false as const,
                      error: {
                        code: "NOT_FOUND" as const,
                        message: `Unknown subagent "${subagentId}"`,
                      },
                    },
                  };
                }

                if (!(subagentDef.callableByMainAgent ?? true)) {
                  updateToolCallById({
                    status: "error",
                    result: {
                      code: "INVALID_ARGUMENT",
                      message: `Subagent "${subagentId}" is not available via agent_subagent_call.`,
                    },
                  });
                  return {
                    result: {
                      ok: false as const,
                      error: {
                        code: "INVALID_ARGUMENT" as const,
                        message: `Subagent "${subagentId}" is not available via agent_subagent_call.`,
                      },
                    },
                  };
                }

                if (subagentDef.requiresApproval) {
                  updateToolCallById({ status: "awaiting_approval" });
                  writeToolApprovalLog({
                    event: "waiting",
                    toolName: tc.function.name,
                    context: toolLog.context,
                    data: { subagentId },
                  });
                  const approved = await requestApproval(tabId, tcId);
                  if (!approved) {
                    const reason = consumeApprovalReason(tabId, tcId);
                    updateToolCallById({ status: "denied" });
                    writeToolApprovalLog({
                      event: "denied",
                      toolName: tc.function.name,
                      context: toolLog.context,
                      data: {
                        subagentId,
                        ...(reason ? { reason } : {}),
                      },
                    });
                    return {
                      result: {
                        ok: false as const,
                        error: {
                          code: "PERMISSION_DENIED" as const,
                          message: reason ?? "Subagent call denied by user",
                        },
                      },
                      finalStatus: "denied" as const,
                    };
                  }
                  writeToolApprovalLog({
                    event: "approved",
                    toolName: tc.function.name,
                    context: toolLog.context,
                    data: { subagentId },
                  });
                }

                updateToolCallById({ status: "running" });
                const subagentResult = await runSubagentLoop({
                  tabId,
                  signal,
                  runId,
                  currentTurn,
                  subagentDef,
                  message: subagentMessage,
                  parentModelId: modelId,
                  providers,
                  debugEnabled,
                  logContext: toolLog.context,
                });
                return subagentResult.ok
                  ? {
                      result: {
                        ok: true as const,
                        data: subagentResult.data,
                      },
                    }
                  : {
                      result: {
                        ok: false as const,
                        error: {
                          code: subagentResult.error.code as ToolErrorCode,
                          message: subagentResult.error.message,
                        },
                      },
                    };
              },
              user_input: async () => {
                updateToolCallById({ status: "awaiting_approval" });
                writeUserInputLifecycleLog({
                  event: "waiting",
                  context: toolLog.context,
                });
                const answer = await requestUserInput(tabId, tcId);
                if (answer === null) {
                  updateToolCallById({ status: "denied" });
                  writeUserInputLifecycleLog({
                    event: "skipped",
                    context: toolLog.context,
                  });
                  return {
                    result: {
                      ok: false as const,
                      error: {
                        code: "PERMISSION_DENIED" as const,
                        message: "User skipped the question.",
                      },
                    },
                    finalStatus: "denied" as const,
                  };
                }
                writeUserInputLifecycleLog({
                  event: "received",
                  context: toolLog.context,
                  data: { answerLength: answer.length },
                });
                return {
                  result: { ok: true as const, data: { answer } },
                };
              },
              agent_card_add: async (args) => {
                updateToolCallById({ status: "running" });
                const preparedCard = prepareConversationCardToolCall(args);
                if (!preparedCard.ok) {
                  turnCardAccumulator.markSkipped(tcId);
                  updateToolCallById({
                    status: "error",
                    result: preparedCard.result.error,
                  });
                  return { result: preparedCard.result };
                }

                turnCardAccumulator.markDone(tcId, preparedCard.data.card);
                return {
                  result: preparedCard.data.result,
                };
              },
            },
            mcpExecutor: async (args) => {
              if (!mcpTool) {
                return {
                  result: {
                    ok: false as const,
                    error: {
                      code: "INTERNAL" as const,
                      message: `MCP executor missing registration for "${tc.function.name}"`,
                    },
                  },
                };
              }

              updateToolCallById({ status: "awaiting_approval" });
              writeToolApprovalLog({
                event: "waiting",
                toolName: tc.function.name,
                context: toolLog.context,
                data: {
                  serverId: mcpTool.serverId,
                  serverName: mcpTool.serverName,
                  toolName: mcpTool.toolName,
                },
              });
              const approved = await requestApproval(tabId, tcId);
              if (!approved) {
                const reason = consumeApprovalReason(tabId, tcId);
                updateToolCallById({ status: "denied" });
                writeToolApprovalLog({
                  event: "denied",
                  toolName: tc.function.name,
                  context: toolLog.context,
                  data: {
                    serverId: mcpTool.serverId,
                    serverName: mcpTool.serverName,
                    toolName: mcpTool.toolName,
                    ...(reason ? { reason } : {}),
                  },
                });
                return {
                  result: {
                    ok: false as const,
                    error: {
                      code: "PERMISSION_DENIED" as const,
                      message: reason ?? "MCP tool call denied by user",
                    },
                  },
                  finalStatus: "denied" as const,
                };
              }
              writeToolApprovalLog({
                event: "approved",
                toolName: tc.function.name,
                context: toolLog.context,
                data: {
                  serverId: mcpTool.serverId,
                  serverName: mcpTool.serverName,
                  toolName: mcpTool.toolName,
                },
              });

              updateToolCallById({ status: "running" });
              try {
                const rawMcpResult = await callMcpTool(
                  runId,
                  mcpTool.serverId,
                  mcpTool.toolName,
                  args,
                  toolLog.context,
                );
                const mcpResult = await maybeArtifactizeMcpToolResult(
                  tabId,
                  runId,
                  mcpTool,
                  rawMcpResult,
                  artifactizeReturnedFiles,
                  toolLog.context,
                );

                if (mcpResult.isError) {
                  return {
                    result: {
                      ok: false as const,
                      error: {
                        code: "INTERNAL" as const,
                        message: extractMcpToolErrorMessage(mcpResult),
                        details: {
                          mcp: mcpResult,
                          serverId: mcpTool.serverId,
                          serverName: mcpTool.serverName,
                          toolName: mcpTool.toolName,
                        },
                      },
                    },
                  };
                }

                return {
                  result: { ok: true as const, data: mcpResult },
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                  result: {
                    ok: false as const,
                    error: {
                      code: "INTERNAL" as const,
                      message,
                      details: {
                        serverId: mcpTool.serverId,
                        serverName: mcpTool.serverName,
                        toolName: mcpTool.toolName,
                      },
                    },
                  },
                };
              }
            },
            localExecutor: async (args) =>
              executeLocalTool({
                tabId,
                runId,
                agentId: "agent_main",
                currentTurn,
                toolCallId: tcId,
                toolName: tc.function.name,
                preArgs: rawArgs,
                args,
                logContext: toolLog.context,
                updateToolCallById,
              }),
          });
          const result = executed.result;

          const fallbackContent = serializeToolResultForModel(
            tcId,
            streamed.parsedToolCalls,
            result,
          );

          return {
            tool_call_id: tcId,
            result,
            content: fallbackContent,
          };
        }),
      );
      if (signal.aborted || !isCurrentRunId(tabId, runId)) return;
      if (toolResults.some(({ result }) => isRunAbortedToolResult(result))) {
        throw new RunAbortedError();
      }

      const toolApiMessages: ApiMessage[] = toolResults.map(
        ({ tool_call_id, content }) => ({
          role: "tool" as const,
          tool_call_id,
          content,
        }),
      );

      patchAgentState(tabId, (prev) => ({
        ...prev,
        apiMessages: [...prev.apiMessages, ...toolApiMessages],
      }));

      if (toolContextCompactionEnabled && DELAYED_TOOL_IO_REPLACEMENT_ENABLED) {
        const thresholdBytes = toolContextCompactionThresholdKbToBytes(
          jotaiStore.get(toolContextCompactionThresholdKbAtom),
        );
        const toolCallById = new Map(
          streamed.parsedToolCalls.map((toolCall) => [toolCall.id, toolCall] as const),
        );

        for (const { tool_call_id, result } of toolResults) {
          const toolCall = toolCallById.get(tool_call_id);
          if (!toolCall) continue;

          const rawArgs = parseArgs(toolCall.function.arguments);
          const pendingReplacement = createPendingToolIoReplacement(
            tool_call_id,
            toolCall.function.name,
            rawArgs,
            result,
            {
              enabled: true,
              thresholdBytes,
            },
          );
          if (pendingReplacement) {
            pendingToolIoReplacements.set(tool_call_id, pendingReplacement);
          }
        }
      }
    }

    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.loop.limit.error",
      message: "Main agent loop hit the configured hard limit",
      kind: "error",
      data: { maxIterations: hardLimit, warningThreshold },
      context: runLogContext,
    });
    patchAgentState(tabId, {
      status: "error",
      error: `Reached maximum iteration limit (${hardLimit} turns)`,
      loopLimitWarning: null,
    });
  } finally {
    try {
      await shutdownMcpRun(runId, runLogContext);
    } catch (error) {
      writeRunnerLog({
        level: "error",
        tags: ["frontend", "agent-loop", "system"],
        event: "runner.mcp.shutdown.error",
        message: "MCP shutdown failed",
        kind: "error",
        data: error,
        context: runLogContext,
      });
    }
  }
}
