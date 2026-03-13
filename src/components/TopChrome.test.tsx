// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import TopChrome from "./TopChrome";
import type { Tab } from "@/contexts/TabsContext";
import {
  DEFAULT_MODEL,
  appUpdaterStateAtom,
  defaultAppUpdaterState,
  jotaiStore,
  patchAgentState,
} from "@/agent/atoms";
import type { AgentStatus, ChatMessage } from "@/agent/types";

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
    ] as Tab[],
    activeTabId: "tab-1",
    setActiveTab: vi.fn(),
    addTab: vi.fn(),
    addTabWithId: vi.fn(),
    openSettingsTab: vi.fn(),
    closeTab: vi.fn(),
    updateTab: vi.fn(),
    reorderTabs: vi.fn(),
  },
}));

const sessionRestoreMock = vi.hoisted(() => ({
  restoreMostRecentArchivedTab: vi.fn(),
}));

vi.mock("@/contexts/TabsContext", () => ({
  useTabs: () => tabsContextMock.value,
}));

vi.mock("@/agent/sessionRestore", () => ({
  restoreMostRecentArchivedTab: (...args: unknown[]) =>
    sessionRestoreMock.restoreMostRecentArchivedTab(...args),
}));

vi.mock("@/components/ArchivedTabsMenu", () => ({
  default: () => <div data-testid="archived-tabs-menu" />,
}));

vi.mock("@/components/CloseTabModal", () => ({
  default: () => null,
}));

vi.mock("@/updater", () => ({
  shouldShowAppUpdateBadge: (state: { status: string }) =>
    state.status === "available",
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  type MotionProps = React.PropsWithChildren<Record<string, unknown>>;

  function createMotionComponent(tag: string) {
    return React.forwardRef<HTMLElement, MotionProps>(
      (
        {
          children,
          animate: _animate,
          exit: _exit,
          initial: _initial,
          layout: _layout,
          transition: _transition,
          ...props
        },
        ref,
      ) => React.createElement(tag, { ...props, ref }, children as React.ReactNode),
    );
  }

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    motion: new Proxy(
      {},
      {
        get: (_target, key) => createMotionComponent(String(key)),
      },
    ),
  };
});

function setNavigatorPlatform(value: string) {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value,
  });
}

function renderTopChrome() {
  return render(
    <Provider store={jotaiStore}>
      <TopChrome />
    </Provider>,
  );
}

function setAgentState(
  tabId: string,
  {
    chatMessages = [],
    cwd = "",
    status = "idle",
    tabTitle = "",
    worktreeBranch,
  }: {
    chatMessages?: ChatMessage[];
    cwd?: string;
    status?: AgentStatus;
    tabTitle?: string;
    worktreeBranch?: string;
  } = {},
) {
  patchAgentState(tabId, {
    chatMessages,
    config: {
      cwd,
      model: DEFAULT_MODEL,
      ...(worktreeBranch ? { worktreeBranch } : {}),
    },
    status,
    tabTitle,
  });
}

function hoverTab(label: string) {
  const tab = screen.getByText(label).closest('[role="tab"]');
  if (!(tab instanceof HTMLElement)) {
    throw new Error(`Unable to find tab for ${label}`);
  }
  fireEvent.mouseEnter(tab);
  return tab;
}

