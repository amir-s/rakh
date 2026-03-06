import type { ChatMessage } from "@/agent/types";

type UserChatMessage = ChatMessage & { role: "user" };
type AssistantChatMessage = ChatMessage & { role: "assistant" };

export interface UserChatBubbleGroup {
  kind: "user";
  key: string;
  message: UserChatMessage;
}

export interface AssistantChatBubbleGroup {
  kind: "assistant";
  key: string;
  messages: AssistantChatMessage[];
  /** Display name of the agent owning this bubble group. Undefined = "Rakh". */
  agentName?: string;
}

export type ChatBubbleGroup = UserChatBubbleGroup | AssistantChatBubbleGroup;

function isAssistantMessage(msg: ChatMessage): msg is AssistantChatMessage {
  return msg.role === "assistant";
}

function isUserMessage(msg: ChatMessage): msg is UserChatMessage {
  return msg.role === "user";
}

/**
 * Group adjacent assistant turns so the UI can render them in a single bubble.
 * User messages are always rendered as standalone bubbles.
 */
export function groupChatMessagesForBubbles(
  messages: ChatMessage[],
): ChatBubbleGroup[] {
  const groups: ChatBubbleGroup[] = [];

  for (const msg of messages) {
    if (isAssistantMessage(msg)) {
      const prev = groups[groups.length - 1];
      // Merge into the previous assistant bubble only when the agent name matches.
      if (prev && prev.kind === "assistant" && prev.agentName === msg.agentName) {
        prev.messages.push(msg);
        continue;
      }

      groups.push({
        kind: "assistant",
        key: `assistant:${msg.id}`,
        messages: [msg],
        agentName: msg.agentName,
      });
      continue;
    }

    if (isUserMessage(msg)) {
      groups.push({
        kind: "user",
        key: `user:${msg.id}`,
        message: msg,
      });
    }
  }

  return groups;
}
