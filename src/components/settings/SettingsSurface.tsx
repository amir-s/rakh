import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { v4 as uuidv4 } from "uuid";
import pkg from "../../../package.json";
import {
  buildUniqueProviderName,
  type EnvKeyEntry,
  type EnvProviderType,
} from "@/agent/useEnvProviderKeys";
import {
  deleteProvider,
  saveProvider,
  type ProviderInstance,
} from "@/agent/db";
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
  Panel,
  SelectField,
  TextField,
  ToggleSwitch,
} from "@/components/ui";
import {
  getAppUpdaterProgressValue,
  getAppUpdaterStatusLabel,
  getAppUpdaterStatusVariant,
} from "@/updater";
import {
  DEFAULT_SETTINGS_SECTION,
  getSettingsSectionBadge,
  getSettingsSectionDefinition,
  getSettingsSectionsForGroup,
  SETTINGS_SECTION_GROUPS,
  type SettingsSectionId,
} from "./model";
import type {
  SettingsControllerValue,
  VoiceDownloadStatus,
} from "./useSettingsController";

type TestStatus = "idle" | "testing" | "ok" | "error";
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
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(`${url}/models`, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ id?: string; owned_by?: string }>;
  };

  return (json.data ?? [])
    .map((model) => model.id?.trim())
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, owned_by: "openai-compatible" }));
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

function SectionCard({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Panel className="settings-card">
      <div className="settings-card__header">
        <div>
          <h3 className="settings-card__title">{title}</h3>
          {description ? (
            <p className="settings-card__description">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="settings-card__actions">{actions}</div>
        ) : null}
      </div>
      <div className="settings-card__body">{children}</div>
    </Panel>
  );
}

