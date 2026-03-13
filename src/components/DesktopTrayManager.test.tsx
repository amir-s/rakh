// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, patchAgentState, jotaiStore } from "@/agent/atoms";
import type { PersistedSession } from "@/agent/persistence";
import { TabsProvider } from "@/contexts/TabsContext";
import DesktopTrayManager from "./DesktopTrayManager";

type MockMenuItem = {
  id: string;
  action?: (id: string) => void;
  setText: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const trayMocks = vi.hoisted(() => {
  const iconBuffers = {
    dark: new Uint8Array([1]).buffer,
    light: new Uint8Array([2]).buffer,
  };

  return {
    iconBuffers,
    menuItems: new Map<string, MockMenuItem>(),
    trayAction: null as null | ((event: Record<string, unknown>) => void),
    trayIcon: {
      setMenu: vi.fn(async () => undefined),
      setShowMenuOnLeftClick: vi.fn(async () => undefined),
      setIconAsTemplate: vi.fn(async () => undefined),
      setTooltip: vi.fn(async () => undefined),
      setIcon: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    trayIconNewMock: vi.fn(
      async (options?: { action?: (event: Record<string, unknown>) => void }) => {
        trayMocks.trayAction = options?.action ?? null;
        return trayMocks.trayIcon;
      },
    ),
    menuNewMock: vi.fn(async () => ({
      close: vi.fn(async () => undefined),
    })),
    menuItemNewMock: vi.fn(
      async (options: { id: string; action?: (id: string) => void }) => {
        const item: MockMenuItem = {
          id: options.id,
          action: options.action,
          setText: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        };
        trayMocks.menuItems.set(options.id, item);
        return item;
      },
    ),
    predefinedMenuItemNewMock: vi.fn(async () => ({
      close: vi.fn(async () => undefined),
    })),
    exitMock: vi.fn(async () => undefined),
    focusAppWindowMock: vi.fn(async () => undefined),
  };
});

vi.mock("@tauri-apps/api/tray", () => ({
  TrayIcon: {
    new: trayMocks.trayIconNewMock,
  },
}));

vi.mock("@tauri-apps/api/menu", () => ({
  Menu: {
    new: trayMocks.menuNewMock,
  },
  MenuItem: {
    new: trayMocks.menuItemNewMock,
  },
  PredefinedMenuItem: {
    new: trayMocks.predefinedMenuItemNewMock,
  },
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  exit: trayMocks.exitMock,
}));

vi.mock("@/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/notifications")>(
    "@/notifications",
  );
  return {
    ...actual,
    focusAppWindow: trayMocks.focusAppWindowMock,
  };
});

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

function setTauriAvailable(value: boolean): void {
  if (value) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  } else {
    Reflect.deleteProperty(
      window as typeof window & { __TAURI_INTERNALS__?: unknown },
      "__TAURI_INTERNALS__",
    );
  }
}

function setNavigatorPlatform(value: string): void {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value,
  });
}

function renderManager(sessions: PersistedSession[]) {
  return render(
    <Provider store={jotaiStore}>
      <TabsProvider initialSessions={sessions}>
        <DesktopTrayManager />
      </TabsProvider>
    </Provider>,
  );
}

function setAgentStatus(
  tabId: string,
  status: "idle" | "thinking" | "working" | "done" | "error",
) {
  patchAgentState(tabId, {
    status,
    config: {
      cwd: `/tmp/${tabId}`,
      model: DEFAULT_MODEL,
    },
  });
}

function setAwaitingToolCall(
  tabId: string,
  toolCallStatus:
    | "awaiting_approval"
    | "awaiting_worktree"
    | "awaiting_setup_action",
) {
  patchAgentState(tabId, {
    status: "working",
    chatMessages: [
      {
        id: `${tabId}-msg`,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        toolCalls: [
          {
            id: `${tabId}-tool`,
            tool: "request_user_input",
            args: {},
            status: toolCallStatus,
          },
        ],
      },
    ],
    tabTitle: "",
    config: {
      cwd: `/tmp/${tabId}`,
      model: DEFAULT_MODEL,
    },
  });
}

