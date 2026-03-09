import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactGet,
  artifactList,
  listenForArtifactChanges,
} from "@/agent/tools/artifacts";
import type {
  ArtifactContentCache,
  ArtifactContentEntry,
  SessionArtifactInventory,
} from "./types";
import {
  buildSessionArtifactInventory,
  getArtifactContentKey,
} from "./model";

const EMPTY_INVENTORY: SessionArtifactInventory = {
  groups: [],
  kindCounts: [],
  latestPlanGroup: null,
  fingerprint: "",
};

interface SessionInventoryState {
  tabId: string;
  loading: boolean;
  error: string | null;
  inventory: SessionArtifactInventory;
  hasLoadedSuccessfully: boolean;
}

interface ArtifactCacheState {
  tabId: string;
  entries: ArtifactContentCache;
}

const ARTIFACT_SUBSCRIPTION_RETRY_BASE_MS = 1_000;
const ARTIFACT_SUBSCRIPTION_RETRY_MAX_MS = 30_000;

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useSessionArtifactInventory(tabId: string, enabled = true) {
  const runtimeEnabled = isTauriRuntime() && enabled;
  const [state, setState] = useState<SessionInventoryState>({
    tabId,
    loading: runtimeEnabled,
    error: null,
    inventory: EMPTY_INVENTORY,
    hasLoadedSuccessfully: false,
  });

  useEffect(() => {
    let cancelled = false;
    let refreshInFlight = false;
    let refreshQueued = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelayMs = ARTIFACT_SUBSCRIPTION_RETRY_BASE_MS;
    let shouldCatchUpOnResubscribe = false;
    let unlisten: (() => void) | null = null;

    if (!runtimeEnabled) return;

    const refreshInventory = async () => {
      if (cancelled) return;
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }

      refreshInFlight = true;
      const result = await artifactList(tabId, {
        latestOnly: false,
        limit: 1_000,
      });

      try {
        if (cancelled) return;

        if (result.ok) {
          setState({
            tabId,
            loading: false,
            error: null,
            inventory: buildSessionArtifactInventory(result.data.artifacts),
            hasLoadedSuccessfully: true,
          });
        } else {
          setState((prev) =>
            prev.tabId !== tabId
              ? {
                  tabId,
                  loading: false,
                  error: result.error.message,
                  inventory: EMPTY_INVENTORY,
                  hasLoadedSuccessfully: false,
                }
              : {
                  ...prev,
                  loading: false,
                  error: result.error.message,
                },
          );
        }
      } finally {
        refreshInFlight = false;
        if (!cancelled && refreshQueued) {
          refreshQueued = false;
          void refreshInventory();
        }
      }
    };

    const scheduleSubscriptionRetry = () => {
      if (cancelled || retryTimer) return;
      shouldCatchUpOnResubscribe = true;
      const currentDelay = retryDelayMs;
      retryDelayMs = Math.min(
        retryDelayMs * 2,
        ARTIFACT_SUBSCRIPTION_RETRY_MAX_MS,
      );
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void subscribeToArtifactChanges();
      }, currentDelay);
    };

    const subscribeToArtifactChanges = async () => {
      if (cancelled) return;
      const nextUnlisten = await listenForArtifactChanges(tabId, () => {
        void refreshInventory();
      });

      if (cancelled) {
        nextUnlisten?.();
        return;
      }

      if (!nextUnlisten) {
        scheduleSubscriptionRetry();
        return;
      }

      retryDelayMs = ARTIFACT_SUBSCRIPTION_RETRY_BASE_MS;
      unlisten = nextUnlisten;

      if (shouldCatchUpOnResubscribe) {
        shouldCatchUpOnResubscribe = false;
        void refreshInventory();
      }
    };

    void refreshInventory();
    void subscribeToArtifactChanges();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unlisten?.();
    };
  }, [runtimeEnabled, tabId]);

  if (!runtimeEnabled) {
    return {
      inventory: EMPTY_INVENTORY,
      loading: false,
      error: null,
      hasLoadedSuccessfully: false,
    };
  }

  if (state.tabId !== tabId) {
    return {
      inventory: EMPTY_INVENTORY,
      loading: true,
      error: null,
      hasLoadedSuccessfully: false,
    };
  }

  return {
    ...state,
    loading:
      state.loading ||
      (!state.hasLoadedSuccessfully &&
        state.error === null &&
        state.inventory.groups.length === 0),
  };
}

export function useArtifactContentCache(tabId: string) {
  const [state, setState] = useState<ArtifactCacheState>({
    tabId,
    entries: {},
  });
  const inFlightKeysRef = useRef<Set<string>>(new Set());

  const getEntry = useCallback(
    (artifactId: string, version: number): ArtifactContentEntry | undefined => {
      if (state.tabId !== tabId) return undefined;
      return state.entries[getArtifactContentKey(artifactId, version)];
    },
    [state, tabId],
  );

  const ensureArtifactContent = useCallback(
    async (artifactId: string, version: number) => {
      if (!isTauriRuntime()) return;

      const key = getArtifactContentKey(artifactId, version);
      const inFlightKey = `${tabId}:${key}`;
      const existing =
        state.tabId === tabId ? state.entries[key] : undefined;

      if (existing?.status === "loaded" || existing?.status === "loading") {
        return;
      }
      if (inFlightKeysRef.current.has(inFlightKey)) return;

      inFlightKeysRef.current.add(inFlightKey);
      setState((prev) => {
        if (prev.tabId !== tabId) {
          return {
            tabId,
            entries: {
              [key]: { status: "loading" },
            },
          };
        }
        return {
          ...prev,
          entries: {
            ...prev.entries,
            [key]: { status: "loading" },
          },
        };
      });

      try {
        const result = await artifactGet(tabId, {
          artifactId,
          version,
          includeContent: true,
        });

        setState((prev) => {
          if (prev.tabId !== tabId) return prev;
          return {
            ...prev,
            entries: {
              ...prev.entries,
              [key]: result.ok
                ? { status: "loaded", artifact: result.data.artifact }
                : { status: "error", error: result.error.message },
            },
          };
        });
      } finally {
        inFlightKeysRef.current.delete(inFlightKey);
      }
    },
    [state.entries, state.tabId, tabId],
  );

  return useMemo(
    () => ({
      entries: state.tabId === tabId ? state.entries : {},
      getEntry,
      ensureArtifactContent,
    }),
    [ensureArtifactContent, getEntry, state.entries, state.tabId, tabId],
  );
}
