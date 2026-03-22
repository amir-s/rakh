// @vitest-environment jsdom

import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Provider } from "jotai";
import { TabsProvider, useTabs } from "@/contexts/TabsContext";
import {
  agentLoopSettingsAtom,
  autoContextCompactionSettingsAtom,
  appUpdaterStateAtom,
  debugModeEnabledAtom,
  defaultAppUpdaterState,
  groupInlineToolCallsAtom,
  jotaiStore,
  toolContextCompactionEnabledAtom,
} from "@/agent/atoms";
import { DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS } from "@/agent/contextCompaction";
import { providersAtom } from "@/agent/db";
import { DEFAULT_AGENT_LOOP_SETTINGS } from "@/agent/loopLimits";
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

const loopLimitMocks = vi.hoisted(() => ({
  saveAgentLoopSettingsMock: vi.fn<(settings: unknown) => Promise<void>>(),
}));

const dbMocks = vi.hoisted(() => ({
  saveProviderMock: vi.fn<(provider: unknown) => Promise<void>>(),
  deleteProviderMock: vi.fn<(id: string) => Promise<void>>(),
}));

const cliMocks = vi.hoisted(() => ({
  getCliStatusMock: vi.fn<() => Promise<unknown>>(),
  installCliMock: vi.fn<() => Promise<unknown>>(),
  uninstallCliMock: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@/agent/useEnvProviderKeys", () => ({
  useEnvProviderKeys: () => [],
  isTauriRuntime: () => true,
  buildUniqueProviderName: (baseName: string) => baseName,
}));

vi.mock("@/notifications", () => ({
  ensureNotificationPermission: vi.fn(async () => true),
}));

vi.mock("@/agent/persistence", () => ({
  upsertWorkspaceSessions: vi.fn(async () => undefined),
}));

vi.mock("@/agent/db", async () => {
  const actual = await vi.importActual<typeof import("@/agent/db")>(
    "@/agent/db",
  );
  return {
    ...actual,
    saveProvider: (...args: unknown[]) => dbMocks.saveProviderMock(args[0]),
    deleteProvider: (...args: unknown[]) => dbMocks.deleteProviderMock(args[0] as string),
  };
});

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

