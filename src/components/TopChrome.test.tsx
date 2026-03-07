// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    closeTab: vi.fn(),
    reorderTabs: vi.fn(),
  },
}));

vi.mock("@/contexts/TabsContext", () => ({
  useTabs: () => tabsContextMock.value,
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

describe("TopChrome updater badge", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    jotaiStore.set(appUpdaterStateAtom, { ...defaultAppUpdaterState });
    jotaiStore.set(settingsSidebarOpenAtom, false);
    tabsContextMock.value.setActiveTab.mockReset();
    tabsContextMock.value.addTab.mockReset();
    tabsContextMock.value.closeTab.mockReset();
    tabsContextMock.value.reorderTabs.mockReset();
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
});
