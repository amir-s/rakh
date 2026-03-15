import { getAgentState, patchAgentState } from "../atoms";
import { getToolDefinitionsByNames } from "../tools";
import {
  requestUserInput,
} from "../approvals";
import {
  getSubagentArtifactSpec,
  getSubagentArtifactSpecs,
  type SubagentDefinition,
} from "../subagents";
import { validateArtifactContentWithValidator } from "../subagents/contracts";
import type {
  SubagentArtifactSpec,
  SubagentArtifactValidation,
  SubagentArtifactValidationStatus,
} from "../subagents/types";
import type {
  ApiMessage,
  ConversationCard,
  SerializedConversationCard,
  ToolCallDisplay,
  ToolResult,
} from "../types";
import {
  ARTIFACT_CARD_PARENT_INSTRUCTION,
} from "../types";
import {
  artifactGet,
  getArtifactFrameworkMetadata,
  withArtifactFrameworkMetadata,
  type ArtifactManifest,
} from "../tools/artifacts";
import { buildConversationCard, type CardAddInput } from "../tools/agentControl";
import type { ProviderInstance } from "../db";
import type { LogContext } from "@/logging/types";

import {
  createConversationCardAccumulator,
} from "./chatState";
import {
  buildPendingToolDisplay,
  executeLocalTool,
} from "./executeLocalTool";
import {
  createToolLogContext,
  nextLogId,
  nextTraceId,
  writeRunnerLog,
} from "./logging";
import {
  resolveLanguageModel,
} from "./providerOptions";
import { recordLlmUsage } from "../sessionStats";
import { streamTurn } from "./streamTurn";
import {
  buildSubagentSystemPrompt,
  resolveSubagentModelId,
} from "./systemPrompt";
import {
  isCurrentRunId,
} from "./abortRegistry";
import {
  isRunAbortedToolResult,
  parseArgs,
  RunAbortedError,
  serializeToolResultForModel,
} from "./utils";
import { executeThroughToolGateway } from "./toolGateway";
import { executeThroughContextGateway } from "./contextGateway";

type ToolFailureResult = Extract<ToolResult<unknown>, { ok: false }>;

interface PreparedSubagentArtifactToolCall {
  args: Record<string, unknown>;
  spec?: SubagentArtifactSpec;
  validation?: Omit<SubagentArtifactValidation, "artifactId">;
}

interface PreparedConversationCardToolCall {
  card: ConversationCard;
  result: {
    ok: true;
    data: { cardId: string; kind: ConversationCard["kind"] };
  };
}

function makeSubagentToolError(
  message: string,
  details?: Record<string, unknown>,
): ToolFailureResult {
  return {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message,
      ...(details ? { details } : {}),
    },
  };
}

function normalizeSubagentArtifactValidation(
  spec: SubagentArtifactSpec,
  status: SubagentArtifactValidationStatus,
  issues?: SubagentArtifactValidation["issues"],
): Omit<SubagentArtifactValidation, "artifactId"> | undefined {
  const validatorId = spec.validator?.id;
  if (!validatorId) return undefined;
  return {
    artifactType: spec.artifactType,
    validatorId,
    status,
    ...(issues && issues.length > 0 ? { issues } : {}),
  };
}

function validateSubagentArtifactContent(
  spec: SubagentArtifactSpec,
  content: string,
): Omit<SubagentArtifactValidation, "artifactId"> | undefined {
  if (!spec.validator || spec.contentFormat !== "json") return undefined;
  const validation = validateArtifactContentWithValidator(spec.validator, content);
  return normalizeSubagentArtifactValidation(
    spec,
    validation.status,
    validation.issues,
  );
}