function revealTooltip() {
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

describe("TopChrome", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    setNavigatorPlatform("MacIntel");
    jotaiStore.set(appUpdaterStateAtom, { ...defaultAppUpdaterState });
    tabsContextMock.value.tabs = [
      {
        id: "tab-1",
        label: "Workspace",
        icon: "chat_bubble_outline",
        status: "idle" as const,
        mode: "workspace" as const,
      },
    ];
    tabsContextMock.value.activeTabId = "tab-1";
    tabsContextMock.value.setActiveTab.mockReset();
    tabsContextMock.value.addTab.mockReset();
    tabsContextMock.value.addTabWithId.mockReset();
    tabsContextMock.value.openSettingsTab.mockReset();
    tabsContextMock.value.closeTab.mockReset();
    tabsContextMock.value.updateTab.mockReset();
    tabsContextMock.value.reorderTabs.mockReset();
    sessionRestoreMock.restoreMostRecentArchivedTab.mockReset();
    setAgentState("tab-1");
  });

  afterEach(() => {
    cleanup();
  });

  it("hides the settings update badge when no update is available", () => {
    renderTopChrome();

    expect(screen.queryByTestId("settings-update-badge")).toBeNull();
  });

  it("shows the settings update badge when a newer release is available", () => {
    jotaiStore.set(appUpdaterStateAtom, {
      ...defaultAppUpdaterState,
      status: "available",
      availableVersion: "0.2.1",
    });

    renderTopChrome();

    expect(screen.getByTestId("settings-update-badge")).not.toBeNull();
  });

  it("opens the settings tab from the gear button", () => {
    renderTopChrome();

    fireEvent.click(screen.getByTitle("Settings"));

    expect(tabsContextMock.value.openSettingsTab).toHaveBeenCalledTimes(1);
    expect(tabsContextMock.value.openSettingsTab).toHaveBeenCalledWith();
  });

  it("uses Cmd+, on macOS to open the settings tab", () => {
    renderTopChrome();

    fireEvent.keyDown(window, { key: ",", metaKey: true });

    expect(tabsContextMock.value.openSettingsTab).toHaveBeenCalledTimes(1);
  });

  it("uses Ctrl+, on Windows to open the settings tab", () => {
    setNavigatorPlatform("Win32");
    renderTopChrome();

    fireEvent.keyDown(window, { key: ",", ctrlKey: true });

    expect(tabsContextMock.value.openSettingsTab).toHaveBeenCalledTimes(1);
  });

  it("middle-click closes the clicked tab without activating it", () => {
    tabsContextMock.value.tabs = [
      {
        id: "tab-1",
        label: "Workspace",
        icon: "chat_bubble_outline",
        status: "idle",
        mode: "workspace",
      },
      {
        id: "tab-2",
        label: "History",
        icon: "history",
        status: "idle",
        mode: "workspace",
      },
    ];

    renderTopChrome();

    const historyTab = screen.getByRole("tab", { name: /history/i });
    fireEvent.pointerDown(historyTab, { button: 1 });
    fireEvent(
      historyTab,
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );

    expect(tabsContextMock.value.closeTab).toHaveBeenCalledWith("tab-2");
    expect(tabsContextMock.value.setActiveTab).not.toHaveBeenCalled();
  });

  it("double-click toggles pinning for workspace tabs", () => {
    renderTopChrome();

    fireEvent.doubleClick(screen.getByRole("tab", { name: /workspace/i }));

    expect(tabsContextMock.value.updateTab).toHaveBeenCalledWith("tab-1", {
      pinned: true,
    });
  });

  it("shows a pinned indicator for pinned tabs", () => {
    tabsContextMock.value.tabs = [
      {
        id: "tab-1",
        label: "Workspace",
        icon: "chat_bubble_outline",
        status: "idle",
        mode: "workspace",
        pinned: true,
      },
    ];

    renderTopChrome();

    const workspaceTab = screen.getByRole("tab", { name: /workspace/i });
    expect(workspaceTab.getAttribute("data-pinned")).toBe("true");
    expect(workspaceTab.querySelector(".tab-pin-indicator--active")).not.toBeNull();
  });

  it("middle-button presses do not start drag reorder", () => {
    tabsContextMock.value.tabs = [
      {
        id: "tab-1",
        label: "Workspace",
        icon: "chat_bubble_outline",
        status: "idle",
        mode: "workspace",
      },
      {
        id: "tab-2",
        label: "History",
        icon: "history",
        status: "idle",
        mode: "workspace",
      },
    ];

    renderTopChrome();

    const workspaceTab = screen.getByRole("tab", { name: /workspace/i });
    const historyTab = screen.getByRole("tab", { name: /history/i });

    fireEvent.pointerDown(workspaceTab, { button: 1 });
    fireEvent.pointerEnter(historyTab);

    expect(tabsContextMock.value.reorderTabs).not.toHaveBeenCalled();
  });

  it("uses Cmd+Shift+T on macOS to reopen the most recent archived tab", () => {
    renderTopChrome();

    fireEvent.keyDown(window, { key: "T", metaKey: true, shiftKey: true });

    expect(sessionRestoreMock.restoreMostRecentArchivedTab).toHaveBeenCalledWith(
      tabsContextMock.value.addTabWithId,
    );
  });

  it("uses Ctrl+Shift+T on Windows to reopen the most recent archived tab", () => {
    setNavigatorPlatform("Win32");
    renderTopChrome();

    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });

    expect(sessionRestoreMock.restoreMostRecentArchivedTab).toHaveBeenCalledWith(
      tabsContextMock.value.addTabWithId,
    );
  });
});

