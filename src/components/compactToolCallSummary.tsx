import type { ReactNode } from "react";
import { getToolGatewayArtifactRef } from "@/agent/toolGateway";
import type { ToolCallDisplay } from "@/agent/types";
import { getExecCommandBadge } from "@/components/compactToolCallStatus";
import { getToolCallIcon, getToolCallLabel } from "@/components/toolDisplay";
import { cn } from "@/utils/cn";
import { Badge, StatusDot } from "@/components/ui";

const STATUS_DOT: Record<string, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  error: "error",
  denied: "error",
  awaiting_branch_release: "error",
  awaiting_setup_action: "error",
};

function truncateText(value: string, max = 56): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}...`;
}

function stringifyScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function normalizePath(path: unknown): string {
  if (typeof path !== "string" || path.trim().length === 0) return ".";
  return path;
}

function describeLineRange(range: unknown): string | null {
  if (!range || typeof range !== "object") return null;
  const r = range as Record<string, unknown>;
  const start = typeof r.startLine === "number" ? r.startLine : null;
  const end = typeof r.endLine === "number" ? r.endLine : null;
  if (start !== null && end !== null) return `L${start}-${end}`;
  if (start !== null) return `from L${start}`;
  if (end !== null) return `to L${end}`;
  return null;
}

function fallbackArgPreview(args: Record<string, unknown>): string | null {
  const keys = Object.keys(args);
  if (keys.length === 0) return null;

  const firstKey = keys[0];
  const firstValue = args[firstKey];

  if (typeof firstValue === "string") {
    return `${firstKey}: ${truncateText(firstValue)}`;
  }
  if (typeof firstValue === "number" || typeof firstValue === "boolean") {
    return `${firstKey}: ${String(firstValue)}`;
  }
  if (Array.isArray(firstValue)) {
    return `${firstKey}: ${firstValue.length} item${firstValue.length === 1 ? "" : "s"}`;
  }
  if (firstValue && typeof firstValue === "object") {
    return `${firstKey}: {...}`;
  }
  return firstKey;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function getGatewayPhaseDetails(
  tc: ToolCallDisplay,
): { label: string; description: string } | null {
  switch (tc.gatewayPhase) {
    case "summarizing":
      return {
        label: "Compacting",
        description: "Results are being summarized to save space.",
      };
    default:
      return null;
  }
}

export function buildCollapsedArgPreview(tc: ToolCallDisplay): string | null {
  const gatewayRef = getToolGatewayArtifactRef(tc.result);
  if (gatewayRef) {
    if (gatewayRef.summary) return truncateText(gatewayRef.summary, 64);
    return `${truncateText(gatewayRef.artifactId, 32)} (${formatBytes(gatewayRef.sizeBytes)})`;
  }

  const { tool, args } = tc;
  switch (tool) {
    case "workspace_listDir": {
      return `dir: ${normalizePath(args.path)}`;
    }
    case "workspace_stat": {
      return `path: ${normalizePath(args.path)}`;
    }
    case "workspace_readFile": {
      const path = normalizePath(args.path);
      const range = describeLineRange(args.range);
      return range ? `${path} (${range})` : path;
    }
    case "workspace_writeFile": {
      const path = normalizePath(args.path);
      const content = typeof args.content === "string" ? args.content : "";
      return `${path} (${content.length} chars)`;
    }
    case "workspace_editFile": {
      const path = normalizePath(args.path);
      const count = Array.isArray(args.changes) ? args.changes.length : 0;
      return `${path} (${count} change${count === 1 ? "" : "s"})`;
    }
    case "workspace_glob": {
      const patterns = Array.isArray(args.patterns)
        ? (args.patterns as unknown[]).map(stringifyScalar).filter(Boolean)
        : [];
      if (patterns.length === 0) return "patterns: none";
      if (patterns.length === 1) return `pattern: ${truncateText(patterns[0])}`;
      return `patterns: ${truncateText(patterns[0])} +${patterns.length - 1}`;
    }
    case "workspace_search": {
      const pattern =
        typeof args.pattern === "string" ? truncateText(args.pattern) : "";
      const root = normalizePath(args.rootDir);
      return pattern ? `/${pattern}/ in ${root}` : `in ${root}`;
    }
    case "exec_run": {
      const command = typeof args.command === "string" ? args.command : "";
      const argList = Array.isArray(args.args)
        ? (args.args as unknown[]).map(stringifyScalar).filter(Boolean)
        : [];
      const full = [command, ...argList].filter(Boolean).join(" ");
      return full ? truncateText(full, 64) : "command";
    }
    case "git_worktree_init": {
      const branch =
        typeof args.suggestedBranch === "string" ? args.suggestedBranch : "";
      return branch ? `branch: ${truncateText(branch)}` : "init worktree";
    }
    case "agent_artifact_create": {
      const kind = typeof args.kind === "string" ? args.kind : "artifact";
      const summary = typeof args.summary === "string" ? args.summary : "";
      return summary ? `${kind}: ${truncateText(summary)}` : kind;
    }
    case "agent_card_add": {
      const kind = typeof args.kind === "string" ? args.kind : "card";
      const title =
        typeof args.title === "string" ? truncateText(args.title, 28) : "";
      if (kind === "summary") {
        const markdown =
          typeof args.markdown === "string"
            ? truncateText(args.markdown.replace(/\s+/g, " "), 40)
            : "";
        if (title && markdown) return `${title} - ${markdown}`;
        if (title) return `${title} - summary`;
        return markdown || "summary card";
      }

      const artifactId =
        typeof args.artifactId === "string" ? args.artifactId : "artifact";
      const version =
        typeof args.version === "number" ? ` @v${args.version}` : " @latest";
      if (title) return `${title} - ${truncateText(artifactId, 28)}${version}`;
      return `${truncateText(artifactId, 36)}${version}`;
    }
    case "agent_artifact_version": {
      const artifactId =
        typeof args.artifactId === "string" ? args.artifactId : "artifact";
      return `${truncateText(artifactId, 44)} -> new version`;
    }
    case "agent_artifact_get": {
      const artifactId =
        typeof args.artifactId === "string" ? args.artifactId : "artifact";
      const version =
        typeof args.version === "number" ? `@v${args.version}` : "@latest";
      return `${truncateText(artifactId, 40)} ${version}`;
    }
    case "agent_artifact_list": {
      const kind = typeof args.kind === "string" ? args.kind : "any";
      return `kind: ${kind}`;
    }
    case "agent_tool_artifact_get": {
      const artifactId =
        typeof args.artifactId === "string" ? args.artifactId : "tool artifact";
      const range = describeLineRange(args.range);
      return range
        ? `${truncateText(artifactId, 28)} (${range})`
        : truncateText(artifactId, 36);
    }
    case "agent_tool_artifact_search": {
      const artifactId =
        typeof args.artifactId === "string" ? args.artifactId : "tool artifact";
      const pattern =
        typeof args.pattern === "string" ? truncateText(args.pattern, 24) : "";
      if (!pattern) return truncateText(artifactId, 36);
      return `${truncateText(artifactId, 20)} /${pattern}/`;
    }
    case "agent_todo_add": {
      const title = typeof args.title === "string" ? args.title : "";
      return title ? truncateText(title) : "add todo";
    }
    case "agent_todo_update": {
      const id = typeof args.id === "string" ? args.id : "";
      const patch =
        args.patch && typeof args.patch === "object"
          ? (args.patch as Record<string, unknown>)
          : null;
      const state =
        patch && typeof patch.state === "string" ? patch.state : null;
      const title =
        patch && typeof patch.title === "string"
          ? truncateText(patch.title, 36)
          : null;
      const completionNote =
        patch && typeof patch.completionNote === "string"
          ? truncateText(patch.completionNote, 24)
          : null;
      const update = [
        state ? `state:${state}` : null,
        title ? `title:${title}` : null,
        completionNote ? `done:${completionNote}` : null,
      ]
        .filter(Boolean)
        .join(" - ");
      if (id && update) return `${id} (${update})`;
      if (id) return id;
      return update || "update todo";
    }
    case "agent_todo_note_add": {
      const kind = typeof args.kind === "string" ? args.kind : "note";
      const text =
        typeof args.text === "string" ? truncateText(args.text, 32) : "";
      return text ? `${kind}: ${text}` : `add ${kind} note`;
    }
    case "agent_todo_list": {
      const status = typeof args.status === "string" ? args.status : "any";
      const limit =
        typeof args.limit === "number" ? `, limit ${args.limit}` : "";
      return `status: ${status}${limit}`;
    }
    case "agent_todo_remove": {
      const id = typeof args.id === "string" ? args.id : "";
      return id ? `id: ${id}` : "remove todo";
    }
    case "agent_title_set": {
      const title = typeof args.title === "string" ? args.title : "";
      return title ? truncateText(title) : "set title";
    }
    case "agent_title_get": {
      return "read tab title";
    }
    case "user_input": {
      const q =
        typeof args.question === "string"
          ? truncateText(args.question, 52)
          : "";
      const result =
        tc.result && typeof tc.result === "object"
          ? (tc.result as Record<string, unknown>)
          : null;
      const answer =
        typeof result?.answer === "string"
          ? truncateText(result.answer, 28)
          : null;
      const skipped = tc.status === "denied";
      if (q && answer) return `${q} -> "${answer}"`;
      if (q && skipped) return `${q} -> (skipped)`;
      return q || "question";
    }
    default: {
      return fallbackArgPreview(args);
    }
  }
}

export interface CompactToolCallSummaryRowProps {
  tc: ToolCallDisplay;
  expanded?: boolean;
  showExpandChevron?: boolean;
  showInspect?: boolean;
  showOpenLogs?: boolean;
  onActivate?: () => void;
  onInspect?: () => void;
  onOpenLogs?: () => void;
  trailingContent?: ReactNode;
  className?: string;
  iconOverride?: string;
  labelOverride?: string;
  argPreviewOverride?: string | null;
}

export function CompactToolCallSummaryRow({
  tc,
  expanded = false,
  showExpandChevron = false,
  showInspect = false,
  showOpenLogs = false,
  onActivate,
  onInspect,
  onOpenLogs,
  trailingContent,
  className,
  iconOverride,
  labelOverride,
  argPreviewOverride,
}: CompactToolCallSummaryRowProps) {
  const interactive = typeof onActivate === "function";
  const icon = iconOverride ?? getToolCallIcon(tc);
  const label = labelOverride ?? getToolCallLabel(tc);
  const dotStatus = STATUS_DOT[tc.status] ?? "pending";
  const statusDotVariant =
    dotStatus === "pending"
      ? "idle"
      : dotStatus === "running"
        ? "working"
        : dotStatus === "done"
          ? "done"
          : "error";
  const argPreview =
    argPreviewOverride === undefined
      ? buildCollapsedArgPreview(tc)
      : argPreviewOverride;
  const execBadge = getExecCommandBadge(tc);
  const gatewayPhase = getGatewayPhaseDetails(tc);

  return (
    <div
      className={cn(
        "inline-tool-summary",
        interactive && "inline-tool-summary--clickable",
        className,
      )}
      onClick={onActivate}
      role={interactive ? "button" : undefined}
    >
      <StatusDot
        status={statusDotVariant}
        className={cn("inline-tool-status", `inline-tool-status--${dotStatus}`)}
      />

      <span className="material-symbols-outlined text-base opacity-65 shrink-0">
        {icon}
      </span>
      {gatewayPhase && (
        <span
          className="chat-ctrl-info shrink-0"
          aria-label={gatewayPhase.label}
        >
          <span
            className="inline-tool-gateway-spinner"
            role="status"
            aria-hidden="true"
          />
          <span className="chat-ctrl-popover inline-tool-gateway-popover">
            <strong>{gatewayPhase.label}</strong>
            <br />
            {gatewayPhase.description}
          </span>
        </span>
      )}

      <div className="inline-tool-summary-main">
        <span
          className={cn(
            "inline-tool-label",
            tc.status === "denied" && "text-error",
          )}
        >
          {label}
          {tc.status === "denied" && (
            <span className="ml-1 opacity-80"> - DENIED</span>
          )}
        </span>
        {argPreview && (
          <span className="inline-tool-arg-preview" title={argPreview}>
            {argPreview}
          </span>
        )}
      </div>

      {execBadge && (
        <Badge
          variant={execBadge.variant}
          className="shrink-0"
          title={execBadge.title}
        >
          {execBadge.label}
        </Badge>
      )}

      {trailingContent}

      {showInspect && onInspect && (
        <button
          type="button"
          className="material-symbols-outlined text-muted opacity-45 shrink-0 text-sm cursor-pointer border-0 bg-transparent p-0"
          aria-label="Inspect tool call"
          title="Inspect tool call"
          onClick={(event) => {
            event.stopPropagation();
            onInspect();
          }}
        >
          frame_bug
        </button>
      )}

      {showOpenLogs && onOpenLogs && (
        <button
          type="button"
          className="material-symbols-outlined text-muted opacity-45 shrink-0 text-sm cursor-pointer border-0 bg-transparent p-0"
          aria-label="Open logs"
          title="Open logs"
          onClick={(event) => {
            event.stopPropagation();
            onOpenLogs();
          }}
        >
          timeline
        </button>
      )}

      {showExpandChevron && (
        <span
          className={cn(
            "material-symbols-outlined text-muted opacity-40 shrink-0 text-md transition-transform duration-150",
            expanded ? "rotate-180" : "rotate-0",
          )}
        >
          expand_more
        </span>
      )}
    </div>
  );
}
