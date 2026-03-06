/**
 * Workspace tools (§1 of tools.md)
 * All filesystem operations are delegated to custom Tauri commands which run
 * as native Rust code so they can access the real filesystem.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ToolResult } from "../types";

/* ── helpers ────────────────────────────────────────────────────────────────── */

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalizeAbsolutePath(path: string): string {
  const normalized = normalizeSlashes(path);
  const leadingSlash = normalized.startsWith("/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return leadingSlash ? `/${parts.join("/")}` : parts.join("/");
}

function trimTrailingSlashes(path: string): string {
  if (!path || path === "/") return path;
  return path.replace(/\/+$/g, "");
}

function joinAbsolutePath(baseAbs: string, relOrAbs: string): string {
  const cleaned = normalizeSlashes(relOrAbs);
  if (!cleaned) return normalizeAbsolutePath(baseAbs);
  if (cleaned.startsWith("/")) return normalizeAbsolutePath(cleaned);
  const base = trimTrailingSlashes(normalizeAbsolutePath(baseAbs));
  return normalizeAbsolutePath(`${base}/${cleaned.replace(/^\/+/g, "")}`);
}

/** Safety: reject paths with ".." or absolute paths */
function validatePath(
  path: unknown,
  options: { allowEmpty?: boolean } = {},
): string | null {
  const allowEmpty = options.allowEmpty ?? false;

  if (path === undefined || path === null) {
    return allowEmpty ? null : "Path is required";
  }
  if (typeof path !== "string") {
    return "Path must be a string";
  }
  if (path.length === 0) {
    return allowEmpty ? null : "Path is required";
  }

  const norm = normalizeSlashes(path);
  if (norm.startsWith("/"))
    return "Path must be workspace-relative (no leading /)";
  if (norm.split("/").includes(".."))
    return "Path must not contain '..' segments";
  return null;
}

async function tauriInvoke<T>(
  cmd: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) {
    throw new Error("Tauri is not available — run inside the Tauri app");
  }
  return invoke<T>(cmd, args);
}

/* ── 1.1 workspace.listDir ──────────────────────────────────────────────────── */

export interface ListDirInput {
  path?: string;
  includeHidden?: boolean;
  maxEntries?: number;
}

export interface DirEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink";
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface ListDirOutput {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
}

