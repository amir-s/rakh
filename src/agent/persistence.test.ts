import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  invokeMock,
  getAgentStateMock,
  defaultModel,
  stateByTab,
  consoleErrorSpy,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getAgentStateMock: vi.fn(),
  defaultModel: "openai/gpt-5.2",
  stateByTab: {} as Record<string, unknown>,
  consoleErrorSpy: vi.spyOn(console, "error").mockImplementation(() => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./atoms", () => ({
  getAgentState: (...args: unknown[]) => getAgentStateMock(...args),
  DEFAULT_MODEL: defaultModel,
}));

import {
  archiveSession,
  buildPersistedSession,
  deleteSession,
  isSessionEmpty,
  loadArchivedSessions,
  loadSessions,
  restoreSession,
  upsertSession,
  upsertWorkspaceSessions,
  type PersistedSession,
} from "./persistence";
import { Tab } from "@/contexts/TabsContext";

function setTauriAvailable(value: boolean): void {
  if (value) {
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: {},
    };
  } else {
    (globalThis as unknown as { window?: unknown }).window = undefined;
  }
}

describe("persistence", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    getAgentStateMock.mockReset();
    consoleErrorSpy.mockClear();
    for (const key of Object.keys(stateByTab)) {
      delete stateByTab[key];
    }
    getAgentStateMock.mockImplementation(
      (tabId: unknown) => stateByTab[String(tabId)],
    );
    setTauriAvailable(false);
  });

  it("buildPersistedSession serializes agent state with defaults", () => {
    const tab = {
      id: "tab-1",
      label: "Workspace",
      icon: "folder",
      mode: "workspace",
      status: "idle",
    } as Tab;
    const state = {
      tabTitle: "Task",
      config: {
        cwd: "/repo",
        model: "",
        worktreePath: undefined,
        worktreeBranch: undefined,
      },
      plan: { markdown: "plan", version: 2, updatedAtMs: 100 },
      chatMessages: [{ role: "user", content: "hello" }],
      apiMessages: [{ role: "user", content: "hello" }],
      todos: [{ id: "a" }],
      reviewEdits: [{ filePath: "a.ts" }],
    } as unknown as Parameters<typeof buildPersistedSession>[1];

    const session = buildPersistedSession(tab, state);
    expect(session.id).toBe("tab-1");
    expect(session.model).toBe(defaultModel);
    expect(session.chatMessages).toBe(JSON.stringify(state.chatMessages));
    expect(session.apiMessages).toBe(JSON.stringify(state.apiMessages));
    expect(session.todos).toBe(JSON.stringify(state.todos));
    expect(session.reviewEdits).toBe(JSON.stringify(state.reviewEdits));
    expect(session.worktreePath).toBe("");
    expect(session.worktreeBranch).toBe("");
    expect(session.worktreeDeclined).toBe(false);
    expect(session.showDebug).toBe(false);
  });

  it("isSessionEmpty returns true for a blank/default agent state", () => {
    const state = {
      chatMessages: [],
      apiMessages: [],
      todos: [],
      reviewEdits: [],
      tabTitle: "",
      plan: { markdown: "", version: 0, updatedAtMs: 0 },
      error: null,
    } as unknown as Parameters<typeof isSessionEmpty>[0];

    expect(isSessionEmpty(state)).toBe(true);
  });

  it("isSessionEmpty returns false when tab has meaningful content", () => {
    const withChat = {
      chatMessages: [{ id: "1" }],
      apiMessages: [],
      todos: [],
      reviewEdits: [],
      tabTitle: "",
      plan: { markdown: "", version: 0, updatedAtMs: 0 },
      error: null,
    } as unknown as Parameters<typeof isSessionEmpty>[0];
    const withPlan = {
      chatMessages: [],
      apiMessages: [],
      todos: [],
      reviewEdits: [],
      tabTitle: "",
      plan: { markdown: "Plan", version: 1, updatedAtMs: 123 },
      error: null,
    } as unknown as Parameters<typeof isSessionEmpty>[0];
    const withError = {
      chatMessages: [],
      apiMessages: [],
      todos: [],
      reviewEdits: [],
      tabTitle: "",
      plan: { markdown: "", version: 0, updatedAtMs: 0 },
      error: "boom",
    } as unknown as Parameters<typeof isSessionEmpty>[0];

    expect(isSessionEmpty(withChat)).toBe(false);
    expect(isSessionEmpty(withPlan)).toBe(false);
    expect(isSessionEmpty(withError)).toBe(false);
  });

  it("loadSessions returns [] when not running in Tauri", async () => {
    const sessions = await loadSessions();
    expect(sessions).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("loadSessions invokes db_load_sessions in Tauri mode", async () => {
    setTauriAvailable(true);
    invokeMock.mockResolvedValueOnce([{ id: "s1" }]);

    const sessions = await loadSessions();
    expect(sessions).toEqual([{ id: "s1" }]);
    expect(invokeMock).toHaveBeenCalledWith("db_load_sessions", undefined);
  });

  it("loadSessions returns [] and logs when invoke fails", async () => {
    setTauriAvailable(true);
    invokeMock.mockRejectedValueOnce(new Error("db down"));

    const sessions = await loadSessions();
    expect(sessions).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("upsertSession is no-op outside Tauri and for non-workspace tabs", async () => {
    stateByTab["tab-1"] = {
      tabTitle: "",
      config: { cwd: "/repo", model: "m1" },
      plan: { markdown: "", version: 0, updatedAtMs: 0 },
      chatMessages: [],
      apiMessages: [],
      todos: [],
      reviewEdits: [],
    };

    await upsertSession({
      id: "tab-1",
      label: "New",
      icon: "plus",
      mode: "new",
    } as never);
    expect(invokeMock).not.toHaveBeenCalled();

    setTauriAvailable(true);
    await upsertSession({
      id: "tab-1",
      label: "New",
      icon: "plus",
      mode: "new",
    } as never);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("upsertSession persists workspace tabs through db_upsert_session", async () => {
    setTauriAvailable(true);
    stateByTab["tab-w"] = {
      tabTitle: "Title",
      config: {
        cwd: "/repo",
        model: "model-x",
        worktreePath: "/wt",
        worktreeBranch: "codex/branch",
        worktreeDeclined: true,
      },
      plan: { markdown: "md", version: 1, updatedAtMs: 2 },
      chatMessages: [{ id: "c1" }],
      apiMessages: [{ role: "user", content: "hi" }],
      todos: [{ id: "t1" }],
      reviewEdits: [{ filePath: "a.ts" }],
      showDebug: true,
    };

    await upsertSession({
      id: "tab-w",
      label: "Workspace",
      icon: "folder",
      mode: "workspace",
    } as never);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("db_upsert_session");
    const payload = invokeMock.mock.calls[0][1] as {
      session: PersistedSession;
    };
    expect(payload.session.id).toBe("tab-w");
    expect(payload.session.cwd).toBe("/repo");
    expect(payload.session.worktreePath).toBe("/wt");
    expect(payload.session.worktreeBranch).toBe("codex/branch");
    expect(payload.session.worktreeDeclined).toBe(true);
    expect(payload.session.showDebug).toBe(true);
  });

  it("upsertWorkspaceSessions only persists workspace tabs", async () => {
    setTauriAvailable(true);
    stateByTab["tab-a"] = {
      tabTitle: "Workspace A",
      config: { cwd: "/repo-a", model: "model-a" },
      plan: { markdown: "", version: 0, updatedAtMs: 0 },
      chatMessages: [],
      apiMessages: [],
      todos: [],
      reviewEdits: [],
    };

    await upsertWorkspaceSessions([
      {
        id: "tab-a",
        label: "Workspace A",
        icon: "folder",
        mode: "workspace",
      } as Tab,
      {
        id: "tab-b",
        label: "New Tab",
        icon: "chat_bubble_outline",
        mode: "new",
      } as Tab,
    ]);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("db_upsert_session");
    const payload = invokeMock.mock.calls[0][1] as {
      session: PersistedSession;
    };
    expect(payload.session.id).toBe("tab-a");
    expect(payload.session.mode).toBe("workspace");
  });

  it("archive/loadArchived/restore/delete call the right db commands", async () => {
    setTauriAvailable(true);
    invokeMock
      .mockResolvedValueOnce(undefined) // archive
      .mockResolvedValueOnce([{ id: "archived-1" }]) // load archived
      .mockResolvedValueOnce(undefined) // restore
      .mockResolvedValueOnce(undefined); // delete

    await archiveSession("s-1");
    const archived = await loadArchivedSessions();
    await restoreSession({
      id: "s-restore",
      label: "l",
      icon: "i",
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
      archived: true,
      createdAt: 1,
      updatedAt: 1,
      worktreePath: "",
      worktreeBranch: "",
      worktreeDeclined: false,
      showDebug: false,
      advancedOptions: "{}",
    });
    await deleteSession("s-del");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "db_archive_session", {
      id: "s-1",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "db_load_archived_sessions",
      undefined,
    );
    expect(archived).toEqual([{ id: "archived-1" }]);
    expect(invokeMock).toHaveBeenNthCalledWith(3, "db_upsert_session", {
      session: expect.objectContaining({ id: "s-restore", archived: false }),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "db_delete_session", {
      id: "s-del",
    });
  });
});
