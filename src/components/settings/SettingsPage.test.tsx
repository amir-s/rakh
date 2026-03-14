// @vitest-environment jsdom

import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Provider } from "jotai";
import { TabsProvider, useTabs } from "@/contexts/TabsContext";
import {
  appUpdaterStateAtom,
  debugModeEnabledAtom,
  defaultAppUpdaterState,
  groupInlineToolCallsAtom,
  jotaiStore,
} from "@/agent/atoms";
import { providersAtom } from "@/agent/db";
import { mcpServersAtom, mcpSettingsAtom } from "@/agent/mcp";
import SettingsPage from "./SettingsPage";

const updaterMocks = vi.hoisted(() => ({
  checkForAppUpdatesMock: vi.fn<() => Promise<void>>(),
  installAppUpdateMock: vi.fn<
    (options?: { beforeInstall?: () => Promise<void> }) => Promise<void>
  >(),
}));

const mcpMocks = vi.hoisted(() => ({
  saveMcpServersMock: vi.fn<(servers: unknown[]) => Promise<void>>(),
  saveMcpSettingsMock: vi.fn<(settings: unknown) => Promise<void>>(),
  testMcpServerMock: vi.fn<(server: unknown) => Promise<unknown>>(),
}));

vi.mock("@/agent/useEnvProviderKeys", () => ({
  useEnvProviderKeys: () => [],
  isTauriRuntime: () => false,
  buildUniqueProviderName: (baseName: string) => baseName,
}));

vi.mock("@/notifications", () => ({
  ensureNotificationPermission: vi.fn(async () => true),
}));

vi.mock("@/agent/persistence", () => ({
  upsertWorkspaceSessions: vi.fn(async () => undefined),
}));

vi.mock("@/updater", () => ({
  checkForAppUpdates: () => updaterMocks.checkForAppUpdatesMock(),
  installAppUpdate: (options?: { beforeInstall?: () => Promise<void> }) =>
    updaterMocks.installAppUpdateMock(options),
  getAppUpdaterProgressValue: (state: {
    downloadedBytes: number;
    contentLength: number | null;
  }) => {
    if (!state.contentLength || state.contentLength <= 0) return null;
    return Math.min(
      100,
      Math.round((state.downloadedBytes / state.contentLength) * 100),
    );
  },
  getAppUpdaterStatusLabel: (state: { status: string }) => {
    switch (state.status) {
      case "available":
        return "Update ready";
      case "checking":
        return "Checking";
      case "installing":
        return "Installing";
      case "up-to-date":
        return "Up to date";
      default:
        return "Not checked";
    }
  },
  getAppUpdaterStatusVariant: (state: { status: string }) => {
    switch (state.status) {
      case "available":
        return "primary";
      case "up-to-date":
        return "success";
      case "error":
        return "danger";
      default:
        return "muted";
    }
  },
}));

vi.mock("@/agent/mcp", async () => {
  const actual = await vi.importActual<typeof import("@/agent/mcp")>(
    "@/agent/mcp",
  );
  return {
    ...actual,
    saveMcpServers: (...args: unknown[]) =>
      mcpMocks.saveMcpServersMock(args[0] as unknown[]),
    saveMcpSettings: (...args: unknown[]) =>
      mcpMocks.saveMcpSettingsMock(args[0]),
    testMcpServer: (...args: unknown[]) => mcpMocks.testMcpServerMock(args[0]),
  };
});

