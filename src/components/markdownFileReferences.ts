import { invoke } from "@tauri-apps/api/core";

export interface FileReferenceTarget {
  path: string;
  line?: number;
  column?: number;
}

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:\//;
const EXTERNAL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/;
const HASH_LINE_RE = /^(.*)#L([1-9]\d*)(?:C([1-9]\d*))?$/i;
const URL_LIKE_TLDS = new Set([
  "ai",
  "app",
  "ca",
  "co",
  "com",
  "dev",
  "fm",
  "gg",
  "io",
  "ly",
  "me",
  "net",
  "org",
  "rs",
  "sh",
  "tv",
  "uk",
  "us",
]);

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalizeSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeAbsolutePath(path: string): string {
  const normalized = normalizeSlashes(path);
  const hasWindowsDrive = WINDOWS_ABSOLUTE_PATH_RE.test(normalized);
  const leadingSlash = normalized.startsWith("/");
  const prefix = hasWindowsDrive ? normalized.slice(0, 2) : "";
  const body = hasWindowsDrive ? normalized.slice(2) : normalized;
  const parts = body.split("/").filter((part) => part.length > 0);
  const joined = parts.join("/");
  if (hasWindowsDrive) return joined ? `${prefix}/${joined}` : `${prefix}/`;
  return leadingSlash ? `/${joined}` : joined;
}

function trimTrailingSlashes(path: string): string {
  if (!path || path === "/" || WINDOWS_ABSOLUTE_PATH_RE.test(path) && path.endsWith("/")) {
    return path;
  }
  return path.replace(/\/+$/g, "");
}

function joinAbsolutePath(baseAbs: string, relOrAbs: string): string {
  const cleaned = normalizeSlashes(relOrAbs);
  if (!cleaned) return normalizeAbsolutePath(baseAbs);
  if (cleaned.startsWith("/") || WINDOWS_ABSOLUTE_PATH_RE.test(cleaned)) {
    return normalizeAbsolutePath(cleaned);
  }
  const base = trimTrailingSlashes(normalizeAbsolutePath(baseAbs));
  return normalizeAbsolutePath(`${base}/${cleaned.replace(/^\/+/g, "")}`);
}

function isLikelyUrlHost(path: string): boolean {
  if (path.includes("/") || path.includes("@")) return false;
  const parts = path.split(".");
  if (parts.length < 2) return false;
  const ext = parts[parts.length - 1]?.toLowerCase() ?? "";
  return URL_LIKE_TLDS.has(ext);
}

function isCandidateFilePath(path: string): boolean {
  const normalized = normalizeSlashes(path.trim());
  if (!normalized) return false;
  if (normalized.includes("://")) return false;
  if (EXTERNAL_SCHEME_RE.test(normalized) && !WINDOWS_ABSOLUTE_PATH_RE.test(normalized)) {
    return false;
  }
  const basename = normalized.split("/").pop() ?? normalized;
  if (!basename.includes(".")) return false;
  if (isLikelyUrlHost(normalized)) return false;
  return true;
}

function toPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function parsePlainTextFileReference(
  value: string,
): FileReferenceTarget | null {
  const trimmed = value.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) return null;

  const trailingSegment = trimmed.slice(lastColon + 1);
  const trailingNumber = toPositiveInt(trailingSegment);
  if (!trailingNumber) return null;

  const beforeTrailing = trimmed.slice(0, lastColon);
  const secondLastColon = beforeTrailing.lastIndexOf(":");
  if (secondLastColon >= 0) {
    const lineSegment = beforeTrailing.slice(secondLastColon + 1);
    const line = toPositiveInt(lineSegment);
    if (line) {
      const path = beforeTrailing.slice(0, secondLastColon).trim();
      if (!isCandidateFilePath(path)) return null;
      return {
        path: normalizeSlashes(path),
        line,
        column: trailingNumber,
      };
    }
  }

  const path = beforeTrailing.trim();
  if (!isCandidateFilePath(path)) return null;
  return {
    path: normalizeSlashes(path),
    line: trailingNumber,
  };
}

export function parseFileReferenceHref(
  href: string,
): FileReferenceTarget | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  const hashLineMatch = trimmed.match(HASH_LINE_RE);
  if (hashLineMatch) {
    const path = hashLineMatch[1]?.trim() ?? "";
    if (!isCandidateFilePath(path)) return null;
    const line = toPositiveInt(hashLineMatch[2]);
    const column = toPositiveInt(hashLineMatch[3]);
    if (!line) return null;
    return {
      path: normalizeSlashes(path),
      line,
      ...(column ? { column } : {}),
    };
  }

  const textReference = parsePlainTextFileReference(trimmed);
  if (textReference) return textReference;

  if (!isCandidateFilePath(trimmed)) return null;
  return { path: normalizeSlashes(trimmed) };
}

export function resolveFileReferencePath(
  referencePath: string,
  cwd?: string,
): string | null {
  const normalized = normalizeSlashes(referencePath.trim());
  if (!normalized) return null;
  if (normalized.startsWith("/") || WINDOWS_ABSOLUTE_PATH_RE.test(normalized)) {
    return normalizeAbsolutePath(normalized);
  }
  if (!cwd?.trim()) return null;
  return joinAbsolutePath(cwd, normalized);
}

export async function openFileReference(
  reference: FileReferenceTarget,
  options?: {
    cwd?: string;
    onError?: (details: unknown) => void;
  },
): Promise<boolean> {
  const resolvedPath = resolveFileReferencePath(reference.path, options?.cwd);
  if (!resolvedPath) {
    options?.onError?.({
      message:
        "Could not resolve the file reference path. Workspace-relative references require an active workspace path.",
      reference,
    });
    return true;
  }

  if (!isTauriRuntime()) {
    options?.onError?.({
      message: "Editor links are only available in the desktop app.",
      reference,
      path: resolvedPath,
    });
    return true;
  }

  try {
    await invoke("open_editor_reference", {
      path: resolvedPath,
      ...(reference.line ? { line: reference.line } : {}),
      ...(reference.column ? { column: reference.column } : {}),
    });
  } catch (error) {
    options?.onError?.(error);
  }

  return true;
}
