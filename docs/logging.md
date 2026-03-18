# Structured Logging

Rakh uses a backend-owned structured logging pipeline. Frontend and backend
code both emit the same `LogEntry` shape, the Rust backend persists entries as
JSONL, and the app exposes a shared detached log viewer window for querying and
live inspection.

This document covers the current implementation, not just the original logging
API contract.

## Goals

- one schema for frontend and backend logs
- persisted JSONL files owned by the Tauri backend
- live subscription inside the app through the `log_entry` event
- query/export APIs for filtered inspection
- a detached viewer window that can deep-link into a trace or tool call

## Runtime model

There are three main layers:

1. emit logs
2. persist/query logs
3. inspect logs

### Emit logs

- frontend app code writes through [`src/logging/client.ts`](../src/logging/client.ts)
- runner-specific helpers live in
  [`src/agent/runner/logging.ts`](../src/agent/runner/logging.ts)
- backend code writes through [`src-tauri/src/logging.rs`](../src-tauri/src/logging.rs)

### Persist and query logs

- the Rust `LogStore` in [`src-tauri/src/logging.rs`](../src-tauri/src/logging.rs)
  owns disk persistence, rotation, querying, export, and clear
- the frontend calls Tauri commands through
  [`src/logging/client.ts`](../src/logging/client.ts)

### Inspect logs

- the detached viewer UI lives in
  [`src/logging/LogsWindowApp.tsx`](../src/logging/LogsWindowApp.tsx)
- the shared window launcher lives in
  [`src/logging/window.ts`](../src/logging/window.ts)
- app bootstrap mounts the viewer in `window=logs` mode from
  [`src/App.tsx`](../src/App.tsx)

## Storage and retention

Logs are written under the app store root:

- release: `~/.rakh/logs/`
- debug / `npm run tauri:dev`: `~/.rakh-dev/logs/`

Files:

- active log: `rakh.log`
- archives: `rakh.log.1` through `rakh.log.5`
- exports: `logs/exports/rakh-logs-<timestamp>.jsonl`

Retention rules:

- rotate when the active file would exceed `10 MiB`
- keep `5` archives
- query reads the active file plus archives

In debug builds, backend log lines are also mirrored to `stderr`.

The plain web Vite runtime does not persist logs to disk. In that mode:

- frontend logs fall back to structured `console` output
- query/export/listen APIs are effectively unavailable or no-op
- the detached Tauri log window cannot be opened

## Schema

Shared TypeScript types live in
[`src/logging/types.ts`](../src/logging/types.ts).
The Rust backend mirrors the same shape in
[`src-tauri/src/logging.rs`](../src-tauri/src/logging.rs) using
`#[serde(rename_all = "camelCase")]`.

### `LogEntry`

```ts
type LogEntry = {
  id: string
  timestamp: string
  timestampMs: number
  level: "trace" | "debug" | "info" | "warn" | "error"
  source: "frontend" | "backend"
  tags: string[]
  event: string
  message: string
  traceId?: string
  correlationId?: string
  parentId?: string
  depth: number
  kind: "start" | "end" | "event" | "error"
  expandable: boolean
  durationMs?: number
  data?: unknown
}
```

Field intent:

- `traceId`: joins a whole run or execution flow
- `correlationId`: narrower join key, typically a tool call id
- `parentId`: points to another log entry for tree rendering
- `depth`: nesting depth for trace visualization
- `kind`: coarse event type for row treatment
- `data`: JSON-safe structured metadata

### `LogContext`

Frontend emitters can thread context through child operations:

```ts
type LogContext = {
  sessionId?: string
  tabId?: string
  traceId?: string
  correlationId?: string
  parentId?: string
  depth?: number
  agentId?: string
  toolName?: string
}
```

The runner uses this to keep trace lineage intact across the main run, tool
calls, and related sub-operations.

### `LogQueryFilter`

```ts
type LogQueryFilter = {
  tags?: string[]
  excludeTags?: string[]
  tagMode?: "and" | "or"
  levels?: Array<"trace" | "debug" | "info" | "warn" | "error">
  traceId?: string
  correlationId?: string
  source?: "frontend" | "backend"
  sinceMs?: number
  untilMs?: number
  limit?: number
}
```

Defaults:

- default backend limit: `500`
- default tag mode when omitted: `or`

## Write path

### Frontend

Frontend code usually logs through one of these helpers in
[`src/logging/client.ts`](../src/logging/client.ts):

- `logFrontend(input)`
- `logFrontendSoon(input)`
- `writeLogEntry(entry)`

Notable behavior:

- tags are normalized to lowercase, deduplicated, and sorted
- metadata is made JSON-safe before serialization
- if Tauri is unavailable, entries are written to `console` instead

### Runner

Runner-specific helpers in
[`src/agent/runner/logging.ts`](../src/agent/runner/logging.ts) build the
trace structure used by the viewer:

- `createMainRunLogContext(tabId, runId)`
- `createToolLogContext(baseContext, toolCallId, toolName)`
- `writeRunnerLog(...)`
- `logStreamDebug(...)`

Current conventions:

- the main run trace id is derived from `trace:<runId>:main`
- tool call ids are used as `correlationId`
- assistant messages and debug-pane actions can deep-link back into the same
  trace using that stored trace id
- runner/frontend messages should read as short subject-first summaries such as
  `Main turn 2 completed` or `Tool workspace_readFile queued`
- raw streaming internals (`stream.part`, token deltas, raw tool-call payloads)
  are emitted at `trace`; higher-value milestones stay at `debug`/`warn`/`error`

