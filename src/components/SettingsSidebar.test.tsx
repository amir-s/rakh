// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider } from "jotai";
import SettingsSidebar from "./SettingsSidebar";
import {
  appUpdaterStateAtom,
  defaultAppUpdaterState,
  jotaiStore,
  settingsSidebarOpenAtom,
} from "@/agent/atoms";
import { providersAtom } from "@/agent/db";

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

const updaterMocks = vi.hoisted(() => ({
  checkForAppUpdatesMock: vi.fn<() => Promise<void>>(),
  installAppUpdateMock: vi.fn<
    (options?: { beforeInstall?: () => Promise<void> }) => Promise<void>
  >(),
}));

const upsertWorkspaceSessionsMock = vi.hoisted(() =>
  vi.fn<(tabs: unknown[]) => Promise<void>>(),
);

vi.mock("@/contexts/TabsContext", () => ({
  useTabs: () => tabsContextMock.value,
}));

vi.mock("@/agent/useEnvProviderKeys", () => ({
  useEnvProviderKeys: () => [],
  isTauriRuntime: () => false,
  buildUniqueProviderName: (baseName: string) => baseName,
}));

vi.mock("@/notifications", () => ({
  ensureNotificationPermission: vi.fn(async () => true),
}));

vi.mock("@/agent/persistence", () => ({
  upsertWorkspaceSessions: (tabs: unknown[]) =>
    upsertWorkspaceSessionsMock(tabs),
}));

vi.mock("@/updater", () => ({
  checkForAppUpdates: () => updaterMocks.checkForAppUpdatesMock(),
  installAppUpdate: (options?: { beforeInstall?: () => Promise<void> }) =>
    updaterMocks.installAppUpdateMock(options),
  getAppUpdaterProgressValue: (state: {
    downloadedBytes: number;
    contentLength: number | null;
  }) => {
    if (!state.contentLength || state.contentLength <= 0) return null;
    return Math.min(
      100,
      Math.round((state.downloadedBytes / state.contentLength) * 100),
    );
  },
  getAppUpdaterStatusLabel: (state: { status: string }) => {
    switch (state.status) {
      case "available":
        return "Update ready";
      case "checking":
        return "Checking";
      case "installing":
        return "Installing";
      case "up-to-date":
        return "Up to date";
      default:
        return "Not checked";
    }
  },
  getAppUpdaterStatusVariant: (state: { status: string }) => {
    switch (state.status) {
      case "available":
        return "primary";
      case "up-to-date":
        return "success";
      case "error":
        return "danger";
      default:
        return "muted";
    }
  },
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

describe("SettingsSidebar updater section", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    jotaiStore.set(settingsSidebarOpenAtom, true);
    jotaiStore.set(providersAtom, []);
    jotaiStore.set(appUpdaterStateAtom, {
      ...defaultAppUpdaterState,
      status: "available",
      availableVersion: "0.2.1",
      availableDate: "2026-03-07",
      releaseNotes: "Updater integration is now available.",
      lastCheckedAt: Date.now(),
    });
    updaterMocks.checkForAppUpdatesMock.mockReset();
    updaterMocks.installAppUpdateMock.mockReset();
    updaterMocks.checkForAppUpdatesMock.mockResolvedValue(undefined);
    updaterMocks.installAppUpdateMock.mockResolvedValue(undefined);
    upsertWorkspaceSessionsMock.mockReset();
    upsertWorkspaceSessionsMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderSettingsSidebar() {
    return render(
      <Provider store={jotaiStore}>
        <SettingsSidebar />
      </Provider>,
    );
  }

  it("renders the updater details and actions in the settings sidebar", () => {
    renderSettingsSidebar();

    expect(
      screen.getByRole("heading", { name: "App Updates" }),
    ).not.toBeNull();
    expect(screen.getByText("Signed releases are delivered from GitHub Releases.")).not.toBeNull();
    expect(screen.getByText("Current version")).not.toBeNull();
    expect(screen.getByText("Available version")).not.toBeNull();
    expect(screen.getByText("Update ready")).not.toBeNull();
    expect(screen.getByText("Updater integration is now available.")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /Check for updates/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /Install v0\.2\.1/i }),
    ).not.toBeNull();
  });

  it("checks for updates and persists workspace tabs before install", async () => {
    updaterMocks.installAppUpdateMock.mockImplementation(async (options) => {
      await options?.beforeInstall?.();
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderSettingsSidebar();

    fireEvent.click(
      screen.getByRole("button", { name: /Check for updates/i }),
    );
    await waitFor(() =>
      expect(updaterMocks.checkForAppUpdatesMock).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole("button", { name: /Install v0\.2\.1/i }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(updaterMocks.installAppUpdateMock).toHaveBeenCalledTimes(1),
    );
    expect(upsertWorkspaceSessionsMock).toHaveBeenCalledWith(
      tabsContextMock.value.tabs,
    );
  });
});
