// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import {
  agentAtomFamily,
  agentSessionPersistenceAtomFamily,
  defaultSessionPersistenceState,
  type SessionPersistenceState,
} from "@/agent/atoms";
import { buildSessionPersistenceSignature } from "@/agent/persistence";
import type { AgentState } from "@/agent/types";
import DebugPane from "./DebugPane";

const tabsContextMock = vi.hoisted(() => ({
  value: {
    tabs: [
      {
        id: "tab-1",
        label: "Workspace",
        icon: "chat_bubble_outline",
        status: "idle" as const,
        mode: "workspace" as const,
      },
    ],
    activeTabId: "tab-1",
    setActiveTab: vi.fn(),
    addTab: vi.fn(),
    addTabWithId: vi.fn(),
    closeTab: vi.fn(),
    updateTab: vi.fn(),
    reorderTabs: vi.fn(),
  },
}));

const clipboardMock = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("@/contexts/TabsContext", () => ({
  useTabs: () => tabsContextMock.value,
}));

const FAKE_PREVIEW_URL = `data:image/png;base64,${'Z'.repeat(8192)}`;

const FAKE_ATTACHMENT = {
  id: "img-1",
  name: "screenshot.png",
  previewUrl: FAKE_PREVIEW_URL,
  mimeType: "image/png",
};

function buildFixture() {
  const longSystemPrompt = "system prompt ".repeat(600);
  const longUserMessage = `attach this screenshot data:image/png;base64,${"A".repeat(4096)}`;
  const longChatMessage = "chat message ".repeat(600);
  const longStreamingContent = "stream ".repeat(1200);
  const toolArguments = JSON.stringify({
    path: "src/App.tsx",
    patch: "B".repeat(5000),
  });
  const toolResult = JSON.stringify({
    ok: true,
    output: "C".repeat(5000),
  });

  const state: AgentState = {
    status: "done",
    config: {
      cwd: "/tmp/workspace",
      model: "openai/gpt-5.2",
      contextLength: 128000,
    },
    chatMessages: [
      {
        id: "chat-user",
        role: "user",
        content: longChatMessage,
        timestamp: 1,
        attachments: [{ ...FAKE_ATTACHMENT }],
      },
      {
        id: "chat-assistant",
        role: "assistant",
        content: "Working on it",
        timestamp: 2,
        toolCalls: [
          {
            id: "call-1",
            tool: "workspace_applyPatch",
            args: {
              path: "src/App.tsx",
              patch: "D".repeat(5000),
            },
            result: {
              ok: true,
              output: "E".repeat(5000),
            },
            status: "done",
          },
        ],
      },
    ],
    apiMessages: [
      {
        role: "system",
        content: longSystemPrompt,
      },
      {
        role: "user",
        content: longUserMessage,
        attachments: [{ ...FAKE_ATTACHMENT }],
      },
      {
        role: "assistant",
        content: "Calling tool",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "workspace_applyPatch",
              arguments: toolArguments,
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        content: toolResult,
      },
    ],
    streamingContent: longStreamingContent,
    plan: {
      markdown: "",
      updatedAtMs: 0,
      version: 0,
    },
    todos: [],
    error: null,
    errorDetails: null,
    errorAction: null,
    tabTitle: "Debug test",
    reviewEdits: [],
    autoApproveEdits: false,
    autoApproveCommands: "no",
    groupInlineToolCallsOverride: null,
    queuedMessages: [],
    queueState: "idle",
    llmUsageLedger: [
      {
        id: "usage-main",
        timestamp: 3,
        modelId: "openai/gpt-5.2",
        actorKind: "main",
        actorId: "main",
        actorLabel: "Rakh",
        operation: "assistant turn",
        inputTokens: 2000,
        noCacheInputTokens: 2000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 500,
        reasoningTokens: 100,
        totalTokens: 2500,
      },
      {
        id: "usage-summary",
        timestamp: 4,
        modelId: "openai/gpt-5.2",
        actorKind: "internal",
        actorId: "context-compaction-summary",
        actorLabel: "Context compaction",
        operation: "artifact summary",
        inputTokens: 400,
        noCacheInputTokens: 400,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 80,
        reasoningTokens: 0,
        totalTokens: 480,
      },
    ],
    showDebug: true,
  };

  return {
    state,
    longSystemPrompt,
    longUserMessage,
    longChatMessage,
    longStreamingContent,
    toolArguments,
    toolResult,
  };
}

function renderDebugPane(
  state: AgentState,
  persistenceState?: Partial<SessionPersistenceState>,
) {
  const store = createStore();
  store.set(agentAtomFamily("tab-1"), state);
  store.set(agentSessionPersistenceAtomFamily("tab-1"), {
    ...defaultSessionPersistenceState,
    ...persistenceState,
  });

  return render(
    <Provider store={store}>
      <DebugPane tabId="tab-1" />
    </Provider>,
  );
}

