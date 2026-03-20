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
 *   4. PersistedSession struct in src-tauri/src/db.rs
 *   5. The sessions table schema in init_db() (add the column)
 *   6. The SELECT column list in db_load_sessions
 *   7. The INSERT column list and ON CONFLICT SET in db_upsert_session
 * ─────────────────────────────────────────────────────────────────────────
 */

import type { Tab } from "@/contexts/TabsContext";
import { logFrontendSoon } from "@/logging/client";
import type { AgentQueueState, AgentState } from "./types";
import {
  DEFAULT_MODEL,
  defaultCommunicationProfileAtom,
  getAgentState,
  jotaiStore,
  patchSessionPersistenceState,
} from "./atoms";

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
  projectPath: string;
  setupCommand: string;
  backend?: string;
  model: string;
  turnCount: number;
  planMarkdown: string;
  planVersion: number;
  planUpdatedAt: number;
  /** JSON string — ChatMessage[] */
  chatMessages: string;
  /** JSON string — ApiMessage[] */
  apiMessages: string;
  /** JSON string — ReviewEdit[] */
  reviewEdits: string;
  /** JSON string — QueuedUserMessage[] */
  queuedMessages: string;
  /** Queue drain state for persisted follow-ups */
  queueState: AgentQueueState;
  /** JSON string — LlmUsageRecord[] */
  llmUsageLedger: string;
  archived: boolean;
  pinned: boolean;
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
  /** JSON string — BackendSessionState */
  backendSessionState?: string;
  communicationProfile: string;
}

export type SessionChangeKind = "upserted" | "archived" | "pinned" | "deleted";

export interface SessionChangeEvent {
  sessionId: string;
  change: SessionChangeKind;
  archived: boolean | null;
  previousArchived: boolean | null;
  pinned: boolean | null;
  changedAt: number;
}

export type UnlistenFn = () => void;

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

export function sessionChangeAffectsRecentSessionSurfaces(
  event: SessionChangeEvent,
): boolean {
  switch (event.change) {
    case "archived":
      return event.archived === true;
    case "pinned":
      return true;
    case "deleted":
      return event.previousArchived === true || event.pinned === true;
    case "upserted":
      return (
        event.archived === true ||
        event.previousArchived === true ||
        event.pinned === true
      );
    default:
      return false;
  }
}

/**
 * Load the recent-session inventory used by the new-session landing and archived
 * tabs UI. This includes all archived sessions plus any currently active pinned
 * sessions, so pinned workspaces remain reachable after they are reopened.
 */
export async function loadRecentSessions(): Promise<PersistedSession[]> {
  if (!isTauri()) return [];

  const archivedSessions = await loadArchivedSessions();
  const activeSessions = await loadSessions();

  const byId = new Map<string, PersistedSession>();
  for (const session of archivedSessions) {
    byId.set(session.id, session);
  }
  for (const session of activeSessions) {
    if (!session.pinned) continue;
    byId.set(session.id, session);
  }

  return Array.from(byId.values());
}

export async function listenForSessionChanges(
  onChange: (event: SessionChangeEvent) => void,
): Promise<UnlistenFn | null> {
  if (!isTauri()) return null;

  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<SessionChangeEvent>("session_changed", (event) => {
      onChange(event.payload);
    });
  } catch {
    return null;
  }
}

function getPersistedSessionComparableValue(session: PersistedSession) {
  return {
    id: session.id,
    label: session.label,
    icon: session.icon,
    mode: session.mode,
    tabTitle: session.tabTitle,
    cwd: session.cwd,
    projectPath: session.projectPath,
    setupCommand: session.setupCommand,
    backend: session.backend ?? "ai-sdk",
    model: session.model,
    turnCount: session.turnCount,
    planMarkdown: session.planMarkdown,
    planVersion: session.planVersion,
    planUpdatedAt: session.planUpdatedAt,
    chatMessages: session.chatMessages,
    apiMessages: session.apiMessages,
    reviewEdits: session.reviewEdits,
    queuedMessages: session.queuedMessages,
    queueState: session.queueState,
    llmUsageLedger: session.llmUsageLedger,
    pinned: session.pinned,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    worktreeDeclined: session.worktreeDeclined,
    showDebug: session.showDebug,
    advancedOptions: session.advancedOptions,
    backendSessionState: session.backendSessionState ?? "null",
    communicationProfile: session.communicationProfile,
  };
}

export function getPersistedSessionSignature(session: PersistedSession): string {
  return JSON.stringify(getPersistedSessionComparableValue(session));
}

export function buildSessionPersistenceSignature(
  tab: Tab,
  state: AgentState,
): string | null {
  if (tab.mode !== "workspace") return null;
  return getPersistedSessionSignature(buildPersistedSession(tab, state));
}

