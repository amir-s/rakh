/**
 * Central tool dispatcher.
 * Maps tool call names → handler functions.
 * Each handler receives the parsed arguments and returns a ToolResult.
 */
import {
  listDir,
  statFile,
  readFile,
  writeFile,
  editFile,
  validateEditFile,
  glob,
  searchFiles,
} from "./workspace";
import type { EditFileInput } from "./workspace";
import { execRun } from "./exec";
import { gitWorktreeInit } from "./git";
import {
  cardAdd,
  titleSet,
  titleGet,
} from "./agentControl";
import {
  todoAdd,
  todoUpdate,
  todoList,
  todoRemove,
  todoNoteAdd,
} from "./todos";
import {
  artifactCreate,
  artifactVersion,
  artifactGet,
  artifactList,
  type ArtifactRuntimeContext,
} from "./artifacts";
import type { ToolResult } from "../types";
import { computeDiffFile } from "../patchToDiff";
import { serializeDiff } from "@/components/diffSerialization";
import { patchAgentState, getAgentState } from "../atoms";
import type { LogContext } from "@/logging/types";

export { TOOL_DEFINITIONS, getToolDefinitionsByNames } from "./definitions";

/* ── Review edit helpers ───────────────────────────────────────────────────── */

/**
 * Snapshot the original content of a file before it is modified,
 * if this file isn't already tracked in reviewEdits.
 * Returns the original content, or undefined if already tracked.
 */
