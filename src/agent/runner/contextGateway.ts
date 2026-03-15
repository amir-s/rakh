import { generateObject } from "ai";
import { z } from "zod";
import { createChildLogContext } from "@/logging/client";
import type { LogContext } from "@/logging/types";

import {
  defaultContextGatewayConfigProvider,
  type ContextGatewayConfig,
  type ContextGatewayConfigProvider,
  type ContextGatewayOutput,
  type ContextGatewayStateSnapshot,
} from "../contextGateway";
import { estimateContextUsage } from "../contextUsage";
import { getModelCatalogEntry } from "../modelCatalog";
import { buildConversationCard } from "../tools/agentControl";
import { applyTodoContextEnrichment } from "../tools/todos";
import type {
  AdvancedModelOptions,
  AgentPlan,
  ApiMessage,
  ChatMessage,
  TodoItem,
  TodoNoteItem,
} from "../types";
import type { ProviderInstance } from "../db";

import { msgId } from "./chatState";
import { writeRunnerLog } from "./logging";
import { buildProviderOptions, resolveLanguageModel } from "./providerOptions";

const COMPACTED_CONTEXT_PREFIX =
  "COMPACTED SESSION CONTEXT\nThis is a compacted replacement for earlier API history.";

const contextGatewayTodoUpdateSchema = z.object({
  todoId: z.string().min(1),
  verifyThingsLearnedNoteIds: z.array(z.string().min(1)).max(64).default([]),
  verifyCriticalInfoNoteIds: z.array(z.string().min(1)).max(64).default([]),
  appendThingsLearned: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  appendCriticalInfo: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  removeDuplicateThingsLearnedNoteIds: z.array(z.string().min(1)).max(64).default([]),
  removeDuplicateCriticalInfoNoteIds: z.array(z.string().min(1)).max(64).default([]),
});

const contextGatewayCompactionSchema = z.object({
  summary: z.string().trim().min(1).max(6000),
  todoUpdates: z.array(contextGatewayTodoUpdateSchema).max(200).default([]),
});

type ContextGatewayCompactionResult = z.infer<typeof contextGatewayCompactionSchema>;

export interface ExecuteThroughContextGatewayOptions {
  messages: ApiMessage[];
  plan: AgentPlan;
  todos: TodoItem[];
  providers: ProviderInstance[];
  advancedOptions?: AdvancedModelOptions;
  debugEnabled?: boolean;
  logContext?: LogContext;
  stateSnapshot: ContextGatewayStateSnapshot;
  configProvider?: ContextGatewayConfigProvider;
}

function completeStateSnapshot(
  messages: ApiMessage[],
  snapshot: ContextGatewayStateSnapshot,
): ContextGatewayStateSnapshot {
  const usage = estimateContextUsage(messages);
  const contextUsagePct =
    snapshot.contextUsagePct ??
    (usage && snapshot.contextLength
      ? Math.min(100, (usage.estimatedTokens / snapshot.contextLength) * 100)
      : undefined);

  return {
    ...snapshot,
    ...(typeof contextUsagePct === "number" ? { contextUsagePct } : {}),
    ...(usage?.estimatedTokens ? { estimatedTokens: usage.estimatedTokens } : {}),
    ...(usage?.estimatedBytes ? { estimatedBytes: usage.estimatedBytes } : {}),
  };
}

