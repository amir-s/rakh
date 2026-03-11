import { useState } from "react";
import type { ToolCallDisplay } from "@/agent/types";
import CompactToolCall from "@/components/CompactToolCall";
import { CompactToolCallSummaryRow } from "@/components/compactToolCallSummary";
import { getToolCallIcon, getToolCallLabel } from "@/components/toolDisplay";
import { cn } from "@/utils/cn";
import { Badge } from "@/components/ui";

interface GroupedInlineToolCallProps {
  toolCalls: ToolCallDisplay[];
  onInspect: (toolCall: ToolCallDisplay) => void;
  cwd?: string;
  showDebug: boolean;
}

export default function GroupedInlineToolCall({
  toolCalls,
  onInspect,
  cwd,
  showDebug,
}: GroupedInlineToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const latestToolCall = toolCalls[toolCalls.length - 1];
  const uniqueToolTypes = toolCalls.filter((toolCall, index, allToolCalls) => {
    const typeKey = toolCall.mcp
      ? `mcp:${toolCall.mcp.serverId}:${toolCall.mcp.toolName}`
      : toolCall.tool;
    return (
      allToolCalls.findIndex((candidate) => {
        const candidateKey = candidate.mcp
          ? `mcp:${candidate.mcp.serverId}:${candidate.mcp.toolName}`
          : candidate.tool;
        return candidateKey === typeKey;
      }) === index
    );
  });

  if (!latestToolCall) return null;

  return (
    <div className="inline-tool-group">
      <CompactToolCallSummaryRow
        tc={latestToolCall}
        expanded={expanded}
        showExpandChevron
        onActivate={() => setExpanded((current) => !current)}
        trailingContent={
          <div className="inline-tool-group__summary-trailing">
            <div
              className="inline-tool-group__icon-strip"
              aria-label={`${uniqueToolTypes.length} unique inline tool types`}
            >
              {uniqueToolTypes.map((toolCall) => (
                <span
                  key={toolCall.mcp ? `${toolCall.mcp.serverId}:${toolCall.mcp.toolName}` : toolCall.tool}
                  className="material-symbols-outlined inline-tool-group__icon"
                  title={getToolCallLabel(toolCall)}
                >
                  {getToolCallIcon(toolCall)}
                </span>
              ))}
            </div>
            <Badge variant="muted" className="shrink-0">
              {toolCalls.length}
            </Badge>
          </div>
        }
      />

      <div
        className={cn(
          "inline-tool-group__body",
          expanded && "inline-tool-group__body--expanded",
        )}
        style={{ maxHeight: expanded ? "640px" : "0px" }}
      >
        <div className="inline-tool-group__body-inner">
          {toolCalls.map((toolCall) => (
            <CompactToolCall
              key={toolCall.id}
              tc={toolCall}
              onInspect={() => onInspect(toolCall)}
              cwd={cwd}
              showDebug={showDebug}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
