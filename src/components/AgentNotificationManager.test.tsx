// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentAtomFamily,
  jotaiStore,
  notifyOnAttentionAtom,
} from "@/agent/atoms";
import type { PersistedSession } from "@/agent/persistence";
import { TabsProvider } from "@/contexts/TabsContext";
import AgentNotificationManager from "./AgentNotificationManager";

const notificationMocks = vi.hoisted(() => ({
  showNotificationMock: vi.fn(async () => true),
  focusTabMock: vi.fn(async () => undefined),
  setAppBadgeCountMock: vi.fn(async () => undefined),
}));

vi.mock("@/notifications", () => ({
  showNotification: notificationMocks.showNotificationMock,
  focusTab: notificationMocks.focusTabMock,
  setAppBadgeCount: notificationMocks.setAppBadgeCountMock,
}));

function makeSession(id: string, label: string): PersistedSession {
  return {
    id,
    label,
    icon: "chat_bubble_outline",
    mode: "workspace",
    tabTitle: "",
    cwd: "",
    model: "",
    turnCount: 0,
    planMarkdown: "",
    planVersion: 0,
    planUpdatedAt: 0,
    chatMessages: "[]",
    apiMessages: "[]",
    reviewEdits: "[]",
    queuedMessages: "[]",
    queueState: "idle",
    llmUsageLedger: "[]",
    archived: false,
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    worktreePath: "",
    worktreeBranch: "",
    worktreeDeclined: false,
    projectPath: "",
    setupCommand: "",
    showDebug: false,
    communicationProfile: "pragmatic",
    advancedOptions: "{}",
  };
}

function setAwaitingToolCall(tabId: string, toolCallId: string) {
  const state = jotaiStore.get(agentAtomFamily(tabId));
  jotaiStore.set(agentAtomFamily(tabId), {
    ...state,
    chatMessages: [
      {
        id: `msg-${toolCallId}`,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        toolCalls: [
          {
            id: toolCallId,
            tool: "request_user_input",
            args: {},
            status: "awaiting_approval",
          },
        ],
      },
    ],
  });
}

function clearToolCalls(tabId: string) {
  const state = jotaiStore.get(agentAtomFamily(tabId));
  jotaiStore.set(agentAtomFamily(tabId), {
    ...state,
    chatMessages: [],
  });
}

function setAgentStatus(tabId: string, status: "idle" | "thinking" | "working" | "done" | "error") {
  const state = jotaiStore.get(agentAtomFamily(tabId));
  jotaiStore.set(agentAtomFamily(tabId), {
    ...state,
    status,
  });
}

function renderManager(sessions: PersistedSession[]) {
  return render(
    <Provider store={jotaiStore}>
      <TabsProvider initialSessions={sessions}>
        <AgentNotificationManager />
      </TabsProvider>
    </Provider>,
  );
}

