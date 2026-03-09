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
  agentShowDebugAtomFamily,
  patchAgentState,
} from "./atoms";
import {
  runAgent,
  retryAgent as _retryAgent,
  stopAgent as _stopAgent,
  stopRunningExecToolCall as _stopRunningExecToolCall,
} from "./runner";
import type {
  AgentConfig,
  ApiMessage,
  AttachedImage,
  AutoApproveCommandsMode,
} from "./types";

interface ContextUsageEstimate {
  estimatedTokens: number;
  estimatedBytes: number;
}

export interface ContextWindowKbUsage {
  currentKb: number;
  /** null when the model's max context size is not known */
  maxKb: number | null;
}

function estimateContextUsage(apiMessages: ApiMessage[]): ContextUsageEstimate | null {
  if (!apiMessages.length) return null;

  const totalChars = apiMessages.reduce((sum, m) => {
    if (m.role === "system" || m.role === "user" || m.role === "tool") {
      return sum + (m.content?.length ?? 0);
    }
    if (m.role === "assistant") {
      const textLen = m.content?.length ?? 0;
      const tcLen = m.tool_calls
        ? m.tool_calls.reduce(
            (s, tc) =>
              s +
              tc.function.name.length +
              (typeof tc.function.arguments === "string"
                ? tc.function.arguments.length
                : 0),
            0,
          )
        : 0;
      return sum + textLen + tcLen;
    }
    return sum;
  }, 0);

  const estimatedTokens = Math.ceil(totalChars / 4);
  return {
    estimatedTokens,
    estimatedBytes: estimatedTokens * 4,
  };
}

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
      runAgent(tabId, message, attachments).catch(console.error);
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
    _retryAgent(tabId).catch(console.error);
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
      showDebug: false,
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

  if (!config.contextLength) return null;

  const usage = estimateContextUsage(apiMessages);
  if (!usage) return null;

  return Math.min(100, (usage.estimatedTokens / config.contextLength) * 100);
}

/** Estimates current and maximum context size in KB from token budgets. */
export function useContextWindowKb(tabId: string): ContextWindowKbUsage | null {
  const config = useAgentConfig(tabId);
  const apiMessages = useAtomValue(agentAtomFamily(tabId)).apiMessages;

  const usage = estimateContextUsage(apiMessages);
  if (!usage) return null;

  const maxKb = config.contextLength ? (config.contextLength * 4) / 1024 : null;
  return {
    currentKb: usage.estimatedBytes / 1024,
    maxKb,
  };
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
  const showDebug = useAgentShowDebug(tabId);
  const sendMessage = useSendMessage();
  const stopAgent = useStopAgent();
  const setConfig = useSetAgentConfig();
  const resetAgent = useResetAgent();
  const retryAgent = useRetryAgent();
  const contextWindowPct = useContextWindowPct(tabId);
  const contextWindowKb = useContextWindowKb(tabId);

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
    contextWindowPct,
    contextWindowKb,
    autoApproveEdits,
    autoApproveCommands,
    showDebug,
    sendMessage: useCallback(
      (msg: string, attachments?: AttachedImage[]) =>
        sendMessage(tabId, msg, attachments),
      [tabId, sendMessage],
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
  };
}
