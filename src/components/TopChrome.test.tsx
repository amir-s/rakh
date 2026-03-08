// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import TopChrome from "./TopChrome";
import {
  appUpdaterStateAtom,
  defaultAppUpdaterState,
  jotaiStore,
  settingsSidebarOpenAtom,
} from "@/agent/atoms";

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

describe("TopChrome", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    setNavigatorPlatform("MacIntel");
    jotaiStore.set(appUpdaterStateAtom, { ...defaultAppUpdaterState });
    jotaiStore.set(settingsSidebarOpenAtom, false);
    tabsContextMock.value.tabs = [
      {
        id: "tab-1",
        label: "Workspace",
        icon: "chat_bubble_outline",
        status: "idle",
        mode: "workspace",
      },
    ];
    tabsContextMock.value.activeTabId = "tab-1";
    tabsContextMock.value.setActiveTab.mockReset();
    tabsContextMock.value.addTab.mockReset();
    tabsContextMock.value.addTabWithId.mockReset();
    tabsContextMock.value.closeTab.mockReset();
    tabsContextMock.value.reorderTabs.mockReset();
    sessionRestoreMock.restoreMostRecentArchivedTab.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  function renderTopChrome() {
    return render(
      <Provider store={jotaiStore}>
        <TopChrome />
      </Provider>,
    );
  }

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
