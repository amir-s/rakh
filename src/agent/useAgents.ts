/**
 * useAgents — the primary React hook for the UI to interact with agents.
 *
 * Exposes:
 *  - per-tab agent state via Jotai atoms
 *  - sendMessage(tabId, text): start/continue a conversation
 *  - stopAgent(tabId): cancel the current run
 *  - setAgentConfig(tabId, config): update cwd / model
 *  - resetAgent(tabId): clear conversation history
 */

import { useAtom, useAtomValue } from "jotai";
import { useCallback } from "react";
import { logFrontendSoon } from "@/logging/client";
import {
  buildSessionCostSeries,
  estimateCurrentContextStats,
  summarizeSessionUsage,
  type CurrentContextStats,
  type SessionCostSeriesPoint,
  type SessionUsageSummary,
} from "./sessionStats";

import {
  agentAtomFamily,
  agentStatusAtomFamily,
  agentChatMessagesAtomFamily,
  agentStreamingAtomFamily,
  agentPlanAtomFamily,
  agentTodosAtomFamily,
  agentConfigAtomFamily,
  agentErrorAtomFamily,
  agentErrorActionAtomFamily,
  agentErrorDetailsAtomFamily,
  agentTabTitleAtomFamily,
  agentReviewEditsAtomFamily,
  agentAutoApproveEditsAtomFamily,
  agentAutoApproveCommandsAtomFamily,
  agentGroupInlineToolCallsAtomFamily,
  agentQueuedMessagesAtomFamily,
  agentQueueStateAtomFamily,
  agentShowDebugAtomFamily,
  patchAgentState,
} from "./atoms";
import {
  runAgent,
  queueMessage as _queueMessage,
  steerMessage as _steerMessage,
  resumeQueue as _resumeQueue,
  removeQueuedMessage as _removeQueuedMessage,
  clearQueuedMessages as _clearQueuedMessages,
  continueToolIoReplacementFailure as _continueToolIoReplacementFailure,
  retryAgent as _retryAgent,
  stopAgent as _stopAgent,
  stopRunningExecToolCall as _stopRunningExecToolCall,
} from "./runner";
import type { AgentConfig, AttachedImage, AutoApproveCommandsMode } from "./types";

export interface ContextWindowKbUsage {
  currentKb: number;
  /** null when the model's max context size is not known */
  maxKb: number | null;
}

export type { CurrentContextStats, SessionUsageSummary };
export type { SessionCostSeriesPoint };

/* ── Full atom for a tab (use when you need to write to it) ──────────────── */

export function useAgentAtom(tabId: string) {
  return useAtom(agentAtomFamily(tabId));
}

/* ── Fine-grained read-only subscriptions ────────────────────────────────── */

export function useAgentStatus(tabId: string) {
  return useAtomValue(agentStatusAtomFamily(tabId));
}

export function useAgentChatMessages(tabId: string) {
  return useAtomValue(agentChatMessagesAtomFamily(tabId));
}

export function useAgentStreaming(tabId: string) {
  return useAtomValue(agentStreamingAtomFamily(tabId));
}

export function useAgentPlan(tabId: string) {
  return useAtomValue(agentPlanAtomFamily(tabId));
}

export function useAgentTodos(tabId: string) {
  return useAtomValue(agentTodosAtomFamily(tabId));
}

export function useAgentConfig(tabId: string) {
  return useAtomValue(agentConfigAtomFamily(tabId));
}

export function useAgentError(tabId: string) {
  return useAtomValue(agentErrorAtomFamily(tabId));
}

export function useAgentErrorAction(tabId: string) {
  return useAtomValue(agentErrorActionAtomFamily(tabId));
}

export function useAgentErrorDetails(tabId: string) {
  return useAtomValue(agentErrorDetailsAtomFamily(tabId));
}

export function useAgentTabTitle(tabId: string) {
  return useAtomValue(agentTabTitleAtomFamily(tabId));
}

