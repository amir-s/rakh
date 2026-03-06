import { useEffect, useReducer, useRef } from "react";
import { useAgentReviewEdits, useAgentTodos } from "@/agent/useAgents";
import type { ArtifactTab } from "./types";
import { buildTodoSnapshot } from "./model";
import { useSessionArtifactInventory } from "./useSessionArtifacts";

interface ArtifactPaneUiState {
  activeTab: ArtifactTab;
  unseenTabs: Set<ArtifactTab>;
}

type ArtifactPaneUiAction =
  | { type: "reset" }
  | { type: "mark-unseen"; tab: ArtifactTab }
  | { type: "clear-unseen"; tab: ArtifactTab }
  | { type: "activate"; tab: ArtifactTab }
  | { type: "force-active"; tab: ArtifactTab };

function artifactPaneUiReducer(
  state: ArtifactPaneUiState,
  action: ArtifactPaneUiAction,
): ArtifactPaneUiState {
  switch (action.type) {
    case "reset":
      return { ...state, unseenTabs: new Set() };
    case "mark-unseen": {
      if (state.unseenTabs.has(action.tab)) return state;
      return {
        ...state,
        unseenTabs: new Set([...state.unseenTabs, action.tab]),
      };
    }
    case "clear-unseen": {
      if (!state.unseenTabs.has(action.tab)) return state;
      const next = new Set(state.unseenTabs);
      next.delete(action.tab);
      return { ...state, unseenTabs: next };
    }
    case "activate": {
      const next = new Set(state.unseenTabs);
      next.delete(action.tab);
      return { activeTab: action.tab, unseenTabs: next };
    }
    case "force-active":
      return { ...state, activeTab: action.tab };
    default:
      return state;
  }
}

export function useArtifactUpdates(
  activeTabId: string,
  isCollapsed: boolean,
  showDebug: boolean,
) {
  const todos = useAgentTodos(activeTabId);
  const reviewEdits = useAgentReviewEdits(activeTabId);
  const {
    inventory,
    loading: artifactInventoryLoading,
    error: artifactInventoryError,
    hasLoadedSuccessfully: artifactInventoryHasLoadedSuccessfully,
  } = useSessionArtifactInventory(activeTabId);

  const [{ activeTab, unseenTabs }, dispatch] = useReducer(
    artifactPaneUiReducer,
    {
      activeTab: "PLAN" as ArtifactTab,
      unseenTabs: new Set<ArtifactTab>(),
    },
  );

  const prevActiveTabId = useRef(activeTabId);
  const prevPlanVersion = useRef<number>(
    inventory.latestPlanGroup?.latest.version ?? 0,
  );
  const prevTodoSnapshot = useRef<string>(buildTodoSnapshot(todos));
  const prevReviewCount = useRef<number>(reviewEdits.length);
  const prevArtifactFingerprint = useRef<string>(inventory.fingerprint);
  const hasArtifactBaseline = useRef<boolean>(
    artifactInventoryHasLoadedSuccessfully,
  );

  useEffect(() => {
    if (prevActiveTabId.current === activeTabId) return;
    prevActiveTabId.current = activeTabId;
    prevPlanVersion.current = inventory.latestPlanGroup?.latest.version ?? 0;
    prevTodoSnapshot.current = buildTodoSnapshot(todos);
    prevReviewCount.current = reviewEdits.length;
    prevArtifactFingerprint.current = inventory.fingerprint;
    hasArtifactBaseline.current = artifactInventoryHasLoadedSuccessfully;
    dispatch({ type: "reset" });
  }, [
    activeTabId,
    artifactInventoryHasLoadedSuccessfully,
    inventory.fingerprint,
    inventory.latestPlanGroup,
    reviewEdits.length,
    todos,
  ]);

  useEffect(() => {
    const nextPlanVersion = inventory.latestPlanGroup?.latest.version ?? 0;
    if (nextPlanVersion === prevPlanVersion.current) return;
    prevPlanVersion.current = nextPlanVersion;
    if (activeTab !== "PLAN" || isCollapsed) {
      dispatch({ type: "mark-unseen", tab: "PLAN" });
    }
  }, [activeTab, inventory.latestPlanGroup, isCollapsed]);

  useEffect(() => {
    const nextTodoSnapshot = buildTodoSnapshot(todos);
    if (nextTodoSnapshot === prevTodoSnapshot.current) return;
    prevTodoSnapshot.current = nextTodoSnapshot;
    if (activeTab !== "TODO" || isCollapsed) {
      dispatch({ type: "mark-unseen", tab: "TODO" });
    }
  }, [activeTab, isCollapsed, todos]);

  useEffect(() => {
    if (reviewEdits.length === prevReviewCount.current) return;
    prevReviewCount.current = reviewEdits.length;
    if (activeTab !== "REVIEW" || isCollapsed) {
      dispatch({ type: "mark-unseen", tab: "REVIEW" });
    }
  }, [activeTab, isCollapsed, reviewEdits.length]);

  useEffect(() => {
    if (!artifactInventoryHasLoadedSuccessfully) return;

    if (!hasArtifactBaseline.current) {
      prevArtifactFingerprint.current = inventory.fingerprint;
      hasArtifactBaseline.current = true;
      return;
    }

    if (inventory.fingerprint === prevArtifactFingerprint.current) return;
    prevArtifactFingerprint.current = inventory.fingerprint;
    if (activeTab !== "ARTIFACTS" || isCollapsed) {
      dispatch({ type: "mark-unseen", tab: "ARTIFACTS" });
    }
  }, [
    activeTab,
    artifactInventoryHasLoadedSuccessfully,
    inventory.fingerprint,
    isCollapsed,
  ]);

  useEffect(() => {
    if (!showDebug && activeTab === "DEBUG") {
      dispatch({ type: "force-active", tab: "PLAN" });
    }
    if (!showDebug) dispatch({ type: "clear-unseen", tab: "DEBUG" });
  }, [activeTab, showDebug]);

  useEffect(() => {
    if (isCollapsed) return;
    dispatch({ type: "clear-unseen", tab: activeTab });
  }, [activeTab, isCollapsed]);

  const handleTabClick = (tab: ArtifactTab) => {
    dispatch({ type: "activate", tab });
  };

  return {
    activeTab,
    unseenTabs,
    handleTabClick,
    artifactInventory: inventory,
    artifactInventoryLoading,
    artifactInventoryError,
  };
}
