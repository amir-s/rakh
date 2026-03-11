import {
  resolveApproval,
  resolveBranchReleaseAction,
  resolveWorktreeApproval,
  resolveWorktreeSetupAction,
  setApprovalReason,
} from "@/agent/approvals";
import { useState, useEffect, useRef } from "react";
import { execRun } from "@/agent/tools/exec";
import { useStopAgent, useStopRunningExecToolCall } from "@/agent/useAgents";
import PatchPreview from "@/components/PatchPreview";
import CopyableCodePill from "@/components/CopyableCodePill";
import type { ToolCallDisplay } from "@/agent/types";
import {
  buildEditFileDiffFiles,
  buildWriteFileDiffFiles,
} from "@/components/patchDiffFiles";
import type { EditFileChange } from "@/agent/tools/workspace";
import type { DiffFile } from "@/components/DiffViewer";
import { deserializeDiff } from "@/components/diffSerialization";
import {
  getChatAttentionTargetProps,
  getToolCallAttentionTargetKind,
} from "@/components/autoScrollAttention";
import { Badge, Button, TextField } from "@/components/ui";
import { getToolCallIcon, getToolCallLabel } from "@/components/toolDisplay";
import { cn } from "@/utils/cn";

/* ─────────────────────────────────────────────────────────────────────────────
   ToolCallApproval — rendered when a tool call is in "awaiting_approval" state.
   Generic approval card for tool args and pending actions.
───────────────────────────────────────────────────────────────────────────── */

/** Render a single arg value — keeps strings unquoted, objects as compact JSON. */
function renderArgValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return JSON.stringify(value, null, 2);
}

/**
 * Renders the constructed command for exec_run approval cards.
 */
function ExecRunContent({ args }: { args: Record<string, unknown> }) {
  const cmd = typeof args.command === "string" ? args.command : "";
  const argsList = Array.isArray(args.args) ? (args.args as string[]) : [];
  const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
  const reason = typeof args.reason === "string" ? args.reason : undefined;
  const fullCommand = [cmd, ...argsList].filter(Boolean).join(" ");

  return (
    <div className="cmd-block border-b border-border-subtle">
      {reason && (
        <div className="cmd-prompt opacity-80">
          <span className="cmd-sigil font-bold">&gt;</span>
          <span className="cmd-text text-muted">{reason}</span>
        </div>
      )}
      <div className="cmd-prompt">
        <span className="cmd-sigil">$</span>
        <span className="cmd-text">{fullCommand}</span>
      </div>
      {cwd && (
        <div className="cmd-cwd">
          <span className="material-symbols-outlined text-xs cmd-cwd-icon">
            folder_open
          </span>
          {cwd}
        </div>
      )}
    </div>
  );
}

/**
 * Renders a diff preview for workspace_editFile approval cards.
 */
