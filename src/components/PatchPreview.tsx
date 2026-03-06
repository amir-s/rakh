/* ─────────────────────────────────────────────────────────────────────────────
   PatchPreview — GitHub-style diff viewer with one tab per file.
   Accepts the same DiffFile[] type as DiffViewer so data can be shared.
───────────────────────────────────────────────────────────────────────────── */

import { useState } from "react";
import { DiffLineRow, type DiffFile } from "./DiffViewer";
import { cn } from "@/utils/cn";

/** Returns the filename portion of a path (everything after the last slash). */
function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/* ── File tab ───────────────────────────────────────────────────────────────── */
interface FileTabProps {
  file: DiffFile;
  active: boolean;
  onClick: () => void;
}

function FileTab({ file, active, onClick }: FileTabProps) {
  return (
    <button
      className={cn("patch-preview-tab", active && "patch-preview-tab--active")}
      onClick={onClick}
    >
      <span className="patch-preview-tab-name">{basename(file.filename)}</span>
      <span className="patch-preview-tab-stats">
        {file.adds > 0 && <span className="diff-stat-add">+{file.adds}</span>}
        {file.removes > 0 && (
          <span className="diff-stat-rem">-{file.removes}</span>
        )}
      </span>
    </button>
  );
}

/* ── Public component ──────────────────────────────────────────────────────── */
export default function PatchPreview({ files }: { files: DiffFile[] }) {
  const [activeIdx, setActiveIdx] = useState(0);

  if (files.length === 0) return null;

  // Clamp in case files change externally
  const clampedIdx = Math.min(activeIdx, files.length - 1);
  const activeFile = files[clampedIdx];

  return (
    <div className="patch-preview">
      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <div className="patch-preview-tabs">
        {files.map((f, i) => (
          <FileTab
            key={i}
            file={f}
            active={i === clampedIdx}
            onClick={() => setActiveIdx(i)}
          />
        ))}
      </div>

      {/* ── Full path breadcrumb ─────────────────────────────────────────── */}
      <div className="patch-preview-filepath">
        <span
          className="material-symbols-outlined text-sm"
          style={{ fontVariationSettings: "'FILL' 0, 'wght' 300" }}
        >
          description
        </span>
        {activeFile.filename}
      </div>

      {/* ── Diff body ───────────────────────────────────────────────────── */}
      <div className="patch-preview-diff">
        <div className="diff-lines-inner">
          {activeFile.lines.map((line, i) => (
            <DiffLineRow key={i} {...line} />
          ))}
        </div>
      </div>
    </div>
  );
}
