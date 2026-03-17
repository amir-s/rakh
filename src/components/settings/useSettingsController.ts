import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAtom } from "jotai";
import {
  autoContextCompactionSettingsAtom,
  appUpdaterStateAtom,
  debugModeEnabledAtom,
  notifyOnAttentionAtom,
  themeModeAtom,
  themeNameAtom,
  groupInlineToolCallsAtom,
  defaultCommunicationProfileAtom,
  voiceInputEnabledAtom,
  voiceModelPathAtom,
  toolContextCompactionEnabledAtom,
  jotaiStore,
  type AppUpdaterState,
} from "@/agent/atoms";
import type { AutoContextCompactionSettings } from "@/agent/contextCompaction";
import {
  providersAtom,
  profilesAtom,
  commandListAtom,
  type ProviderInstance,
  type CommunicationProfileRecord,
  type CommandList,
  type CommandListEntry,
} from "@/agent/db";
import { resolveCommunicationProfileId } from "@/agent/communicationProfiles";
import {
  mcpServersAtom,
  mcpSettingsAtom,
  type McpServerConfig,
  type McpSettings,
} from "@/agent/mcp";
import { ensureNotificationPermission } from "@/notifications";
import { upsertWorkspaceSessions } from "@/agent/persistence";
import {
  getCliStatus,
  installCli,
  uninstallCli,
  type CliStatus,
} from "@/cli";
import {
  useEnvProviderKeys,
  isTauriRuntime,
  type EnvKeyEntry,
} from "@/agent/useEnvProviderKeys";
import { logFrontendSoon } from "@/logging/client";
import type { ThemeName } from "@/styles/themes/registry";
import { checkForAppUpdates, installAppUpdate } from "@/updater";
import { useTabs } from "@/contexts/TabsContext";

export type VoiceDownloadStatus = "idle" | "downloading" | "ready" | "error";

async function confirmInstallUpdate(version: string): Promise<boolean> {
  const message =
    `Install Rakh v${version} now?\n\n` +
    "Open workspace tabs will be saved and the app will restart.";

  if (isTauriRuntime()) {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return confirm(message, {
      title: "Install update",
      kind: "info",
      okLabel: "Install",
      cancelLabel: "Cancel",
    });
  }

  if (typeof window === "undefined") return false;
  return window.confirm(message);
}

export interface SettingsControllerValue {
  providers: ProviderInstance[];
  setProviders: (providers: ProviderInstance[]) => void;
  mcpServers: McpServerConfig[];
  setMcpServers: (servers: McpServerConfig[]) => void;
  mcpSettings: McpSettings;
  setMcpSettings: (settings: McpSettings) => void;
  envKeysAvailable: EnvKeyEntry[];
  debugModeEnabled: boolean;
  setDebugModeEnabled: (enabled: boolean) => void;
  themeMode: "dark" | "light";
  toggleThemeMode: () => void;
  themeName: ThemeName;
  setThemeName: (name: ThemeName) => void;
  groupInlineToolCalls: boolean;
  setGroupInlineToolCalls: (enabled: boolean) => void;
  toolContextCompactionEnabled: boolean;
  setToolContextCompactionEnabled: (enabled: boolean) => void;
  autoContextCompactionSettings: AutoContextCompactionSettings;
  setAutoContextCompactionSettings: (settings: AutoContextCompactionSettings) => void;
  defaultCommunicationProfile: string;
  setDefaultCommunicationProfile: (profile: string) => void;
  customProfiles: CommunicationProfileRecord[];
  setCustomProfiles: (profiles: CommunicationProfileRecord[]) => void;
  isAddingProfile: boolean;
  setIsAddingProfile: (adding: boolean) => void;
  editingProfileId: string | null;
  setEditingProfileId: (id: string | null) => void;
  saveProfile: (profile: CommunicationProfileRecord) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  notifyOnAttention: boolean;
  toggleNotifyOnAttention: () => Promise<void>;
  voiceInputEnabled: boolean;
  voiceModelPath: string;
  voiceDownloadStatus: VoiceDownloadStatus;
  voiceDownloadError: string | null;
  toggleVoiceInput: (next: boolean) => Promise<void>;
  commandList: CommandList;
  saveCommandList: (list: CommandList) => Promise<void>;
  addCommandEntry: (list: "allow" | "deny", entry: CommandListEntry) => Promise<void>;
  removeCommandEntry: (list: "allow" | "deny", id: string) => Promise<void>;
  updateCommandEntry: (list: "allow" | "deny", entry: CommandListEntry) => Promise<void>;
  appUpdater: AppUpdaterState;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  cliStatus: CliStatus | null;
  cliStatusLoading: boolean;
  cliStatusError: string | null;
  refreshCliStatus: () => Promise<void>;
  installCliLauncher: () => Promise<void>;
  uninstallCliLauncher: () => Promise<void>;
}

