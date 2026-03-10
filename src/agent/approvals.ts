import type { AutoApproveCommandsMode } from "./types";

/**
 * Tool approval system.
 *
 * Before each tool call the runner checks TOOL_APPROVAL_CONFIG.
 * If the tool requires approval it calls requestApproval(id), which parks a
 * Promise resolver in approvalResolvers and returns the Promise.
 * The UI calls resolveApproval(id, approved) to unblock the runner.
 *
 * For the /test command the UI registers its own one-shot callback via
 * registerApproval() instead of going through the runner.
 */

/* ─────────────────────────────────────────────────────────────────────────────
   Config hash — flip a value to false to auto-allow that tool without asking.
   Everything is true for now (hardcoded as requested).
───────────────────────────────────────────────────────────────────────────── */

/**
 * Inline tools — read-only / non-destructive tools that run immediately
 * without user approval.
 */
const INLINE_TOOL_NAMES = [
  "workspace_listDir",
  "workspace_stat",
  "workspace_readFile",
  "workspace_glob",
  "workspace_search",
  "agent_todo_add",
  "agent_todo_update",
  "agent_todo_list",
  "agent_todo_remove",
  "agent_card_add",
  "agent_artifact_create",
  "agent_artifact_version",
  "agent_artifact_get",
  "agent_artifact_list",
  "agent_title_set",
  "agent_title_get",
  // The subagent invocation tool itself is inline; per-subagent requiresApproval
  // is enforced separately in the runner before the subagent starts.
  "agent_subagent_call",
  // user_input is handled by its own async channel (requestUserInput), not the
  // standard approve/deny gate.
  "user_input",
] as const;

/** Union of every inline (auto-approved) tool name. */
export type InlineTool = (typeof INLINE_TOOL_NAMES)[number];
export const INLINE_TOOLS = new Set<string>(INLINE_TOOL_NAMES);

/** Returns true when the tool is inline (no approval required). */
export function isInlineTool(toolName: string): boolean {
  return INLINE_TOOLS.has(toolName);
}

/**
 * Non-inline tools — these go through the standard approval gate.
 * Adding a new tool here will cause TypeScript to error in TOOL_APPROVAL_CONFIG
 * until it is given an explicit approval value.
 */
const NON_INLINE_TOOL_NAMES = [
  "workspace_editFile",
  "workspace_writeFile",
  "exec_run",
  // git_worktree_init bypasses the standard gate — it manages its own
  // approval flow via requestWorktreeApproval / resolveWorktreeApproval.
  "git_worktree_init",
] as const;

export type NonInlineTool = (typeof NON_INLINE_TOOL_NAMES)[number];

/** Union of every known tool name. */
export type KnownTool = InlineTool | NonInlineTool;

/**
 * Approval config — only covers non-inline tools (inline tools never reach this table).
 * `satisfies` enforces exhaustiveness at definition; `Map` allows string-keyed lookups
 * in callers without any casts.
 */
export const TOOL_APPROVAL_CONFIG = new Map<string, boolean>(
  Object.entries({
    workspace_editFile: true,
    workspace_writeFile: true,
    exec_run: true,
    git_worktree_init: false,
  } satisfies Record<NonInlineTool, boolean>),
);

/* ─────────────────────────────────────────────────────────────────────────────
   Auto-approve flags — governed by the Chat Controls UI per-tab.
   This file used to hold global state, but it is now per-tab in AgentState.
───────────────────────────────────────────────────────────────────────────── */

/** Edit tools that the auto-approve flag covers */
const EDIT_TOOLS = new Set<string>(["workspace_writeFile", "workspace_editFile"]);
/** Command tools that the auto-approve flag covers */
const COMMAND_TOOLS = new Set<string>(["exec_run"]);

/** Returns true when the given tool must be approved before running. */
export function requiresApproval(
  toolName: string,
  autoApproveEdits: boolean,
  autoApproveCommands: AutoApproveCommandsMode,
  toolArgs?: Record<string, unknown>,
): boolean {
  // Inline tools never require approval.
  if (isInlineTool(toolName)) return false;
  // Auto-approve overrides for edit tools
  if (autoApproveEdits && EDIT_TOOLS.has(toolName)) return false;

  // Command approval is tri-state and may consider a model-provided hint.
  if (COMMAND_TOOLS.has(toolName)) {
    if (autoApproveCommands === "yes") return false;
    if (autoApproveCommands === "no") return true;

    // "agent": respect model hint, safe default is to ask.
    const shouldRequireApproval = toolArgs?.requireUserApproval;
    return shouldRequireApproval !== false;
  }

  // Unknown tools default to requiring approval (safe default).
  return TOOL_APPROVAL_CONFIG.get(toolName) ?? true;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Resolver registry — maps tool-call id → pending resolver
───────────────────────────────────────────────────────────────────────────── */

const approvalResolvers = new Map<string, (approved: boolean) => void>();
const approvalReasons = new Map<string, string>();

/**
 * Register a custom resolver for a tool call id.
 * Used by the /test command to wire up fake approvals without a live runner.
 */
export function registerApproval(
  tabId: string,
  id: string,
  resolver: (approved: boolean) => void,
): void {
  approvalResolvers.set(`${tabId}:${id}`, resolver);
}

/**
 * Wait for the user to allow or deny a tool call.
 * Stores the Promise resolver so resolveApproval() can unblock it later.
 * Used by the runner — one call per tool call id.
 */
export function requestApproval(tabId: string, id: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    approvalResolvers.set(`${tabId}:${id}`, resolve);
  });
}