describe("TopChrome tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cleanup();
    jotaiStore.set(appUpdaterStateAtom, { ...defaultAppUpdaterState });
    tabsContextMock.value.tabs = [
      {
        id: "tab-1",
        label: "Workspace",
        icon: "chat_bubble_outline",
        status: "idle" as const,
        mode: "workspace" as const,
      },
    ];
    tabsContextMock.value.activeTabId = "tab-1";
    patchAgentState("tab-1", {
      chatMessages: [],
      config: {
        cwd: "",
        model: DEFAULT_MODEL,
      },
      status: "idle",
      tabTitle: "",
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    cleanup();
  });

  it("shows structured tooltip content after the hover delay", () => {
    patchAgentState("tab-1", {
      chatMessages: [],
      config: {
        cwd: "/Users/amir/projects/my-project",
        model: DEFAULT_MODEL,
        worktreeBranch: "feat/auth",
      },
      status: "working",
      tabTitle: "Fix login session handling",
    });

    renderTopChrome();

    hoverTab("Workspace");
    expect(screen.queryByText("my-project [feat/auth]")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(screen.queryByText("my-project [feat/auth]")).toBeNull();

    revealTooltip();

    expect(screen.getByText("my-project [feat/auth]")).not.toBeNull();
    expect(screen.getByText("Fix login session handling")).not.toBeNull();
    expect(screen.getByText("Working")).not.toBeNull();
    expect(document.querySelector(".tab-popover__status-pill")?.textContent).toBe(
      "Working",
    );
    expect(document.querySelector(".tab-popover__header .tab-popover__status-pill")).not.toBeNull();
  });

  it("shows done for settled tabs that already produced activity", () => {
    patchAgentState("tab-1", {
      chatMessages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "Finished the refactor.",
          timestamp: 1,
        },
      ],
      config: {
        cwd: "/Users/amir/projects/refactor-db",
        model: DEFAULT_MODEL,
      },
      status: "idle",
      tabTitle: "",
    });

    renderTopChrome();

    hoverTab("Workspace");
    revealTooltip();

    expect(screen.getByText("refactor-db")).not.toBeNull();
    expect(screen.getByText("Done")).not.toBeNull();
    const popover = document.querySelector(".tab-popover");
    expect(popover?.querySelector(".tab-popover__title")).toBeNull();
  });

  it("shows a new-session fallback without an idle pill", () => {
    tabsContextMock.value.tabs = [
      {
        id: "tab-new",
        label: "New Tab",
        icon: "chat_bubble_outline",
        status: "idle" as const,
        mode: "new" as const,
      },
    ];
    tabsContextMock.value.activeTabId = "tab-new";
    patchAgentState("tab-new", {
      chatMessages: [],
      config: {
        cwd: "",
        model: DEFAULT_MODEL,
      },
      status: "idle",
      tabTitle: "",
    });

    renderTopChrome();

    hoverTab("New Tab");
    revealTooltip();

    expect(screen.getByText("New session")).not.toBeNull();
    expect(document.querySelector(".tab-popover__status-pill")).toBeNull();
  });

  it("prioritizes awaiting approval over the base agent status", () => {
    patchAgentState("tab-1", {
      chatMessages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "",
          timestamp: 1,
          toolCalls: [
            {
              id: "tc-1",
              tool: "exec_run",
              args: { cmd: "npm test" },
              status: "awaiting_approval",
            },
          ],
        },
      ],
      config: {
        cwd: "/Users/amir/projects/my-project",
        model: DEFAULT_MODEL,
      },
      status: "working",
      tabTitle: "Run checks",
    });

    renderTopChrome();

    hoverTab("Workspace");
    revealTooltip();

    expect(screen.getByText("Requires attention")).not.toBeNull();
    expect(screen.queryByText("Working")).toBeNull();
  });

  it("prioritizes awaiting worktree over other statuses", () => {
    patchAgentState("tab-1", {
      chatMessages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "",
          timestamp: 1,
          toolCalls: [
            {
              id: "tc-1",
              tool: "git_worktree_init",
              args: {},
              status: "awaiting_worktree",
            },
            {
              id: "tc-2",
              tool: "exec_run",
              args: { cmd: "npm test" },
              status: "awaiting_approval",
            },
          ],
        },
      ],
      config: {
        cwd: "/Users/amir/projects/my-project",
        model: DEFAULT_MODEL,
      },
      status: "thinking",
      tabTitle: "Prepare worktree",
    });

    renderTopChrome();

    hoverTab("Workspace");
    revealTooltip();

    expect(screen.getByText("Requires attention")).not.toBeNull();
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.queryByText("Done")).toBeNull();
  });
});
