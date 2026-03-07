import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useAtom } from "jotai";
import pkg from "../../package.json";
import {
  appUpdaterStateAtom,
  notifyOnAttentionAtom,
  settingsSidebarOpenAtom,
  themeModeAtom,
  themeNameAtom,
  type AppUpdaterState,
  voiceInputEnabledAtom,
  voiceModelPathAtom,
} from "@/agent/atoms";
import { upsertWorkspaceSessions } from "@/agent/persistence";
import {
  providersAtom,
  saveProvider,
  deleteProvider,
  type ProviderInstance,
} from "@/agent/db";
import { motion, AnimatePresence } from "framer-motion";
import { ensureNotificationPermission } from "@/notifications";
import { v4 as uuidv4 } from "uuid";
import { cn } from "@/utils/cn";
import {
  THEME_NAMES,
  formatThemeName,
  type ThemeName,
} from "@/styles/themes/registry";
import {
  Badge,
  Button,
  IconButton,
  SelectField,
  TextField,
  ToggleSwitch,
} from "@/components/ui";
import { useTabs } from "@/contexts/TabsContext";
import {
  useEnvProviderKeys,
  isTauriRuntime,
  buildUniqueProviderName,
  type EnvProviderType,
  type EnvKeyEntry,
} from "@/agent/useEnvProviderKeys";
import {
  checkForAppUpdates,
  getAppUpdaterProgressValue,
  getAppUpdaterStatusLabel,
  getAppUpdaterStatusVariant,
  installAppUpdate,
} from "@/updater";

type TestStatus = "idle" | "testing" | "ok" | "error";

type VoiceDownloadStatus = "idle" | "downloading" | "ready" | "error";
type ProviderRefreshStatus = "idle" | "loading" | "ok" | "error";
const REFRESH_FEEDBACK_MS = 3000;

