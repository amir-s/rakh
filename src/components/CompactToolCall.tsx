/* ─────────────────────────────────────────────────────────────────────────────
   CompactToolCall — rendered for tool calls that are past the approval stage.
   Every compact tool row supports inline expand/collapse. Known tools use
   dedicated previews; others fall back to a generic args/result inspector.
───────────────────────────────────────────────────────────────────────────── */

import { useState, useEffect, useRef } from "react";
import PatchPreview from "@/components/PatchPreview";
import type { ToolCallDisplay } from "@/agent/types";
import {
  buildEditFileDiffFiles,
  buildWriteFileDiffFiles,
} from "@/components/patchDiffFiles";
import { getExecCommandBadge } from "@/components/compactToolCallStatus";
import { deserializeDiff } from "@/components/diffSerialization";
import type { EditFileChange } from "@/agent/tools/workspace";
import { getToolCallIcon, getToolCallLabel } from "@/components/toolDisplay";
import { cn } from "@/utils/cn";
import { Badge, StatusDot } from "@/components/ui";

/* ── Tools with dedicated inline previews ─────────────────────────────────── */
const CUSTOM_EXPANDED_TOOLS = new Set([
  "workspace_listDir",
  "workspace_stat",
  "workspace_readFile",
  "workspace_glob",
  "git_worktree_init",
  "workspace_editFile",
  "workspace_writeFile",
  "exec_run",
  "workspace_search",
  "user_input",
]);

const NON_EXPANDABLE_TOOLS = new Set([
  "agent_title_set",
  "agent_card_add",
  "agent_artifact_create",
  "agent_artifact_version",
  "agent_artifact_get",
  "agent_artifact_list",
  "agent_todo_add",
  "agent_todo_update",
  "agent_todo_list",
  "agent_todo_remove",
]);

const STATUS_DOT: Record<string, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  error: "error",
  denied: "error",
  awaiting_setup_action: "error",
};

function truncateText(value: string, max = 56): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
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
    return `${firstKey}: {…}`;
  }
  return firstKey;
}

