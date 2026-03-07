import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactGet, artifactList } from "@/agent/tools/artifacts";
import type {
  ArtifactContentCache,
  ArtifactContentEntry,
  SessionArtifactInventory,
} from "./types";
import {
  ARTIFACT_POLL_MS,
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
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (!runtimeEnabled) return;

    const poll = async () => {
      const result = await artifactList(tabId, {
        latestOnly: false,
        limit: 1_000,
      });

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

      timer = setTimeout(poll, ARTIFACT_POLL_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
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