vi.mock("@/cli", () => ({
  getCliStatus: () => cliMocks.getCliStatusMock(),
  installCli: () => cliMocks.installCliMock(),
  uninstallCli: () => cliMocks.uninstallCliMock(),
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

vi.mock("@/agent/loopLimits", async () => {
  const actual = await vi.importActual<typeof import("@/agent/loopLimits")>(
    "@/agent/loopLimits",
  );
  return {
    ...actual,
    saveAgentLoopSettings: (...args: unknown[]) =>
      loopLimitMocks.saveAgentLoopSettingsMock(args[0]),
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
  initialSection?:
    | "appearance"
    | "loop-safeguards"
    | "context-compaction"
    | "updates"
    | "mcp"
    | "developer"
    | "providers";
}) {
  const { openSettingsTab } = useTabs();

  useEffect(() => {
    openSettingsTab(initialSection);
  }, [initialSection, openSettingsTab]);

  return <SettingsPage />;
}

function renderSettingsPage(
  initialSection:
    | "appearance"
    | "loop-safeguards"
    | "context-compaction"
    | "updates"
    | "mcp"
    | "developer"
    | "providers" = "appearance",
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
    jotaiStore.set(toolContextCompactionEnabledAtom, true);
    jotaiStore.set(agentLoopSettingsAtom, DEFAULT_AGENT_LOOP_SETTINGS);
    jotaiStore.set(
      autoContextCompactionSettingsAtom,
      DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS,
    );
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
    cliMocks.getCliStatusMock.mockReset();
    cliMocks.installCliMock.mockReset();
    cliMocks.uninstallCliMock.mockReset();
    dbMocks.saveProviderMock.mockReset();
    dbMocks.deleteProviderMock.mockReset();
    updaterMocks.checkForAppUpdatesMock.mockResolvedValue(undefined);
    updaterMocks.installAppUpdateMock.mockResolvedValue(undefined);
    cliMocks.getCliStatusMock.mockResolvedValue({
      installed: false,
      binDir: "/Users/tester/.rakh/bin",
      appExecutablePath: "/Applications/Rakh.app/Contents/MacOS/Rakh",
      onPath: false,
      needsTerminalRestart: false,
    });
    cliMocks.installCliMock.mockResolvedValue({
      installed: true,
      commandPath: "/Users/tester/.rakh/bin/rakh",
      binDir: "/Users/tester/.rakh/bin",
      appExecutablePath: "/Applications/Rakh.app/Contents/MacOS/Rakh",
      onPath: true,
      needsTerminalRestart: true,
    });
    cliMocks.uninstallCliMock.mockResolvedValue({
      installed: false,
      binDir: "/Users/tester/.rakh/bin",
      appExecutablePath: "/Applications/Rakh.app/Contents/MacOS/Rakh",
      onPath: false,
      needsTerminalRestart: false,
    });
    dbMocks.saveProviderMock.mockResolvedValue(undefined);
    dbMocks.deleteProviderMock.mockResolvedValue(undefined);
    mcpMocks.saveMcpServersMock.mockReset();
    mcpMocks.saveMcpSettingsMock.mockReset();
    mcpMocks.testMcpServerMock.mockReset();
    loopLimitMocks.saveAgentLoopSettingsMock.mockReset();
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
    loopLimitMocks.saveAgentLoopSettingsMock.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(
      screen.getByRole("heading", { name: "Command-line launcher" }),
    ).not.toBeNull();
  });

  it("renders CLI launcher status and installs the managed launcher", async () => {
    renderSettingsPage("updates");

    await waitFor(() => {
      expect(screen.getByText("Not installed")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(cliMocks.installCliMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Installed")).not.toBeNull();
  });

  it("shows uninstall action when the CLI launcher is already installed", async () => {
    cliMocks.getCliStatusMock.mockResolvedValue({
      installed: true,
      commandPath: "/Users/tester/.rakh/bin/rakh",
      binDir: "/Users/tester/.rakh/bin",
      appExecutablePath: "/Applications/Rakh.app/Contents/MacOS/Rakh",
      onPath: true,
      needsTerminalRestart: true,
    });

    renderSettingsPage("updates");

    await waitFor(() => {
      expect(screen.getByText("Installed")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));

    await waitFor(() => {
      expect(cliMocks.uninstallCliMock).toHaveBeenCalledTimes(1);
    });
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

  it("updates the context compaction settings", async () => {
    renderSettingsPage("context-compaction");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Context Compaction" }),
      ).not.toBeNull();
    });

    fireEvent.click(screen.getByTitle("Tool context compaction"));
    expect(jotaiStore.get(toolContextCompactionEnabledAtom)).toBe(false);

    fireEvent.click(screen.getByTitle("Automatic context compaction"));
    expect(jotaiStore.get(autoContextCompactionSettingsAtom)).toMatchObject({
      enabled: true,
    });

    fireEvent.change(screen.getByLabelText("Auto-compaction trigger mode"), {
      target: { value: "kb" },
    });
    fireEvent.change(screen.getByLabelText("Auto-compaction threshold"), {
      target: { value: "384" },
    });

    expect(jotaiStore.get(autoContextCompactionSettingsAtom)).toMatchObject({
      enabled: true,
      thresholdMode: "kb",
      thresholdKb: 384,
    });
  });

  it("saves validated loop safeguard settings on blur", async () => {
    renderSettingsPage("loop-safeguards");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Loop Safeguards" }),
      ).not.toBeNull();
    });

    fireEvent.change(screen.getByLabelText("Warning Threshold"), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByLabelText("Hard Stop Limit"), {
      target: { value: "80" },
    });
    fireEvent.blur(screen.getByLabelText("Hard Stop Limit"));

    await waitFor(() => {
      expect(loopLimitMocks.saveAgentLoopSettingsMock).toHaveBeenCalledWith({
        warningThreshold: 60,
        hardLimit: 80,
      });
    });
    expect(jotaiStore.get(agentLoopSettingsAtom)).toEqual({
      warningThreshold: 60,
      hardLimit: 80,
    });
    expect(screen.queryByRole("button", { name: "Save limits" })).toBeNull();
  });

  it("rejects invalid loop safeguard pairs on blur", async () => {
    renderSettingsPage("loop-safeguards");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Loop Safeguards" }),
      ).not.toBeNull();
    });

    fireEvent.change(screen.getByLabelText("Warning Threshold"), {
      target: { value: "90" },
    });
    fireEvent.change(screen.getByLabelText("Hard Stop Limit"), {
      target: { value: "80" },
    });
    fireEvent.blur(screen.getByLabelText("Hard Stop Limit"));

    expect(
      screen.getByText("Warning threshold must be lower than the hard stop limit."),
    ).not.toBeNull();
    expect(loopLimitMocks.saveAgentLoopSettingsMock).not.toHaveBeenCalled();
  });

  it("resets loop safeguards to defaults", async () => {
    jotaiStore.set(agentLoopSettingsAtom, {
      warningThreshold: 65,
      hardLimit: 90,
    });
    renderSettingsPage("loop-safeguards");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Loop Safeguards" }),
      ).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    await waitFor(() => {
      expect(loopLimitMocks.saveAgentLoopSettingsMock).toHaveBeenCalledWith(
        DEFAULT_AGENT_LOOP_SETTINGS,
      );
    });
    expect(jotaiStore.get(agentLoopSettingsAtom)).toEqual(
      DEFAULT_AGENT_LOOP_SETTINGS,
    );
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

  it("saves custom provider model metadata from the providers settings section", async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockImplementation(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input);

      if (url === "https://models.dev/api.json") {
        return {
          ok: true,
          json: async () => ({
            openrouter: {
              id: "openrouter",
              name: "OpenRouter",
              models: {
                "meta/llama-3.3-70b": {
                  id: "meta/llama-3.3-70b",
                  name: "Llama 3.3 70B",
                  cost: { input: 0.12, output: 0.48 },
                  limit: { context: 65536 },
                },
              },
            },
            togetherai: {
              id: "togetherai",
              name: "Together AI",
              models: {
                "meta/llama-3.3-70b": {
                  id: "meta/llama-3.3-70b",
                  name: "Llama 3.3 70B",
                  cost: { input: 0.15, output: 0.6 },
                  limit: { context: 131072 },
                },
              },
            },
          }),
        } as Response;
      }

      if (url === "http://localhost:11434/v1/models") {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "meta/llama-3.3-70b" },
              { id: "qwen/qwen-2.5-coder" },
            ],
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${url}`);
    });

    renderSettingsPage("providers");

    await waitFor(() => {
      expect(screen.getByText("Provider Registry")).not.toBeNull();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("https://models.dev/api.json");
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Provider/i }));

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Local Gateway" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Provider Type" }), {
      target: { value: "openai-compatible" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Base URL (include version)" }),
      {
        target: { value: "http://localhost:11434/v1" },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:11434/v1/models",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getAllByText("meta/llama-3.3-70b").length).toBeGreaterThan(0);
      expect(screen.getAllByText("qwen/qwen-2.5-coder").length).toBeGreaterThan(0);
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Prefill meta/llama-3.3-70b metadata from models.dev",
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /OpenRouter/i })).not.toBeNull();
      expect(
        screen.getByRole("button", { name: /Together AI/i }),
      ).not.toBeNull();
    });

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Search models.dev providers for meta/llama-3.3-70b",
      }),
      {
        target: { value: "together" },
      },
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /OpenRouter/i }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: /Together AI/i }),
      ).not.toBeNull();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /Together AI/i }));

    expect(
      (screen.getAllByLabelText("Context limit")[0] as HTMLInputElement).value,
    ).toBe("131072");
    expect(
      (screen.getAllByLabelText("Input cost / 1M")[0] as HTMLInputElement).value,
    ).toBe("0.15");
    expect(
      (screen.getAllByLabelText("Output cost / 1M")[0] as HTMLInputElement).value,
    ).toBe("0.6");

    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(dbMocks.saveProviderMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Local Gateway",
          type: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          cachedModels: [
            {
              id: "meta/llama-3.3-70b",
              cost: { input: 0.15, output: 0.6 },
              limit: { context: 131072 },
            },
            {
              id: "qwen/qwen-2.5-coder",
            },
          ],
        }),
      );
    });

    expect(jotaiStore.get(providersAtom)).toEqual([
      expect.objectContaining({
        name: "Local Gateway",
        type: "openai-compatible",
        cachedModels: [
          expect.objectContaining({
            id: "meta/llama-3.3-70b",
            cost: { input: 0.15, output: 0.6 },
            limit: { context: 131072 },
          }),
          expect.objectContaining({
            id: "qwen/qwen-2.5-coder",
          }),
        ],
      }),
    ]);
  });
});
