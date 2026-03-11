import type { ToolCallDisplay } from "@/agent/types";

export const CHAT_ATTENTION_TARGET_ATTR = "data-chat-attention-target" as const;

export type ChatAttentionTargetKind = "approval" | "cta";

export function getChatAttentionTargetProps(
  kind: ChatAttentionTargetKind | null,
): Record<typeof CHAT_ATTENTION_TARGET_ATTR, ChatAttentionTargetKind> | undefined {
  if (kind == null) return undefined;
  return { [CHAT_ATTENTION_TARGET_ATTR]: kind };
}

export function getToolCallAttentionTargetKind(
  toolCall: ToolCallDisplay,
): ChatAttentionTargetKind | null {
  switch (toolCall.status) {
    case "awaiting_approval":
    case "awaiting_worktree":
    case "awaiting_setup_action":
      return "approval";
    default:
      return null;
  }
}

export function parseChatAttentionTargetKind(
  value: string | undefined,
): ChatAttentionTargetKind | null {
  return value === "approval" || value === "cta" ? value : null;
}
