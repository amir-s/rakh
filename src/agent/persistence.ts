/**
 * persistence.ts — session save/restore via Tauri SQLite backend.
 *
 * All public functions are no-ops when running outside Tauri (e.g. in the
 * Vite dev browser) so the rest of the codebase can import them safely.
 *
 * ── Adding new AgentState fields ──────────────────────────────────────────
 * If you add a new field to AgentState (src/agent/types.ts) that should
 * survive app restarts, you must update THREE places:
 *   1. PersistedSession interface below (add the new field)
 *   2. buildPersistedSession() below (snapshot the field from AgentState)
 *   3. The restore call in App.tsx SessionRestorer (read it back into
 *      patchAgentState so the atom is hydrated on startup)
 * On the Rust side also update:
 *   4. PersistedSession struct in src-tauri/src/lib.rs
 *   5. The sessions table schema in init_db() (add the column)
 *   6. The SELECT column list in db_load_sessions
 *   7. The INSERT column list and ON CONFLICT SET in db_upsert_session
 * ─────────────────────────────────────────────────────────────────────────
 */

import type { Tab } from "@/contexts/TabsContext";
import type { AgentState } from "./types";
import { getAgentState } from "./atoms";
import { DEFAULT_MODEL } from "./atoms";

/* ─────────────────────────────────────────────────────────────────────────────
   Shared type (mirrors the Rust PersistedSession struct)
───────────────────────────────────────────────────────────────────────────── */

export interface PersistedSession {
  id: string;
  label: string;
  icon: string;
  /** "new" | "workspace" */
  mode: string;
  tabTitle: string;
  cwd: string;
  model: string;
  planMarkdown: string;
  planVersion: number;
  planUpdatedAt: number;
  /** JSON string — ChatMessage[] */
  chatMessages: string;
  /** JSON string — ApiMessage[] */
  apiMessages: string;
  /** JSON string — TodoItem[] */
  todos: string;
  /** JSON string — ReviewEdit[] */
  reviewEdits: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  /** Absolute path to the git worktree (empty string = none) */
  worktreePath: string;
  /** Git branch name for the worktree (empty string = none) */
  worktreeBranch: string;
  /** Whether the user declined worktree creation */
  worktreeDeclined: boolean;
  /** Whether debug UI is enabled for this tab */
  showDebug: boolean;
  /** JSON string — AdvancedModelOptions (empty string / '{}' = use defaults) */
  advancedOptions: string;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Tauri invoke helper (safe outside Tauri)
───────────────────────────────────────────────────────────────────────────── */

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

/* ─────────────────────────────────────────────────────────────────────────────
   Public API
───────────────────────────────────────────────────────────────────────────── */

/** Load all non-archived sessions from the DB. Returns [] outside Tauri. */
export async function loadSessions(): Promise<PersistedSession[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<PersistedSession[]>("db_load_sessions");
  } catch (e) {
    console.error("rakh: failed to load sessions:", e);
    return [];
  }
}

/** Build a snapshot of a tab + its agent state suitable for persisting. */
export function buildPersistedSession(
  tab: Tab,
  state: AgentState,
): PersistedSession {
  const now = Date.now();
  return {
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    mode: tab.mode,
    tabTitle: state.tabTitle,
    cwd: state.config.cwd,
    model: state.config.model || DEFAULT_MODEL,
    planMarkdown: state.plan.markdown,
    planVersion: state.plan.version,
    planUpdatedAt: state.plan.updatedAtMs,
    chatMessages: JSON.stringify(state.chatMessages),
    apiMessages: JSON.stringify(state.apiMessages),
    todos: JSON.stringify(state.todos),
    reviewEdits: JSON.stringify(state.reviewEdits),
    archived: false,
    worktreePath: state.config.worktreePath ?? "",
    worktreeBranch: state.config.worktreeBranch ?? "",
    worktreeDeclined: state.config.worktreeDeclined ?? false,
    showDebug: state.showDebug ?? false,
    advancedOptions: state.config.advancedOptions
      ? JSON.stringify(state.config.advancedOptions)
      : "{}",
    // created_at is only used on the initial INSERT; the DB preserves the
    // original value on subsequent upserts (not included in ON CONFLICT SET).
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * True when a tab has no meaningful agent-produced content yet.
 * Used to avoid archiving completely empty workspace tabs on close.
 */
export function isSessionEmpty(state: AgentState): boolean {
  if (state.chatMessages.length > 0 || state.apiMessages.length > 0) return false;
  if (state.todos.length > 0 || state.reviewEdits.length > 0) return false;
  if (state.tabTitle.trim().length > 0) return false;
  if (state.plan.markdown.trim().length > 0) return false;
  if (state.plan.version > 0 || state.plan.updatedAtMs > 0) return false;
  if (state.error !== null) return false;
  return true;
}

/**
 * Persist the current state of a tab to SQLite.
 * Only saves workspace-mode tabs (new-session tabs have no meaningful state).
 */
export async function upsertSession(tab: Tab): Promise<void> {
  if (!isTauri()) return;
  if (tab.mode !== "workspace") return;
  const state = getAgentState(tab.id);
  const session = buildPersistedSession(tab, state);
  try {
    await invoke("db_upsert_session", { session });
  } catch (e) {
    console.error("rakh: failed to upsert session:", e);
  }
}

/** Persist every workspace tab before a controlled app restart/update. */
export async function upsertWorkspaceSessions(tabs: Tab[]): Promise<void> {
  await Promise.all(tabs.map((tab) => upsertSession(tab)));
}

/** Mark a session as archived (hidden from UI, data preserved). */
export async function archiveSession(id: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("db_archive_session", { id });
  } catch (e) {
    console.error("rakh: failed to archive session:", e);
  }
}

/** Load all archived sessions from the DB. Returns [] outside Tauri. */
export async function loadArchivedSessions(): Promise<PersistedSession[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<PersistedSession[]>("db_load_archived_sessions");
  } catch (e) {
    console.error("rakh: failed to load archived sessions:", e);
    return [];
  }
}

/** Unarchive a session so it appears in the active sessions list. */
export async function restoreSession(session: PersistedSession): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("db_upsert_session", {
      session: { ...session, archived: false },
    });
  } catch (e) {
    console.error("rakh: failed to restore session:", e);
  }
}

/** Permanently delete a session from the DB. */
export async function deleteSession(id: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("db_delete_session", { id });
  } catch (e) {
    console.error("rakh: failed to delete session:", e);
  }
}
