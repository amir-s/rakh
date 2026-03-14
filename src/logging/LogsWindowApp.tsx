import {
  useCallback,
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Badge, Button, IconButton, TextField } from "@/components/ui";
import { cn } from "@/utils/cn";
import { exportLogs, listenForLogEntries, queryLogs } from "./client";
import type {
  LogTag,
  LogEntry,
  LogLevel,
  LogQueryFilter,
  LogSource,
} from "./types";
import { KNOWN_LOG_TAGS } from "./types";
import LogJsonTree from "./LogJsonTree";
import {
  DEFAULT_LOG_LIMIT,
  LOG_WINDOW_NAVIGATE_EVENT,
  type LogWindowNavigatePayload,
  normalizeLogNavigatePayload,
} from "./window";

const MAX_WINDOW_ENTRIES = 1000;
const LIVE_FLUSH_MS = 75;
const SCROLL_TAIL_THRESHOLD_PX = 28;
const VERBOSITY_LEVELS: LogLevel[] = [
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];
const SOURCE_OPTIONS: LogSource[] = ["backend", "frontend"];
const LIMIT_OPTIONS = [100, 250, 500, 1000];
const NOTICE_AUTO_CLOSE_MS = 3500;
const COPY_FEEDBACK_MS = 2200;

type ViewerNotice = {
  id: number;
  kind: "success" | "error";
  message: string;
  autoCloseMs: number | null;
} | null;

interface ControlState {
  tagStates: Partial<Record<string, "include" | "exclude">>;
  verbosity: LogLevel;
  source: LogSource | "";
  traceId: string;
  correlationId: string;
  sinceMs: number | null;
  limit: number;
}

interface LogTreeNode {
  entry: LogEntry;
  children: LogTreeNode[];
}

interface InlineTokenFilterControlProps {
  label: string;
  value: string;
  placeholder: string;
  addLabel: string;
  badgePrefix: string;
  onChange: (next: string) => void;
  className?: string;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LOG_LIMIT;
  return Math.max(1, Math.min(MAX_WINDOW_ENTRIES, Math.floor(limit)));
}