export function useAgentReviewEdits(tabId: string) {
  return useAtomValue(agentReviewEditsAtomFamily(tabId));
}

export function useAgentAutoApproveEdits(tabId: string) {
  return useAtomValue(agentAutoApproveEditsAtomFamily(tabId));
}

export function useAgentAutoApproveCommands(tabId: string) {
  return useAtomValue(agentAutoApproveCommandsAtomFamily(tabId));
}

export function useAgentGroupInlineToolCalls(tabId: string) {
  return useAtomValue(agentGroupInlineToolCallsAtomFamily(tabId));
}

export function useAgentQueuedMessages(tabId: string) {
  return useAtomValue(agentQueuedMessagesAtomFamily(tabId));
}

export function useAgentQueueState(tabId: string) {
  return useAtomValue(agentQueueStateAtomFamily(tabId));
}

export function useAgentShowDebug(tabId: string) {
  return useAtomValue(agentShowDebugAtomFamily(tabId));
}

/* ── Actions ─────────────────────────────────────────────────────────────── */

/**
 * sendMessage — send a user message to the given agent.
 * Safe to call concurrently for different tabIds (they run in parallel).
 */
export function useSendMessage() {
  return useCallback(
    (tabId: string, message: string, attachments?: AttachedImage[]) => {
      // fire-and-forget; the runner updates atoms reactively
      runAgent(tabId, message, attachments).catch((error) => {
        logFrontendSoon({
          level: "error",
          tags: ["frontend", "agent-loop"],
          event: "agent.send-message.error",
          message: "Failed to start an agent run from the send-message hook.",
          data: { error, tabId },
          context: { tabId },
        });
      });
    },
    [],
  );
}

/** stopAgent — abort the currently running turn for a tab */
export function useStopAgent() {
  return useCallback((tabId: string) => _stopAgent(tabId), []);
}

/** retryAgent — re-run the last user message after an error */
export function useRetryAgent() {
  return useCallback((tabId: string) => {
    _retryAgent(tabId).catch((error) => {
      logFrontendSoon({
        level: "error",
        tags: ["frontend", "agent-loop"],
        event: "agent.retry.error",
        message: "Failed to retry the agent run.",
        data: { error, tabId },
        context: { tabId },
      });
    });
  }, []);
}

export function useContinueToolIoReplacementFailure() {
  return useCallback((tabId: string) => {
    _continueToolIoReplacementFailure(tabId).catch((error) => {
      logFrontendSoon({
        level: "error",
        tags: ["frontend", "agent-loop"],
        event: "agent.continueToolIoReplacementFailure.error",
        message: "Failed to continue the agent run without tool IO replacement.",
        data: {
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
          tabId,
        },
        context: { tabId },
      });
    });
  }, []);
}

export function useQueueMessage() {
  return useCallback((tabId: string, message: string) => {
    _queueMessage(tabId, message);
  }, []);
}

export function useSteerMessage() {
  return useCallback((tabId: string, message: string, queuedMessageId?: string) => {
    _steerMessage(tabId, message, queuedMessageId).catch((error) => {
      logFrontendSoon({
        level: "error",
        tags: ["frontend", "agent-loop"],
        event: "agent.steer.error",
        message: "Failed to steer the active agent run.",
        data: { error, tabId, queuedMessageId },
        context: { tabId, correlationId: queuedMessageId },
      });
    });
  }, []);
}

export function useResumeQueue() {
  return useCallback((tabId: string) => {
    _resumeQueue(tabId);
  }, []);
}

export function useRemoveQueuedMessage() {
  return useCallback((tabId: string, messageId: string) => {
    _removeQueuedMessage(tabId, messageId);
  }, []);
}

export function useClearQueuedMessages() {
  return useCallback((tabId: string) => {
    _clearQueuedMessages(tabId);
  }, []);
}

/** stopRunningExecToolCall — terminate one running exec_run tool call only. */
export function useStopRunningExecToolCall() {
  return useCallback((tabId: string, toolCallId: string) => {
    return _stopRunningExecToolCall(tabId, toolCallId);
  }, []);
}

