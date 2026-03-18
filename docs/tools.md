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

- tool IO compaction rewrites large model-facing tool inputs or outputs into
  compact sentinels in `apiMessages`
- automatic main-context compaction runs the internal `compact` subagent when
  the overall conversation history crosses a configured threshold

Tool IO compaction rules:

- requires the global `Enable tool IO compaction` setting
- uses hidden `__contextCompaction` metadata on tool calls
- applies only to allowlisted `local` tools
- is ignored for `synthetic` tools and dynamic `mcp_*` tools

The current allowlists live in
[`src/agent/runner/toolContextCompaction.ts`](../src/agent/runner/toolContextCompaction.ts).

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

## Tool IO compaction matrix

Legend:

- `Y`: allowlisted for that side when the global tool-IO compaction toggle is enabled
- `-`: not allowlisted

| Tool | Input compaction | Output compaction | Notes |
| --- | --- | --- | --- |
| `workspace_listDir` | - | Y | Local tool |
| `workspace_stat` | - | - | Local tool |
| `workspace_readFile` | - | Y | Local tool |
| `workspace_writeFile` | Y | - | Local tool |
| `workspace_editFile` | Y | - | Local tool |
| `workspace_glob` | - | Y | Local tool |
| `workspace_search` | - | Y | Local tool |
| `exec_run` | Y | Y | Output compaction should usually prefer `outputMode: "on_success"` |
| `agent_todo_add` | - | - | Local tool |
| `agent_todo_update` | - | - | Local tool |
| `agent_todo_note_add` | - | - | Local tool |
| `agent_todo_list` | - | - | Local tool |
| `agent_todo_remove` | - | - | Local tool |
| `agent_project_memory_add` | - | - | Local tool |
| `agent_project_memory_remove` | - | - | Local tool |
| `agent_project_memory_edit` | - | - | Local tool |
| `agent_card_add` | - | - | Synthetic tools do not support tool IO compaction |
| `agent_artifact_create` | Y | - | Local tool |
| `agent_artifact_version` | Y | - | Local tool |
| `agent_artifact_get` | - | Y | Local tool |
| `agent_artifact_list` | - | - | Local tool |
| `git_worktree_init` | - | Y | Local tool |
| `agent_subagent_call` | - | - | Synthetic tools do not support tool IO compaction |
| `user_input` | - | - | Synthetic tools do not support tool IO compaction |
| `agent_title_set` | - | - | Local tool |
| `agent_title_get` | - | - | Local tool |
| `mcp_*` | - | - | Dynamic MCP tools do not support tool IO compaction |