async function snapshotOriginal(
  tabId: string,
  cwd: string,
  filePath: string,
  logContext?: LogContext,
): Promise<string | undefined> {
  const existing = getAgentState(tabId).reviewEdits.find(
    (e) => e.filePath === filePath,
  );
  if (existing) return undefined; // already tracked

  try {
    const r = await readFile(cwd, { path: filePath }, logContext);
    return r.ok ? r.data.content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * After a successful file write/edit, compute and upsert a review edit entry.
 * originalContent: content before this agent's FIRST change (or "" for new files).
 * currentContent: the file content now (after the operation).
 */
function upsertReviewEdit(
  tabId: string,
  filePath: string,
  originalContent: string,
  currentContent: string,
): void {
  const existing = getAgentState(tabId).reviewEdits.find(
    (e) => e.filePath === filePath,
  );
  // Use the stored original baseline if we already have it
  const baseline = existing?.originalContent ?? originalContent;
  const diffFile = serializeDiff(
    computeDiffFile(filePath, baseline, currentContent),
  );
  const now = Date.now();

  patchAgentState(tabId, (prev) => {
    const edits = prev.reviewEdits.filter((e) => e.filePath !== filePath);
    edits.push({
      filePath,
      diffFile,
      originalContent: baseline,
      timestamp: now,
    });
    return { ...prev, reviewEdits: edits };
  });
}

/**
 * Execute a tool by name.
 * @param tabId       – the agent/tab that owns this call
 * @param cwd         – the agent's current workspace directory
 * @param name        – tool function name from the model response
 * @param args        – parsed JSON arguments (from LLM, validated inside each tool)
 * @param toolCallId  – the unique ID of this tool call (used by interactive tools)
 */
export interface DispatchCallbacks {
  onExecOutput?: (stream: "stdout" | "stderr", data: string) => void;
}

export interface DispatchRuntimeContext extends ArtifactRuntimeContext {
  currentTurn?: number;
  logContext?: LogContext;
}

export async function dispatchTool(
  tabId: string,
  cwd: string,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  toolCallId: string = "",
  callbacks?: DispatchCallbacks,
  runtime?: DispatchRuntimeContext,
): Promise<ToolResult<unknown>> {
  // ⚠️  args are LLM-generated and may be missing fields; each tool validates internally.
  // The casts below are intentional — runtime errors surface as ToolResult errors.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = args as any;
  switch (name) {
    /* ── workspace ──────────────────────────────────────────────────────────── */
    case "workspace_listDir":
      return listDir(cwd, a, runtime?.logContext);

    case "workspace_stat":
      return statFile(cwd, a, runtime?.logContext);

    case "workspace_readFile":
      return readFile(cwd, a, runtime?.logContext);

    case "workspace_writeFile": {
      const wfPath = typeof a.path === "string" ? a.path : "";
      const wfOverwrite = a.overwrite === true;
      // Snapshot original for overwrite (new files have no original)
      const wfOriginal = wfOverwrite
        ? await snapshotOriginal(tabId, cwd, wfPath, runtime?.logContext)
        : undefined;

      const wfResult = await writeFile(cwd, {
        path: wfPath,
        content: typeof a.content === "string" ? a.content : "",
        mode: wfOverwrite ? "create_or_overwrite" : "create",
        createDirs: true,
      }, runtime?.logContext);

      if (wfResult.ok) {
        const currentContent = typeof a.content === "string" ? a.content : "";
        upsertReviewEdit(tabId, wfPath, wfOriginal ?? "", currentContent);
      }

      return wfResult;
    }

    case "workspace_editFile": {
      const efInput = a as EditFileInput;
      // Snapshot original before editing
      const efOriginal = await snapshotOriginal(
        tabId,
        cwd,
        efInput.path,
        runtime?.logContext,
      );

      const efResult = await editFile(cwd, efInput, runtime?.logContext);

      if (efResult.ok) {
        // Read the new content from disk
        const readResult = await readFile(
          cwd,
          { path: efInput.path },
          runtime?.logContext,
        );
        const currentContent = readResult.ok ? readResult.data.content : "";
        upsertReviewEdit(tabId, efInput.path, efOriginal ?? "", currentContent);
      }

      return efResult;
    }

    case "workspace_glob":
      return glob(cwd, a, runtime?.logContext);

    case "workspace_search":
      return searchFiles(cwd, a, runtime?.logContext);

    /* ── git ─────────────────────────────────────────────────────────────────────────── */
    case "git_worktree_init":
      return gitWorktreeInit(
        tabId,
        toolCallId,
        cwd,
        a,
        callbacks?.onExecOutput,
        runtime?.logContext,
      );

    /* ── exec ──────────────────────────────────────────────────────────────────────── */
    case "exec_run":
      return execRun(
        cwd,
        {
          ...a,
          runId:
            typeof toolCallId === "string" && toolCallId.trim().length > 0
              ? toolCallId
              : undefined,
        },
        callbacks?.onExecOutput,
        runtime?.logContext,
      );

    /* ── agent.todo ─────────────────────────────────────────────────────────── */
    case "agent_todo_add":
      return todoAdd(tabId, {
        currentTurn: runtime?.currentTurn ?? 0,
        agentId: runtime?.agentId ?? "agent_main",
      }, a);

    case "agent_todo_update":
      return todoUpdate(tabId, {
        currentTurn: runtime?.currentTurn ?? 0,
        agentId: runtime?.agentId ?? "agent_main",
      }, a);

    case "agent_todo_note_add":
      return todoNoteAdd(tabId, {
        currentTurn: runtime?.currentTurn ?? 0,
        agentId: runtime?.agentId ?? "agent_main",
      }, a);

    case "agent_todo_list":
      return todoList(tabId, a);

    case "agent_todo_remove":
      return todoRemove(tabId, a);

    case "agent_card_add":
      return cardAdd(tabId, a);

    /* ── agent.artifact ────────────────────────────────────────────────── */
    case "agent_artifact_create":
      return artifactCreate(tabId, runtime, a);

    case "agent_artifact_version":
      return artifactVersion(tabId, runtime, a);

    case "agent_artifact_get":
      return artifactGet(tabId, a, runtime?.logContext);

    case "agent_artifact_list":
      return artifactList(tabId, a, runtime?.logContext);

    /* ── agent.title ─────────────────────────────────────────────────────────────── */
    case "agent_title_set":
      return titleSet(tabId, a);

    case "agent_title_get":
      return titleGet(tabId);

    default:
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: `Unknown tool: "${name}"`,
        },
      };
  }
}

/**
 * Validate a tool call before it proceeds to the approval and execution phase.
 * If this returns an error ToolResult, the tool call fails immediately.
 * Otherwise, it returns null and the tool call proceeds exactly as normal.
 */
export async function validateTool(
  tabId: string,
  cwd: string,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
): Promise<Extract<ToolResult<unknown>, { ok: false }> | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = args as any;
  if (name === "workspace_editFile") {
    // Only pre-validate if the tool is editFile to avoid asking users to approve doomed edits
    const err = await validateEditFile(cwd, a as EditFileInput);
    return err ? (err as Extract<ToolResult<unknown>, { ok: false }>) : null;
  }
  return null;
}
