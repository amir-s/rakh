import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL, patchAgentState } from "./atoms";
import {
  getAttentionToolCalls,
  resolveWorkspaceDisplayStatus,
  summarizeDesktopAgentState,
  summarizeWorkspaceTab,
} from "./desktopStatus";
import type { ChatMessage } from "./types";
import type { Tab } from "@/contexts/TabsContext";

function makeWorkspaceTab(id: string, label: string): Tab {
  return {
    id,
    label,
    icon: "chat_bubble_outline",
    status: "idle",
    mode: "workspace",
  };
}

function createMessage(toolCalls?: ChatMessage["toolCalls"]): ChatMessage {
  return {
    id: `msg-${Math.random().toString(16).slice(2)}`,
    role: "assistant",
    content: toolCalls ? "" : "Finished work.",
    timestamp: Date.now(),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function setAgentState(
  tabId: string,
  {
    chatMessages = [],
    status = "idle",
    tabTitle = "",
  }: {
    chatMessages?: ChatMessage[];
    status?: Tab["status"];
    tabTitle?: string;
  } = {},
): void {
  patchAgentState(tabId, {
    chatMessages,
    status,
    tabTitle,
    config: {
      cwd: `/tmp/${tabId}`,
      model: DEFAULT_MODEL,
    },
  });
}

describe("desktopStatus", () => {
  beforeEach(() => {
    setAgentState("tab-attention");
    setAgentState("tab-working");
    setAgentState("tab-done");
    setAgentState("tab-idle");
    setAgentState("tab-error");
  });

  it("filters only blocking tool calls that require user input", () => {
    const chatMessages = [
      createMessage([
        {
          id: "approve-1",
          tool: "exec_run",
          args: {},
          status: "awaiting_approval",
        },
        {
          id: "running-1",
          tool: "workspace_editFile",
          args: {},
          status: "running",
        },
        {
          id: "worktree-1",
          tool: "git_worktree_init",
          args: {},
          status: "awaiting_worktree",
        },
      ]),
    ];

    expect(getAttentionToolCalls(chatMessages).map((toolCall) => toolCall.id)).toEqual([
      "approve-1",
      "worktree-1",
    ]);
  });

  it("prioritizes attention over a busy base status", () => {
    const status = resolveWorkspaceDisplayStatus(
      "working",
      [
        createMessage([
          {
            id: "approve-1",
            tool: "exec_run",
            args: {},
            status: "awaiting_approval",
          },
        ]),
      ],
      "Run checks",
    );

    expect(status).toEqual({
      label: "Requires attention",
      tone: "attention",
    });
  });

  it("falls back to working when no attention state exists", () => {
    const status = resolveWorkspaceDisplayStatus("thinking", [], "");

    expect(status).toEqual({
      label: "Working",
      tone: "working",
    });
  });

  it("distinguishes done from idle based on prior activity", () => {
    setAgentState("tab-done", {
      chatMessages: [createMessage()],
      status: "idle",
    });
    setAgentState("tab-idle", {
      chatMessages: [],
      status: "idle",
    });

    expect(summarizeWorkspaceTab("tab-done", "Done Tab").bucket).toBe("done");
    expect(summarizeWorkspaceTab("tab-idle", "Idle Tab").bucket).toBe("idle");
  });

  it("treats error tabs as tray attention", () => {
    setAgentState("tab-error", {
      chatMessages: [],
      status: "error",
    });

    const summary = summarizeWorkspaceTab("tab-error", "Broken Tab");

    expect(summary.requiresAttention).toBe(true);
    expect(summary.attentionToolCalls).toEqual([]);
    expect(summary.bucket).toBe("attention");
  });

  it("aggregates tray status and keeps completed tabs out of attention counts", () => {
    setAgentState("tab-attention", {
      chatMessages: [
        createMessage([
          {
            id: "approve-1",
            tool: "request_user_input",
            args: {},
            status: "awaiting_setup_action",
          },
        ]),
      ],
      status: "working",
    });
    setAgentState("tab-working", {
      chatMessages: [],
      status: "working",
    });
    setAgentState("tab-done", {
      chatMessages: [createMessage()],
      status: "idle",
    });

    const summary = summarizeDesktopAgentState([
      makeWorkspaceTab("tab-attention", "Needs Input"),
      makeWorkspaceTab("tab-working", "Running"),
      makeWorkspaceTab("tab-done", "Finished"),
    ]);

    expect(summary.attentionCount).toBe(1);
    expect(summary.workingCount).toBe(1);
    expect(summary.doneCount).toBe(1);
    expect(summary.trayStatus).toBe("attention");
    expect(summary.menuStatusText).toBe("Status: Requires attention");
    expect(summary.menuCountsText).toBe("Attention 1 • Working 1 • Done 1");
  });
});
