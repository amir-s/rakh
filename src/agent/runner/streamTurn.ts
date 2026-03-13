import { streamText } from "ai";

import { patchAgentState } from "../atoms";
import type {
  ApiMessage,
  ApiToolCall,
  AssistantApiMessage,
  ToolCallDisplay,
} from "../types";
import type { LogContext } from "@/logging/types";

import {
  appendChatMessage,
  msgId,
  updateLastChatMessage,
} from "./chatState";
import { logStreamDebug, logStreamFinishDebug } from "./logging";
import {
  attachStreamErrors,
  isRecord,
  mapApiMessagesToModelMessages,
  streamDeltaPart,
  streamPartError,
  toApiToolCall,
  type JsonValue,
} from "./utils";

type StreamTextInput = Parameters<typeof streamText>[0];

export interface StreamTurnResult {
  assistantChatId: string;
  assistantApiMsg: AssistantApiMessage;
  parsedToolCalls: ApiToolCall[];
  text: string;
  reasoning: string;
  reasoningStartedAtMs: number | null;
  reasoningDurationMs: number | null;
}

interface StreamTurnOptions {
  tabId: string;
  signal: AbortSignal;
  model: StreamTextInput["model"];
  messages: ApiMessage[];
  tools: StreamTextInput["tools"];
  debugEnabled: boolean;
  logContext: LogContext;
  providerOptions?: Record<string, Record<string, JsonValue>>;
  agentName?: string;
  statusWhileStreaming?: "thinking";
  toPendingToolCalls: (toolCalls: ApiToolCall[]) => ToolCallDisplay[] | undefined;
}