function ProviderConfigurator({
  provider,
  onSave,
  onCancel,
}: {
  provider?: ProviderInstance;
  onSave: (provider: ProviderInstance) => void;
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
    } catch (error) {
      setTestStatus("error");
      setTestError(error instanceof Error ? error.message : String(error));
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
    <Panel className="settings-provider-form">
      <div className="settings-provider-form__grid">
        <div className="settings-field">
          <label className="settings-field-label">Name</label>
          <TextField
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My OpenAI Key"
            wrapClassName="settings-input-wrap"
          />
        </div>

        <div className="settings-field">
          <label className="settings-field-label">Provider Type</label>
          <SelectField
            className="settings-input settings-provider-form__select"
            value={type}
            onChange={(e) =>
              setType(e.target.value as ProviderInstance["type"])
            }
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai-compatible">
              Custom (OpenAI Compatible)
            </option>
          </SelectField>
        </div>

        <div className="settings-field">
          <label className="settings-field-label">
            {isCustom ? "API Key (optional)" : "API Key"}
          </label>
          <TextField
            type={keyVisible ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            wrapClassName="settings-input-wrap"
            endAdornment={
              <IconButton
                className="settings-input-icon-btn"
                onClick={() => setKeyVisible((visible) => !visible)}
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

        {isCustom ? (
          <div className="settings-field">
            <label className="settings-field-label">
              Base URL (include version)
            </label>
            <TextField
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              wrapClassName="settings-input-wrap"
            />
          </div>
        ) : null}
      </div>

      <div className="settings-provider-form__footer">
        <div className="settings-provider-form__status" aria-live="polite">
          {testStatus === "ok" ? (
            <span className="settings-feedback settings-feedback--success">
              <span className="material-symbols-outlined text-md">
                check_circle
              </span>
              {isCustom && hasCachedModels
                ? `${cachedModels.length} model${cachedModels.length === 1 ? "" : "s"} loaded.`
                : "Provider looks valid."}
            </span>
          ) : null}
          {testStatus === "error" && testError ? (
            <span className="settings-feedback settings-feedback--error">
              <span className="material-symbols-outlined text-md">error</span>
              {testError}
            </span>
          ) : null}
        </div>

        <div className="settings-provider-form__actions">
          <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => {
              void handleTest();
            }}
            loading={testStatus === "testing"}
          >
            Test
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={handleSaveClick}
            disabled={!name.trim()}
          >
            Save Provider
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function AppearanceSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  return (
    <SectionCard
      title="Theme & Mode"
      description="Choose the visual theme and whether the UI uses dark or light mode."
    >
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Theme</span>
          <span className="settings-row-desc">
            Theme palettes come from the design-token theme registry.
          </span>
        </div>
        <SelectField
          className="settings-select settings-select--compact"
          value={controller.themeName}
          onChange={(e) => controller.setThemeName(e.target.value as ThemeName)}
        >
          {THEME_NAMES.map((themeName) => (
            <option key={themeName} value={themeName}>
              {formatThemeName(themeName)}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Mode</span>
          <span className="settings-row-desc">
            Toggle the active palette without changing the selected theme
            family.
          </span>
        </div>
        <Button
          className={cn(
            "settings-toggle-btn",
            controller.themeMode === "dark" && "settings-toggle-btn--active",
          )}
          onClick={controller.toggleThemeMode}
          variant="secondary"
          size="xs"
        >
          <span className="material-symbols-outlined text-md">
            {controller.themeMode === "dark" ? "light_mode" : "dark_mode"}
          </span>
          <span>{controller.themeMode === "dark" ? "Light" : "Dark"}</span>
        </Button>
      </div>
    </SectionCard>
  );
}

function NotificationsSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  return (
    <SectionCard
      title="Attention Alerts"
      description="Control whether the app notifies you when an agent needs approval or worktree input."
    >
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Agent attention</span>
          <span className="settings-row-desc">
            Desktop notifications are shown only when focus is elsewhere.
          </span>
        </div>
        <ToggleSwitch
          checked={controller.notifyOnAttention}
          onChange={() => {
            void controller.toggleNotifyOnAttention();
          }}
          className="settings-switch"
        />
      </div>
    </SectionCard>
  );
}

function VoiceStatus({
  voiceDownloadStatus,
  voiceModelPath,
  voiceDownloadError,
}: {
  voiceDownloadStatus: VoiceDownloadStatus;
  voiceModelPath: string;
  voiceDownloadError: string | null;
}) {
  if (voiceDownloadStatus === "downloading") {
    return (
      <p className="settings-voice-status settings-voice-status--loading">
        <span className="material-symbols-outlined settings-voice-spinner">
          progress_activity
        </span>
        Downloading Whisper model...
      </p>
    );
  }

  if (voiceDownloadStatus === "ready" && voiceModelPath) {
    return (
      <div className="settings-voice-status settings-voice-status--ready">
        <span className="material-symbols-outlined text-md">check_circle</span>
        <div className="settings-voice-status-copy">
          <span>Model downloaded</span>
          <code className="settings-voice-path">{voiceModelPath}</code>
        </div>
      </div>
    );
  }

  if (voiceDownloadStatus === "error" && voiceDownloadError) {
    return (
      <p className="settings-voice-status settings-voice-status--error">
        <span className="material-symbols-outlined text-md">error</span>
        {voiceDownloadError}
      </p>
    );
  }

  return null;
}

function VoiceSection({ controller }: { controller: SettingsControllerValue }) {
  return (
    <SectionCard
      title="Voice Input"
      description="Use the microphone with a locally prepared Whisper model for chat transcription."
    >
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Enable voice input</span>
          <span className="settings-row-desc">
            The Whisper model is prepared on demand and stored locally.
          </span>
        </div>
        <ToggleSwitch
          checked={controller.voiceInputEnabled}
          className="settings-switch"
          onChange={() => {
            void controller.toggleVoiceInput(!controller.voiceInputEnabled);
          }}
          disabled={controller.voiceDownloadStatus === "downloading"}
        />
      </div>

      <VoiceStatus
        voiceDownloadStatus={controller.voiceDownloadStatus}
        voiceModelPath={controller.voiceModelPath}
        voiceDownloadError={controller.voiceDownloadError}
      />
    </SectionCard>
  );
}

function ProvidersSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
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

  const envProviderCandidates = controller.envKeysAvailable
    .map((entry) => ({
      ...entry,
      label: entry.type === "openai" ? "OpenAI" : "Anthropic",
    }))
    .filter(
      (candidate) =>
        !controller.providers.some(
          (provider) => provider.type === candidate.type,
        ),
    );
  const showImportHint = envProviderCandidates.length > 0;

  const handleSaveProvider = async (provider: ProviderInstance) => {
    await saveProvider(provider);
    controller.setProviders([
      ...controller.providers.filter((p) => p.id !== provider.id),
      provider,
    ]);
    setIsAdding(false);
    setEditingProviderId(null);
  };

  const handleDeleteProvider = async (id: string) => {
    await deleteProvider(id);
    controller.setProviders(controller.providers.filter((p) => p.id !== id));
  };

  const handleRefreshProviderModels = async (provider: ProviderInstance) => {
    if (provider.type !== "openai-compatible") return;

    clearRefreshResetTimeout(provider.id);
    setProviderRefreshStatus((prev) => ({
      ...prev,
      [provider.id]: "loading",
    }));
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
      controller.setProviders(
        controller.providers.map((currentProvider) =>
          currentProvider.id === updatedProvider.id
            ? updatedProvider
            : currentProvider,
        ),
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
  };

  const handleImportProviderFromEnv = async (
    type: EnvProviderType,
    apiKey: string,
  ) => {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) return;

    const alreadyExists = controller.providers.some(
      (provider) => provider.type === type,
    );
    if (alreadyExists) return;

    const defaultName = type === "openai" ? "OpenAI (Env)" : "Anthropic (Env)";
    const provider: ProviderInstance = {
      id: uuidv4(),
      name: buildUniqueProviderName(defaultName, controller.providers),
      type,
      apiKey: normalizedApiKey,
    };

    await saveProvider(provider);
    controller.setProviders([...controller.providers, provider]);
  };

  return (
    <div className="settings-page__section-stack">
      <SectionCard
        title="Provider Registry"
        description="Configure first-party and custom OpenAI-compatible providers. Keys remain local to this app."
        actions={
          <Button
            type="button"
            size="xs"
            onClick={() => {
              setIsAdding(true);
              setEditingProviderId(null);
            }}
            className="text-nowrap"
          >
            Add Provider
          </Button>
        }
      >
        {showImportHint ? (
          <Panel className="settings-callout">
            <div className="settings-callout__icon">
              <span className="material-symbols-outlined text-primary text-[18px]">
                tips_and_updates
              </span>
            </div>
            <div className="settings-callout__body">
              <p className="settings-callout__title">Import from environment</p>
              <p className="settings-callout__copy">
                API keys already available in the environment can be imported
                directly into the local provider registry.
              </p>
              <div className="settings-callout__actions">
                {envProviderCandidates.map((candidate) => (
                  <Button
                    key={`${candidate.type}-env-import`}
                    type="button"
                    variant="ghost"
                    size="xxs"
                    onClick={() =>
                      void handleImportProviderFromEnv(
                        candidate.type,
                        candidate.apiKey,
                      )
                    }
                  >
                    Import {candidate.label}
                  </Button>
                ))}
              </div>
            </div>
          </Panel>
        ) : null}

        <div className="settings-provider-list">
          {controller.providers.length === 0 && !isAdding ? (
            <Panel variant="inset" className="settings-empty-panel">
              <span className="material-symbols-outlined settings-empty-panel__icon">
                hub
              </span>
              <div className="settings-empty-panel__copy">
                <span className="settings-empty-panel__title">
                  No providers configured
                </span>
                <span className="settings-empty-panel__description">
                  Add a provider to populate the model picker and start new
                  agent runs.
                </span>
              </div>
            </Panel>
          ) : null}

          {controller.providers.map((provider) => {
            const refreshStatus = providerRefreshStatus[provider.id] ?? "idle";
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

            return editingProviderId === provider.id ? (
              <ProviderConfigurator
                key={provider.id}
                provider={provider}
                onSave={handleSaveProvider}
                onCancel={() => setEditingProviderId(null)}
              />
            ) : (
              <Panel key={provider.id} className="settings-provider-card">
                <div className="settings-provider-card__copy">
                  <span className="settings-provider-card__title">
                    {provider.name}
                  </span>
                  <span className="settings-provider-card__meta">
                    {provider.type}
                  </span>
                </div>
                <div className="settings-provider-card__actions">
                  {provider.type === "openai-compatible" ? (
                    <IconButton
                      className={cn(
                        "settings-provider-card__icon-btn",
                        refreshStatus === "ok" &&
                          "settings-provider-card__icon-btn--success",
                        refreshStatus === "error" &&
                          "settings-provider-card__icon-btn--danger",
                      )}
                      onClick={() => void handleRefreshProviderModels(provider)}
                      title={refreshTitle}
                      aria-label={`Refresh models for ${provider.name}`}
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
                  ) : null}
                  <IconButton
                    className="settings-provider-card__icon-btn"
                    onClick={() => setEditingProviderId(provider.id)}
                    title={`Edit ${provider.name}`}
                    aria-label={`Edit ${provider.name}`}
                  >
                    <span className="material-symbols-outlined text-sm">
                      edit
                    </span>
                  </IconButton>
                  <IconButton
                    className="settings-provider-card__icon-btn settings-provider-card__icon-btn--danger"
                    onClick={() => {
                      void handleDeleteProvider(provider.id);
                    }}
                    title={`Delete ${provider.name}`}
                    aria-label={`Delete ${provider.name}`}
                  >
                    <span className="material-symbols-outlined text-sm">
                      delete
                    </span>
                  </IconButton>
                </div>
              </Panel>
            );
          })}

          {isAdding ? (
            <ProviderConfigurator
              onSave={handleSaveProvider}
              onCancel={() => setIsAdding(false)}
            />
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}

function UpdatesSection({
  controller,
}: {
  controller: SettingsControllerValue;
}) {
  const updaterStatusLabel = getAppUpdaterStatusLabel(controller.appUpdater);
  const updaterStatusVariant = getAppUpdaterStatusVariant(
    controller.appUpdater,
  );
  const updaterProgressValue = getAppUpdaterProgressValue(
    controller.appUpdater,
  );
  const isCheckingUpdates = controller.appUpdater.status === "checking";
  const isInstallingUpdate =
    controller.appUpdater.status === "downloading" ||
    controller.appUpdater.status === "installing" ||
    controller.appUpdater.status === "restarting";
  const installButtonLabel = isInstallingUpdate
    ? controller.appUpdater.status === "downloading"
      ? "Downloading…"
      : controller.appUpdater.status === "installing"
        ? "Installing…"
        : "Restarting…"
    : controller.appUpdater.availableVersion
      ? `Install v${controller.appUpdater.availableVersion}`
      : "Install update";
  const availableDateLabel = controller.appUpdater.availableDate
    ? new Date(controller.appUpdater.availableDate).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <SectionCard
      title="Release Channel"
      description="Check for signed releases from GitHub and install them without leaving the app."
    >
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Current version</span>
          <span className="settings-row-desc">v{pkg.version}</span>
        </div>
        <Badge variant={updaterStatusVariant}>{updaterStatusLabel}</Badge>
      </div>

      {controller.appUpdater.availableVersion ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Available version</span>
            <span className="settings-row-desc">
              v{controller.appUpdater.availableVersion}
              {availableDateLabel ? ` • ${availableDateLabel}` : ""}
            </span>
          </div>
        </div>
      ) : null}

      <Panel variant="inset" className="settings-updates-panel">
        <p className="settings-section-desc">
          {formatUpdaterLastChecked(controller.appUpdater.lastCheckedAt)}
        </p>

        {updaterProgressValue !== null ? (
          <p className="settings-feedback settings-feedback--primary">
            Download progress: {updaterProgressValue}%
          </p>
        ) : null}

        {controller.appUpdater.error ? (
          <p className="settings-feedback settings-feedback--error">
            {controller.appUpdater.error}
          </p>
        ) : null}

        {controller.appUpdater.releaseNotes ? (
          <div className="settings-release-notes">
            <p className="settings-release-notes__label">Release notes</p>
            <p className="settings-release-notes__body">
              {controller.appUpdater.releaseNotes}
            </p>
          </div>
        ) : null}

        <div className="settings-updates-panel__actions">
          <Button
            type="button"
            onClick={() => {
              void controller.checkForUpdates();
            }}
            disabled={isCheckingUpdates || isInstallingUpdate}
            variant={
              controller.appUpdater.availableVersion ? "secondary" : "primary"
            }
            size="xs"
            loading={isCheckingUpdates}
          >
            {isCheckingUpdates ? "Checking…" : "Check for updates"}
          </Button>

          {controller.appUpdater.availableVersion ? (
            <Button
              type="button"
              onClick={() => {
                void controller.installUpdate();
              }}
              disabled={isCheckingUpdates || isInstallingUpdate}
              size="xs"
              loading={isInstallingUpdate}
            >
              {installButtonLabel}
            </Button>
          ) : null}
        </div>
      </Panel>
    </SectionCard>
  );
}

function renderSection(
  sectionId: SettingsSectionId,
  controller: SettingsControllerValue,
) {
  switch (sectionId) {
    case "appearance":
      return <AppearanceSection controller={controller} />;
    case "notifications":
      return <NotificationsSection controller={controller} />;
    case "providers":
      return <ProvidersSection controller={controller} />;
    case "voice":
      return <VoiceSection controller={controller} />;
    case "updates":
      return <UpdatesSection controller={controller} />;
    default:
      return <AppearanceSection controller={controller} />;
  }
}

export interface SettingsSurfaceProps {
  controller: SettingsControllerValue;
  activeSectionId?: SettingsSectionId;
  onChangeSection: (sectionId: SettingsSectionId) => void;
}

export default function SettingsSurface({
  controller,
  activeSectionId = DEFAULT_SETTINGS_SECTION,
  onChangeSection,
}: SettingsSurfaceProps) {
  const activeSection = getSettingsSectionDefinition(activeSectionId);
  const activeBadge = getSettingsSectionBadge(
    activeSection.id,
    controller.appUpdater,
  );

  return (
    <div className="settings-shell">
      <div className="settings-shell__body">
        <aside className="settings-nav" aria-label="Settings sections">
          {SETTINGS_SECTION_GROUPS.map((group) => (
            <div key={group.id} className="settings-nav__group">
              <div className="settings-nav__group-label">{group.label}</div>
              <div className="settings-nav__items">
                {getSettingsSectionsForGroup(group.id).map((section) => {
                  const badge = getSettingsSectionBadge(
                    section.id,
                    controller.appUpdater,
                  );
                  const isActive = section.id === activeSection.id;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      className={cn(
                        "settings-nav__item",
                        isActive && "settings-nav__item--active",
                      )}
                      onClick={() => onChangeSection(section.id)}
                    >
                      <div className="settings-nav__item-main">
                        <span className="material-symbols-outlined settings-nav__item-icon">
                          {section.icon}
                        </span>
                        <div className="settings-nav__item-copy">
                          <span className="settings-nav__item-label">
                            {section.label}
                          </span>
                        </div>
                      </div>
                      {badge ? (
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </aside>

        <section
          className="settings-page"
          aria-labelledby="settings-page-title"
        >
          <div className="settings-page__header">
            <div className="settings-page__header-copy">
              <div className="settings-page__title-row">
                <span className="material-symbols-outlined settings-page__title-icon text-xl">
                  {activeSection.icon}
                </span>
                <h2 id="settings-page-title" className="settings-page__title">
                  {activeSection.label}
                </h2>
              </div>
              <p className="settings-page__description">
                {activeSection.description}
              </p>
            </div>
            <div className="settings-page__header-meta">
              {activeBadge ? (
                <Badge variant={activeBadge.variant}>{activeBadge.label}</Badge>
              ) : null}
            </div>
          </div>

          <div className="settings-page__content">
            {renderSection(activeSection.id, controller)}
          </div>
        </section>
      </div>
    </div>
  );
}
