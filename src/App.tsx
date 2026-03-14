import "@/styles/globals.css";
import { Provider, useAtom, useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import TopChrome from "@/components/TopChrome";
import AgentNotificationManager from "@/components/AgentNotificationManager";
import DesktopTrayManager from "@/components/DesktopTrayManager";
import { TabsProvider } from "@/contexts/TabsContext";
import { useTabs } from "@/contexts/TabsContext";
import {
  jotaiStore,
  themeModeAtom,
  themeNameAtom,
  agentAtomFamily,
  debugModeEnabledAtom,
  patchAgentState,
  defaultCommunicationProfileAtom,
} from "@/agent/atoms";
import { loadProviders, providersAtom, loadProfiles, profilesAtom, loadCommandList, commandListAtom } from "@/agent/db";
import { resolveCommunicationProfileId } from "@/agent/communicationProfiles";
import {
  loadMcpServers,
  loadMcpSettings,
  mcpServersAtom,
  mcpSettingsAtom,
} from "@/agent/mcp";
import { hydratePersistedSession } from "@/agent/sessionRestore";
import WorkspacePage from "@/WorkspacePage";
import SettingsPage from "@/components/settings/SettingsPage";
import {
  loadSessions,
  upsertSession,
  archiveSession,
  deleteSession,
  isSessionEmpty,
  markSessionAsPersisted,
  type PersistedSession,
} from "@/agent/persistence";
import type { AgentStatus } from "@/agent/types";
import { preloadEnvProviderKeys } from "@/agent/useEnvProviderKeys";
import { logFrontendSoon } from "@/logging/client";
import LogsWindowApp from "@/logging/LogsWindowApp";
import {
  LOG_WINDOW_MODE,
  parseLogNavigatePayloadFromSearch,
} from "@/logging/window";
import { STATIC_MODEL_CATALOG } from "@/agent/modelCatalog";
import { getThemeSubagentColorVariables } from "@/styles/themes/registry";
import { checkForAppUpdates } from "@/updater";

/* ──────────────────────────────────────────────────────────────────────────────────
   ThemeApplier — syncs themeAtom to data-theme on <html>
───────────────────────────────────────────────────────────────────────────────── */

function ThemeApplier() {
  const [themeMode] = useAtom(themeModeAtom);
  const [themeName] = useAtom(themeNameAtom);
  const appliedSubagentVarsRef = useRef<string[]>([]);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", themeMode);
    document.documentElement.setAttribute("data-theme-name", themeName);

    const nextVars = getThemeSubagentColorVariables(themeMode);
    const nextVarNames = Object.keys(nextVars);
    for (const varName of appliedSubagentVarsRef.current) {
      if (!nextVarNames.includes(varName)) {
        document.documentElement.style.removeProperty(varName);
      }
    }
    for (const [varName, value] of Object.entries(nextVars)) {
      document.documentElement.style.setProperty(varName, value);
    }
    appliedSubagentVarsRef.current = nextVarNames;
  }, [themeMode, themeName]);
  return null;
}

function DebugModeSynchronizer() {
  const { tabs } = useTabs();
  const debugModeEnabled = useAtomValue(debugModeEnabledAtom);

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.mode === "settings") continue;

      const currentShowDebug = jotaiStore.get(agentAtomFamily(tab.id)).showDebug ?? false;
      if (currentShowDebug === debugModeEnabled) continue;

      patchAgentState(tab.id, { showDebug: debugModeEnabled });
    }
  }, [tabs, debugModeEnabled]);

  return null;
}

/* ──────────────────────────────────────────────────────────────────────────────────
   AutoSaveManager — saves sessions on completion; archives or deletes on close
───────────────────────────────────────────────────────────────────────────────── */

function AutoSaveManager() {
  const { tabs } = useTabs();
  // Track the previous tab list so we can inspect removed tabs' mode
  const prevTabsRef = useRef<typeof tabs>([]);

  useEffect(() => {
    const currentIds = new Set(tabs.map((t) => t.id));
    const prevTabs = prevTabsRef.current;

    // Closed workspace tabs: delete if empty, otherwise save + archive.
    for (const prevTab of prevTabs) {
      if (!currentIds.has(prevTab.id) && prevTab.mode === "workspace") {
        const state = jotaiStore.get(agentAtomFamily(prevTab.id));
        if (isSessionEmpty(state)) {
          void deleteSession(prevTab.id);
          continue;
        }
        // Save latest state before archiving so nothing is lost
        void upsertSession(prevTab).then(() => archiveSession(prevTab.id));
      }
    }

    prevTabsRef.current = tabs;
  }, [tabs]);

  // Subscribe to each workspace tab's atom; save when agent becomes idle/done/error
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    for (const tab of tabs) {
      if (tab.mode !== "workspace") continue;

      const tabAtom = agentAtomFamily(tab.id);
      let lastStatus: AgentStatus = jotaiStore.get(tabAtom).status;
      let lastShowDebug = jotaiStore.get(tabAtom).showDebug ?? false;
      let lastQueueSnapshot = JSON.stringify({
        queueState: jotaiStore.get(tabAtom).queueState,
        queuedMessages: jotaiStore.get(tabAtom).queuedMessages,
      });

      const unsub = jotaiStore.sub(tabAtom, () => {
        const state = jotaiStore.get(tabAtom);
        const newStatus = state.status;
        const newShowDebug = state.showDebug ?? false;
        const newQueueSnapshot = JSON.stringify({
          queueState: state.queueState,
          queuedMessages: state.queuedMessages,
        });

        const settled =
          newStatus !== lastStatus &&
          (newStatus === "idle" ||
            newStatus === "done" ||
            newStatus === "error");
        const debugToggled = newShowDebug !== lastShowDebug;
        const queueChanged = newQueueSnapshot !== lastQueueSnapshot;

        lastStatus = newStatus;
        lastShowDebug = newShowDebug;
        lastQueueSnapshot = newQueueSnapshot;

        if (settled || debugToggled || queueChanged) {
          const currentTab = tabs.find((t) => t.id === tab.id);
          if (currentTab && currentTab.mode === "workspace") {
            upsertSession(currentTab);
          }
        }
      });

      unsubs.push(unsub);
    }

    return () => unsubs.forEach((fn) => fn());
    // Re-subscribe whenever the tab list changes (new tabs added, mode changes)
  }, [tabs]);

  return null;
}