export function markSessionAsPersisted(session: PersistedSession): void {
  patchSessionPersistenceState(session.id, {
    phase: "saved",
    lastSavedAtMs: session.updatedAt,
    lastSavedSignature: getPersistedSessionSignature(session),
    lastSaveError: null,
  });
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
    logFrontendSoon({
      level: "error",
      tags: ["frontend", "db", "system"],
      event: "persistence.load.error",
      message: "Failed to load sessions",
      kind: "error",
      data: e,
    });
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
    projectPath: state.config.projectPath ?? "",
    setupCommand: state.config.setupCommand ?? "",
    backend: state.config.backend ?? "ai-sdk",
    model: state.config.model || DEFAULT_MODEL,
    turnCount: state.turnCount,
    planMarkdown: state.plan.markdown,
    planVersion: state.plan.version,
    planUpdatedAt: state.plan.updatedAtMs,
    chatMessages: JSON.stringify(state.chatMessages),
    apiMessages: JSON.stringify(state.apiMessages),
    reviewEdits: JSON.stringify(state.reviewEdits),
    queuedMessages: JSON.stringify(state.queuedMessages),
    queueState: state.queueState,
    llmUsageLedger: JSON.stringify(state.llmUsageLedger ?? []),
    archived: false,
    pinned: tab.pinned ?? false,
    worktreePath: state.config.worktreePath ?? "",
    worktreeBranch: state.config.worktreeBranch ?? "",
    worktreeDeclined: state.config.worktreeDeclined ?? false,
    showDebug: state.showDebug ?? false,
    advancedOptions: state.config.advancedOptions
      ? JSON.stringify(state.config.advancedOptions)
      : "{}",
    backendSessionState: JSON.stringify(state.backendSessionState ?? null),
    communicationProfile:
      state.config.communicationProfile ||
      jotaiStore.get(defaultCommunicationProfileAtom) ||
      "pragmatic",
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
  if (state.queuedMessages.length > 0) return false;
  if ((state.llmUsageLedger?.length ?? 0) > 0) return false;
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

  patchSessionPersistenceState(tab.id, {
    phase: "saving",
    lastSaveError: null,
  });

  const state = getAgentState(tab.id);
  const session = buildPersistedSession(tab, state);
  try {
    await invoke("db_upsert_session", { session });
    markSessionAsPersisted(session);
  } catch (e) {
    logFrontendSoon({
      level: "error",
      tags: ["frontend", "db", "system"],
      event: "persistence.upsert.error",
      message: "Failed to upsert session",
      kind: "error",
      data: { sessionId: tab.id, error: e },
    });
    patchSessionPersistenceState(tab.id, {
      phase: "error",
      lastSaveError: e instanceof Error ? e.message : String(e),
    });
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
    logFrontendSoon({
      level: "error",
      tags: ["frontend", "db", "system"],
      event: "persistence.archive.error",
      message: "Failed to archive session",
      kind: "error",
      data: { sessionId: id, error: e },
    });
  }
}

/** Load all archived sessions from the DB. Returns [] outside Tauri. */
export async function loadArchivedSessions(): Promise<PersistedSession[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<PersistedSession[]>("db_load_archived_sessions");
  } catch (e) {
    logFrontendSoon({
      level: "error",
      tags: ["frontend", "db", "system"],
      event: "persistence.loadArchived.error",
      message: "Failed to load archived sessions",
      kind: "error",
      data: e,
    });
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
    markSessionAsPersisted({ ...session, archived: false });
  } catch (e) {
    logFrontendSoon({
      level: "error",
      tags: ["frontend", "db", "system"],
      event: "persistence.restore.error",
      message: "Failed to restore session",
      kind: "error",
      data: { sessionId: session.id, error: e },
    });
  }
}

/** Toggle whether a persisted session is pinned in recent-tabs UIs. */
export async function setSessionPinned(
  id: string,
  pinned: boolean,
): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("db_set_session_pinned", { id, pinned });
  } catch (e) {
    logFrontendSoon({
      level: "error",
      tags: ["frontend", "db", "system"],
      event: "persistence.pin.error",
      message: "Failed to update pinned session state",
      kind: "error",
      data: { sessionId: id, pinned, error: e },
    });
  }
}

/** Permanently delete a session from the DB. */
export async function deleteSession(id: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("db_delete_session", { id });
  } catch (e) {
    logFrontendSoon({
      level: "error",
      tags: ["frontend", "db", "system"],
      event: "persistence.delete.error",
      message: "Failed to delete session",
      kind: "error",
      data: { sessionId: id, error: e },
    });
  }
}