describe("DebugPane copy bundle", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    clipboardMock.writeText.mockReset();
    clipboardMock.writeText.mockResolvedValue(undefined);
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: clipboardMock.writeText,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shrinks long message text by default but preserves tool payloads", async () => {
    const {
      state,
      longSystemPrompt,
      longChatMessage,
      longStreamingContent,
      toolArguments,
      toolResult,
    } = buildFixture();
    renderDebugPane(state);

    const shrinkButton = screen.getByRole("button", {
      name: "Shrink long messages",
    });
    expect(shrinkButton.className).toContain("chat-cycle-switch--active");

    fireEvent.click(screen.getByRole("button", { name: "COPY CONTEXT" }));

    await waitFor(() =>
      expect(clipboardMock.writeText).toHaveBeenCalledTimes(1),
    );
    const bundle = JSON.parse(clipboardMock.writeText.mock.calls[0][0]) as {
      version: number;
      copyOptions: { shrinkLongMessages: boolean };
      agent: AgentState & {
        currentContextStats: { estimatedTokens: number; pct: number | null } | null;
        sessionUsageSummary: {
          usage: { totalTokens: number };
          costStatus: string;
        } | null;
        chatMessageMetadata: Array<{
          contentChars: number;
          toolCallCount: number;
          attachmentCount: number;
          wasModifiedForCopy: boolean;
        }>;
        apiMessageMetadata: Array<{
          contentChars: number;
          toolCallCount: number;
          attachmentCount: number;
          estimatedContextTokens: number;
          wasModifiedForCopy: boolean;
        }>;
      };
    };

    expect(bundle.version).toBe(3);
    expect(bundle.copyOptions.shrinkLongMessages).toBe(true);
    const systemMessage = bundle.agent.apiMessages[0];
    if (systemMessage.role !== "system") {
      throw new Error("Expected system api message");
    }
    expect(systemMessage.content.length).toBeLessThan(longSystemPrompt.length);
    expect(systemMessage.content).toContain("truncated");

    const userMessage = bundle.agent.apiMessages[1];
    if (userMessage.role !== "user") {
      throw new Error("Expected user api message");
    }
    expect(userMessage.content).not.toContain("A".repeat(1024));
    expect(userMessage.content).toContain(
      "[truncated 4096 chars for debug copy]",
    );
    expect(bundle.agent.streamingContent?.length).toBeLessThan(
      longStreamingContent.length,
    );

    const assistantMessage = bundle.agent.apiMessages[2];
    if (assistantMessage.role !== "assistant") {
      throw new Error("Expected assistant api message");
    }
    expect(assistantMessage.tool_calls?.[0]?.function.arguments).toBe(
      toolArguments,
    );

    const toolMessage = bundle.agent.apiMessages[3];
    if (toolMessage.role !== "tool") {
      throw new Error("Expected tool api message");
    }
    expect(toolMessage.content).toBe(toolResult);

    expect(bundle.agent.chatMessages[0].content.length).toBeLessThan(
      longChatMessage.length,
    );
    expect(bundle.agent.chatMessages[1].toolCalls?.[0]?.args).toEqual(
      state.chatMessages[1].toolCalls?.[0]?.args,
    );
    expect(bundle.agent.chatMessages[1].toolCalls?.[0]?.result).toEqual(
      state.chatMessages[1].toolCalls?.[0]?.result,
    );

    // Attachments: previewUrl redacted, other fields preserved
    const chatUserMsg = bundle.agent.chatMessages[0];
    expect(chatUserMsg.attachments).toHaveLength(1);
    expect(chatUserMsg.attachments?.[0]?.previewUrl).not.toContain("base64");
    expect(chatUserMsg.attachments?.[0]?.previewUrl).toContain("redacted");
    expect(chatUserMsg.attachments?.[0]?.name).toBe("screenshot.png");
    expect(chatUserMsg.attachments?.[0]?.mimeType).toBe("image/png");

    const apiUserMsg = bundle.agent.apiMessages[1];
    if (apiUserMsg.role !== "user") throw new Error("Expected user api message");
    expect(apiUserMsg.attachments).toHaveLength(1);
    expect(apiUserMsg.attachments?.[0]?.previewUrl).not.toContain("base64");
    expect(apiUserMsg.attachments?.[0]?.previewUrl).toContain("redacted");
    expect(apiUserMsg.attachments?.[0]?.name).toBe("screenshot.png");

    expect(bundle.agent.llmUsageLedger).toEqual(state.llmUsageLedger);
    expect(bundle.agent.sessionUsageSummary?.usage.totalTokens).toBe(2980);
    expect(bundle.agent.chatMessageMetadata).toHaveLength(
      bundle.agent.chatMessages.length,
    );
    expect(bundle.agent.apiMessageMetadata).toHaveLength(
      bundle.agent.apiMessages.length,
    );
    expect(bundle.agent.currentContextStats?.estimatedTokens).toBeGreaterThan(0);
    expect(bundle.agent.chatMessageMetadata[0]).toMatchObject({
      attachmentCount: 1,
      wasModifiedForCopy: true,
    });
    expect(bundle.agent.chatMessageMetadata[1]).toMatchObject({
      toolCallCount: 1,
      wasModifiedForCopy: false,
    });
    expect(bundle.agent.apiMessageMetadata[1]).toMatchObject({
      attachmentCount: 1,
      wasModifiedForCopy: true,
    });
    expect(bundle.agent.apiMessageMetadata[2]).toMatchObject({
      toolCallCount: 1,
      wasModifiedForCopy: false,
    });
    expect(bundle.agent.apiMessageMetadata[2]?.estimatedContextTokens).toBeGreaterThan(
      0,
    );
  });

  it("copies the full bundle when shrinking is disabled", async () => {
    const { state } = buildFixture();
    renderDebugPane(state);

    fireEvent.click(
      screen.getByRole("button", { name: "Shrink long messages" }),
    );
    expect(
      screen.getByRole("button", { name: "Shrink long messages" }).className,
    ).not.toContain("chat-cycle-switch--active");

    fireEvent.click(screen.getByRole("button", { name: "COPY CONTEXT" }));

    await waitFor(() =>
      expect(clipboardMock.writeText).toHaveBeenCalledTimes(1),
    );
    const bundle = JSON.parse(clipboardMock.writeText.mock.calls[0][0]) as {
      copyOptions: { shrinkLongMessages: boolean };
      agent: AgentState & {
        chatMessageMetadata: Array<{ wasModifiedForCopy: boolean }>;
        apiMessageMetadata: Array<{ wasModifiedForCopy: boolean }>;
        sessionUsageSummary: {
          usage: { totalTokens: number };
        } | null;
      };
    };

    expect(bundle.copyOptions.shrinkLongMessages).toBe(false);
    expect(bundle.agent.apiMessages).toEqual(state.apiMessages);
    expect(bundle.agent.chatMessages).toEqual(state.chatMessages);
    expect(bundle.agent.streamingContent).toBe(state.streamingContent);
    expect(bundle.agent.sessionUsageSummary?.usage.totalTokens).toBe(2980);
    expect(
      bundle.agent.chatMessageMetadata.every((meta) => !meta.wasModifiedForCopy),
    ).toBe(true);
    expect(
      bundle.agent.apiMessageMetadata.every((meta) => !meta.wasModifiedForCopy),
    ).toBe(true);

    // Attachments preserved verbatim when shrinking is off
    expect(bundle.agent.chatMessages[0].attachments?.[0]?.previewUrl).toBe(
      FAKE_PREVIEW_URL,
    );
    const apiUserMsgFull = bundle.agent.apiMessages[1];
    if (apiUserMsgFull.role !== "user")
      throw new Error("Expected user api message");
    expect(apiUserMsgFull.attachments?.[0]?.previewUrl).toBe(FAKE_PREVIEW_URL);
  });

  it("shows whether the current session snapshot is saved or has unsaved changes", () => {
    const { state } = buildFixture();
    const workspaceTab = tabsContextMock.value.tabs[0];
    const savedSignature = buildSessionPersistenceSignature(workspaceTab, state);

    if (!savedSignature) {
      throw new Error("Expected a workspace persistence signature");
    }

    const { unmount } = renderDebugPane(state, {
      phase: "saved",
      lastSavedAtMs: 1_710_000_000_000,
      lastSavedSignature: savedSignature,
      lastSaveError: null,
    });

    expect(
      screen.getAllByText(
        (_content, node) =>
          node?.textContent?.includes("session save: saved @") ?? false,
      ),
    ).not.toHaveLength(0);

    unmount();

    renderDebugPane(
      {
        ...state,
        tabTitle: "Changed after last save",
      },
      {
        phase: "saved",
        lastSavedAtMs: 1_710_000_000_000,
        lastSavedSignature: savedSignature,
        lastSaveError: null,
      },
    );

    expect(
      screen.getAllByText(
        (_content, node) =>
          node?.textContent?.includes("session save: unsaved changes") ?? false,
      ),
    ).not.toHaveLength(0);
  });
});