/** setAgentConfig — update the CWD or model for a specific tab */
export function useSetAgentConfig() {
  return useCallback((tabId: string, config: Partial<AgentConfig>) => {
    patchAgentState(tabId, (prev) => ({
      ...prev,
      config: { ...prev.config, ...config },
    }));
  }, []);
}

/** resetAgent — clear all messages and state for a tab (keeps config) */
export function useResetAgent() {
  return useCallback((tabId: string) => {
    _stopAgent(tabId);
    patchAgentState(tabId, (prev) => ({
      ...prev,
      status: "idle",
      turnCount: 0,
      chatMessages: [],
      apiMessages: [],
      streamingContent: null,
      error: null,
      errorAction: null,
      errorDetails: null,
      plan: { markdown: "", updatedAtMs: 0, version: 0 },
      todos: [],
      tabTitle: "",
      reviewEdits: [],
      autoApproveEdits: false,
      autoApproveCommands: "no",
      groupInlineToolCallsOverride: null,
      queuedMessages: [],
      queueState: "idle",
      llmUsageLedger: [],
      loopLimitWarning: null,
      showDebug: prev.showDebug ?? false,
      lastRunTraceId: undefined,
    }));
  }, []);
}

/* ── Context window % ────────────────────────────────────────────────────── */

/**
 * Computes how much of the context window is used (0–100), based on a
 * character-length estimate of the current apiMessages vs the model's
 * context_length stored in AgentConfig at session creation.
 */
export function useContextWindowPct(tabId: string): number | null {
  const config = useAgentConfig(tabId);
  const apiMessages = useAtomValue(agentAtomFamily(tabId)).apiMessages;
  return estimateCurrentContextStats(apiMessages, config.contextLength)?.pct ?? null;
}

/** Estimates current and maximum context size in KB from token budgets. */
export function useContextWindowKb(tabId: string): ContextWindowKbUsage | null {
  const config = useAgentConfig(tabId);
  const apiMessages = useAtomValue(agentAtomFamily(tabId)).apiMessages;
  const stats = estimateCurrentContextStats(apiMessages, config.contextLength);
  if (!stats) return null;
  return {
    currentKb: stats.currentKb,
    maxKb: stats.maxKb,
  };
}

export function useCurrentContextStats(tabId: string): CurrentContextStats | null {
  const config = useAgentConfig(tabId);
  const apiMessages = useAtomValue(agentAtomFamily(tabId)).apiMessages;
  return estimateCurrentContextStats(apiMessages, config.contextLength);
}

export function useSessionUsageSummary(tabId: string): SessionUsageSummary | null {
  const llmUsageLedger = useAtomValue(agentAtomFamily(tabId)).llmUsageLedger;
  return summarizeSessionUsage(llmUsageLedger);
}

export function useSessionCostSeries(tabId: string): SessionCostSeriesPoint[] {
  const llmUsageLedger = useAtomValue(agentAtomFamily(tabId)).llmUsageLedger;
  return buildSessionCostSeries(llmUsageLedger);
}

/* ── Convenience: everything for one tab in a single hook ────────────────── */

