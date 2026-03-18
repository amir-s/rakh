/**
 * Agent runner — the core agentic loop facade.
 *
 * Public API lives here. Internal helpers and loops live under ./runner/*.
 */

import {
  getAgentState,
  patchAgentState,
  jotaiStore,
} from "./atoms";
import { providersAtom } from "./db";
import { getModelCatalogEntry } from "./modelCatalog";
import { execAbort, execStop } from "./tools/exec";
import { findSubagentByTrigger, type SubagentDefinition } from "./subagents";
import { cancelAllApprovals } from "./approvals";
import type {
  AttachedImage,
  AgentQueueState,
  ChatMessage,
  ConversationCard,
  QueuedUserMessage,
  ToolApiMessage,
  ToolCallDisplay,
} from "./types";

import {
  type ActiveRun,
  type AgentAbortReason,
  clearActiveRun,
  getActiveRun,
  hasActiveRun,
  nextRunId,
  setActiveRun,
} from "./runner/abortRegistry";
import { agentLoop } from "./runner/agentLoop";
import { msgId, updateLastChatMessage } from "./runner/chatState";
import {
  createMainRunLogContext,
  writeRunnerLog,
} from "./runner/logging";
import { buildProviderOptions } from "./runner/providerOptions";
import { runSubagentLoop } from "./runner/subagentLoop";
import { RunAbortedError, serializeError } from "./runner/utils";
import {
  buildMainSystemPromptForState,
  COMPACT_TRIGGER_SUBAGENT_ID,
  executeMainContextCompaction,
  maybeRunAutomaticMainContextCompaction,
} from "./runner/mainContextCompaction";

export { buildProviderOptions } from "./runner/providerOptions";
export { serializeError } from "./runner/utils";

function activeRunLogContext(tabId: string): {
  sessionId: string;
  tabId: string;
  traceId?: string;
  depth: number;
  agentId: "agent_main";
} {
  const state = getAgentState(tabId);
  return {
    sessionId: tabId,
    tabId,
    ...(state.lastRunTraceId ? { traceId: state.lastRunTraceId } : {}),
    depth: 0,
    agentId: "agent_main",
  };
}

function abortReasonMessage(reason: AgentAbortReason): string {
  switch (reason) {
    case "user_stop":
      return "Main run aborted by the user";
    case "steer":
      return "Main run aborted for steering";
    case "superseded":
      return "Main run was superseded by a newer message";
  }
}

function normalizeQueueState(
  queuedMessages: QueuedUserMessage[],
  queueState: AgentQueueState,
): AgentQueueState {
  if (queuedMessages.length === 0) return "idle";
  return queueState === "paused" ? "paused" : "draining";
}

function pauseQueueState(
  queuedMessages: QueuedUserMessage[],
  queueState: AgentQueueState,
): AgentQueueState {
  if (queuedMessages.length === 0) return "idle";
  return queueState === "draining" || queueState === "paused"
    ? "paused"
    : "paused";
}

function setAgentErrorState(
  tabId: string,
  error: string,
  errorDetails?: unknown,
  errorAction: { type: "open-settings-section"; section: "providers"; label: string } | null = null,
): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    status: "error",
    error,
    errorAction,
    errorDetails: errorDetails ?? null,
    streamingContent: null,
    queueState: pauseQueueState(prev.queuedMessages, prev.queueState),
  }));
}

function appendAssistantChatMessage(
  tabId: string,
  content: string,
  options?: {
    agentName?: string;
    cards?: ConversationCard[];
  },
): void {
  const trimmed = content.trim();
  patchAgentState(tabId, (prev) => ({
    ...prev,
    chatMessages: [
      ...prev.chatMessages,
      {
        id: msgId(),
        role: "assistant",
        content: trimmed,
        timestamp: Date.now(),
        ...(options?.agentName ? { agentName: options.agentName } : {}),
        ...(options?.cards && options.cards.length > 0
          ? { cards: options.cards }
          : {}),
      },
    ],
  }));
}

