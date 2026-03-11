import { isInlineTool } from "@/agent/approvals";
import type { ToolCallDisplay } from "@/agent/types";

export type ToolCallRenderKind = "user_input" | "approval" | "compact";

export type ToolCallRenderItem =
  | {
      kind: "tool";
      toolCall: ToolCallDisplay;
      renderKind: ToolCallRenderKind;
    }
  | {
      kind: "group";
      toolCalls: ToolCallDisplay[];
    };

export function getToolCallRenderKind(tc: ToolCallDisplay): ToolCallRenderKind {
  if (tc.tool === "user_input" && tc.status === "awaiting_approval") {
    return "user_input";
  }

  if (
    tc.status === "awaiting_approval" ||
    tc.status === "awaiting_worktree" ||
    tc.status === "awaiting_branch_release" ||
    tc.status === "awaiting_setup_action" ||
    (tc.tool === "git_worktree_init" && tc.status === "running") ||
    (tc.tool === "exec_run" && tc.status === "running")
  ) {
    return "approval";
  }

  return "compact";
}

function canGroupInlineToolCall(tc: ToolCallDisplay): boolean {
  return (
    tc.tool !== "user_input" &&
    isInlineTool(tc.tool) &&
    getToolCallRenderKind(tc) === "compact"
  );
}

function flushGroup(
  items: ToolCallRenderItem[],
  pendingGroup: ToolCallDisplay[],
): ToolCallDisplay[] {
  if (pendingGroup.length > 1) {
    items.push({ kind: "group", toolCalls: pendingGroup });
  } else if (pendingGroup.length === 1) {
    items.push({
      kind: "tool",
      toolCall: pendingGroup[0],
      renderKind: "compact",
    });
  }

  return [];
}

export function buildToolCallRenderItems(
  toolCalls: ToolCallDisplay[],
  groupInlineToolCalls: boolean,
): ToolCallRenderItem[] {
  if (!groupInlineToolCalls) {
    return toolCalls.map((toolCall) => ({
      kind: "tool" as const,
      toolCall,
      renderKind: getToolCallRenderKind(toolCall),
    }));
  }

  const items: ToolCallRenderItem[] = [];
  let pendingGroup: ToolCallDisplay[] = [];

  for (const toolCall of toolCalls) {
    if (canGroupInlineToolCall(toolCall)) {
      pendingGroup.push(toolCall);
      continue;
    }

    pendingGroup = flushGroup(items, pendingGroup);
    items.push({
      kind: "tool",
      toolCall,
      renderKind: getToolCallRenderKind(toolCall),
    });
  }

  flushGroup(items, pendingGroup);
  return items;
}
