// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const notificationMocks = vi.hoisted(() => ({
  isPermissionGrantedMock: vi.fn(async () => true),
  requestPermissionMock: vi.fn(async () => "granted" as const),
  sendNotificationMock: vi.fn(),
  onActionHandler: null as null | ((event: unknown) => void),
  onActionMock: vi.fn(async (handler: (event: unknown) => void) => {
    notificationMocks.onActionHandler = handler;
    return { unregister: vi.fn() };
  }),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: notificationMocks.isPermissionGrantedMock,
  requestPermission: notificationMocks.requestPermissionMock,
  sendNotification: notificationMocks.sendNotificationMock,
  onAction: notificationMocks.onActionMock,
}));

describe("notifications", () => {
  beforeEach(() => {
    vi.resetModules();
    notificationMocks.isPermissionGrantedMock.mockClear();
    notificationMocks.requestPermissionMock.mockClear();
    notificationMocks.sendNotificationMock.mockClear();
    notificationMocks.onActionMock.mockClear();
    notificationMocks.onActionHandler = null;

    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("defers Tauri click handlers until a notification action event arrives", async () => {
    const { showNotification } = await import("./notifications");
    const onClick = vi.fn();

    const sent = await showNotification({
      title: "Agent needs your input",
      options: { body: "Workspace • request_user_input" },
      onClick,
    });

    expect(sent).toBe(true);
    expect(notificationMocks.sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();

    const [{ id }] = notificationMocks.sendNotificationMock.mock.calls[0] ?? [];
    notificationMocks.onActionHandler?.({ notification: { id } });

    expect(onClick).toHaveBeenCalledTimes(1);
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
});
