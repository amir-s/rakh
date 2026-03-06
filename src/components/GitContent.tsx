import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/utils/cn";

/* ─────────────────────────────────────────────────────────────────────────────
   Types
───────────────────────────────────────────────────────────────────────────── */

interface GitFile {
  path: string;
  /** Raw two-char porcelain status, e.g. "M ", " M", "??", "A ", "R " */
  xy: string;
}

interface GitStatus {
  branch: string;
  staged: GitFile[];
  unstaged: GitFile[];
}

type OpStatus =
  | { type: "idle" }
  | { type: "running"; label: string }
  | { type: "ok"; label: string }
  | { type: "error"; message: string };

/* ─────────────────────────────────────────────────────────────────────────────
   Git helpers
───────────────────────────────────────────────────────────────────────────── */

async function gitRun(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; output: string; rawStdout: string }> {
  try {
    const r = await invoke<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>("exec_run", {
      command: "git",
      args,
      cwd,
      env: {},
      timeoutMs: 30_000,
      maxStdoutBytes: 200_000,
      maxStderrBytes: 20_000,
      stdin: null,
    });
    return {
      ok: r.exitCode === 0,
      output: (r.stdout + r.stderr).trim(),
      rawStdout: r.stdout,
    };
  } catch (e) {
    return { ok: false, output: String(e), rawStdout: "" };
  }
}

async function ghRun(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  try {
    const r = await invoke<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>("exec_run", {
      command: "gh",
      args,
      cwd,
      env: {},
      timeoutMs: 60_000,
      maxStdoutBytes: 20_000,
      maxStderrBytes: 20_000,
      stdin: null,
    });
    return { ok: r.exitCode === 0, output: (r.stdout + r.stderr).trim() };
  } catch (e) {
    return { ok: false, output: String(e) };
  }
}

/** Parse `git status --porcelain` into staged / unstaged file lists. */
function parseGitStatus(raw: string): {
  staged: GitFile[];
  unstaged: GitFile[];
} {
  const staged: GitFile[] = [];
  const unstaged: GitFile[] = [];

  for (const line of raw.split("\n")) {
    if (line.length < 3) continue;
    const x = line[0]; // index (staged) status
    const y = line[1]; // working-tree (unstaged) status
    let filePath = line.slice(3);

    // Renamed: "R  old-path -> new-path" — take the part after " -> "
    if ((x === "R" || x === "C") && filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ")[1];
    }

    const xy = x + y;

    // Staged: index column is not space or '?'
    if (x !== " " && x !== "?") {
      staged.push({ path: filePath, xy });
    }

    // Unstaged / untracked: working-tree column is not space
    if (y !== " " && xy !== "??") {
      // Untracked files appear in unstaged section separately below
      unstaged.push({ path: filePath, xy });
    }

    // Untracked
    if (xy === "??") {
      unstaged.push({ path: filePath, xy });
    }
  }

  return { staged, unstaged };
}

