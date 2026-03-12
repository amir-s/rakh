export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type LogSource = "backend" | "frontend";
export type LogKind = "start" | "end" | "event" | "error";
export type TagMode = "and" | "or";

export interface LogContext {
  sessionId?: string;
  tabId?: string;
  traceId?: string;
  correlationId?: string;
  parentId?: string;
  depth?: number;
  agentId?: string;
  toolName?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  timestampMs: number;
  level: LogLevel;
  source: LogSource;
  tags: string[];
  event: string;
  message: string;
  traceId?: string;
  correlationId?: string;
  parentId?: string;
  depth: number;
  kind: LogKind;
  expandable: boolean;
  durationMs?: number;
  data?: unknown;
}

export interface LogQueryFilter {
  tags?: string[];
  tagMode?: TagMode;
  levels?: LogLevel[];
  traceId?: string;
  correlationId?: string;
  source?: LogSource;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
}

export interface LogExportResult {
  path: string;
  count: number;
}

export interface LogClearResult {
  removedFiles: number;
}

export interface FrontendLogInput {
  id?: string;
  level?: LogLevel;
  tags: string[];
  event: string;
  message: string;
  kind?: LogKind;
  expandable?: boolean;
  durationMs?: number;
  data?: unknown;
  context?: LogContext;
}
