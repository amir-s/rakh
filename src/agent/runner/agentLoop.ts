import {
  getAgentState,
  jotaiStore,
  patchAgentState,
  toolContextCompactionEnabledAtom,
} from "../atoms";
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
  buildToolContextCompactedInput,
  buildToolContextCompactedOutput,
  mergeToolContextCompactionDisplay,
  prepareToolContextCompaction,
  type ToolContextCompactionSourceKind,
} from "./toolContextCompaction";
import { maybeRunAutomaticMainContextCompaction } from "./mainContextCompaction";

const SYNTHETIC_TOOL_NAMES = new Set([
  "agent_subagent_call",
  "user_input",
  "agent_card_add",
]);

function resolveToolContextCompactionSourceKind(
  toolName: string,
  mcpToolsByName: MainAgentMcpRuntime["toolsByName"],
): ToolContextCompactionSourceKind {
  if (mcpToolsByName[toolName]) return "mcp";
  if (SYNTHETIC_TOOL_NAMES.has(toolName)) return "synthetic";
  return "local";
}

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

interface PreparedConversationCardToolCall {
  card: ConversationCard;
  result: {
    ok: true;
    data: { cardId: string; kind: ConversationCard["kind"] };
  };
}

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

export async function agentLoop(
  tabId: string,
  signal: AbortSignal,
  modelId: string,
  providers: ProviderInstance[],
  debugEnabled: boolean,
  runId: string,
  currentTurn: number,
  runLogContext: LogContext,
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

  try {
    for (let iteration = 0; iteration < 50; iteration++) {
      if (signal.aborted) return;

      if (iteration > 0) {
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
      const toolContextCompactionEnabled =
        jotaiStore.get(toolContextCompactionEnabledAtom) !== false;
      const toolDefinitions = {
        ...buildToolDefinitions(toolContextCompactionEnabled),
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

      const preparedToolCalls = new Map(
        streamed.parsedToolCalls.map((tc) => {
          const prepared = prepareToolContextCompaction(
            tc.function.name,
            parseArgs(tc.function.arguments),
            resolveToolContextCompactionSourceKind(
              tc.function.name,
              mcpRuntime.toolsByName,
            ),
            { enabled: toolContextCompactionEnabled },
          );
          if (prepared.warnings.length > 0) {
            writeRunnerLog({
              level: "warn",
              tags: ["frontend", "agent-loop", "tool-calls"],
              event: "runner.tool.context-compaction.ignored",
              message: `Tool ${tc.function.name} ignored context compaction metadata`,
              data: {
                toolName: tc.function.name,
                warnings: prepared.warnings,
              },
              context: {
                ...turnContext,
                correlationId: tc.id,
                depth: turnContext.depth ?? 2,
              },
            });
          }
          return [tc.id, prepared] as const;
        }),
      );

      const assistantApiMsg = {
        ...streamed.assistantApiMsg,
        ...(streamed.assistantApiMsg.tool_calls
          ? {
              tool_calls: streamed.assistantApiMsg.tool_calls.map((toolCall) => {
                const prepared = preparedToolCalls.get(toolCall.id);
                if (!prepared) return toolCall;
                const compacted = buildToolContextCompactedInput(
                  toolCall.function.name,
                  prepared,
                );
                return {
                  ...toolCall,
                  function: {
                    ...toolCall.function,
                    arguments: compacted.argumentsJson,
                  },
                };
              }),
            }
          : {}),
      };

      patchAgentState(tabId, (prev) => ({
        ...prev,
        apiMessages: [...prev.apiMessages, assistantApiMsg],
        chatMessages: prev.chatMessages.map((message) =>
          message.toolCalls
            ? {
                ...message,
                toolCalls: message.toolCalls.map((toolCall) => {
                  const prepared = preparedToolCalls.get(toolCall.id);
                  if (!prepared) return toolCall;
                  const compacted = buildToolContextCompactedInput(
                    toolCall.tool,
                    prepared,
                  );
                  return compacted.display
                    ? {
                        ...toolCall,
                        contextCompaction: mergeToolContextCompactionDisplay(
                          toolCall.contextCompaction,
                          compacted.display,
                        ),
                      }
                    : toolCall;
                }),
              }
            : message,
        ),
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
          const preparedCompaction = preparedToolCalls.get(tcId);
          const rawArgs = preparedCompaction?.strippedArgs ?? parseArgs(tc.function.arguments);
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

          const result = await executeToolCall({
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

          const fallbackContent = serializeToolResultForModel(
            tcId,
            streamed.parsedToolCalls,
            result,
          );
          const compactedOutput = preparedCompaction
            ? buildToolContextCompactedOutput(
                tc.function.name,
                result,
                preparedCompaction,
                fallbackContent,
              )
            : { content: fallbackContent };

          if (compactedOutput.display) {
            updateToolCallById({
              contextCompaction: mergeToolContextCompactionDisplay(
                preparedCompaction?.display,
                compactedOutput.display,
              ),
            });
          }

          return {
            tool_call_id: tcId,
            result,
            content: compactedOutput.content,
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
    }

    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.loop.limit.error",
      message: "Main agent loop hit the 50-turn limit",
      kind: "error",
      data: { maxIterations: 50 },
      context: runLogContext,
    });
    patchAgentState(tabId, {
      status: "error",
      error: "Reached maximum iteration limit (50 turns)",
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