function EditFileDiffContent({
  tc,
  cwd,
}: {
  tc: ToolCallDisplay;
  cwd?: string;
}) {
  const path = tc.args.path;
  const changes = tc.args.changes;
  const [diffFiles, setDiffFiles] = useState<DiffFile[] | null>(
    tc.originalDiffFiles?.map(deserializeDiff) ?? null,
  );

  const filePath = typeof path === "string" ? path : null;
  const changeList = Array.isArray(changes)
    ? (changes as EditFileChange[])
    : null;

  useEffect(() => {
    if (tc.originalDiffFiles) return;
    if (!filePath || !changeList) return;
    let cancelled = false;
    buildEditFileDiffFiles(filePath, changeList, cwd).then((files) => {
      if (!cancelled) setDiffFiles(files);
    });
    return () => {
      cancelled = true;
    };
  }, [tc.originalDiffFiles, filePath, changeList, cwd]);

  if (!filePath || !changeList) {
    return (
      <div className="px-3 py-2.5 border-b border-border-subtle text-xs font-mono text-muted">
        (invalid args)
      </div>
    );
  }

  if (!diffFiles) {
    // Fallback: show path + change count while diff loads
    return (
      <div className="px-3 py-2.5 border-b border-border-subtle flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-xs font-mono">
          <Badge variant="primary" className="tool-approval-tag">
            EDIT
          </Badge>
          <span className="text-text break-all">{filePath}</span>
          <span className="text-muted text-xxs">
            ({changeList.length} change{changeList.length !== 1 ? "s" : ""})
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-border-subtle">
      <PatchPreview files={diffFiles} />
    </div>
  );
}

/**
 * Renders a diff preview for workspace_writeFile approval cards.
 */
function WriteFileDiffContent({
  tc,
  cwd,
}: {
  tc: ToolCallDisplay;
  cwd?: string;
}) {
  const path = tc.args.path;
  const content = tc.args.content;
  const overwrite = tc.args.overwrite;
  const [diffFiles, setDiffFiles] = useState<DiffFile[] | null>(
    tc.originalDiffFiles?.map(deserializeDiff) ?? null,
  );

  const filePath = typeof path === "string" ? path : null;
  const fileContent = typeof content === "string" ? content : "";
  const isOverwrite = overwrite === true;

  useEffect(() => {
    if (tc.originalDiffFiles) return;
    if (!filePath) return;
    let cancelled = false;
    buildWriteFileDiffFiles(filePath, fileContent, isOverwrite, cwd).then(
      (files) => {
        if (!cancelled) setDiffFiles(files);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tc.originalDiffFiles, filePath, fileContent, isOverwrite, cwd]);

  if (!filePath) {
    return (
      <div className="px-3 py-2.5 border-b border-border-subtle text-xs font-mono text-muted">
        (invalid args)
      </div>
    );
  }

  if (!diffFiles) {
    return (
      <div className="px-3 py-2.5 border-b border-border-subtle flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-xs font-mono">
          <Badge variant="success" className="tool-approval-tag">
            {isOverwrite ? "OVERWRITE" : "CREATE"}
          </Badge>
          <span className="text-text break-all">{filePath}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-border-subtle">
      <PatchPreview files={diffFiles} />
    </div>
  );
}

interface ToolCallApprovalProps {
  toolCall: ToolCallDisplay;
  cwd?: string;
  tabId: string;
  onOpenProjectSettings?: () => void;
}

function renderWorktreeSetupOutput(
  toolCall: ToolCallDisplay,
  activeSetup: Record<string, unknown> | null,
) {
  if (toolCall.streamingOutput) {
    return <pre className="cmd-output mt-1">{toolCall.streamingOutput}</pre>;
  }

  const stdout =
    typeof activeSetup?.stdout === "string" ? activeSetup.stdout.trimEnd() : "";
  const stderr =
    typeof activeSetup?.stderr === "string" ? activeSetup.stderr.trimEnd() : "";

  if (!stdout && !stderr) return null;

  return (
    <>
      {stdout ? <pre className="cmd-output mt-1">{stdout}</pre> : null}
      {stderr ? (
        <pre className="cmd-output cmd-output--error mt-1">{stderr}</pre>
      ) : null}
    </>
  );
}

function renderWorktreeSetupCommand({
  activeSetup,
  isVisible,
  setupCommand,
  setupCwd,
  toolCall,
}: {
  activeSetup: Record<string, unknown> | null;
  isVisible: boolean;
  setupCommand: string;
  setupCwd: string | null;
  toolCall: ToolCallDisplay;
}) {
  if (!isVisible) return null;
  return (
    <div className="cmd-block border-b border-border-subtle">
      <div className="cmd-prompt">
        <span className="cmd-sigil">$</span>
        <span className="cmd-text">{setupCommand || "(no setup command)"}</span>
      </div>
      {setupCwd ? (
        <div className="cmd-cwd">
          <span className="material-symbols-outlined text-xs cmd-cwd-icon">
            folder_open
          </span>
          {setupCwd}
        </div>
      ) : null}
      {renderWorktreeSetupOutput(toolCall, activeSetup)}
    </div>
  );
}

function WorktreeSetupFailureCard({
  activeSetup,
  configuredBranch,
  configuredPath,
  id,
  onOpenProjectSettings,
  setupCommand,
  setupCwd,
  setupFailureMessage,
  tabId,
  toolCall,
}: {
  activeSetup: Record<string, unknown> | null;
  configuredBranch: string;
  configuredPath: string | null;
  id: string;
  onOpenProjectSettings?: () => void;
  setupCommand: string;
  setupCwd: string | null;
  setupFailureMessage: string | null;
  tabId: string;
  toolCall: ToolCallDisplay;
}) {
  const [countdownPaused, setCountdownPaused] = useState(false);
  const [countdownSeconds, setCountdownSeconds] = useState(5);
  const attentionTargetProps = getChatAttentionTargetProps(
    getToolCallAttentionTargetKind(toolCall),
  );

  useEffect(() => {
    if (countdownPaused) return;

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const remaining = Math.max(0, 5 - elapsed);
      setCountdownSeconds(remaining);
      if (remaining === 0) {
        window.clearInterval(timer);
        resolveWorktreeSetupAction(tabId, id, "continue");
      }
    }, 200);

    return () => window.clearInterval(timer);
  }, [countdownPaused, id, tabId]);

  return (
    <div className="msg-card animate-fade-up mt-1.5" {...attentionTargetProps}>
      <div className="msg-card-head">
        <div className="msg-card-label">
          <span className="material-symbols-outlined text-base text-warning">
            warning
          </span>
          SETUP FAILED
        </div>
        <div className="text-xxs text-muted font-mono opacity-60">
          git_worktree_init
        </div>
      </div>

      <div className="px-3 py-2.5 border-b border-border-subtle">
        <div className="text-xs text-text leading-[1.6]">
          Branch{" "}
          <span className="font-mono">{configuredBranch || "(pending)"}</span>
          {configuredPath ? (
            <>
              {" "}
              is ready at{" "}
              <span className="font-mono break-all">{configuredPath}</span>.
            </>
          ) : (
            "."
          )}
        </div>
        {setupFailureMessage ? (
          <div className="text-xxs text-error mt-1">{setupFailureMessage}</div>
        ) : null}
      </div>

      {renderWorktreeSetupCommand({
        activeSetup,
        isVisible: true,
        setupCommand,
        setupCwd,
        toolCall,
      })}

      <div className="px-3 py-2 border-b border-border-subtle text-xxs text-muted">
        {countdownPaused
          ? "Auto-continue paused while editing the setup command."
          : `Continuing without setup in ${countdownSeconds}s unless you choose an action.`}
      </div>

      <div className="msg-card-footer">
        <Button
          variant="secondary"
          size="xxs"
          onClick={() => resolveWorktreeSetupAction(tabId, id, "retry")}
        >
          RETRY
        </Button>
        {onOpenProjectSettings ? (
          <Button
            variant="ghost"
            size="xxs"
            onClick={() => {
              setCountdownPaused(true);
              onOpenProjectSettings();
            }}
          >
            EDIT COMMAND
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="xxs"
          onClick={() => resolveWorktreeSetupAction(tabId, id, "continue")}
        >
          CONTINUE
        </Button>
        <Button
          variant="danger"
          size="xxs"
          onClick={() => resolveWorktreeSetupAction(tabId, id, "abort")}
        >
          ABORT
        </Button>
      </div>
    </div>
  );
}

function WorktreeToolCard({
  toolCall,
  tabId,
  onOpenProjectSettings,
}: {
  toolCall: ToolCallDisplay;
  tabId: string;
  onOpenProjectSettings?: () => void;
}) {
  const { id, args } = toolCall;
  const suggested =
    typeof args.suggestedBranch === "string" ? args.suggestedBranch : "";
  const repoSlug =
    typeof args.repoSlug === "string" && args.repoSlug.trim()
      ? args.repoSlug.replace(/^\/+|\/+$/g, "")
      : "repo";
  const setupCommand =
    typeof args.setupCommand === "string" ? args.setupCommand.trim() : "";
  const setupPhase =
    typeof args.setupPhase === "string" ? args.setupPhase : "approval";
  const branchError =
    typeof args.branchError === "string" ? args.branchError.trim() : "";
  const configuredBranch =
    typeof args.branch === "string" && args.branch.trim()
      ? args.branch
      : suggested;
  const configuredPath =
    typeof args.worktreePath === "string" && args.worktreePath.trim()
      ? args.worktreePath
      : null;
  const [branch, setBranch] = useState(suggested);
  const stopAgent = useStopAgent();
  const stopRunningExecToolCall = useStopRunningExecToolCall();

  useEffect(() => {
    setBranch(suggested);
  }, [suggested]);

  const resultRecord =
    toolCall.result && typeof toolCall.result === "object"
      ? (toolCall.result as Record<string, unknown>)
      : null;
  const setupRecord =
    resultRecord?.setup && typeof resultRecord.setup === "object"
      ? (resultRecord.setup as Record<string, unknown>)
      : null;
  const setupErrorRecord =
    resultRecord?.details &&
    typeof resultRecord.details === "object" &&
    (resultRecord.details as Record<string, unknown>).setup &&
    typeof (resultRecord.details as Record<string, unknown>).setup === "object"
      ? ((resultRecord.details as Record<string, unknown>).setup as Record<
          string,
          unknown
        >)
      : null;
  const activeSetup = setupRecord ?? setupErrorRecord;
  const setupStatus =
    typeof activeSetup?.status === "string" ? activeSetup.status : null;
  const setupCwd =
    typeof activeSetup?.cwd === "string" ? activeSetup.cwd : configuredPath;
  const setupFailureMessage =
    typeof activeSetup?.errorMessage === "string"
      ? activeSetup.errorMessage
      : null;
  const isAwaitingSetupAction = toolCall.status === "awaiting_setup_action";
  const isSetupRunning = setupPhase === "running_setup";
  const isSetupPhaseVisible = setupCommand.length > 0 || isSetupRunning;
  const attentionTargetProps = getChatAttentionTargetProps(
    getToolCallAttentionTargetKind(toolCall),
  );

  if (toolCall.status === "awaiting_worktree") {
    return (
      <div className="msg-card animate-fade-up mt-1.5" {...attentionTargetProps}>
        <div className="msg-card-head">
          <div className="msg-card-label">
            <span className="material-symbols-outlined text-base">
              account_tree
            </span>
            CREATE ISOLATED BRANCH
          </div>
          <div className="text-xxs text-muted font-mono opacity-60">
            git_worktree_init
          </div>
        </div>

        <div className="px-3 py-2.5 border-b border-border-subtle">
          <div className="text-xs text-muted font-mono mb-1.5">Branch name</div>
          <TextField
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="w-full bg-inset py-1.25 px-2 text-xs font-mono"
            wrapClassName="border border-border-mid rounded"
            placeholder="feat/my-branch"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                resolveWorktreeApproval(
                  tabId,
                  id,
                  true,
                  branch.trim() || suggested,
                );
              }
            }}
          />
          <div className="text-xxs text-muted font-mono mt-1.25 opacity-60">
            A worktree will be created under worktrees/{repoSlug}/
            {branch.trim() || suggested || "branch"}
          </div>
          <div className="text-xxs text-muted font-mono mt-1 opacity-60">
            The worktree starts detached and will only hold this branch when the
            agent needs to write or hand off changes.
          </div>
          {branchError ? (
            <div className="text-xxs text-error font-mono mt-1.5">
              {branchError}
            </div>
          ) : null}
          {setupCommand ? (
            <div className="text-xxs text-muted font-mono mt-1.5 opacity-75">
              Setup command: <span className="text-text">{setupCommand}</span>
            </div>
          ) : null}
        </div>

        <div className="msg-card-footer">
          <Button
            variant="ghost"
            size="xxs"
            onClick={() => resolveWorktreeApproval(tabId, id, false, "")}
          >
            WORK IN MAIN REPO
          </Button>
          <Button
            variant="primary"
            size="xxs"
            onClick={() =>
              resolveWorktreeApproval(
                tabId,
                id,
                true,
                branch.trim() || suggested,
              )
            }
          >
            CREATE BRANCH
          </Button>
        </div>
      </div>
    );
  }

  if (isAwaitingSetupAction) {
    return (
      <WorktreeSetupFailureCard
        key={`${id}:${String(args.setupAttemptCount ?? 0)}`}
        activeSetup={activeSetup}
        configuredBranch={configuredBranch}
        configuredPath={configuredPath}
        id={id}
        onOpenProjectSettings={onOpenProjectSettings}
        setupCommand={setupCommand}
        setupCwd={setupCwd}
        setupFailureMessage={setupFailureMessage}
        tabId={tabId}
        toolCall={toolCall}
      />
    );
  }

  return (
    <div className="msg-card animate-fade-up mt-1.5" {...attentionTargetProps}>
      <div className="msg-card-head">
        <div className="msg-card-label">
          <span className="material-symbols-outlined text-base">
            account_tree
          </span>
          PREPARE WORKTREE
        </div>
        <div className="text-xxs text-muted font-mono opacity-60">
          git_worktree_init
        </div>
      </div>

      <div className="px-3 py-2.5 border-b border-border-subtle">
        <div className="text-xs text-muted font-mono">Branch</div>
        <div className="text-xs text-text mt-1">
          <span className="font-mono">{configuredBranch || "(pending)"}</span>
        </div>
        {configuredPath ? (
          <div className="text-xxs text-muted font-mono mt-1 opacity-70 break-all">
            {configuredPath}
          </div>
        ) : null}
        <div className="text-xxs text-muted mt-1.5">
          {isSetupRunning ? "Running project setup..." : "Creating worktree..."}
        </div>
      </div>

      {renderWorktreeSetupCommand({
        activeSetup,
        isVisible: isSetupPhaseVisible,
        setupCommand,
        setupCwd,
        toolCall,
      })}

      <div className="msg-card-footer">
        {isSetupRunning ? (
          <>
            <Button
              className="tool-approval-stop-btn"
              variant="secondary"
              size="xxs"
              onClick={() => {
                void stopRunningExecToolCall(tabId, id);
              }}
            >
              STOP
            </Button>
            <Button
              variant="danger"
              size="xxs"
              onClick={() => stopAgent(tabId)}
            >
              ABORT
            </Button>
            <Button variant="primary" size="xxs" loading disabled>
              RUNNING
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="danger"
              size="xxs"
              onClick={() => stopAgent(tabId)}
            >
              ABORT
            </Button>
            <Button variant="primary" size="xxs" loading disabled>
              PREPARING
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function BranchReleaseCommandRow({
  command,
  buttonLabel,
  running,
  disabled,
  onRun,
}: {
  command: string;
  buttonLabel: string;
  running: boolean;
  disabled?: boolean;
  onRun: () => void;
}) {
  return (
    <div className="inline-flex max-w-full self-start items-center gap-2 rounded-md border border-border-subtle bg-subtle/40 px-2 py-1.5">
      <div className="min-w-0 break-all font-mono text-[11px] text-text">
        <span className="text-muted">$ </span>
        {command}
      </div>
      <Button
        leftIcon={
          <span
            aria-hidden="true"
            className="material-symbols-outlined text-base"
          >
            terminal_2
          </span>
        }
        variant="secondary"
        size="xxs"
        loading={running}
        disabled={disabled}
        onClick={onRun}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}

function BranchReleaseCard({
  toolCall,
  tabId,
}: {
  toolCall: ToolCallDisplay;
  tabId: string;
}) {
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [activeCommand, setActiveCommand] = useState<
    "detach" | "switch" | null
  >(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const resultRecord =
    toolCall.result && typeof toolCall.result === "object"
      ? (toolCall.result as Record<string, unknown>)
      : null;
  const branch =
    typeof resultRecord?.branch === "string" ? resultRecord.branch : "";
  const worktreePath =
    typeof resultRecord?.path === "string" ? resultRecord.path : "";
  const blockingPath =
    typeof resultRecord?.blockingPath === "string"
      ? resultRecord.blockingPath
      : "";
  const branchLookupPath = blockingPath || worktreePath;

  useEffect(() => {
    let cancelled = false;

    async function loadDefaultBranch() {
      if (!branchLookupPath) {
        setDefaultBranch("main");
        return;
      }

      const originHead = await execRun(branchLookupPath, {
        command: "git",
        args: [
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        ],
        timeoutMs: 10_000,
        maxStdoutBytes: 4_096,
        maxStderrBytes: 4_096,
      });
      if (cancelled) return;

      if (originHead.ok && originHead.data.exitCode === 0) {
        const resolved = originHead.data.stdout.trim().replace(/^origin\//, "");
        if (resolved) {
          setDefaultBranch(resolved);
          return;
        }
      }

      const remoteShow = await execRun(branchLookupPath, {
        command: "git",
        args: ["remote", "show", "origin"],
        timeoutMs: 10_000,
        maxStdoutBytes: 12_000,
        maxStderrBytes: 12_000,
      });
      if (cancelled) return;

      if (remoteShow.ok && remoteShow.data.exitCode === 0) {
        const output = `${remoteShow.data.stdout}\n${remoteShow.data.stderr}`;
        const match = output.match(/HEAD branch:\s+(.+)/);
        const resolved = match?.[1]?.trim();
        if (resolved) {
          setDefaultBranch(resolved);
          return;
        }
      }

      setDefaultBranch("main");
    }

    void loadDefaultBranch();

    return () => {
      cancelled = true;
    };
  }, [branchLookupPath]);

  async function runReleaseCommand(
    commandId: "detach" | "switch",
    args: string[],
  ) {
    if (!blockingPath) return;

    setActiveCommand(commandId);
    setCommandError(null);

    const result = await execRun(blockingPath, {
      command: "git",
      args,
      timeoutMs: 30_000,
      maxStdoutBytes: 16_000,
      maxStderrBytes: 16_000,
      reason: `Release session branch ${branch || "session branch"} from the conflicting checkout.`,
    });

    if (!result.ok) {
      setCommandError(result.error.message);
      setActiveCommand(null);
      return;
    }

    if (result.data.exitCode !== 0) {
      const output =
        result.data.stderr.trim() ||
        result.data.stdout.trim() ||
        `git ${args.join(" ")} exited with code ${result.data.exitCode}.`;
      setCommandError(output);
      setActiveCommand(null);
      return;
    }

    resolveBranchReleaseAction(tabId, toolCall.id, "retry");
  }

  return (
    <div className="msg-card animate-fade-up mt-1.5">
      <div className="msg-card-head">
        <div className="msg-card-label">
          <span className="material-symbols-outlined text-base">
            account_tree
          </span>
          RELEASE SESSION BRANCH
        </div>
        <div className="text-xxs text-muted font-mono opacity-60">
          {toolCall.tool}
        </div>
      </div>

      <div className="px-3 py-2.5 border-b border-border-subtle">
        <div className="text-xs text-text">
          Release this branch so the agent can continue writing.
        </div>
        <div className="mt-3 flex flex-col md:flex-row gap-2">
          <div className="flex flex-col gap-1 flex-1">
            <div className="text-xxs font-bold tracking-widest uppercase text-muted">
              Session Branch
            </div>
            <CopyableCodePill
              value={branch || "(unknown branch)"}
              label="session branch"
            />
          </div>
          {blockingPath ? (
            <div className="flex flex-col gap-1 flex-1">
              <div className="text-xxs font-bold tracking-widest uppercase text-muted">
                Conflicting Checkout
              </div>
              <CopyableCodePill
                value={blockingPath}
                label="conflicting checkout path"
              />
            </div>
          ) : null}
        </div>
        <div className="mt-4 text-xs text-text">
          Run one of these in the conflicting checkout.
        </div>
        <div className="mt-4 flex flex-row gap-4 items-center">
          <BranchReleaseCommandRow
            command="git switch --detach"
            buttonLabel="DETACH"
            running={activeCommand === "detach"}
            disabled={!blockingPath || activeCommand === "switch"}
            onRun={() => {
              void runReleaseCommand("detach", ["switch", "--detach"]);
            }}
          />
          <div className="text-muted"> or </div>
          <BranchReleaseCommandRow
            command={`git switch ${defaultBranch}`}
            buttonLabel="SWITCH"
            running={activeCommand === "switch"}
            disabled={!blockingPath || activeCommand === "detach"}
            onRun={() => {
              void runReleaseCommand("switch", ["switch", defaultBranch]);
            }}
          />
        </div>
        {commandError ? (
          <div className="mt-2 text-xxs text-danger whitespace-pre-wrap break-words">
            {commandError}
          </div>
        ) : null}
        {!blockingPath ? (
          <div className="mt-2 text-xxs text-warning">
            Release the branch in the other checkout, then retry.
          </div>
        ) : null}
      </div>

      <div className="msg-card-footer">
        <Button
          variant="danger"
          size="xxs"
          onClick={() =>
            resolveBranchReleaseAction(tabId, toolCall.id, "abort")
          }
        >
          ABORT
        </Button>
        <Button
          variant="secondary"
          size="xxs"
          disabled={activeCommand !== null}
          onClick={() =>
            resolveBranchReleaseAction(tabId, toolCall.id, "retry")
          }
        >
          RETRY
        </Button>
      </div>
    </div>
  );
}

export default function ToolCallApproval({
  toolCall,
  cwd,
  tabId,
  onOpenProjectSettings,
}: ToolCallApprovalProps) {
  const { id, tool, args } = toolCall;
  const stopAgent = useStopAgent();
  const stopRunningExecToolCall = useStopRunningExecToolCall();
  const [isApproving, setIsApproving] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const isExecRunning = tool === "exec_run" && toolCall.status === "running";
  const showAllowSpinner = isApproving;
  const attentionTargetProps = getChatAttentionTargetProps(
    getToolCallAttentionTargetKind(toolCall),
  );

  const streamingRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (isExecRunning && streamingRef.current) {
      streamingRef.current.scrollTop = streamingRef.current.scrollHeight;
    }
  }, [isExecRunning, toolCall.streamingOutput]);

  if (toolCall.status === "awaiting_branch_release") {
    return <BranchReleaseCard toolCall={toolCall} tabId={tabId} />;
  }

  // Render the dedicated worktree card for git_worktree_init
  if (tool === "git_worktree_init") {
    return (
      <WorktreeToolCard
        toolCall={toolCall}
        tabId={tabId}
        onOpenProjectSettings={onOpenProjectSettings}
      />
    );
  }

  const icon = getToolCallIcon(toolCall);
  const label = getToolCallLabel(toolCall);

  const argEntries = Object.entries(args);

  return (
    <div className="msg-card animate-fade-up mt-1.5" {...attentionTargetProps}>
      {/* ── Card header ───────────────────────────────────────────────── */}
      <div className="msg-card-head">
        <div className="msg-card-label">
          <span className="material-symbols-outlined text-base">{icon}</span>
          {label}
        </div>
        <div className="text-xxs text-muted font-mono opacity-60">{tool}</div>
      </div>

      {/* ── Args block ──────────────────────────────────────────────────────────────────────── */}
      {tool === "workspace_editFile" ? (
        <EditFileDiffContent tc={toolCall} cwd={cwd} />
      ) : tool === "workspace_writeFile" ? (
        <WriteFileDiffContent tc={toolCall} cwd={cwd} />
      ) : tool === "exec_run" ? (
        <ExecRunContent args={args} />
      ) : argEntries.length > 0 ? (
        <div className="px-3 py-2.5 border-b border-border-subtle flex flex-col gap-1.25">
          {argEntries.map(([key, value]) => (
            <div
              key={key}
              className="flex gap-2 text-xs font-mono leading-normal"
            >
              <span className="text-muted shrink-0 min-w-20">{key}</span>
              <span className="whitespace-pre-wrap break-all max-h-20 overflow-hidden">
                {renderArgValue(value)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* ── Live streaming output (exec_run while running) ─────────────── */}
      {isExecRunning && toolCall.streamingOutput && (
        <pre
          ref={streamingRef}
          className="cmd-output border-b border-border-subtle rounded-none max-h-50"
        >
          {toolCall.streamingOutput}
        </pre>
      )}

      {/* ── Footer — Allow / Deny ─────────────────────────────────────── */}
      <div className="msg-card-footer">
        {isExecRunning ? (
          <>
            <Button
              className="tool-approval-stop-btn"
              variant="secondary"
              size="xxs"
              onClick={() => {
                setIsStopping(true);
                void stopRunningExecToolCall(tabId, id)
                  .then((stopped: boolean) => {
                    if (!stopped) setIsStopping(false);
                  })
                  .catch(() => {
                    setIsStopping(false);
                  });
              }}
              disabled={isAborting || isStopping}
            >
              {isStopping ? "STOPPING" : "STOP"}
            </Button>
            <Button
              variant="danger"
              size="xxs"
              onClick={() => {
                setIsAborting(true);
                stopAgent(tabId);
              }}
              disabled={isAborting || isStopping}
            >
              ABORT
            </Button>
            <Button variant="primary" size="xxs" loading disabled>
              RUNNING
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="xxs"
              onClick={() => resolveApproval(tabId, id, false)}
              disabled={isApproving}
            >
              DENY
            </Button>
            {(tool === "workspace_editFile" ||
              tool === "workspace_writeFile" ||
              tool === "exec_run") && (
              <Button
                variant="ghost"
                size="xxs"
                onClick={() => {
                  setApprovalReason(
                    tabId,
                    id,
                    tool === "exec_run"
                      ? "The command was NOT run. The user wants to refine the approach and will provide follow-up instructions."
                      : "The file edit was NOT applied. The user wants to refine the approach and will provide follow-up instructions.",
                  );
                  resolveApproval(tabId, id, false);
                  stopAgent(tabId);
                }}
                disabled={isApproving}
              >
                REFINE
              </Button>
            )}
            <Button
              variant="primary"
              size="xxs"
              loading={showAllowSpinner}
              onClick={() => {
                setIsApproving(true);
                resolveApproval(tabId, id, true);
              }}
              disabled={isApproving}
            >
              ALLOW
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