function sanitizeApiMessagesForCompaction(messages: ApiMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: message.role,
        content: message.content,
        toolCalls: (message.tool_calls ?? []).map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })),
      };
    }

    if (message.role === "user") {
      return {
        role: message.role,
        content: message.content,
        ...(message.attachments && message.attachments.length > 0
          ? { attachmentCount: message.attachments.length }
          : {}),
      };
    }

    if (message.role === "tool") {
      return {
        role: message.role,
        toolCallId: message.tool_call_id,
        content: message.content,
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

function sanitizeTodosForCompaction(todos: TodoItem[]): unknown[] {
  return todos.map((todo) => ({
    id: todo.id,
    title: todo.title,
    state: todo.state,
    owner: todo.owner,
    createdTurn: todo.createdTurn,
    updatedTurn: todo.updatedTurn,
    lastTouchedTurn: todo.lastTouchedTurn,
    filesTouched: todo.filesTouched,
    completionNote: todo.completionNote,
    thingsLearned: todo.thingsLearned,
    criticalInfo: todo.criticalInfo,
  }));
}

function mergeCompactionTodoUpdates(
  updates: ContextGatewayCompactionResult["todoUpdates"],
): ContextGatewayCompactionResult["todoUpdates"] {
  const byTodoId = new Map<string, ContextGatewayCompactionResult["todoUpdates"][number]>();

  for (const update of updates) {
    const existing = byTodoId.get(update.todoId);
    if (!existing) {
      byTodoId.set(update.todoId, {
        ...update,
        verifyThingsLearnedNoteIds: [...update.verifyThingsLearnedNoteIds],
        verifyCriticalInfoNoteIds: [...update.verifyCriticalInfoNoteIds],
        appendThingsLearned: [...update.appendThingsLearned],
        appendCriticalInfo: [...update.appendCriticalInfo],
        removeDuplicateThingsLearnedNoteIds: [...update.removeDuplicateThingsLearnedNoteIds],
        removeDuplicateCriticalInfoNoteIds: [...update.removeDuplicateCriticalInfoNoteIds],
      });
      continue;
    }

    const mergeUnique = (left: string[], right: string[]) =>
      Array.from(new Set([...left, ...right]));

    existing.verifyThingsLearnedNoteIds = mergeUnique(
      existing.verifyThingsLearnedNoteIds,
      update.verifyThingsLearnedNoteIds,
    );
    existing.verifyCriticalInfoNoteIds = mergeUnique(
      existing.verifyCriticalInfoNoteIds,
      update.verifyCriticalInfoNoteIds,
    );
    existing.appendThingsLearned = mergeUnique(
      existing.appendThingsLearned,
      update.appendThingsLearned,
    );
    existing.appendCriticalInfo = mergeUnique(
      existing.appendCriticalInfo,
      update.appendCriticalInfo,
    );
    existing.removeDuplicateThingsLearnedNoteIds = mergeUnique(
      existing.removeDuplicateThingsLearnedNoteIds,
      update.removeDuplicateThingsLearnedNoteIds,
    );
    existing.removeDuplicateCriticalInfoNoteIds = mergeUnique(
      existing.removeDuplicateCriticalInfoNoteIds,
      update.removeDuplicateCriticalInfoNoteIds,
    );
  }

  return Array.from(byTodoId.values());
}

function formatNoteLine(note: TodoNoteItem): string {
  const flags = [
    note.verified ? "verified" : "unverified",
    note.source,
    note.author,
  ].join(", ");
  return `- ${note.text} [${flags}]`;
}

function buildTodoDigest(todos: TodoItem[]): string {
  if (todos.length === 0) return "None.";

  return todos
    .map((todo) => {
      const lines = [
        `- [${todo.state}] ${todo.title} (id: ${todo.id}, owner: ${todo.owner})`,
      ];

      if (todo.completionNote) {
        lines.push(`  completionNote: ${todo.completionNote}`);
      }
      if (todo.filesTouched.length > 0) {
        lines.push(`  filesTouched: ${todo.filesTouched.join(", ")}`);
      }
      if (todo.thingsLearned.length > 0) {
        lines.push("  thingsLearned:");
        for (const note of todo.thingsLearned) {
          lines.push(`    ${formatNoteLine(note)}`);
        }
      }
      if (todo.criticalInfo.length > 0) {
        lines.push("  criticalInfo:");
        for (const note of todo.criticalInfo) {
          lines.push(`    ${formatNoteLine(note)}`);
        }
      }

      return lines.join("\n");
    })
    .join("\n");
}

function buildCompactedContextMessage(
  summary: string,
  plan: AgentPlan,
  todos: TodoItem[],
): ApiMessage {
  const content = [
    COMPACTED_CONTEXT_PREFIX,
    "",
    "CURRENT PLAN",
    plan.markdown.trim() || "No plan recorded.",
    "",
    "NORMALIZED TODOS",
    buildTodoDigest(todos),
    "",
    "CONTINUATION SUMMARY",
    summary.trim(),
  ].join("\n");

  return {
    role: "system",
    content,
  };
}

function buildReplacementApiMessages(
  originalMessages: ApiMessage[],
  compactedContextMessage: ApiMessage,
): ApiMessage[] {
  const leadingSystem =
    originalMessages[0]?.role === "system" ? originalMessages[0] : null;
  const trailingUser =
    originalMessages[originalMessages.length - 1]?.role === "user"
      ? originalMessages[originalMessages.length - 1]
      : null;

  return [
    ...(leadingSystem ? [leadingSystem] : []),
    compactedContextMessage,
    ...(trailingUser ? [trailingUser] : []),
  ];
}

function buildCompactionDebugSnapshot(
  stateSnapshot: ContextGatewayStateSnapshot,
  plan: AgentPlan,
  todos: TodoItem[],
  apiMessages: ApiMessage[],
): Record<string, unknown> {
  return {
    stateSnapshot: {
      tabId: stateSnapshot.tabId,
      runId: stateSnapshot.runId,
      agentId: stateSnapshot.agentId,
      modelId: stateSnapshot.modelId,
      currentTurn: stateSnapshot.currentTurn,
      messageCount: stateSnapshot.messageCount,
      ...(stateSnapshot.activeTodoId
        ? { activeTodoId: stateSnapshot.activeTodoId }
        : {}),
      ...(typeof stateSnapshot.contextLength === "number"
        ? { contextLength: stateSnapshot.contextLength }
        : {}),
      ...(typeof stateSnapshot.contextUsagePct === "number"
        ? { contextUsagePct: stateSnapshot.contextUsagePct }
        : {}),
      ...(typeof stateSnapshot.estimatedTokens === "number"
        ? { estimatedTokens: stateSnapshot.estimatedTokens }
        : {}),
      ...(typeof stateSnapshot.estimatedBytes === "number"
        ? { estimatedBytes: stateSnapshot.estimatedBytes }
        : {}),
    },
    plan,
    todos: sanitizeTodosForCompaction(todos),
    apiMessages: sanitizeApiMessagesForCompaction(apiMessages),
  };
}

function buildCompactionDebugCardMarkdown(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  return [
    "ContextGateway compacted the main-agent API context for this turn.",
    "",
    "### Before",
    "```json",
    JSON.stringify(before, null, 2),
    "```",
    "",
    "### After",
    "```json",
    JSON.stringify(after, null, 2),
    "```",
  ].join("\n");
}

function buildCompactionDebugChatMessage(
  options: ExecuteThroughContextGatewayOptions,
  childContext: LogContext | undefined,
  stateSnapshot: ContextGatewayStateSnapshot,
  updatedTodos: TodoItem[],
  replacementApiMessages: ApiMessage[],
): ChatMessage | undefined {
  if (!options.debugEnabled) return undefined;

  const before = buildCompactionDebugSnapshot(
    stateSnapshot,
    options.plan,
    options.todos,
    options.messages,
  );
  const after = buildCompactionDebugSnapshot(
    stateSnapshot,
    options.plan,
    updatedTodos,
    replacementApiMessages,
  );
  const builtCard = buildConversationCard({
    kind: "summary",
    title: "ContextGateway Compaction",
    markdown: buildCompactionDebugCardMarkdown(before, after),
  });
  if (!builtCard.ok) return undefined;

  const messageId = msgId();
  return {
    id: messageId,
    role: "assistant",
    content: "ContextGateway compacted the API context. Debug snapshot below.",
    timestamp: Date.now(),
    badge: "DEBUG",
    cards: [builtCard.data.card],
    bubbleGroupId: `context-gateway:${messageId}`,
    ...(childContext?.traceId ? { traceId: childContext.traceId } : {}),
  };
}

async function compactWithTodoNormalizationPolicy(
  config: ContextGatewayConfig["todoNormalization"],
  options: ExecuteThroughContextGatewayOptions,
  stateSnapshot: ContextGatewayStateSnapshot,
): Promise<ContextGatewayOutput | null> {
  const summaryModelId =
    config.modelStrategy === "override" && config.overrideModelId
      ? config.overrideModelId
      : stateSnapshot.modelId;
  const summaryModelEntry = getModelCatalogEntry(summaryModelId);
  if (!summaryModelEntry) {
    writeRunnerLog({
      level: "warn",
      tags: ["frontend", "agent-loop", "context-gateway", "system"],
      event: "runner.contextgateway.compaction.skip",
      message: "Skipping context compaction because the configured model is unavailable",
      data: {
        modelId: summaryModelId,
        reason: "unknown-model",
      },
      context: options.logContext,
    });
    return null;
  }

  const providerOptions =
    buildProviderOptions(
      summaryModelEntry.owned_by ?? null,
      options.advancedOptions,
      summaryModelEntry.sdk_id?.trim(),
    );

  const childContext = createChildLogContext(options.logContext, {
    parentId: options.logContext?.parentId,
  });
  const startedAt = Date.now();
  writeRunnerLog({
    level: "info",
    tags: ["frontend", "agent-loop", "context-gateway", "system"],
    event: "runner.contextgateway.compaction.start",
    message: "Compacting API context and enriching todos",
    kind: "start",
    data: {
      modelId: summaryModelId,
      contextUsagePct: stateSnapshot.contextUsagePct,
      estimatedTokens: stateSnapshot.estimatedTokens,
    },
    context: childContext,
  });

  try {
    const model = resolveLanguageModel(summaryModelId, options.providers);
    const prompt = [
      "Normalize todo metadata and compact the prior API context.",
      "You must treat todo normalization as enrich-only.",
      "You may only append notes, verify existing notes, or remove duplicate notes.",
      "You must never change todo ids, titles, states, owners, completion notes, files touched, or note text.",
      "Duplicate removal is only allowed for exact duplicates or near-exact duplicates where the normalized text matches after trim, whitespace collapse, lowercasing, and stripping trailing ., !, or ?.",
      "Keep the earliest existing note and remove only later duplicates.",
      "",
      `Current turn: ${stateSnapshot.currentTurn}`,
      `Active todo id: ${stateSnapshot.activeTodoId ?? "none"}`,
      "",
      "PLAN",
      options.plan.markdown.trim() || "No plan recorded.",
      "",
      "TODOS",
      JSON.stringify(sanitizeTodosForCompaction(options.todos), null, 2),
      "",
      "API MESSAGES",
      JSON.stringify(sanitizeApiMessagesForCompaction(options.messages), null, 2),
    ].join("\n");

    const generated = await generateObject({
      model,
      schema: contextGatewayCompactionSchema,
      system:
        "You compress earlier API history for another coding agent. " +
        "Return structured output only. " +
        "Your summary must preserve the critical continuation context needed to keep working correctly.",
      prompt,
      ...(providerOptions ? { providerOptions } : {}),
    });

    const normalizedResult = {
      summary: generated.object.summary.trim(),
      todoUpdates: mergeCompactionTodoUpdates(generated.object.todoUpdates),
    };

    const updatedTodos =
      normalizedResult.todoUpdates.length === 0
        ? options.todos
        : await (async () => {
            const enrichedTodosResult = await applyTodoContextEnrichment(
              stateSnapshot.tabId,
              {
                turn: stateSnapshot.currentTurn,
                updates: normalizedResult.todoUpdates,
              },
            );
            if (!enrichedTodosResult.ok) {
              writeRunnerLog({
                level: "warn",
                tags: ["frontend", "agent-loop", "context-gateway", "system"],
                event: "runner.contextgateway.compaction.error",
                message:
                  "Skipping context compaction because todo enrichment failed",
                kind: "error",
                durationMs: Math.max(0, Date.now() - startedAt),
                data: enrichedTodosResult.error,
                context: childContext,
              });
              return null;
            }
            return enrichedTodosResult.data.items;
          })();
    if (updatedTodos === null) {
      return null;
    }
    const compactedContextMessage = buildCompactedContextMessage(
      normalizedResult.summary,
      options.plan,
      updatedTodos,
    );
    const replacementApiMessages = buildReplacementApiMessages(
      options.messages,
      compactedContextMessage,
    );
    const debugChatMessage = buildCompactionDebugChatMessage(
      options,
      childContext,
      stateSnapshot,
      updatedTodos,
      replacementApiMessages,
    );

    writeRunnerLog({
      level: "info",
      tags: ["frontend", "agent-loop", "context-gateway", "system"],
      event: "runner.contextgateway.compaction.end",
      message: "Context compaction completed",
      kind: "end",
      durationMs: Math.max(0, Date.now() - startedAt),
      data: {
        replacementApiMessageCount: replacementApiMessages.length,
        todoCount: updatedTodos.length,
      },
      context: childContext,
    });

    return {
      messages: replacementApiMessages,
      ...(config.replaceApiMessagesAfterCompaction
        ? { replacementApiMessages }
        : {}),
      ...(debugChatMessage ? { debugChatMessage } : {}),
    };
  } catch (error) {
    writeRunnerLog({
      level: "warn",
      tags: ["frontend", "agent-loop", "context-gateway", "system"],
      event: "runner.contextgateway.compaction.error",
      message: "Skipping context compaction because the compaction model failed",
      kind: "error",
      durationMs: Math.max(0, Date.now() - startedAt),
      data: error,
      context: childContext,
    });
    return null;
  }
}

export async function executeThroughContextGateway(
  options: ExecuteThroughContextGatewayOptions,
): Promise<ContextGatewayOutput> {
  const configProvider =
    options.configProvider ?? defaultContextGatewayConfigProvider;
  const stateSnapshot = completeStateSnapshot(
    options.messages,
    options.stateSnapshot,
  );
  const config = configProvider.getConfig(stateSnapshot);
  if (!config.enabled) {
    return { messages: options.messages };
  }

  const policy = config.todoNormalization;
  if (!policy.enabled || stateSnapshot.agentId !== "agent_main") {
    return { messages: options.messages };
  }

  const contextUsagePct =
    typeof stateSnapshot.contextUsagePct === "number"
      ? stateSnapshot.contextUsagePct
      : null;
  if (
    contextUsagePct === null ||
    contextUsagePct < policy.triggerMinContextUsagePct
  ) {
    return { messages: options.messages };
  }

  const compacted = await compactWithTodoNormalizationPolicy(
    policy,
    options,
    stateSnapshot,
  );
  return compacted ?? { messages: options.messages };
}
