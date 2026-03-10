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
 * Group assistant turns into UI bubbles.
 * Messages with bubbleGroupId stay attached to a stable bubble even when other
 * assistant messages interleave. User messages are always standalone.
 */
export function groupChatMessagesForBubbles(
  messages: ChatMessage[],
): ChatBubbleGroup[] {
  const groups: ChatBubbleGroup[] = [];
  const threadedAssistantGroupIndexes = new Map<string, number>();

  for (const msg of messages) {
    if (isAssistantMessage(msg)) {
      const threadedGroupKey = msg.bubbleGroupId
        ? `assistant:${msg.agentName ?? "Rakh"}:${msg.bubbleGroupId}`
        : null;
      if (threadedGroupKey) {
        const existingGroupIndex = threadedAssistantGroupIndexes.get(
          threadedGroupKey,
        );
        if (existingGroupIndex !== undefined) {
          const existingGroup = groups[existingGroupIndex];
          if (existingGroup?.kind === "assistant") {
            existingGroup.messages.push(msg);
            continue;
          }
        }

        groups.push({
          kind: "assistant",
          key: threadedGroupKey,
          messages: [msg],
          agentName: msg.agentName,
        });
        threadedAssistantGroupIndexes.set(threadedGroupKey, groups.length - 1);
        continue;
      }

      const prev = groups[groups.length - 1];
      // Merge into the previous assistant bubble only when the agent name matches.
      if (
        prev &&
        prev.kind === "assistant" &&
        prev.agentName === msg.agentName &&
        prev.messages.every((existingMessage) => !existingMessage.bubbleGroupId)
      ) {
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