/** Friendly label for a two-char porcelain status. */
function statusLabel(xy: string): string {
  const x = xy[0];
  const y = xy[1];
  if (xy === "??") return "untracked";
  const col = x !== " " && x !== "?" ? x : y;
  switch (col) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return col;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Sub-components
───────────────────────────────────────────────────────────────────────────── */

function Checkbox({
  checked,
  onClick,
}: {
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "w-3.5 h-3.5 shrink-0 rounded-sm border flex items-center justify-center cursor-default transition-colors",
        checked
          ? "bg-primary-dim border-primary-border"
          : "border-border-mid bg-transparent",
      )}
    >
      {checked && (
        <svg
          width={8}
          height={8}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-primary"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )}
    </div>
  );
}

interface FileListProps {
  files: GitFile[];
  staged: boolean;
  /** Called when user clicks a checkbox row */
  onToggle: (file: GitFile) => void;
  disabled: boolean;
}

function FileList({ files, staged, onToggle, disabled }: FileListProps) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-xxs font-bold tracking-widest uppercase text-muted mb-1.5">
        {staged ? "Staged" : "Unstaged"} Changes ({files.length})
      </div>
      {files.map((f) => (
        <div
          key={f.path}
          className={cn(
            "flex items-center gap-2 px-1.5 py-1 rounded hover:bg-subtle/40 transition-colors group",
            disabled && "opacity-50 pointer-events-none",
          )}
        >
          <Checkbox checked={staged} onClick={() => onToggle(f)} />
          <span
            className="flex-1 min-w-0 text-xs font-mono text-text truncate"
            title={f.path}
          >
            {f.path}
          </span>
          <span className="text-xxs text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            {statusLabel(f.xy)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   GitContent
───────────────────────────────────────────────────────────────────────────── */

export interface GitContentProps {
  /** The path to run git commands in (worktreePath if set, otherwise cwd) */
  gitPath: string;
  /** Branch name from agent config (may be empty if not a worktree session) */
  configBranch?: string;
}

export default function GitContent({ gitPath, configBranch }: GitContentProps) {
  const [loading, setLoading] = useState(true);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [opStatus, setOpStatus] = useState<OpStatus>({ type: "idle" });
  const [toggling, setToggling] = useState<string | null>(null);

  /* ── fetch git status ── */
  const fetchStatus = useCallback(async () => {
    if (!gitPath) return;

    // Detect git repo
    const revParse = await gitRun(gitPath, ["rev-parse", "--show-toplevel"]);

    if (!revParse.ok) {
      setIsGitRepo(false);
      setLoading(false);
      return;
    }
    setIsGitRepo(true);

    // Get current branch
    const branchRes = await gitRun(gitPath, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const branch = branchRes.ok ? branchRes.output : (configBranch ?? "");

    // Get status — use rawStdout to preserve leading spaces in porcelain format
    const statusRes = await gitRun(gitPath, ["status", "--porcelain"]);
    const { staged, unstaged } = statusRes.ok
      ? parseGitStatus(statusRes.rawStdout)
      : { staged: [], unstaged: [] };

    setGitStatus({ branch, staged, unstaged });
    setLoading(false);
  }, [gitPath, configBranch]);

  useEffect(() => {
    setLoading(true);
    setGitStatus(null);
    fetchStatus();
  }, [fetchStatus]);

  /* ── run a git operation ── */
  const runOp = async (
    label: string,
    fn: () => Promise<{ ok: boolean; output: string }>,
  ) => {
    setOpStatus({ type: "running", label });
    const result = await fn();
    setOpStatus(
      result.ok
        ? { type: "ok", label: result.output || `${label} succeeded` }
        : { type: "error", message: result.output || `${label} failed` },
    );
    await fetchStatus();
  };

  /* ── toggle a file's staged state ── */
  const handleToggle = async (file: GitFile, currentlyStaged: boolean) => {
    if (toggling || opStatus.type === "running") return;
    setToggling(file.path);
    try {
      if (currentlyStaged) {
        await gitRun(gitPath, ["restore", "--staged", file.path]);
      } else {
        await gitRun(gitPath, ["add", file.path]);
      }
      await fetchStatus();
    } finally {
      setToggling(null);
    }
  };

  /* ── commit ── */
  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    await runOp("Committing", async () => {
      const result = await gitRun(gitPath, ["commit", "-m", commitMsg.trim()]);
      if (result.ok) setCommitMsg("");
      return result;
    });
  };

  /* ── push ── */
  const handlePush = () => {
    const branch = gitStatus?.branch ?? "";
    runOp("Pushing", () => gitRun(gitPath, ["push", "-u", "origin", branch]));
  };

  /* ── create PR ── */
  const handlePR = () => {
    runOp("Creating PR", () => ghRun(gitPath, ["pr", "create", "--fill"]));
  };

  const isRunning = opStatus.type === "running" || toggling !== null;
  const branch = gitStatus?.branch ?? configBranch ?? "";

  /* ── empty/loading states ── */
  if (!gitPath) {
    return (
      <div className="artifact-tab-content">
        <p className="text-muted italic text-sm text-center mt-10">
          No workspace selected.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="artifact-tab-content">
        <p className="text-muted italic text-sm text-center mt-10">
          Detecting git repository…
        </p>
      </div>
    );
  }

  if (!isGitRepo) {
    return (
      <div className="artifact-tab-content">
        <p className="text-muted italic text-sm text-center mt-10">
          Not a git repository.
        </p>
      </div>
    );
  }

  const { staged = [], unstaged = [] } = gitStatus ?? {};
  const hasChanges = staged.length > 0 || unstaged.length > 0;

  return (
    <div className="artifact-tab-content flex flex-col gap-4">
      {/* ── Branch header ── */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="material-symbols-outlined text-primary text-base">
            account_tree
          </span>
          <span className="text-xs font-mono font-semibold text-primary truncate">
            {branch || "detached HEAD"}
          </span>
        </div>
        {/* Refresh button */}
        <button
          onClick={() => {
            setLoading(true);
            fetchStatus();
          }}
          disabled={isRunning}
          title="Refresh git status"
          className="flex items-center justify-center w-6 h-6 rounded text-muted hover:text-text hover:bg-subtle/50 transition-colors disabled:opacity-40"
        >
          <span className="material-symbols-outlined text-sm">refresh</span>
        </button>
      </div>

      {/* ── File lists ── */}
      {!hasChanges ? (
        <p className="text-muted italic text-sm text-center mt-4">
          Working tree is clean.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <FileList
            files={staged}
            staged={true}
            onToggle={(f) => handleToggle(f, true)}
            disabled={isRunning}
          />
          <FileList
            files={unstaged}
            staged={false}
            onToggle={(f) => handleToggle(f, false)}
            disabled={isRunning}
          />
        </div>
      )}

      {/* ── Commit area ── */}
      <div className="flex flex-col gap-2 mt-auto pt-2 border-t border-border-subtle">
        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCommit();
          }}
          rows={2}
          disabled={isRunning}
          className="resize-none w-full bg-inset border border-border-mid rounded py-1.5 px-2 text-xs font-mono outline-none placeholder:text-muted placeholder:opacity-50 disabled:opacity-50 transition-colors focus:border-primary-border"
          placeholder="Commit message (⌘↩ to commit)…"
        />
        <button
          className="msg-btn msg-btn--allow justify-center w-full"
          onClick={handleCommit}
          disabled={!commitMsg.trim() || isRunning || staged.length === 0}
        >
          <span className="material-symbols-outlined text-base mr-1">
            commit
          </span>
          COMMIT TO {branch ? branch.toUpperCase() : "BRANCH"}
        </button>

        {/* ── Secondary actions ── */}
        <div className="flex gap-1.5">
          <button
            className="msg-btn msg-btn--deny justify-center flex-1"
            onClick={handlePush}
            disabled={isRunning}
          >
            <span className="material-symbols-outlined text-base mr-1">
              upload
            </span>
            PUSH
          </button>
          <button
            className="msg-btn msg-btn--deny justify-center flex-1"
            onClick={handlePR}
            disabled={isRunning}
          >
            <span className="material-symbols-outlined text-base mr-1">
              call_merge
            </span>
            CREATE PR
          </button>
        </div>
      </div>

      {/* ── Operation status strip ── */}
      {opStatus.type !== "idle" && (
        <div
          className={cn(
            "px-2.5 py-2 rounded-[5px] text-xs font-mono whitespace-pre-wrap break-all border",
            opStatus.type === "error"
              ? "bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)] text-error border-[color-mix(in_srgb,var(--color-error)_30%,transparent)]"
              : opStatus.type === "ok"
                ? "bg-inset text-success border-border-subtle"
                : "bg-inset text-muted border-border-subtle",
          )}
        >
          {opStatus.type === "running" && `⏳ ${opStatus.label}…`}
          {opStatus.type === "ok" && `✓ ${opStatus.label}`}
          {opStatus.type === "error" && `✗ ${opStatus.message}`}
        </div>
      )}
    </div>
  );
}
