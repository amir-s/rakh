// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewSession from "./NewSession";
import type { PersistedSession, SessionChangeEvent } from "@/agent/persistence";

const tabsContextMock = vi.hoisted(() => ({
  value: {
    activeTabId: "new-tab-1",
    addTabWithId: vi.fn(),
    closeTab: vi.fn(),
    openSettingsTab: vi.fn(),
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
  loadRecentSessions: vi.fn(),
  setSessionPinned: vi.fn(),
}));

const tauriEventMock = vi.hoisted(() => ({
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  listenMock: vi.fn(),
}));

const jotaiMock = vi.hoisted(() => ({
  useAtomMock: vi.fn(() => [[{ name: "OpenAI", type: "openai" }], vi.fn()]),
}));

const sessionRestoreMock = vi.hoisted(() => ({
  focusOrOpenPersistedSession: vi.fn(),
}));

vi.mock("@/contexts/TabsContext", () => ({
  useTabs: () => tabsContextMock.value,
}));

vi.mock("jotai", async () => {
  const actual = await vi.importActual<typeof import("jotai")>("jotai");
  return {
    ...actual,
    useAtom: () => jotaiMock.useAtomMock(),
  };
});

vi.mock("@/agent/db", () => ({
  providersAtom: Symbol("providersAtom"),
}));

vi.mock("@/agent/useModels", async () => {
  const React = await import("react");

  return {
    useModels: () => ({
      models: [{ id: "openai/gpt-5.2", context_length: 200000 }],
      loading: false,
      error: null,
    }),
    useSelectedModel: (models: Array<{ id: string }>) =>
      React.useState(models[0]?.id ?? ""),
  };
});

vi.mock("@/components/NewSessionModelSelector", () => ({
  default: () => <div data-testid="model-selector" />,
}));

vi.mock("@/components/ProviderSetupHint", () => ({
  default: () => null,
}));

vi.mock("@/components/ProjectSettingsModal", () => ({
  default: () => null,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => tauriEventMock.listenMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));

vi.mock("@/agent/persistence", async () => {
  const actual = await vi.importActual<typeof import("@/agent/persistence")>(
    "@/agent/persistence",
  );

  return {
    ...actual,
    loadRecentSessions: (...args: unknown[]) =>
      persistenceMock.loadRecentSessions(...args),
    setSessionPinned: (...args: unknown[]) =>
      persistenceMock.setSessionPinned(...args),
  };
});

vi.mock("@/agent/sessionRestore", () => ({
  focusOrOpenPersistedSession: (...args: unknown[]) =>
    sessionRestoreMock.focusOrOpenPersistedSession(...args),
}));

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

describe("NewSession recent tabs", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    tabsContextMock.value.addTabWithId.mockReset();
    tabsContextMock.value.closeTab.mockReset();
    tabsContextMock.value.openSettingsTab.mockReset();
    tabsContextMock.value.setActiveTab.mockReset();
    tabsContextMock.value.tabs = [];
    persistenceMock.loadRecentSessions.mockReset();
    persistenceMock.setSessionPinned.mockReset();
    sessionRestoreMock.focusOrOpenPersistedSession.mockReset();
    jotaiMock.useAtomMock.mockReset();
    tauriEventMock.listenMock.mockReset();
    tauriEventMock.eventHandlers.clear();
    persistenceMock.setSessionPinned.mockResolvedValue(undefined);
    sessionRestoreMock.focusOrOpenPersistedSession.mockResolvedValue("restored");
    jotaiMock.useAtomMock.mockReturnValue([
      [{ name: "OpenAI", type: "openai" }],
      vi.fn(),
    ]);
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

  it("renders pinned tabs first and limits the recent list to five unpinned sessions", async () => {
    persistenceMock.loadRecentSessions.mockResolvedValue([
      makeSession("pinned-1", {
        label: "Pinned Workspace",
        projectPath: "/repo/pinned",
        cwd: "/repo/pinned",
        pinned: true,
        updatedAt: 500,
      }),
      ...Array.from({ length: 9 }, (_, index) =>
        makeSession(`recent-${index + 1}`, {
          label: `Recent ${index + 1}`,
          projectPath: `/repo/recent-${index + 1}`,
          cwd: `/repo/recent-${index + 1}`,
          updatedAt: 400 - index,
        }),
      ),
    ]);

    render(<NewSession onSubmit={vi.fn()} />);

    expect(await screen.findAllByText("Recent tabs")).toHaveLength(1);
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(screen.getByText("Pinned Workspace")).not.toBeNull();
    expect(screen.getByText("Recent 1")).not.toBeNull();
    expect(screen.getByText("Recent 5")).not.toBeNull();
    expect(screen.queryByText("Recent 6")).toBeNull();
  });

  it("pins recent tabs from the landing page", async () => {
    persistenceMock.loadRecentSessions
      .mockResolvedValueOnce([
        makeSession("recent-1", {
          label: "Recent Workspace",
          projectPath: "/repo/recent",
          cwd: "/repo/recent",
          updatedAt: 250,
        }),
      ])
      .mockResolvedValueOnce([
        makeSession("recent-1", {
          label: "Recent Workspace",
          projectPath: "/repo/recent",
          cwd: "/repo/recent",
          updatedAt: 250,
          pinned: true,
        }),
      ]);

    render(<NewSession onSubmit={vi.fn()} />);

    await screen.findByText("Recent Workspace");
    fireEvent.click(screen.getByRole("button", { name: "Pin Recent Workspace" }));

    await waitFor(() => {
      expect(persistenceMock.setSessionPinned).toHaveBeenCalledWith(
        "recent-1",
        true,
      );
    });
    await waitFor(() => {
      expect(persistenceMock.loadRecentSessions).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Unpin Recent Workspace" }),
    ).not.toBeNull();
  });

  it("keeps active pinned tabs visible and focuses them when clicked", async () => {
    const session = makeSession("open-pinned", {
      label: "Open Pinned Workspace",
      projectPath: "/repo/open",
      cwd: "/repo/open",
      pinned: true,
      archived: false,
      updatedAt: 320,
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

    render(<NewSession onSubmit={vi.fn()} />);

    await screen.findByText("Open Pinned Workspace");
    fireEvent.click(screen.getByTitle("Open: Open Pinned Workspace"));

    await waitFor(() => {
      expect(sessionRestoreMock.focusOrOpenPersistedSession).toHaveBeenCalledWith(
        session,
        {
          addTabWithId: tabsContextMock.value.addTabWithId,
          setActiveTab: tabsContextMock.value.setActiveTab,
          tabs: tabsContextMock.value.tabs,
        },
      );
    });
    expect(tabsContextMock.value.closeTab).toHaveBeenCalledWith("new-tab-1");
  });

  it("restores a recent tab and closes the current new-session tab", async () => {
    const session = makeSession("restore-me", {
      label: "Restore Me",
      projectPath: "/repo/restore",
      cwd: "/repo/restore",
      pinned: true,
      updatedAt: 300,
    });
    persistenceMock.loadRecentSessions.mockResolvedValue([session]);

    render(<NewSession onSubmit={vi.fn()} />);

    await screen.findByText("Restore Me");
    fireEvent.click(screen.getByTitle("Open: Restore Me"));

    await waitFor(() => {
      expect(sessionRestoreMock.focusOrOpenPersistedSession).toHaveBeenCalledWith(
        session,
        {
          addTabWithId: tabsContextMock.value.addTabWithId,
          setActiveTab: tabsContextMock.value.setActiveTab,
          tabs: tabsContextMock.value.tabs,
        },
      );
    });
    expect(tabsContextMock.value.closeTab).toHaveBeenCalledWith("new-tab-1");
  });

  it("reloads recent tabs when archived-session events arrive", async () => {
    const initial = makeSession("recent-1", {
      label: "Recent Workspace",
      projectPath: "/repo/recent",
      cwd: "/repo/recent",
      updatedAt: 250,
    });
    const added = makeSession("recent-2", {
      label: "Freshly Archived",
      projectPath: "/repo/fresh",
      cwd: "/repo/fresh",
      updatedAt: 260,
    });
    persistenceMock.loadRecentSessions
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([added, initial]);

    render(<NewSession onSubmit={vi.fn()} />);

    await screen.findByText("Recent Workspace");

    emitSessionChange({
      sessionId: "recent-2",
      change: "archived",
      archived: true,
      previousArchived: false,
      pinned: false,
      changedAt: 260,
    });

    await waitFor(() => {
      expect(screen.getByText("Freshly Archived")).not.toBeNull();
    });
    expect(persistenceMock.loadRecentSessions).toHaveBeenCalledTimes(2);
  });
});
