import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  FrontendLogInput,
  LogClearResult,
  LogContext,
  LogEntry,
  LogExportResult,
  LogQueryFilter,
} from "./types";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function nextRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  ).sort();
}

function jsonSafe(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const replacer = (_key: string, current: unknown): unknown => {
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "function") {
      return `[Function${current.name ? `: ${current.name}` : ""}]`;
    }
    if (current instanceof Error) {
      const error = current as Error & Record<string, unknown>;
      return {
        name: current.name,
        message: current.message,
        stack: current.stack,
        ...Object.fromEntries(Object.entries(error)),
      };
    }
    if (current && typeof current === "object") {
      if (seen.has(current as object)) return "[Circular]";
      seen.add(current as object);
      if (current instanceof Map) {
        return {
          __type: "Map",
          entries: Array.from(current.entries()),
        };
      }
      if (current instanceof Set) {
        return {
          __type: "Set",
          values: Array.from(current.values()),
        };
      }
    }
    return current;
  };

  try {
    return JSON.parse(JSON.stringify(value, replacer));
  } catch {
    return String(value);
  }
}

function consoleMethod(level: LogEntry["level"]): "debug" | "info" | "warn" | "error" {
  switch (level) {
    case "trace":
    case "debug":
      return "debug";
    case "warn":
      return "warn";
    case "error":
      return "error";
    default:
      return "info";
  }
}

export function nextLogId(prefix = "log"): string {
  return `${prefix}:${Date.now()}:${nextRandomId()}`;
}

export function nextTraceId(...parts: string[]): string {
  const normalized = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/[^a-zA-Z0-9:_-]+/g, "-"));
  return normalized.join(":") || `trace:${nextRandomId()}`;
}

export function createChildLogContext(
  parent: LogContext | undefined,
  overrides: Partial<LogContext> = {},
  depthStep = 1,
): LogContext {
  const depth = overrides.depth ?? (parent?.depth ?? 0) + depthStep;
  return {
    ...parent,
    ...overrides,
    depth,
  };
}

export function buildFrontendLogEntry(input: FrontendLogInput): LogEntry {
  const timestampMs = Date.now();
  const context = input.context ?? {};
  return {
    id: input.id ?? nextLogId("frontend"),
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    level: input.level ?? "info",
    source: "frontend",
    tags: normalizeTags(input.tags),
    event: input.event,
    message: input.message,
    ...(context.traceId ? { traceId: context.traceId } : {}),
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    ...(context.parentId ? { parentId: context.parentId } : {}),
    depth: context.depth ?? 0,
    kind: input.kind ?? "event",
    expandable: input.expandable ?? false,
    ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
    ...(input.data !== undefined ? { data: jsonSafe(input.data) } : {}),
  };
}

function writeToConsole(entry: LogEntry): void {
  const method = consoleMethod(entry.level);
  console[method](`[rakh][${entry.event}]`, entry.message, entry);
}

export async function writeLogEntry(entry: LogEntry): Promise<void> {
  if (!isTauriRuntime()) {
    writeToConsole(entry);
    return;
  }

  try {
    await invoke("logs_write", { entry });
  } catch (error) {
    console.error("rakh: failed to persist structured log entry", {
      error,
      entry,
    });
  }
}

export async function logFrontend(input: FrontendLogInput): Promise<LogEntry> {
  const entry = buildFrontendLogEntry(input);
  await writeLogEntry(entry);
  return entry;
}

export function logFrontendSoon(input: FrontendLogInput): void {
  void logFrontend(input);
}

export async function queryLogs(
  filter: LogQueryFilter = {},
): Promise<LogEntry[]> {
  if (!isTauriRuntime()) return [];
  return invoke<LogEntry[]>("logs_query", { filter });
}

export async function exportLogs(
  filter: LogQueryFilter = {},
): Promise<LogExportResult | null> {
  if (!isTauriRuntime()) return null;
  return invoke<LogExportResult>("logs_export", { filter });
}

export async function clearLogs(): Promise<LogClearResult> {
  if (!isTauriRuntime()) {
    return { removedFiles: 0 };
  }
  return invoke<LogClearResult>("logs_clear");
}

export async function listenForLogEntries(
  handler: (entry: LogEntry) => void,
): Promise<UnlistenFn | null> {
  if (!isTauriRuntime()) return null;
  return listen<LogEntry>("log_entry", (event) => {
    handler(event.payload);
  });
}