export async function streamTurn(
  opts: StreamTurnOptions,
): Promise<StreamTurnResult> {
  const {
    tabId,
    signal,
    model,
    messages,
    tools,
    debugEnabled,
    logContext,
    providerOptions,
    agentName,
    statusWhileStreaming,
    toPendingToolCalls,
  } = opts;

  let usedFullStream = false;
  let streamPartCount = 0;
  let streamErrorPartCount = 0;
  let textDeltaCount = 0;
  let textDeltaChars = 0;
  let reasoningDeltaCount = 0;
  let reasoningDeltaChars = 0;
  let reasoningStartCount = 0;
  let reasoningEndCount = 0;

  let accText = "";
  let accReasoning = "";
  let reasoningActive = false;
  let reasoningStartedAtMs: number | null = null;
  let reasoningDurationMs: number | null = null;
  const streamErrors: unknown[] = [];

  const assistantChatId = msgId();
  appendChatMessage(tabId, {
    id: assistantChatId,
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    streaming: true,
    ...(agentName ? { agentName } : {}),
  });

  patchAgentState(tabId, (prev) => ({
    ...prev,
    ...(statusWhileStreaming ? { status: statusWhileStreaming } : {}),
    streamingContent: "",
  }));

  const mappedMessages = mapApiMessagesToModelMessages(messages);
  const result = streamText({
    model,
    messages: mappedMessages,
    tools,
    abortSignal: signal,
    ...(providerOptions ? { providerOptions } : {}),
  });

  const ensureReasoningStart = () => {
    if (reasoningStartedAtMs === null) {
      reasoningStartedAtMs = Date.now();
    }
  };

  const finalizeReasoningDuration = () => {
    if (reasoningStartedAtMs === null || reasoningDurationMs !== null) {
      return;
    }
    reasoningDurationMs = Math.max(0, Date.now() - reasoningStartedAtMs);
  };

  const updateStreamingMessage = () => {
    updateLastChatMessage(tabId, (m) =>
      m.id === assistantChatId
        ? {
            ...m,
            ...(agentName ? { agentName } : {}),
            content: accText,
            reasoning: accReasoning || undefined,
            reasoningStreaming: reasoningActive ? true : undefined,
            reasoningStartedAtMs: reasoningStartedAtMs ?? undefined,
            reasoningDurationMs: reasoningDurationMs ?? undefined,
          }
        : m,
    );
  };

  try {
    const fullStream = (result as { fullStream?: AsyncIterable<unknown> })
      .fullStream;
    if (fullStream) {
      usedFullStream = true;
      for await (const part of fullStream) {
        if (signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        streamPartCount += 1;
        logStreamDebug(tabId, debugEnabled, "stream:part", logContext, part);

        const streamError = streamPartError(part);
        if (streamError !== null) {
          streamErrorPartCount += 1;
          logStreamDebug(
            tabId,
            debugEnabled,
            "stream:error-part",
            logContext,
            streamError,
          );
          streamErrors.push(streamError);
          continue;
        }

        if (isRecord(part) && part.type === "reasoning-start") {
          reasoningStartCount += 1;
          ensureReasoningStart();
          reasoningActive = true;
          logStreamDebug(
            tabId,
            debugEnabled,
            "stream:reasoning-start",
            logContext,
          );
          updateStreamingMessage();
          continue;
        }

        if (isRecord(part) && part.type === "reasoning-end") {
          reasoningEndCount += 1;
          reasoningActive = false;
          finalizeReasoningDuration();
          logStreamDebug(tabId, debugEnabled, "stream:reasoning-end", logContext, {
            reasoningDurationMs,
          });
          updateStreamingMessage();
          continue;
        }

        const textDelta = streamDeltaPart(part, "text-delta");
        if (textDelta !== null) {
          accText += textDelta;
          textDeltaCount += 1;
          textDeltaChars += textDelta.length;
          logStreamDebug(tabId, debugEnabled, "stream:text-delta", logContext, {
            delta: textDelta,
            deltaLength: textDelta.length,
            accumulatedLength: accText.length,
          });
          patchAgentState(tabId, { streamingContent: accText });
          updateStreamingMessage();
          continue;
        }

        const reasoningDelta = streamDeltaPart(part, "reasoning-delta");
        if (reasoningDelta !== null) {
          ensureReasoningStart();
          reasoningActive = true;
          accReasoning += reasoningDelta;
          reasoningDeltaCount += 1;
          reasoningDeltaChars += reasoningDelta.length;
          logStreamDebug(tabId, debugEnabled, "stream:reasoning-delta", logContext, {
            delta: reasoningDelta,
            deltaLength: reasoningDelta.length,
            accumulatedLength: accReasoning.length,
          });
          updateStreamingMessage();
        }
      }
    } else {
      for await (const delta of result.textStream) {
        if (signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        accText += delta;
        textDeltaCount += 1;
        textDeltaChars += delta.length;
        logStreamDebug(tabId, debugEnabled, "stream:text-delta:textStream", logContext, {
          delta,
          deltaLength: delta.length,
          accumulatedLength: accText.length,
        });

        patchAgentState(tabId, { streamingContent: accText });
        updateStreamingMessage();
      }
    }
  } catch (err) {
    logStreamDebug(tabId, debugEnabled, "stream:throw", logContext, err);
    if (!signal.aborted && (err as Error).name !== "AbortError") {
      throw attachStreamErrors(err, streamErrors);
    }
    throw err;
  }

  let sdkToolCalls: unknown;
  try {
    sdkToolCalls = await result.toolCalls;
    logStreamDebug(
      tabId,
      debugEnabled,
      "stream:tool-calls:raw",
      logContext,
      sdkToolCalls,
    );
  } catch (err) {
    logStreamDebug(tabId, debugEnabled, "stream:tool-calls:error", logContext, err);
    throw attachStreamErrors(err, streamErrors);
  }
  await logStreamFinishDebug(tabId, debugEnabled, result, logContext);

  if (reasoningStartedAtMs !== null && reasoningDurationMs === null) {
    reasoningDurationMs = Math.max(0, Date.now() - reasoningStartedAtMs);
  }
  patchAgentState(tabId, { streamingContent: null });

  const parsedToolCalls: ApiToolCall[] = (
    Array.isArray(sdkToolCalls) ? sdkToolCalls : []
  )
    .map((tc) => toApiToolCall(tc))
    .filter((tc): tc is ApiToolCall => tc !== null);
  logStreamDebug(tabId, debugEnabled, "stream:tool-calls:parsed", logContext, {
    count: parsedToolCalls.length,
    toolCallIds: parsedToolCalls.map((tc) => tc.id),
    toolNames: parsedToolCalls.map((tc) => tc.function.name),
  });
  logStreamDebug(tabId, debugEnabled, "stream:summary", logContext, {
    usedFullStream,
    streamPartCount,
    streamErrorPartCount,
    textDeltaCount,
    textDeltaChars,
    reasoningStartCount,
    reasoningEndCount,
    reasoningDeltaCount,
    reasoningDeltaChars,
    assistantTextChars: accText.length,
    assistantReasoningChars: accReasoning.length,
    toolCallCount: parsedToolCalls.length,
    reasoningDurationMs: reasoningDurationMs ?? undefined,
  });

  updateLastChatMessage(tabId, (m) => {
    if (m.id !== assistantChatId) return m;
    return {
      ...m,
      ...(agentName ? { agentName } : {}),
      content: accText,
      reasoning: accReasoning || undefined,
      reasoningStreaming: undefined,
      reasoningStartedAtMs: reasoningStartedAtMs ?? undefined,
      reasoningDurationMs: reasoningDurationMs ?? undefined,
      streaming: false,
      badge: parsedToolCalls.length > 0 ? "CALLING TOOLS" : undefined,
      toolCalls: toPendingToolCalls(parsedToolCalls),
    };
  });

  return {
    assistantChatId,
    assistantApiMsg: {
      role: "assistant",
      content: accText || null,
      ...(parsedToolCalls.length > 0 ? { tool_calls: parsedToolCalls } : {}),
    },
    parsedToolCalls,
    text: accText,
    reasoning: accReasoning,
    reasoningStartedAtMs,
    reasoningDurationMs,
  };
}
