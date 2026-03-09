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
}));

vi.mock("@/notifications", () => ({
  showNotification: notificationMocks.showNotificationMock,
  focusTab: notificationMocks.focusTabMock,
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
    planMarkdown: "",
    planVersion: 0,
    planUpdatedAt: 0,
    chatMessages: "[]",
    apiMessages: "[]",
    todos: "[]",
    reviewEdits: "[]",
    queuedMessages: "[]",
    queueState: "idle",
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    worktreePath: "",
    worktreeBranch: "",
    worktreeDeclined: false,
    showDebug: false,
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

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(notificationMocks.showNotificationMock).toHaveBeenCalledTimes(1);

    hasFocusSpy.mockRestore();
  });
});
