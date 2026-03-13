// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { atom } from "jotai";
import NewSession from "./NewSession";
import type { PersistedSession } from "@/agent/persistence";

const tabsContextMock = vi.hoisted(() => ({
  value: {
    activeTabId: "new-tab-1",
    addTabWithId: vi.fn(),
    closeTab: vi.fn(),
    openSettingsTab: vi.fn(),
  },
}));

const persistenceMock = vi.hoisted(() => ({
  loadArchivedSessions: vi.fn(),
  setSessionPinned: vi.fn(),
}));

const sessionRestoreMock = vi.hoisted(() => ({
  restoreArchivedTab: vi.fn(),
}));

vi.mock("@/contexts/TabsContext", () => ({
  useTabs: () => tabsContextMock.value,
}));

vi.mock("@/agent/db", () => ({
  providersAtom: atom([{ name: "OpenAI", type: "openai" }]),
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
  listen: vi.fn(async () => () => undefined),
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
    loadArchivedSessions: (...args: unknown[]) =>
      persistenceMock.loadArchivedSessions(...args),
    setSessionPinned: (...args: unknown[]) =>
      persistenceMock.setSessionPinned(...args),
  };
});

vi.mock("@/agent/sessionRestore", () => ({
  restoreArchivedTab: (...args: unknown[]) =>
    sessionRestoreMock.restoreArchivedTab(...args),
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

describe("NewSession recent tabs", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    tabsContextMock.value.addTabWithId.mockReset();
    tabsContextMock.value.closeTab.mockReset();
    tabsContextMock.value.openSettingsTab.mockReset();
    persistenceMock.loadArchivedSessions.mockReset();
    persistenceMock.setSessionPinned.mockReset();
    sessionRestoreMock.restoreArchivedTab.mockReset();
    persistenceMock.setSessionPinned.mockResolvedValue(undefined);
    sessionRestoreMock.restoreArchivedTab.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders pinned tabs first and limits the recent list to eight unpinned sessions", async () => {
    persistenceMock.loadArchivedSessions.mockResolvedValue([
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
    expect(screen.getByText("Recent 8")).not.toBeNull();
    expect(screen.queryByText("Recent 9")).toBeNull();
  });

  it("pins recent tabs from the landing page", async () => {
    persistenceMock.loadArchivedSessions.mockResolvedValue([
      makeSession("recent-1", {
        label: "Recent Workspace",
        projectPath: "/repo/recent",
        cwd: "/repo/recent",
        updatedAt: 250,
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
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Unpin Recent Workspace" }),
    ).not.toBeNull();
  });

  it("restores a recent tab and closes the current new-session tab", async () => {
    const session = makeSession("restore-me", {
      label: "Restore Me",
      projectPath: "/repo/restore",
      cwd: "/repo/restore",
      pinned: true,
      updatedAt: 300,
    });
    persistenceMock.loadArchivedSessions.mockResolvedValue([session]);

    render(<NewSession onSubmit={vi.fn()} />);

    await screen.findByText("Restore Me");
    fireEvent.click(screen.getByTitle("Restore: Restore Me"));

    await waitFor(() => {
      expect(sessionRestoreMock.restoreArchivedTab).toHaveBeenCalledWith(
        session,
        tabsContextMock.value.addTabWithId,
      );
    });
    expect(tabsContextMock.value.closeTab).toHaveBeenCalledWith("new-tab-1");
  });
});
