import {
  resolveApproval,
  resolveWorktreeApproval,
  setApprovalReason,
} from "@/agent/approvals";
import { useState, useEffect, useRef } from "react";
import { useStopAgent, useStopRunningExecToolCall } from "@/agent/useAgents";
import PatchPreview from "@/components/PatchPreview";
import type { ToolCallDisplay } from "@/agent/types";
import {
  buildEditFileDiffFiles,
  buildWriteFileDiffFiles,
} from "@/components/patchDiffFiles";
import type { EditFileChange } from "@/agent/tools/workspace";
import type { DiffFile } from "@/components/DiffViewer";
import { deserializeDiff } from "@/components/diffSerialization";
import { Badge, Button, TextField } from "@/components/ui";

/* ─────────────────────────────────────────────────────────────────────────────
   ToolCallApproval — rendered when a tool call is in "awaiting_approval" state.
   Generic approval card for tool args and pending actions.
───────────────────────────────────────────────────────────────────────────── */

/** Icon shown for each tool category. Falls back to "build". */
const TOOL_ICON: Record<string, string> = {
  workspace_listDir: "folder_open",
  workspace_readFile: "description",
  workspace_writeFile: "edit_document",
  workspace_editFile: "difference",
  workspace_glob: "search",
  exec_run: "terminal",
  agent_todo_add: "checklist",
  agent_todo_update: "checklist",
  agent_todo_list: "checklist",
  agent_todo_remove: "checklist",
};

/** Human-friendly label shown in the card header. */
const TOOL_LABEL: Record<string, string> = {
  workspace_listDir: "LIST DIRECTORY",
  workspace_readFile: "READ FILE",
  workspace_writeFile: "WRITE FILE",
  workspace_editFile: "EDIT FILE",
  workspace_glob: "GLOB FILES",
  exec_run: "RUN COMMAND",
  agent_todo_add: "ADD TODO",
  agent_todo_update: "UPDATE TODO",
  agent_todo_list: "LIST TODOS",
  agent_todo_remove: "REMOVE TODO",
};

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
}

/** Special card shown for git_worktree_init (awaiting_worktree status). */
function WorktreeApprovalCard({ toolCall }: { toolCall: ToolCallDisplay }) {
  const { id, args } = toolCall;
  const suggested =
    typeof args.suggestedBranch === "string" ? args.suggestedBranch : "";
  const repoSlug =
    typeof args.repoSlug === "string" && args.repoSlug.trim()
      ? args.repoSlug.replace(/^\/+|\/+$/g, "")
      : "repo";
  const [branch, setBranch] = useState(suggested);

  return (
    <div className="msg-card animate-fade-up mt-1.5">
      {/* Header */}
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

      {/* Branch name input */}
      <div className="px-3 py-2.5 border-b border-border-subtle">
        <div className="text-xs text-muted font-mono mb-1.5">Branch name</div>
        <TextField
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          className="w-full bg-inset py-[5px] px-2 text-xs font-mono"
          wrapClassName="border border-border-mid rounded"
          placeholder="feat/my-branch"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter")
              resolveWorktreeApproval(id, true, branch.trim() || suggested);
          }}
        />
        <div className="text-xxs text-muted font-mono mt-[5px] opacity-60">
          A worktree will be created under worktrees/{repoSlug}/
          {branch.trim() || suggested || "branch"}
        </div>
      </div>

      {/* Footer */}
      <div className="msg-card-footer">
        <Button
          variant="ghost"
          size="xxs"
          onClick={() => resolveWorktreeApproval(id, false, "")}
        >
          WORK IN MAIN REPO
        </Button>
        <Button
          variant="primary"
          size="xxs"
          onClick={() =>
            resolveWorktreeApproval(id, true, branch.trim() || suggested)
          }
        >
          CREATE BRANCH
        </Button>
      </div>
    </div>
  );
}

export default function ToolCallApproval({
  toolCall,
  cwd,
  tabId,
}: ToolCallApprovalProps) {
  const { id, tool, args } = toolCall;
  const stopAgent = useStopAgent();
  const stopRunningExecToolCall = useStopRunningExecToolCall();
  const [isApproving, setIsApproving] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const isExecRunning = tool === "exec_run" && toolCall.status === "running";
  const showAllowSpinner = isApproving;

  const streamingRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (isExecRunning && streamingRef.current) {
      streamingRef.current.scrollTop = streamingRef.current.scrollHeight;
    }
  }, [isExecRunning, toolCall.streamingOutput]);

  // Render the dedicated worktree card for git_worktree_init
  if (toolCall.status === "awaiting_worktree" || tool === "git_worktree_init") {
    return <WorktreeApprovalCard toolCall={toolCall} />;
  }

  const icon = TOOL_ICON[tool] ?? "build";
  const label = TOOL_LABEL[tool] ?? tool.toUpperCase();

  const argEntries = Object.entries(args);

  return (
    <div className="msg-card animate-fade-up mt-1.5">
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
        <div className="px-3 py-2.5 border-b border-border-subtle flex flex-col gap-[5px]">
          {argEntries.map(([key, value]) => (
            <div
              key={key}
              className="flex gap-2 text-xs font-mono leading-[1.5]"
            >
              <span className="text-muted shrink-0 min-w-[80px]">{key}</span>
              <span className="whitespace-pre-wrap break-all max-h-[80px] overflow-hidden">
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
              onClick={() => resolveApproval(id, false)}
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
                    id,
                    tool === "exec_run"
                      ? "The command was NOT run. The user wants to refine the approach and will provide follow-up instructions."
                      : "The file edit was NOT applied. The user wants to refine the approach and will provide follow-up instructions.",
                  );
                  resolveApproval(id, false);
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
                resolveApproval(id, true);
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