export function useAgent(tabId: string) {
  const status = useAgentStatus(tabId);
  const chatMessages = useAgentChatMessages(tabId);
  const streaming = useAgentStreaming(tabId);
  const plan = useAgentPlan(tabId);
  const todos = useAgentTodos(tabId);
  const config = useAgentConfig(tabId);
  const error = useAgentError(tabId);
  const errorAction = useAgentErrorAction(tabId);
  const errorDetails = useAgentErrorDetails(tabId);
  const tabTitle = useAgentTabTitle(tabId);
  const autoApproveEdits = useAgentAutoApproveEdits(tabId);
  const autoApproveCommands = useAgentAutoApproveCommands(tabId);
  const groupInlineToolCalls = useAgentGroupInlineToolCalls(tabId);
  const queuedMessages = useAgentQueuedMessages(tabId);
  const queueState = useAgentQueueState(tabId);
  const showDebug = useAgentShowDebug(tabId);
  const loopLimitWarning = useAtomValue(agentAtomFamily(tabId)).loopLimitWarning;
  const lastRunTraceId = useAtomValue(agentAtomFamily(tabId)).lastRunTraceId;
  const sendMessage = useSendMessage();
  const queueMessage = useQueueMessage();
  const steerMessage = useSteerMessage();
  const resumeQueue = useResumeQueue();
  const removeQueuedMessage = useRemoveQueuedMessage();
  const clearQueuedMessages = useClearQueuedMessages();
  const stopAgent = useStopAgent();
  const setConfig = useSetAgentConfig();
  const resetAgent = useResetAgent();
  const retryAgent = useRetryAgent();
  const continueToolIoReplacementFailure =
    useContinueToolIoReplacementFailure();
  const currentContextStats = useCurrentContextStats(tabId);
  const contextWindowPct = useContextWindowPct(tabId);
  const contextWindowKb = useContextWindowKb(tabId);
  const sessionUsageSummary = useSessionUsageSummary(tabId);
  const sessionCostSeries = useSessionCostSeries(tabId);

  return {
    status,
    chatMessages,
    streaming,
    plan,
    todos,
    config,
    error,
    errorAction,
    errorDetails,
    tabTitle,
    currentContextStats,
    contextWindowPct,
    contextWindowKb,
    sessionUsageSummary,
    sessionCostSeries,
    autoApproveEdits,
    autoApproveCommands,
    groupInlineToolCalls,
    queuedMessages,
    queueState,
    showDebug,
    loopLimitWarning,
    lastRunTraceId,
    sendMessage: useCallback(
      (msg: string, attachments?: AttachedImage[]) =>
        sendMessage(tabId, msg, attachments),
      [tabId, sendMessage],
    ),
    queueMessage: useCallback(
      (msg: string) => queueMessage(tabId, msg),
      [tabId, queueMessage],
    ),
    steerMessage: useCallback(
      (msg: string, queuedMessageId?: string) =>
        steerMessage(tabId, msg, queuedMessageId),
      [tabId, steerMessage],
    ),
    resumeQueue: useCallback(() => resumeQueue(tabId), [tabId, resumeQueue]),
    removeQueuedMessage: useCallback(
      (messageId: string) => removeQueuedMessage(tabId, messageId),
      [tabId, removeQueuedMessage],
    ),
    clearQueuedMessages: useCallback(
      () => clearQueuedMessages(tabId),
      [tabId, clearQueuedMessages],
    ),
    stop: useCallback(() => stopAgent(tabId), [tabId, stopAgent]),
    setConfig: useCallback(
      (c: Partial<AgentConfig>) => setConfig(tabId, c),
      [tabId, setConfig],
    ),
    setAutoApproveEdits: useCallback(
      (v: boolean) => patchAgentState(tabId, { autoApproveEdits: v }),
      [tabId],
    ),
    setAutoApproveCommands: useCallback(
      (v: AutoApproveCommandsMode) =>
        patchAgentState(tabId, { autoApproveCommands: v }),
      [tabId],
    ),
    reset: useCallback(() => resetAgent(tabId), [tabId, resetAgent]),
    retry: useCallback(() => retryAgent(tabId), [tabId, retryAgent]),
    continueWithoutReplacement: useCallback(
      () => continueToolIoReplacementFailure(tabId),
      [tabId, continueToolIoReplacementFailure],
    ),
    dismissLoopLimitWarning: useCallback(
      () =>
        patchAgentState(tabId, (prev) =>
          prev.loopLimitWarning
            ? {
                ...prev,
                loopLimitWarning: {
                  ...prev.loopLimitWarning,
                  dismissed: true,
                },
              }
            : prev,
        ),
      [tabId],
    ),
  };
}
