/**
 * Execution tool (§2 of tools.md)
 * Delegates to a custom Tauri Rust command for native shell execution.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ToolResult } from "../types";
import type { LogContext } from "@/logging/types";

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

export interface ExecRunInput {
  command: string;
  args?: string[];
  cwd?: string; // workspace-relative; defaults to agent cwd
  env?: Record<string, string>;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  stdin?: string;
  /** Short human-readable reason why this command is being run. */
  reason?: string;
  /**
   * Approval hint from the model. Used only when the user selected
   * auto-approve mode "agent".
   */
  requireUserApproval?: boolean;
  /** Internal run identifier used for cancellation; set by the runner. */
  runId?: string;
}

export interface ExecRunOutput {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
  /** True when the process was manually terminated via the UI stop action. */
  terminatedByUser?: boolean;
}

interface ExecAbortOutput {
  aborted: boolean;
}

interface ExecStopOutput {
  stopped: boolean;
}

export async function execRun(
  agentCwd: string,
  input: ExecRunInput,
  onOutput?: (stream: "stdout" | "stderr", data: string) => void,
  logContext?: LogContext,
): Promise<ToolResult<ExecRunOutput>> {
  if (!input.command || input.command.trim() === "") {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "command must be a non-empty string",
      },
    };
  }

  // Resolve cwd: if relative, join with agentCwd
  let resolvedCwd = agentCwd;
  if (input.cwd) {
    resolvedCwd = joinAbsolutePath(agentCwd, input.cwd);
  }

  // Set up streaming listener before invoking so no events are missed.
  let unlisten: (() => void) | null = null;
  if (onOutput && input.runId) {
    try {
      const runId = input.runId;
      unlisten = await listen<{
        runId: string;
        stream: "stdout" | "stderr";
        data: string;
      }>("exec_output", (event) => {
        if (event.payload.runId === runId) {
          onOutput(event.payload.stream, event.payload.data);
        }
      });
    } catch {
      // Not in Tauri or event system unavailable — streaming disabled.
    }
  }

  try {
    const data = await invoke<ExecRunOutput>("exec_run", {
      command: input.command,
      args: input.args ?? [],
      cwd: resolvedCwd,
      env: input.env ?? {},
      timeoutMs: input.timeoutMs ?? 120_000,
      maxStdoutBytes: input.maxStdoutBytes ?? 200_000,
      maxStderrBytes: input.maxStderrBytes ?? 200_000,
      stdin: input.stdin ?? null,
      runId: input.runId ?? null,
      ...(logContext ? { logContext } : {}),
    });
    return { ok: true, data };
  } catch (e) {
    const msg = String(e);
    if (msg === "TIMEOUT") {
      return { ok: false, error: { code: "TIMEOUT", message: msg } };
    }
    if (msg === "ABORTED") {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message:
            "User aborted the execution of this command. No stdout/stderr will be returned.",
        },
      };
    }
    return { ok: false, error: { code: "INTERNAL", message: msg } };
  } finally {
    unlisten?.();
  }
}

/** Best-effort command abort helper; used when stopping an agent mid-command. */
export async function execAbort(runId: string): Promise<boolean> {
  try {
    const data = await invoke<ExecAbortOutput>("exec_abort", { runId });
    return data.aborted;
  } catch {
    return false;
  }
}

/** Best-effort command stop helper; keeps command output and agent flow. */
export async function execStop(runId: string): Promise<boolean> {
  try {
    const data = await invoke<ExecStopOutput>("exec_stop", { runId });
    return data.stopped;
  } catch {
    return false;
  }
}
