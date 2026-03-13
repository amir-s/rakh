// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ArchivedTabsMenu from "./ArchivedTabsMenu";
import type { PersistedSession, SessionChangeEvent } from "@/agent/persistence";
import { PROJECTS_STORAGE_KEY } from "@/projects";

const tabsContextMock = vi.hoisted(() => ({
  value: {
    addTabWithId: vi.fn(),
    setActiveTab: vi.fn(),
    tabs: [] as Array<{
      id: string;
      label: string;
      icon: string;
      status: "idle";
      pinned?: boolean;
      mode: "workspace";
    }>,
  },
}));

const persistenceMock = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  loadRecentSessions: vi.fn(),
  setSessionPinned: vi.fn(),
}));

const tauriEventMock = vi.hoisted(() => ({
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  listenMock: vi.fn(),
}));

const sessionRestoreMock = vi.hoisted(() => ({
  focusOrOpenPersistedSession: vi.fn(),
}));

vi.mock("@/contexts/TabsContext", () => ({
  useTabs: () => tabsContextMock.value,
}));

vi.mock("@/agent/sessionRestore", () => ({
  focusOrOpenPersistedSession: (...args: unknown[]) =>
    sessionRestoreMock.focusOrOpenPersistedSession(...args),
}));

vi.mock("@/agent/persistence", async () => {
  const actual = await vi.importActual<typeof import("@/agent/persistence")>(
    "@/agent/persistence",
  );

  return {
    ...actual,
    deleteSession: (...args: unknown[]) => persistenceMock.deleteSession(...args),
    loadRecentSessions: (...args: unknown[]) =>
      persistenceMock.loadRecentSessions(...args),
    setSessionPinned: (...args: unknown[]) =>
      persistenceMock.setSessionPinned(...args),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => tauriEventMock.listenMock(...args),
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

function makeSession(
  id: string,
  overrides: Partial<PersistedSession> = {},
): PersistedSession {
  return {
    id,
    label: "Workspace",
    icon: "chat_bubble_outline",
    mode: "workspace",
    tabTitle: "",
    cwd: "/repo/default",
    projectPath: "/repo/default",
    setupCommand: "",
    model: "openai/gpt-5.2",
    planMarkdown: "",
    planVersion: 0,
    planUpdatedAt: 0,
    chatMessages: "[]",
    apiMessages: "[]",
    todos: "[]",
    reviewEdits: "[]",
    queuedMessages: "[]",
    queueState: "idle",
    archived: true,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    worktreePath: "",
    worktreeBranch: "",
    worktreeDeclined: false,
    showDebug: false,
    advancedOptions: "{}",
    communicationProfile: "pragmatic",
    ...overrides,
  };
}

function emitSessionChange(event: SessionChangeEvent) {
  act(() => {
    tauriEventMock.eventHandlers.get("session_changed")?.({ payload: event });
  });
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Archived tabs" }));
  await screen.findByText("Archived Tabs");
  return screen.getByRole("textbox", { name: "Search archived tabs" });
}

describe("ArchivedTabsMenu", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    persistenceMock.loadRecentSessions.mockReset();
    persistenceMock.deleteSession.mockReset();
    persistenceMock.setSessionPinned.mockReset();
    sessionRestoreMock.focusOrOpenPersistedSession.mockReset();
    tabsContextMock.value.addTabWithId.mockReset();
    tabsContextMock.value.setActiveTab.mockReset();
    tabsContextMock.value.tabs = [];
    tauriEventMock.listenMock.mockReset();
    tauriEventMock.eventHandlers.clear();
    persistenceMock.deleteSession.mockResolvedValue(undefined);
    persistenceMock.setSessionPinned.mockResolvedValue(undefined);
    sessionRestoreMock.focusOrOpenPersistedSession.mockResolvedValue("restored");
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    tauriEventMock.listenMock.mockImplementation(
      async (
        event: string,
        handler: (event: { payload: SessionChangeEvent }) => void,
      ) => {
        tauriEventMock.eventHandlers.set(
          event,
          handler as (event: { payload: unknown }) => void,
        );
        return () => {
          tauriEventMock.eventHandlers.delete(event);
        };
      },
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("shows pinned tabs directly in the parent list above grouped projects and excludes them from grouped rows", async () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([{ path: "/repo/platform", name: "Platform API" }]),
    );

    persistenceMock.loadRecentSessions.mockResolvedValue([
      makeSession("platform-pinned", {
        label: "Pinned platform tab",
        tabTitle: "Hold rollout notes",
        projectPath: "/repo/platform",
        cwd: "/repo/platform",
        updatedAt: 350,
        pinned: true,
      }),
      makeSession("platform-old", {
        label: "Older platform tab",
        tabTitle: "Ship OAuth polish",
        projectPath: "/repo/platform",
        cwd: "/repo/platform",
        updatedAt: 250,
      }),
      makeSession("unknown", {
        label: "Detached scratchpad",
        projectPath: "",
        cwd: "",
        updatedAt: 100,
      }),
      makeSession("docs", {
        label: "Docs notes",
        projectPath: "",
        cwd: "/repo/docs",
        updatedAt: 200,
      }),
      makeSession("platform-new", {
        label: "Latest platform tab",
        tabTitle: "Fix auth token refresh",
        projectPath: "/repo/platform",
        cwd: "/repo/platform",
        updatedAt: 300,
      }),
    ]);

    render(<ArchivedTabsMenu />);
    await openMenu();

    const firstGroup = document.querySelector(".archived-group");
    expect(firstGroup).not.toBeNull();
    expect(screen.queryByText("Pinned")).toBeNull();
    const pinnedItem = screen.getByText("Pinned platform tab").closest(".archived-item");
    expect(pinnedItem).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete Pinned platform tab" }),
    ).toBeNull();
    if (!(pinnedItem instanceof HTMLElement) || !(firstGroup instanceof HTMLElement)) {
      throw new Error("Expected pinned item and first group to render");
    }
    expect(
      pinnedItem.compareDocumentPosition(firstGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(pinnedItem.className).toContain("archived-item--pinned");

    const groupLabels = Array.from(
      document.querySelectorAll(".archived-group-label"),
    ).map((node) => node.textContent);
    expect(groupLabels).toEqual(["platform", "docs", "Unknown Project"]);

    const firstGroupItems = Array.from(
      document.querySelectorAll(".archived-group-list")[0]?.querySelectorAll(
        ".archived-item-label",
      ) ?? [],
    ).map((node) => node.textContent);
    expect(firstGroupItems).toEqual(["Latest platform tab", "Older platform tab"]);

    expect(screen.getByText("/repo/platform")).not.toBeNull();
    expect(screen.getByText("/repo/docs")).not.toBeNull();
    expect(screen.getByText("Unknown Project")).not.toBeNull();
  });

  it("unpins pinned tabs back into grouped project lists", async () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([{ path: "/repo/platform", name: "Platform API" }]),
    );

    persistenceMock.loadRecentSessions
      .mockResolvedValueOnce([
        makeSession("platform-pinned", {
          label: "Pinned platform tab",
          projectPath: "/repo/platform",
          cwd: "/repo/platform",
          updatedAt: 300,
          pinned: true,
        }),
        makeSession("platform-regular", {
          label: "Regular platform tab",
          projectPath: "/repo/platform",
          cwd: "/repo/platform",
          updatedAt: 200,
        }),
      ])
      .mockResolvedValueOnce([
        makeSession("platform-pinned", {
          label: "Pinned platform tab",
          projectPath: "/repo/platform",
          cwd: "/repo/platform",
          updatedAt: 300,
          pinned: false,
        }),
        makeSession("platform-regular", {
          label: "Regular platform tab",
          projectPath: "/repo/platform",
          cwd: "/repo/platform",
          updatedAt: 200,
        }),
      ]);

    render(<ArchivedTabsMenu />);
    await openMenu();

    fireEvent.click(screen.getByRole("button", { name: "Unpin Pinned platform tab" }));

    await waitFor(() => {
      expect(persistenceMock.setSessionPinned).toHaveBeenCalledWith(
        "platform-pinned",
        false,
      );
    });
    await waitFor(() => {
      expect(persistenceMock.loadRecentSessions).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("button", { name: "Delete Pinned platform tab" }),
      ).not.toBeNull();

      const groupedItems = Array.from(
        document.querySelectorAll(".archived-group-list .archived-item-label"),
      ).map((node) => node.textContent);
      expect(groupedItems).toEqual([
        "Pinned platform tab",
        "Regular platform tab",
      ]);
    });
  });

  it("shows active pinned tabs and focuses them when clicked", async () => {
    const session = makeSession("open-pinned", {
      label: "Open Pinned Workspace",
      projectPath: "/repo/open",
      cwd: "/repo/open",
      updatedAt: 320,
      pinned: true,
      archived: false,
    });
    tabsContextMock.value.tabs = [
      {
        id: "open-pinned",
        label: "Open Pinned Workspace",
        icon: "chat_bubble_outline",
        status: "idle",
        pinned: true,
        mode: "workspace",
      },
    ];
    sessionRestoreMock.focusOrOpenPersistedSession.mockResolvedValue("focused");
    persistenceMock.loadRecentSessions.mockResolvedValue([session]);

    render(<ArchivedTabsMenu />);
    await openMenu();

    expect(screen.getByText("Open Pinned Workspace")).not.toBeNull();

    fireEvent.click(screen.getByTitle("Open: Open Pinned Workspace"));

    await waitFor(() => {
      expect(
        sessionRestoreMock.focusOrOpenPersistedSession,
      ).toHaveBeenCalledWith(session, {
        addTabWithId: tabsContextMock.value.addTabWithId,
        setActiveTab: tabsContextMock.value.setActiveTab,
        tabs: tabsContextMock.value.tabs,
      });
    });
    expect(screen.queryByText("Archived Tabs")).toBeNull();
  });

  it("collapses and expands project groups", async () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([{ path: "/repo/platform", name: "Platform API" }]),
    );

    persistenceMock.loadRecentSessions.mockResolvedValue([
      makeSession("platform", {
        label: "Platform work",
        projectPath: "/repo/platform",
        cwd: "/repo/platform",
        updatedAt: 300,
      }),
    ]);

    render(<ArchivedTabsMenu />);
    await openMenu();

    const groupButton = screen.getByRole("button", { name: /Platform API/i });
    expect(groupButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Platform work")).not.toBeNull();

    fireEvent.click(groupButton);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Platform API/i }).getAttribute(
          "aria-expanded",
        ),
      ).toBe("false");
    });
    expect(screen.queryByText("Platform work")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Platform API/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Platform API/i }).getAttribute(
          "aria-expanded",
        ),
      ).toBe("true");
    });
    expect(screen.getByText("Platform work")).not.toBeNull();
  });

  it("searches across labels, titles, project names, and paths while hiding the pinned section", async () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([{ path: "/repo/platform", name: "Platform API" }]),
    );

    persistenceMock.loadRecentSessions.mockResolvedValue([
      makeSession("auth", {
        label: "Auth tokens",
        tabTitle: "Refresh rotation",
        projectPath: "/repo/platform",
        cwd: "/repo/platform",
        updatedAt: 300,
        pinned: true,
      }),
      makeSession("cleanup", {
        label: "Browser tab",
        tabTitle: "Memory cleanup",
        projectPath: "",
        cwd: "/repo/docs",
        updatedAt: 200,
      }),
      makeSession("runtime", {
        label: "Background worker",
        tabTitle: "",
        projectPath: "/repo/runtime",
        cwd: "/repo/runtime",
        updatedAt: 150,
      }),
    ]);

    render(<ArchivedTabsMenu />);
    await openMenu();

    fireEvent.change(screen.getByRole("textbox", { name: "Search archived tabs" }), {
      target: { value: "cleanup" },
    });
    expect(document.querySelectorAll(".archived-group")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Delete Auth tokens" })).toBeNull();
    expect(screen.getByText("Browser tab")).not.toBeNull();
    expect(screen.queryByText("docs · Memory cleanup")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search archived tabs" }), {
      target: { value: "platform" },
    });
    await waitFor(() => {
      expect(screen.getByText("Auth tokens")).not.toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Delete Auth tokens" })).not.toBeNull();
    expect(screen.queryByText("Platform API · Refresh rotation")).toBeNull();
    expect(screen.queryByText("Browser tab")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search archived tabs" }), {
      target: { value: "repo runtime" },
    });
    await waitFor(() => {
      expect(screen.getByText("Background worker")).not.toBeNull();
    });
    expect(screen.queryByText("Auth tokens")).toBeNull();
  });

  it("blocks delete on pinned rows and still deletes/restores eligible rows", async () => {
    const platformSession = makeSession("platform", {
      label: "Platform work",
      tabTitle: "Ship auth fix",
      projectPath: "/repo/platform",
      cwd: "/repo/platform",
      updatedAt: 300,
      pinned: true,
    });
    const docsSession = makeSession("docs", {
      label: "Docs notes",
      tabTitle: "Memory cleanup",
      projectPath: "",
      cwd: "/repo/docs",
      updatedAt: 200,
      pinned: false,
    });

    persistenceMock.loadRecentSessions
      .mockResolvedValueOnce([platformSession, docsSession])
      .mockResolvedValueOnce([platformSession]);

    render(<ArchivedTabsMenu />);
    await openMenu();

    expect(
      screen.queryByRole("button", { name: "Delete Platform work" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete Docs notes" }));

    await waitFor(() => {
      expect(persistenceMock.deleteSession).toHaveBeenCalledWith("docs");
    });
    expect(screen.queryByText("Docs notes")).toBeNull();

    fireEvent.click(screen.getByTitle("Open: Platform work"));
    await waitFor(() => {
      expect(
        sessionRestoreMock.focusOrOpenPersistedSession,
      ).toHaveBeenCalledWith(platformSession, {
        addTabWithId: tabsContextMock.value.addTabWithId,
        setActiveTab: tabsContextMock.value.setActiveTab,
        tabs: tabsContextMock.value.tabs,
      });
    });
    expect(screen.queryByText("Archived Tabs")).toBeNull();
  });

  it("autofocuses search, clears query before closing on Escape, and resets state on reopen", async () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([{ path: "/repo/platform", name: "Platform API" }]),
    );

    const sessions = [
      makeSession("platform", {
        label: "Platform work",
        projectPath: "/repo/platform",
        cwd: "/repo/platform",
        updatedAt: 300,
      }),
    ];

    persistenceMock.loadRecentSessions.mockResolvedValue(sessions);

    render(<ArchivedTabsMenu />);
    const input = await openMenu();

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    const groupButton = screen.getByRole("button", { name: /Platform API/i });
    fireEvent.click(groupButton);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Platform API/i }).getAttribute(
          "aria-expanded",
        ),
      ).toBe("false");
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Search archived tabs" }), {
      target: { value: "platform" },
    });
    expect(
      (
        screen.getByRole("textbox", {
          name: "Search archived tabs",
        }) as HTMLInputElement
      ).value,
    ).toBe("platform");

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search archived tabs" }),
      { key: "Escape" },
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "Search archived tabs",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(screen.getByText("Archived Tabs")).not.toBeNull();

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search archived tabs" }),
      { key: "Escape" },
    );
    expect(screen.queryByText("Archived Tabs")).toBeNull();

    const button = screen.getByRole("button", { name: "Archived tabs" });
    fireEvent.click(button);
    await screen.findByText("Archived Tabs");
    const reopenedInput = screen.getByRole("textbox", {
      name: "Search archived tabs",
    }) as HTMLInputElement;
    expect(reopenedInput.value).toBe("");
    expect(
      screen.getByRole("button", { name: /Platform API/i }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
  });

  it("reloads archived tabs while open when session events arrive", async () => {
    const original = makeSession("docs", {
      label: "Docs notes",
      projectPath: "",
      cwd: "/repo/docs",
      updatedAt: 200,
    });
    const added = makeSession("fresh", {
      label: "Freshly Archived",
      projectPath: "/repo/platform",
      cwd: "/repo/platform",
      updatedAt: 300,
      pinned: true,
    });

    persistenceMock.loadRecentSessions
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([added, original]);

    render(<ArchivedTabsMenu />);
    await openMenu();
    await screen.findByText("Docs notes");

    emitSessionChange({
      sessionId: "fresh",
      change: "archived",
      archived: true,
      previousArchived: false,
      pinned: true,
      changedAt: 300,
    });

    await waitFor(() => {
      expect(screen.getByText("Freshly Archived")).not.toBeNull();
    });
    expect(persistenceMock.loadRecentSessions).toHaveBeenCalledTimes(2);
  });
});
