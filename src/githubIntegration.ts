import { execRun } from "@/agent/tools/exec";

export type GitHubRepoProbeReason =
  | "eligible"
  | "not_git"
  | "missing_origin"
  | "not_github"
  | "error";

export interface GitHubRepoProbeResult {
  eligible: boolean;
  reason: GitHubRepoProbeReason;
  repoRoot: string | null;
  repoSlug: string | null;
  remoteUrl: string | null;
}

function trimGitSuffix(path: string): string {
  return path.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
}

export function parseGitHubRepoSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const slug = trimGitSuffix(parsed.pathname);
    return slug || null;
  } catch {
    // fall back to SCP-style remote parsing
  }

  const scpMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (!scpMatch) return null;
  if (scpMatch[1]?.toLowerCase() !== "github.com") return null;

  const slug = trimGitSuffix(scpMatch[2] ?? "");
  return slug || null;
}

export function getGitHubRepoUnavailableMessage(
  probe: GitHubRepoProbeResult | null,
): string {
  if (!probe) {
    return "Checking whether this project is a GitHub repository.";
  }
  switch (probe.reason) {
    case "not_git":
      return "GitHub integration is unavailable because this project is not a git repository.";
    case "missing_origin":
      return "GitHub integration is unavailable because this project has no origin remote.";
    case "not_github":
      return "GitHub integration is unavailable because this project is not connected to GitHub.";
    case "error":
      return "GitHub integration is unavailable right now.";
    case "eligible":
    default:
      return "Show recent GitHub issues from this repository in the command bar.";
  }
}

export async function probeGitHubRepository(
  cwd: string,
): Promise<GitHubRepoProbeResult> {
  const repoRootResult = await execRun(cwd, {
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    timeoutMs: 10_000,
    maxStdoutBytes: 8_000,
    maxStderrBytes: 8_000,
  });

  if (!repoRootResult.ok || repoRootResult.data.exitCode !== 0) {
    return {
      eligible: false,
      reason: "not_git",
      repoRoot: null,
      repoSlug: null,
      remoteUrl: null,
    };
  }

  const repoRoot = repoRootResult.data.stdout.trim();
  if (!repoRoot) {
    return {
      eligible: false,
      reason: "error",
      repoRoot: null,
      repoSlug: null,
      remoteUrl: null,
    };
  }

  const remoteResult = await execRun(repoRoot, {
    command: "git",
    args: ["remote", "get-url", "origin"],
    timeoutMs: 10_000,
    maxStdoutBytes: 8_000,
    maxStderrBytes: 8_000,
  });

  if (!remoteResult.ok || remoteResult.data.exitCode !== 0) {
    return {
      eligible: false,
      reason: "missing_origin",
      repoRoot,
      repoSlug: null,
      remoteUrl: null,
    };
  }

  const remoteUrl = remoteResult.data.stdout.trim();
  if (!remoteUrl) {
    return {
      eligible: false,
      reason: "missing_origin",
      repoRoot,
      repoSlug: null,
      remoteUrl: null,
    };
  }

  const repoSlug = parseGitHubRepoSlug(remoteUrl);
  if (!repoSlug) {
    return {
      eligible: false,
      reason: "not_github",
      repoRoot,
      repoSlug: null,
      remoteUrl,
    };
  }

  return {
    eligible: true,
    reason: "eligible",
    repoRoot,
    repoSlug,
    remoteUrl,
  };
}