### Backend

Backend writes append normalized entries to JSONL and emit a live
`log_entry` event after each successful write.

## Query, export, and clear APIs

The backend exposes these Tauri commands:

- `logs_write(entry)`
- `logs_query(filter)`
- `logs_export(filter)`
- `logs_clear()`

Behavior:

- `logs_query(filter)` returns newest-first results from disk
- `logs_export(filter)` writes filtered JSONL to the exports directory
- `logs_clear()` deletes persisted log files on disk

The frontend wrapper lives in
[`src/logging/client.ts`](../src/logging/client.ts):

- `queryLogs(filter)`
- `exportLogs(filter)`
- `clearLogs()`
- `listenForLogEntries(handler)`

## Detached log viewer window

The viewer is a shared Tauri window with label `logs`.

Launcher behavior in [`src/logging/window.ts`](../src/logging/window.ts):

- if the window already exists, focus it and emit a `logs:navigate` payload
- otherwise create it with `?window=logs`
- embed the initial payload in the URL for first-load reliability

App bootstrap in [`src/App.tsx`](../src/App.tsx):

- keeps normal theme application
- skips workspace bootstrap when `window=logs`
- mounts only `LogsWindowApp`

### Entry points into the viewer

The main workspace can open the same shared viewer from:

- debug pane manual open
- debug pane latest run trace open
- assistant message trace links
- tool call `Open logs` links

The payload shape is:

```ts
type LogWindowNavigatePayload = {
  filter: LogQueryFilter
  origin: "manual" | "debug-pane" | "assistant-message" | "tool-call"
  tailEnabled?: boolean
}
```

## Viewer behavior

The detached viewer in
[`src/logging/LogsWindowApp.tsx`](../src/logging/LogsWindowApp.tsx):

- loads history with `queryLogs(filter)`
- subscribes to live `log_entry` events
- merges history and live entries by `entry.id`
- keeps at most `1000` matching entries in memory
- batches live updates with `startTransition`

Presentation modes:

- general feed: chronological oldest-to-newest, terminal-style tailing
- trace/correlation view: grouped tree built from `id` and `parentId`
- app entry points that open the viewer from the workspace default to
  `debug` verbosity so raw `trace` rows do not dominate the first view

Tailing behavior:

- tail is on by default
- scrolling away from the bottom pauses tail
- `Jump to live` resumes and scrolls to the end

### Clear behavior

The viewer’s `CLEAR` button does **not** call `logs_clear()`.

Instead it clears the current in-memory view and records a local cutoff time so
that only newly arriving entries appear afterward. Persisted logs on disk remain
untouched.

This is intentionally different from the backend `logs_clear()` command, which
deletes log files.

## Current filter semantics

The current UI does **not** expose the full `LogQueryFilter` surface directly.

### Tags

The tag pills are tri-state:

- ignored
- included
- excluded

UI conversion:

- included pills -> `filter.tags`
- excluded pills -> `filter.excludeTags`
- ignored pills -> omitted

Important nuance:

- the current viewer UI never sets `tagMode`
- that means included tags use backend/default `or` semantics
- excluded tags always act as “drop any entry that has one of these tags”

So today the effective tag behavior is:

```ts
{
  tags: ["agent-loop", "messages"],    // entry may match either
  excludeTags: ["system"],             // entry is removed if it has this tag
}
```

### Verbosity

The viewer exposes a compact verbosity control instead of raw level chips.

UI conversion:

- `error` -> `["error"]`
- `warn` -> `["error", "warn"]`
- `info` -> `["error", "warn", "info"]`
- `debug` -> `["error", "warn", "info", "debug"]`
- `trace` -> omit `levels` entirely, which means “show everything”

### Other filters

The current viewer exposes:

- source
- trace id
- correlation id
- row limit

It does not currently expose time-range inputs, even though `sinceMs` and
`untilMs` are still supported by the backend API.

## Tags

`LogTag` is open-ended. The backend can persist any string tag.

The frontend viewer has a small built-in known tag catalog in
[`src/logging/types.ts`](../src/logging/types.ts) for its pill strip:

- `agent-loop`
- `backend`
- `db`
- `frontend`
- `messages`
- `system`
- `tool-calls`

That list is only a UI catalog, not a hard validation boundary.

Some runtime logs also use additional tags such as `streaming` and `tokens`.
Those still query correctly even if they are not in the built-in pill list.

## Operational examples

Tail the active log:

```bash
tail -f ~/.rakh/logs/rakh.log
```

Filter one trace from disk:

```bash
grep '"traceId":"trace:run-123:main"' ~/.rakh/logs/rakh.log
```

Filter tool-call activity:

```bash
grep '"tool-calls"' ~/.rakh/logs/rakh.log
```

## File map

- shared frontend types:
  [`src/logging/types.ts`](../src/logging/types.ts)
- frontend Tauri client:
  [`src/logging/client.ts`](../src/logging/client.ts)
- detached window launcher:
  [`src/logging/window.ts`](../src/logging/window.ts)
- detached viewer UI:
  [`src/logging/LogsWindowApp.tsx`](../src/logging/LogsWindowApp.tsx)
- runner logging helpers:
  [`src/agent/runner/logging.ts`](../src/agent/runner/logging.ts)
- backend store and Tauri commands:
  [`src-tauri/src/logging.rs`](../src-tauri/src/logging.rs)
- logs window capability:
  [`src-tauri/capabilities/logs.json`](../src-tauri/capabilities/logs.json)
