import { describe, expect, it } from "vitest";
import type { AgentState, ChatMessage } from "@/agent/types";
import {
  buildForkedAgentState,
  serializeChatBubbleGroupAsMarkdown,
} from "@/agent/chatBubbleActions";

function makeBaseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    status: "done",
    config: {
      cwd: "/repo",
      model: "openai/gpt-5.2",
    },
    turnCount: 2,
    chatMessages: [],
    apiMessages: [],
    streamingContent: null,
    plan: {
      markdown: "Current plan",
      updatedAtMs: 10,
      version: 1,
    },
    todos: [],
    error: null,
    errorDetails: null,
    errorAction: null,
    tabTitle: "Task",
    reviewEdits: [],
    autoApproveEdits: false,
    autoApproveCommands: "no",
    groupInlineToolCallsOverride: null,
    queuedMessages: [],
    queueState: "idle",
    llmUsageLedger: [],
    showDebug: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "msg-1",
    role: "assistant",
    content: "",
    timestamp: 1,
    ...overrides,
  };
}

function makeAssistantMessage(
  overrides: Partial<ChatMessage> = {},
): ChatMessage & { role: "assistant" } {
  return makeMessage({
    role: "assistant",
    ...overrides,
  }) as ChatMessage & { role: "assistant" };
}

describe("chatBubbleActions", () => {
  it("serializes assistant bubbles as markdown without reasoning blocks", () => {
    const markdown = serializeChatBubbleGroupAsMarkdown({
      kind: "assistant",
      key: "assistant:1",
      messages: [
        makeAssistantMessage({
          content: "Implemented the change.",
          reasoning: "Inspect files first.",
          toolCalls: [
            {
              id: "tc-1",
              tool: "workspace_readFile",
              args: { path: "src/App.tsx" },
              result: { ok: true, data: "file contents" },
              status: "done",
            },
          ],
        }),
      ],
    });

    expect(markdown).toContain("## Rakh");
    expect(markdown).toContain("Implemented the change.");
    expect(markdown).toContain("### Tool usage");
    expect(markdown).toContain("workspace_readFile");
    expect(markdown).not.toContain("Inspect files first.");
  });

  it("forks an earlier bubble into an idle truncated session", () => {
    const chatMessages = [
      makeMessage({
        id: "user-1",
        role: "user",
        content: "First",
        timestamp: 1,
      }),
      makeMessage({
        id: "assistant-1",
        content: "Answer",
        timestamp: 2,
        traceId: "trace-1",
      }),
      makeMessage({
        id: "user-2",
        role: "user",
        content: "Later",
        timestamp: 3,
      }),
    ];
    const state = makeBaseState({
      chatMessages,
      apiMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "First" },
        { role: "assistant", content: "Answer" },
        { role: "user", content: "Later" },
      ],
      todos: [
        {
          id: "todo-1",
          title: "Later state",
          state: "todo",
          owner: "main",
          createdTurn: 2,
          updatedTurn: 2,
          lastTouchedTurn: 2,
          filesTouched: [],
          thingsLearned: [],
          criticalInfo: [],
          mutationLog: [],
        },
      ],
      llmUsageLedger: [
        {
          id: "usage-1",
          timestamp: 1,
          modelId: "openai/gpt-5.2",
          actorKind: "main",
          actorId: "main",
          actorLabel: "Rakh",
          operation: "assistant turn",
          inputTokens: 1,
          noCacheInputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
          totalTokens: 2,
        },
      ],
    });

    const forked = buildForkedAgentState(state, ["assistant-1"]);

    expect(forked).not.toBeNull();
    expect(forked?.status).toBe("idle");
    expect(forked?.chatMessages).toEqual(chatMessages.slice(0, 2));
    expect(forked?.apiMessages).toEqual(state.apiMessages.slice(0, 3));
    expect(forked?.plan).toEqual({
      markdown: "",
      updatedAtMs: 0,
      version: 0,
    });
    expect(forked?.todos).toEqual([]);
    expect(forked?.llmUsageLedger).toEqual([]);
  });
});
