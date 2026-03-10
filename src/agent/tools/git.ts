/**
 * Git tools — worktree management.
 *
 * git_worktree_init: called by the agent before its first file write.
 * Presents a custom approval card to the user who can name the branch;
 * on approval, asks the backend to create a worktree under the active app
 * store root, optionally runs the saved project setup command, and updates
 * AgentConfig.cwd to the returned path.
 */
import { invoke } from "@tauri-apps/api/core";
import { getAgentState, patchAgentState } from "../atoms";
import {
  requestWorktreeApproval,
  requestWorktreeSetupAction,
} from "../approvals";
import { execRun, type ExecRunOutput } from "./exec";
import type { ToolResult } from "../types";

export interface GitWorktreeInitInput {
  suggestedBranch: string;
}

export interface GitWorktreeSetupOutput {
  status: "not_configured" | "success" | "failed_continued";
  command?: string;
  cwd?: string;
  attemptCount?: number;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  truncatedStdout?: boolean;
  truncatedStderr?: boolean;
  terminatedByUser?: boolean;
  errorMessage?: string;
}

interface PendingGitWorktreeSetupOutput
  extends Omit<GitWorktreeSetupOutput, "status"> {
  status: "failed_pending";
}

type GitWorktreeSetupState =
  | GitWorktreeSetupOutput
  | PendingGitWorktreeSetupOutput;

export interface GitWorktreeInitOutput {
  alreadyExists?: boolean;
  declined?: boolean;
  path?: string;
  branch?: string;
  setup?: GitWorktreeSetupOutput;
}

type OutputStream = "stdout" | "stderr";
type OutputCallback = (stream: OutputStream, data: string) => void;

function sanitiseBranch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .replace(/--+/g, "-")
    .slice(0, 80) || "agent-branch";
}

function parseRemoteSlug(remoteUrl: string, fallbackName: string): string {
  const trimmed = remoteUrl.trim();
  const httpsMatch = trimmed.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = trimmed.match(/[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  return fallbackName;
}

function trimEdgeSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function updateWorktreeToolCall(
  tabId: string,
  toolCallId: string,
  patch: {
    status?: "awaiting_worktree" | "awaiting_setup_action" | "running";
    result?: unknown;
    streamingOutput?: string;
    argPatch?: Record<string, unknown>;
  },
): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    chatMessages: prev.chatMessages.map((message) =>
      message.toolCalls
        ? {
            ...message,
            toolCalls: message.toolCalls.map((toolCall) =>
              toolCall.id === toolCallId
                ? {
                    ...toolCall,
                    ...(patch.status ? { status: patch.status } : {}),
                    ...(patch.result !== undefined ? { result: patch.result } : {}),
                    ...(patch.streamingOutput !== undefined
                      ? { streamingOutput: patch.streamingOutput }
                      : {}),
                    ...(patch.argPatch
                      ? { args: { ...toolCall.args, ...patch.argPatch } }
                      : {}),
                  }
                : toolCall,
            ),
          }
        : message,
    ),
  }));
}

function getSetupCommand(tabId: string): string {
  return getAgentState(tabId).config.setupCommand?.trim() ?? "";
}

function getSetupShell(command: string): { command: string; args: string[] } {
  const platform = (navigator.platform ?? "").toLowerCase();
  if (platform.includes("win")) {
    return { command: "cmd.exe", args: ["/C", command] };
  }
  return { command: "sh", args: ["-lc", command] };
}

function getSetupFailureMessage(
  exitCode: number | undefined,
  terminatedByUser: boolean | undefined,
  fallback?: string,
): string {
  if (terminatedByUser) {
    return "Setup command was stopped.";
  }
  if (typeof exitCode === "number") {
    return `Setup command exited with code ${exitCode}.`;
  }
  return fallback ?? "Setup command failed.";
}

function buildSetupFailure(
  command: string,
  cwd: string,
  attemptCount: number,
  errorMessage: string,
): PendingGitWorktreeSetupOutput {
  return {
    status: "failed_pending",
    command,
    cwd,
    attemptCount,
    stdout: "",
    stderr: errorMessage,
    errorMessage,
  };
}

function buildSetupStateFromExecOutput(
  setupCommand: string,
  output: ExecRunOutput,
  attemptCount: number,
): GitWorktreeSetupState {
  const base = {
    command: setupCommand,
    cwd: output.cwd,
    attemptCount,
    exitCode: output.exitCode,
    durationMs: output.durationMs,
    stdout: output.stdout,
    stderr: output.stderr,
    truncatedStdout: output.truncatedStdout,
    truncatedStderr: output.truncatedStderr,
    terminatedByUser: output.terminatedByUser,
  };

  if (output.terminatedByUser || output.exitCode !== 0) {
    return {
      ...base,
      status: "failed_pending",
      errorMessage: getSetupFailureMessage(
        output.exitCode,
        output.terminatedByUser,
      ),
    };
  }

  return {
    ...base,
    status: "success",
  };
}