async function runManualCompactionTrigger(
  tabId: string,
  userMessage: string,
  triggerSubagent: SubagentDefinition,
  controller: AbortController,
  runId: string,
  currentTurn: number,
  runLogContext: ReturnType<typeof createMainRunLogContext>["childContext"],
): Promise<{ ok: true } | { ok: false; error?: unknown }> {
  const compactArgs = userMessage
    .trim()
    .slice(triggerSubagent.triggerCommand?.length ?? 0)
    .trim();
  if (compactArgs.length > 0) {
    appendAssistantChatMessage(
      tabId,
      "`/compact` does not accept arguments. Run `/compact` by itself.",
      { agentName: triggerSubagent.name },
    );
    return { ok: true };
  }

  const result = await executeMainContextCompaction({
    tabId,
    signal: controller.signal,
    runId,
    currentTurn,
    logContext: runLogContext,
    mode: "manual",
  });
  if (!result.ok) {
    appendAssistantChatMessage(tabId, result.message, {
      agentName: triggerSubagent.name,
    });
    return { ok: false, ...(result.error !== undefined ? { error: result.error } : {}) };
  }
  return { ok: true };
}

function findRunningExecToolCallIds(tabId: string): string[] {
  const state = getAgentState(tabId);
  const ids: string[] = [];
  for (const msg of state.chatMessages) {
    for (const tc of msg.toolCalls ?? []) {
      const gitSetupRunning =
        tc.tool === "git_worktree_init" &&
        tc.status === "running" &&
        tc.args.setupPhase === "running_setup";
      if ((tc.tool === "exec_run" && tc.status === "running") || gitSetupRunning) {
        ids.push(tc.id);
      }
    }
  }
  return ids;
}

function hasRunningExecToolCall(tabId: string, toolCallId: string): boolean {
  const state = getAgentState(tabId);
  for (const msg of state.chatMessages) {
    for (const tc of msg.toolCalls ?? []) {
      if (
        tc.id === toolCallId &&
        tc.status === "running" &&
        (tc.tool === "exec_run" ||
          (tc.tool === "git_worktree_init" &&
            tc.args.setupPhase === "running_setup"))
      ) {
        return true;
      }
    }
  }
  return false;
}

interface IncompleteToolCall {
  toolCallId: string;
  toolName: string;
}

function findIncompleteToolCalls(tabId: string): IncompleteToolCall[] {
  const state = getAgentState(tabId);
  const incomplete: IncompleteToolCall[] = [];

  const completedToolCallIds = new Set<string>();
  for (const msg of state.apiMessages) {
    if (msg.role === "tool") {
      completedToolCallIds.add(msg.tool_call_id);
    }
  }

  for (const msg of state.apiMessages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!completedToolCallIds.has(tc.id)) {
          incomplete.push({
            toolCallId: tc.id,
            toolName: tc.function.name,
          });
        }
      }
    }
  }

  return incomplete;
}

