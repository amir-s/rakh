import { useMemo } from "react";
import DiffViewer from "@/components/DiffViewer";
import { deserializeDiff } from "@/components/diffSerialization";
import { patchAgentState } from "@/agent/atoms";
import { useAgentReviewEdits } from "@/agent/useAgents";
import PaneEmptyState from "./PaneEmptyState";

interface ReviewPaneProps {
  tabId: string;
  onRefineEdit: (filePath: string) => void;
}

export default function ReviewPane({ tabId, onRefineEdit }: ReviewPaneProps) {
  const reviewEdits = useAgentReviewEdits(tabId);
  const diffFiles = useMemo(
    () => reviewEdits.map((edit) => deserializeDiff(edit.diffFile)),
    [reviewEdits],
  );

  if (reviewEdits.length === 0) {
    return (
      <PaneEmptyState message="No edits yet — file changes made by the agent will appear here for review." />
    );
  }

  const handleAccept = (filePath: string) => {
    patchAgentState(tabId, (prev) => ({
      ...prev,
      reviewEdits: prev.reviewEdits.filter((edit) => edit.filePath !== filePath),
    }));
  };

  return (
    <div className="artifact-tab-content">
      <DiffViewer
        files={diffFiles}
        onAccept={handleAccept}
        onRefine={onRefineEdit}
      />
    </div>
  );
}
