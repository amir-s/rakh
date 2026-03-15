import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  generateObjectMock,
  resolveLanguageModelMock,
  buildProviderOptionsMock,
  applyTodoContextEnrichmentMock,
  logFrontendSoonMock,
} = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  resolveLanguageModelMock: vi.fn(),
  buildProviderOptionsMock: vi.fn(),
  applyTodoContextEnrichmentMock: vi.fn(),
  logFrontendSoonMock: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

vi.mock("./providerOptions", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModelMock(...args),
  buildProviderOptions: (...args: unknown[]) => buildProviderOptionsMock(...args),
}));

vi.mock("../tools/todos", () => ({
  applyTodoContextEnrichment: (...args: unknown[]) =>
    applyTodoContextEnrichmentMock(...args),
}));

vi.mock("@/logging/client", async () => {
  const actual = await vi.importActual<typeof import("@/logging/client")>(
    "@/logging/client",
  );
  return {
    ...actual,
    logFrontendSoon: (...args: unknown[]) => logFrontendSoonMock(...args),
  };
});

import { registerDynamicModels } from "../modelCatalog";
import type { AgentPlan, ApiMessage, TodoItem } from "../types";
import { executeThroughContextGateway } from "./contextGateway";

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: "todo-1",
    title: "Implement compaction",
    state: "doing",
    owner: "main",
    createdTurn: 2,
    updatedTurn: 3,
    lastTouchedTurn: 3,
    filesTouched: ["src/agent/runner/contextGateway.ts"],
    thingsLearned: [
      {
        id: "note-agent",
        text: "The policy should preserve the leading system prompt.",
        addedTurn: 3,
        author: "main",
        source: "agent",
        verified: false,
      },
    ],
    criticalInfo: [],
    mutationLog: [],
    ...overrides,
  };
}

function makePlan(): AgentPlan {
  return {
    markdown: "1. Compact API history\n2. Enrich todo notes",
    updatedAtMs: 123,
    version: 2,
  };
}

function makeMessages(): ApiMessage[] {
  return [
    { role: "system", content: "system prompt" },
    { role: "assistant", content: "A".repeat(420) },
    { role: "user", content: "Continue implementing the todo compactor." },
  ];
}