async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
): Promise<Record<string, unknown>[]> {
  const url = baseUrl.trim().replace(/\/+$/, "");
  if (!url) {
    throw new Error("Please enter a base URL first.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = apiKey.trim();
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const res = await fetch(`${url}/models`, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ id?: string; owned_by?: string }>;
  };

  return (json.data ?? [])
    .map((m) => m.id?.trim())
    .filter((id): id is string => Boolean(id))
    .map((id) => ({
      id,
      owned_by: "openai-compatible",
    }));
}

function formatUpdaterLastChecked(lastCheckedAt: number | null): string {
  if (!lastCheckedAt) return "Automatic startup checks are enabled.";
  return `Last checked ${new Date(lastCheckedAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}.`;
}

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

function ProviderConfigurator({
  provider,
  onSave,
  onCancel,
}: {
  provider?: ProviderInstance;
  onSave: (p: ProviderInstance) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(provider?.name ?? "");
  const [type, setType] = useState<ProviderInstance["type"]>(
    provider?.type ?? "openai",
  );
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [keyVisible, setKeyVisible] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [cachedModels, setCachedModels] = useState<Record<string, unknown>[]>(
    provider?.cachedModels ?? [],
  );

  const isCustom = type === "openai-compatible";
  const hasCachedModels = cachedModels.length > 0;

  const handleTest = async () => {
    if (!isCustom) {
      setTestStatus("ok");
      return;
    }

    setTestStatus("testing");
    setTestError(null);
    try {
      const models = await fetchOpenAICompatibleModels(baseUrl, apiKey);
      setCachedModels(models);
      setTestStatus("ok");
    } catch (err) {
      setTestStatus("error");
      setTestError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveClick = () => {
    if (!name.trim()) return;
    onSave({
      id: provider?.id ?? uuidv4(),
      name: name.trim(),
      type,
      apiKey: apiKey.trim(),
      baseUrl: isCustom ? baseUrl.trim() : undefined,
      cachedModels: isCustom ? cachedModels : undefined,
    });
  };

  return (
    <div className="flex flex-col gap-4 bg-surface rounded-lg mt-2 border border-primary/30 p-4">
      {/* Name */}
      <div className="settings-field">
        <label className="settings-field-label">Name (Must be Unique)</label>
        <TextField
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My OpenAI Key"
          className="settings-input"
          wrapClassName="settings-input-wrap"
        />
      </div>

      {/* Provider Type */}
      <div className="settings-field">
        <label className="settings-field-label">Provider Type</label>
        <SelectField
          className="settings-select w-full"
          value={type}
          onChange={(e) => setType(e.target.value as ProviderInstance["type"])}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai-compatible">Custom (OpenAI Compatible)</option>
        </SelectField>
      </div>

      {/* API Key */}
      <div className="settings-field">
        <label className="settings-field-label">
          {isCustom ? "API Key (optional)" : "API Key"}
        </label>
        <TextField
          type={keyVisible ? "text" : "password"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className="settings-input"
          wrapClassName="settings-input-wrap"
          endAdornment={
            <IconButton
              className="settings-input-icon-btn"
              onClick={() => setKeyVisible((v) => !v)}
              title={keyVisible ? "Hide key" : "Show key"}
              type="button"
            >
              <span className="material-symbols-outlined text-md">
                {keyVisible ? "visibility_off" : "visibility"}
              </span>
            </IconButton>
          }
        />
      </div>

      {/* Base URL (Custom only) */}
      {isCustom && (
        <div className="settings-field">
          <label className="settings-field-label">
            Base URL (include version)
          </label>
          <TextField
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
            className="settings-input"
            wrapClassName="settings-input-wrap"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-2">
        <Button
          className="settings-save-btn"
          onClick={handleSaveClick}
          disabled={!name.trim()}
          size="xs"
        >
          <span className="material-symbols-outlined text-md">save</span>
          Save
        </Button>

        {isCustom && (
          <Button
            className="settings-save-btn"
            onClick={handleTest}
            disabled={testStatus === "testing"}
            size="xs"
          >
            <span className="material-symbols-outlined text-md">
              {testStatus === "testing"
                ? "hourglass_empty"
                : hasCachedModels
                  ? "refresh"
                  : "wifi_tethering"}
            </span>
            {testStatus === "testing"
              ? "Testing…"
              : hasCachedModels
                ? `Refresh`
                : "Test URL"}
          </Button>
        )}

        <Button
          className="settings-save-btn"
          variant="ghost"
          size="xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>

      {/* Status feedback */}
      <div className="h-2">
        {testStatus === "ok" && isCustom && (
          <p className="text-xs text-success flex items-center gap-1">
            <span className="material-symbols-outlined text-md">
              check_circle
            </span>
            Connected — {cachedModels.length} model
            {cachedModels.length !== 1 ? "s" : ""} loaded.
          </p>
        )}
        {testStatus === "error" && testError && (
          <p className="text-xs text-error flex items-center gap-1">
            <span className="material-symbols-outlined text-md">error</span>
            {testError}
          </p>
        )}
      </div>
    </div>
  );
}

interface SettingsSidebarInnerProps {
  providers: ProviderInstance[];
  envKeysAvailable: EnvKeyEntry[];
  onSetProviders: (providers: ProviderInstance[]) => void;
  themeMode: "dark" | "light";
  onToggleThemeMode: () => void;
  themeName: ThemeName;
  onChangeThemeName: (name: ThemeName) => void;
  notifyOnAttention: boolean;
  onToggleNotifyOnAttention: (next: boolean) => void;
  voiceInputEnabled: boolean;
  voiceModelPath: string;
  voiceDownloadStatus: VoiceDownloadStatus;
  voiceDownloadError: string | null;
  appUpdater: AppUpdaterState;
  onCheckForUpdates: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onToggleVoiceInput: (next: boolean) => Promise<void>;
  onClose: () => void;
}

function SettingsSidebarInner({
  providers,
  envKeysAvailable,
  onSetProviders,
  themeMode,
  onToggleThemeMode,
  themeName,
  onChangeThemeName,
  notifyOnAttention,
  onToggleNotifyOnAttention,
  voiceInputEnabled,
  voiceModelPath,
  voiceDownloadStatus,
  voiceDownloadError,
  appUpdater,
  onCheckForUpdates,
  onInstallUpdate,
  onToggleVoiceInput,
  onClose,
}: SettingsSidebarInnerProps) {
  const [editingProviderId, setEditingProviderId] = useState<string | null>(
    null,
  );
  const [isAdding, setIsAdding] = useState(false);
  const [providerRefreshStatus, setProviderRefreshStatus] = useState<
    Record<string, ProviderRefreshStatus>
  >({});
  const refreshResetTimeoutsRef = useRef<Record<string, number>>({});

  const clearRefreshResetTimeout = useCallback((providerId: string) => {
    const timeoutId = refreshResetTimeoutsRef.current[providerId];
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      delete refreshResetTimeoutsRef.current[providerId];
    }
  }, []);

  const scheduleRefreshStatusReset = useCallback(
    (providerId: string) => {
      clearRefreshResetTimeout(providerId);
      refreshResetTimeoutsRef.current[providerId] = window.setTimeout(() => {
        setProviderRefreshStatus((prev) => ({ ...prev, [providerId]: "idle" }));
        delete refreshResetTimeoutsRef.current[providerId];
      }, REFRESH_FEEDBACK_MS);
    },
    [clearRefreshResetTimeout],
  );

  useEffect(() => {
    return () => {
      Object.values(refreshResetTimeoutsRef.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      refreshResetTimeoutsRef.current = {};
    };
  }, []);
  const envProviderCandidates = envKeysAvailable
    .map((entry) => ({
      ...entry,
      label: entry.type === "openai" ? "OpenAI" : "Anthropic",
    }))
    .filter(
      (candidate) =>
        !providers.some((provider) => provider.type === candidate.type),
    );

  const handleToggleNotify = useCallback(async () => {
    const nextValue = !notifyOnAttention;
    if (nextValue) {
      const granted = await ensureNotificationPermission();
      if (!granted) {
        console.warn("Notification permission denied by user");
        return;
      }
    }
    onToggleNotifyOnAttention(nextValue);
  }, [notifyOnAttention, onToggleNotifyOnAttention]);

  const handleToggleVoice = useCallback(async () => {
    if (voiceDownloadStatus === "downloading") return;
    await onToggleVoiceInput(!voiceInputEnabled);
  }, [voiceDownloadStatus, onToggleVoiceInput, voiceInputEnabled]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const showImportHint = envProviderCandidates.length > 0;
  const updaterStatusLabel = getAppUpdaterStatusLabel(appUpdater);
  const updaterStatusVariant = getAppUpdaterStatusVariant(appUpdater);
  const updaterProgressValue = getAppUpdaterProgressValue(appUpdater);
  const isCheckingUpdates = appUpdater.status === "checking";
  const isInstallingUpdate =
    appUpdater.status === "downloading" ||
    appUpdater.status === "installing" ||
    appUpdater.status === "restarting";
  const installButtonLabel = isInstallingUpdate
    ? appUpdater.status === "downloading"
      ? "Downloading…"
      : appUpdater.status === "installing"
        ? "Installing…"
        : "Restarting…"
    : appUpdater.availableVersion
      ? `Install v${appUpdater.availableVersion}`
      : "Install update";
  const availableDateLabel = appUpdater.availableDate
    ? new Date(appUpdater.availableDate).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  const handleSaveProvider = async (provider: ProviderInstance) => {
    await saveProvider(provider);
    onSetProviders([
      ...providers.filter((p) => p.id !== provider.id),
      provider,
    ]);
    setIsAdding(false);
    setEditingProviderId(null);
  };

  const handleDeleteProvider = async (id: string) => {
    await deleteProvider(id);
    onSetProviders(providers.filter((p) => p.id !== id));
  };

  const handleRefreshProviderModels = useCallback(
    async (provider: ProviderInstance) => {
      if (provider.type !== "openai-compatible") return;

      clearRefreshResetTimeout(provider.id);
      setProviderRefreshStatus((prev) => ({ ...prev, [provider.id]: "loading" }));
      try {
        const models = await fetchOpenAICompatibleModels(
          provider.baseUrl ?? "",
          provider.apiKey,
        );
        const updatedProvider: ProviderInstance = {
          ...provider,
          cachedModels: models,
        };

        await saveProvider(updatedProvider);
        onSetProviders(
          providers.map((p) => (p.id === updatedProvider.id ? updatedProvider : p)),
        );
        setProviderRefreshStatus((prev) => ({ ...prev, [provider.id]: "ok" }));
        scheduleRefreshStatusReset(provider.id);
      } catch (error) {
        console.error(
          `Failed to refresh OpenAI-compatible models for "${provider.name}"`,
          error,
        );
        setProviderRefreshStatus((prev) => ({
          ...prev,
          [provider.id]: "error",
        }));
        scheduleRefreshStatusReset(provider.id);
      }
    },
    [clearRefreshResetTimeout, onSetProviders, providers, scheduleRefreshStatusReset],
  );

  const handleImportProviderFromEnv = async (
    type: EnvProviderType,
    apiKey: string,
  ) => {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) return;

    const alreadyExists = providers.some((provider) => provider.type === type);
    if (alreadyExists) return;

    const defaultName = type === "openai" ? "OpenAI (Env)" : "Anthropic (Env)";
    const provider: ProviderInstance = {
      id: uuidv4(),
      name: buildUniqueProviderName(defaultName, providers),
      type,
      apiKey: normalizedApiKey,
    };

    await saveProvider(provider);
    onSetProviders([...providers, provider]);
  };

  return (
    <motion.aside
      key="settings-sidebar"
      className="settings-sidebar"
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="settings-header">
        <div className="settings-header-left">
          <span className="material-symbols-outlined text-primary text-md">
            settings
          </span>
          <span className="settings-title">Settings</span>
        </div>
        <IconButton className="settings-close-btn" onClick={onClose} title="Close">
          <span className="material-symbols-outlined text-md">close</span>
        </IconButton>
      </div>

      <div className="settings-body">
        {/* Appearance */}
        <section className="settings-section">
          <h2 className="settings-section-title">Appearance</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Theme</span>
            </div>
            <SelectField
              className="settings-select settings-select--compact"
              value={themeName}
              onChange={(e) => onChangeThemeName(e.target.value as ThemeName)}
            >
              {THEME_NAMES.map((t) => (
                <option key={t} value={t}>
                  {formatThemeName(t)}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Mode</span>
            </div>
            <Button
              className={cn(
                "settings-toggle-btn",
                themeMode === "dark" && "settings-toggle-btn--active",
              )}
              onClick={onToggleThemeMode}
              variant="secondary"
              size="xs"
            >
              <span className="material-symbols-outlined text-md">
                {themeMode === "dark" ? "light_mode" : "dark_mode"}
              </span>
              <span>{themeMode === "dark" ? "Light" : "Dark"}</span>
            </Button>
          </div>
        </section>

        <div className="settings-divider" />

        {/* Notifications */}
        <section className="settings-section">
          <h2 className="settings-section-title">Notifications</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Agent attention</span>
            </div>
            <ToggleSwitch
              checked={notifyOnAttention}
              onChange={() => {
                void handleToggleNotify();
              }}
              className="settings-switch"
            />
          </div>
        </section>

        <div className="settings-divider" />

        {/* Voice Input */}
        <section className="settings-section">
          <h2 className="settings-section-title">Voice Input</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Enable voice input</span>
              <span className="settings-row-desc">
                Use microphone and local Whisper transcription.
              </span>
            </div>
            <ToggleSwitch
              checked={voiceInputEnabled}
              className="settings-switch"
              onChange={() => {
                void handleToggleVoice();
              }}
              disabled={voiceDownloadStatus === "downloading"}
            />
          </div>
          {voiceDownloadStatus === "downloading" && (
            <p className="settings-voice-status settings-voice-status--loading">
              <span className="material-symbols-outlined settings-voice-spinner">
                progress_activity
              </span>
              Downloading Whisper model...
            </p>
          )}
          {voiceDownloadStatus === "ready" && voiceModelPath && (
            <div className="settings-voice-status settings-voice-status--ready">
              <span className="material-symbols-outlined text-md">
                check_circle
              </span>
              <div className="settings-voice-status-copy">
                <span>Model downloaded</span>
                <code className="settings-voice-path">{voiceModelPath}</code>
              </div>
            </div>
          )}
          {voiceDownloadStatus === "error" && voiceDownloadError && (
            <p className="settings-voice-status settings-voice-status--error">
              <span className="material-symbols-outlined text-md">error</span>
              {voiceDownloadError}
            </p>
          )}
        </section>

        <div className="settings-divider" />

        {/* Providers */}
        <section className="settings-section">
          <h2 className="settings-section-title">AI Providers</h2>
          <p className="settings-section-desc">
            Configure default and custom AI providers. Keys are stored safely in
            a local database.
          </p>
          {showImportHint && (
            <div className="mt-3 rounded-lg border border-border-subtle bg-surface/60 px-3 py-3">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-primary text-[18px] leading-none mt-0.5">
                  tips_and_updates
                </span>

                <div className="flex-1">
                  <p className="text-xs font-medium text-foreground">
                    Import from environment
                  </p>

                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    API keys can be imported automatically.
                  </p>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {envProviderCandidates.map((candidate) => (
                      <Button
                        key={`${candidate.type}-env-import`}
                        type="button"
                        onClick={() =>
                          void handleImportProviderFromEnv(
                            candidate.type,
                            candidate.apiKey,
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs"
                        variant="ghost"
                        size="xxs"
                      >
                        <span className="material-symbols-outlined text-base">
                          input
                        </span>
                        Import {candidate.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 mt-4">
            {providers.map((p) => {
              const refreshStatus = providerRefreshStatus[p.id] ?? "idle";
              const refreshIcon =
                refreshStatus === "loading"
                  ? "autorenew"
                  : refreshStatus === "ok"
                    ? "check_circle"
                    : refreshStatus === "error"
                      ? "error"
                      : "refresh";
              const refreshTitle =
                refreshStatus === "loading"
                  ? "Refreshing models…"
                  : refreshStatus === "ok"
                    ? "Models refreshed."
                    : refreshStatus === "error"
                      ? "Refresh failed."
                      : "Refresh models";

              return (
                <div key={p.id}>
                  {editingProviderId === p.id ? (
                    <ProviderConfigurator
                      provider={p}
                      onSave={handleSaveProvider}
                      onCancel={() => setEditingProviderId(null)}
                    />
                  ) : (
                    <div className="flex items-center justify-between p-3 bg-inset rounded-md border-primary/30 border">
                      <div className="flex flex-col">
                        <span className="font-semibold text-sm">{p.name}</span>
                        <span className="text-xs text-muted uppercase tracking-wider mt-1">
                          {p.type}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        {p.type === "openai-compatible" && (
                          <IconButton
                            className={cn(
                              "p-1 hover:bg-surface rounded transition-colors",
                              refreshStatus === "ok"
                                ? "text-success hover:text-success"
                                : refreshStatus === "error"
                                  ? "text-error hover:text-error"
                                  : "text-muted hover:text-primary",
                            )}
                            onClick={() => void handleRefreshProviderModels(p)}
                            type="button"
                            title={refreshTitle}
                            aria-label={`Refresh models for ${p.name}`}
                            disabled={refreshStatus === "loading"}
                          >
                            <span
                              className={cn(
                                "material-symbols-outlined text-sm",
                                refreshStatus === "loading" && "animate-spin",
                              )}
                            >
                              {refreshIcon}
                            </span>
                          </IconButton>
                        )}
                        <IconButton
                          className="p-1 hover:bg-surface rounded text-muted hover:text-primary transition-colors"
                          onClick={() => setEditingProviderId(p.id)}
                        >
                          <span className="material-symbols-outlined text-sm">
                            edit
                          </span>
                        </IconButton>
                        <IconButton
                          className="p-1 hover:bg-surface rounded text-muted hover:text-error transition-colors"
                          onClick={() => handleDeleteProvider(p.id)}
                        >
                          <span className="material-symbols-outlined text-sm">
                            delete
                          </span>
                        </IconButton>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {isAdding ? (
              <ProviderConfigurator
                onSave={handleSaveProvider}
                onCancel={() => setIsAdding(false)}
              />
            ) : (
              <Button
                className="flex items-center justify-center p-3 mt-2 border border-dashed border-border-subtle rounded hover:border-primary hover:text-primary transition-colors text-muted text-sm gap-2"
                onClick={() => setIsAdding(true)}
                variant="ghost"
              >
                <span className="material-symbols-outlined text-sm">
                  add_circle
                </span>
                Add Provider
              </Button>
            )}
          </div>
        </section>

        <div className="settings-divider" />

        <section className="settings-section">
          <h2 className="settings-section-title">App Updates</h2>
          <p className="settings-section-desc">
            Signed releases are delivered from GitHub Releases.
          </p>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Current version</span>
              <span className="settings-row-desc">v{pkg.version}</span>
            </div>
            <Badge variant={updaterStatusVariant}>{updaterStatusLabel}</Badge>
          </div>

          {appUpdater.availableVersion && (
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Available version</span>
                <span className="settings-row-desc">
                  v{appUpdater.availableVersion}
                  {availableDateLabel ? ` • ${availableDateLabel}` : ""}
                </span>
              </div>
            </div>
          )}

          <div className="mt-3 rounded-lg border border-border-subtle bg-surface/60 px-3 py-3">
            <p className="text-xs leading-relaxed text-muted">
              {formatUpdaterLastChecked(appUpdater.lastCheckedAt)}
            </p>

            {updaterProgressValue !== null && (
              <p className="mt-2 text-xs leading-relaxed text-primary">
                Download progress: {updaterProgressValue}%
              </p>
            )}

            {appUpdater.error && (
              <p className="mt-2 text-xs leading-relaxed text-error">
                {appUpdater.error}
              </p>
            )}

            {appUpdater.releaseNotes && (
              <div className="mt-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">
                  Release notes
                </p>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted">
                  {appUpdater.releaseNotes}
                </p>
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                className="settings-save-btn"
                onClick={() => {
                  void onCheckForUpdates();
                }}
                disabled={isCheckingUpdates || isInstallingUpdate}
                variant={appUpdater.availableVersion ? "secondary" : "primary"}
                size="xs"
              >
                <span
                  className={cn(
                    "material-symbols-outlined text-md",
                    isCheckingUpdates && "animate-spin",
                  )}
                >
                  {isCheckingUpdates ? "progress_activity" : "system_update_alt"}
                </span>
                {isCheckingUpdates ? "Checking…" : "Check for updates"}
              </Button>

              {appUpdater.availableVersion && (
                <Button
                  className="settings-save-btn"
                  onClick={() => {
                    void onInstallUpdate();
                  }}
                  disabled={isCheckingUpdates || isInstallingUpdate}
                  size="xs"
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-md",
                      isInstallingUpdate && "animate-spin",
                    )}
                  >
                    {isInstallingUpdate ? "progress_activity" : "download"}
                  </span>
                  {installButtonLabel}
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>

      <div className="settings-footer">
        <span className="settings-footer-text">
          <span className="material-symbols-outlined text-primary text-md">
            terminal
          </span>
          Rakh
        </span>
        <span className="settings-footer-version">v{pkg.version}</span>
      </div>
    </motion.aside>
  );
}

export default function SettingsSidebar() {
  const { tabs } = useTabs();
  const [isOpen, setIsOpen] = useAtom(settingsSidebarOpenAtom);
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

  const effectiveVoiceDownloadStatus: VoiceDownloadStatus =
    voiceDownloadStatus === "downloading" || voiceDownloadStatus === "error"
      ? voiceDownloadStatus
      : voiceInputEnabled && !!voiceModelPath
        ? "ready"
        : "idle";

  const envKeysAvailable = useEnvProviderKeys();

  const close = () => setIsOpen(false);
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

  const handleToggleVoiceInput = useCallback(
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

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            key="sidebar-backdrop"
            className="settings-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={close}
          />
          <SettingsSidebarInner
            key="settings-sidebar-inner"
            providers={providers}
            envKeysAvailable={envKeysAvailable}
            onSetProviders={setProviders}
            themeMode={themeMode}
            onToggleThemeMode={() =>
              setThemeMode(themeMode === "dark" ? "light" : "dark")
            }
            themeName={themeName}
            onChangeThemeName={setThemeName}
            notifyOnAttention={notifyOnAttention}
            onToggleNotifyOnAttention={setNotifyOnAttention}
            voiceInputEnabled={voiceInputEnabled}
            voiceModelPath={voiceModelPath}
            voiceDownloadStatus={effectiveVoiceDownloadStatus}
            voiceDownloadError={voiceDownloadError}
            appUpdater={appUpdater}
            onCheckForUpdates={handleCheckForUpdates}
            onInstallUpdate={handleInstallUpdate}
            onToggleVoiceInput={handleToggleVoiceInput}
            onClose={close}
          />
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