export function useSettingsController(): SettingsControllerValue {
  const { tabs } = useTabs();
  const [providers, setProviders] = useAtom(providersAtom);
  const [mcpServers, setMcpServers] = useAtom(mcpServersAtom);
  const [mcpSettings, setMcpSettings] = useAtom(mcpSettingsAtom);
  const [debugModeEnabled, setDebugModeEnabled] = useAtom(debugModeEnabledAtom);
  const [themeMode, setThemeMode] = useAtom(themeModeAtom);
  const [themeName, setThemeName] = useAtom(themeNameAtom);
  const [groupInlineToolCalls, setGroupInlineToolCalls] = useAtom(
    groupInlineToolCallsAtom,
  );
  const [toolContextCompactionEnabled, setToolContextCompactionEnabled] =
    useAtom(toolContextCompactionEnabledAtom);
  const [autoContextCompactionSettings, setAutoContextCompactionSettings] =
    useAtom(autoContextCompactionSettingsAtom);
  const [defaultCommunicationProfile, setDefaultCommunicationProfile] = useAtom(
    defaultCommunicationProfileAtom,
  );
  const [customProfiles, setCustomProfiles] = useAtom(profilesAtom);
  const [commandList, setCommandList] = useAtom(commandListAtom);
  const [appUpdater] = useAtom(appUpdaterStateAtom);
  const [notifyOnAttention, setNotifyOnAttention] = useAtom(
    notifyOnAttentionAtom,
  );
  const [voiceInputEnabled, setVoiceInputEnabled] = useAtom(
    voiceInputEnabledAtom,
  );
  const [voiceModelPath, setVoiceModelPath] = useAtom(voiceModelPathAtom);
  const [voiceDownloadStatus, setVoiceDownloadStatus] =
    useState<VoiceDownloadStatus>("idle");
  const [voiceDownloadError, setVoiceDownloadError] = useState<string | null>(
    null,
  );
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);
  const [cliStatusLoading, setCliStatusLoading] = useState(false);
  const [cliStatusError, setCliStatusError] = useState<string | null>(null);

  const [isAddingProfile, setIsAddingProfile] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);

  const handleSaveProfile = useCallback(
    async (profile: CommunicationProfileRecord) => {
      const { saveProfile, loadProfiles } = await import("@/agent/db");
      await saveProfile(profile);
      const nextProfiles = await loadProfiles();
      setCustomProfiles(nextProfiles);
      const nextDefaultCommunicationProfile = resolveCommunicationProfileId(
        undefined,
        nextProfiles,
        defaultCommunicationProfile,
      );
      if (nextDefaultCommunicationProfile) {
        setDefaultCommunicationProfile(nextDefaultCommunicationProfile);
      }
    },
    [
      defaultCommunicationProfile,
      setCustomProfiles,
      setDefaultCommunicationProfile,
    ],
  );

  const handleDeleteProfile = useCallback(
    async (id: string) => {
      if (customProfiles.length <= 1) return;
      const { deleteProfile, loadProfiles } = await import("@/agent/db");
      await deleteProfile(id);
      const nextProfiles = await loadProfiles();
      setCustomProfiles(nextProfiles);
      const nextDefaultCommunicationProfile = resolveCommunicationProfileId(
        undefined,
        nextProfiles,
        defaultCommunicationProfile === id
          ? undefined
          : defaultCommunicationProfile,
      );
      if (nextDefaultCommunicationProfile) {
        setDefaultCommunicationProfile(nextDefaultCommunicationProfile);
      }
    },
    [
      customProfiles.length,
      defaultCommunicationProfile,
      setCustomProfiles,
      setDefaultCommunicationProfile,
    ],
  );

  const handleSaveCommandList = useCallback(
    async (list: CommandList) => {
      const { saveCommandList } = await import("@/agent/db");
      await saveCommandList(list);
      setCommandList(list);
    },
    [setCommandList],
  );

  const handleAddCommandEntry = useCallback(
    async (listName: "allow" | "deny", entry: CommandListEntry) => {
      const current = jotaiStore.get(commandListAtom);
      const next: CommandList = {
        ...current,
        [listName]: [...current[listName], entry],
      };
      const { saveCommandList } = await import("@/agent/db");
      await saveCommandList(next);
      setCommandList(next);
    },
    [setCommandList],
  );

  const handleRemoveCommandEntry = useCallback(
    async (listName: "allow" | "deny", id: string) => {
      const current = jotaiStore.get(commandListAtom);
      const next: CommandList = {
        ...current,
        [listName]: current[listName].filter((e) => e.id !== id),
      };
      const { saveCommandList } = await import("@/agent/db");
      await saveCommandList(next);
      setCommandList(next);
    },
    [setCommandList],
  );

  const handleUpdateCommandEntry = useCallback(
    async (listName: "allow" | "deny", entry: CommandListEntry) => {
      const current = jotaiStore.get(commandListAtom);
      const next: CommandList = {
        ...current,
        [listName]: current[listName].map((e) => (e.id === entry.id ? entry : e)),
      };
      const { saveCommandList } = await import("@/agent/db");
      await saveCommandList(next);
      setCommandList(next);
    },
    [setCommandList],
  );

  const envKeysAvailable = useEnvProviderKeys();

  const effectiveVoiceDownloadStatus: VoiceDownloadStatus =
    voiceDownloadStatus === "downloading" || voiceDownloadStatus === "error"
      ? voiceDownloadStatus
      : voiceInputEnabled && !!voiceModelPath
        ? "ready"
        : "idle";

  const toggleThemeMode = useCallback(() => {
    setThemeMode((current) => (current === "dark" ? "light" : "dark"));
  }, [setThemeMode]);

  const toggleNotifyOnAttention = useCallback(async () => {
    const nextValue = !notifyOnAttention;
    if (nextValue) {
      const granted = await ensureNotificationPermission();
      if (!granted) {
        logFrontendSoon({
          level: "warn",
          tags: ["frontend", "system"],
          event: "settings.notifications.denied",
          message: "Notification permission was denied by the user.",
        });
        return;
      }
    }
    setNotifyOnAttention(nextValue);
  }, [notifyOnAttention, setNotifyOnAttention]);

  const toggleVoiceInput = useCallback(
    async (next: boolean) => {
      if (!next) {
        setVoiceInputEnabled(false);
        setVoiceDownloadStatus("idle");
        setVoiceDownloadError(null);
        return;
      }

      if (!isTauriRuntime()) {
        setVoiceInputEnabled(false);
        setVoiceDownloadStatus("error");
        setVoiceDownloadError(
          "Voice input is only available in the desktop Tauri app runtime.",
        );
        return;
      }

      setVoiceInputEnabled(true);
      setVoiceDownloadStatus("downloading");
      setVoiceDownloadError(null);

      try {
        const result = await invoke<{ modelPath: string }>(
          "whisper_prepare_model",
        );
        const path = result.modelPath?.trim() ?? "";
        if (path) {
          setVoiceModelPath(path);
        }
        setVoiceDownloadStatus("ready");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "Unknown");
        setVoiceInputEnabled(false);
        setVoiceDownloadStatus("error");
        setVoiceDownloadError(message);
      }
    },
    [setVoiceInputEnabled, setVoiceModelPath],
  );

  const handleCheckForUpdates = useCallback(async () => {
    await checkForAppUpdates();
  }, []);

  const handleRefreshCliStatus = useCallback(async () => {
    if (!isTauriRuntime()) {
      setCliStatus(null);
      setCliStatusLoading(false);
      setCliStatusError(null);
      return;
    }

    setCliStatusLoading(true);
    setCliStatusError(null);
    try {
      setCliStatus(await getCliStatus());
    } catch (error) {
      setCliStatusError(
        error instanceof Error ? error.message : String(error ?? "Unknown"),
      );
    } finally {
      setCliStatusLoading(false);
    }
  }, []);

  const handleInstallCliLauncher = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setCliStatusLoading(true);
    setCliStatusError(null);
    try {
      setCliStatus(await installCli());
    } catch (error) {
      setCliStatusError(
        error instanceof Error ? error.message : String(error ?? "Unknown"),
      );
    } finally {
      setCliStatusLoading(false);
    }
  }, []);

  const handleUninstallCliLauncher = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setCliStatusLoading(true);
    setCliStatusError(null);
    try {
      setCliStatus(await uninstallCli());
    } catch (error) {
      setCliStatusError(
        error instanceof Error ? error.message : String(error ?? "Unknown"),
      );
    } finally {
      setCliStatusLoading(false);
    }
  }, []);

  const handleInstallUpdate = useCallback(async () => {
    if (!appUpdater.availableVersion) return;

    const confirmed = await confirmInstallUpdate(appUpdater.availableVersion);
    if (!confirmed) return;

    try {
      await installAppUpdate({
        beforeInstall: () => upsertWorkspaceSessions(tabs),
      });
    } catch {
      // updater state already captures failures for the settings UI
    }
  }, [appUpdater.availableVersion, tabs]);

  useEffect(() => {
    void handleRefreshCliStatus();
  }, [handleRefreshCliStatus]);

  return {
    providers,
    setProviders,
    mcpServers,
    setMcpServers,
    mcpSettings,
    setMcpSettings,
    envKeysAvailable,
    debugModeEnabled,
    setDebugModeEnabled,
    themeMode,
    toggleThemeMode,
    themeName,
    setThemeName,
    groupInlineToolCalls,
    setGroupInlineToolCalls,
    toolContextCompactionEnabled,
    setToolContextCompactionEnabled,
    autoContextCompactionSettings,
    setAutoContextCompactionSettings,
    defaultCommunicationProfile,
    setDefaultCommunicationProfile,
    customProfiles,
    setCustomProfiles,
    isAddingProfile,
    setIsAddingProfile,
    editingProfileId,
    setEditingProfileId,
    saveProfile: handleSaveProfile,
    deleteProfile: handleDeleteProfile,
    notifyOnAttention,
    toggleNotifyOnAttention,
    voiceInputEnabled,
    voiceModelPath,
    voiceDownloadStatus: effectiveVoiceDownloadStatus,
    voiceDownloadError,
    toggleVoiceInput,
    commandList,
    saveCommandList: handleSaveCommandList,
    addCommandEntry: handleAddCommandEntry,
    removeCommandEntry: handleRemoveCommandEntry,
    updateCommandEntry: handleUpdateCommandEntry,
    appUpdater,
    checkForUpdates: handleCheckForUpdates,
    installUpdate: handleInstallUpdate,
    cliStatus,
    cliStatusLoading,
    cliStatusError,
    refreshCliStatus: handleRefreshCliStatus,
    installCliLauncher: handleInstallCliLauncher,
    uninstallCliLauncher: handleUninstallCliLauncher,
  };
}
