import {
  createChildLogContext,
  logFrontendSoon,
  nextLogId,
  nextTraceId,
} from "@/logging/client";
import type { LogContext, LogKind, LogLevel } from "@/logging/types";

import { serializeError } from "./utils";

function toLoggable(value: unknown): unknown {
  return value instanceof Error ? serializeError(value) : value;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractMessage(value: unknown): string | null {
  if (value instanceof Error) {
    return value.message || value.name || null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!isRecord(value)) return null;
  const direct = value.message;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const error = value.error;
  if (error instanceof Error) return error.message || error.name || null;
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (isRecord(error) && typeof error.message === "string") {
    const trimmed = error.message.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

function describeToolCalls(
  payload: Record<string, unknown> | undefined,
): string {
  const names = Array.isArray(payload?.toolNames)
    ? payload.toolNames.filter((name): name is string => typeof name === "string")
    : [];
  const count =
    typeof payload?.count === "number"
      ? payload.count
      : typeof payload?.toolCallCount === "number"
        ? payload.toolCallCount
        : names.length;
  if (count <= 0) return "no tool calls";
  const suffix = names.length > 0 ? `: ${joinNames(names)}` : "";
  return `${pluralize(count, "tool call")}${suffix}`;
}

function streamLogLevel(event: string): LogLevel {
  switch (event) {
    case "stream:part":
    case "stream:text-delta":
    case "stream:reasoning-delta":
    case "stream:text-delta:textStream":
    case "stream:tool-calls:raw":
      return "trace";
    case "stream:error-part":
    case "stream:tool-calls:error":
    case "stream:finish:error":
    case "stream:usage:error":
      return "warn";
    case "stream:throw":
      return "error";
    default:
      return "debug";
  }
}

function streamLogKind(event: string, level: LogLevel): LogKind {
  if (level === "error") return "error";
  if (event.includes(":error") || event.endsWith(":throw")) return "error";
  return "event";
}

function summarizeStreamEvent(
  event: string,
  payload: unknown,
): string {
  const record = isRecord(payload) ? payload : undefined;
  switch (event) {
    case "stream:part": {
      const partType =
        typeof record?.type === "string" ? record.type : null;
      return partType ? `Stream part received: ${partType}` : "Stream part received";
    }
    case "stream:error-part": {
      const message = extractMessage(payload);
      return message ? `Stream reported an error part: ${message}` : "Stream reported an error part";
    }
    case "stream:reasoning-start":
      return "Reasoning stream started";
    case "stream:reasoning-end": {
      const durationMs =
        typeof record?.reasoningDurationMs === "number"
          ? record.reasoningDurationMs
          : null;
      return durationMs !== null
        ? `Reasoning stream ended after ${durationMs}ms`
        : "Reasoning stream ended";
    }
    case "stream:text-delta":
    case "stream:text-delta:textStream": {
      const deltaLength =
        typeof record?.deltaLength === "number" ? record.deltaLength : null;
      const accumulatedLength =
        typeof record?.accumulatedLength === "number"
          ? record.accumulatedLength
          : null;
      const prefix =
        event === "stream:text-delta:textStream"
          ? "Fallback text delta"
          : "Text delta";
      if (deltaLength !== null && accumulatedLength !== null) {
        return `${prefix}: +${deltaLength} chars (${accumulatedLength} total)`;
      }
      if (deltaLength !== null) return `${prefix}: +${deltaLength} chars`;
      return `${prefix} received`;
    }
    case "stream:reasoning-delta": {
      const deltaLength =
        typeof record?.deltaLength === "number" ? record.deltaLength : null;
      const accumulatedLength =
        typeof record?.accumulatedLength === "number"
          ? record.accumulatedLength
          : null;
      if (deltaLength !== null && accumulatedLength !== null) {
        return `Reasoning delta: +${deltaLength} chars (${accumulatedLength} total)`;
      }
      if (deltaLength !== null) return `Reasoning delta: +${deltaLength} chars`;
      return "Reasoning delta received";
    }
    case "stream:throw": {
      const message = extractMessage(payload);
      return message ? `Stream threw before completion: ${message}` : "Stream threw before completion";
    }
    case "stream:tool-calls:raw": {
      const count = Array.isArray(payload) ? payload.length : 0;
      return count > 0
        ? `Raw tool call payload received for ${pluralize(count, "call")}`
        : "Raw tool call payload received";
    }
    case "stream:tool-calls:error": {
      const message = extractMessage(payload);
      return message ? `Failed to read tool calls from the stream: ${message}` : "Failed to read tool calls from the stream";
    }
    case "stream:finish": {
      const stepCount =
        typeof record?.stepCount === "number" ? record.stepCount : 0;
      const finishReason =
        typeof record?.finishReason === "string" ? record.finishReason : null;
      return finishReason
        ? `Stream finished after ${pluralize(stepCount, "step")} (${finishReason})`
        : `Stream finished after ${pluralize(stepCount, "step")}`;
    }
    case "stream:finish:error": {
      const message = extractMessage(payload);
      return message ? `Failed to read stream completion details: ${message}` : "Failed to read stream completion details";
    }
    case "stream:usage": {
      const totalTokens =
        typeof record?.totalTokens === "number" ? record.totalTokens : null;
      const inputTokens =
        typeof record?.inputTokens === "number" ? record.inputTokens : null;
      const outputTokens =
        typeof record?.outputTokens === "number" ? record.outputTokens : null;
      if (totalTokens !== null) {
        return `Recorded usage: ${totalTokens} total tokens`;
      }
      if (inputTokens !== null || outputTokens !== null) {
        return `Recorded usage: ${inputTokens ?? 0} input, ${outputTokens ?? 0} output tokens`;
      }
      return "Recorded model usage";
    }
    case "stream:usage:error": {
      const message = extractMessage(payload);
      return message ? `Failed to read usage metadata: ${message}` : "Failed to read usage metadata";
    }
    case "stream:tool-calls:parsed":
      return `Parsed ${describeToolCalls(record)}`;
    case "stream:summary": {
      const textChars =
        typeof record?.assistantTextChars === "number"
          ? record.assistantTextChars
          : 0;
      const reasoningChars =
        typeof record?.assistantReasoningChars === "number"
          ? record.assistantReasoningChars
          : 0;
      const toolCallCount =
        typeof record?.toolCallCount === "number" ? record.toolCallCount : 0;
      return `Stream summary: ${textChars} text chars, ${reasoningChars} reasoning chars, ${pluralize(toolCallCount, "tool call")}`;
    }
    default:
      return event.replaceAll(":", " ");
  }
}

function normalizeRunnerEvent(event: string): string {
  return `runner.${event.replaceAll(":", ".")}`;
}

export function writeRunnerLog(input: {
  id?: string;
  level?: "trace" | "debug" | "info" | "warn" | "error";
  tags: string[];
  event: string;
  message: string;
  kind?: "start" | "end" | "event" | "error";
  expandable?: boolean;
  durationMs?: number;
  data?: unknown;
  context?: LogContext;
}): void {
  logFrontendSoon({
    id: input.id,
    level: input.level,
    tags: input.tags,
    event: input.event,
    message: input.message,
    kind: input.kind,
    expandable: input.expandable,
    durationMs: input.durationMs,
    data: input.data,
    context: input.context,
  });
}

export function createMainRunLogContext(tabId: string, runId: string): {
  runStartId: string;
  rootContext: LogContext;
  childContext: LogContext;
} {
  const traceId = nextTraceId("trace", runId, "main");
  const runStartId = nextLogId(`run:${runId}`);
  const rootContext: LogContext = {
    sessionId: tabId,
    tabId,
    traceId,
    depth: 0,
    agentId: "agent_main",
  };
  return {
    runStartId,
    rootContext,
    childContext: {
      ...rootContext,
      parentId: runStartId,
      depth: 1,
    },
  };
}

export function createToolLogContext(
  baseContext: LogContext,
  toolCallId: string,
  toolName: string,
): { startId: string; context: LogContext } {
  const startId = nextLogId(`tool:${toolCallId}`);
  return {
    startId,
    context: createChildLogContext(baseContext, {
      correlationId: toolCallId,
      parentId: startId,
      toolName,
    }),
  };
}

export function logStreamDebug(
  debugEnabled: boolean,
  event: string,
  logContext: LogContext,
  payload?: unknown,
): void {
  if (!debugEnabled) return;
  const tags = ["frontend", "agent-loop", "streaming"];
  if (event.includes("reasoning")) tags.push("reasoning");
  if (event.includes("delta")) tags.push("tokens");
  if (event.includes("tool-calls")) tags.push("tool-calls");
  const level = streamLogLevel(event);
  writeRunnerLog({
    level,
    tags,
    event: normalizeRunnerEvent(event),
    message: summarizeStreamEvent(event, payload),
    kind: streamLogKind(event, level),
    data: payload === undefined ? undefined : toLoggable(payload),
    context: logContext,
  });
}

interface DebuggableStreamStep {
  stepNumber?: unknown;
  finishReason?: unknown;
  rawFinishReason?: unknown;
  text?: unknown;
  reasoningText?: unknown;
  toolCalls?: unknown;
}

interface DebuggableStreamResult {
  finishReason?: PromiseLike<unknown>;
  rawFinishReason?: PromiseLike<unknown>;
  steps?: PromiseLike<unknown>;
}

function summarizeStreamStepForDebug(
  step: unknown,
  fallbackStepNumber: number,
): Record<string, unknown> {
  if (!(typeof step === "object" && step !== null)) {
    return { stepNumber: fallbackStepNumber };
  }

  const debugStep = step as DebuggableStreamStep;
  const toolCalls = Array.isArray(debugStep.toolCalls) ? debugStep.toolCalls : [];
  const toolNames = toolCalls
    .map((toolCall) =>
      typeof toolCall === "object" &&
      toolCall !== null &&
      typeof (toolCall as { toolName?: unknown }).toolName === "string"
        ? (toolCall as { toolName: string }).toolName
        : null,
    )
    .filter((toolName): toolName is string => toolName !== null);

  return {
    stepNumber:
      typeof debugStep.stepNumber === "number"
        ? debugStep.stepNumber
        : fallbackStepNumber,
    ...(typeof debugStep.finishReason === "string"
      ? { finishReason: debugStep.finishReason }
      : {}),
    ...(typeof debugStep.rawFinishReason === "string"
      ? { rawFinishReason: debugStep.rawFinishReason }
      : {}),
    textChars:
      typeof debugStep.text === "string" ? debugStep.text.length : undefined,
    reasoningChars:
      typeof debugStep.reasoningText === "string"
        ? debugStep.reasoningText.length
        : undefined,
    toolCallCount: toolCalls.length,
    ...(toolNames.length > 0 ? { toolNames } : {}),
  };
}

export async function logStreamFinishDebug(
  debugEnabled: boolean,
  result: DebuggableStreamResult,
  logContext: LogContext,
): Promise<void> {
  if (!debugEnabled) return;

  try {
    const [finishReason, rawFinishReason, stepsValue] = await Promise.all([
      result.finishReason ?? Promise.resolve(undefined),
      result.rawFinishReason ?? Promise.resolve(undefined),
      result.steps ?? Promise.resolve(undefined),
    ]);
    const steps = Array.isArray(stepsValue) ? stepsValue : [];

    logStreamDebug(debugEnabled, "stream:finish", logContext, {
      ...(typeof finishReason === "string" ? { finishReason } : {}),
      ...(typeof rawFinishReason === "string" ? { rawFinishReason } : {}),
      stepCount: steps.length,
      steps: steps.map((step, index) =>
        summarizeStreamStepForDebug(step, index),
      ),
    });
  } catch (error) {
    logStreamDebug(debugEnabled, "stream:finish:error", logContext, error);
  }
}

export { nextLogId, nextTraceId };
