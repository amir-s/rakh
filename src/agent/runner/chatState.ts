import { getAgentState, patchAgentState } from "../atoms";
import type {
  ApiToolCall,
  ChatMessage,
  ConversationCard,
} from "../types";

export function msgId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function appendChatMessage(tabId: string, msg: ChatMessage): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    chatMessages: [...prev.chatMessages, msg],
  }));
}

export function updateLastChatMessage(
  tabId: string,
  updater: (msg: ChatMessage) => ChatMessage,
): void {
  patchAgentState(tabId, (prev) => {
    const msgs = [...prev.chatMessages];
    if (msgs.length === 0) return prev;
    msgs[msgs.length - 1] = updater(msgs[msgs.length - 1]);
    return { ...prev, chatMessages: msgs };
  });
}

export function appendCardsToChatMessage(
  tabId: string,
  messageId: string,
  cards: ConversationCard[],
): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    chatMessages: prev.chatMessages.map((msg) =>
      msg.id !== messageId
        ? msg
        : {
            ...msg,
            cards: cards.length > 0 ? cards : undefined,
          },
    ),
  }));
}

type ConversationCardSlot =
  | { status: "pending" }
  | { status: "done"; card: ConversationCard }
  | { status: "skipped" };

export function createConversationCardAccumulator(
  tabId: string,
  messageId: string,
  toolCalls: ApiToolCall[],
): {
  markDone: (toolCallId: string, card: ConversationCard) => void;
  markSkipped: (toolCallId: string) => void;
  getResolvedCards: () => ConversationCard[];
} {
  const existingCards =
    getAgentState(tabId).chatMessages.find((msg) => msg.id === messageId)
      ?.cards ?? [];
  const slotIndexByToolCallId = new Map<string, number>();
  const slots: ConversationCardSlot[] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.function.name !== "agent_card_add") continue;
    slotIndexByToolCallId.set(toolCall.id, slots.length);
    slots.push({ status: "pending" });
  }

  function publishResolvedPrefix(): void {
    if (slots.length === 0) return;
    const visibleCards: ConversationCard[] = [];
    for (const slot of slots) {
      if (slot.status === "pending") break;
      if (slot.status === "done") visibleCards.push(slot.card);
    }
    appendCardsToChatMessage(tabId, messageId, [
      ...existingCards,
      ...visibleCards,
    ]);
  }

  function updateSlot(toolCallId: string, next: ConversationCardSlot): void {
    const slotIndex = slotIndexByToolCallId.get(toolCallId);
    if (slotIndex === undefined) return;
    slots[slotIndex] = next;
    publishResolvedPrefix();
  }

  return {
    markDone(toolCallId: string, card: ConversationCard): void {
      updateSlot(toolCallId, { status: "done", card });
    },
    markSkipped(toolCallId: string): void {
      updateSlot(toolCallId, { status: "skipped" });
    },
    getResolvedCards(): ConversationCard[] {
      return slots.flatMap((slot) =>
        slot.status === "done" ? [slot.card] : [],
      );
    },
  };
}