export async function listDir(
  cwd: string,
  input: ListDirInput,
): Promise<ToolResult<ListDirOutput>> {
  const pathErr = validatePath(input.path, { allowEmpty: true });
  if (pathErr)
    return { ok: false, error: { code: "INVALID_ARGUMENT", message: pathErr } };
  const relPath = typeof input.path === "string" ? input.path : "";
  const absPath = relPath ? joinAbsolutePath(cwd, relPath) : cwd;

  try {
    const data = await tauriInvoke<ListDirOutput>("list_dir", {
      path: absPath,
      includeHidden: input.includeHidden ?? false,
      maxEntries: input.maxEntries ?? 200,
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: { code: "INTERNAL", message: String(e) } };
  }
}

/* ── 1.2 workspace.statFile ─────────────────────────────────────────────────── */

export interface StatFileInput {
  path: string;
}

export interface StatFileOutput {
  exists: boolean;
  path: string;
  kind?: "file" | "dir" | "symlink";
  sizeBytes?: number;
  mtimeMs?: number;
}

export async function statFile(
  cwd: string,
  input: StatFileInput,
): Promise<ToolResult<StatFileOutput>> {
  const pathErr = validatePath(input.path);
  if (pathErr)
    return { ok: false, error: { code: "INVALID_ARGUMENT", message: pathErr } };
  const absPath = joinAbsolutePath(cwd, input.path);

  try {
    const data = await tauriInvoke<StatFileOutput>("stat_file", {
      path: absPath,
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: { code: "INTERNAL", message: String(e) } };
  }
}

/* ── 1.3 workspace.readFile ─────────────────────────────────────────────────── */

export interface ReadFileInput {
  path: string;
  range?: { startLine: number; endLine: number };
  maxBytes?: number;
}

export interface ReadFileOutput {
  path: string;
  encoding: "utf8";
  content: string;
  fileSizeBytes: number;
  lineCount?: number;
  range?: { startLine: number; endLine: number };
  truncated: boolean;
}

export async function readFile(
  cwd: string,
  input: ReadFileInput,
): Promise<ToolResult<ReadFileOutput>> {
  const pathErr = validatePath(input.path);
  if (pathErr)
    return { ok: false, error: { code: "INVALID_ARGUMENT", message: pathErr } };

  const absPath = joinAbsolutePath(cwd, input.path);

  try {
    const data = await tauriInvoke<ReadFileOutput>("read_file", {
      path: absPath,
      startLine: input.range?.startLine ?? null,
      endLine: input.range?.endLine ?? null,
      maxBytes: input.maxBytes ?? 200_000,
    });
    return { ok: true, data };
  } catch (e) {
    const msg = String(e);
    const code =
      msg.includes("not found") || msg.includes("No such")
        ? "NOT_FOUND"
        : "INTERNAL";
    return { ok: false, error: { code, message: msg } };
  }
}

/* ── 1.3 workspace.writeFile ────────────────────────────────────────────────── */

export interface WriteFileInput {
  path: string;
  content: string;
  mode?: "create" | "overwrite" | "create_or_overwrite";
  createDirs?: boolean;
  maxBytes?: number;
}

export interface WriteFileOutput {
  path: string;
  bytesWritten: number;
  created: boolean;
  overwritten: boolean;
}

export async function writeFile(
  cwd: string,
  input: WriteFileInput,
): Promise<ToolResult<WriteFileOutput>> {
  const pathErr = validatePath(input.path);
  if (pathErr)
    return { ok: false, error: { code: "INVALID_ARGUMENT", message: pathErr } };

  const maxBytes = input.maxBytes ?? 500_000;
  if (new TextEncoder().encode(input.content).length > maxBytes) {
    return {
      ok: false,
      error: {
        code: "TOO_LARGE",
        message: `Content exceeds ${maxBytes} bytes`,
      },
    };
  }

  const absPath = `${cwd}/${input.path}`;

  try {
    const data = await tauriInvoke<WriteFileOutput>("write_file", {
      path: absPath,
      content: input.content,
      mode: input.mode ?? "create_or_overwrite",
      createDirs: input.createDirs ?? true,
    });
    return { ok: true, data };
  } catch (e) {
    const msg = String(e);
    const code =
      msg.includes("CONFLICT") || msg.includes("exists")
        ? "CONFLICT"
        : "INTERNAL";
    return { ok: false, error: { code, message: msg } };
  }
}

/* ── 1.4 workspace.editFile ─────────────────────────────────────────────────── */

export interface EditFileChange {
  /** String to search for in the file */
  oldString: string;
  /** String to replace it with */
  newString: string;
  /** Replace all occurrences (default: false — only the first) */
  replaceAll?: boolean;
}

export interface EditFileInput {
  path: string;
  changes: EditFileChange[];
}

export interface EditFileOutput {
  path: string;
  bytesWritten: number;
  appliedChanges: number;
}

/**
 * Pure helper: apply a list of find/replace changes to a string in sequence.
 * Throws if any oldString is not found (and replaceAll is false).
 * Used by editFile and by the diff preview builder.
 */
export function applyEditChanges(
  content: string,
  changes: EditFileChange[],
): string {
  let result = content;
  for (const change of changes) {
    if (change.oldString === change.newString) {
      throw new Error(
        `oldString and newString are identical. The edit would have no effect. Please provide a newString that is different from oldString.`,
      );
    }

    const firstIdx = result.indexOf(change.oldString);
    if (firstIdx === -1) {
      throw new Error(
        `String not found in file: ${JSON.stringify(change.oldString)}. Please check the file content and provide the exact existing string to replace, including correct whitespace and indentation.`,
      );
    }

    if (change.replaceAll) {
      result = result.split(change.oldString).join(change.newString);
    } else {
      const secondIdx = result.indexOf(change.oldString, firstIdx + 1);
      if (secondIdx !== -1) {
        throw new Error(
          `String found multiple times. Provide a longer, more specific oldString to ensure unique matching, or set replaceAll: true if you want to replace all occurrences. String: ${JSON.stringify(change.oldString)}`,
        );
      }
      result =
        result.slice(0, firstIdx) +
        change.newString +
        result.slice(firstIdx + change.oldString.length);
    }
  }
  return result;
}

export async function validateEditFile(
  cwd: string,
  input: EditFileInput,
): Promise<ToolResult<null> | null> {
  const pathErr = validatePath(input.path);
  if (pathErr)
    return { ok: false, error: { code: "INVALID_ARGUMENT", message: pathErr } };

  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "changes array is required and must be non-empty",
      },
    };
  }

  // Read current content
  const readResult = await readFile(cwd, { path: input.path });
  if (!readResult.ok) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Cannot read ${input.path}: ${readResult.error.message}`,
      },
    };
  }

  // Apply changes
  try {
    applyEditChanges(readResult.data.content, input.changes);
  } catch (e) {
    return { ok: false, error: { code: "CONFLICT", message: String(e) } };
  }

  return null;
}

export async function editFile(
  cwd: string,
  input: EditFileInput,
): Promise<ToolResult<EditFileOutput>> {
  const validationErr = await validateEditFile(cwd, input);
  if (validationErr) {
    return validationErr as unknown as ToolResult<EditFileOutput>;
  }

  const readResult = await readFile(cwd, { path: input.path });
  if (!readResult.ok) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Cannot read ${input.path}: ${readResult.error.message}`,
      },
    };
  }

  // Apply changes
  let newContent: string;
  try {
    newContent = applyEditChanges(readResult.data.content, input.changes);
  } catch (e) {
    return { ok: false, error: { code: "CONFLICT", message: String(e) } };
  }

  // Write back
  const writeResult = await writeFile(cwd, {
    path: input.path,
    content: newContent,
    mode: "overwrite",
  });
  if (!writeResult.ok) return writeResult as ToolResult<EditFileOutput>;

  return {
    ok: true,
    data: {
      path: input.path,
      bytesWritten: writeResult.data.bytesWritten,
      appliedChanges: input.changes.length,
    },
  };
}

