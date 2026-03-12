# Structured Logging

Rakh now writes structured JSONL logs through a single backend-owned pipeline.
Frontend and backend entries share the same schema and land in the same log
files.

## Log locations

- release: `~/.rakh/logs/rakh.log`
- debug / `npm run tauri:dev`: `~/.rakh-dev/logs/rakh.log`

Exports are written under:

- release: `~/.rakh/logs/exports/`
- debug: `~/.rakh-dev/logs/exports/`

The plain web Vite runtime does not persist logs to disk. It falls back to
structured `console` output instead.

## Rotation and retention

- active file: `rakh.log`
- archives: `rakh.log.1` through `rakh.log.5`
- rotation threshold: `10 MiB`
- retention: keep `5` archives

In debug builds, each persisted JSONL line is also mirrored to `stderr` to keep
local development ergonomics intact.

## Entry schema

Every log line is a JSON object with this shape:

- `id`
- `timestamp`
- `timestampMs`
- `level`
- `source`
- `tags`
- `event`
- `message`
- `traceId?`
- `correlationId?`
- `parentId?`
- `depth`
- `kind`
- `expandable`
- `durationMs?`
- `data?`

### Field notes

- `source`: `frontend` or `backend`
- `level`: `trace`, `debug`, `info`, `warn`, `error`
- `kind`: `start`, `end`, `event`, `error`
- `traceId`: end-to-end execution trace. Main agent loops use the run id as the
  base trace seed.
- `correlationId`: tool-call level join key. Rakh uses tool call ids here.
- `parentId`: logical parent log record for start/end trees.
- `depth`: nesting level for runs, turns, tools, and subagents.
- `data`: JSON-safe metadata only. Secrets and large binary payloads should stay
  redacted or truncated.

## Context schema

Agent-originated calls can carry this shared context:

- `sessionId?`
- `tabId?`
- `traceId?`
- `correlationId?`
- `parentId?`
- `depth?`
- `agentId?`
- `toolName?`

The runner threads this context into:

- workspace tools
- `exec_run`
- `git_worktree_init`
- MCP prepare/call/shutdown
- artifact create/version/get/list

## Canonical tags

Issue `#133` keeps this v1 tag set:

- `backend`
- `frontend`
- `db`
- `streaming`
- `tokens`
- `tool-calls`
- `agent-loop`
- `messages`
- `system`

`streaming` and `tokens` entries are verbose logs and are only emitted when the
session debug toggle is enabled.

## Backend APIs

The Tauri backend exposes:

- `logs_write(entry)`
- `logs_query(filter)`
- `logs_export(filter)`
- `logs_clear()`

`logs_query()` supports:

- `tags`
- `tagMode: "and" | "or"`
- `levels`
- `traceId`
- `correlationId`
- `source`
- `sinceMs`
- `untilMs`
- `limit`

Query results are returned newest-first. The default limit is `500`.

The backend also emits a live `log_entry` event after each successful write.

## Operational usage

Tail the active log:

```bash
tail -f ~/.rakh/logs/rakh.log
```

Filter tool-call activity:

```bash
tail -f ~/.rakh/logs/rakh.log | grep '"tool-calls"'
```

Filter one trace:

```bash
grep '"traceId":"trace:run_2026-03-12T00-00-00Z_0001:main"' ~/.rakh/logs/rakh.log
```

## Implementation map

- frontend client: [`src/logging/client.ts`](../src/logging/client.ts)
- shared TS types: [`src/logging/types.ts`](../src/logging/types.ts)
- backend store and Tauri commands: [`src-tauri/src/logging.rs`](../src-tauri/src/logging.rs)
- runner trace propagation: [`src/agent/runner.ts`](../src/agent/runner.ts)
