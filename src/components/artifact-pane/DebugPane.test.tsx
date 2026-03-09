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
import { agentAtomFamily } from "@/agent/atoms";
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

function renderDebugPane(state: AgentState) {
  const store = createStore();
  store.set(agentAtomFamily("tab-1"), state);

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
      copyOptions: { shrinkLongMessages: boolean };
      agent: AgentState;
    };

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
      agent: AgentState;
    };

    expect(bundle.copyOptions.shrinkLongMessages).toBe(false);
    expect(bundle.agent.apiMessages).toEqual(state.apiMessages);
    expect(bundle.agent.chatMessages).toEqual(state.chatMessages);
    expect(bundle.agent.streamingContent).toBe(state.streamingContent);

    // Attachments preserved verbatim when shrinking is off
    expect(bundle.agent.chatMessages[0].attachments?.[0]?.previewUrl).toBe(
      FAKE_PREVIEW_URL,
    );
    const apiUserMsgFull = bundle.agent.apiMessages[1];
    if (apiUserMsgFull.role !== "user")
      throw new Error("Expected user api message");
    expect(apiUserMsgFull.attachments?.[0]?.previewUrl).toBe(FAKE_PREVIEW_URL);
  });
});
