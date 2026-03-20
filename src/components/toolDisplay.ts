import type { ToolCallDisplay } from "@/agent/types";
import { AGENT_LOOP_LIMIT_TOOL_NAME } from "@/agent/loopLimits";

const TOOL_ICON: Record<string, string> = {
  workspace_listDir: "folder_open",
  workspace_stat: "info",
  workspace_readFile: "description",
  workspace_writeFile: "edit_document",
  workspace_editFile: "difference",
  workspace_glob: "search",
  workspace_search: "manage_search",
  exec_run: "terminal",
  codex_commandExecution: "terminal",
  codex_fileChange: "difference",
  codex_mcpToolCall: "extension",
  git_worktree_init: "account_tree",
  user_input: "person",
  agent_card_add: "dashboard_customize",
  agent_artifact_create: "inventory_2",
  agent_artifact_version: "layers",
  agent_artifact_get: "pageview",
  agent_artifact_list: "lists",
  agent_todo_add: "checklist",
  agent_todo_update: "checklist",
  agent_todo_note_add: "checklist",
  agent_todo_list: "checklist",
  agent_todo_remove: "checklist",
  agent_project_memory_add: "psychology",
  agent_project_memory_remove: "psychology_alt",
  agent_project_memory_edit: "edit_note",
  [AGENT_LOOP_LIMIT_TOOL_NAME]: "warning",
};

const TOOL_LABEL: Record<string, string> = {
  workspace_listDir: "LIST DIRECTORY",
  workspace_stat: "STAT FILE",
  workspace_readFile: "READ FILE",
  workspace_writeFile: "WRITE FILE",
  workspace_editFile: "EDIT FILE",
  workspace_glob: "GLOB FILES",
  workspace_search: "SEARCH FILES",
  exec_run: "RUN COMMAND",
  codex_commandExecution: "RUN COMMAND",
  codex_fileChange: "APPLY FILE CHANGE",
  codex_mcpToolCall: "CALL MCP TOOL",
  git_worktree_init: "CREATE ISOLATED BRANCH",
  user_input: "ASK USER",
  agent_card_add: "ADD CARD",
  agent_artifact_create: "CREATE ARTIFACT",
  agent_artifact_version: "VERSION ARTIFACT",
  agent_artifact_get: "GET ARTIFACT",
  agent_artifact_list: "LIST ARTIFACTS",
  agent_todo_add: "ADD TODO",
  agent_todo_update: "UPDATE TODO",
  agent_todo_note_add: "ADD TODO NOTE",
  agent_todo_list: "LIST TODOS",
  agent_todo_remove: "REMOVE TODO",
  agent_project_memory_add: "UPDATE PROJECT MEMORY",
  agent_project_memory_remove: "REMOVE PROJECT MEMORY",
  agent_project_memory_edit: "EDIT PROJECT MEMORY",
  [AGENT_LOOP_LIMIT_TOOL_NAME]: "LOOP LIMIT GUARD",
};

export function getToolCallIcon(tc: Pick<ToolCallDisplay, "tool" | "mcp">): string {
  if (tc.mcp) return "extension";
  return TOOL_ICON[tc.tool] ?? "build";
}

export function getToolCallLabel(tc: Pick<ToolCallDisplay, "tool" | "mcp">): string {
  if (tc.mcp) {
    return `MCP / ${tc.mcp.serverName} / ${tc.mcp.toolTitle ?? tc.mcp.toolName}`;
  }
  return TOOL_LABEL[tc.tool] ?? tc.tool.toUpperCase();
}
