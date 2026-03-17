// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import CliLaunchManager from "./CliLaunchManager";

const tabsMock = vi.hoisted(() => ({
  value: {
    activeTabId: "tab-1",
    addTab: vi.fn<(partial?: Record<string, unknown>) => string>(),
    setActiveTab: vi.fn<(id: string) => void>(),
    tabs: [] as Array<{
      id: string;
      label: string;
      icon: string;
      mode: "new" | "workspace";
      status: "idle";
    }>,
    updateTab: vi.fn<(id: string, changes: Record<string, unknown>) => void>(),
  },
}));

const cliMocks = vi.hoisted(() => ({
  listenForCliOpenRequestsMock: vi.fn(),
  takePendingCliRequestsMock: vi.fn(),
  requestHandler: null as null | ((request: { path?: string; addProject: boolean }) => void),
}));

const agentMocks = vi.hoisted(() => ({
  getAgentStateMock: vi.fn(),
  patchAgentStateMock: vi.fn(),
}));

const persistenceMocks = vi.hoisted(() => ({
  isSessionEmptyMock: vi.fn(),
  upsertSessionMock: vi.fn(),
}));

const projectMocks = vi.hoisted(() => ({
  inferProjectNameMock: vi.fn((path: string) => path.split("/").filter(Boolean).pop() ?? path),
  resolveSavedProjectMock: vi.fn(),
  upsertSavedProjectPreservingLearnedFactsMock: vi.fn(),
}));

vi.mock("@/contexts/TabsContext", () => ({
  useTabs: () => tabsMock.value,
}));

vi.mock("@/cli", () => ({
  listenForCliOpenRequests: (...args: unknown[]) =>
    cliMocks.listenForCliOpenRequestsMock(...args),
  takePendingCliRequests: (...args: unknown[]) =>
    cliMocks.takePendingCliRequestsMock(...args),
}));

vi.mock("@/agent/atoms", () => ({
  getAgentState: (...args: unknown[]) => agentMocks.getAgentStateMock(...args),
  patchAgentState: (...args: unknown[]) => agentMocks.patchAgentStateMock(...args),
}));

vi.mock("@/agent/persistence", () => ({
  isSessionEmpty: (...args: unknown[]) => persistenceMocks.isSessionEmptyMock(...args),
  upsertSession: (...args: unknown[]) => persistenceMocks.upsertSessionMock(...args),
}));

vi.mock("@/projects", () => ({
  DEFAULT_PROJECT_ICON: "folder",
  inferProjectName: (path: string) => projectMocks.inferProjectNameMock(path),
  resolveSavedProject: (project: unknown) =>
    projectMocks.resolveSavedProjectMock(project),
  upsertSavedProjectPreservingLearnedFacts: (project: unknown) =>
    projectMocks.upsertSavedProjectPreservingLearnedFactsMock(project),
}));

