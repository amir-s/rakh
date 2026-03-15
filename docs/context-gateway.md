# ContextGateway

## Overview

ContextGateway is the pre-turn context boundary for the agent runtime.

It sits between persisted `apiMessages` and the next model call. Unlike
ToolGateway, which wraps tool execution, ContextGateway decides whether the
model should see the raw accumulated API history or a transformed replacement.

Current goals:

- keep long-running sessions inside the selected model's context window
- preserve important working memory through normalized todos instead of replaying
  every earlier turn
- keep the visible chat transcript intact while allowing `apiMessages` to be
  compacted live

The main entrypoints are:

- [`src/agent/contextGateway.ts`](../src/agent/contextGateway.ts)
- [`src/agent/runner/contextGateway.ts`](../src/agent/runner/contextGateway.ts)
- [`src/agent/runner/agentLoop.ts`](../src/agent/runner/agentLoop.ts)
- [`src/agent/runner/subagentLoop.ts`](../src/agent/runner/subagentLoop.ts)

## Runtime contract

The gateway receives a per-turn state snapshot with:

- `tabId`, `runId`, `agentId`, `modelId`
- `currentTurn` and `messageCount`
- optional `contextLength`, `contextUsagePct`, `estimatedTokens`, and `estimatedBytes`
- optional `activeTodoId`

The gateway returns:

- `messages`: the message list to send to the next model call
- optional `replacementApiMessages`: a replacement history the runner should
  persist back into `AgentState.apiMessages`

The runner calls ContextGateway before every main-agent and subagent turn.
Current policies are main-agent-only, but subagents still pass through the same
seam so future policies do not need new runner plumbing.

## Todo policy foundation

ContextGateway depends on the JSON-backed todo system introduced in the v1 todo
policy.

Todo storage:

- release builds: `~/.rakh/sessions/todos/<sessionId>.json`
- debug/dev builds: `~/.rakh-dev/sessions/todos/<sessionId>.json`

The session SQLite row keeps a legacy `todos` field for compatibility, but the
real source of truth is the JSON file plus the in-memory Jotai cache.

Current todo shape:

- `id`
- `title`
- `state`: `todo | doing | blocked | done`
- `owner`: `main` or a concrete subagent id string
- `createdTurn`
- `updatedTurn`
- `lastTouchedTurn`
- `filesTouched`
- `thingsLearned`
- `criticalInfo`
- `mutationLog`
- optional `completionNote`

Important turn semantics:

- `updatedTurn` changes only on explicit todo-tool mutations
- `lastTouchedTurn` changes on todo-tool mutations and tracked file/command
  mutations, including ContextGateway enrichments

`filesTouched` is a deduped projection over `mutationLog`; it is not the
authoritative history.

Normal `agent_todo_list` responses intentionally omit `mutationLog` so the main
agent does not pay that context cost on every turn. ContextGateway and the
backend todo store still read the full persisted todo record when they need the
tracked history.

## Todo note rules

Todo notes are the durable memory channel ContextGateway uses during
compaction.

Current note sources:

- `agent`
- `context_gateway`

Each note stores:

- `id`
- `text`
- `addedTurn`
- `author`
- `source`
- `verified`

ContextGateway is intentionally enrich-only. It may:

- append new `thingsLearned` notes
- append new `criticalInfo` notes
- mark existing notes verified
- remove only exact or near-exact duplicate notes

It may not:

- edit note text
- rewrite todo ids, titles, owners, states, or completion notes
- add or remove todos

Duplicate handling is conservative:

- exact duplicate: identical raw text
- near-exact duplicate: same text after trim, whitespace collapse,
  lowercasing, and stripping only trailing `.`, `!`, or `?`
- keep the earliest existing note and remove only later duplicates

## Todo ownership and mutation tracking

The main agent currently owns todo lifecycle.

Planner-specific rule:

- the planner subagent may return plan artifacts and summary cards
- it must not call `agent_todo_*` tools
- the main agent creates and updates todos after reviewing planner output

Tracked mutation rules are enforced before mutating tools run:

- `workspace_writeFile`
- `workspace_editFile`
- `exec_run`
- `git_worktree_init`

Each of those calls must include:

- `mutationIntent`
- `todoHandling`

`todoHandling.mode` must be one of:

- `track_active`
- `skip`

When `track_active` is used:

- exactly one session-wide todo must be in the `doing` state

When `skip` is used:

- `todoHandling.skipReason` is required

Tracked successful mutations append to `mutationLog` and update
`lastTouchedTurn`. `workspace_*` writes infer their touched path directly;
`exec_run` and `git_worktree_init` only track explicit `todoHandling.touchedPaths`.

## Current compaction policy

The current v2 policy is `todoNormalization`.

Default bootstrap behavior:

- enabled
- trigger threshold: `75%` estimated context usage
- main agent only
- uses an override model by default: `openai/gpt-5.2-codex`
- replaces `apiMessages` after successful compaction

Inputs to the internal compaction model:

- full current `apiMessages`
- current plan markdown
- full persisted todo list
- current turn and active todo id

The model returns structured output with:

- a compact continuation summary
- per-todo note verification and append instructions
- duplicate removals limited to the allowed note rules

The backend applies those note updates atomically through
`todo_store_context_enrich` in
[`src-tauri/src/todos.rs`](../src-tauri/src/todos.rs).

## API history replacement

On successful compaction, ContextGateway replaces only `apiMessages`.

Replacement rules:

- preserve the original leading system prompt
- insert one synthetic system message containing:
  - current plan
  - normalized todos
  - compact continuation summary
- if the pre-compaction tail ends with a user message, keep that trailing user
  message after the synthetic system message
- leave `chatMessages` unchanged

This means:

- visible conversation history remains the durable user-facing transcript
- the model sees only the compacted API context going forward

## Failure behavior

ContextGateway fails open.

If the internal model call fails, schema validation fails, or todo enrichment
fails:

- keep the original `apiMessages`
- do not mutate todos
- continue the run normally

The runner logs the skip or failure with structured log events under the
`runner.contextgateway.*` namespace.

## Related files

- [`src/agent/contextGateway.ts`](../src/agent/contextGateway.ts)
- [`src/agent/mutationPolicy.ts`](../src/agent/mutationPolicy.ts)
- [`src/agent/tools/todos.ts`](../src/agent/tools/todos.ts)
- [`src/agent/runner/contextGateway.ts`](../src/agent/runner/contextGateway.ts)
- [`src/agent/runner/systemPrompt.ts`](../src/agent/runner/systemPrompt.ts)
- [`src-tauri/src/todos.rs`](../src-tauri/src/todos.rs)