function ActiveTabContent() {
  const { tabs, activeTabId } = useTabs();
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  if (activeTab?.mode === "settings") {
    return <SettingsPage />;
  }

  return <WorkspacePage />;
}

/* ─────────────────────────────────────────────────────────────────────────────
   App — root component
───────────────────────────────────────────────────────────────────────────── */

import ThemePreview from "@/ThemePreview";

export default function App() {
  const searchParams = new URLSearchParams(window.location.search);
  const isLogsWindow = searchParams.get("window") === LOG_WINDOW_MODE;
  const initialLogPayload = isLogsWindow
    ? parseLogNavigatePayloadFromSearch(window.location.search)
    : null;
  // Check if we are in preview mode
  const isPreview = searchParams.get("preview") === "true";

  // null = still loading, [] / [...] = ready
  const [initialSessions, setInitialSessions] = useState<
    PersistedSession[] | null
  >(null);

  useEffect(() => {
    if (isPreview || isLogsWindow) return; // Skip app bootstrap for preview/log windows

    // Prime provider env keys at startup so settings opens without waiting on backend reads.
    void preloadEnvProviderKeys();

    Promise.all([
      loadSessions(),
      loadProviders(),
      loadProfiles(),
      loadMcpServers(),
      loadMcpSettings(),
      loadCommandList(),
    ]).then(
      ([sessions, providers, profiles, mcpServers, mcpSettings, commandList]) => {
        // Load providers and profiles into global store early
        jotaiStore.set(providersAtom, providers);
        jotaiStore.set(profilesAtom, profiles);
        const storedDefaultCommunicationProfile = jotaiStore.get(
          defaultCommunicationProfileAtom,
        );
        const resolvedDefaultCommunicationProfile = resolveCommunicationProfileId(
          undefined,
          profiles,
          storedDefaultCommunicationProfile,
        );
        if (
          resolvedDefaultCommunicationProfile &&
          resolvedDefaultCommunicationProfile !== storedDefaultCommunicationProfile
        ) {
          jotaiStore.set(
            defaultCommunicationProfileAtom,
            resolvedDefaultCommunicationProfile,
          );
        }
        jotaiStore.set(mcpServersAtom, mcpServers);
        jotaiStore.set(mcpSettingsAtom, mcpSettings);
        jotaiStore.set(commandListAtom, commandList);

        // Hydrate Jotai atoms before first render of agent components
        for (const s of sessions) {
          try {
            // Check if provider for this session model still exists
            // If not, maybe we display an error on load? (The prompt requested this)
            let restoreError: string | null = null;
            if (s.model) {
              // Find provider by prefix since model is "{providerName}/{rawId}"
              const [providerName] = s.model.split("/");
              const provider = providerName
                ? providers.find((p) => p.name === providerName)
                : undefined;
              if (providerName && !provider) {
                restoreError = `The provider previously driving this session ("${providerName}") was deleted or renamed. Please choose another model.`;
              } else if (
                provider &&
                (provider.type === "openai" || provider.type === "anthropic")
              ) {
                const staticModelId = s.model.slice(provider.name.length + 1);
                const modelStillExists = STATIC_MODEL_CATALOG.some(
                  (entry) =>
                    entry.id === staticModelId &&
                    entry.owned_by === provider.type,
                );
                if (!modelStillExists) {
                  restoreError = `The model previously selected for this session ("${staticModelId}") is no longer in src/agent/models.catalog.json. Please choose another model.`;
                }
              }
            }

            hydratePersistedSession(s, { restoreError });
            markSessionAsPersisted(s);
          } catch (e) {
            logFrontendSoon({
              level: "error",
              tags: ["frontend", "db", "system"],
              event: "app.restoreSession.error",
              message: "Failed to restore session",
              kind: "error",
              data: { sessionId: s.id, error: e },
            });
          }
        }
        setInitialSessions(sessions);
        void checkForAppUpdates({ silent: true });
      },
    );
  }, [isLogsWindow, isPreview]);

  if (isPreview) {
    return <ThemePreview />;
  }

  if (isLogsWindow) {
    return (
      <div className="app-root" style={{ height: "100%" }}>
        <Provider store={jotaiStore}>
          <ThemeApplier />
          <LogsWindowApp initialPayload={initialLogPayload} />
        </Provider>
      </div>
    );
  }

  // Show nothing while sessions are loading to avoid a flash of empty state
  if (initialSessions === null) return null;

  return (
    <div className="app-root" style={{ height: "100%" }}>
      <Provider store={jotaiStore}>
        <TabsProvider initialSessions={initialSessions}>
          <ThemeApplier />
          <DebugModeSynchronizer />
          <AutoSaveManager />
          <AgentNotificationManager />
          <DesktopTrayManager />
          <TopChrome />
          <div className="page-content">
            <ActiveTabContent />
          </div>
        </TabsProvider>
      </Provider>
    </div>
  );
}