function interruptActiveRun(
  tabId: string,
  reason: AgentAbortReason,
  options: { pauseQueue: boolean },
): void {
  const stoppedAtMs = Date.now();
  const state = getAgentState(tabId);
  const runningExecIds = findRunningExecToolCallIds(tabId);
  for (const toolCallId of runningExecIds) {
    void execAbort(toolCallId);
  }
  const activeRun = getActiveRun(tabId);
  if (activeRun) {
    activeRun.abortReason = reason;
    activeRun.controller.abort();
  }

  const incompleteToolCalls = findIncompleteToolCalls(tabId);
  const synthesizedToolMessages: ToolApiMessage[] = incompleteToolCalls.map(
    ({ toolCallId, toolName }) => ({
      role: "tool" as const,
      tool_call_id: toolCallId,
      content: JSON.stringify({
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Agent was stopped before tool call "${toolName}" completed.`,
        },
      }),
    }),
  );

  if (
    activeRun ||
    state.status === "thinking" ||
    state.status === "working" ||
    state.streamingContent !== null ||
    runningExecIds.length > 0 ||
    incompleteToolCalls.length > 0
  ) {
    writeRunnerLog({
      level: "warn",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.run.aborted",
      message: abortReasonMessage(reason),
      kind: "error",
      data: {
        reason,
        pauseQueue: options.pauseQueue,
        runningExecToolCallIds: runningExecIds,
        incompleteToolCallCount: incompleteToolCalls.length,
      },
      context: activeRunLogContext(tabId),
    });
  }

  const isIncompleteStatus = (status: ToolCallDisplay["status"]): boolean =>
    status === "pending" ||
    status === "awaiting_approval" ||
    status === "awaiting_worktree" ||
    status === "awaiting_branch_release" ||
    status === "awaiting_setup_action" ||
    status === "running";

  patchAgentState(tabId, (prev) => ({
    ...prev,
    status: "idle",
    streamingContent: null,
    queueState: options.pauseQueue
      ? pauseQueueState(prev.queuedMessages, prev.queueState)
      : normalizeQueueState(prev.queuedMessages, prev.queueState),
    apiMessages:
      synthesizedToolMessages.length > 0
        ? [...prev.apiMessages, ...synthesizedToolMessages]
        : prev.apiMessages,
    chatMessages: prev.chatMessages.map((msg) => {
      const shouldFinalizeReasoningDuration =
        typeof msg.reasoningStartedAtMs === "number" &&
        typeof msg.reasoningDurationMs !== "number";
      const finalizedReasoningDurationMs = shouldFinalizeReasoningDuration
        ? Math.max(0, stoppedAtMs - (msg.reasoningStartedAtMs ?? 0))
        : msg.reasoningDurationMs;

      const nextMsg =
        msg.streaming ||
        msg.reasoningStreaming ||
        shouldFinalizeReasoningDuration
          ? {
              ...msg,
              streaming: false,
              reasoningStreaming: undefined,
              reasoningDurationMs: finalizedReasoningDurationMs,
            }
          : msg;

      if (!nextMsg.toolCalls) return nextMsg;
      return {
        ...nextMsg,
        toolCalls: nextMsg.toolCalls.map((tc) =>
          isIncompleteStatus(tc.status)
            ? {
                ...tc,
                status: "error" as const,
                result: {
                  code: "INTERNAL",
                  message:
                    tc.tool === "exec_run" && tc.status === "running"
                      ? "User aborted the execution of this command. No stdout/stderr will be returned."
                      : "Agent was stopped before this tool call completed.",
                },
              }
            : tc,
        ),
      };
    }),
  }));
  cancelAllApprovals(tabId);
}

async function maybeStartQueuedRun(tabId: string): Promise<void> {
  const state = getAgentState(tabId);
  if (state.queueState !== "draining") return;
  if (hasActiveRun(tabId)) return;

  const nextQueuedMessage = state.queuedMessages[0];
  if (!nextQueuedMessage) {
    patchAgentState(tabId, (prev) =>
      prev.queueState === "draining" ? { ...prev, queueState: "idle" } : prev,
    );
    return;
  }

  await runAgentTurn(tabId, nextQueuedMessage.content, undefined, {
    queuedMessageId: nextQueuedMessage.id,
  });
}

export function queueMessage(tabId: string, userMessage: string): void {
  const content = userMessage.trim();
  if (!content) return;

  patchAgentState(tabId, (prev) => ({
    ...prev,
    queuedMessages: [
      ...prev.queuedMessages,
      {
        id: msgId(),
        content,
        createdAtMs: Date.now(),
      },
    ],
    queueState: prev.queueState === "paused" ? "paused" : "draining",
  }));

  void maybeStartQueuedRun(tabId).catch((error) => {
    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.queue.start.error",
      message: "Queue start failed",
      kind: "error",
      data: error,
      context: { sessionId: tabId, tabId, depth: 0 },
    });
  });
}

export async function steerMessage(
  tabId: string,
  userMessage: string,
  queuedMessageId?: string,
): Promise<void> {
  const content = userMessage.trim();
  if (!content) return;

  if (hasActiveRun(tabId)) {
    interruptActiveRun(tabId, "steer", { pauseQueue: false });
  }

  await runAgentTurn(tabId, content, undefined, { queuedMessageId });
}

export function resumeQueue(tabId: string): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    queueState: prev.queuedMessages.length > 0 ? "draining" : "idle",
  }));
  void maybeStartQueuedRun(tabId).catch((error) => {
    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.queue.resume.error",
      message: "Queue resume failed",
      kind: "error",
      data: error,
      context: { sessionId: tabId, tabId, depth: 0 },
    });
  });
}

export function removeQueuedMessage(tabId: string, messageId: string): void {
  patchAgentState(tabId, (prev) => {
    const queuedMessages = prev.queuedMessages.filter(
      (message) => message.id !== messageId,
    );
    return {
      ...prev,
      queuedMessages,
      queueState:
        queuedMessages.length === 0 ? "idle" : prev.queueState,
    };
  });
}

export function clearQueuedMessages(tabId: string): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    queuedMessages: [],
    queueState: "idle",
  }));
}

export function stopAgent(tabId: string): void {
  interruptActiveRun(tabId, "user_stop", { pauseQueue: true });
}

export async function stopRunningExecToolCall(
  tabId: string,
  toolCallId: string,
): Promise<boolean> {
  if (!hasRunningExecToolCall(tabId, toolCallId)) return false;
  return execStop(toolCallId);
}

export async function retryAgent(tabId: string): Promise<void> {
  const state = getAgentState(tabId);

  let lastUserMessage: string | null = null;
  let lastUserIndex = -1;
  for (let i = state.apiMessages.length - 1; i >= 0; i--) {
    const msg = state.apiMessages[i];
    if (msg.role === "user" && typeof msg.content === "string") {
      lastUserMessage = msg.content;
      lastUserIndex = i;
      break;
    }
  }

  if (!lastUserMessage) return;

  const strippedApiMessages = state.apiMessages.slice(0, lastUserIndex);

  let lastUserChatIndex = -1;
  for (let i = state.chatMessages.length - 1; i >= 0; i--) {
    if (state.chatMessages[i].role === "user") {
      lastUserChatIndex = i;
      break;
    }
  }
  const strippedChatMessages =
    lastUserChatIndex >= 0
      ? state.chatMessages.slice(0, lastUserChatIndex + 1)
      : state.chatMessages;

  patchAgentState(tabId, {
    apiMessages: strippedApiMessages,
    chatMessages: strippedChatMessages,
    error: null,
    errorDetails: null,
    errorAction: null,
  });

  await runAgent(tabId, lastUserMessage, undefined, { skipUserChatAppend: true });
}

interface RunAgentTurnOptions {
  queuedMessageId?: string;
  skipUserChatAppend?: boolean;
}

function dequeueQueuedMessage(
  tabId: string,
  queuedMessageId: string | undefined,
): void {
  if (!queuedMessageId) return;

  patchAgentState(tabId, (prev) => {
    const queuedMessages = prev.queuedMessages.filter(
      (message) => message.id !== queuedMessageId,
    );
    return queuedMessages.length === prev.queuedMessages.length
      ? prev
      : {
          ...prev,
          queuedMessages,
        };
  });
}

export async function runAgent(
  tabId: string,
  userMessage: string,
  attachments?: AttachedImage[],
  options?: { skipUserChatAppend?: boolean },
): Promise<void> {
  if (hasActiveRun(tabId)) {
    interruptActiveRun(tabId, "superseded", { pauseQueue: false });
  }

  await runAgentTurn(tabId, userMessage, attachments, options);
}

async function runAgentTurn(
  tabId: string,
  userMessage: string,
  attachments?: AttachedImage[],
  options: RunAgentTurnOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const runId = nextRunId(tabId);
  const currentTurn = getAgentState(tabId).turnCount + 1;
  const {
    runStartId,
    rootContext: runRootLogContext,
    childContext: runLogContext,
  } = createMainRunLogContext(tabId, runId);
  patchAgentState(tabId, {
    lastRunTraceId: runRootLogContext.traceId,
    turnCount: currentTurn,
  });
  const activeRun: ActiveRun = {
    runId,
    controller,
    abortReason: null,
  };
  setActiveRun(tabId, activeRun);
  writeRunnerLog({
    id: runStartId,
    level: "info",
    tags: ["frontend", "agent-loop", "messages"],
    event: "runner.run.start",
    message: "Main run started",
    kind: "start",
    expandable: true,
    data: {
      userMessageLength: userMessage.length,
      hasAttachments: Boolean(attachments && attachments.length > 0),
    },
    context: runRootLogContext,
  });

  const failPreflight = (
    message: string,
    data?: Record<string, unknown>,
    errorDetails?: unknown,
    errorAction: { type: "open-settings-section"; section: "providers"; label: string } | null = null,
  ): void => {
    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.run.preflight.error",
      message,
      kind: "error",
      ...(data ? { data } : {}),
      context: runLogContext,
    });
    setAgentErrorState(tabId, message, errorDetails, errorAction);
    clearActiveRun(tabId, activeRun);
  };

  let completedCleanly = false;

  const triggerMatch = findSubagentByTrigger(userMessage);
  if (triggerMatch) {
    const { subagent: triggerSubagent, subMessage } = triggerMatch;
    const isCompactTrigger = triggerSubagent.id === COMPACT_TRIGGER_SUBAGENT_ID;

    const triggerUserMsg: ChatMessage | null = isCompactTrigger
      ? null
      : {
          id: msgId(),
          role: "user",
          content: userMessage,
          timestamp: Date.now(),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        };
    dequeueQueuedMessage(tabId, options.queuedMessageId);
    patchAgentState(tabId, (prev) => ({
      ...prev,
      status: "working",
      error: null,
      errorAction: null,
      errorDetails: null,
      chatMessages:
        options?.skipUserChatAppend || triggerUserMsg === null
          ? prev.chatMessages
          : [...prev.chatMessages, triggerUserMsg],
      streamingContent: null,
    }));

    try {
      if (isCompactTrigger) {
        const compactResult = await runManualCompactionTrigger(
          tabId,
          userMessage,
          triggerSubagent,
          controller,
          runId,
          currentTurn,
          runLogContext,
        );
        if (!compactResult.ok) {
          writeRunnerLog({
            level: "error",
            tags: ["frontend", "agent-loop", "messages"],
            event: "runner.run.error",
            message: "Manual compaction run failed",
            kind: "error",
            ...(compactResult.error !== undefined ? { data: compactResult.error } : {}),
            context: runLogContext,
          });
        }
        completedCleanly = true;
      } else {
        const triggerState = getAgentState(tabId);
        const triggerProviders = jotaiStore.get(providersAtom);
        const triggerDebug = triggerState.showDebug ?? false;
        const triggerResult = await runSubagentLoop({
          tabId,
          signal: controller.signal,
          runId,
          currentTurn,
          subagentDef: triggerSubagent,
          message: subMessage,
          parentModelId: triggerState.config.model,
          providers: triggerProviders,
          debugEnabled: triggerDebug,
          logContext: runLogContext,
        });
        if (!triggerResult.ok) {
          writeRunnerLog({
            level: "error",
            tags: ["frontend", "agent-loop", "messages"],
            event: "runner.run.error",
            message: "Trigger subagent run failed",
            kind: "error",
            data: triggerResult.error,
            context: runLogContext,
          });
          setAgentErrorState(
            tabId,
            triggerResult.error.message,
            triggerResult.error,
          );
        } else {
          completedCleanly = true;
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (err instanceof RunAbortedError) {
        completedCleanly = true;
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      writeRunnerLog({
        level: "error",
        tags: ["frontend", "agent-loop", "messages"],
        event: "runner.run.error",
        message: isCompactTrigger
          ? "Manual compaction threw"
          : "Trigger subagent threw",
        kind: "error",
        data: err,
        context: runLogContext,
      });
      if (isCompactTrigger) {
        appendAssistantChatMessage(tabId, msg, {
          agentName: triggerSubagent.name,
        });
        completedCleanly = true;
      } else {
        setAgentErrorState(tabId, msg, serializeError(err));
        updateLastChatMessage(tabId, (m) =>
          m.role === "assistant" ? { ...m, streaming: false } : m,
        );
        return;
      }
    } finally {
      clearActiveRun(tabId, activeRun);
      if (activeRun.abortReason !== null) return;
      if (completedCleanly) {
        writeRunnerLog({
          level: "info",
          tags: ["frontend", "agent-loop", "messages"],
          event: "runner.run.end",
          message: "Main run completed",
          kind: "end",
          context: runLogContext,
        });
        patchAgentState(tabId, (prev) => ({
          ...prev,
          status: "idle",
          streamingContent: null,
          queueState: normalizeQueueState(prev.queuedMessages, prev.queueState),
        }));
        void maybeStartQueuedRun(tabId).catch((error) => {
          writeRunnerLog({
            level: "error",
            tags: ["frontend", "agent-loop", "system"],
            event: "runner.queue.drain.error",
            message: "Queue drain failed",
            kind: "error",
            data: error,
            context: runLogContext,
          });
        });
      }
    }
    return;
  }

  const state = getAgentState(tabId);
  const { cwd, model } = state.config;
  const debugEnabled = state.showDebug ?? false;
  const modelEntry = getModelCatalogEntry(model);
  const provider = modelEntry?.owned_by ?? null;
  const providers = jotaiStore.get(providersAtom);

  writeRunnerLog({
    level: "info",
    tags: ["frontend", "agent-loop", "system"],
    event: "runner.model.resolve",
    message: `Preparing main run with model ${model}`,
    data: { model, provider, cwd },
    context: runLogContext,
  });

  if (!modelEntry || !provider) {
    failPreflight("Unknown model. Please choose a model from the New Session list.", {
      model,
      provider,
    });
    return;
  }

  if (!modelEntry.sdk_id.trim()) {
    failPreflight(
      `Selected model is missing a provider model ID. Please update src/agent/models.catalog.json for ${modelEntry.id}.`,
      {
        modelId: modelEntry.id,
        provider,
      },
    );
    return;
  }

  const providerInstance = providers.find(
    (p) => p.id === modelEntry.providerId,
  );
  if (!providerInstance) {
    failPreflight(`Model "${modelEntry.id}" references an unknown provider.`, {
      modelId: modelEntry.id,
      providerId: modelEntry.providerId,
      provider,
    });
    return;
  }

  if (provider === "openai" && !providerInstance.apiKey) {
    failPreflight(
      "No OpenAI API key. Please open the settings to enter your OpenAI API key.",
      {
        providerId: providerInstance.id,
        providerName: providerInstance.name,
        providerType: provider,
      },
      null,
      {
        type: "open-settings-section",
        section: "providers",
        label: "Open AI Providers",
      },
    );
    return;
  }

  if (provider === "anthropic" && !providerInstance.apiKey) {
    failPreflight(
      "No Claude API key. Please open the settings to enter your Claude (Anthropic) API key.",
      {
        providerId: providerInstance.id,
        providerName: providerInstance.name,
        providerType: provider,
      },
      null,
      {
        type: "open-settings-section",
        section: "providers",
        label: "Open AI Providers",
      },
    );
    return;
  }

  const preflightAutoCompaction = await maybeRunAutomaticMainContextCompaction({
    tabId,
    signal: controller.signal,
    runId,
    currentTurn,
    logContext: runLogContext,
  });
  if (preflightAutoCompaction.status === "compacted") {
    writeRunnerLog({
      level: "info",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.context-compaction.auto.triggered",
      message: "Automatic context compaction ran before the main turn started",
      data: {
        source: "preflight",
        trigger: preflightAutoCompaction.trigger,
      },
      context: runLogContext,
    });
  } else if (preflightAutoCompaction.status === "failed") {
    writeRunnerLog({
      level: "warn",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.context-compaction.auto.failed",
      message: "Automatic context compaction failed before the main turn started",
      data: {
        source: "preflight",
        trigger: preflightAutoCompaction.trigger,
        error: preflightAutoCompaction.error ?? preflightAutoCompaction.message,
      },
      context: runLogContext,
    });
  }

  const stateAfterPreflight = getAgentState(tabId);
  const userChatMsg: ChatMessage = {
    id: msgId(),
    role: "user",
    content: userMessage,
    timestamp: Date.now(),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
  dequeueQueuedMessage(tabId, options.queuedMessageId);

  const newApiMessages = [
    ...(stateAfterPreflight.apiMessages.length === 0
      ? [
          {
            role: "system" as const,
            content: await buildMainSystemPromptForState(stateAfterPreflight),
          },
        ]
      : []),
    ...stateAfterPreflight.apiMessages,
    {
      role: "user" as const,
      content: userMessage,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    },
  ];

  patchAgentState(tabId, (prev) => ({
    ...prev,
    status: "thinking",
    error: null,
    errorAction: null,
    errorDetails: null,
    chatMessages: options?.skipUserChatAppend
      ? prev.chatMessages
      : [...prev.chatMessages, userChatMsg],
    apiMessages: newApiMessages,
    streamingContent: null,
  }));

  try {
    await agentLoop(
      tabId,
      controller.signal,
      model,
      providers,
      debugEnabled,
      runId,
      currentTurn,
      runLogContext,
    );
    completedCleanly = !controller.signal.aborted;
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    if (err instanceof RunAbortedError) {
      completedCleanly = true;
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "messages"],
      event: "runner.run.error",
      message: "Main agent loop failed",
      kind: "error",
      data: err,
      context: runLogContext,
    });
    setAgentErrorState(tabId, msg, serializeError(err));
    updateLastChatMessage(tabId, (m) =>
      m.role === "assistant" ? { ...m, streaming: false } : m,
    );
  } finally {
    clearActiveRun(tabId, activeRun);
    if (activeRun.abortReason !== null) return;
    if (!completedCleanly) return;
    if (getAgentState(tabId).status === "error") return;

    patchAgentState(tabId, (prev) =>
      prev.status === "error"
        ? prev
        : {
            ...prev,
            status: "idle",
            streamingContent: null,
            queueState: normalizeQueueState(prev.queuedMessages, prev.queueState),
          },
    );
    writeRunnerLog({
      level: "info",
      tags: ["frontend", "agent-loop", "messages"],
      event: "runner.run.end",
      message: "Main run completed",
      kind: "end",
      context: runLogContext,
    });
    void maybeStartQueuedRun(tabId).catch((error) => {
      writeRunnerLog({
        level: "error",
        tags: ["frontend", "agent-loop", "system"],
        event: "runner.queue.drain.error",
        message: "Queue drain failed",
        kind: "error",
        data: error,
        context: runLogContext,
      });
    });
  }
}
