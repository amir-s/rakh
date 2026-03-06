import { invoke } from "@tauri-apps/api/core";
import { applyEditChanges } from "@/agent/tools/workspace";
import type { EditFileChange } from "@/agent/tools/workspace";
import { computeDiffFile } from "@/agent/patchToDiff";
import type { DiffFile } from "@/components/DiffViewer";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function readFileContent(
  cwd: string,
  relPath: string,
): Promise<string | null> {
  try {
    const absPath = `${cwd}/${relPath}`;
    const r = await invoke<{ content: string }>("read_file", {
      path: absPath,
      startLine: null,
      endLine: null,
      maxBytes: 500_000,
    });
    return r.content;
  } catch {
    return null;
  }
}

/**
 * Build a DiffFile[] preview for workspace_editFile.
 * Reads the current file from disk and applies the changes virtually.
 * Falls back to a single-file diff showing the raw change list if read fails.
 */
export async function buildEditFileDiffFiles(
  path: string,
  changes: EditFileChange[],
  cwd?: string,
): Promise<DiffFile[] | null> {
  if (!cwd || !isTauri()) return null;

  try {
    const original = await readFileContent(cwd, path);
    if (original === null) return null;
    const newContent = applyEditChanges(original, changes);
    return [computeDiffFile(path, original, newContent)];
  } catch {
    return null;
  }
}

/**
 * Build a DiffFile[] preview for workspace_writeFile.
 * If overwrite is true, reads the current file from disk and diffs against new content.
 * If overwrite is false (new file), shows all lines as added.
 */
export async function buildWriteFileDiffFiles(
  path: string,
  content: string,
  overwrite: boolean,
  cwd?: string,
): Promise<DiffFile[] | null> {
  try {
    let original = "";
    if (overwrite && cwd && isTauri()) {
      original = (await readFileContent(cwd, path)) ?? "";
    }
    return [computeDiffFile(path, original, content)];
  } catch {
    return null;
  }
}
