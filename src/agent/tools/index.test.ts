import { beforeEach, describe, expect, it, vi } from "vitest";

type MockAgentState = {
  reviewEdits: Array<{
    filePath: string;
    diffFile: unknown;
    originalContent: string;
    timestamp: number;
  }>;
};

const {
  listDirMock,
  statFileMock,
  readFileMock,
  writeFileMock,
  editFileMock,
  globMock,
  searchFilesMock,
  execRunMock,
  gitWorktreeInitMock,
  planSetMock,
  planEditMock,
  planGetMock,
  todoAddMock,
  todoUpdateMock,
  todoListMock,
  todoRemoveMock,
  cardAddMock,
  titleSetMock,
  titleGetMock,
  artifactCreateMock,
  artifactVersionMock,
  artifactGetMock,
  artifactListMock,
  computeDiffFileMock,
  patchAgentStateMock,
  getAgentStateMock,
  states,
} = vi.hoisted(() => ({
  listDirMock: vi.fn(),
  statFileMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  editFileMock: vi.fn(),
  globMock: vi.fn(),
  searchFilesMock: vi.fn(),
  execRunMock: vi.fn(),
  gitWorktreeInitMock: vi.fn(),
  planSetMock: vi.fn(),
  planEditMock: vi.fn(),
  planGetMock: vi.fn(),
  todoAddMock: vi.fn(),
  todoUpdateMock: vi.fn(),
  todoListMock: vi.fn(),
  todoRemoveMock: vi.fn(),
  cardAddMock: vi.fn(),
  titleSetMock: vi.fn(),
  titleGetMock: vi.fn(),
  artifactCreateMock: vi.fn(),
  artifactVersionMock: vi.fn(),
  artifactGetMock: vi.fn(),
  artifactListMock: vi.fn(),
  computeDiffFileMock: vi.fn(),
  patchAgentStateMock: vi.fn(),
  getAgentStateMock: vi.fn(),
  states: {} as Record<string, MockAgentState>,
}));

vi.mock("./workspace", () => ({
  listDir: (...args: unknown[]) => listDirMock(...args),
  statFile: (...args: unknown[]) => statFileMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  editFile: (...args: unknown[]) => editFileMock(...args),
  glob: (...args: unknown[]) => globMock(...args),
  searchFiles: (...args: unknown[]) => searchFilesMock(...args),
}));

vi.mock("./exec", () => ({
  execRun: (...args: unknown[]) => execRunMock(...args),
}));

vi.mock("./git", () => ({
  gitWorktreeInit: (...args: unknown[]) => gitWorktreeInitMock(...args),
}));

vi.mock("./agentControl", () => ({
  planSet: (...args: unknown[]) => planSetMock(...args),
  planEdit: (...args: unknown[]) => planEditMock(...args),
  planGet: (...args: unknown[]) => planGetMock(...args),
  todoAdd: (...args: unknown[]) => todoAddMock(...args),
  todoUpdate: (...args: unknown[]) => todoUpdateMock(...args),
  todoList: (...args: unknown[]) => todoListMock(...args),
  todoRemove: (...args: unknown[]) => todoRemoveMock(...args),
  cardAdd: (...args: unknown[]) => cardAddMock(...args),
  titleSet: (...args: unknown[]) => titleSetMock(...args),
  titleGet: (...args: unknown[]) => titleGetMock(...args),
}));

vi.mock("./artifacts", () => ({
  artifactCreate: (...args: unknown[]) => artifactCreateMock(...args),
  artifactVersion: (...args: unknown[]) => artifactVersionMock(...args),
  artifactGet: (...args: unknown[]) => artifactGetMock(...args),
  artifactList: (...args: unknown[]) => artifactListMock(...args),
}));

vi.mock("../patchToDiff", () => ({
  computeDiffFile: (...args: unknown[]) => computeDiffFileMock(...args),
}));

vi.mock("../atoms", () => ({
  getAgentState: (...args: unknown[]) => getAgentStateMock(...args),
  patchAgentState: (...args: unknown[]) => patchAgentStateMock(...args),
}));

import { dispatchTool } from "./index";