/* ── 1.5 workspace.glob ─────────────────────────────────────────────────────── */

export interface GlobInput {
  patterns: string[];
  cwd?: string;
  maxMatches?: number;
  includeDirs?: boolean;
  includeHidden?: boolean;
}

export interface GlobOutput {
  matches: string[];
  truncated: boolean;
}

export async function glob(
  agentCwd: string,
  input: GlobInput,
): Promise<ToolResult<GlobOutput>> {
  const pathErr = validatePath(input.cwd, { allowEmpty: true });
  if (pathErr)
    return { ok: false, error: { code: "INVALID_ARGUMENT", message: pathErr } };

  const baseCwd =
    typeof input.cwd === "string" && input.cwd.length > 0
      ? joinAbsolutePath(agentCwd, input.cwd)
      : agentCwd;

  try {
    const data = await tauriInvoke<GlobOutput>("glob_files", {
      patterns: input.patterns,
      cwd: baseCwd,
      maxMatches: input.maxMatches ?? 2000,
      includeDirs: input.includeDirs ?? false,
      includeHidden: input.includeHidden ?? false,
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: { code: "INTERNAL", message: String(e) } };
  }
}

/* ── 1.6 workspace.search ───────────────────────────────────────────────────── */

export interface SearchFilesInput {
  pattern: string;
  rootDir?: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxMatches?: number;
  caseSensitive?: boolean;
  includeHidden?: boolean;
  contextLines?: number;
  followSymlinks?: boolean;
}

export interface SearchMatch {
  path: string;
  lineNumber: number;
  line: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface SearchFilesOutput {
  matches: SearchMatch[];
  truncated: boolean;
  searchedFiles: number;
  matchCount: number;
}

export async function searchFiles(
  agentCwd: string,
  input: SearchFilesInput,
): Promise<ToolResult<SearchFilesOutput>> {
  const pathErr = validatePath(input.rootDir, { allowEmpty: true });
  if (pathErr)
    return { ok: false, error: { code: "INVALID_ARGUMENT", message: pathErr } };

  const absRootDir =
    typeof input.rootDir === "string" && input.rootDir.length > 0
      ? joinAbsolutePath(agentCwd, input.rootDir)
      : agentCwd;

  try {
    const data = await tauriInvoke<SearchFilesOutput>("search_files_grep", {
      pattern: input.pattern,
      rootDir: absRootDir,
      includeGlobs: input.includeGlobs ?? [],
      excludeGlobs: input.excludeGlobs ?? [],
      maxMatches: input.maxMatches ?? 200,
      caseSensitive: input.caseSensitive ?? false,
      includeHidden: input.includeHidden ?? false,
      contextLines: input.contextLines ?? 0,
      followSymlinks: input.followSymlinks ?? false,
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: { code: "INTERNAL", message: String(e) } };
  }
}