vi.mock("@/components/ui/JsonCodeEditor", () => ({
  default: ({
    value,
    onChange,
    "aria-label": ariaLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    "aria-label"?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? "JSON code editor"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

function SettingsPageHarness({
  initialSection = "appearance",
}: {
  initialSection?: "appearance" | "updates" | "mcp" | "developer";
}) {
  const { openSettingsTab } = useTabs();

  useEffect(() => {
    openSettingsTab(initialSection);
  }, [initialSection, openSettingsTab]);

  return <SettingsPage />;
}

function renderSettingsPage(
  initialSection: "appearance" | "updates" | "mcp" | "developer" = "appearance",
) {
  return render(
    <Provider store={jotaiStore}>
      <TabsProvider>
        <SettingsPageHarness initialSection={initialSection} />
      </TabsProvider>
    </Provider>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    jotaiStore.set(providersAtom, []);
    jotaiStore.set(mcpServersAtom, []);
    jotaiStore.set(mcpSettingsAtom, { artifactizeReturnedFiles: false });
    jotaiStore.set(debugModeEnabledAtom, false);
    jotaiStore.set(groupInlineToolCallsAtom, true);
    jotaiStore.set(appUpdaterStateAtom, {
      ...defaultAppUpdaterState,
      status: "available",
      availableVersion: "0.2.1",
      availableDate: "2026-03-07",
      releaseNotes: "Updater integration is now available.",
      lastCheckedAt: Date.now(),
    });
    updaterMocks.checkForAppUpdatesMock.mockReset();
    updaterMocks.installAppUpdateMock.mockReset();
    updaterMocks.checkForAppUpdatesMock.mockResolvedValue(undefined);
    updaterMocks.installAppUpdateMock.mockResolvedValue(undefined);
    mcpMocks.saveMcpServersMock.mockReset();
    mcpMocks.saveMcpSettingsMock.mockReset();
    mcpMocks.testMcpServerMock.mockReset();
    mcpMocks.saveMcpServersMock.mockResolvedValue(undefined);
    mcpMocks.saveMcpSettingsMock.mockResolvedValue(undefined);
    mcpMocks.testMcpServerMock.mockResolvedValue({
      serverId: "filesystem",
      serverName: "Filesystem",
      tools: [
        {
          serverId: "filesystem",
          serverName: "Filesystem",
          name: "read_file",
          title: "Read File",
          inputSchema: { type: "object" },
        },
        {
          serverId: "filesystem",
          serverName: "Filesystem",
          name: "list_directory",
          title: "List Directory",
          inputSchema: { type: "object" },
        },
      ],
      toolCount: 2,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders grouped navigation and the selected section", async () => {
    renderSettingsPage("updates");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "App Updates" })).not.toBeNull();
    });

    expect(screen.getByText("General")).not.toBeNull();
    expect(screen.getByText("AI")).not.toBeNull();
    expect(screen.getByText("App")).not.toBeNull();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /Check for updates/i }),
    ).not.toBeNull();
  });

  it("switches sections through the left navigation", async () => {
    renderSettingsPage("updates");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "App Updates" })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /Appearance/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Appearance" })).not.toBeNull();
    });
    expect(screen.getByText("Theme & Mode")).not.toBeNull();
    expect(screen.getByText("Theme")).not.toBeNull();
  });

  it("toggles the grouped inline tool call appearance preference", async () => {
    renderSettingsPage("appearance");

    await waitFor(() => {
      expect(screen.getByText("Group inline tool calls")).not.toBeNull();
    });

    const toggle = screen.getByTitle("Group inline tool calls");
    fireEvent.click(toggle);

    expect(jotaiStore.get(groupInlineToolCallsAtom)).toBe(false);

    cleanup();
    renderSettingsPage("appearance");

    await waitFor(() => {
      expect(screen.getByTitle("Group inline tool calls")).not.toBeNull();
    });
    expect(jotaiStore.get(groupInlineToolCallsAtom)).toBe(false);
  });

  it("toggles global debug mode from the developer settings section", async () => {
    renderSettingsPage("developer");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Developer" })).not.toBeNull();
    });

    fireEvent.click(screen.getByTitle("Debug mode"));

    expect(jotaiStore.get(debugModeEnabledAtom)).toBe(true);

    cleanup();
    renderSettingsPage("developer");

    await waitFor(() => {
      expect(screen.getByTitle("Debug mode")).not.toBeNull();
    });
    expect(jotaiStore.get(debugModeEnabledAtom)).toBe(true);
  });

  it("renders the MCP settings section under AI and saves a tested server", async () => {
    renderSettingsPage("mcp");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "MCP Servers" })).not.toBeNull();
    });

    expect(screen.getByText("Global MCP Registry")).not.toBeNull();
    expect(screen.getByText("AI")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add Server/i }));

    fireEvent.change(screen.getByRole("textbox", { name: "Server JSON" }), {
      target: {
        value: JSON.stringify(
          {
            name: "Filesystem",
            enabled: true,
            transport: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          },
          null,
          2,
        ),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => {
      expect(mcpMocks.testMcpServerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Filesystem",
          enabled: true,
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        }),
      );
    });
    expect(screen.getByText("2 tools discovered")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Save Server/i }));

    await waitFor(() => {
      expect(mcpMocks.saveMcpServersMock).toHaveBeenCalledWith([
        expect.objectContaining({
          name: "Filesystem",
          enabled: true,
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        }),
      ]);
    });
    expect(screen.getByText("Filesystem")).not.toBeNull();
    expect(screen.getByText("stdio · enabled")).not.toBeNull();
  });

  it("persists the MCP artifactization toggle", async () => {
    renderSettingsPage("mcp");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "MCP Servers" })).not.toBeNull();
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Save returned files as artifacts/i }),
    );

    await waitFor(() => {
      expect(mcpMocks.saveMcpSettingsMock).toHaveBeenCalledWith({
        artifactizeReturnedFiles: true,
      });
    });
    expect(jotaiStore.get(mcpSettingsAtom)).toEqual({
      artifactizeReturnedFiles: true,
    });
  });

  it("opens the MCP schema help modal from the inline help icon", async () => {
    renderSettingsPage("mcp");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "MCP Servers" })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Server/i }));

    fireEvent.click(
      screen.getByRole("button", { name: "Open MCP JSON schema help" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "MCP Server JSON Schema",
    });

    expect(dialog).not.toBeNull();
    expect(
      within(dialog).getByText(/Remove comments before pasting/i),
    ).not.toBeNull();
    expect(
      within(dialog).getByText(/Example: stdio/i),
    ).not.toBeNull();
    expect(
      within(dialog).getByText(/Example: streamable-http/i),
    ).not.toBeNull();
    expect(dialog.textContent).toContain('"NODE_ENV": "production"');
    expect(dialog.textContent).toContain('"timeoutMs": 15000');
  });
});