function prepareConversationCardToolCall(
  rawArgs: Record<string, unknown>,
): { ok: true; data: PreparedConversationCardToolCall } | {
  ok: false;
  result: ToolFailureResult;
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

function serializeConversationCardForParent(
  card: ConversationCard,
): SerializedConversationCard {
  if (card.kind === "summary") {
    return {
      kind: "summary",
      ...(card.title ? { title: card.title } : {}),
      markdown: card.markdown,
    };
  }

  return {
    kind: "artifact",
    ...(card.title ? { title: card.title } : {}),
    artifactId: card.artifactId,
    ...(card.version !== undefined ? { version: card.version } : {}),
    instruction: ARTIFACT_CARD_PARENT_INSTRUCTION,
  };
}

export interface SubagentCallResult {
  subagentId: string;
  name: string;
  modelId: string;
  startedAtMs: number;
  finishedAtMs: number;
  turns: number;
  rawText: string;
  note?: string;
  cards: SerializedConversationCard[];
  artifacts: ArtifactManifest[];
  artifactValidations: SubagentArtifactValidation[];
}

interface SubagentLoopOptions {
  tabId: string;
  signal: AbortSignal;
  runId: string;
  currentTurn: number;
  subagentDef: SubagentDefinition;
  message: string;
  parentModelId: string;
  providers: ProviderInstance[];
  debugEnabled: boolean;
  logContext: LogContext;
}

export async function runSubagentLoop(
  opts: SubagentLoopOptions,
): Promise<
  | { ok: true; data: SubagentCallResult }
  | { ok: false; error: { code: string; message: string } }
> {
  const {
    tabId,
    signal,
    runId,
    currentTurn,
    subagentDef,
    message,
    parentModelId,
    providers,
    debugEnabled,
    logContext,
  } = opts;

  const startedAtMs = Date.now();
  const subagentStartId = nextLogId(`subagent:${subagentDef.id}`);
  const subagentRootContext: LogContext = {
    ...logContext,
    agentId: `agent_${subagentDef.id}`,
  };
  const subagentContext: LogContext = {
    ...subagentRootContext,
    traceId: nextTraceId(logContext.traceId ?? nextTraceId("trace", runId), subagentDef.id),
    parentId: subagentStartId,
    depth: (logContext.depth ?? 0) + 1,
  };
  writeRunnerLog({
    id: subagentStartId,
    level: "info",
    tags: ["frontend", "agent-loop", "messages"],
    event: "runner.subagent.start",
    message: `${subagentDef.name} started`,
    kind: "start",
    expandable: true,
    data: {
      subagentId: subagentDef.id,
      modelId: parentModelId,
    },
    context: subagentRootContext,
  });
  const modelId = resolveSubagentModelId(subagentDef, parentModelId, providers);

  let languageModel;
  try {
    languageModel = resolveLanguageModel(modelId, providers);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const toolDefs = getToolDefinitionsByNames(subagentDef.tools);
  const communicationProfile = getAgentState(tabId).config.communicationProfile;
  const systemPromptText = buildSubagentSystemPrompt(subagentDef, communicationProfile);

  const localApiMessages: ApiMessage[] = [
    { role: "system", content: systemPromptText },
    {
      role: "user",
      content:
        message.trim() || "(No task provided — please ask what you should do.)",
    },
  ];

  let finalText = "";
  let turns = 0;
  const MAX_SUBAGENT_ITERATIONS = 15;
  const collectedCards: ConversationCard[] = [];
  const collectedArtifacts: ArtifactManifest[] = [];
  const artifactValidations: SubagentArtifactValidation[] = [];

  async function prepareSubagentArtifactToolCall(
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): Promise<
    | { ok: true; data: PreparedSubagentArtifactToolCall }
    | { ok: false; result: ToolFailureResult }
  > {
    const declaredArtifacts = getSubagentArtifactSpecs(subagentDef);
    if (declaredArtifacts.length === 0) {
      return { ok: true, data: { args: rawArgs } };
    }

    if (
      toolName !== "agent_artifact_create" &&
      toolName !== "agent_artifact_version"
    ) {
      return { ok: true, data: { args: rawArgs } };
    }

    const requestedArtifactType =
      typeof rawArgs.artifactType === "string" ? rawArgs.artifactType.trim() : "";

    if (toolName === "agent_artifact_create") {
      if (!requestedArtifactType) {
        return {
          ok: false,
          result: makeSubagentToolError(
            `Subagent "${subagentDef.id}" must set artifactType when creating artifact payloads.`,
          ),
        };
      }

      const spec = getSubagentArtifactSpec(subagentDef, requestedArtifactType);
      if (!spec) {
        return {
          ok: false,
          result: makeSubagentToolError(
            `Unknown artifactType "${requestedArtifactType}" for subagent "${subagentDef.id}".`,
            { artifactType: requestedArtifactType },
          ),
        };
      }

      const kind = typeof rawArgs.kind === "string" ? rawArgs.kind : "";
      if (kind !== spec.kind) {
        return {
          ok: false,
          result: makeSubagentToolError(
            `artifactType "${requestedArtifactType}" must use kind "${spec.kind}".`,
            { artifactType: requestedArtifactType, expectedKind: spec.kind, actualKind: kind },
          ),
        };
      }

      const contentFormat =
        typeof rawArgs.contentFormat === "string" ? rawArgs.contentFormat : "";
      if (contentFormat !== spec.contentFormat) {
        return {
          ok: false,
          result: makeSubagentToolError(
            `artifactType "${requestedArtifactType}" must use contentFormat "${spec.contentFormat}".`,
            {
              artifactType: requestedArtifactType,
              expectedContentFormat: spec.contentFormat,
              actualContentFormat: contentFormat,
            },
          ),
        };
      }

      const content = typeof rawArgs.content === "string" ? rawArgs.content : null;
      if (content === null) {
        return {
          ok: false,
          result: makeSubagentToolError(
            `artifactType "${requestedArtifactType}" requires string content.`,
          ),
        };
      }

      const validation = validateSubagentArtifactContent(spec, content);
      if (validation?.status === "failed") {
        return {
          ok: false,
          result: makeSubagentToolError(
            `Artifact "${requestedArtifactType}" failed validation.`,
            {
              artifactType: requestedArtifactType,
              validatorId: validation.validatorId,
              issues: validation.issues,
            },
          ),
        };
      }

      return {
        ok: true,
        data: {
          args: {
            ...rawArgs,
            artifactType: requestedArtifactType,
            metadata: withArtifactFrameworkMetadata(
              rawArgs.metadata,
              requestedArtifactType,
              spec.validator?.id,
            ),
          },
          spec,
          validation,
        },
      };
    }

    const artifactId =
      typeof rawArgs.artifactId === "string" ? rawArgs.artifactId.trim() : "";
    if (!artifactId) {
      return {
        ok: false,
        result: makeSubagentToolError("artifactId must not be empty"),
      };
    }

    const latestResult = await artifactGet(tabId, {
      artifactId,
      includeContent: true,
    });
    if (!latestResult.ok) {
      return {
        ok: false,
        result: latestResult,
      };
    }

    const latestArtifact = latestResult.data.artifact;
    const frameworkMetadata = getArtifactFrameworkMetadata(latestArtifact.metadata);
    const resolvedArtifactType =
      requestedArtifactType || frameworkMetadata?.artifactType || "";

    if (!resolvedArtifactType) {
      return {
        ok: false,
        result: makeSubagentToolError(
          `artifactType is required when versioning artifact "${artifactId}" because the existing artifact has no framework metadata.`,
        ),
      };
    }

    const spec = getSubagentArtifactSpec(subagentDef, resolvedArtifactType);
    if (!spec) {
      return {
        ok: false,
        result: makeSubagentToolError(
          `Unknown artifactType "${resolvedArtifactType}" for subagent "${subagentDef.id}".`,
          { artifactId, artifactType: resolvedArtifactType },
        ),
      };
    }

    if (latestArtifact.kind !== spec.kind) {
      return {
        ok: false,
        result: makeSubagentToolError(
          `artifactType "${resolvedArtifactType}" must version kind "${spec.kind}".`,
          {
            artifactId,
            artifactType: resolvedArtifactType,
            expectedKind: spec.kind,
            actualKind: latestArtifact.kind,
          },
        ),
      };
    }

    const nextContentFormat =
      typeof rawArgs.content === "string"
        ? typeof rawArgs.contentFormat === "string"
          ? rawArgs.contentFormat
          : latestArtifact.contentFormat
        : latestArtifact.contentFormat;
    if (nextContentFormat !== spec.contentFormat) {
      return {
        ok: false,
        result: makeSubagentToolError(
          `artifactType "${resolvedArtifactType}" must use contentFormat "${spec.contentFormat}".`,
          {
            artifactId,
            artifactType: resolvedArtifactType,
            expectedContentFormat: spec.contentFormat,
            actualContentFormat: nextContentFormat,
          },
        ),
      };
    }

    const contentForValidation =
      typeof rawArgs.content === "string" ? rawArgs.content : latestArtifact.content;
    if (
      spec.validator &&
      spec.contentFormat === "json" &&
      typeof contentForValidation !== "string"
    ) {
      return {
        ok: false,
        result: makeSubagentToolError(
          `Artifact "${artifactId}" content could not be loaded for validator "${spec.validator.id}".`,
          { artifactId, artifactType: resolvedArtifactType, validatorId: spec.validator.id },
        ),
      };
    }

    const validation =
      typeof contentForValidation === "string"
        ? validateSubagentArtifactContent(spec, contentForValidation)
        : undefined;
    if (validation?.status === "failed") {
      return {
        ok: false,
        result: makeSubagentToolError(
          `Artifact "${resolvedArtifactType}" failed validation.`,
          {
            artifactId,
            artifactType: resolvedArtifactType,
            validatorId: validation.validatorId,
            issues: validation.issues,
          },
        ),
      };
    }

    return {
      ok: true,
      data: {
        args: {
          ...rawArgs,
          artifactType: resolvedArtifactType,
          metadata: withArtifactFrameworkMetadata(
            rawArgs.metadata ?? latestArtifact.metadata,
            resolvedArtifactType,
            spec.validator?.id,
          ),
        },
        spec,
        validation,
      },
    };
  }

  function finalizeSubagentArtifacts():
    | { ok: true }
    | { ok: false; result: ToolFailureResult } {
    const declaredArtifacts = getSubagentArtifactSpecs(subagentDef);
    if (declaredArtifacts.length === 0) {
      return { ok: true };
    }

    const artifactIdsByType = new Map<string, Set<string>>();
    for (const artifact of collectedArtifacts) {
      const artifactType = getArtifactFrameworkMetadata(artifact.metadata)?.artifactType;
      if (!artifactType) continue;
      const bucket = artifactIdsByType.get(artifactType) ?? new Set<string>();
      bucket.add(artifact.artifactId);
      artifactIdsByType.set(artifactType, bucket);
    }

    const missingRequired: string[] = [];
    const cardinalityErrors: Array<{ artifactType: string; count: number }> = [];

    for (const spec of declaredArtifacts) {
      const producedIds = artifactIdsByType.get(spec.artifactType) ?? new Set<string>();
      const required = spec.required ?? true;
      const cardinality = spec.cardinality ?? "one";

      if (required && producedIds.size === 0) {
        missingRequired.push(spec.artifactType);
      }
      if (cardinality === "one" && producedIds.size > 1) {
        cardinalityErrors.push({
          artifactType: spec.artifactType,
          count: producedIds.size,
        });
      }
    }

    if (missingRequired.length === 0 && cardinalityErrors.length === 0) {
      return { ok: true };
    }

    return {
      ok: false,
      result: makeSubagentToolError(
        `Subagent "${subagentDef.id}" did not satisfy its artifact contract.`,
        {
          ...(missingRequired.length > 0 ? { missingRequired } : {}),
          ...(cardinalityErrors.length > 0 ? { cardinalityErrors } : {}),
        },
      ),
    };
  }

  for (let iteration = 0; iteration < MAX_SUBAGENT_ITERATIONS; iteration++) {
    if (signal.aborted) break;
    turns++;

    const activeTodo = getAgentState(tabId).todos.find((todo) => todo.state === "doing");
    const contextGateway = await executeThroughContextGateway({
      messages: localApiMessages,
      stateSnapshot: {
        tabId,
        runId,
        agentId: `agent_${subagentDef.id}`,
        modelId,
        currentTurn,
        messageCount: localApiMessages.length,
        ...(activeTodo ? { activeTodoId: activeTodo.id } : {}),
      },
    });

    const streamed = await streamTurn({
      tabId,
      signal,
      modelId,
      model: languageModel,
      messages: contextGateway.messages,
      tools: toolDefs,
      debugEnabled,
      logContext: subagentContext,
      agentName: subagentDef.name,
      toPendingToolCalls: (toolCalls) =>
        toolCalls.length > 0
          ? toolCalls.map((tc) =>
              buildPendingToolDisplay(
                tc.id,
                tc.function.name,
                tc.function.arguments,
              ),
            )
          : undefined,
      usageMetadata: {
        actorKind: "subagent",
        actorId: subagentDef.id,
        actorLabel: subagentDef.name,
        operation: "assistant turn",
      },
      onRecordUsage: (input) => recordLlmUsage(tabId, input),
    });

    finalText = streamed.text;
    localApiMessages.push(streamed.assistantApiMsg);

    if (streamed.parsedToolCalls.length === 0) break;

    const turnCardAccumulator = createConversationCardAccumulator(
      tabId,
      streamed.assistantChatId,
      streamed.parsedToolCalls,
    );

    const toolResults = await Promise.all(
      streamed.parsedToolCalls.map(async (tc) => {
        const tcId = tc.id;
        const toolLog = createToolLogContext(
          subagentContext,
          tcId,
          tc.function.name,
        );
        writeRunnerLog({
          id: toolLog.startId,
          level: "info",
          tags: ["frontend", "agent-loop", "tool-calls"],
          event: "runner.subagent.tool.start",
          message: `${subagentDef.name} queued ${tc.function.name}`,
          kind: "start",
          expandable: true,
          data: {
            toolName: tc.function.name,
            args: parseArgs(tc.function.arguments),
            subagentId: subagentDef.id,
          },
          context: {
            ...subagentContext,
            correlationId: tcId,
            depth: subagentContext.depth,
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
        const toolResult = await executeThroughToolGateway({
          tabId,
          runId,
          agentId: `agent_${subagentDef.id}`,
          toolCallId: tcId,
          toolName: tc.function.name,
          rawArgs,
          currentModelId: modelId,
          contextLength: getAgentState(tabId).config.contextLength,
          apiMessages: localApiMessages,
          providers,
          logContext: toolLog.context,
          updateToolCallById,
          recordLlmUsage: (input) => recordLlmUsage(tabId, input),
          advancedOptions: getAgentState(tabId).config.advancedOptions,
          syntheticExecutors: {
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
          localExecutor: async (args) => {
            const preparedArtifactCall = await prepareSubagentArtifactToolCall(
              tc.function.name,
              args,
            );
            if (!preparedArtifactCall.ok) {
              updateToolCallById({
                status: "error",
                result: preparedArtifactCall.result.error,
              });
              return { result: preparedArtifactCall.result };
            }

            const executed = await executeLocalTool({
              tabId,
              runId,
              agentId: `agent_${subagentDef.id}`,
              currentTurn,
              toolCallId: tcId,
              toolName: tc.function.name,
              preArgs: args,
              args: preparedArtifactCall.data.args,
              logContext: toolLog.context,
              updateToolCallById,
              logEventPrefix: "runner.subagent.tool",
              logMessageName: `${subagentDef.name} ${tc.function.name}`,
            });

            if (
              executed.result.ok &&
              preparedArtifactCall.data.spec &&
              (tc.function.name === "agent_artifact_create" ||
                tc.function.name === "agent_artifact_version")
            ) {
              const data = executed.result.data as Record<string, unknown>;
              if (data.artifact && typeof data.artifact === "object") {
                const artifact = data.artifact as ArtifactManifest;
                collectedArtifacts.push(artifact);
                if (preparedArtifactCall.data.validation) {
                  artifactValidations.push({
                    ...preparedArtifactCall.data.validation,
                    artifactId: artifact.artifactId,
                  });
                }
              }
            }

            return executed;
          },
        });

        return { tool_call_id: tcId, result: toolResult };
      }),
    );
    if (signal.aborted || !isCurrentRunId(tabId, runId)) {
      const abortError = new Error("Subagent run aborted");
      abortError.name = "AbortError";
      throw abortError;
    }
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
    localApiMessages.push(...toolApiMessages);

    const resolvedTurnCards = turnCardAccumulator.getResolvedCards();
    if (resolvedTurnCards.length > 0) {
      collectedCards.push(...resolvedTurnCards);
    }

    if (debugEnabled) {
      writeRunnerLog({
        level: "debug",
        tags: ["frontend", "agent-loop", "messages"],
        event: "runner.subagent.iteration",
        message: `${subagentDef.name} iteration ${iteration}`,
        data: { iteration, toolCallCount: streamed.parsedToolCalls.length },
        context: subagentContext,
      });
    }
  }

  const contractResult = finalizeSubagentArtifacts();
  if (!contractResult.ok) {
    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "messages"],
      event: "runner.subagent.error",
      message: `${subagentDef.name} failed artifact validation`,
      kind: "error",
      data: contractResult.result.error,
      context: subagentContext,
    });
    return {
      ok: false,
      error: contractResult.result.error,
    };
  }

  const note = subagentDef.output?.parentNote;
  writeRunnerLog({
    level: "info",
    tags: ["frontend", "agent-loop", "messages"],
    event: "runner.subagent.end",
    message: `${subagentDef.name} completed`,
    kind: "end",
    durationMs: Math.max(0, Date.now() - startedAtMs),
    data: {
      subagentId: subagentDef.id,
      turns,
      artifactCount: collectedArtifacts.length,
      cardCount: collectedCards.length,
    },
    context: subagentContext,
  });

  return {
    ok: true,
    data: {
      subagentId: subagentDef.id,
      name: subagentDef.name,
      modelId,
      startedAtMs,
      finishedAtMs: Date.now(),
      turns,
      rawText: finalText,
      cards: collectedCards.map(serializeConversationCardForParent),
      artifacts: collectedArtifacts,
      artifactValidations,
      ...(note !== undefined ? { note } : {}),
    },
  };
}
