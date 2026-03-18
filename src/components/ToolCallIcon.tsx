import type { ToolCallDisplay } from "@/agent/types";
import { getToolCallIcon } from "@/components/toolDisplay";
import { cn } from "@/utils/cn";

type ToolCallIconContext = Pick<ToolCallDisplay, "tool" | "mcp" | "contextCompaction">;

type ToolCallCompactionState = "none" | "annotated" | "compacted";

function getToolCallCompactionState(tc: ToolCallIconContext): ToolCallCompactionState {
  if (!tc.contextCompaction) return "none";
  const inputCompacted = tc.contextCompaction.input?.status === "compacted";
  const outputCompacted = tc.contextCompaction.output?.status === "compacted";
  return inputCompacted || outputCompacted ? "compacted" : "annotated";
}

function getToolCallCompactionTitle(tc: ToolCallIconContext): string | null {
  const state = getToolCallCompactionState(tc);
  if (state === "none") return null;

  const inputCompacted = tc.contextCompaction?.input?.status === "compacted";
  const outputCompacted = tc.contextCompaction?.output?.status === "compacted";

  if (inputCompacted && outputCompacted) {
    return "Context compaction compacted the model-facing input and output.";
  }
  if (inputCompacted) {
    return "Context compaction compacted the model-facing input.";
  }
  if (outputCompacted) {
    return "Context compaction compacted the model-facing output.";
  }
  return "This tool call included context compaction metadata.";
}

interface ToolCallIconProps {
  toolCall: ToolCallIconContext;
  icon?: string;
  showCompactionFlare?: boolean;
  className?: string;
  iconClassName?: string;
  flareClassName?: string;
  title?: string;
}

export default function ToolCallIcon({
  toolCall,
  icon,
  showCompactionFlare = true,
  className,
  iconClassName,
  flareClassName,
  title,
}: ToolCallIconProps) {
  const resolvedIcon = icon ?? getToolCallIcon(toolCall);
  const compactionState = showCompactionFlare
    ? getToolCallCompactionState(toolCall)
    : "none";
  const flareTitle = getToolCallCompactionTitle(toolCall);

  return (
    <span
      className={cn(
        "tool-call-icon",
        compactionState !== "none" && `tool-call-icon--${compactionState}`,
        className,
      )}
      data-context-compaction-state={
        compactionState === "none" ? undefined : compactionState
      }
      title={title}
    >
      <span className={cn("material-symbols-outlined", iconClassName)}>
        {resolvedIcon}
      </span>
      {compactionState !== "none" ? (
        <span
          className={cn(
            "material-symbols-outlined tool-call-icon__flare",
            flareClassName,
          )}
          title={flareTitle ?? undefined}
          aria-hidden="true"
        >
          flare
        </span>
      ) : null}
    </span>
  );
}