function setState(tabId: string, state?: Partial<MockAgentState>): void {
  states[tabId] = {
    reviewEdits: [],
    ...state,
  };
}

describe("tools/index dispatchTool", () => {
  beforeEach(() => {
    listDirMock.mockReset();
    statFileMock.mockReset();
    readFileMock.mockReset();
    writeFileMock.mockReset();
    editFileMock.mockReset();
    globMock.mockReset();
    searchFilesMock.mockReset();
    execRunMock.mockReset();
    gitWorktreeInitMock.mockReset();
    planSetMock.mockReset();
    planEditMock.mockReset();
    planGetMock.mockReset();
    todoAddMock.mockReset();
    todoUpdateMock.mockReset();
    todoListMock.mockReset();
    todoRemoveMock.mockReset();
    cardAddMock.mockReset();
    titleSetMock.mockReset();
    titleGetMock.mockReset();
    artifactCreateMock.mockReset();
    artifactVersionMock.mockReset();
    artifactGetMock.mockReset();
    artifactListMock.mockReset();
    computeDiffFileMock.mockReset();
    patchAgentStateMock.mockReset();
    getAgentStateMock.mockReset();

    for (const key of Object.keys(states)) {
      delete states[key];
    }

    getAgentStateMock.mockImplementation((tabId: unknown) => {
      const key = String(tabId);
      if (!states[key]) setState(key);
      return states[key];
    });

    patchAgentStateMock.mockImplementation(
      (
        tabId: unknown,
        patch:
          | Partial<MockAgentState>
          | ((prev: MockAgentState) => MockAgentState),
      ) => {
        const key = String(tabId);
        const prev = states[key];
        states[key] =
          typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      },
    );
  });

  it("returns INVALID_ARGUMENT for unknown tools", async () => {
    const result = await dispatchTool("tab", "/cwd", "tool_unknown", {});
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
      },
    });
  });

  it("routes workspace_listDir calls to listDir", async () => {
    listDirMock.mockResolvedValue({
      ok: true,
      data: { path: "/cwd/src", entries: [], truncated: false },
    });

    const result = await dispatchTool(
      "tab",
      "/cwd",
      "workspace_listDir",
      { path: "src" },
      "tc-1",
    );

    expect(listDirMock).toHaveBeenCalledWith("/cwd", { path: "src" }, undefined);
    expect(result).toMatchObject({ ok: true });
  });

  it("passes runtime logContext through workspace and exec dispatch", async () => {
    const logContext = {
      sessionId: "tab",
      tabId: "tab",
      traceId: "trace:run-1:main",
      correlationId: "tc-log",
    };
    listDirMock.mockResolvedValue({
      ok: true,
      data: { path: "/cwd/src", entries: [], truncated: false },
    });
    execRunMock.mockResolvedValue({ ok: true, data: { exitCode: 0 } });

    await dispatchTool(
      "tab",
      "/cwd",
      "workspace_listDir",
      { path: "src" },
      "tc-log",
      undefined,
      { runId: "run_1", agentId: "agent_main", logContext },
    );
    await dispatchTool(
      "tab",
      "/cwd",
      "exec_run",
      { command: "pwd" },
      "tc-log",
      undefined,
      { runId: "run_1", agentId: "agent_main", logContext },
    );

    expect(listDirMock).toHaveBeenCalledWith("/cwd", { path: "src" }, logContext);
    expect(execRunMock).toHaveBeenCalledWith(
      "/cwd",
      expect.objectContaining({
        command: "pwd",
        runId: "tc-log",
      }),
      undefined,
      logContext,
    );
  });

  it("routes agent_card_add calls to cardAdd", async () => {
    cardAddMock.mockReturnValue({
      ok: true,
      data: { cardId: "card_1", kind: "summary" },
    });

    const result = await dispatchTool(
      "tab",
      "/cwd",
      "agent_card_add",
      { kind: "summary", markdown: "## Summary" },
      "tc-card",
    );

    expect(cardAddMock).toHaveBeenCalledWith("tab", {
      kind: "summary",
      markdown: "## Summary",
    });
    expect(result).toEqual({
      ok: true,
      data: { cardId: "card_1", kind: "summary" },
    });
  });

  it("handles workspace_editFile success and updates reviewEdits", async () => {
    setState("tab-edit");

    readFileMock
      .mockResolvedValueOnce({ ok: true, data: { content: "original content" } }) // snapshotOriginal
      .mockResolvedValueOnce({ ok: true, data: { content: "edited content" } });  // post-edit read

    editFileMock.mockResolvedValue({
      ok: true,
      data: { path: "file.txt", bytesWritten: 14, appliedChanges: 1 },
    });

    computeDiffFileMock.mockImplementation(
      (filename: string, originalContent: string, currentContent: string) => ({
        filename,
        originalContent,
        currentContent,
        adds: 1,
        removes: 1,
        lines: [],
      }),
    );

    const result = await dispatchTool(
      "tab-edit",
      "/cwd",
      "workspace_editFile",
      { path: "file.txt", changes: [{ oldString: "original", newString: "edited" }] },
      "tc-4",
    );

    expect(result).toMatchObject({ ok: true });
    expect(editFileMock).toHaveBeenCalledWith("/cwd", {
      path: "file.txt",
      changes: [{ oldString: "original", newString: "edited" }],
    }, undefined);
    expect(computeDiffFileMock).toHaveBeenCalledWith(
      "file.txt",
      "original content",
      "edited content",
    );
    const editPaths = states["tab-edit"].reviewEdits.map((e) => e.filePath);
    expect(editPaths).toContain("file.txt");
  });

  it("does not update reviewEdits when workspace_editFile fails", async () => {
    setState("tab-edit-fail", {
      reviewEdits: [
        {
          filePath: "existing.txt",
        diffFile: JSON.stringify({ filename: "existing.txt" }),
          originalContent: "content",
          timestamp: 1,
        },
      ],
    });

    readFileMock.mockResolvedValueOnce({ ok: true, data: { content: "before" } });
    editFileMock.mockResolvedValue({
      ok: false,
      error: { code: "CONFLICT", message: "not found" },
    });

    const result = await dispatchTool(
      "tab-edit-fail",
      "/cwd",
      "workspace_editFile",
      { path: "file.txt", changes: [{ oldString: "x", newString: "y" }] },
      "tc-5",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(states["tab-edit-fail"].reviewEdits).toHaveLength(1);
    expect(states["tab-edit-fail"].reviewEdits[0].filePath).toBe("existing.txt");
  });

  it("handles workspace_writeFile success and updates reviewEdits", async () => {
    setState("tab-write");

    writeFileMock.mockResolvedValue({
      ok: true,
      data: { path: "new.ts", bytesWritten: 20, created: true, overwritten: false },
    });

    computeDiffFileMock.mockImplementation(
      (filename: string, originalContent: string, currentContent: string) => ({
        filename,
        originalContent,
        currentContent,
        adds: 1,
        removes: 0,
        lines: [],
      }),
    );

    const result = await dispatchTool(
      "tab-write",
      "/cwd",
      "workspace_writeFile",
      { path: "new.ts", content: "export const x = 1;", overwrite: false },
      "tc-6",
    );

    expect(result).toMatchObject({ ok: true });
    expect(writeFileMock).toHaveBeenCalledWith("/cwd", {
      path: "new.ts",
      content: "export const x = 1;",
      mode: "create",
      createDirs: true,
    }, undefined);
    expect(computeDiffFileMock).toHaveBeenCalledWith(
      "new.ts",
      "",
      "export const x = 1;",
    );
    const editPaths = states["tab-write"].reviewEdits.map((e) => e.filePath);
    expect(editPaths).toContain("new.ts");
  });

  it("passes toolCallId to git_worktree_init", async () => {
    gitWorktreeInitMock.mockResolvedValue({
      ok: true,
      data: {
        path: "/tmp/worktree",
        branch: "codex/feature",
        setup: { status: "not_configured" },
      },
    });

    const result = await dispatchTool(
      "tab",
      "/cwd",
      "git_worktree_init",
      { suggestedBranch: "feature branch" },
      "tool-call-7",
    );

    expect(gitWorktreeInitMock).toHaveBeenCalledWith(
      "tab",
      "tool-call-7",
      "/cwd",
      { suggestedBranch: "feature branch" },
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("passes onExecOutput callback to git_worktree_init when callbacks provided", async () => {
    gitWorktreeInitMock.mockResolvedValue({
      ok: true,
      data: {
        path: "/tmp/worktree",
        branch: "codex/feature",
        setup: { status: "not_configured" },
      },
    });

    const onExecOutput = vi.fn();
    await dispatchTool(
      "tab",
      "/cwd",
      "git_worktree_init",
      { suggestedBranch: "feature branch" },
      "tool-call-7b",
      { onExecOutput },
    );

    expect(gitWorktreeInitMock).toHaveBeenCalledWith(
      "tab",
      "tool-call-7b",
      "/cwd",
      { suggestedBranch: "feature branch" },
      onExecOutput,
      undefined,
    );
  });

  it("passes toolCallId to exec_run as runId", async () => {
    execRunMock.mockResolvedValue({
      ok: true,
      data: { exitCode: 0, stdout: "", stderr: "" },
    });

    const result = await dispatchTool(
      "tab",
      "/cwd",
      "exec_run",
      { command: "pwd" },
      "tool-call-exec",
    );

    expect(execRunMock).toHaveBeenCalledWith(
      "/cwd",
      { command: "pwd", runId: "tool-call-exec" },
      undefined, // no onExecOutput when no callbacks provided
      undefined,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("passes onExecOutput callback to exec_run when callbacks provided", async () => {
    execRunMock.mockResolvedValue({
      ok: true,
      data: { exitCode: 0, stdout: "", stderr: "" },
    });

    const onExecOutput = vi.fn();
    await dispatchTool(
      "tab",
      "/cwd",
      "exec_run",
      { command: "pwd" },
      "tc-cb",
      { onExecOutput },
    );

    expect(execRunMock).toHaveBeenCalledWith(
      "/cwd",
      { command: "pwd", runId: "tc-cb" },
      onExecOutput,
      undefined,
    );
  });

  it("routes agent_artifact_create with runtime context", async () => {
    artifactCreateMock.mockResolvedValue({
      ok: true,
      data: { artifact: { artifactId: "a1", version: 1 } },
    });

    const runtime = { runId: "run_1", agentId: "agent_main" };
    const result = await dispatchTool(
      "tab",
      "/cwd",
      "agent_artifact_create",
      {
        kind: "report",
        targets: [{ type: "path", value: "src/index.ts" }],
        contentFormat: "markdown",
        content: "# hi",
      },
      "tc-artifact-create",
      undefined,
      runtime,
    );

    expect(artifactCreateMock).toHaveBeenCalledWith(
      "tab",
      runtime,
      expect.objectContaining({ kind: "report" }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("routes artifact version/get/list tools", async () => {
    artifactVersionMock.mockResolvedValue({
      ok: true,
      data: { artifact: { artifactId: "a1", version: 2 } },
    });
    artifactGetMock.mockResolvedValue({
      ok: true,
      data: { artifact: { artifactId: "a1", version: 2 } },
    });
    artifactListMock.mockResolvedValue({
      ok: true,
      data: { artifacts: [] },
    });

    await dispatchTool(
      "tab",
      "/cwd",
      "agent_artifact_version",
      { artifactId: "a1" },
      "tc-artifact-version",
      undefined,
      { runId: "run_1", agentId: "agent_main" },
    );
    await dispatchTool(
      "tab",
      "/cwd",
      "agent_artifact_get",
      { artifactId: "a1" },
      "tc-artifact-get",
    );
    await dispatchTool(
      "tab",
      "/cwd",
      "agent_artifact_list",
      { latestOnly: true },
      "tc-artifact-list",
    );

    expect(artifactVersionMock).toHaveBeenCalledTimes(1);
    expect(artifactGetMock).toHaveBeenCalledWith("tab", { artifactId: "a1" }, undefined);
    expect(artifactListMock).toHaveBeenCalledWith("tab", { latestOnly: true }, undefined);
  });
});