describe("AgentNotificationManager", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    notificationMocks.showNotificationMock.mockClear();
    notificationMocks.focusTabMock.mockClear();
    notificationMocks.setAppBadgeCountMock.mockClear();
    jotaiStore.set(notifyOnAttentionAtom, true);
  });

  afterEach(() => {
    cleanup();
  });

  it("sends a notification for an awaiting tool call on an inactive tab", async () => {
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);

    renderManager([
      makeSession("tab-1", "Tab One"),
      makeSession("tab-2", "Tab Two"),
    ]);

    await act(async () => {
      setAwaitingToolCall("tab-2", "tool-1");
    });

    await waitFor(() => {
      expect(notificationMocks.showNotificationMock).toHaveBeenCalledTimes(1);
    });

    expect(notificationMocks.showNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Agent needs your input",
        options: expect.objectContaining({
          body: "Tab Two • request_user_input",
          tag: "tool-1",
        }),
      }),
    );
    expect(notificationMocks.setAppBadgeCountMock).not.toHaveBeenCalled();

    hasFocusSpy.mockRestore();
  });

  it("notifies after the window loses focus for an active tab that is still awaiting input", async () => {
    const hasFocusSpy = vi.spyOn(document, "hasFocus");
    hasFocusSpy.mockReturnValue(true);

    renderManager([makeSession("tab-active", "Focused Tab")]);

    await act(async () => {
      setAwaitingToolCall("tab-active", "tool-active");
    });

    expect(notificationMocks.showNotificationMock).not.toHaveBeenCalled();

    hasFocusSpy.mockReturnValue(false);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    await waitFor(() => {
      expect(notificationMocks.showNotificationMock).toHaveBeenCalledTimes(1);
    });
    expect(notificationMocks.setAppBadgeCountMock).toHaveBeenCalledWith(1);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(notificationMocks.showNotificationMock).toHaveBeenCalledTimes(1);

    hasFocusSpy.mockRestore();
  });

  it("badges the app when an agent finishes while the app is not focused", async () => {
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    renderManager([makeSession("tab-1", "Tab One")]);

    await act(async () => {
      setAgentStatus("tab-1", "thinking");
    });

    await act(async () => {
      setAgentStatus("tab-1", "idle");
    });

    await waitFor(() => {
      expect(notificationMocks.setAppBadgeCountMock).toHaveBeenCalledWith(1);
    });

    hasFocusSpy.mockRestore();
  });

  it("does not badge completed work while the app is focused", async () => {
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);

    renderManager([makeSession("tab-1", "Tab One")]);

    await act(async () => {
      setAgentStatus("tab-1", "thinking");
    });

    await act(async () => {
      setAgentStatus("tab-1", "idle");
    });

    expect(notificationMocks.setAppBadgeCountMock).not.toHaveBeenCalled();

    hasFocusSpy.mockRestore();
  });

  it("clears the badge when attention is resolved while unfocused", async () => {
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    renderManager([makeSession("tab-1", "Tab One")]);

    await act(async () => {
      setAwaitingToolCall("tab-1", "tool-1");
    });

    await waitFor(() => {
      expect(notificationMocks.setAppBadgeCountMock).toHaveBeenCalledWith(1);
    });

    notificationMocks.setAppBadgeCountMock.mockClear();

    await act(async () => {
      clearToolCalls("tab-1");
    });

    await waitFor(() => {
      expect(notificationMocks.setAppBadgeCountMock).toHaveBeenCalledWith(null);
    });

    hasFocusSpy.mockRestore();
  });

  it("clears unseen completion badges once the app regains focus", async () => {
    const hasFocusSpy = vi.spyOn(document, "hasFocus");
    hasFocusSpy.mockReturnValue(false);

    renderManager([makeSession("tab-1", "Tab One")]);

    await act(async () => {
      setAgentStatus("tab-1", "thinking");
    });

    await act(async () => {
      setAgentStatus("tab-1", "idle");
    });

    await waitFor(() => {
      expect(notificationMocks.setAppBadgeCountMock).toHaveBeenCalledWith(1);
    });

    notificationMocks.setAppBadgeCountMock.mockClear();
    hasFocusSpy.mockReturnValue(true);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(notificationMocks.setAppBadgeCountMock).toHaveBeenCalledWith(null);
    });

    hasFocusSpy.mockRestore();
  });

  it("badges with the number of unique tabs needing attention or having unseen completion", async () => {
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    renderManager([
      makeSession("tab-1", "Tab One"),
      makeSession("tab-2", "Tab Two"),
      makeSession("tab-3", "Tab Three"),
    ]);

    await act(async () => {
      setAwaitingToolCall("tab-1", "tool-1");
      setAgentStatus("tab-2", "thinking");
    });

    await act(async () => {
      setAgentStatus("tab-2", "idle");
    });

    await waitFor(() => {
      expect(notificationMocks.setAppBadgeCountMock).toHaveBeenLastCalledWith(2);
    });

    await act(async () => {
      setAgentStatus("tab-1", "thinking");
    });

    await act(async () => {
      setAgentStatus("tab-1", "idle");
    });

    await waitFor(() => {
      expect(notificationMocks.setAppBadgeCountMock).toHaveBeenLastCalledWith(2);
    });

    hasFocusSpy.mockRestore();
  });
});
