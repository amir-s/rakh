import type { ChatBubbleGroup } from "@/agent/chatBubbleGroups";
import type {
  AgentState,
  ApiMessage,
  AttachedImage,
  ChatMessage,
  ConversationCard,
  ToolCallDisplay,
} from "@/agent/types";

const EMPTY_PLAN = {
  markdown: "",
  updatedAtMs: 0,
  version: 0,
} as const;

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  return (
    JSON.stringify(
      value,
      (_key, current) => {
        if (typeof current === "bigint") return current.toString();
        if (typeof current === "function") {
          return `[Function${current.name ? `: ${current.name}` : ""}]`;
        }
        if (current instanceof Error) {
          return {
            name: current.name,
            message: current.message,
            stack: current.stack,
          };
        }
        if (current && typeof current === "object") {
          if (seen.has(current as object)) return "[Circular]";
          seen.add(current as object);
        }
        return current;
      },
      2,
    ) ?? String(value)
  );
}

function joinMarkdownSections(sections: Array<string | null | undefined>): string {
  return sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join("\n\n")
    .trim();
}

function serializeAttachments(attachments?: AttachedImage[]): string | null {
  if (!attachments?.length) return null;
  return joinMarkdownSections([
    "### Attachments",
    attachments
      .map((attachment) => `- ${attachment.name} (${attachment.mimeType})`)
      .join("\n"),
  ]);
}

function serializeToolCall(toolCall: ToolCallDisplay, index: number): string {
  const sections = [
    `#### ${index + 1}. \`${toolCall.tool}\``,
    toolCall.status !== "done" ? `Status: \`${toolCall.status}\`` : null,
    joinMarkdownSections([
      "Args:",
      `\`\`\`json\n${safeJsonStringify(toolCall.args)}\n\`\`\``,
    ]),
    toolCall.streamingOutput
      ? joinMarkdownSections([
          "Output:",
          `\`\`\`\n${toolCall.streamingOutput.trim()}\n\`\`\``,
        ])
      : null,
    toolCall.result !== undefined
      ? joinMarkdownSections([
          "Result:",
          `\`\`\`json\n${safeJsonStringify(toolCall.result)}\n\`\`\``,
        ])
      : null,
  ];

  return joinMarkdownSections(sections);
}

function serializeConversationCard(card: ConversationCard, index: number): string {
  if (card.kind === "summary") {
    return joinMarkdownSections([
      `#### ${index + 1}. ${card.title ?? "Summary"}`,
      card.markdown,
    ]);
  }

  return joinMarkdownSections([
    `#### ${index + 1}. ${card.title ?? "Artifact"}`,
    `Artifact ID: \`${card.artifactId}\``,
    typeof card.version === "number" ? `Version: \`${card.version}\`` : null,
  ]);
}

function serializeAssistantMessage(message: ChatMessage): string | null {
  const sections = [
    message.content.trim() || null,
    message.toolCalls?.length
      ? joinMarkdownSections([
          "### Tool usage",
          message.toolCalls.map((toolCall, index) => serializeToolCall(toolCall, index)).join("\n\n"),
        ])
      : null,
    message.cards?.length
      ? joinMarkdownSections([
          "### Cards",
          message.cards.map((card, index) => serializeConversationCard(card, index)).join("\n\n"),
        ])
      : null,
  ];

  return joinMarkdownSections(sections);
}

export function serializeChatBubbleGroupAsMarkdown(group: ChatBubbleGroup): string {
  if (group.kind === "user") {
    return joinMarkdownSections([
      "## You",
      serializeAttachments(group.message.attachments),
      group.message.content.trim(),
    ]);
  }

  const agentName = group.agentName ?? "Rakh";
  return joinMarkdownSections([
    `## ${agentName}`,
    ...group.messages.map((message) => serializeAssistantMessage(message)),
  ]);
}

function countUserMessages(messages: ChatMessage[]): number {
  return messages.reduce(
    (count, message) => count + (message.role === "user" ? 1 : 0),
    0,
  );
}

function isApiBackedAssistantChatMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.agentName) return false;
  return (
    (typeof message.traceId === "string" && message.traceId.length > 0) ||
    (message.toolCalls?.length ?? 0) > 0
  );
}

function truncateApiMessagesForChatPrefix(
  apiMessages: ApiMessage[],
  chatMessages: ChatMessage[],
): ApiMessage[] {
  if (apiMessages.length === 0) return [];

  const result: ApiMessage[] = [];
  let startIndex = 0;
  if (apiMessages[0]?.role === "system") {
    result.push(deepClone(apiMessages[0]));
    startIndex = 1;
  }

  const targetUserCount = countUserMessages(chatMessages);
  const targetAssistantCount = chatMessages.reduce(
    (count, message) => count + (isApiBackedAssistantChatMessage(message) ? 1 : 0),
    0,
  );

  let includedUserCount = 0;
  let includedAssistantCount = 0;
  let keepToolMessages = false;

  for (let index = startIndex; index < apiMessages.length; index += 1) {
    const message = apiMessages[index];

    if (message.role === "user") {
      if (includedUserCount >= targetUserCount) break;
      includedUserCount += 1;
      keepToolMessages = false;
      result.push(deepClone(message));
      continue;
    }

    if (message.role === "assistant") {
      if (includedAssistantCount >= targetAssistantCount) break;
      includedAssistantCount += 1;
      keepToolMessages = true;
      result.push(deepClone(message));
      continue;
    }

    if (!keepToolMessages) break;
    result.push(deepClone(message));
  }

  return result;
}

export function bubbleGroupContainsStreaming(group: ChatBubbleGroup): boolean {
  if (group.kind === "user") return false;
  return group.messages.some(
    (message) => message.streaming || message.reasoningStreaming,
  );
}

export function buildForkedAgentState(
  state: AgentState,
  messageIds: string[],
): AgentState | null {
  if (messageIds.length === 0) return null;

  const messageIdSet = new Set(messageIds);
  let boundaryIndex = -1;
  for (let index = 0; index < state.chatMessages.length; index += 1) {
    if (messageIdSet.has(state.chatMessages[index].id)) {
      boundaryIndex = index;
    }
  }

  if (boundaryIndex < 0) return null;

  const boundaryIsLatest = boundaryIndex === state.chatMessages.length - 1;
  const chatMessages = deepClone(state.chatMessages.slice(0, boundaryIndex + 1));
  const forkedState = deepClone(state);

  forkedState.status = "idle";
  forkedState.turnCount = countUserMessages(chatMessages);
  forkedState.chatMessages = chatMessages;
  forkedState.apiMessages = boundaryIsLatest
    ? deepClone(state.apiMessages)
    : truncateApiMessagesForChatPrefix(state.apiMessages, chatMessages);
  forkedState.streamingContent = null;
  forkedState.error = null;
  forkedState.errorAction = null;
  forkedState.errorDetails = null;
  forkedState.queuedMessages = [];
  forkedState.queueState = "idle";
  forkedState.lastRunTraceId = undefined;

  if (!boundaryIsLatest) {
    forkedState.plan = { ...EMPTY_PLAN };
    forkedState.todos = [];
    forkedState.reviewEdits = [];
    forkedState.llmUsageLedger = [];
  }

  return forkedState;
}
