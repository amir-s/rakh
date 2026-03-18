import { useEffect } from "react";
import Markdown from "@/components/Markdown";
import type { SessionArtifactGroup } from "./types";
import PaneEmptyState from "./PaneEmptyState";

interface PlanPaneProps {
  planGroup: SessionArtifactGroup | null;
  content?: string;
  loading: boolean;
  error?: string;
  cwd?: string;
  onOpenFileReferenceError?: (details: unknown) => void;
  ensurePlanContent: (artifactId: string, version: number) => Promise<void>;
}

export default function PlanPane({
  planGroup,
  content,
  loading,
  error,
  cwd,
  onOpenFileReferenceError,
  ensurePlanContent,
}: PlanPaneProps) {
  useEffect(() => {
    if (!planGroup) return;
    void ensurePlanContent(planGroup.artifactId, planGroup.latest.version);
  }, [ensurePlanContent, planGroup]);

  if (!planGroup) {
    if (loading) {
      return (
        <div className="artifact-tab-content plan-content">
          <p className="artifact-loading-copy">Loading plan artifact…</p>
        </div>
      );
    }
    return (
      <PaneEmptyState message="No plan yet — the planner agent will create one when it runs." />
    );
  }

  return (
    <div className="artifact-tab-content plan-content">
      <div className="plan-section-label">
        PLAN · v{planGroup.latest.version}
        {planGroup.latest.summary ? ` · ${planGroup.latest.summary}` : ""} · updated{" "}
        {new Date(planGroup.latest.createdAt).toLocaleTimeString()}
      </div>

      {loading ? (
        <p className="artifact-loading-copy">Loading plan artifact…</p>
      ) : error ? (
        <p className="artifact-inline-error">{error}</p>
      ) : content ? (
        <div className="artifact-markdown text-sm leading-[1.8] text-[color-mix(in_srgb,var(--color-text)_85%,transparent)]">
          <Markdown cwd={cwd} onOpenFileReferenceError={onOpenFileReferenceError}>
            {content}
          </Markdown>
        </div>
      ) : (
        <p className="artifact-empty-copy">Plan artifact content is empty.</p>
      )}
    </div>
  );
}
