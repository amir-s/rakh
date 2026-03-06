/* ─────────────────────────────────────────────────────────────────────────────
   DiffViewer — renders one or more unified-diff file blocks.
   Content HTML strings are hardcoded (never user input) so
   dangerouslySetInnerHTML is safe here.
─────────────────────────────────────────────────────────────────────────────── */

import { useState } from "react";
import { cn } from "@/utils/cn";

export type DiffLineType = "context" | "add" | "remove" | "meta";

export interface DiffLine {
  /** null renders as "..." in the gutter */
  lineNum: number | null;
  type: DiffLineType;
  /** Pre-rendered HTML – syntax spans using existing .sk / .sf / .ss classes */
  html: string;
}

export interface DiffFile {
  filename: string;
  adds: number;
  removes: number;
  lines: DiffLine[];
}

/* ── Single diff line row ──────────────────────────────────────────────────── */
export function DiffLineRow({ lineNum, type, html }: DiffLine) {
  const prefix = type === "add" ? "+" : type === "remove" ? "-" : "\u00a0";
  return (
    <div className={cn("diff-line", `diff-line--${type}`)}>
      <div
        className={cn(
          "diff-line-num",
          lineNum == null && "diff-line-num--meta",
        )}
      >
        {lineNum ?? "..."}
      </div>
      <div className="diff-line-prefix">{prefix}</div>
      <div
        className="diff-line-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/* ── File block ────────────────────────────────────────────────────────────── */
interface DiffFileBlockProps extends DiffFile {
  onAccept?: () => void;
  onRefine?: () => void;
}

function DiffFileBlock({
  filename,
  adds,
  removes,
  lines,
  onAccept,
  onRefine,
}: DiffFileBlockProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="diff-file">
      <div className="diff-file-header">
        {/* Clickable title — toggles collapse */}
        <button
          className="diff-file-name diff-file-name--btn"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Expand" : "Collapse"}
        >
          <span
            className="material-symbols-outlined text-md"
            style={{ fontVariationSettings: "'FILL' 0, 'wght' 300" }}
          >
            description
          </span>
          {filename}
          <span
            className={cn(
              "material-symbols-outlined diff-file-chevron text-base transition-transform duration-150",
              collapsed ? "-rotate-90" : "rotate-0",
            )}
          >
            expand_more
          </span>
        </button>

        {/* Right side: stat chips + action buttons */}
        <div className="diff-file-header-right">
          <div className="diff-stats">
            <span className="diff-stat-add">+{adds}</span>
            <span className="diff-stat-rem">-{removes}</span>
          </div>
          {onRefine && (
            <button
              className="diff-action-btn diff-action-btn--refine"
              onClick={onRefine}
              title="Add to chat for refinement"
            >
              Refine
            </button>
          )}
          {onAccept && (
            <button
              className="diff-action-btn diff-action-btn--accept"
              onClick={onAccept}
              title="Accept this edit"
            >
              Accept
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="diff-lines">
          <div className="diff-lines-inner">
            {lines.map((line, i) => (
              <DiffLineRow key={i} {...line} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Public component ──────────────────────────────────────────────────────── */

export interface DiffViewerFileCallbacks {
  onAccept?: (filename: string) => void;
  onRefine?: (filename: string) => void;
}

export default function DiffViewer({
  files,
  onAccept,
  onRefine,
}: {
  files: DiffFile[];
  onAccept?: (filename: string) => void;
  onRefine?: (filename: string) => void;
}) {
  return (
    <div className="diff-viewer">
      {files.map((f, i) => (
        <DiffFileBlock
          key={i}
          {...f}
          onAccept={onAccept ? () => onAccept(f.filename) : undefined}
          onRefine={onRefine ? () => onRefine(f.filename) : undefined}
        />
      ))}
    </div>
  );
}
