/**
 * Git tools — worktree management.
 *
 * git_worktree_init: called by the agent before its first file write.
 * Presents a custom approval card to the user who can name the branch;
 * on approval, creates a worktree under ~/.rakh/worktrees/<owner>/<repo>/<branch>
 * and updates AgentConfig.cwd so all subsequent tool calls use the new path.
 */
import { invoke } from "@tauri-apps/api/core";
import { getAgentState, patchAgentState } from "../atoms";
import { requestWorktreeApproval } from "../approvals";
import type { ToolResult } from "../types";

export interface GitWorktreeInitInput {
  suggestedBranch: string;
}

export interface GitWorktreeInitOutput {
  alreadyExists?: boolean;
  declined?: boolean;
  path?: string;
  branch?: string;
}

/** Sanitise a branch name suggestion into something git-safe. */
function sanitiseBranch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .replace(/--+/g, "-")
    .slice(0, 80) || "agent-branch";
}

/**
 * Parse a git remote URL into an "owner/repo" slug.
 * Handles HTTPS (https://github.com/owner/repo.git) and
 * SSH (git@github.com:owner/repo.git) formats.
 * Falls back to just the repo name if parsing fails.
 */
function parseRemoteSlug(remoteUrl: string, fallbackName: string): string {
  const trimmed = remoteUrl.trim();
  // HTTPS: https://host/owner/repo[.git]
  const httpsMatch = trimmed.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];
  // SSH: git@host:owner/repo[.git]
  const sshMatch = trimmed.match(/[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  return fallbackName;
}

function trimTrailingSlash(path: string): string {
  if (!path || path === "/") return path;
  return path.replace(/\/+$/g, "");
}

export async function gitWorktreeInit(
  tabId: string,
  toolCallId: string,
  agentCwd: string,
  input: GitWorktreeInitInput,
): Promise<ToolResult<GitWorktreeInitOutput>> {
  const state = getAgentState(tabId);
  const config = state.config;

  // 1. Idempotent — already set up
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

  // 2. User already declined — don't ask again
  if (config.worktreeDeclined) {
    return { ok: true, data: { declined: true } };
  }

  // 3. Detect git repo root
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
  } catch (e) {
    return {
      ok: false,
      error: { code: "INTERNAL", message: `git rev-parse failed: ${e}` },
    };
  }

  // 4. Derive owner/repo slug from remote URL
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
    // No remote — fall back to repo dir name
  }

  // 5. Build worktree path proposal
  const sanitised = sanitiseBranch(input.suggestedBranch || "agent-branch");
  const home =
    typeof window !== "undefined"
      ? (window as unknown as { __EVE_HOME__?: string }).__EVE_HOME__
      : undefined;
  // Use HOME env via a quick invoke if needed; fall back to a known path
  let homeDir = home ?? "";
  if (!homeDir) {
    try {
      const r = await invoke<{ exitCode: number; stdout: string }>("exec_run", {
        command: "sh",
        args: ["-c", "echo $HOME"],
        cwd: repoRoot,
        env: {},
        timeoutMs: 5_000,
        maxStdoutBytes: 512,
        maxStderrBytes: 512,
        stdin: null,
      });
      homeDir = r.stdout.trim();
    } catch {
      homeDir = "~";
    }
  }
  // 6. Update the tool call display status so the UI renders the custom card,
  //    then block until the user makes a decision.
  patchAgentState(tabId, (prev) => ({
    ...prev,
    chatMessages: prev.chatMessages.map((m) =>
      m.toolCalls
        ? {
            ...m,
            toolCalls: m.toolCalls.map((t) =>
              t.id === toolCallId
                ? { ...t, status: "awaiting_worktree" as const }
                : t,
            ),
          }
        : m,
    ),
  }));

  const { approved, branchName } = await requestWorktreeApproval(toolCallId);

  // 7. User declined
  if (!approved) {
    patchAgentState(tabId, (prev) => ({
      ...prev,
      config: { ...prev.config, worktreeDeclined: true },
    }));
    return { ok: true, data: { declined: true } };
  }

  // 8. Create the worktree
  const finalBranch = sanitiseBranch(branchName || sanitised);
  const baseHome = trimTrailingSlash(homeDir);
  const slugClean = slug.replace(/^\/+|\/+$/g, "");
  const finalPath = trimTrailingSlash(
    `${baseHome}/.rakh/worktrees/${slugClean}/${finalBranch}`,
  );

  try {
    await invoke("git_worktree_add", {
      repoPath: repoRoot,
      worktreePath: finalPath,
      branch: finalBranch,
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Failed to create worktree: ${e}`,
      },
    };
  }

  // 9. Update AgentConfig — cwd switches to the new worktree
  patchAgentState(tabId, (prev) => ({
    ...prev,
    config: {
      ...prev.config,
      cwd: finalPath,
      worktreePath: finalPath,
      worktreeBranch: finalBranch,
    },
  }));

  return {
    ok: true,
    data: { path: finalPath, branch: finalBranch },
  };
}
