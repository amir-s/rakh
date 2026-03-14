import type { ApiMessage } from "./types";

export interface ContextUsageEstimate {
  estimatedTokens: number;
  estimatedBytes: number;
}

export function estimateContextUsage(
  apiMessages: ApiMessage[],
): ContextUsageEstimate | null {
  if (!apiMessages.length) return null;

  const totalChars = apiMessages.reduce((sum, message) => {
    if (
      message.role === "system" ||
      message.role === "user" ||
      message.role === "tool"
    ) {
      return sum + (message.content?.length ?? 0);
    }

    if (message.role === "assistant") {
      const textLength = message.content?.length ?? 0;
      const toolCallLength = message.tool_calls
        ? message.tool_calls.reduce(
            (acc, toolCall) =>
              acc +
              toolCall.function.name.length +
              (typeof toolCall.function.arguments === "string"
                ? toolCall.function.arguments.length
                : 0),
            0,
          )
        : 0;
      return sum + textLength + toolCallLength;
    }

    return sum;
  }, 0);

  const estimatedTokens = Math.ceil(totalChars / 4);
  return {
    estimatedTokens,
    estimatedBytes: estimatedTokens * 4,
  };
}

export function estimateContextWindowPct(
  apiMessages: ApiMessage[],
  contextLength?: number,
): number | null {
  if (!contextLength) return null;
  const usage = estimateContextUsage(apiMessages);
  if (!usage) return null;
  return Math.min(100, (usage.estimatedTokens / contextLength) * 100);
}