/**
 * Called from the UI (Allow / Deny buttons) to unblock a waiting requestApproval().
 * Safe to call multiple times — subsequent calls for the same id are no-ops.
 */
export function resolveApproval(tabId: string, id: string, approved: boolean): void {
  const key = `${tabId}:${id}`;
  const resolve = approvalResolvers.get(key);
  if (resolve) {
    approvalResolvers.delete(key);
    resolve(approved);
  }
}

/**
 * Attach a reason message to a tool approval id (used when denying).
 * The runner can consume it and forward it to the agent.
 */
export function setApprovalReason(tabId: string, id: string, reason: string): void {
  if (!reason.trim()) return;
  approvalReasons.set(`${tabId}:${id}`, reason.trim());
}

/**
 * Consume (read + clear) a pending approval reason for a tool call id.
 */
export function consumeApprovalReason(tabId: string, id: string): string | undefined {
  const key = `${tabId}:${id}`;
  const reason = approvalReasons.get(key);
  if (reason) approvalReasons.delete(key);
  return reason;
}

/**
 * Deny all currently-pending approvals.
 * Called when an agent is stopped so the runner can exit cleanly.
 */
export function cancelAllApprovals(tabId?: string): void {
  const prefix = tabId ? `${tabId}:` : "";

  for (const [key, resolve] of approvalResolvers.entries()) {
    if (key.startsWith(prefix)) {
      resolve(false);
      approvalResolvers.delete(key);
    }
  }
  for (const key of approvalReasons.keys()) {
    if (key.startsWith(prefix)) {
      approvalReasons.delete(key);
    }
  }

  // Also cancel any pending worktree approvals
  for (const [key, resolve] of worktreeApprovalResolvers.entries()) {
    if (key.startsWith(prefix)) {
      resolve({ approved: false, branchName: "" });
      worktreeApprovalResolvers.delete(key);
    }
  }

  // Also cancel any pending user_input requests
  for (const [key, resolve] of userInputResolvers.entries()) {
    if (key.startsWith(prefix)) {
      resolve(null);
      userInputResolvers.delete(key);
    }
  }

  for (const [key, resolve] of worktreeSetupActionResolvers.entries()) {
    if (key.startsWith(prefix)) {
      resolve({ action: "abort" });
      worktreeSetupActionResolvers.delete(key);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   user_input — suspends the runner until the user types or selects an answer.
   resolveUserInput is called by the UI with the answer text.
   cancelUserInput is called when the user skips / the agent is stopped.
───────────────────────────────────────────────────────────────────────────── */

const userInputResolvers = new Map<string, (answer: string | null) => void>();

/** Suspend the subagent loop until the user provides an answer. */
export function requestUserInput(tabId: string, id: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    userInputResolvers.set(`${tabId}:${id}`, resolve);
  });
}

/** Called from the UserInputCard UI with the user's answer. */
export function resolveUserInput(tabId: string, id: string, answer: string): void {
  const key = `${tabId}:${id}`;
  const resolve = userInputResolvers.get(key);
  if (resolve) {
    userInputResolvers.delete(key);
    resolve(answer);
  }
}

/** Called when the user skips the question or the agent is stopped. */
export function cancelUserInput(tabId: string, id: string): void {
  const key = `${tabId}:${id}`;
  const resolve = userInputResolvers.get(key);
  if (resolve) {
    userInputResolvers.delete(key);
    resolve(null);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Worktree approval — returns { approved, branchName } so the UI can pass
   back the user-edited branch name alongside the allow/deny decision.
───────────────────────────────────────────────────────────────────────────── */

export interface WorktreeApprovalResult {
  approved: boolean;
  branchName: string;
}

const worktreeApprovalResolvers = new Map<
  string,
  (result: WorktreeApprovalResult) => void
>();

/**
 * Wait for the user to approve/deny worktree creation and provide a branch name.
 * Used by the git_worktree_init tool handler.
 */
export function requestWorktreeApproval(
  tabId: string,
  id: string,
): Promise<WorktreeApprovalResult> {
  return new Promise<WorktreeApprovalResult>((resolve) => {
    worktreeApprovalResolvers.set(`${tabId}:${id}`, resolve);
  });
}

/**
 * Called from the custom worktree approval card UI.
 * Safe to call multiple times — subsequent calls for the same id are no-ops.
 */
export function resolveWorktreeApproval(
  tabId: string,
  id: string,
  approved: boolean,
  branchName: string,
): void {
  const key = `${tabId}:${id}`;
  const resolve = worktreeApprovalResolvers.get(key);
  if (resolve) {
    worktreeApprovalResolvers.delete(key);
    resolve({ approved, branchName });
  }
}

export type WorktreeSetupAction = "retry" | "continue" | "abort";

export interface WorktreeSetupActionResult {
  action: WorktreeSetupAction;
}

const worktreeSetupActionResolvers = new Map<
  string,
  (result: WorktreeSetupActionResult) => void
>();

export function requestWorktreeSetupAction(
  tabId: string,
  id: string,
): Promise<WorktreeSetupActionResult> {
  return new Promise<WorktreeSetupActionResult>((resolve) => {
    worktreeSetupActionResolvers.set(`${tabId}:${id}`, resolve);
  });
}

export function resolveWorktreeSetupAction(
  tabId: string,
  id: string,
  action: WorktreeSetupAction,
): void {
  const key = `${tabId}:${id}`;
  const resolve = worktreeSetupActionResolvers.get(key);
  if (resolve) {
    worktreeSetupActionResolvers.delete(key);
    resolve({ action });
  }
}
