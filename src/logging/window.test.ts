// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const windowMocks = vi.hoisted(() => {
  const createdWindows: MockWindowInstance[] = [];
  const getByLabelMock = vi.fn();
  const emitToMock = vi.fn();

  class MockWindowInstance {
    label: string;
    options: Record<string, unknown>;
    show = vi.fn().mockResolvedValue(undefined);
    unminimize = vi.fn().mockResolvedValue(undefined);
    setFocus = vi.fn().mockResolvedValue(undefined);

    constructor(label: string, options: Record<string, unknown>) {
      this.label = label;
      this.options = options;
      createdWindows.push(this);
    }

    once(event: string, handler: (event: { payload?: unknown }) => void) {
      if (event === "tauri://created") {
        queueMicrotask(() => handler({}));
      }
      return Promise.resolve(() => {});
    }

    static getByLabel(label: string) {
      return getByLabelMock(label);
    }
  }

  return {
    createdWindows,
    getByLabelMock,
    emitToMock,
    MockWindowInstance,
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: (...args: unknown[]) => windowMocks.emitToMock(...args),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: windowMocks.MockWindowInstance,
}));

import {
  LOG_WINDOW_LABEL,
  LOG_WINDOW_NAVIGATE_EVENT,
  openLogViewerWindow,
} from "./window";

describe("logging/window", () => {
  beforeEach(() => {
    windowMocks.createdWindows.length = 0;
    windowMocks.getByLabelMock.mockReset();
    windowMocks.emitToMock.mockReset();
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.history.replaceState({}, "", "/app");
  });

  it("returns false outside the Tauri runtime", async () => {
    const opened = await openLogViewerWindow({
      origin: "manual",
      filter: {},
    });

    expect(opened).toBe(false);
    expect(windowMocks.getByLabelMock).not.toHaveBeenCalled();
  });

  it("creates and focuses the shared logs window when it does not exist", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    windowMocks.getByLabelMock.mockReturnValue(null);

    await openLogViewerWindow({
      origin: "debug-pane",
      filter: { traceId: "trace-1" },
      tailEnabled: false,
    });

    expect(windowMocks.createdWindows).toHaveLength(1);
    const created = windowMocks.createdWindows[0];
    expect(created.label).toBe(LOG_WINDOW_LABEL);
    expect(created.options).toEqual(
      expect.objectContaining({
        title: "Rakh Logs",
        width: 980,
        height: 760,
        minWidth: 640,
        minHeight: 480,
        center: true,
        resizable: true,
        focus: true,
      }),
    );
    expect(String(created.options.url)).toContain("window=logs");
    expect(String(created.options.url)).toContain("logsPayload=");
    expect(windowMocks.emitToMock).toHaveBeenCalledWith(
      LOG_WINDOW_LABEL,
      LOG_WINDOW_NAVIGATE_EVENT,
      expect.objectContaining({
        origin: "debug-pane",
        tailEnabled: false,
        filter: expect.objectContaining({
          traceId: "trace-1",
          limit: 500,
        }),
      }),
    );
    expect(created.show).toHaveBeenCalled();
    expect(created.unminimize).toHaveBeenCalled();
    expect(created.setFocus).toHaveBeenCalled();
  });

  it("reuses and focuses the existing shared logs window", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const existing = {
      show: vi.fn().mockResolvedValue(undefined),
      unminimize: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    };
    windowMocks.getByLabelMock.mockReturnValue(existing);

    await openLogViewerWindow({
      origin: "tool-call",
      filter: { correlationId: "tool-1" },
    });

    expect(windowMocks.createdWindows).toHaveLength(0);
    expect(windowMocks.emitToMock).toHaveBeenCalledWith(
      LOG_WINDOW_LABEL,
      LOG_WINDOW_NAVIGATE_EVENT,
      expect.objectContaining({
        origin: "tool-call",
        tailEnabled: true,
        filter: expect.objectContaining({
          correlationId: "tool-1",
          limit: 500,
        }),
      }),
    );
    expect(existing.show).toHaveBeenCalled();
    expect(existing.unminimize).toHaveBeenCalled();
    expect(existing.setFocus).toHaveBeenCalled();
  });
});
