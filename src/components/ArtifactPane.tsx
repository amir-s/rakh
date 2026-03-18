import { useEffect } from "react";
import { useTabs } from "@/contexts/TabsContext";
import {
  useAgentConfig,
  useAgentReviewEdits,
  useAgentShowDebug,
  useAgentTodos,
} from "@/agent/useAgents";
import { cn } from "@/utils/cn";
import ArtifactsPane from "./artifact-pane/ArtifactsPane";
import DebugPane from "./artifact-pane/DebugPane";
import PlanPane from "./artifact-pane/PlanPane";
import ReviewPane from "./artifact-pane/ReviewPane";
import TodoPane from "./artifact-pane/TodoPane";
import type {
  ArtifactContentEntry,
  ArtifactTab,
  SessionArtifactInventory,
} from "./artifact-pane/types";

export { useArtifactUpdates } from "./artifact-pane/useArtifactUpdates";

interface ArtifactPaneProps {
  onRefineEdit: (filePath: string) => void;
  onOpenLogs: () => void;
  onOpenFileReferenceError?: (details: unknown) => void;
  onCollapse?: () => void;
  activeTab: ArtifactTab;
  unseenTabs: Set<ArtifactTab>;
  onTabClick: (tab: ArtifactTab) => void;
  artifactInventory: SessionArtifactInventory;
  artifactInventoryLoading: boolean;
  artifactInventoryError: string | null;
  getArtifactContentEntry: (
    artifactId: string,
    version: number,
  ) => ArtifactContentEntry | undefined;
  ensureArtifactContent: (artifactId: string, version: number) => Promise<void>;
}

export default function ArtifactPane({
  onRefineEdit,
  onOpenLogs,
  onOpenFileReferenceError,
  onCollapse,
  activeTab,
  unseenTabs,
  onTabClick,
  artifactInventory,
  artifactInventoryLoading,
  artifactInventoryError,
  getArtifactContentEntry,
  ensureArtifactContent,
}: ArtifactPaneProps) {
  const { activeTabId } = useTabs();
  const todos = useAgentTodos(activeTabId);
  const reviewEdits = useAgentReviewEdits(activeTabId);
  const showDebug = useAgentShowDebug(activeTabId);
  const config = useAgentConfig(activeTabId);

  const todoDone = todos.filter((todo) => todo.state === "done").length;
  const visibleTabs: ArtifactTab[] = showDebug
    ? ["PLAN", "TODO", "REVIEW", "ARTIFACTS", "DEBUG"]
    : ["PLAN", "TODO", "REVIEW", "ARTIFACTS"];
  const effectiveActiveTab: ArtifactTab =
    !showDebug && activeTab === "DEBUG" ? "PLAN" : activeTab;

  useEffect(() => {
    const planGroup = artifactInventory.latestPlanGroup;
    if (!planGroup) return;
    void ensureArtifactContent(planGroup.artifactId, planGroup.latest.version);
  }, [artifactInventory.latestPlanGroup, ensureArtifactContent]);

  const planGroup = artifactInventory.latestPlanGroup;
  const planEntry = planGroup
    ? getArtifactContentEntry(planGroup.artifactId, planGroup.latest.version)
    : undefined;

  return (
    <section className="artifact-pane">
      <div className="artifact-tabs-bar">
        <div className="artifact-tabs-group">
          {visibleTabs.map((tab) => (
            <button
              key={tab}
              className={cn(
                "artifact-tab-btn",
                effectiveActiveTab === tab && "artifact-tab-btn--active",
              )}
              onClick={() => onTabClick(tab)}
            >
              {tab}
              {tab === "TODO" && todos.length > 0 ? (
                <span className="ml-2 text-xss opacity-70">
                  {todoDone}/{todos.length}
                </span>
              ) : null}
              {tab === "REVIEW" && reviewEdits.length > 0 ? (
                <span className="ml-2 text-xss opacity-70">
                  {reviewEdits.length}
                </span>
              ) : null}
              {tab === "ARTIFACTS" && artifactInventory.groups.length > 0 ? (
                <span className="ml-2 text-xss opacity-70">
                  {artifactInventory.groups.length}
                </span>
              ) : null}
              {unseenTabs.has(tab) ? (
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full bg-primary ml-1.5 shrink-0 animate-pulse"
                  aria-label="New updates"
                />
              ) : null}
            </button>
          ))}
        </div>
        {onCollapse ? (
          <button
            className="artifact-pane-collapse-btn"
            onClick={onCollapse}
            title="Collapse artifacts"
          >
            <svg
              width={13}
              height={13}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>
        ) : null}
      </div>

      <div className="artifact-tab-body">
        {effectiveActiveTab === "PLAN" ? (
          <PlanPane
            planGroup={planGroup}
            content={planEntry?.artifact?.content}
            cwd={config.cwd}
            onOpenFileReferenceError={onOpenFileReferenceError}
            loading={
              artifactInventoryLoading ||
              (planGroup != null && planEntry == null) ||
              planEntry?.status === "loading"
            }
            error={
              (planEntry?.status === "error" ? planEntry.error : undefined) ??
              artifactInventoryError ??
              undefined
            }
            ensurePlanContent={ensureArtifactContent}
          />
        ) : null}

        {effectiveActiveTab === "TODO" ? (
          <TodoPane sessionId={activeTabId} todos={todos} />
        ) : null}

        {effectiveActiveTab === "REVIEW" ? (
          <ReviewPane tabId={activeTabId} onRefineEdit={onRefineEdit} />
        ) : null}

        {effectiveActiveTab === "ARTIFACTS" ? (
          <ArtifactsPane
            inventory={artifactInventory}
            loading={artifactInventoryLoading}
            error={artifactInventoryError}
            cwd={config.cwd}
            onOpenFileReferenceError={onOpenFileReferenceError}
            getContentEntry={getArtifactContentEntry}
            ensureArtifactContent={ensureArtifactContent}
          />
        ) : null}

        {showDebug && effectiveActiveTab === "DEBUG" ? (
          <DebugPane tabId={activeTabId} onOpenLogs={onOpenLogs} />
        ) : null}
      </div>
    </section>
  );
}
