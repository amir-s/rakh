import type { ModelMessage } from "ai";

import type { ApiMessage, ApiToolCall } from "../types";
import type { SearchFilesOutput } from "@/agent/tools/workspace";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

type ToolResultOutputLike =
  | { type: "text"; value: string }
  | { type: "json"; value: JsonValue }
  | { type: "execution-denied"; reason?: string }
  | { type: "error-text"; value: string }
  | { type: "error-json"; value: JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class RunAbortedError extends Error {
  constructor(message = "Agent run aborted") {
    super(message);
    this.name = "RunAbortedError";
  }
}

export function isRunAbortedToolResult(result: unknown): boolean {
  return (
    isRecord(result) &&
    result.ok === false &&
    isRecord(result.error) &&
    result.error.code === "RUN_ABORTED"
  );
}

export function toJsonValue(value: unknown): JsonValue {
  return (value ?? null) as JsonValue;
}

function parseToolResultOutput(content: string): ToolResultOutputLike {
  try {
    const parsed = JSON.parse(content);
    if (isRecord(parsed) && parsed.ok === false) {
      const parsedError = isRecord(parsed.error) ? parsed.error : null;
      const errorCode =
        parsedError && typeof parsedError.code === "string"
          ? parsedError.code
          : null;
      const errorMessage =
        parsedError && typeof parsedError.message === "string"
          ? parsedError.message
          : undefined;

      if (errorCode === "PERMISSION_DENIED") {
        return {
          type: "execution-denied",
          ...(errorMessage ? { reason: errorMessage } : {}),
        };
      }

      return { type: "error-json", value: toJsonValue(parsed) };
    }
    return { type: "json", value: toJsonValue(parsed) };
  } catch {
    return { type: "text", value: content };
  }
}

export function parseArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return {};

  try {
    const parsed = JSON.parse(raw || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function mapApiMessagesToModelMessages(messages: ApiMessage[]): ModelMessage[] {
  const toolNameById = new Map<string, string>();
  const mapped: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolNameById.set(tc.id, tc.function.name);
      }
    }

    if (msg.role === "system") {
      mapped.push({ role: "system", content: msg.content ?? "" });
      continue;
    }

    if (msg.role === "user") {
      const imgs = msg.attachments;
      if (imgs && imgs.length > 0) {
        const parts: Array<Record<string, unknown>> = [
          ...imgs.map((img) => ({
            type: "image",
            image: img.previewUrl,
            mimeType: img.mimeType,
          })),
          ...(msg.content ? [{ type: "text", text: msg.content }] : []),
        ];
        mapped.push({ role: "user", content: parts } as unknown as ModelMessage);
      } else {
        mapped.push({ role: "user", content: msg.content ?? "" });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const contentParts: Array<Record<string, unknown>> = [];

      if (msg.content) {
        contentParts.push({ type: "text", text: msg.content });
      }

      for (const tc of msg.tool_calls ?? []) {
        contentParts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: parseArgs(tc.function.arguments),
        });
      }

      if (contentParts.length === 0) {
        mapped.push({ role: "assistant", content: "" });
      } else if (
        contentParts.length === 1 &&
        contentParts[0].type === "text" &&
        typeof contentParts[0].text === "string"
      ) {
        mapped.push({ role: "assistant", content: contentParts[0].text });
      } else {
        mapped.push({
          role: "assistant",
          content: contentParts,
        } as ModelMessage);
      }
      continue;
    }

    const toolName = toolNameById.get(msg.tool_call_id) ?? "unknown_tool";
    const output = parseToolResultOutput(msg.content ?? "");
    mapped.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: msg.tool_call_id,
          toolName,
          output,
        },
      ],
    } as ModelMessage);
  }

  return mapped;
}

export function toApiToolCall(raw: unknown): ApiToolCall | null {
  if (!isRecord(raw)) return null;

  const id =
    typeof raw.toolCallId === "string"
      ? raw.toolCallId
      : typeof raw.id === "string"
        ? raw.id
        : null;
  const name =
    typeof raw.toolName === "string"
      ? raw.toolName
      : typeof raw.name === "string"
        ? raw.name
        : null;

  if (!id || !name) return null;

  let argsJson = "{}";
  if (typeof raw.input === "string") {
    argsJson = raw.input;
  } else if (raw.input !== undefined) {
    try {
      const serialized = JSON.stringify(raw.input);
      argsJson = typeof serialized === "string" ? serialized : "{}";
    } catch {
      argsJson = "{}";
    }
  } else if (typeof raw.arguments === "string") {
    argsJson = raw.arguments;
  } else if (raw.arguments !== undefined) {
    try {
      const serialized = JSON.stringify(raw.arguments);
      argsJson = typeof serialized === "string" ? serialized : "{}";
    } catch {
      argsJson = "{}";
    }
  }

  return {
    id,
    type: "function",
    function: {
      name,
      arguments: argsJson,
    },
  };
}

