// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ArchivedTabsMenu from "./ArchivedTabsMenu";
import type { PersistedSession } from "@/agent/persistence";
import { PROJECTS_STORAGE_KEY } from "@/projects";

const tabsContextMock = vi.hoisted(() => ({
  value: {
    addTabWithId: vi.fn(),
  },
}));

const persistenceMock = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  loadArchivedSessions: vi.fn(),
}));

const sessionRestoreMock = vi.hoisted(() => ({
  restoreArchivedTab: vi.fn(),
}));

vi.mock("@/contexts/TabsContext", () => ({
  useTabs: () => tabsContextMock.value,
}));

vi.mock("@/agent/sessionRestore", () => ({
  restoreArchivedTab: (...args: unknown[]) =>
    sessionRestoreMock.restoreArchivedTab(...args),
}));

vi.mock("@/agent/persistence", async () => {
  const actual = await vi.importActual<typeof import("@/agent/persistence")>(
    "@/agent/persistence",
  );

  return {
    ...actual,
    deleteSession: (...args: unknown[]) => persistenceMock.deleteSession(...args),
    loadArchivedSessions: (...args: unknown[]) =>
      persistenceMock.loadArchivedSessions(...args),
  };
});

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

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Archived tabs" }));
  await screen.findByText("Archived Tabs");
  return screen.getByRole("textbox", { name: "Search archived tabs" });
}

describe("ArchivedTabsMenu", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    persistenceMock.loadArchivedSessions.mockReset();
    persistenceMock.deleteSession.mockReset();
    sessionRestoreMock.restoreArchivedTab.mockReset();
    tabsContextMock.value.addTabWithId.mockReset();
    persistenceMock.deleteSession.mockResolvedValue(undefined);
    sessionRestoreMock.restoreArchivedTab.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("groups archived tabs by project, using cwd and unknown fallbacks, and keeps recency ordering", async () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([{ path: "/repo/platform", name: "Platform API" }]),
    );

    persistenceMock.loadArchivedSessions.mockResolvedValue([
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

    const groupLabels = Array.from(
      document.querySelectorAll(".archived-group-label"),
    ).map((node) => node.textContent);
    expect(groupLabels).toEqual(["Platform API", "docs", "Unknown Project"]);

    const firstGroupItems = Array.from(
      document.querySelectorAll(".archived-group-list")[0]?.querySelectorAll(
        ".archived-item-label",
      ) ?? [],
    ).map((node) => node.textContent);
    expect(firstGroupItems).toEqual([
      "Latest platform tab",
      "Older platform tab",
    ]);

    expect(screen.getByText("/repo/platform")).not.toBeNull();
    expect(screen.getByText("/repo/docs")).not.toBeNull();
    expect(screen.getByText("Unknown Project")).not.toBeNull();
  });

  it("collapses and expands project groups", async () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([{ path: "/repo/platform", name: "Platform API" }]),
    );

    persistenceMock.loadArchivedSessions.mockResolvedValue([
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

  it("searches across labels, titles, project names, and paths with flat ranked results", async () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([{ path: "/repo/platform", name: "Platform API" }]),
    );

    persistenceMock.loadArchivedSessions.mockResolvedValue([
      makeSession("auth", {
        label: "Auth tokens",
        tabTitle: "Refresh rotation",
        projectPath: "/repo/platform",
        cwd: "/repo/platform",
        updatedAt: 300,
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
    expect(screen.getByText("Browser tab")).not.toBeNull();
    expect(screen.getByText("docs · Memory cleanup")).not.toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search archived tabs" }), {
      target: { value: "platform" },
    });
    await waitFor(() => {
      expect(screen.getByText("Auth tokens")).not.toBeNull();
    });
    expect(screen.getByText("Platform API · Refresh rotation")).not.toBeNull();
    expect(screen.queryByText("Browser tab")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search archived tabs" }), {
      target: { value: "repo runtime" },
    });
    await waitFor(() => {
      expect(screen.getByText("Background worker")).not.toBeNull();
    });
    expect(screen.getByText("runtime")).not.toBeNull();
    expect(screen.queryByText("Auth tokens")).toBeNull();
  });

  it("updates the visible list when deleting search results and restores grouped items", async () => {
    const platformSession = makeSession("platform", {
      label: "Platform work",
      tabTitle: "Ship auth fix",
      projectPath: "/repo/platform",
      cwd: "/repo/platform",
      updatedAt: 300,
    });
    const docsSession = makeSession("docs", {
      label: "Docs notes",
      tabTitle: "Memory cleanup",
      projectPath: "",
      cwd: "/repo/docs",
      updatedAt: 200,
    });

    persistenceMock.loadArchivedSessions.mockResolvedValue([
      platformSession,
      docsSession,
    ]);

    render(<ArchivedTabsMenu />);
    await openMenu();

    fireEvent.change(screen.getByRole("textbox", { name: "Search archived tabs" }), {
      target: { value: "cleanup" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Docs notes" }));

    await waitFor(() => {
      expect(persistenceMock.deleteSession).toHaveBeenCalledWith("docs");
    });
    expect(screen.queryByText("Docs notes")).toBeNull();
    expect(screen.getByText("No archived tabs match")).not.toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search archived tabs" }), {
      target: { value: "" },
    });
    await waitFor(() => {
      expect(screen.getByTitle("Restore: Platform work")).not.toBeNull();
    });
    fireEvent.click(screen.getByTitle("Restore: Platform work"));

    await waitFor(() => {
      expect(sessionRestoreMock.restoreArchivedTab).toHaveBeenCalledWith(
        platformSession,
        tabsContextMock.value.addTabWithId,
      );
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

    persistenceMock.loadArchivedSessions.mockResolvedValue(sessions);

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
});
