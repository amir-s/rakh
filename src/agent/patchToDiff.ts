/**
 * patchToDiff — computes DiffFile data for PatchPreview and diff viewers.
 *
 * Line numbers:
 *   - context / add lines  → monotonically incrementing new-file counter (1-based).
 *   - remove lines         → null (they don't exist in the new file).
 *   - meta separators      → null.
 *
 * HTML:
 *   Plain text is HTML-escaped. No syntax highlighting is applied here.
 */

import type { DiffFile, DiffLine } from "@/components/DiffViewer";

/* ── HTML escaping ──────────────────────────────────────────────────────────── */

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ── LCS-based line diff ────────────────────────────────────────────────────── */

type DiffOp = { type: "context" | "remove" | "add"; content: string };
type DiffOpWithLine = DiffOp & { lineNum: number | null };

/**
 * Produces an ordered list of diff operations by running Myers/LCS diff
 * between old_lines and new_lines.
 * Context lines appear in both arrays (they were pushed to both by the parser).
 * Removes appear only in old_lines; adds only in new_lines.
 */
function diffLines(old_lines: string[], new_lines: string[]): DiffOp[] {
  const m = old_lines.length;
  const n = new_lines.length;

  // Build LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        old_lines[i - 1] === new_lines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to reconstruct ops in forward order
  const ops: DiffOp[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && old_lines[i - 1] === new_lines[j - 1]) {
      ops.unshift({ type: "context", content: old_lines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "add", content: new_lines[j - 1] });
      j--;
    } else {
      ops.unshift({ type: "remove", content: old_lines[i - 1] });
      i--;
    }
  }

  return ops;
}

/* ── Context trimming ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * Given a flat list of diff operations (output of diffLines), returns a new
 * list where long runs of unchanged context lines are replaced with a single
 * sentinel { type: "meta", content: "..." } entry, keeping only `radius`
 * lines around each change (standard unified-diff ‑u3 style).
 */
function trimContextOps(
  ops: DiffOpWithLine[],
  radius = 3,
): (DiffOpWithLine | { type: "meta"; content: string })[] {
  // Locate every index that is a change (add or remove)
  const changeAt = new Set<number>();
  ops.forEach((op, i) => {
    if (op.type !== "context") changeAt.add(i);
  });

  if (changeAt.size === 0) return []; // no changes at all

  // Build the set of indices to include
  const include = new Set<number>();
  for (const ci of changeAt) {
    for (let d = -radius; d <= radius; d++) {
      const idx = ci + d;
      if (idx >= 0 && idx < ops.length) include.add(idx);
    }
  }

  // Emit in order, inserting meta separators for gaps
  const sorted = [...include].sort((a, b) => a - b);
  const result: (DiffOpWithLine | { type: "meta"; content: string })[] = [];
  let prevIdx = -1;

  for (const idx of sorted) {
    if (prevIdx !== -1 && idx > prevIdx + 1) {
      result.push({ type: "meta", content: "…" });
    }
    result.push(ops[idx]);
    prevIdx = idx;
  }

  return result;
}

/* ── Public: computeDiffFile ─────────────────────────────────────────────────────────── */

/**
 * Compute a DiffFile between two versions of a file's content.
 * Context lines are trimmed to `radius` lines around each changed region
 * (like `diff -u3`), so the result is compact even for large files.
 *
 * Use this to render the canonical "what changed overall" view after one or
 * more successive patches to the same file.
 */
export function computeDiffFile(
  filename: string,
  originalContent: string,
  currentContent: string,
  radius = 3,
): DiffFile {
  const toLines = (s: string) => {
    const ls = s.split("\n");
    if (ls.length > 0 && ls[ls.length - 1] === "") ls.pop();
    return ls;
  };

  const oldLines = toLines(originalContent);
  const newLines = toLines(currentContent);

  const allOps = diffLines(oldLines, newLines);
  let runningLineNum = 1;
  const opsWithLines: DiffOpWithLine[] = allOps.map((op) => {
    if (op.type === "context" || op.type === "add") {
      const lineNum = runningLineNum++;
      return { ...op, lineNum };
    }
    return { ...op, lineNum: null };
  });
  const trimmed = trimContextOps(opsWithLines, radius);

  const lines: DiffLine[] = [];
  let adds = 0;
  let removes = 0;

  for (const op of trimmed) {
    if (op.type === "meta") {
      lines.push({ lineNum: null, type: "meta", html: op.content });
    } else if (op.type === "context") {
      lines.push({
        lineNum: op.lineNum,
        type: "context",
        html: escapeHtml(op.content),
      });
    } else if (op.type === "add") {
      adds++;
      lines.push({
        lineNum: op.lineNum,
        type: "add",
        html: escapeHtml(op.content),
      });
    } else {
      removes++;
      lines.push({
        lineNum: null,
        type: "remove",
        html: escapeHtml(op.content),
      });
    }
  }

  return { filename, adds, removes, lines };
}
