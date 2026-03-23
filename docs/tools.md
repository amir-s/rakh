# Tools

## Scope

This document covers the model-visible tool surface exposed by:

- [`src/agent/tools/definitions.ts`](../src/agent/tools/definitions.ts) for
  built-in tools
- dynamic `mcp_*` registrations prepared for the main agent at runtime

It does not include helper functions that exist in code but are not exported
through `TOOL_DEFINITIONS`.

## Tool kinds

- `local`: built-in tools dispatched through
  [`src/agent/tools/index.ts`](../src/agent/tools/index.ts)
- `synthetic`: runner-intercepted tools handled in
  [`src/agent/runner/agentLoop.ts`](../src/agent/runner/agentLoop.ts) or
  [`src/agent/runner/subagentLoop.ts`](../src/agent/runner/subagentLoop.ts)
- `mcp`: dynamic tools registered from configured MCP servers; only the main
  agent receives them today

## Tool IO compaction

Tool IO compaction is separate from automatic main-context compaction:

- tool IO compaction lets the main agent see oversized tool input/output once,
  then rewrites that prior tool turn in `apiMessages` into compact sentinels
- automatic main-context compaction runs the internal `compact` subagent when
  the overall conversation history crosses a configured threshold

Tool IO compaction rules:

- requires the global `Enable tool IO compaction` setting
- uses the configured KB threshold from Settings
- only runs through the internal `agent_replace_tool_io` maintenance turn after
  a large tool call has already been consumed once by the main agent
- preserves raw args/results in visible chat; only model-facing `apiMessages`
  are rewritten afterward
- has tool-specific sentinel shapes for common tools and a generic fallback for
  everything else, implemented in
  [`src/agent/runner/toolContextCompaction.ts`](../src/agent/runner/toolContextCompaction.ts)

## Access matrix

Legend:

- `Y`: tool is available to that agent
- `-`: tool is not available to that agent
- `Main`: the primary agent loop
- `Compact`: the internal context-compaction subagent; it is not callable via
  `agent_subagent_call`

| Tool | Kind | Main | Planner | Copywriter | Reviewer | Security | GitHub | Compact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `workspace_listDir` | local | Y | Y | Y | Y | Y | Y | - |
| `workspace_stat` | local | Y | Y | Y | Y | Y | Y | - |
| `workspace_readFile` | local | Y | Y | Y | Y | Y | Y | - |
| `workspace_writeFile` | local | Y | - | - | - | - | - | - |
| `workspace_editFile` | local | Y | - | - | - | - | - | - |
| `workspace_glob` | local | Y | Y | Y | Y | Y | Y | - |
| `workspace_search` | local | Y | Y | Y | Y | Y | Y | - |
| `exec_run` | local | Y | - | Y | - | Y | Y | - |
| `agent_todo_add` | local | Y | - | - | - | - | - | - |
| `agent_todo_update` | local | Y | - | - | - | - | - | - |
| `agent_todo_note_add` | local | Y | - | - | - | - | - | - |
| `agent_todo_list` | local | Y | - | - | - | - | - | - |
| `agent_todo_remove` | local | Y | - | - | - | - | - | - |
| `agent_project_memory_add` | local | Y | - | - | - | - | - | Y |
| `agent_project_memory_remove` | local | Y | - | - | - | - | - | Y |
| `agent_project_memory_edit` | local | Y | - | - | - | - | - | Y |
| `agent_card_add` | synthetic | Y | Y | Y | Y | Y | Y | - |
| `agent_artifact_create` | local | Y | Y | Y | Y | Y | - | Y |
| `agent_artifact_version` | local | Y | Y | Y | Y | Y | - | - |
| `agent_artifact_get` | local | Y | Y | Y | Y | Y | - | - |
| `agent_artifact_list` | local | Y | Y | Y | Y | Y | - | - |
| `git_worktree_init` | local | Y | - | - | - | - | - | - |
| `agent_subagent_call` | synthetic | Y | - | - | - | - | - | - |
| `user_input` | synthetic | Y | - | Y | Y | Y | Y | - |
| `agent_title_set` | local | Y | - | - | - | - | - | - |
| `agent_title_get` | local | Y | - | - | - | - | - | - |
| `mcp_*` | mcp | Y | - | - | - | - | - | - |