describe("context gateway", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    resolveLanguageModelMock.mockReset();
    buildProviderOptionsMock.mockReset();
    applyTodoContextEnrichmentMock.mockReset();
    logFrontendSoonMock.mockReset();

    registerDynamicModels([
      {
        id: "openai/gpt-5.2",
        name: "GPT 5.2",
        providerId: "provider-openai",
        owned_by: "openai",
        tags: [],
        context_length: 200_000,
        sdk_id: "gpt-5.2",
      },
      {
        id: "openai/gpt-5.2-codex",
        name: "GPT 5.2 Codex",
        providerId: "provider-openai",
        owned_by: "openai",
        tags: [],
        context_length: 200_000,
        sdk_id: "gpt-5.2-codex",
      },
    ]);

    resolveLanguageModelMock.mockImplementation((modelId: string) => ({ modelId }));
    buildProviderOptionsMock.mockReturnValue(undefined);
    generateObjectMock.mockResolvedValue({
      object: {
        summary: "Continue by updating the compaction policy and validating todo note metadata.",
        todoUpdates: [],
      },
    });
    applyTodoContextEnrichmentMock.mockResolvedValue({
      ok: true,
      data: { items: [makeTodo()] },
    });
  });

  it("is a no-op when disabled", async () => {
    const messages = makeMessages();

    const result = await executeThroughContextGateway({
      messages,
      plan: makePlan(),
      todos: [makeTodo()],
      providers: [],
      stateSnapshot: {
        tabId: "tab-1",
        runId: "run-1",
        agentId: "agent_main",
        modelId: "openai/gpt-5.2",
        currentTurn: 7,
        messageCount: messages.length,
        contextLength: 100,
      },
      configProvider: {
        getConfig: () => ({
          enabled: false,
          todoNormalization: {
            enabled: true,
            triggerMinContextUsagePct: 75,
            replaceApiMessagesAfterCompaction: true,
            modelStrategy: "override",
            overrideModelId: "openai/gpt-5.2-codex",
          },
        }),
      },
    });

    expect(result).toEqual({ messages });
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("is a no-op below the configured threshold", async () => {
    const messages: ApiMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "small" },
    ];

    const result = await executeThroughContextGateway({
      messages,
      plan: makePlan(),
      todos: [makeTodo()],
      providers: [],
      stateSnapshot: {
        tabId: "tab-1",
        runId: "run-1",
        agentId: "agent_main",
        modelId: "openai/gpt-5.2",
        currentTurn: 7,
        messageCount: messages.length,
        contextLength: 10_000,
      },
    });

    expect(result).toEqual({ messages });
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("never runs for subagents", async () => {
    const messages = makeMessages();

    const result = await executeThroughContextGateway({
      messages,
      plan: makePlan(),
      todos: [makeTodo()],
      providers: [],
      stateSnapshot: {
        tabId: "tab-1",
        runId: "run-1",
        agentId: "agent_planner",
        modelId: "openai/gpt-5.2",
        currentTurn: 7,
        messageCount: messages.length,
        contextLength: 100,
      },
    });

    expect(result).toEqual({ messages });
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("uses the override model, enriches todos, returns replacement api messages, and emits a debug card when enabled", async () => {
    const messages = makeMessages();
    const enrichedTodo = makeTodo({
      thingsLearned: [
        {
          id: "note-agent",
          text: "The policy should preserve the leading system prompt.",
          addedTurn: 3,
          author: "main",
          source: "agent",
          verified: true,
        },
        {
          id: "note-cg",
          text: "The compactor replaces apiMessages but keeps chatMessages.",
          addedTurn: 7,
          author: "context_gateway",
          source: "context_gateway",
          verified: true,
        },
      ],
    });
    generateObjectMock.mockResolvedValue({
      object: {
        summary: "Continue by using the compacted system context and the normalized todo notes.",
        todoUpdates: [
          {
            todoId: "todo-1",
            verifyThingsLearnedNoteIds: ["note-agent"],
            appendThingsLearned: [
              "The compactor replaces apiMessages but keeps chatMessages.",
            ],
            verifyCriticalInfoNoteIds: [],
            appendCriticalInfo: [],
            removeDuplicateThingsLearnedNoteIds: [],
            removeDuplicateCriticalInfoNoteIds: [],
          },
        ],
      },
    });
    applyTodoContextEnrichmentMock.mockResolvedValue({
      ok: true,
      data: { items: [enrichedTodo] },
    });

    const result = await executeThroughContextGateway({
      messages,
      plan: makePlan(),
      todos: [makeTodo()],
      providers: [
        {
          id: "provider-openai",
          name: "OpenAI",
          type: "openai",
          apiKey: "test-key",
        },
      ],
      debugEnabled: true,
      stateSnapshot: {
        tabId: "tab-1",
        runId: "run-1",
        agentId: "agent_main",
        modelId: "openai/gpt-5.2",
        currentTurn: 7,
        messageCount: messages.length,
        contextLength: 100,
        activeTodoId: "todo-1",
      },
    });

    expect(resolveLanguageModelMock).toHaveBeenCalledWith(
      "openai/gpt-5.2-codex",
      expect.any(Array),
    );
    expect(applyTodoContextEnrichmentMock).toHaveBeenCalledWith("tab-1", {
      turn: 7,
      updates: [
        {
          todoId: "todo-1",
          verifyThingsLearnedNoteIds: ["note-agent"],
          appendThingsLearned: [
            "The compactor replaces apiMessages but keeps chatMessages.",
          ],
          verifyCriticalInfoNoteIds: [],
          appendCriticalInfo: [],
          removeDuplicateThingsLearnedNoteIds: [],
          removeDuplicateCriticalInfoNoteIds: [],
        },
      ],
    });
    expect(result.replacementApiMessages).toBeDefined();
    expect(result.replacementApiMessages?.[0]).toMatchObject({
      role: "system",
      content: "system prompt",
    });
    expect(result.replacementApiMessages?.[1]).toMatchObject({
      role: "system",
    });
    expect(result.replacementApiMessages?.[1]?.content).toContain(
      "COMPACTED SESSION CONTEXT",
    );
    expect(result.replacementApiMessages?.[1]?.content).toContain(
      "The compactor replaces apiMessages but keeps chatMessages.",
    );
    expect(result.replacementApiMessages?.at(-1)).toMatchObject({
      role: "user",
      content: "Continue implementing the todo compactor.",
    });
    expect(result.messages).toEqual(result.replacementApiMessages);
    expect(result.debugChatMessage).toMatchObject({
      role: "assistant",
      badge: "DEBUG",
      content: "ContextGateway compacted the API context. Debug snapshot below.",
      cards: [
        {
          kind: "summary",
          title: "ContextGateway Compaction",
        },
      ],
    });
    expect(result.debugChatMessage?.cards?.[0]).toMatchObject({
      kind: "summary",
      title: "ContextGateway Compaction",
    });
    expect(result.debugChatMessage?.cards?.[0]?.kind).toBe("summary");
    expect(
      (
        result.debugChatMessage?.cards?.[0] &&
        "markdown" in result.debugChatMessage.cards[0]
      )
        ? result.debugChatMessage.cards[0].markdown
        : "",
    ).toContain('"todos"');
    expect(
      (
        result.debugChatMessage?.cards?.[0] &&
        "markdown" in result.debugChatMessage.cards[0]
      )
        ? result.debugChatMessage.cards[0].markdown
        : "",
    ).toContain('"apiMessages"');
    expect(
      (
        result.debugChatMessage?.cards?.[0] &&
        "markdown" in result.debugChatMessage.cards[0]
      )
        ? result.debugChatMessage.cards[0].markdown
        : "",
    ).toContain("### Before");
    expect(
      (
        result.debugChatMessage?.cards?.[0] &&
        "markdown" in result.debugChatMessage.cards[0]
      )
        ? result.debugChatMessage.cards[0].markdown
        : "",
    ).toContain("### After");
  });
});