export function serializeSearchResultForModel(output: SearchFilesOutput): string {
  const { matches, truncated, matchCount, searchedFiles } = output;

  const header =
    `Found ${matchCount} match(es) in ${searchedFiles} file(s)` +
    (truncated ? " [TRUNCATED — not all results shown]" : "");

  if (matches.length === 0) return header;

  const lines: string[] = [header];

  let lastPath = "";
  for (const m of matches) {
    if (m.path !== lastPath) {
      lines.push("", m.path);
      lastPath = m.path;
    }
    const ctxBeforeStart = m.lineNumber - m.contextBefore.length;
    for (let i = 0; i < m.contextBefore.length; i++) {
      lines.push(`  ${ctxBeforeStart + i}- ${m.contextBefore[i]}`);
    }
    lines.push(`  ${m.lineNumber}: ${m.line}`);
    for (let i = 0; i < m.contextAfter.length; i++) {
      lines.push(`  ${m.lineNumber + 1 + i}- ${m.contextAfter[i]}`);
    }
  }

  return lines.join("\n");
}

export function serializeToolResultForModel(
  toolCallId: string,
  toolCalls: ApiToolCall[],
  result: unknown,
): string {
  const tc = toolCalls.find((t) => t.id === toolCallId);
  const toolName = tc?.function.name;

  if (
    toolName === "workspace_search" &&
    isRecord(result) &&
    result.ok === true &&
    isRecord(result.data)
  ) {
    return serializeSearchResultForModel(
      result.data as unknown as SearchFilesOutput,
    );
  }

  return JSON.stringify(result);
}

const SPECIAL_TOKEN_RE = /<\|[a-zA-Z0-9_\-]+\|>/g;

function sanitizeTextDelta(text: string): string {
  return text.replace(SPECIAL_TOKEN_RE, "");
}

export function streamDeltaPart(
  part: unknown,
  type: "text-delta" | "reasoning-delta",
): string | null {
  if (!isRecord(part) || part.type !== type) return null;
  const raw =
    typeof part.text === "string"
      ? part.text
      : typeof part.delta === "string"
        ? part.delta
        : typeof part.textDelta === "string"
          ? part.textDelta
          : null;
  return raw === null ? null : sanitizeTextDelta(raw);
}

export function streamPartError(part: unknown): unknown | null {
  if (!isRecord(part) || part.type !== "error") return null;
  if ("error" in part) return part.error;
  if ("errorText" in part) return part.errorText;
  return part;
}

export function attachStreamErrors(err: unknown, streamErrors: unknown[]): unknown {
  if (streamErrors.length === 0) return err;

  const serializedStreamErrors = streamErrors.map((item) =>
    serializeError(item),
  );

  if (err instanceof Error) {
    const enhanced = err as Error & {
      streamErrors?: unknown[];
      cause?: unknown;
    };

    try {
      enhanced.streamErrors = serializedStreamErrors;
      if (enhanced.cause === undefined) {
        enhanced.cause =
          serializedStreamErrors.length === 1
            ? serializedStreamErrors[0]
            : serializedStreamErrors;
      }
    } catch {
      // If the error object is not extensible, fall back to returning it as-is.
    }
    return enhanced;
  }

  return {
    error: serializeError(err),
    streamErrors: serializedStreamErrors,
  };
}

export function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    const result: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    if (err.stack) result.stack = err.stack;
    for (const key of Object.getOwnPropertyNames(err)) {
      if (key in result) continue;
      try {
        result[key] = (err as unknown as Record<string, unknown>)[key];
      } catch {
        // skip unreadable properties
      }
    }
    if ((err as Error & { cause?: unknown }).cause !== undefined) {
      result.cause = serializeError((err as Error & { cause?: unknown }).cause);
    }
    return result;
  }
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.parse(JSON.stringify(err));
    } catch {
      return String(err);
    }
  }
  return err;
}
