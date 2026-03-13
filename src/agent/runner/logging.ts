import {
  createChildLogContext,
  logFrontendSoon,
  nextLogId,
  nextTraceId,
} from "@/logging/client";
import type { LogContext } from "@/logging/types";

import { serializeError } from "./utils";

function toLoggable(value: unknown): unknown {
  return value instanceof Error ? serializeError(value) : value;
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
  tabId: string,
  debugEnabled: boolean,
  event: string,
  logContext: LogContext,
  payload?: unknown,
): void {
  if (!debugEnabled) return;
  const tags = ["frontend", "agent-loop", "streaming"];
  if (event.includes("delta")) tags.push("tokens");
  if (event.includes("tool-calls")) tags.push("tool-calls");
  writeRunnerLog({
    level: "debug",
    tags,
    event: `runner.${event}`,
    message: `[${tabId}] ${event}`,
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
  tabId: string,
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

    logStreamDebug(tabId, debugEnabled, "stream:finish", logContext, {
      ...(typeof finishReason === "string" ? { finishReason } : {}),
      ...(typeof rawFinishReason === "string" ? { rawFinishReason } : {}),
      stepCount: steps.length,
      steps: steps.map((step, index) =>
        summarizeStreamStepForDebug(step, index),
      ),
    });
  } catch (error) {
    logStreamDebug(tabId, debugEnabled, "stream:finish:error", logContext, error);
  }
}

export { nextLogId, nextTraceId };
