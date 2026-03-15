import { getAgentState, jotaiStore, patchAgentState } from "../atoms";
import {
  mcpSettingsAtom,
  callMcpTool,
  extractMcpToolErrorMessage,
  shutdownMcpRun,
} from "../mcp";
import { getModelCatalogEntry } from "../modelCatalog";
import {
  persistedContextGatewayConfigProvider,
  persistedToolGatewayConfigProvider,
} from "../gatewayPolicySettings";
import { requestApproval, consumeApprovalReason, requestUserInput } from "../approvals";
import { getSubagent } from "../subagents";
import { TOOL_DEFINITIONS } from "../tools";
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
import {
  createToolLogContext,
  logStreamDebug,
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
  isRecord,
  isRunAbortedToolResult,
  parseArgs,
  RunAbortedError,
  serializeToolResultForModel,
} from "./utils";
import { executeThroughToolGateway } from "./toolGateway";
import { executeThroughContextGateway } from "./contextGateway";

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
  const toolDefinitions = {
    ...TOOL_DEFINITIONS,
    ...mcpRuntime.toolDefinitions,
  };

  try {
    for (let iteration = 0; iteration < 50; iteration++) {
      if (signal.aborted) return;

      const turnStartedAtMs = Date.now();
      const currentApiMessages = getAgentState(tabId).apiMessages;
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
        message: `Turn ${iteration} started`,
        kind: "start",
        expandable: true,
        data: {
          iteration,
          apiMessageCount: currentApiMessages.length,
          modelId,
        },
        context: runLogContext,
      });
      logStreamDebug(debugEnabled, "turn:start", turnContext, {
        iteration,
        apiMessageCount: currentApiMessages.length,
        modelId,
      });
      const stateBeforeTurn = getAgentState(tabId);
      const activeTodo = stateBeforeTurn.todos.find((todo) => todo.state === "doing");
      const contextGateway = await executeThroughContextGateway({
        messages: currentApiMessages,
        plan: stateBeforeTurn.plan,
        todos: stateBeforeTurn.todos,
        providers,
        advancedOptions: advancedOpts,
        debugEnabled: stateBeforeTurn.showDebug ?? false,
        logContext: turnContext,
        stateSnapshot: {
          tabId,
          runId,
          agentId: "agent_main",
          modelId,
          currentTurn,
          messageCount: currentApiMessages.length,
          ...(stateBeforeTurn.config.contextLength
            ? { contextLength: stateBeforeTurn.config.contextLength }
            : {}),
          ...(activeTodo ? { activeTodoId: activeTodo.id } : {}),
        },
        configProvider: persistedContextGatewayConfigProvider,
      });
      if (contextGateway.replacementApiMessages) {
        patchAgentState(tabId, {
          apiMessages: contextGateway.replacementApiMessages,
        });
      }
      if (contextGateway.debugChatMessage) {
        appendChatMessage(tabId, contextGateway.debugChatMessage);
      }

      const streamed = await streamTurn({
        tabId,
        signal,
        modelId,
        model: languageModel,
        messages: contextGateway.messages,
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
        message: `Turn ${iteration} completed`,
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
          const toolLog = createToolLogContext(turnContext, tcId, tc.function.name);
          writeRunnerLog({
            id: toolLog.startId,
            level: "info",
            tags: ["frontend", "agent-loop", "tool-calls"],
            event: "runner.tool.start",
            message: `${tc.function.name} queued`,
            kind: "start",
            expandable: true,
            data: {
              toolName: tc.function.name,
              args: parseArgs(tc.function.arguments),
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
                        t.id === tcId ? { ...t, ...patch } : t,
                      ),
                    }
                  : m,
              ),
            }));
          }

          const rawArgs = parseArgs(tc.function.arguments);
          const mcpTool = mcpRuntime.toolsByName[tc.function.name];
          const artifactizeReturnedFiles =
            jotaiStore.get(mcpSettingsAtom)?.artifactizeReturnedFiles === true;

          const result = await executeThroughToolGateway({
            tabId,
            runId,
            agentId: "agent_main",
            toolCallId: tcId,
            toolName: tc.function.name,
            rawArgs,
            currentModelId: modelId,
            contextLength: getAgentState(tabId).config.contextLength,
            apiMessages: currentApiMessages,
            providers,
            providerOptions,
            advancedOptions: advancedOpts,
            logContext: toolLog.context,
            updateToolCallById,
            recordLlmUsage: (input) => recordLlmUsage(tabId, input),
            configProvider: persistedToolGatewayConfigProvider,
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

                if (subagentDef.requiresApproval) {
                  updateToolCallById({ status: "awaiting_approval" });
                  const approved = await requestApproval(tabId, tcId);
                  if (!approved) {
                    const reason = consumeApprovalReason(tabId, tcId);
                    updateToolCallById({ status: "denied" });
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
                const answer = await requestUserInput(tabId, tcId);
                if (answer === null) {
                  updateToolCallById({ status: "denied" });
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
              const approved = await requestApproval(tabId, tcId);
              if (!approved) {
                const reason = consumeApprovalReason(tabId, tcId);
                updateToolCallById({ status: "denied" });
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
                preArgs: args,
                args,
                logContext: toolLog.context,
                updateToolCallById,
              }),
          });

          return { tool_call_id: tcId, result };
        }),
      );
      if (signal.aborted || !isCurrentRunId(tabId, runId)) return;
      if (toolResults.some(({ result }) => isRunAbortedToolResult(result))) {
        throw new RunAbortedError();
      }

      const toolApiMessages: ApiMessage[] = toolResults.map(
        ({ tool_call_id, result }) => ({
          role: "tool" as const,
          tool_call_id,
          content: serializeToolResultForModel(
            tool_call_id,
            streamed.parsedToolCalls,
            result,
          ),
        }),
      );

      patchAgentState(tabId, (prev) => ({
        ...prev,
        apiMessages: [...prev.apiMessages, ...toolApiMessages],
      }));
    }

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
        message: "Failed to shut down MCP run",
        kind: "error",
        data: error,
        context: runLogContext,
      });
    }
  }
}
