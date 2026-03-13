// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const notificationMocks = vi.hoisted(() => ({
  isPermissionGrantedMock: vi.fn(async () => true),
  requestPermissionMock: vi.fn(async () => "granted" as const),
  isMinimizedMock: vi.fn(async () => true),
  unminimizeMock: vi.fn(async () => undefined),
  showMock: vi.fn(async () => undefined),
  setFocusMock: vi.fn(async () => undefined),
  currentWindowLabel: "main",
  instances: [] as Array<{
    title: string;
    options?: NotificationOptions;
    close: ReturnType<typeof vi.fn>;
    onclick: null | (() => void);
  }>,
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: notificationMocks.isPermissionGrantedMock,
  requestPermission: notificationMocks.requestPermissionMock,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: notificationMocks.currentWindowLabel,
    isMinimized: () => notificationMocks.isMinimizedMock(),
    unminimize: () => notificationMocks.unminimizeMock(),
    show: () => notificationMocks.showMock(),
    setFocus: () => notificationMocks.setFocusMock(),
  }),
}));

describe("notifications", () => {
  beforeEach(() => {
    vi.resetModules();
    notificationMocks.isPermissionGrantedMock.mockClear();
    notificationMocks.requestPermissionMock.mockClear();
    notificationMocks.isMinimizedMock.mockClear();
    notificationMocks.unminimizeMock.mockClear();
    notificationMocks.showMock.mockClear();
    notificationMocks.setFocusMock.mockClear();
    notificationMocks.currentWindowLabel = "main";
    notificationMocks.instances = [];

    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    window.history.replaceState({}, "", "/");

    class MockNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission = vi.fn(
        async () => "granted" as NotificationPermission,
      );
      onclick: null | (() => void) = null;
      close = vi.fn();

      constructor(
        public title: string,
        public options?: NotificationOptions,
      ) {
        notificationMocks.instances.push(this);
      }
    }

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: MockNotification,
    });
  });

  it("uses the browser notification API in Tauri and wires click handling directly", async () => {
    const { showNotification } = await import("./notifications");
    const onClick = vi.fn();

    const sent = await showNotification({
      title: "Agent needs your input",
      options: { body: "Workspace • request_user_input" },
      onClick,
    });

    expect(sent).toBe(true);
    expect(notificationMocks.instances).toHaveLength(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(notificationMocks.instances[0]?.options?.icon).toBe("icons/icon.png");

    notificationMocks.instances[0]?.onclick?.();

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(notificationMocks.instances[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("does not query notification permissions in the detached logs window", async () => {
    window.history.replaceState({}, "", "/?window=logs");
    const { ensureNotificationPermission } = await import("./notifications");

    const granted = await ensureNotificationPermission();

    expect(granted).toBe(false);
    expect(notificationMocks.isPermissionGrantedMock).not.toHaveBeenCalled();
    expect(notificationMocks.requestPermissionMock).not.toHaveBeenCalled();
  });

  it("does not query notification permissions when the current Tauri window label is logs", async () => {
    window.history.replaceState({}, "", "/");
    notificationMocks.currentWindowLabel = "logs";
    const { ensureNotificationPermission } = await import("./notifications");

    const granted = await ensureNotificationPermission();

    expect(granted).toBe(false);
    expect(notificationMocks.isPermissionGrantedMock).not.toHaveBeenCalled();
    expect(notificationMocks.requestPermissionMock).not.toHaveBeenCalled();
  });

  it("can activate a tab without redundantly refocusing the window", async () => {
    const windowFocusSpy = vi
      .spyOn(window, "focus")
      .mockImplementation(() => undefined);
    const { focusTab } = await import("./notifications");
    const setActiveTab = vi.fn();

    await focusTab("tab-2", setActiveTab, { focusWindow: false });

    expect(setActiveTab).toHaveBeenCalledWith("tab-2");
    expect(windowFocusSpy).not.toHaveBeenCalled();

    windowFocusSpy.mockRestore();
  });

  it("restores and focuses the Tauri window", async () => {
    const { focusAppWindow } = await import("./notifications");

    await focusAppWindow();

    expect(notificationMocks.isMinimizedMock).toHaveBeenCalledTimes(1);
    expect(notificationMocks.unminimizeMock).toHaveBeenCalledTimes(1);
    expect(notificationMocks.showMock).toHaveBeenCalledTimes(1);
    expect(notificationMocks.setFocusMock).toHaveBeenCalledTimes(1);
  });
});