async function runSetupAttempt(
  tabId: string,
  toolCallId: string,
  worktreePath: string,
  setupCommand: string,
  attemptCount: number,
  onSetupOutput?: OutputCallback,
): Promise<GitWorktreeSetupState> {
  if (attemptCount > 1) {
    onSetupOutput?.(
      "stdout",
      `\nRetrying setup command (attempt ${attemptCount})...\n`,
    );
  }

  const shell = getSetupShell(setupCommand);
  const result = await execRun(
    worktreePath,
    {
      command: shell.command,
      args: shell.args,
      runId: toolCallId,
    },
    onSetupOutput,
  );

  if (!result.ok) {
    const errorMessage =
      result.error.code === "TIMEOUT"
        ? "Setup command timed out."
        : result.error.message;
    return buildSetupFailure(
      setupCommand,
      worktreePath,
      attemptCount,
      errorMessage,
    );
  }

  return buildSetupStateFromExecOutput(
    setupCommand,
    result.data,
    attemptCount,
  );
}

export async function gitWorktreeInit(
  tabId: string,
  toolCallId: string,
  agentCwd: string,
  input: GitWorktreeInitInput,
  onSetupOutput?: OutputCallback,
): Promise<ToolResult<GitWorktreeInitOutput>> {
  const state = getAgentState(tabId);
  const config = state.config;

  if (config.worktreePath) {
    return {
      ok: true,
      data: {
        alreadyExists: true,
        path: config.worktreePath,
        branch: config.worktreeBranch,
      },
    };
  }

  if (config.worktreeDeclined) {
    return { ok: true, data: { declined: true } };
  }

  let repoRoot: string;
  try {
    const result = await invoke<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>("exec_run", {
      command: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: agentCwd,
      env: {},
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
      stdin: null,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Current workspace is not inside a git repository.",
        },
      };
    }
    repoRoot = result.stdout.trim();
  } catch (error) {
    return {
      ok: false,
      error: { code: "INTERNAL", message: `git rev-parse failed: ${error}` },
    };
  }

  const repoName = repoRoot.split("/").filter(Boolean).pop() ?? "repo";
  let slug = repoName;
  try {
    const result = await invoke<{ exitCode: number; stdout: string }>(
      "exec_run",
      {
        command: "git",
        args: ["remote", "get-url", "origin"],
        cwd: repoRoot,
        env: {},
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        stdin: null,
      },
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      slug = parseRemoteSlug(result.stdout, repoName);
    }
  } catch {
    // No remote — fall back to repo dir name.
  }

  const sanitised = sanitiseBranch(input.suggestedBranch || "agent-branch");
  const repoSlug = trimEdgeSlashes(slug) || repoName;
  updateWorktreeToolCall(tabId, toolCallId, {
    status: "awaiting_worktree",
    argPatch: {
      suggestedBranch: input.suggestedBranch,
      repoSlug,
      setupCommand: config.setupCommand ?? "",
    },
  });

  const { approved, branchName } = await requestWorktreeApproval(tabId, toolCallId);

  if (!approved) {
    patchAgentState(tabId, (prev) => ({
      ...prev,
      config: { ...prev.config, worktreeDeclined: true },
    }));
    return { ok: true, data: { declined: true } };
  }

  const finalBranch = sanitiseBranch(branchName || sanitised);
  let finalPath: string;

  try {
    const created = await invoke<{ path: string; branch: string }>(
      "git_worktree_add",
      {
        repoPath: repoRoot,
        repoSlug,
        branch: finalBranch,
      },
    );
    finalPath = created.path;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Failed to create worktree: ${error}`,
      },
    };
  }

  patchAgentState(tabId, (prev) => ({
    ...prev,
    config: {
      ...prev.config,
      cwd: finalPath,
      worktreePath: finalPath,
      worktreeBranch: finalBranch,
    },
  }));

  updateWorktreeToolCall(tabId, toolCallId, {
    status: "running",
    argPatch: {
      branch: finalBranch,
      worktreePath: finalPath,
    },
  });

  let attemptCount = 0;
  while (true) {
    const setupCommand = getSetupCommand(tabId);
    if (!setupCommand) {
      return {
        ok: true,
        data: {
          path: finalPath,
          branch: finalBranch,
          setup: { status: "not_configured" },
        },
      };
    }

    attemptCount += 1;
    updateWorktreeToolCall(tabId, toolCallId, {
      status: "running",
      argPatch: {
        setupCommand,
        setupPhase: "running_setup",
        setupAttemptCount: attemptCount,
      },
    });

    const setupAttempt = await runSetupAttempt(
      tabId,
      toolCallId,
      finalPath,
      setupCommand,
      attemptCount,
      onSetupOutput,
    );

    if (setupAttempt.status === "success") {
      return {
        ok: true,
        data: {
          path: finalPath,
          branch: finalBranch,
          setup: setupAttempt,
        },
      };
    }

    updateWorktreeToolCall(tabId, toolCallId, {
      status: "awaiting_setup_action",
      result: {
        path: finalPath,
        branch: finalBranch,
        setup: setupAttempt,
      },
      argPatch: {
        setupCommand,
        setupPhase: "setup_failed",
        setupAttemptCount: attemptCount,
      },
    });

    const { action } = await requestWorktreeSetupAction(tabId, toolCallId);

    if (action === "retry") {
      continue;
    }

    if (action === "abort") {
      return {
        ok: false,
        error: {
          code: "RUN_ABORTED",
          message: "User aborted the agent run after setup failed.",
          details: {
            path: finalPath,
            branch: finalBranch,
            setup: setupAttempt,
          },
        },
      };
    }

    return {
      ok: true,
      data: {
        path: finalPath,
        branch: finalBranch,
        setup: {
          ...setupAttempt,
          status: "failed_continued",
        },
      },
    };
  }
}
