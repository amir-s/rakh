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

export interface ToolCallRenderMessage {
  id: string;
  content?: string;
  reasoning?: string;
  reasoningStreaming?: boolean;
  streaming?: boolean;
  traceId?: string;
  toolCalls?: ToolCallDisplay[];
}

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

function hasVisibleContentBeforeToolCalls(message: ToolCallRenderMessage): boolean {
  return Boolean(
    message.content ||
      message.reasoning ||
      message.reasoningStreaming ||
      message.streaming,
  );
}

function hasVisibleContentAfterToolCalls(message: ToolCallRenderMessage): boolean {
  return Boolean(message.traceId);
}

export function buildToolCallRenderItemsByMessage(
  messages: ToolCallRenderMessage[],
  groupInlineToolCalls: boolean,
): Partial<Record<string, ToolCallRenderItem[]>> {
  const itemsByMessageId: Partial<Record<string, ToolCallRenderItem[]>> = {};

  if (!groupInlineToolCalls) {
    for (const message of messages) {
      const toolCalls = message.toolCalls ?? [];
      if (toolCalls.length === 0) continue;
      itemsByMessageId[message.id] = buildToolCallRenderItems(
        toolCalls,
        false,
      );
    }
    return itemsByMessageId;
  }

  let pendingToolCalls: ToolCallDisplay[] = [];
  let pendingMessageIds: string[] = [];

  const flushPending = () => {
    if (pendingToolCalls.length === 0 || pendingMessageIds.length === 0) {
      return;
    }

    const anchorMessageId = pendingMessageIds[pendingMessageIds.length - 1];
    itemsByMessageId[anchorMessageId] = buildToolCallRenderItems(
      pendingToolCalls,
      true,
    );
    pendingToolCalls = [];
    pendingMessageIds = [];
  };

  for (const message of messages) {
    if (hasVisibleContentBeforeToolCalls(message)) {
      flushPending();
    }

    const toolCalls = message.toolCalls ?? [];
    if (toolCalls.length > 0) {
      pendingToolCalls = [...pendingToolCalls, ...toolCalls];
      pendingMessageIds.push(message.id);
    }

    if (hasVisibleContentAfterToolCalls(message)) {
      flushPending();
    }
  }

  flushPending();
  return itemsByMessageId;
}
