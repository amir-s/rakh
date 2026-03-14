import { invoke } from "@tauri-apps/api/core";
import type { ToolErrorCode, ToolResult } from "../types";
import type { LogContext } from "@/logging/types";

export type ToolArtifactSourceKind = "local" | "mcp" | "synthetic";
export type ToolArtifactOriginalFormat = "text" | "json";

export interface ToolArtifactCreateInput {
  runId: string;
  tabId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  sourceKind: ToolArtifactSourceKind;
  policyId: string;
  originalFormat: ToolArtifactOriginalFormat;
  content: string;
  intention?: string;
}

export interface ToolArtifactCreateOutput {
  artifactId: string;
  createdAtMs: number;
  sizeBytes: number;
  originalFormat: ToolArtifactOriginalFormat;
  lineCount: number;
}

export interface ToolArtifactRange {
  startLine: number;
  endLine: number;
}

export interface ToolArtifactGetInput {
  artifactId: string;
  range?: ToolArtifactRange;
  maxBytes?: number;
  intention?: string;
}

export interface ToolArtifactGetOutput {
  artifactId: string;
  originalFormat: ToolArtifactOriginalFormat;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  lineCount?: number;
  range?: ToolArtifactRange;
  createdAtMs: number;
}

export interface ToolArtifactSearchInput {
  artifactId: string;
  pattern: string;
  caseSensitive?: boolean;
  maxMatches?: number;
  contextLines?: number;
  intention?: string;
}

export interface ToolArtifactSearchMatch {
  lineNumber: number;
  line: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface ToolArtifactSearchOutput {
  artifactId: string;
  matches: ToolArtifactSearchMatch[];
  truncated: boolean;
  matchCount: number;
  lineCount: number;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function parseInvokeError(error: unknown): {
  code: ToolErrorCode;
  message: string;
} {
  const message = String(error);
  if (message.startsWith("INVALID_ARGUMENT:")) {
    return { code: "INVALID_ARGUMENT", message };
  }
  if (message.startsWith("NOT_FOUND:")) {
    return { code: "NOT_FOUND", message };
  }
  return { code: "INTERNAL", message };
}

async function tauriInvoke<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error("Tauri is not available");
  }
  return invoke<T>(command, args);
}

export async function createToolArtifact(
  input: ToolArtifactCreateInput,
  logContext?: LogContext,
): Promise<ToolResult<ToolArtifactCreateOutput>> {
  try {
    const data = await tauriInvoke<ToolArtifactCreateOutput>("tool_artifact_create", {
      input,
      ...(logContext ? { logContext } : {}),
    });
    return { ok: true, data };
  } catch (error) {
    const parsed = parseInvokeError(error);
    return { ok: false, error: parsed };
  }
}

export async function getToolArtifact(
  input: ToolArtifactGetInput,
  logContext?: LogContext,
): Promise<ToolResult<ToolArtifactGetOutput>> {
  try {
    const data = await tauriInvoke<ToolArtifactGetOutput>("tool_artifact_get", {
      input: {
        artifactId: input.artifactId,
        startLine: input.range?.startLine ?? null,
        endLine: input.range?.endLine ?? null,
        maxBytes: input.maxBytes ?? null,
      },
      ...(logContext ? { logContext } : {}),
    });
    return { ok: true, data };
  } catch (error) {
    const parsed = parseInvokeError(error);
    return { ok: false, error: parsed };
  }
}

export async function searchToolArtifact(
  input: ToolArtifactSearchInput,
  logContext?: LogContext,
): Promise<ToolResult<ToolArtifactSearchOutput>> {
  try {
    const data = await tauriInvoke<ToolArtifactSearchOutput>("tool_artifact_search", {
      input: {
        artifactId: input.artifactId,
        pattern: input.pattern,
        caseSensitive: input.caseSensitive ?? false,
        maxMatches: input.maxMatches ?? null,
        contextLines: input.contextLines ?? null,
      },
      ...(logContext ? { logContext } : {}),
    });
    return { ok: true, data };
  } catch (error) {
    const parsed = parseInvokeError(error);
    return { ok: false, error: parsed };
  }
}

export async function deleteToolArtifact(
  artifactId: string,
  logContext?: LogContext,
): Promise<ToolResult<{ deleted: boolean }>> {
  try {
    const data = await tauriInvoke<{ deleted: boolean }>("tool_artifact_delete", {
      artifactId,
      ...(logContext ? { logContext } : {}),
    });
    return { ok: true, data };
  } catch (error) {
    const parsed = parseInvokeError(error);
    return { ok: false, error: parsed };
  }
}