function normalizeTags(tags: readonly LogTag[] | undefined): LogTag[] {
  return Array.from(
    new Set(
      (tags ?? [])
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  ).sort();
}

function tagStateMap(filter: LogQueryFilter): ControlState["tagStates"] {
  const states: ControlState["tagStates"] = {};
  for (const tag of normalizeTags(filter.tags)) {
    states[tag] = "include";
  }
  for (const tag of normalizeTags(filter.excludeTags)) {
    states[tag] = "exclude";
  }
  return states;
}

function nextTagState(
  current: ControlState["tagStates"],
  tag: LogTag,
): "include" | "exclude" | "ignore" {
  switch (current[tag]) {
    case "include":
      return "exclude";
    case "exclude":
      return "ignore";
    default:
      return "include";
  }
}

function applyTagState(
  current: ControlState["tagStates"],
  tag: LogTag,
  next: "include" | "exclude" | "ignore",
): ControlState["tagStates"] {
  const normalizedTag = tag.trim().toLowerCase();
  const updated = { ...current };
  if (next === "ignore") {
    delete updated[normalizedTag];
    return updated;
  }
  updated[normalizedTag] = next;
  return updated;
}

function tagListsFromStates(states: ControlState["tagStates"]): {
  included: LogTag[];
  excluded: LogTag[];
} {
  const included: LogTag[] = [];
  const excluded: LogTag[] = [];
  for (const [tag, state] of Object.entries(states)) {
    if (state === "include") included.push(tag);
    if (state === "exclude") excluded.push(tag);
  }
  included.sort();
  excluded.sort();
  return { included, excluded };
}

function levelsForVerbosity(verbosity: LogLevel): LogLevel[] {
  return VERBOSITY_LEVELS.slice(0, VERBOSITY_LEVELS.indexOf(verbosity) + 1);
}

function verbosityFromLevels(levels: LogLevel[] | undefined): LogLevel {
  if (!levels || levels.length === 0) return "trace";
  const normalized = [...new Set(levels)].sort(
    (left, right) =>
      VERBOSITY_LEVELS.indexOf(left) - VERBOSITY_LEVELS.indexOf(right),
  );
  for (const candidate of VERBOSITY_LEVELS) {
    const candidateLevels = levelsForVerbosity(candidate);
    if (
      candidateLevels.length === normalized.length &&
      candidateLevels.every((level, index) => normalized[index] === level)
    ) {
      return candidate;
    }
  }
  const maxIndex = normalized.reduce((highest, level) => {
    return Math.max(highest, VERBOSITY_LEVELS.indexOf(level));
  }, 0);
  return VERBOSITY_LEVELS[Math.max(0, maxIndex)] ?? "trace";
}

function verbositySummary(verbosity: LogLevel): string {
  switch (verbosity) {
    case "error":
      return "Errors only";
    case "warn":
      return "Warn+";
    case "info":
      return "Info+";
    case "debug":
      return "Debug+";
    case "trace":
      return "Trace";
  }
}

function levelSymbol(level: LogLevel): string {
  switch (level) {
    case "trace":
      return "T";
    case "debug":
      return "D";
    case "info":
      return "I";
    case "warn":
      return "W";
    case "error":
      return "E";
  }
}

function nextVerbosityLevel(current: LogLevel): LogLevel {
  const currentIndex = VERBOSITY_LEVELS.indexOf(current);
  return (
    VERBOSITY_LEVELS[(currentIndex + 1) % VERBOSITY_LEVELS.length] ?? "error"
  );
}

function nextSourceFilter(
  current: LogSource | "",
  source: LogSource,
): LogSource | "" {
  return current === source ? "" : source;
}

function controlsFromPayload(
  payload: LogWindowNavigatePayload | null,
): ControlState {
  const normalized = payload
    ? normalizeLogNavigatePayload(payload)
    : {
        filter: { limit: DEFAULT_LOG_LIMIT },
        origin: "manual" as const,
        tailEnabled: true,
      };
  const filter = normalized.filter;
  return {
    tagStates: tagStateMap(filter),
    verbosity: verbosityFromLevels(filter.levels),
    source: filter.source ?? "",
    traceId: filter.traceId ?? "",
    correlationId: filter.correlationId ?? "",
    sinceMs: null,
    limit: normalizeLimit(filter.limit ?? DEFAULT_LOG_LIMIT),
  };
}

function buildQueryFilter(controls: ControlState): LogQueryFilter {
  const { included, excluded } = tagListsFromStates(controls.tagStates);
  return {
    ...(included.length > 0 ? { tags: included } : {}),
    ...(excluded.length > 0 ? { excludeTags: excluded } : {}),
    ...(controls.verbosity !== "trace"
      ? { levels: levelsForVerbosity(controls.verbosity) }
      : {}),
    ...(controls.source ? { source: controls.source } : {}),
    ...(controls.traceId.trim() ? { traceId: controls.traceId.trim() } : {}),
    ...(controls.correlationId.trim()
      ? { correlationId: controls.correlationId.trim() }
      : {}),
    ...(typeof controls.sinceMs === "number"
      ? { sinceMs: controls.sinceMs }
      : {}),
    limit: normalizeLimit(controls.limit),
  };
}

function formatTimestamp(timestampMs: number): string {
  try {
    return new Date(timestampMs).toLocaleString([], {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(timestampMs);
  }
}

function formatCompactTimestamp(timestampMs: number): string {
  try {
    return new Date(timestampMs).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(timestampMs);
  }
}

function sortEntriesAscending(entries: LogEntry[]): LogEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.timestampMs - right.timestampMs || left.id.localeCompare(right.id),
  );
}

function mergeEntries(
  baseEntries: LogEntry[],
  liveEntries: LogEntry[],
  limit: number,
): LogEntry[] {
  const byId = new Map<string, LogEntry>();
  for (const entry of baseEntries) byId.set(entry.id, entry);
  for (const entry of liveEntries) byId.set(entry.id, entry);

  return sortEntriesAscending(Array.from(byId.values())).slice(
    -Math.min(MAX_WINDOW_ENTRIES, normalizeLimit(limit)),
  );
}

function matchesFilter(entry: LogEntry, filter: LogQueryFilter): boolean {
  if (filter.source && entry.source !== filter.source) return false;
  if (filter.levels && filter.levels.length > 0) {
    if (!filter.levels.includes(entry.level)) return false;
  }
  if (filter.traceId && entry.traceId !== filter.traceId) return false;
  if (filter.correlationId && entry.correlationId !== filter.correlationId) {
    return false;
  }
  if (
    typeof filter.sinceMs === "number" &&
    entry.timestampMs < filter.sinceMs
  ) {
    return false;
  }
  if (
    typeof filter.untilMs === "number" &&
    entry.timestampMs > filter.untilMs
  ) {
    return false;
  }
  if (filter.excludeTags && filter.excludeTags.length > 0) {
    if (filter.excludeTags.some((tag) => entry.tags.includes(tag))) {
      return false;
    }
  }
  if (!filter.tags || filter.tags.length === 0) return true;
  const mode = filter.tagMode ?? "or";
  return mode === "and"
    ? filter.tags.every((tag) => entry.tags.includes(tag))
    : filter.tags.some((tag) => entry.tags.includes(tag));
}

function normalizeSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function searchableEntryText(entry: LogEntry): string {
  return [
    entry.id,
    entry.timestamp,
    String(entry.timestampMs),
    entry.level,
    entry.source,
    entry.tags.join(" "),
    entry.event,
    entry.message,
    entry.traceId ?? "",
    entry.correlationId ?? "",
    entry.parentId ?? "",
    String(entry.depth),
    entry.kind,
    typeof entry.durationMs === "number" ? String(entry.durationMs) : "",
    entry.data !== undefined ? safePrettyJson(entry.data) : "",
  ]
    .join("\n")
    .toLocaleLowerCase();
}

function filterEntriesBySearch(
  entries: LogEntry[],
  searchQuery: string,
): LogEntry[] {
  const normalizedQuery = normalizeSearchQuery(searchQuery);
  if (!normalizedQuery) return entries;
  return entries.filter((entry) =>
    searchableEntryText(entry).includes(normalizedQuery),
  );
}

function levelVariant(
  level: LogLevel,
): "muted" | "primary" | "info" | "warning" | "danger" {
  switch (level) {
    case "trace":
      return "muted";
    case "debug":
      return "primary";
    case "info":
      return "info";
    case "warn":
      return "warning";
    case "error":
      return "danger";
  }
}

function kindVariant(
  kind: LogEntry["kind"],
): "muted" | "primary" | "success" | "danger" {
  switch (kind) {
    case "start":
      return "primary";
    case "end":
      return "success";
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

function kindDisplayLabel(kind: LogEntry["kind"]): string {
  switch (kind) {
    case "start":
      return "↗";
    case "end":
      return "↘";
    case "event":
      return "•";
    case "error":
      return "!";
    default:
      return kind satisfies never;
  }
}

function safePrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through.
  }

  try {
    const element = document.createElement("textarea");
    element.value = text;
    element.style.position = "fixed";
    element.style.left = "-9999px";
    document.body.appendChild(element);
    element.focus();
    element.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(element);
    return copied;
  } catch {
    return false;
  }
}

function buildTree(entries: LogEntry[]): LogTreeNode[] {
  const nodes = new Map<string, LogTreeNode>();
  const roots: LogTreeNode[] = [];

  for (const entry of entries) {
    nodes.set(entry.id, { entry, children: [] });
  }

  for (const entry of entries) {
    const node = nodes.get(entry.id);
    if (!node) continue;
    if (entry.parentId && nodes.has(entry.parentId)) {
      nodes.get(entry.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (items: LogTreeNode[]) => {
    items.sort(
      (left, right) =>
        left.entry.timestampMs - right.entry.timestampMs ||
        left.entry.id.localeCompare(right.entry.id),
    );
    for (const item of items) {
      if (item.children.length > 0) {
        sortNodes(item.children);
      }
    }
  };
  sortNodes(roots);
  return roots;
}

function activeFilterCount(filter: LogQueryFilter): number {
  return [
    filter.tags && filter.tags.length > 0 ? 1 : 0,
    filter.excludeTags && filter.excludeTags.length > 0 ? 1 : 0,
    filter.levels && filter.levels.length > 0 ? 1 : 0,
    filter.source ? 1 : 0,
    filter.traceId ? 1 : 0,
    filter.correlationId ? 1 : 0,
    typeof filter.sinceMs === "number" ? 1 : 0,
    typeof filter.untilMs === "number" ? 1 : 0,
  ].reduce((sum, count) => sum + count, 0);
}

function visibleTagPills(filter: LogQueryFilter): LogTag[] {
  const selected = new Set([
    ...normalizeTags(filter.tags),
    ...normalizeTags(filter.excludeTags),
  ]);
  const extras = Array.from(selected)
    .filter(
      (tag) => !KNOWN_LOG_TAGS.includes(tag as (typeof KNOWN_LOG_TAGS)[number]),
    )
    .sort();
  return [...KNOWN_LOG_TAGS, ...extras];
}

function ViewModeBadge({
  isTreeView,
  limit,
}: {
  isTreeView: boolean;
  limit: number;
}) {
  const title = isTreeView
    ? "Grouped by trace lineage"
    : `Showing up to ${limit} rows`;
  const label = isTreeView ? "TRACE" : "LIVE";
  const isLive = !isTreeView;
  return (
    <Badge
      variant="muted"
      aria-label={
        isTreeView ? "Trace tree view" : `Live feed up to ${limit} rows`
      }
      title={title}
    >
      <span
        aria-hidden="true"
        className="material-symbols-outlined text-md leading-none"
      >
        {isTreeView ? "account_tree" : "view_list"}
      </span>
      <span>{label}</span>
      {isLive ? (
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-md leading-none text-red-500 animate-pulse"
        >
          screen_record
        </span>
      ) : null}
    </Badge>
  );
}

function NoticeToast({
  notice,
  onDismiss,
}: {
  notice: Exclude<ViewerNotice, null>;
  onDismiss: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div
        role={notice.kind === "error" ? "alert" : "status"}
        className={cn(
          "pointer-events-auto flex w-full max-w-[560px] items-start gap-3 rounded-2xl border px-4 py-3 shadow-[0_16px_40px_rgb(0_0_0_/_0.18)] backdrop-blur",
          notice.kind === "error"
            ? "border-[color-mix(in_srgb,var(--color-error)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_10%,var(--color-surface))] text-error"
            : "border-[color-mix(in_srgb,var(--color-success)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-success)_10%,var(--color-surface))] text-success",
        )}
      >
        <span
          aria-hidden="true"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current/20 text-[12px] font-bold"
        >
          {notice.kind === "error" ? "!" : "i"}
        </span>
        <div className="min-w-0 flex-1 text-sm leading-5 text-text">
          {notice.message}
        </div>
        <button
          type="button"
          aria-label="Dismiss notice"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current/15 text-[11px] text-current transition-colors hover:bg-current/10"
          onClick={onDismiss}
        >
          X
        </button>
      </div>
    </div>
  );
}

function tagPillVisual(state: "include" | "exclude" | "ignore"): {
  icon: string;
  className: string;
  description: string;
} {
  switch (state) {
    case "include":
      return {
        icon: "+",
        className:
          "border-[color-mix(in_srgb,var(--color-success)_32%,transparent)] bg-[color-mix(in_srgb,var(--color-success)_16%,transparent)] text-success",
        description: "included",
      };
    case "exclude":
      return {
        icon: "−",
        className:
          "border-[color-mix(in_srgb,var(--color-error)_34%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_16%,transparent)] text-error",
        description: "excluded",
      };
    default:
      return {
        icon: "•",
        className: "border-border-subtle bg-surface text-muted hover:text-text",
        description: "ignored",
      };
  }
}

function TagStatePill({
  tag,
  state,
  onCycle,
}: {
  tag: LogTag;
  state: "include" | "exclude" | "ignore";
  onCycle: (tag: LogTag) => void;
}) {
  const visual = tagPillVisual(state);
  return (
    <button
      type="button"
      aria-label={`Tag filter ${tag}: ${visual.description}`}
      title={`${tag} (${visual.description})`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
        visual.className,
      )}
      onClick={() => onCycle(tag)}
    >
      <span aria-hidden="true" className="text-[12px] leading-none">
        {visual.icon}
      </span>
      <span>{tag}</span>
    </button>
  );
}

function VerbosityPillControl({
  value,
  onChange,
}: {
  value: LogLevel;
  onChange: (next: LogLevel) => void;
}) {
  const selectedIndex = VERBOSITY_LEVELS.indexOf(value);
  const symbol = levelSymbol(value);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={`Cycle verbosity, current ${value}`}
        title={`Verbosity ${selectedIndex + 1}/${VERBOSITY_LEVELS.length} · ${verbositySummary(value)}`}
        className="inline-flex w-[96px] shrink-0 items-center gap-2 rounded-full border border-border-subtle bg-surface px-3 py-1.5 font-mono text-[11px] text-text transition-colors hover:border-primary/30 hover:bg-inset/50"
        onClick={() => onChange(nextVerbosityLevel(value))}
      >
        <span className="font-bold">{selectedIndex + 1}</span>
        <span aria-hidden="true" className="text-muted">
          /
        </span>
        <span className="font-bold">{symbol}</span>
        <span className="min-w-0 truncate lowercase">{value}</span>
      </button>
    </div>
  );
}

function SourceControl({
  value,
  onChange,
}: {
  value: LogSource | "";
  onChange: (next: LogSource | "") => void;
}) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <div className="flex items-center gap-2">
        {SOURCE_OPTIONS.map((source) => {
          const selected = value === source;
          return (
            <button
              key={source}
              type="button"
              aria-label={`Source filter ${source}`}
              aria-pressed={selected}
              title={
                selected
                  ? `Showing only ${source} logs. Click to include both sources.`
                  : `Show only ${source} logs.`
              }
              className={cn(
                "inline-flex items-center rounded-full border px-3 py-1.5 font-mono text-[11px] lowercase transition-colors",
                selected
                  ? "border-primary bg-primary-dim text-primary"
                  : "border-border-subtle bg-surface text-muted hover:border-primary/30 hover:text-text",
              )}
              onClick={() => onChange(nextSourceFilter(value, source))}
            >
              {source}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RowLimitControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (containerRef.current?.contains(event.target)) return;
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Row limit ${value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Row limit ${value}`}
        className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface px-3 py-1.5 font-mono text-[11px] text-text transition-colors hover:border-primary/30 hover:bg-inset/50"
        onClick={() => setOpen((current) => !current)}
      >
        <span
          aria-hidden="true"
          className="inline-flex h-4 w-4 items-center justify-center text-muted"
        >
          <svg
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M3 4h10" />
            <path d="M3 8h10" />
            <path d="M3 12h10" />
          </svg>
        </span>
        <span>{value}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Row limit options"
          className="absolute right-0 top-full z-20 mt-2 w-24 rounded-xl border border-border-subtle bg-surface p-2 shadow-[0_12px_30px_rgb(0_0_0_/_0.18)]"
        >
          <div className="flex flex-col gap-1">
            {LIMIT_OPTIONS.map((option) => {
              const selected = option === value;
              return (
                <button
                  key={option}
                  type="button"
                  aria-label={`Set row limit ${option}`}
                  className={cn(
                    "rounded-lg px-2 py-1 text-left text-xs transition-colors",
                    selected
                      ? "bg-primary-dim text-primary"
                      : "bg-inset text-text hover:bg-primary-dim hover:text-primary",
                  )}
                  onClick={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                >
                  {option}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SinceFilterPill({
  sinceMs,
  onClear,
}: {
  sinceMs: number;
  onClear: () => void;
}) {
  const compactTimestamp = formatCompactTimestamp(sinceMs);
  const fullTimestamp = formatTimestamp(sinceMs);

  return (
    <span
      className="inline-flex max-w-full gap-2 rounded-full border border-primary/30 bg-primary-dim px-2.5 py-1 font-mono text-[11px] text-primary"
      title={`Showing only logs after ${fullTimestamp}`}
    >
      <span className="min-w-0 truncate">since {compactTimestamp}</span>
      <button
        type="button"
        aria-label="Remove clear timestamp filter"
        title="Remove clear timestamp filter"
        className="cursor-pointer hover:text-error"
        onClick={onClear}
      >
        <span aria-hidden="true" className="material-symbols-outlined">
          close
        </span>
      </button>
    </span>
  );
}

function InlineTokenFilterControl({
  label,
  value,
  placeholder,
  addLabel,
  badgePrefix,
  onChange,
  className,
}: InlineTokenFilterControlProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (containerRef.current?.contains(event.target)) return;
      setOpen(false);
      setDraft("");
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setDraft("");
    };

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const applyDraft = () => {
    const next = draft.trim();
    if (!next) return;
    onChange(next);
    setOpen(false);
    setDraft("");
  };

  const clearValue = () => {
    onChange("");
    setOpen(false);
    setDraft("");
  };

  return (
    <div ref={containerRef} className={cn("relative min-w-0", className)}>
      {value ? (
        <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-primary/30 bg-primary-dim px-2.5 py-1 font-mono text-[11px] text-primary">
          <span className="min-w-0 truncate">
            {badgePrefix}: {value}
          </span>
          <button
            type="button"
            aria-label={`Remove ${label.toLowerCase()} filter`}
            title={`Remove ${label.toLowerCase()} filter`}
            className="cursor-pointer hover:text-error"
            onClick={clearValue}
          >
            <span aria-hidden="true" className="material-symbols-outlined">
              close
            </span>
          </button>
        </span>
      ) : (
        <>
          <button
            type="button"
            aria-label={`Add ${label.toLowerCase()} filter`}
            aria-expanded={open}
            className={cn(
              "inline-flex max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[11px] transition-colors",
              open
                ? "border-primary bg-primary-dim text-primary"
                : "border-border-subtle bg-surface text-muted hover:border-primary/30 hover:text-text",
            )}
            onClick={() => {
              setDraft("");
              setOpen((current) => !current);
            }}
          >
            {addLabel}
          </button>
          {open ? (
            <div
              role="dialog"
              aria-label={`${label} filter input`}
              className="absolute left-0 top-full z-20 mt-2 w-[280px] rounded-xl border border-border-subtle bg-surface p-2 shadow-[0_12px_30px_rgb(0_0_0_/_0.18)]"
            >
              <div className="flex flex-col gap-2">
                <TextField
                  ref={inputRef}
                  aria-label={label}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyDraft();
                    }
                  }}
                  placeholder={placeholder}
                />
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="xxs"
                    onClick={() => {
                      setOpen(false);
                      setDraft("");
                    }}
                  >
                    CANCEL
                  </Button>
                  <Button
                    variant="primary"
                    size="xxs"
                    disabled={draft.trim().length === 0}
                    onClick={applyDraft}
                  >
                    ADD
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

interface LogEntryRowProps {
  entry: LogEntry;
  expanded: boolean;
  onToggleExpanded: () => void;
  includedTags: Set<string>;
  excludedTags: Set<string>;
  onTagAction: (tag: string, mode: "include" | "exclude") => void;
  onTraceIdAction: (traceId: string) => void;
  onCorrelationIdAction: (correlationId: string) => void;
  activeTraceId?: string;
  activeCorrelationId?: string;
  depth?: number;
}

function LogTokenFilterChip({
  prefix,
  value,
  active,
  onActivate,
}: {
  prefix: "trace" | "tool";
  value: string;
  active: boolean;
  onActivate?: (value: string) => void;
}) {
  const className = cn(
    "font-mono text-[11px] break-all",
    active
      ? "border-b border-dashed border-primary/70 pb-px text-muted"
      : onActivate
        ? "rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-text transition-colors hover:border-primary/30 hover:bg-inset/50"
        : "text-muted",
  );

  if (!onActivate) {
    return (
      <span className={className}>
        {prefix}: {value}
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={`Add ${prefix} filter ${value}`}
      title={`Filter by ${prefix} id ${value}`}
      className={className}
      onClick={(event) => {
        event.stopPropagation();
        onActivate(value);
      }}
    >
      {prefix}: {value}
    </button>
  );
}

function LogTagChip({
  tag,
  included,
  excluded,
  onAction,
}: {
  tag: string;
  included: boolean;
  excluded: boolean;
  onAction: (tag: string, mode: "include" | "exclude") => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    if (!menuOpen) return;

    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPosition({
        top: Math.min(window.innerHeight - 88, rect.bottom + 6),
        left: Math.min(window.innerWidth - 156, Math.max(8, rect.left)),
      });
    };

    const handlePointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (buttonRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const menu =
    menuOpen && menuPosition
      ? createPortal(
          <div
            ref={menuRef}
            role="dialog"
            aria-label={`Tag filter actions for ${tag}`}
            className="fixed z-50 w-36 rounded-xl border border-border-subtle bg-surface p-2 shadow-[0_12px_30px_rgb(0_0_0_/_0.18)]"
            style={{
              top: `${menuPosition.top}px`,
              left: `${menuPosition.left}px`,
            }}
          >
            <div className="mb-2 text-[10px] uppercase tracking-[0.06em] text-muted">
              {included ? "Included" : excluded ? "Excluded" : "Filter tag"}
            </div>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                className={cn(
                  "rounded-lg px-2 py-1 text-left text-xs transition-colors",
                  included
                    ? "bg-primary-dim text-primary"
                    : "bg-inset text-text hover:bg-primary-dim hover:text-primary",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onAction(tag, "include");
                  setMenuOpen(false);
                }}
              >
                INCLUDE
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-lg px-2 py-1 text-left text-xs transition-colors",
                  excluded
                    ? "bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)] text-error"
                    : "bg-inset text-text hover:bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)] hover:text-error",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onAction(tag, "exclude");
                  setMenuOpen(false);
                }}
              >
                EXCLUDE
              </button>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-label={`Filter options for tag ${tag}`}
        className={cn(
          "rounded-full border px-2 py-0.5 font-mono transition-colors",
          included
            ? "border-primary bg-primary-dim text-primary"
            : excluded
              ? "border-[color-mix(in_srgb,var(--color-error)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)] text-error"
              : "border-transparent bg-inset text-text hover:border-border-subtle",
        )}
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen((current) => !current);
        }}
      >
        {tag}
      </button>
      {menu}
    </>
  );
}

function LogEntryRow({
  entry,
  expanded,
  onToggleExpanded,
  includedTags,
  excludedTags,
  onTagAction,
  onTraceIdAction,
  onCorrelationIdAction,
  activeTraceId,
  activeCorrelationId,
  depth = 0,
}: LogEntryRowProps) {
  const hasDetails = entry.data !== undefined || entry.expandable;
  const detailIndicatorIcon =
    entry.data !== undefined
      ? "data_object"
      : expanded
        ? "unfold_less"
        : "unfold_more";
  const [copyFeedbackToken, setCopyFeedbackToken] = useState(0);
  const copied = copyFeedbackToken > 0;
  const traceMatchesFilter =
    typeof activeTraceId === "string" &&
    activeTraceId.length > 0 &&
    entry.traceId === activeTraceId;
  const correlationMatchesFilter =
    typeof activeCorrelationId === "string" &&
    activeCorrelationId.length > 0 &&
    entry.correlationId === activeCorrelationId;
  const canFilterTrace =
    typeof entry.traceId === "string" &&
    entry.traceId.length > 0 &&
    (!activeTraceId || activeTraceId.length === 0);
  const canFilterCorrelation =
    typeof entry.correlationId === "string" &&
    entry.correlationId.length > 0 &&
    (!activeCorrelationId || activeCorrelationId.length === 0);
  const leftOffset = Math.min(depth, 8) * 14;
  const markerBadgeClass =
    "h-7 w-7 justify-center px-0 text-center font-mono leading-none";

  const handleSummaryClick = () => {
    if (hasDetails) {
      onToggleExpanded();
    }
  };

  useEffect(() => {
    if (copyFeedbackToken === 0) return;
    const timeoutId = window.setTimeout(() => {
      setCopyFeedbackToken((current) =>
        current === copyFeedbackToken ? 0 : current,
      );
    }, COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timeoutId);
  }, [copyFeedbackToken]);

  const handleCopyClick = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const didCopy = await copyToClipboard(safePrettyJson(entry));
    if (didCopy) {
      setCopyFeedbackToken((current) => current + 1);
    }
  };

  return (
    <div
      className={cn(
        "rounded-xl border border-border-subtle bg-surface transition-[border-color,background-color,box-shadow] duration-150",
        "hover:border-primary/30 hover:bg-inset/25 hover:shadow-[0_8px_20px_rgb(0_0_0_/_0.08)]",
        expanded ? "border-primary/35 bg-inset/20" : null,
      )}
      style={{ marginLeft: leftOffset }}
    >
      <div
        role={hasDetails ? "button" : undefined}
        tabIndex={hasDetails ? 0 : undefined}
        aria-label={
          hasDetails
            ? `${expanded ? "Collapse" : "Expand"} log row ${entry.id}`
            : undefined
        }
        className={cn(
          "flex items-start gap-2.5 px-2.5 py-2",
          hasDetails
            ? "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
            : null,
        )}
        onClick={handleSummaryClick}
        onKeyDown={(event) => {
          if (!hasDetails) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggleExpanded();
          }
        }}
      >
        <div className="shrink-0 flex flex-col gap-1">
          <Badge
            variant={levelVariant(entry.level)}
            aria-label={`Level ${entry.level}`}
            title={entry.level.toUpperCase()}
            className={markerBadgeClass}
          >
            {levelSymbol(entry.level)}
          </Badge>
          <Badge
            variant={kindVariant(entry.kind)}
            aria-label={entry.kind}
            title={entry.kind}
            className={markerBadgeClass}
          >
            {kindDisplayLabel(entry.kind)}
          </Badge>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <span>{formatTimestamp(entry.timestampMs)}</span>
            <span>{entry.source}</span>
            <span className="rounded-md bg-inset px-1.5 py-0.5 font-mono break-all text-[10px]">
              {entry.event}
            </span>
            {entry.tags.map((tag) => (
              <LogTagChip
                key={`${entry.id}:${tag}`}
                tag={tag}
                included={includedTags.has(tag)}
                excluded={excludedTags.has(tag)}
                onAction={onTagAction}
              />
            ))}
          </div>
          <div className="mt-0.5 text-[13px] leading-5 text-text warp-break-words">
            {entry.message}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {entry.traceId ? (
              <LogTokenFilterChip
                prefix="trace"
                value={entry.traceId}
                active={traceMatchesFilter}
                onActivate={canFilterTrace ? onTraceIdAction : undefined}
              />
            ) : null}
            {entry.correlationId ? (
              <LogTokenFilterChip
                prefix="tool"
                value={entry.correlationId}
                active={correlationMatchesFilter}
                onActivate={
                  canFilterCorrelation ? onCorrelationIdAction : undefined
                }
              />
            ) : null}
            {typeof entry.durationMs === "number" ? (
              <span className="font-mono text-[11px] text-muted">
                {entry.durationMs}ms
              </span>
            ) : null}
          </div>
        </div>

        <div className="shrink-0 flex items-start gap-1 self-start pt-0.5">
          <IconButton
            aria-label={"View details of log row"}
            title={
              entry.data !== undefined
                ? expanded
                  ? "Structured data shown below"
                  : "Structured data available"
                : expanded
                  ? "Details expanded"
                  : "Details available"
            }
            className={cn(expanded && "text-primary!")}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {detailIndicatorIcon}
            </span>
          </IconButton>

          <IconButton
            aria-label={
              copied
                ? `Copied log row ${entry.id} JSON`
                : `Copy log row ${entry.id} JSON`
            }
            title={copied ? "Row JSON copied" : "Copy row JSON"}
            className={cn(
              copied &&
                "border-[color-mix(in_srgb,var(--color-success)_34%,transparent)]! bg-[color-mix(in_srgb,var(--color-success)_16%,transparent)]! text-success!",
            )}
            onClick={(event) => {
              void handleCopyClick(event);
            }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {copied ? "check" : "content_copy"}
            </span>
          </IconButton>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-border-subtle bg-inset/60 px-2.5 py-2.5">
          <div className="grid gap-2.5 md:grid-cols-2">
            <div className="rounded-lg border border-border-subtle bg-surface p-2.5">
              <div className="text-xxs font-bold tracking-[0.06em] uppercase text-muted">
                Metadata
              </div>
              <div className="mt-2 space-y-1 text-xs leading-5 text-text">
                <div>
                  <span className="text-muted">id</span>:{" "}
                  <span className="font-mono break-all">{entry.id}</span>
                </div>
                <div>
                  <span className="text-muted">depth</span>: {entry.depth}
                </div>
                {entry.parentId ? (
                  <div>
                    <span className="text-muted">parent</span>:{" "}
                    <span className="font-mono break-all">
                      {entry.parentId}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            {entry.data !== undefined ? (
              <div className="rounded-lg border border-border-subtle bg-surface p-2.5">
                <div className="text-xxs font-bold tracking-[0.06em] uppercase text-muted">
                  Data
                </div>
                <div className="mt-2 overflow-x-auto">
                  <LogJsonTree value={entry.data} />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LogTree({
  nodes,
  expandedIds,
  onToggleExpanded,
  includedTags,
  excludedTags,
  onTagAction,
  onTraceIdAction,
  onCorrelationIdAction,
  activeTraceId,
  activeCorrelationId,
}: {
  nodes: LogTreeNode[];
  expandedIds: Set<string>;
  onToggleExpanded: (entryId: string) => void;
  includedTags: Set<string>;
  excludedTags: Set<string>;
  onTagAction: (tag: string, mode: "include" | "exclude") => void;
  onTraceIdAction: (traceId: string) => void;
  onCorrelationIdAction: (correlationId: string) => void;
  activeTraceId?: string;
  activeCorrelationId?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      {nodes.map((node) => (
        <div key={node.entry.id} className="flex flex-col gap-3">
          <LogEntryRow
            entry={node.entry}
            depth={node.entry.depth}
            expanded={expandedIds.has(node.entry.id)}
            onToggleExpanded={() => onToggleExpanded(node.entry.id)}
            includedTags={includedTags}
            excludedTags={excludedTags}
            onTagAction={onTagAction}
            onTraceIdAction={onTraceIdAction}
            onCorrelationIdAction={onCorrelationIdAction}
            activeTraceId={activeTraceId}
            activeCorrelationId={activeCorrelationId}
          />
          {node.children.length > 0 ? (
            <div className="flex flex-col gap-3">
              <LogTree
                nodes={node.children}
                expandedIds={expandedIds}
                onToggleExpanded={onToggleExpanded}
                includedTags={includedTags}
                excludedTags={excludedTags}
                onTagAction={onTagAction}
                onTraceIdAction={onTraceIdAction}
                onCorrelationIdAction={onCorrelationIdAction}
                activeTraceId={activeTraceId}
                activeCorrelationId={activeCorrelationId}
              />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default function LogsWindowApp({
  initialPayload,
}: {
  initialPayload: LogWindowNavigatePayload | null;
}) {
  const initialControls = useMemo(
    () => controlsFromPayload(initialPayload),
    [initialPayload],
  );
  const [controls, setControls] = useState<ControlState>(initialControls);
  const [tailEnabled, setTailEnabled] = useState(
    initialPayload?.tailEnabled ?? true,
  );
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ViewerNotice>(null);
  const [searchText, setSearchText] = useState("");
  const noticeIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const liveBufferRef = useRef<Map<string, LogEntry>>(new Map());
  const flushTimerRef = useRef<number | null>(null);
  const queryingRef = useRef(false);
  const requestIdRef = useRef(0);
  const deferredEntries = useDeferredValue(entries);
  const deferredSearchText = useDeferredValue(searchText);

  const filter = useMemo(() => buildQueryFilter(controls), [controls]);
  const activeTraceId = filter.traceId?.trim() ?? "";
  const activeCorrelationId = filter.correlationId?.trim() ?? "";
  const searchQuery = normalizeSearchQuery(searchText);
  const filterRef = useRef(filter);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  const updateControls = (
    next: ControlState | ((current: ControlState) => ControlState),
  ) => {
    setLoading(true);
    setError(null);
    setControls(next);
  };

  const showNotice = useCallback(
    (
      next: Pick<Exclude<ViewerNotice, null>, "kind" | "message"> & {
        autoCloseMs?: number | null;
      },
    ) => {
      noticeIdRef.current += 1;
      setNotice({
        id: noticeIdRef.current,
        kind: next.kind,
        message: next.message,
        autoCloseMs:
          next.autoCloseMs === undefined
            ? NOTICE_AUTO_CLOSE_MS
            : next.autoCloseMs,
      });
    },
    [],
  );

  const dismissNotice = useCallback(() => {
    setNotice(null);
  }, []);

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    let stopped = false;
    let unlisten: (() => void) | undefined;

    void currentWindow
      .listen<LogWindowNavigatePayload>(LOG_WINDOW_NAVIGATE_EVENT, (event) => {
        const payload = normalizeLogNavigatePayload(event.payload);
        if (stopped) return;
        setLoading(true);
        setError(null);
        setControls(controlsFromPayload(payload));
        setTailEnabled(payload.tailEnabled ?? true);
        setExpandedIds(new Set());
        setNotice(null);
        setSearchText("");
      })
      .then((dispose) => {
        if (stopped) {
          dispose();
          return;
        }
        unlisten = dispose;
      });

    return () => {
      stopped = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    queryingRef.current = true;
    liveBufferRef.current.clear();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    void queryLogs(filter)
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        queryingRef.current = false;
        startTransition(() => {
          setEntries(
            mergeEntries(
              sortEntriesAscending(result),
              Array.from(liveBufferRef.current.values()),
              filter.limit ?? DEFAULT_LOG_LIMIT,
            ),
          );
        });
        setLoading(false);
      })
      .catch((queryError) => {
        if (requestIdRef.current !== requestId) return;
        queryingRef.current = false;
        setEntries([]);
        setError(
          queryError instanceof Error
            ? queryError.message
            : "Failed to load logs.",
        );
        setLoading(false);
      });
  }, [filter]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const flush = () => {
      flushTimerRef.current = null;
      if (cancelled || queryingRef.current) return;
      const pending = Array.from(liveBufferRef.current.values());
      if (pending.length === 0) return;
      liveBufferRef.current.clear();
      startTransition(() => {
        setEntries((current) =>
          mergeEntries(
            current,
            pending,
            filterRef.current.limit ?? DEFAULT_LOG_LIMIT,
          ),
        );
      });
    };

    const scheduleFlush = () => {
      if (flushTimerRef.current != null) return;
      flushTimerRef.current = window.setTimeout(flush, LIVE_FLUSH_MS);
    };

    void listenForLogEntries((entry) => {
      if (cancelled) return;
      if (!matchesFilter(entry, filterRef.current)) return;
      liveBufferRef.current.set(entry.id, entry);
      scheduleFlush();
    }).then((dispose) => {
      if (cancelled) {
        dispose?.();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      cancelled = true;
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    if (!tailEnabled) return;
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [deferredEntries, deferredSearchText, tailEnabled, expandedIds]);

  useEffect(() => {
    if (!notice || notice.autoCloseMs == null) return;
    const noticeId = notice.id;
    const timerId = window.setTimeout(() => {
      setNotice((current) => (current?.id === noticeId ? null : current));
    }, notice.autoCloseMs);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [notice]);

  const isTreeView = Boolean(filter.traceId || filter.correlationId);
  const appliedFilterCount = activeFilterCount(filter) + (searchQuery ? 1 : 0);
  const includedTags = useMemo(() => new Set(filter.tags ?? []), [filter.tags]);
  const excludedTags = useMemo(
    () => new Set(filter.excludeTags ?? []),
    [filter.excludeTags],
  );
  const filterTags = visibleTagPills(filter);
  const visibleEntries = useMemo(
    () => filterEntriesBySearch(deferredEntries, deferredSearchText),
    [deferredEntries, deferredSearchText],
  );
  const tree = useMemo(
    () => (isTreeView ? buildTree(visibleEntries) : []),
    [visibleEntries, isTreeView],
  );

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <=
      SCROLL_TAIL_THRESHOLD_PX;
    setTailEnabled(nearBottom);
  };

  const handleToggleExpanded = (entryId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  };

  const handleJumpToLive = () => {
    setTailEnabled(true);
    const container = scrollRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  };

  const handleReset = () => {
    setLoading(true);
    setError(null);
    setControls(controlsFromPayload(null));
    setTailEnabled(true);
    setExpandedIds(new Set());
    setNotice(null);
    setSearchText("");
  };

  const handleExport = async () => {
    try {
      const result = await exportLogs(filter);
      if (!result) {
        showNotice({
          kind: "error",
          message: "Log export is only available in Tauri.",
          autoCloseMs: null,
        });
        return;
      }
      showNotice({
        kind: "success",
        message: `Exported ${result.count} log entries to ${result.path}`,
        autoCloseMs: null,
      });
    } catch (exportError) {
      showNotice({
        kind: "error",
        message:
          exportError instanceof Error
            ? exportError.message
            : "Failed to export logs.",
        autoCloseMs: null,
      });
    }
  };

  const handleClear = () => {
    const sinceMs = Date.now();
    const nextControls = {
      ...controls,
      sinceMs,
    };
    requestIdRef.current += 1;
    queryingRef.current = false;
    liveBufferRef.current.clear();
    filterRef.current = buildQueryFilter(nextControls);
    setControls(nextControls);
    setEntries([]);
    setError(null);
    setLoading(false);
    setExpandedIds(new Set());
    setTailEnabled(true);
    showNotice({
      kind: "success",
      message: "Cleared current view. Only new logs will appear.",
    });
  };

  const handleRemoveSinceFilter = () => {
    updateControls((current) => ({
      ...current,
      sinceMs: null,
    }));
  };

  const handleTagAction = (tag: string, mode: "include" | "exclude") => {
    updateControls((current) => ({
      ...current,
      tagStates: applyTagState(current.tagStates, tag, mode),
    }));
  };

  const handleTraceIdAction = (traceId: string) => {
    updateControls((current) => ({
      ...current,
      traceId,
    }));
  };

  const handleCorrelationIdAction = (correlationId: string) => {
    updateControls((current) => ({
      ...current,
      correlationId,
    }));
  };

  const handleCycleTagState = (tag: LogTag) => {
    updateControls((current) => ({
      ...current,
      tagStates: applyTagState(
        current.tagStates,
        tag,
        nextTagState(current.tagStates, tag),
      ),
    }));
  };

  return (
    <div className="min-h-screen bg-app text-text">
      {notice ? (
        <NoticeToast notice={notice} onDismiss={dismissNotice} />
      ) : null}
      <div className="flex h-screen w-full flex-col px-5 py-5">
        <div className="flex h-full flex-col rounded-2xl border border-border-subtle bg-surface shadow-[0_16px_40px_rgb(0_0_0_/_0.12)]">
          <div className="border-b border-border-subtle px-4 py-3">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 lg:grid-cols-[auto_minmax(20rem,1fr)_auto]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-xxs font-bold tracking-[0.08em] uppercase text-primary">
                    Structured Logs
                  </div>
                  <ViewModeBadge
                    isTreeView={isTreeView}
                    limit={filter.limit ?? DEFAULT_LOG_LIMIT}
                  />
                  {appliedFilterCount > 0 ? (
                    <Badge variant="muted">
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined text-md leading-none"
                      >
                        filter_alt
                      </span>
                      {appliedFilterCount}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <div className="order-3 col-span-2 min-w-0 lg:order-2 lg:col-span-1 lg:justify-self-center lg:w-full">
                <TextField
                  type="text"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder="Search logs"
                  aria-label="Search logs"
                  autoComplete="off"
                  spellCheck={false}
                  wrapClassName="border-border-subtle bg-inset/80"
                  startAdornment={
                    <span
                      className="material-symbols-outlined text-muted"
                      style={{ fontSize: 18, marginLeft: 10, flexShrink: 0 }}
                      aria-hidden="true"
                    >
                      search
                    </span>
                  }
                  endAdornment={
                    searchQuery ? (
                      <IconButton
                        type="button"
                        aria-label="Clear log search"
                        title="Clear search"
                        onClick={() => setSearchText("")}
                        className="mr-1"
                      >
                        <span
                          className="material-symbols-outlined text-md"
                          aria-hidden="true"
                        >
                          close
                        </span>
                      </IconButton>
                    ) : null
                  }
                />
              </div>
              <div className="order-2 flex flex-wrap items-center justify-end gap-2 lg:order-3">
                {tailEnabled ? (
                  <Badge variant="success">TAILING</Badge>
                ) : (
                  <Button
                    variant="primary"
                    size="xxs"
                    onClick={handleJumpToLive}
                    leftIcon={
                      <span className="material-symbols-outlined text-md leading-none">
                        text_select_jump_to_end
                      </span>
                    }
                  >
                    TO LIVE
                  </Button>
                )}
                <Button variant="ghost" size="xxs" onClick={handleReset}>
                  RESET
                </Button>
                <Button
                  variant="ghost"
                  size="xxs"
                  onClick={() => void handleExport()}
                >
                  EXPORT
                </Button>
                <Button variant="danger" size="xxs" onClick={handleClear}>
                  CLEAR
                </Button>
              </div>
            </div>
          </div>

          <div className="border-b border-border-subtle px-4 py-3">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mt-2 flex flex-wrap gap-2">
                    {filterTags.map((tag) => (
                      <TagStatePill
                        key={tag}
                        tag={tag}
                        state={
                          includedTags.has(tag)
                            ? "include"
                            : excludedTags.has(tag)
                              ? "exclude"
                              : "ignore"
                        }
                        onCycle={handleCycleTagState}
                      />
                    ))}
                  </div>
                </div>

                <div className="ml-auto flex flex-nowrap items-center gap-3">
                  <VerbosityPillControl
                    value={controls.verbosity}
                    onChange={(next) =>
                      updateControls((current) => ({
                        ...current,
                        verbosity: next,
                      }))
                    }
                  />
                  <SourceControl
                    value={controls.source}
                    onChange={(next) =>
                      updateControls((current) => ({
                        ...current,
                        source: next,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="flex min-w-0 flex-nowrap items-center gap-3">
                <div className="flex min-w-0 flex-nowrap items-center gap-3">
                  <InlineTokenFilterControl
                    label="Trace ID"
                    value={controls.traceId}
                    placeholder="trace id"
                    addLabel="+ TRACE ID"
                    badgePrefix="trace"
                    className="min-w-0 w-65 max-w-65"
                    onChange={(next) =>
                      updateControls((current) => ({
                        ...current,
                        traceId: next,
                      }))
                    }
                  />
                  <InlineTokenFilterControl
                    label="Tool Correlation ID"
                    value={controls.correlationId}
                    placeholder="tool correlation id"
                    addLabel="+ TOOL CORREL ID"
                    badgePrefix="tool"
                    className="min-w-0 w-65 max-w-65"
                    onChange={(next) =>
                      updateControls((current) => ({
                        ...current,
                        correlationId: next,
                      }))
                    }
                  />
                </div>
                <div className="ml-auto shrink-0">
                  <div className="flex items-center gap-2">
                    {typeof controls.sinceMs === "number" ? (
                      <SinceFilterPill
                        sinceMs={controls.sinceMs}
                        onClear={handleRemoveSinceFilter}
                      />
                    ) : null}
                    <RowLimitControl
                      value={controls.limit}
                      onChange={(next) =>
                        updateControls((current) => ({
                          ...current,
                          limit: next,
                        }))
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
              onScroll={handleScroll}
            >
              {loading ? (
                <div className="py-12 text-center text-sm text-muted">
                  Loading logs…
                </div>
              ) : error ? (
                <div className="py-12 text-center text-sm text-error">
                  {error}
                </div>
              ) : visibleEntries.length === 0 ? (
                <div className="py-12 text-center text-sm text-muted">
                  No log entries match the current filter.
                </div>
              ) : isTreeView ? (
                <LogTree
                  nodes={tree}
                  expandedIds={expandedIds}
                  onToggleExpanded={handleToggleExpanded}
                  includedTags={includedTags}
                  excludedTags={excludedTags}
                  onTagAction={handleTagAction}
                  onTraceIdAction={handleTraceIdAction}
                  onCorrelationIdAction={handleCorrelationIdAction}
                  activeTraceId={activeTraceId}
                  activeCorrelationId={activeCorrelationId}
                />
              ) : (
                <div className="flex flex-col gap-3">
                  {visibleEntries.map((entry) => (
                    <LogEntryRow
                      key={entry.id}
                      entry={entry}
                      expanded={expandedIds.has(entry.id)}
                      onToggleExpanded={() => handleToggleExpanded(entry.id)}
                      includedTags={includedTags}
                      excludedTags={excludedTags}
                      onTagAction={handleTagAction}
                      onTraceIdAction={handleTraceIdAction}
                      onCorrelationIdAction={handleCorrelationIdAction}
                      activeTraceId={activeTraceId}
                      activeCorrelationId={activeCorrelationId}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
