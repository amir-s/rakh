// @vitest-environment jsdom

import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { TabsProvider, useTabs } from "@/contexts/TabsContext";
import {
  appUpdaterStateAtom,
  defaultAppUpdaterState,
  jotaiStore,
} from "@/agent/atoms";
import { providersAtom } from "@/agent/db";
import SettingsPage from "./SettingsPage";

const updaterMocks = vi.hoisted(() => ({
  checkForAppUpdatesMock: vi.fn<() => Promise<void>>(),
  installAppUpdateMock: vi.fn<
    (options?: { beforeInstall?: () => Promise<void> }) => Promise<void>
  >(),
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
  upsertWorkspaceSessions: vi.fn(async () => undefined),
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

function SettingsPageHarness({
  initialSection = "appearance",
}: {
  initialSection?: "appearance" | "updates";
}) {
  const { openSettingsTab } = useTabs();

  useEffect(() => {
    openSettingsTab(initialSection);
  }, [initialSection, openSettingsTab]);

  return <SettingsPage />;
}

function renderSettingsPage(initialSection: "appearance" | "updates" = "appearance") {
  return render(
    <Provider store={jotaiStore}>
      <TabsProvider>
        <SettingsPageHarness initialSection={initialSection} />
      </TabsProvider>
    </Provider>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
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
  });

  afterEach(() => {
    cleanup();
  });

  it("renders grouped navigation and the selected section", async () => {
    renderSettingsPage("updates");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "App Updates" })).not.toBeNull();
    });

    expect(screen.getByText("General")).not.toBeNull();
    expect(screen.getByText("AI")).not.toBeNull();
    expect(screen.getByText("App")).not.toBeNull();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /Check for updates/i }),
    ).not.toBeNull();
  });

  it("switches sections through the left navigation", async () => {
    renderSettingsPage("updates");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "App Updates" })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /Appearance/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Appearance" })).not.toBeNull();
    });
    expect(screen.getByText("Theme & Mode")).not.toBeNull();
    expect(screen.getByText("Theme")).not.toBeNull();
  });
});