function clearAgentActivity(tabId: string) {
  patchAgentState(tabId, {
    status: "idle",
    chatMessages: [],
    tabTitle: "",
    config: {
      cwd: `/tmp/${tabId}`,
      model: DEFAULT_MODEL,
    },
  });
}

describe("DesktopTrayManager", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    setNavigatorPlatform("MacIntel");
    setTauriAvailable(true);
    trayMocks.menuItems.clear();
    trayMocks.trayAction = null;
    trayMocks.trayIconNewMock.mockClear();
    trayMocks.menuNewMock.mockClear();
    trayMocks.menuItemNewMock.mockClear();
    trayMocks.predefinedMenuItemNewMock.mockClear();
    trayMocks.trayIcon.setMenu.mockClear();
    trayMocks.trayIcon.setShowMenuOnLeftClick.mockClear();
    trayMocks.trayIcon.setTooltip.mockClear();
    trayMocks.trayIcon.setIcon.mockClear();
    trayMocks.trayIcon.close.mockClear();
    trayMocks.exitMock.mockClear();
    trayMocks.focusAppWindowMock.mockClear();

    let prefersDark = true;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: prefersDark,
        media: query,
        onchange: null,
        addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener);
        },
        removeEventListener: (
          _event: string,
          listener: (event: MediaQueryListEvent) => void,
        ) => {
          listeners.delete(listener);
        },
        addListener: (listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener);
        },
        removeListener: (listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener);
        },
        dispatchEvent: vi.fn(),
      })),
    });

    Object.assign(globalThis, {
      __setTraySystemTheme: (theme: "dark" | "light") => {
        prefersDark = theme === "dark";
        const event = { matches: prefersDark } as MediaQueryListEvent;
        for (const listener of listeners) {
          listener(event);
        }
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        arrayBuffer: async () => {
          if (url.includes("tray-dark")) return trayMocks.iconBuffers.dark;
          return trayMocks.iconBuffers.light;
        },
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(
      globalThis as typeof globalThis & { __setTraySystemTheme?: unknown },
      "__setTraySystemTheme",
    );
    cleanup();
  });

  it("is a no-op outside Tauri", async () => {
    setTauriAvailable(false);

    renderManager([makeSession("tab-1", "Workspace")]);

    await act(async () => undefined);

    expect(trayMocks.trayIconNewMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("creates one tray and updates menu text and icon in place", async () => {
    renderManager([makeSession("tab-1", "Workspace")]);

    await waitFor(() => {
      expect(trayMocks.trayIconNewMock).toHaveBeenCalledTimes(1);
    });

    expect(trayMocks.trayIcon.setMenu).toHaveBeenCalledTimes(1);
    expect(trayMocks.trayIcon.setShowMenuOnLeftClick).toHaveBeenCalledWith(false);
    expect(trayMocks.menuItems.get("tray-status")?.setText).toHaveBeenCalledWith(
      "Status: Idle",
    );
    expect(trayMocks.menuItems.get("tray-counts")?.setText).toHaveBeenCalledWith(
      "Attention 0 • Working 0 • Done 0",
    );
    expect(trayMocks.trayIcon.setTooltip).toHaveBeenCalledWith(
      "Rakh: Idle • Attention 0 • Working 0 • Done 0",
    );
    expect(trayMocks.trayIcon.setIcon).toHaveBeenCalledWith(trayMocks.iconBuffers.dark);

    trayMocks.menuItems.get("tray-status")?.setText.mockClear();
    trayMocks.menuItems.get("tray-counts")?.setText.mockClear();
    trayMocks.trayIcon.setTooltip.mockClear();
    trayMocks.trayIcon.setIcon.mockClear();

    await act(async () => {
      setAgentStatus("tab-1", "working");
    });

    await waitFor(() => {
      expect(trayMocks.menuItems.get("tray-status")?.setText).toHaveBeenCalledWith(
        "Status: Working",
      );
    });
    expect(trayMocks.menuItems.get("tray-counts")?.setText).toHaveBeenCalledWith(
      "Attention 0 • Working 1 • Done 0",
    );
    expect(trayMocks.trayIcon.setTooltip).toHaveBeenCalledWith(
      "Rakh: Working • Attention 0 • Working 1 • Done 0",
    );
    expect(trayMocks.trayIcon.setIcon).toHaveBeenCalledWith(trayMocks.iconBuffers.dark);

    trayMocks.menuItems.get("tray-status")?.setText.mockClear();
    trayMocks.menuItems.get("tray-counts")?.setText.mockClear();
    trayMocks.trayIcon.setTooltip.mockClear();
    trayMocks.trayIcon.setIcon.mockClear();

    await act(async () => {
      setAwaitingToolCall("tab-1", "awaiting_approval");
    });

    await waitFor(() => {
      expect(trayMocks.menuItems.get("tray-status")?.setText).toHaveBeenCalledWith(
        "Status: Requires attention",
      );
    });
    expect(trayMocks.menuItems.get("tray-counts")?.setText).toHaveBeenCalledWith(
      "Attention 1 • Working 0 • Done 0",
    );
    expect(trayMocks.trayIcon.setTooltip).toHaveBeenCalledWith(
      "Rakh: Requires attention • Attention 1 • Working 0 • Done 0",
    );
    expect(trayMocks.trayIcon.setIcon).toHaveBeenCalledWith(trayMocks.iconBuffers.dark);

    trayMocks.menuItems.get("tray-status")?.setText.mockClear();
    trayMocks.menuItems.get("tray-counts")?.setText.mockClear();
    trayMocks.trayIcon.setTooltip.mockClear();
    trayMocks.trayIcon.setIcon.mockClear();

    await act(async () => {
      clearAgentActivity("tab-1");
    });

    await waitFor(() => {
      expect(trayMocks.menuItems.get("tray-status")?.setText).toHaveBeenCalledWith(
        "Status: Idle",
      );
    });
    expect(trayMocks.menuItems.get("tray-counts")?.setText).toHaveBeenCalledWith(
      "Attention 0 • Working 0 • Done 0",
    );
    expect(trayMocks.trayIcon.setTooltip).toHaveBeenCalledWith(
      "Rakh: Idle • Attention 0 • Working 0 • Done 0",
    );
    expect(trayMocks.trayIcon.setIcon).toHaveBeenCalledWith(trayMocks.iconBuffers.dark);
    expect(trayMocks.trayIconNewMock).toHaveBeenCalledTimes(1);
  });

  it("updates the tray icon when the system color scheme changes", async () => {
    renderManager([makeSession("tab-1", "Workspace")]);

    await waitFor(() => {
      expect(trayMocks.trayIconNewMock).toHaveBeenCalledTimes(1);
    });

    trayMocks.trayIcon.setIcon.mockClear();

    await act(async () => {
      (
        globalThis as typeof globalThis & {
          __setTraySystemTheme: (theme: "dark" | "light") => void;
        }
      ).__setTraySystemTheme("light");
    });

    await waitFor(() => {
      expect(trayMocks.trayIcon.setIcon).toHaveBeenCalledWith(
        trayMocks.iconBuffers.light,
      );
    });
  });

  it("reuses the existing focus flow for tray clicks and the open menu item", async () => {
    renderManager([makeSession("tab-1", "Workspace")]);

    await waitFor(() => {
      expect(trayMocks.trayIconNewMock).toHaveBeenCalledTimes(1);
    });

    trayMocks.trayAction?.({
      type: "Click",
      button: "Left",
      buttonState: "Up",
    });
    expect(trayMocks.focusAppWindowMock).toHaveBeenCalledTimes(1);

    trayMocks.menuItems.get("tray-open")?.action?.("tray-open");
    expect(trayMocks.focusAppWindowMock).toHaveBeenCalledTimes(2);

    trayMocks.menuItems.get("tray-quit")?.action?.("tray-quit");
    expect(trayMocks.exitMock).toHaveBeenCalledWith(0);
  });
});