function buildCollapsedArgPreview(tc: ToolCallDisplay): string | null {
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
    case "agent_artifact_version": {
      const artifactId =
        typeof args.artifactId === "string" ? args.artifactId : "artifact";
      return `${truncateText(artifactId, 44)} → new version`;
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
    case "agent_todo_add": {
      const text = typeof args.text === "string" ? args.text : "";
      return text ? truncateText(text) : "add todo";
    }
    case "agent_todo_update": {
      const id = typeof args.id === "string" ? args.id : "";
      const patch =
        args.patch && typeof args.patch === "object"
          ? (args.patch as Record<string, unknown>)
          : null;
      const status =
        patch && typeof patch.status === "string" ? patch.status : null;
      const text =
        patch && typeof patch.text === "string"
          ? truncateText(patch.text, 36)
          : null;
      const update = [
        status ? `status:${status}` : null,
        text ? `text:${text}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      if (id && update) return `${id} (${update})`;
      if (id) return id;
      return update || "update todo";
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
    case "agent_card_add": {
      const kind = typeof args.kind === "string" ? args.kind : "card";
      const title = typeof args.title === "string" ? truncateText(args.title, 28) : "";
      if (kind === "summary") {
        const markdown =
          typeof args.markdown === "string"
            ? truncateText(args.markdown.replace(/\s+/g, " "), 40)
            : "";
        if (title && markdown) return `${title} · ${markdown}`;
        if (title) return `${title} · summary`;
        return markdown || "summary card";
      }

      const artifactId =
        typeof args.artifactId === "string" ? args.artifactId : "artifact";
      const version =
        typeof args.version === "number" ? ` @v${args.version}` : " @latest";
      if (title) return `${title} · ${truncateText(artifactId, 28)}${version}`;
      return `${truncateText(artifactId, 36)}${version}`;
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
      if (q && answer) return `${q} → "${answer}"`;
      if (q && skipped) return `${q} → (skipped)`;
      return q || "question";
    }
    default:
      return fallbackArgPreview(args);
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
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

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(ms);
  return date.toLocaleString();
}

function ExpandedListDir({ tc }: { tc: ToolCallDisplay }) {
  const args = tc.args;
  const requestedPath = normalizePath(args.path);
  const includeHidden = args.includeHidden === true;
  const maxEntries =
    typeof args.maxEntries === "number" ? args.maxEntries : 200;

  const resultRecord =
    tc.result && typeof tc.result === "object"
      ? (tc.result as Record<string, unknown>)
      : null;
  const outputPath =
    typeof resultRecord?.path === "string" ? resultRecord.path : requestedPath;
  const truncated = resultRecord?.truncated === true;
  const errorMessage =
    tc.status === "error" && typeof resultRecord?.message === "string"
      ? resultRecord.message
      : null;

  const rawEntries = Array.isArray(resultRecord?.entries)
    ? (resultRecord.entries as unknown[])
    : [];
  const entries = rawEntries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const rec = entry as Record<string, unknown>;
      const kind = typeof rec.kind === "string" ? rec.kind : "file";
      const name =
        typeof rec.name === "string"
          ? rec.name
          : typeof rec.path === "string"
            ? rec.path
            : null;
      if (!name) return null;
      const sizeBytes =
        typeof rec.sizeBytes === "number" ? rec.sizeBytes : null;
      return { kind, name, sizeBytes };
    })
    .filter(
      (
        entry,
      ): entry is { kind: string; name: string; sizeBytes: number | null } =>
        Boolean(entry),
    );

  const dirCount = entries.filter((e) => e.kind === "dir").length;
  const fileCount = entries.filter((e) => e.kind === "file").length;
  const symlinkCount = entries.filter((e) => e.kind === "symlink").length;

  return (
    <div className="cmd-block mt-1 border border-border-subtle rounded-[6px] bg-inset">
      <div className="text-xs text-text leading-[1.55]">
        Listing directory:{" "}
        <span className="font-mono text-[#6a9fb5]">&lt;{outputPath}&gt;</span>
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Including hidden: {includeHidden ? "yes" : "no"}
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Max entries: {maxEntries}
      </div>

      {tc.status === "running" && (
        <div className="text-xxs text-muted mt-1">Listing...</div>
      )}

      {errorMessage && (
        <pre className="cmd-output cmd-output--error mt-1">{errorMessage}</pre>
      )}

      {!errorMessage && tc.status !== "running" && (
        <>
          <div className="text-xxs text-muted mt-1">
            Found {entries.length} entr{entries.length === 1 ? "y" : "ies"}
            {entries.length > 0 &&
              ` (${dirCount} dir${dirCount === 1 ? "" : "s"}, ${fileCount} file${fileCount === 1 ? "" : "s"}, ${symlinkCount} symlink${symlinkCount === 1 ? "" : "s"})`}
            {truncated ? " · truncated" : ""}
          </div>

          {entries.length > 0 ? (
            <pre className="cmd-output">
              {entries
                .map((entry, idx) => {
                  const suffix =
                    entry.kind === "file" && entry.sizeBytes !== null
                      ? ` (${formatBytes(entry.sizeBytes)})`
                      : "";
                  const name =
                    entry.kind === "dir" && !entry.name.endsWith("/")
                      ? `${entry.name}/`
                      : entry.name;
                  return `${idx + 1}. [${entry.kind}] ${name}${suffix}`;
                })
                .join("\n")}
            </pre>
          ) : (
            <div className="text-xxs text-muted mt-1">No entries.</div>
          )}
        </>
      )}
    </div>
  );
}

function ExpandedStatFile({ tc }: { tc: ToolCallDisplay }) {
  const args = tc.args;
  const requestedPath = normalizePath(args.path);

  const resultRecord =
    tc.result && typeof tc.result === "object"
      ? (tc.result as Record<string, unknown>)
      : null;
  const outputPath =
    typeof resultRecord?.path === "string" ? resultRecord.path : requestedPath;

  const exists =
    typeof resultRecord?.exists === "boolean" ? resultRecord.exists : null;
  const kind =
    typeof resultRecord?.kind === "string" ? resultRecord.kind : null;
  const sizeBytes =
    typeof resultRecord?.sizeBytes === "number" ? resultRecord.sizeBytes : null;
  const mtimeMs =
    typeof resultRecord?.mtimeMs === "number" ? resultRecord.mtimeMs : null;

  const errorMessage =
    tc.status === "error" && typeof resultRecord?.message === "string"
      ? resultRecord.message
      : null;

  return (
    <div className="cmd-block mt-1 border border-border-subtle rounded-[6px] bg-inset">
      <div className="text-xs text-text leading-[1.55]">
        Stat for:{" "}
        <span className="font-mono text-[#6a9fb5]">&lt;{outputPath}&gt;</span>
      </div>

      {tc.status === "running" && (
        <div className="text-xxs text-muted mt-1">Checking...</div>
      )}

      {errorMessage && (
        <pre className="cmd-output cmd-output--error mt-1">{errorMessage}</pre>
      )}

      {!errorMessage && tc.status !== "running" && (
        <>
          {exists === false && (
            <div className="text-xxs text-muted mt-1">File does not exist.</div>
          )}

          {exists === true && (
            <div className="text-xxs text-muted mt-1 leading-[1.55]">
              <div>Exists: yes</div>
              <div>Type: {kind ?? "unknown"}</div>
              {sizeBytes !== null && <div>Size: {formatBytes(sizeBytes)}</div>}
              {mtimeMs !== null && (
                <div>Modified: {formatTimestamp(mtimeMs)}</div>
              )}
            </div>
          )}

          {exists === null && (
            <div className="text-xxs text-muted mt-1">No stat data.</div>
          )}
        </>
      )}
    </div>
  );
}

function ExpandedReadFile({ tc }: { tc: ToolCallDisplay }) {
  const args = tc.args;
  const requestedPath = normalizePath(args.path);
  const requestedRange = describeLineRange(args.range);
  const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : 200_000;

  const resultRecord =
    tc.result && typeof tc.result === "object"
      ? (tc.result as Record<string, unknown>)
      : null;
  const outputPath =
    typeof resultRecord?.path === "string" ? resultRecord.path : requestedPath;
  const encoding =
    typeof resultRecord?.encoding === "string" ? resultRecord.encoding : null;
  const content =
    typeof resultRecord?.content === "string" ? resultRecord.content : null;
  const fileSizeBytes =
    typeof resultRecord?.fileSizeBytes === "number"
      ? resultRecord.fileSizeBytes
      : null;
  const lineCount =
    typeof resultRecord?.lineCount === "number" ? resultRecord.lineCount : null;
  const truncated = resultRecord?.truncated === true;

  const resultRange =
    resultRecord?.range && typeof resultRecord.range === "object"
      ? describeLineRange(resultRecord.range)
      : null;

  const errorMessage =
    tc.status === "error" && typeof resultRecord?.message === "string"
      ? resultRecord.message
      : null;

  return (
    <div className="cmd-block mt-1 border border-border-subtle rounded-[6px] bg-inset">
      <div className="text-xs text-text leading-[1.55]">
        Reading file:{" "}
        <span className="font-mono text-[#6a9fb5]">&lt;{outputPath}&gt;</span>
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Range: {resultRange ?? requestedRange ?? "full file"}
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Max bytes: {maxBytes}
      </div>

      {tc.status === "running" && (
        <div className="text-xxs text-muted mt-1">Reading...</div>
      )}

      {errorMessage && (
        <pre className="cmd-output cmd-output--error mt-1">{errorMessage}</pre>
      )}

      {!errorMessage && tc.status !== "running" && (
        <>
          <div className="text-xxs text-muted mt-1">
            {encoding && `Encoding: ${encoding}`}
            {fileSizeBytes !== null &&
              `${encoding ? " · " : ""}Size: ${formatBytes(fileSizeBytes)}`}
            {lineCount !== null &&
              `${encoding || fileSizeBytes !== null ? " · " : ""}Lines: ${lineCount}`}
            {truncated ? " · truncated" : ""}
          </div>

          {content !== null ? (
            content.length > 0 ? (
              <pre className="cmd-output">{content}</pre>
            ) : (
              <div className="text-xxs text-muted mt-1">File is empty.</div>
            )
          ) : (
            <div className="text-xxs text-muted mt-1">No content returned.</div>
          )}
        </>
      )}
    </div>
  );
}

function ExpandedGlob({ tc }: { tc: ToolCallDisplay }) {
  const args = tc.args;
  const rootDir = normalizePath(args.cwd);
  const maxMatches =
    typeof args.maxMatches === "number" ? args.maxMatches : 2000;
  const includeDirs = args.includeDirs === true;
  const includeHidden = args.includeHidden === true;

  const patterns = Array.isArray(args.patterns)
    ? (args.patterns as unknown[])
        .filter((v): v is string => typeof v === "string")
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    : [];
  const includePatterns = patterns.filter((p) => !p.startsWith("!"));
  const excludePatterns = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => p.slice(1))
    .filter((p) => p.length > 0);

  const resultRecord =
    tc.result && typeof tc.result === "object"
      ? (tc.result as Record<string, unknown>)
      : null;
  const rawMatches = Array.isArray(resultRecord?.matches)
    ? (resultRecord.matches as unknown[])
    : [];
  const matches = rawMatches.filter((m): m is string => typeof m === "string");
  const truncated = resultRecord?.truncated === true;

  const errorMessage =
    tc.status === "error" && typeof resultRecord?.message === "string"
      ? resultRecord.message
      : null;

  return (
    <div className="cmd-block mt-1 border border-border-subtle rounded-[6px] bg-inset">
      <div className="text-xs text-text leading-[1.55]">
        Matching glob patterns in{" "}
        <span className="font-mono text-[#6a9fb5]">&lt;{rootDir}&gt;</span>
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Including:{" "}
        {includePatterns.length > 0 ? includePatterns.join(", ") : "none"}
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Excluding:{" "}
        {excludePatterns.length > 0 ? excludePatterns.join(", ") : "none"}
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Include directories: {includeDirs ? "yes" : "no"} · Hidden:{" "}
        {includeHidden ? "yes" : "no"} · Max matches: {maxMatches}
      </div>

      {tc.status === "running" && (
        <div className="text-xxs text-muted mt-1">Globbing...</div>
      )}

      {errorMessage && (
        <pre className="cmd-output cmd-output--error mt-1">{errorMessage}</pre>
      )}

      {!errorMessage && tc.status !== "running" && (
        <>
          <div className="text-xxs text-muted mt-1">
            Found {matches.length} match{matches.length === 1 ? "" : "es"}
            {truncated ? " · truncated" : ""}
          </div>
          {matches.length > 0 ? (
            <pre className="cmd-output">
              {matches.map((m, idx) => `${idx + 1}. ${m}`).join("\n")}
            </pre>
          ) : (
            <div className="text-xxs text-muted mt-1">No matches.</div>
          )}
        </>
      )}
    </div>
  );
}

function ExpandedGitWorktree({ tc }: { tc: ToolCallDisplay }) {
  const args = tc.args;
  const suggestedBranch =
    typeof args.suggestedBranch === "string" ? args.suggestedBranch : "";
  const setupCommand =
    typeof args.setupCommand === "string" ? args.setupCommand.trim() : "";

  const resultRecord =
    tc.result && typeof tc.result === "object"
      ? (tc.result as Record<string, unknown>)
      : null;

  const branch =
    typeof resultRecord?.branch === "string" ? resultRecord.branch : null;
  const path =
    typeof resultRecord?.path === "string" ? resultRecord.path : null;
  const alreadyExists = resultRecord?.alreadyExists === true;
  const declined = resultRecord?.declined === true;
  const setup =
    resultRecord?.setup && typeof resultRecord.setup === "object"
      ? (resultRecord.setup as Record<string, unknown>)
      : resultRecord?.details &&
          typeof resultRecord.details === "object" &&
          (resultRecord.details as Record<string, unknown>).setup &&
          typeof (resultRecord.details as Record<string, unknown>).setup === "object"
        ? ((resultRecord.details as Record<string, unknown>)
            .setup as Record<string, unknown>)
        : null;
  const setupStatus =
    typeof setup?.status === "string" ? setup.status : null;
  const setupStdout =
    typeof setup?.stdout === "string" ? setup.stdout.trimEnd() : "";
  const setupStderr =
    typeof setup?.stderr === "string" ? setup.stderr.trimEnd() : "";
  const setupErrorMessage =
    typeof setup?.errorMessage === "string" ? setup.errorMessage : null;
  const setupAttemptCount =
    typeof setup?.attemptCount === "number" ? setup.attemptCount : null;
  const setupExitCode =
    typeof setup?.exitCode === "number" ? setup.exitCode : null;

  const errorMessage =
    tc.status === "error" && typeof resultRecord?.message === "string"
      ? resultRecord.message
      : null;

  return (
    <div className="cmd-block mt-1 border border-border-subtle rounded-[6px] bg-inset">
      <div className="text-xs text-text leading-[1.55]">
        Initializing git worktree
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Suggested branch:{" "}
        <span className="font-mono">{suggestedBranch || "(not provided)"}</span>
      </div>
      {setupCommand ? (
        <div className="text-xxs text-muted leading-[1.55] mt-1">
          Setup: <span className="font-mono">{setupCommand}</span>
        </div>
      ) : null}

      {tc.status === "running" && (
        <div className="text-xxs text-muted mt-1">Preparing worktree...</div>
      )}

      {errorMessage && (
        <pre className="cmd-output cmd-output--error mt-1">{errorMessage}</pre>
      )}

      {!errorMessage && tc.status !== "running" && (
        <div className="text-xxs text-muted mt-1 leading-[1.55]">
          {declined && <div>Status: declined by user</div>}
          {alreadyExists && <div>Status: already initialized</div>}
          {!declined && !alreadyExists && <div>Status: initialized</div>}
          {branch && (
            <div>
              Branch: <span className="font-mono">{branch}</span>
            </div>
          )}
          {path && (
            <div>
              Path: <span className="font-mono break-all">{path}</span>
            </div>
          )}
          {setupStatus === "not_configured" && <div>Setup: not configured</div>}
          {setupStatus === "success" && <div>Setup: completed</div>}
          {setupStatus === "failed_continued" && (
            <div>Setup: failed, continued anyway</div>
          )}
          {setupAttemptCount ? <div>Setup attempts: {setupAttemptCount}</div> : null}
          {setupExitCode !== null ? <div>Setup exit code: {setupExitCode}</div> : null}
          {setupErrorMessage ? <div>Setup note: {setupErrorMessage}</div> : null}
          {!declined && !path && !branch && !alreadyExists && (
            <div>No worktree data returned.</div>
          )}
        </div>
      )}

      {setupStdout ? <pre className="cmd-output mt-1">{setupStdout}</pre> : null}
      {setupStderr ? (
        <pre className="cmd-output cmd-output--error mt-1">{setupStderr}</pre>
      ) : null}
    </div>
  );
}

/* ── Expanded content: editFile diff ──────────────────────────────────────────────────────────────────────────────── */
function ExpandedEditFile({ tc, cwd }: { tc: ToolCallDisplay; cwd?: string }) {
  const path = typeof tc.args.path === "string" ? tc.args.path : null;
  const changes = Array.isArray(tc.args.changes)
    ? (tc.args.changes as EditFileChange[])
    : null;
  const [files, setFiles] = useState<
    Awaited<ReturnType<typeof buildEditFileDiffFiles>>
  >(tc.originalDiffFiles?.map(deserializeDiff) ?? null);

  useEffect(() => {
    if (tc.originalDiffFiles) return;
    if (!path || !changes) return;
    let cancelled = false;
    buildEditFileDiffFiles(path, changes, cwd).then((next) => {
      if (!cancelled) setFiles(next);
    });
    return () => {
      cancelled = true;
    };
  }, [tc.originalDiffFiles, path, changes, cwd]);

  if (!path || !files || files.length === 0) return null;

  return (
    <div className="mt-1">
      <PatchPreview files={files} />
    </div>
  );
}

/* ── Expanded content: writeFile diff ──────────────────────────────────────────────────────────────────────────────── */
function ExpandedWriteFile({ tc, cwd }: { tc: ToolCallDisplay; cwd?: string }) {
  const path = typeof tc.args.path === "string" ? tc.args.path : null;
  const content = typeof tc.args.content === "string" ? tc.args.content : "";
  const overwrite = tc.args.overwrite === true;
  const [files, setFiles] = useState<
    Awaited<ReturnType<typeof buildWriteFileDiffFiles>>
  >(tc.originalDiffFiles?.map(deserializeDiff) ?? null);

  useEffect(() => {
    if (tc.originalDiffFiles) return;
    if (!path) return;
    let cancelled = false;
    buildWriteFileDiffFiles(path, content, overwrite, cwd).then((next) => {
      if (!cancelled) setFiles(next);
    });
    return () => {
      cancelled = true;
    };
  }, [tc.originalDiffFiles, path, content, overwrite, cwd]);

  if (!path || !files || files.length === 0) return null;

  return (
    <div className="mt-1">
      <PatchPreview files={files} />
    </div>
  );
}

/* ── Expanded content: search query + findings ─────────────────────────────── */
function ExpandedSearch({ tc }: { tc: ToolCallDisplay }) {
  const args = tc.args;
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  const rootDir = normalizePath(args.rootDir);
  const includeGlobs = Array.isArray(args.includeGlobs)
    ? (args.includeGlobs as unknown[])
        .filter((v): v is string => typeof v === "string")
        .filter((v) => v.trim().length > 0)
    : [];
  const excludeGlobs = Array.isArray(args.excludeGlobs)
    ? (args.excludeGlobs as unknown[])
        .filter((v): v is string => typeof v === "string")
        .filter((v) => v.trim().length > 0)
    : [];
  const caseSensitive = args.caseSensitive === true;

  const resultRecord =
    tc.result && typeof tc.result === "object"
      ? (tc.result as Record<string, unknown>)
      : null;

  const rawMatches = Array.isArray(resultRecord?.matches)
    ? (resultRecord.matches as unknown[])
    : [];

  const findings = rawMatches
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const rec = m as Record<string, unknown>;
      const path = typeof rec.path === "string" ? rec.path : null;
      const lineNumber =
        typeof rec.lineNumber === "number" ? rec.lineNumber : null;
      const line = typeof rec.line === "string" ? rec.line : "";
      if (!path || lineNumber === null) return null;
      return { path, lineNumber, line };
    })
    .filter((m): m is { path: string; lineNumber: number; line: string } =>
      Boolean(m),
    );

  const matchCount =
    typeof resultRecord?.matchCount === "number"
      ? resultRecord.matchCount
      : findings.length;
  const searchedFiles =
    typeof resultRecord?.searchedFiles === "number"
      ? resultRecord.searchedFiles
      : null;
  const truncated = resultRecord?.truncated === true;
  const uniqueFileCount = new Set(findings.map((m) => m.path)).size;
  const errorMessage =
    tc.status === "error" && typeof resultRecord?.message === "string"
      ? resultRecord.message
      : null;

  return (
    <div className="cmd-block mt-1 border border-border-subtle rounded-[6px] bg-inset">
      <div className="text-xs text-text leading-[1.55]">
        Searching for pattern:{" "}
        <span className="font-mono bg-surface border border-border-subtle rounded px-1">
          `{pattern || "(empty pattern)"}`
        </span>{" "}
        in <span className="font-mono text-[#6a9fb5]">&lt;{rootDir}&gt;</span>
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Including:{" "}
        {includeGlobs.length > 0 ? includeGlobs.join(", ") : "all files"}
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Excluding: {excludeGlobs.length > 0 ? excludeGlobs.join(", ") : "none"}
      </div>
      <div className="text-xxs text-muted leading-[1.55]">
        Case: {caseSensitive ? "sensitive" : "insensitive"}
      </div>

      {tc.status === "running" && (
        <div className="text-xxs text-muted mt-1">Searching...</div>
      )}

      {errorMessage && (
        <pre className="cmd-output cmd-output--error mt-1">{errorMessage}</pre>
      )}

      {!errorMessage && tc.status !== "running" && (
        <>
          <div className="text-xxs text-muted mt-1">
            Findings: {matchCount} match{matchCount === 1 ? "" : "es"}
            {uniqueFileCount > 0 &&
              ` in ${uniqueFileCount} file${uniqueFileCount === 1 ? "" : "s"}`}
            {searchedFiles !== null &&
              ` (searched ${searchedFiles} file${searchedFiles === 1 ? "" : "s"})`}
            {truncated ? " · truncated" : ""}
          </div>

          {findings.length > 0 ? (
            <pre className="cmd-output">
              {findings
                .map((m, idx) => {
                  const line = m.line.trim() || "(blank line)";
                  return `${idx + 1}. ${m.path}:${m.lineNumber}\n   ${line}`;
                })
                .join("\n\n")}
            </pre>
          ) : (
            <div className="text-xxs text-muted mt-1">No findings.</div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Expanded content: command block ──────────────────────────────────────────────── */
function ExpandedCommand({
  args,
  result,
  streamingOutput,
  isRunning,
}: {
  args: Record<string, unknown>;
  result?: unknown;
  streamingOutput?: string;
  isRunning?: boolean;
}) {
  const cmd = typeof args.command === "string" ? args.command : "";
  const argsList = Array.isArray(args.args) ? (args.args as string[]) : [];
  const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
  const reason = typeof args.reason === "string" ? args.reason : undefined;
  const fullCommand = [cmd, ...argsList].filter(Boolean).join(" ");

  const res =
    result !== null && typeof result === "object"
      ? (result as Record<string, unknown>)
      : null;
  const stdout = typeof res?.stdout === "string" ? res.stdout.trimEnd() : "";
  const stderr = typeof res?.stderr === "string" ? res.stderr.trimEnd() : "";
  const exitCode = typeof res?.exitCode === "number" ? res.exitCode : null;
  const truncatedStdout = res?.truncatedStdout === true;
  const truncatedStderr = res?.truncatedStderr === true;
  const failed = exitCode !== null && exitCode !== 0;

  const streamingRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (isRunning && streamingRef.current) {
      streamingRef.current.scrollTop = streamingRef.current.scrollHeight;
    }
  }, [isRunning, streamingOutput]);

  return (
    <div className="cmd-block mt-1 border border-border-subtle rounded-md bg-inset">
      {reason && (
        <div className="cmd-prompt opacity-80">
          <span className="cmd-sigil font-bold">&gt;</span>
          <span className="cmd-text text-muted">{reason}</span>
        </div>
      )}
      <div className="cmd-prompt">
        <span className="cmd-sigil">$</span>
        <span className="cmd-text">{fullCommand}</span>
      </div>
      {cwd && (
        <div className="cmd-cwd">
          <span className="material-symbols-outlined text-xs cmd-cwd-icon">
            folder_open
          </span>
          {cwd}
        </div>
      )}
      {/* While running: show live streaming output */}
      {isRunning && streamingOutput && (
        <pre ref={streamingRef} className="cmd-output">
          {streamingOutput}
        </pre>
      )}

      {/* After completion: show final stdout/stderr from result */}
      {!isRunning && stdout && (
        <pre className="cmd-output">
          {stdout}
          {truncatedStdout && (
            <span className="cmd-truncated"> … [truncated]</span>
          )}
        </pre>
      )}
      {!isRunning && stderr && (
        <pre className={cn("cmd-output", failed && "cmd-output--error")}>
          {stderr}
          {truncatedStderr && (
            <span className="cmd-truncated"> … [truncated]</span>
          )}
        </pre>
      )}
      {!isRunning && failed && (
        <div className="cmd-exit-code">exited with code {exitCode}</div>
      )}
    </div>
  );
}

/* ── Expanded content: user_input Q&A readback ────────────────────────────── */
function ExpandedUserInput({ tc }: { tc: ToolCallDisplay }) {
  const question = typeof tc.args.question === "string" ? tc.args.question : "";
  const options: string[] = Array.isArray(tc.args.options)
    ? (tc.args.options as unknown[]).filter(
        (o): o is string => typeof o === "string",
      )
    : [];

  const result =
    tc.result && typeof tc.result === "object"
      ? (tc.result as Record<string, unknown>)
      : null;
  const answer = typeof result?.answer === "string" ? result.answer : null;
  const skipped = tc.status === "denied";
  const isOptionAnswer = answer !== null && options.includes(answer);
  const isCustomAnswer = answer !== null && !isOptionAnswer;

  return (
    <div className="cmd-block mt-1 border border-border-subtle rounded-[6px] bg-inset">
      {/* Question */}
      <div className="text-xs text-text leading-[1.6] mb-2">{question}</div>

      {/* Options list — chosen option highlighted, others faded */}
      {options.length > 0 && (
        <div className="flex flex-col gap-0.5 mb-2">
          {options.map((opt) => {
            const chosen = answer === opt;
            return (
              <div
                key={opt}
                className={cn(
                  "flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded",
                  chosen
                    ? "bg-[color-mix(in_srgb,var(--color-success)_14%,transparent)] text-success"
                    : "text-muted opacity-40",
                )}
              >
                <span className="material-symbols-outlined text-sm shrink-0">
                  {chosen ? "radio_button_checked" : "radio_button_unchecked"}
                </span>
                {opt}
              </div>
            );
          })}
        </div>
      )}

      {/* Custom answer (typed by user, not from options list) */}
      {isCustomAnswer && (
        <div className="flex items-start gap-1.5 text-xs mt-1">
          <span className="material-symbols-outlined text-success text-sm shrink-0 mt-px">
            chat_bubble
          </span>
          <span className="text-text leading-[1.6]">{answer}</span>
        </div>
      )}

      {/* Skipped */}
      {skipped && (
        <div className="text-xxs text-muted italic">Question was skipped.</div>
      )}
    </div>
  );
}

function ExpandedGeneric({ tc }: { tc: ToolCallDisplay }) {
  const rawArgs = stringifyValue(tc.args);
  const rawResult =
    tc.result !== undefined ? stringifyValue(tc.result) : undefined;

  return (
    <div className="cmd-block mt-1 border border-border-subtle rounded-md bg-inset">
      <div className="text-xxs font-bold tracking-[0.08em] uppercase text-muted">
        Parameters
      </div>
      <pre className="cmd-output mt-0">{rawArgs}</pre>
      {rawResult !== undefined && (
        <>
          <div className="text-xxs font-bold tracking-[0.08em] uppercase text-muted mt-1">
            Result
          </div>
          <pre
            className={cn(
              "cmd-output mt-0",
              tc.status === "error" && "cmd-output--error",
            )}
          >
            {rawResult}
          </pre>
        </>
      )}
    </div>
  );
}

/* ── Public component ───────────────────────────────────────────────────────── */
interface CompactToolCallProps {
  tc: ToolCallDisplay;
  onInspect: () => void;
  cwd?: string;
  showDebug: boolean;
}

export default function CompactToolCall({
  tc,
  onInspect,
  cwd,
  showDebug,
}: CompactToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const isExpandable =
    tc.status !== "awaiting_approval" &&
    tc.status !== "awaiting_worktree" &&
    tc.status !== "awaiting_setup_action" &&
    !NON_EXPANDABLE_TOOLS.has(tc.tool);
  const isInspectable =
    showDebug &&
    tc.status !== "awaiting_approval" &&
    tc.status !== "awaiting_worktree" &&
    tc.status !== "awaiting_setup_action";

  const icon = getToolCallIcon(tc);
  const label = getToolCallLabel(tc);
  const dotStatus = STATUS_DOT[tc.status] ?? "pending";
  const statusDotVariant =
    dotStatus === "pending"
      ? "idle"
      : dotStatus === "running"
        ? "working"
        : dotStatus === "done"
          ? "done"
          : "error";
  const argPreview = buildCollapsedArgPreview(tc);
  const execBadge = getExecCommandBadge(tc);

  /* ── Header row ──────────────────────────────────────────────────────────── */
  const headerRow = (
    <div
      className={cn(
        "inline-tool-summary",
        (isExpandable || isInspectable) && "inline-tool-summary--clickable",
      )}
      onClick={
        isExpandable
          ? () => setExpanded((v) => !v)
          : isInspectable
            ? onInspect
            : undefined
      }
      role={isExpandable || isInspectable ? "button" : undefined}
    >
      {/* Status dot */}
      <StatusDot
        status={statusDotVariant}
        className={cn("inline-tool-status", `inline-tool-status--${dotStatus}`)}
      />

      {/* Tool icon */}
      <span className="material-symbols-outlined text-base opacity-65 shrink-0">
        {icon}
      </span>

      <div className="inline-tool-summary-main">
        {/* Human-readable label */}
        <span
          className={cn(
            "inline-tool-label",
            tc.status === "denied" && "text-error",
          )}
        >
          {label}
          {tc.status === "denied" && (
            <span className="ml-1 opacity-80"> · DENIED</span>
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

      {/* frame_bug — opens the details modal */}
      {isInspectable && (
        <span
          className="material-symbols-outlined text-muted opacity-45 shrink-0 text-sm"
          onClick={(e) => {
            e.stopPropagation();
            onInspect();
          }}
        >
          frame_bug
        </span>
      )}

      {/* Expand / collapse chevron */}
      {isExpandable && (
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

  /* ── Expanded section ──────────────────────────────────────────────────── */
  const expandedContent = expanded && isExpandable && (
    // compact-tool-expanded targets .patch-preview-diff in globals.css
    // to constrain height without scrolling the tab bar out of view.
    <div className="compact-tool-expanded ml-1">
      {tc.tool === "workspace_listDir" && <ExpandedListDir tc={tc} />}
      {tc.tool === "workspace_stat" && <ExpandedStatFile tc={tc} />}
      {tc.tool === "workspace_readFile" && <ExpandedReadFile tc={tc} />}
      {tc.tool === "workspace_glob" && <ExpandedGlob tc={tc} />}
      {tc.tool === "git_worktree_init" && <ExpandedGitWorktree tc={tc} />}
      {tc.tool === "workspace_editFile" && (
        <ExpandedEditFile tc={tc} cwd={cwd} />
      )}
      {tc.tool === "workspace_writeFile" && (
        <ExpandedWriteFile tc={tc} cwd={cwd} />
      )}
      {tc.tool === "exec_run" && (
        <ExpandedCommand
          args={tc.args}
          result={tc.result}
          streamingOutput={tc.streamingOutput}
          isRunning={tc.status === "running"}
        />
      )}
      {tc.tool === "workspace_search" && <ExpandedSearch tc={tc} />}
      {tc.tool === "user_input" && <ExpandedUserInput tc={tc} />}
      {!CUSTOM_EXPANDED_TOOLS.has(tc.tool) && <ExpandedGeneric tc={tc} />}
    </div>
  );

  return (
    <div className="inline-tool-block">
      {headerRow}
      {expandedContent}
    </div>
  );
}
