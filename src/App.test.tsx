// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atom, createStore } from "jotai";

const appMocks = vi.hoisted(() => ({
  loadSessionsMock: vi.fn(),
  loadProvidersMock: vi.fn(),
  loadProfilesMock: vi.fn(),
  loadCommandListMock: vi.fn(),
  loadSavedProjectsMock: vi.fn(),
  loadMcpServersMock: vi.fn(),
  loadMcpSettingsMock: vi.fn(),
  loadGatewayPolicySettingsMock: vi.fn(),
  parseLogNavigatePayloadFromSearchMock: vi.fn(),
  logsWindowAppMock: vi.fn(),
  workspacePageMock: vi.fn(),
  topChromeMock: vi.fn(),
}));

vi.mock("@/components/TopChrome", () => ({
  default: () => {
    appMocks.topChromeMock();
    return <div>top chrome</div>;
  },
}));

vi.mock("@/components/AgentNotificationManager", () => ({
  default: () => <div>notifications</div>,
}));

vi.mock("@/components/DesktopTrayManager", () => ({
  default: () => <div>tray</div>,
}));

vi.mock("@/contexts/TabsContext", () => ({
  TabsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTabs: () => ({
    tabs: [],
    activeTabId: "tab-1",
  }),
}));

vi.mock("@/agent/atoms", () => ({
  jotaiStore: createStore(),
  themeModeAtom: atom("dark"),
  themeNameAtom: atom("default"),
  defaultCommunicationProfileAtom: atom("pragmatic"),
  agentAtomFamily: vi.fn(),
  debugModeEnabledAtom: atom(false),
  patchAgentState: vi.fn(),
}));

vi.mock("@/agent/db", () => ({
  loadProviders: (...args: unknown[]) => appMocks.loadProvidersMock(...args),
  providersAtom: atom([]),
  loadProfiles: (...args: unknown[]) => appMocks.loadProfilesMock(...args),
  profilesAtom: atom([]),
  loadCommandList: (...args: unknown[]) => appMocks.loadCommandListMock(...args),
  commandListAtom: atom([]),
}));

vi.mock("@/agent/mcp", () => ({
  loadMcpServers: (...args: unknown[]) => appMocks.loadMcpServersMock(...args),
  loadMcpSettings: (...args: unknown[]) => appMocks.loadMcpSettingsMock(...args),
  mcpServersAtom: atom([]),
  mcpSettingsAtom: atom({}),
}));

vi.mock("@/agent/gatewayPolicySettings", () => ({
  loadGatewayPolicySettings: (...args: unknown[]) =>
    appMocks.loadGatewayPolicySettingsMock(...args),
  gatewayPolicySettingsAtom: atom({}),
}));

vi.mock("@/agent/sessionRestore", () => ({
  hydratePersistedSession: vi.fn(),
}));

vi.mock("@/WorkspacePage", () => ({
  default: () => {
    appMocks.workspacePageMock();
    return <div>workspace page</div>;
  },
}));

vi.mock("@/components/settings/SettingsPage", () => ({
  default: () => <div>settings page</div>,
}));

vi.mock("@/agent/persistence", () => ({
  loadSessions: (...args: unknown[]) => appMocks.loadSessionsMock(...args),
  upsertSession: vi.fn(),
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  isSessionEmpty: vi.fn(() => false),
  markSessionAsPersisted: vi.fn(),
}));

vi.mock("@/projects", () => ({
  loadSavedProjects: (...args: unknown[]) => appMocks.loadSavedProjectsMock(...args),
}));

vi.mock("@/agent/useEnvProviderKeys", () => ({
  preloadEnvProviderKeys: vi.fn(),
}));

vi.mock("@/logging/client", () => ({
  logFrontendSoon: vi.fn(),
}));

vi.mock("@/logging/LogsWindowApp", () => ({
  default: ({
    initialPayload,
  }: {
    initialPayload: Record<string, unknown> | null;
  }) => {
    appMocks.logsWindowAppMock(initialPayload);
    return <div>logs window app</div>;
  },
}));

vi.mock("@/logging/window", () => ({
  LOG_WINDOW_MODE: "logs",
  parseLogNavigatePayloadFromSearch: (...args: unknown[]) =>
    appMocks.parseLogNavigatePayloadFromSearchMock(...args),
}));

vi.mock("@/agent/modelCatalog", () => ({
  STATIC_MODEL_CATALOG: [],
}));

vi.mock("@/styles/themes/registry", () => ({
  getThemeSubagentColorVariables: () => ({}),
}));

vi.mock("@/updater", () => ({
  checkForAppUpdates: vi.fn(),
}));

vi.mock("@/ThemePreview", () => ({
  default: () => <div>theme preview</div>,
}));

describe("App", () => {
  beforeEach(() => {
    cleanup();
    appMocks.loadSessionsMock.mockReset();
    appMocks.loadProvidersMock.mockReset();
    appMocks.loadProfilesMock.mockReset();
    appMocks.loadCommandListMock.mockReset();
    appMocks.loadSavedProjectsMock.mockReset();
    appMocks.loadMcpServersMock.mockReset();
    appMocks.loadMcpSettingsMock.mockReset();
    appMocks.loadGatewayPolicySettingsMock.mockReset();
    appMocks.parseLogNavigatePayloadFromSearchMock.mockReset();
    appMocks.logsWindowAppMock.mockReset();
    appMocks.workspacePageMock.mockReset();
    appMocks.topChromeMock.mockReset();
    appMocks.loadSavedProjectsMock.mockResolvedValue([]);
    appMocks.loadGatewayPolicySettingsMock.mockResolvedValue({});
    appMocks.parseLogNavigatePayloadFromSearchMock.mockReturnValue({
      origin: "manual",
      filter: { limit: 250 },
      tailEnabled: true,
    });
    window.history.replaceState({}, "", "/?window=logs");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the detached logs window mode without bootstrapping the workspace shell", async () => {
    const { default: App } = await import("./App");

    render(<App />);

    expect(screen.getByText("logs window app")).not.toBeNull();
    expect(screen.queryByText("top chrome")).toBeNull();
    expect(screen.queryByText("workspace page")).toBeNull();
    expect(appMocks.loadSessionsMock).not.toHaveBeenCalled();
    expect(appMocks.parseLogNavigatePayloadFromSearchMock).toHaveBeenCalledWith(
      "?window=logs",
    );
    expect(appMocks.logsWindowAppMock).toHaveBeenCalledWith({
      origin: "manual",
      filter: { limit: 250 },
      tailEnabled: true,
    });
  });
});
