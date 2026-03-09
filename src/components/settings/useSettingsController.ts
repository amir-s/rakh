import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAtom } from "jotai";
import {
  appUpdaterStateAtom,
  notifyOnAttentionAtom,
  themeModeAtom,
  themeNameAtom,
  voiceInputEnabledAtom,
  voiceModelPathAtom,
  type AppUpdaterState,
} from "@/agent/atoms";
import {
  providersAtom,
  type ProviderInstance,
} from "@/agent/db";
import { ensureNotificationPermission } from "@/notifications";
import { upsertWorkspaceSessions } from "@/agent/persistence";
import {
  useEnvProviderKeys,
  isTauriRuntime,
  type EnvKeyEntry,
} from "@/agent/useEnvProviderKeys";
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
  envKeysAvailable: EnvKeyEntry[];
  themeMode: "dark" | "light";
  toggleThemeMode: () => void;
  themeName: ThemeName;
  setThemeName: (name: ThemeName) => void;
  notifyOnAttention: boolean;
  toggleNotifyOnAttention: () => Promise<void>;
  voiceInputEnabled: boolean;
  voiceModelPath: string;
  voiceDownloadStatus: VoiceDownloadStatus;
  voiceDownloadError: string | null;
  toggleVoiceInput: (next: boolean) => Promise<void>;
  appUpdater: AppUpdaterState;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

export function useSettingsController(): SettingsControllerValue {
  const { tabs } = useTabs();
  const [providers, setProviders] = useAtom(providersAtom);
  const [themeMode, setThemeMode] = useAtom(themeModeAtom);
  const [themeName, setThemeName] = useAtom(themeNameAtom);
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
        console.warn("Notification permission denied by user");
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

  return {
    providers,
    setProviders,
    envKeysAvailable,
    themeMode,
    toggleThemeMode,
    themeName,
    setThemeName,
    notifyOnAttention,
    toggleNotifyOnAttention,
    voiceInputEnabled,
    voiceModelPath,
    voiceDownloadStatus: effectiveVoiceDownloadStatus,
    voiceDownloadError,
    toggleVoiceInput,
    appUpdater,
    checkForUpdates: handleCheckForUpdates,
    installUpdate: handleInstallUpdate,
  };
}