describe("CliLaunchManager", () => {
  beforeEach(() => {
    cleanup();
    tabsMock.value.activeTabId = "tab-1";
    tabsMock.value.addTab.mockReset();
    tabsMock.value.setActiveTab.mockReset();
    tabsMock.value.updateTab.mockReset();
    tabsMock.value.tabs = [];
    cliMocks.listenForCliOpenRequestsMock.mockReset();
    cliMocks.takePendingCliRequestsMock.mockReset();
    cliMocks.requestHandler = null;
    agentMocks.getAgentStateMock.mockReset();
    agentMocks.patchAgentStateMock.mockReset();
    persistenceMocks.isSessionEmptyMock.mockReset();
    persistenceMocks.upsertSessionMock.mockReset();
    projectMocks.inferProjectNameMock.mockReset();
    projectMocks.resolveSavedProjectMock.mockReset();
    projectMocks.upsertSavedProjectPreservingLearnedFactsMock.mockReset();

    projectMocks.inferProjectNameMock.mockImplementation(
      (path: string) => path.split("/").filter(Boolean).pop() ?? path,
    );
    cliMocks.takePendingCliRequestsMock.mockResolvedValue([]);
    cliMocks.listenForCliOpenRequestsMock.mockImplementation(
      async (handler: (request: { path?: string; addProject: boolean }) => void) => {
        cliMocks.requestHandler = handler;
        return () => {
          cliMocks.requestHandler = null;
        };
      },
    );
    agentMocks.getAgentStateMock.mockReturnValue({});
    persistenceMocks.isSessionEmptyMock.mockReturnValue(false);
    persistenceMocks.upsertSessionMock.mockResolvedValue(undefined);
    projectMocks.upsertSavedProjectPreservingLearnedFactsMock.mockResolvedValue([]);
    projectMocks.resolveSavedProjectMock.mockImplementation(async (project) => project);
    tabsMock.value.addTab.mockReturnValue("tab-2");
  });

  afterEach(() => {
    cleanup();
  });

  it("reuses the lone blank new tab for a pending CLI request", async () => {
    tabsMock.value.tabs = [
      {
        id: "tab-1",
        label: "New Tab",
        icon: "chat_bubble_outline",
        mode: "new",
        status: "idle",
      },
    ];
    cliMocks.takePendingCliRequestsMock.mockResolvedValue([
      { path: "/repo/cold-start", addProject: false },
    ]);
    persistenceMocks.isSessionEmptyMock.mockReturnValue(true);

    render(<CliLaunchManager />);

    await waitFor(() => {
      expect(tabsMock.value.updateTab).toHaveBeenCalledWith("tab-1", {
        mode: "workspace",
        label: "cold-start",
        icon: "folder",
        status: "idle",
      });
    });
    expect(tabsMock.value.addTab).not.toHaveBeenCalled();
    expect(tabsMock.value.setActiveTab).toHaveBeenCalledWith("tab-1");
    expect(persistenceMocks.upsertSessionMock).toHaveBeenCalledWith({
      id: "tab-1",
      label: "cold-start",
      icon: "folder",
      status: "idle",
      mode: "workspace",
    });
  });

  it("opens a new workspace tab for a live CLI request while running", async () => {
    tabsMock.value.tabs = [
      {
        id: "tab-1",
        label: "Workspace",
        icon: "chat_bubble_outline",
        mode: "workspace",
        status: "idle",
      },
    ];

    render(<CliLaunchManager />);

    await waitFor(() => {
      expect(cliMocks.requestHandler).not.toBeNull();
    });

    cliMocks.requestHandler?.({ path: "/repo/live-open", addProject: false });

    await waitFor(() => {
      expect(tabsMock.value.addTab).toHaveBeenCalledWith({
        mode: "workspace",
        label: "live-open",
        icon: "folder",
        status: "idle",
      });
    });
    expect(tabsMock.value.setActiveTab).toHaveBeenCalledWith("tab-2");
    expect(persistenceMocks.upsertSessionMock).toHaveBeenCalledWith({
      id: "tab-2",
      label: "live-open",
      icon: "folder",
      status: "idle",
      mode: "workspace",
    });
  });

  it("adds a saved project and sets project config for -a requests", async () => {
    tabsMock.value.tabs = [
      {
        id: "tab-1",
        label: "Workspace",
        icon: "chat_bubble_outline",
        mode: "workspace",
        status: "idle",
      },
    ];
    const resolvedProject = {
      path: "/repo/with-project",
      name: "with-project",
      icon: "inventory_2",
      setupCommand: "pnpm install",
    };
    projectMocks.upsertSavedProjectPreservingLearnedFactsMock.mockResolvedValue([
      resolvedProject,
    ]);
    projectMocks.resolveSavedProjectMock.mockResolvedValue(resolvedProject);

    render(<CliLaunchManager />);

    await waitFor(() => {
      expect(cliMocks.requestHandler).not.toBeNull();
    });

    cliMocks.requestHandler?.({ path: "/repo/with-project", addProject: true });

    await waitFor(() => {
      expect(projectMocks.upsertSavedProjectPreservingLearnedFactsMock).toHaveBeenCalled();
    });

    const [, updater] = agentMocks.patchAgentStateMock.mock.calls[0];
    const nextState = updater({
      config: { cwd: "", model: "openai/gpt-5.2" },
      status: "idle",
      error: "boom",
      errorDetails: { bad: true },
      errorAction: { type: "noop" },
    });

    expect(projectMocks.resolveSavedProjectMock).toHaveBeenCalledWith(resolvedProject);
    expect(nextState.config.cwd).toBe("/repo/with-project");
    expect(nextState.config.projectPath).toBe("/repo/with-project");
    expect(nextState.config.setupCommand).toBe("pnpm install");
  });
});
