import { atom, createStore } from "jotai";
import { atomFamily } from "jotai-family";
import type { AgentState, AgentPlan, AgentConfig } from "./types";
import {
  coerceThemeName,
  type ThemeName,
} from "@/styles/themes/registry";

/* ─────────────────────────────────────────────────────────────────────────────
   Shared store — used by the runner (outside React) to read/write atoms
───────────────────────────────────────────────────────────────────────────── */

export const jotaiStore = createStore();

/* ─────────────────────────────────────────────────────────────────────────────
   Global state
───────────────────────────────────────────────────────────────────────────── */

import { atomWithStorage } from "jotai/utils";

/** UI colour scheme mode (light/dark) — persisted in localStorage */
export const themeModeAtom = atomWithStorage<"dark" | "light">(
  "rakh.theme-mode",
  "dark",
);

/** Global fallback communication profile */
export const globalCommunicationProfileAtom = atomWithStorage<string>(
  "rakh.communication-profile",
  "pragmatic",
);



/** Specific theme name applied over the mode — persisted in localStorage */
const themeNameStorage = {
  getItem(key: string, initialValue: ThemeName): ThemeName {
    if (typeof window === "undefined") return initialValue;
    return coerceThemeName(window.localStorage.getItem(key));
  },
  setItem(key: string, nextValue: ThemeName) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, nextValue);
  },
  removeItem(key: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  },
};
export const themeNameAtom = atomWithStorage<ThemeName>(
  "rakh.theme-name",
  "rakh",
  themeNameStorage,
);

/** Whether to notify when an agent needs attention (approval required) */
export const notifyOnAttentionAtom = atomWithStorage<boolean>(
  "rakh.notify-attention",
  false,
);

/** Whether inline tool calls are grouped by default across sessions */
export const groupInlineToolCallsAtom = atomWithStorage<boolean>(
  "rakh.group-inline-tool-calls",
  true,
);

/** Whether voice input is enabled in the chat composer */
export const voiceInputEnabledAtom = atomWithStorage<boolean>(
  "rakh.voice-input-enabled",
  false,
);

/** Local cached Whisper model path (informational UI state) */
export const voiceModelPathAtom = atomWithStorage<string>(
  "rakh.voice-model-path",
  "",
);

export type AppUpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "installing"
  | "restarting"
  | "error";

export interface AppUpdaterState {
  status: AppUpdaterStatus;
  availableVersion: string | null;
  availableDate: string | null;
  releaseNotes: string | null;
  lastCheckedAt: number | null;
  error: string | null;
  downloadedBytes: number;
  contentLength: number | null;
}

export const defaultAppUpdaterState: AppUpdaterState = {
  status: "idle",
  availableVersion: null,
  availableDate: null,
  releaseNotes: null,
  lastCheckedAt: null,
  error: null,
  downloadedBytes: 0,
  contentLength: null,
};

export type SessionPersistencePhase =
  | "never_saved"
  | "saving"
  | "saved"
  | "error";

export interface SessionPersistenceState {
  phase: SessionPersistencePhase;
  lastSavedAtMs: number | null;
  lastSavedSignature: string | null;
  lastSaveError: string | null;
}

export const defaultSessionPersistenceState: SessionPersistenceState = {
  phase: "never_saved",
  lastSavedAtMs: null,
  lastSavedSignature: null,
  lastSaveError: null,
};

/** Ephemeral updater state for signed desktop app updates. */
export const appUpdaterStateAtom = atom<AppUpdaterState>({
  ...defaultAppUpdaterState,
});

/** Default model for new agents */
export const DEFAULT_MODEL = "openai/gpt-5.2";

/* ─────────────────────────────────────────────────────────────────────────────
   Default values
───────────────────────────────────────────────────────────────────────────── */

const defaultPlan: AgentPlan = {
  markdown: "",
  updatedAtMs: 0,
  version: 0,
};

const defaultConfig: AgentConfig = {
  cwd: "",
  model: DEFAULT_MODEL,
};

function makeDefaultAgentState(): AgentState {
  return {
    status: "idle",
    config: { ...defaultConfig },
    chatMessages: [],
    apiMessages: [],
    streamingContent: null,
    plan: { ...defaultPlan },
    todos: [],
    error: null,
    errorDetails: null,
    errorAction: null,
    tabTitle: "",
    reviewEdits: [],
    autoApproveEdits: false,
    autoApproveCommands: "no",
    groupInlineToolCallsOverride: null,
    queuedMessages: [],
    queueState: "idle",
    showDebug: import.meta.env.DEV,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   Per-agent atom family — keyed by tabId
   atomFamily returns a stable atom for each unique key.
───────────────────────────────────────────────────────────────────────────── */

export const agentAtomFamily = atomFamily((_tabId: string) =>
  atom<AgentState>(makeDefaultAgentState()),
);

/* ─────────────────────────────────────────────────────────────────────────────
   Derived read-only atoms (for efficient subscriptions in UI components)
───────────────────────────────────────────────────────────────────────────── */

/** Just the status field for a given tab — cheap to subscribe to in TopChrome */
export const agentStatusAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).status),
);

/** Chat messages for the active tab's chat pane */
export const agentChatMessagesAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).chatMessages),
);

/** Current streaming text for a tab */
export const agentStreamingAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).streamingContent),
);

/** Plan for a tab (artifact pane) */
export const agentPlanAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).plan),
);

/** Todos for a tab (artifact pane) */
export const agentTodosAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).todos),
);

/** Config (cwd, model) for a tab */
export const agentConfigAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).config),
);

/** Error string for a tab (null when no error) */
export const agentErrorAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).error),
);

/** Raw error details object for a tab (null when no error) */
export const agentErrorDetailsAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).errorDetails),
);

/** Actionable follow-up metadata for a tab error (null when no action is available) */
export const agentErrorActionAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).errorAction),
);

/** Tab title for a tab (agent-set task description) */
export const agentTabTitleAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).tabTitle),
);

/** Review edits for a tab (artifact pane REVIEW tab) */
export const agentReviewEditsAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).reviewEdits),
);

/** Auto-approve edits for a tab */
export const agentAutoApproveEditsAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).autoApproveEdits),
);

/** Auto-approve commands for a tab */
export const agentAutoApproveCommandsAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).autoApproveCommands),
);

/** Per-tab override for grouped inline tools */
export const agentGroupInlineToolCallsOverrideAtomFamily = atomFamily(
  (tabId: string) =>
    atom((get) => get(agentAtomFamily(tabId)).groupInlineToolCallsOverride),
);

/** Effective grouped inline tools setting for a tab */
export const agentGroupInlineToolCallsAtomFamily = atomFamily((tabId: string) =>
  atom((get) => {
    const override = get(agentAtomFamily(tabId)).groupInlineToolCallsOverride;
    return override ?? get(groupInlineToolCallsAtom);
  }),
);

/** Queued user follow-ups for a tab */
export const agentQueuedMessagesAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).queuedMessages),
);

/** Queue drain / paused state for a tab */
export const agentQueueStateAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).queueState),
);

/** Debug UI mode for a tab */
export const agentShowDebugAtomFamily = atomFamily((tabId: string) =>
  atom((get) => get(agentAtomFamily(tabId)).showDebug ?? false),
);

/** Frontend-only persistence status for a tab's saved session snapshot */
export const agentSessionPersistenceAtomFamily = atomFamily((_tabId: string) =>
  atom<SessionPersistenceState>({ ...defaultSessionPersistenceState }),
);

/* ─────────────────────────────────────────────────────────────────────────────
   Helpers for the runner to patch state immutably
───────────────────────────────────────────────────────────────────────────── */

export function patchAgentState(
  tabId: string,
  patch: Partial<AgentState> | ((prev: AgentState) => AgentState),
): void {
  const atom = agentAtomFamily(tabId);
  if (typeof patch === "function") {
    jotaiStore.set(atom, patch(jotaiStore.get(atom)));
  } else {
    jotaiStore.set(atom, { ...jotaiStore.get(atom), ...patch });
  }
}

export function getAgentState(tabId: string): AgentState {
  return jotaiStore.get(agentAtomFamily(tabId));
}

export function patchSessionPersistenceState(
  tabId: string,
  patch:
    | Partial<SessionPersistenceState>
    | ((prev: SessionPersistenceState) => SessionPersistenceState),
): void {
  const atom = agentSessionPersistenceAtomFamily(tabId);
  if (typeof patch === "function") {
    jotaiStore.set(atom, patch(jotaiStore.get(atom)));
  } else {
    jotaiStore.set(atom, { ...jotaiStore.get(atom), ...patch });
  }
}

export function getSessionPersistenceState(tabId: string): SessionPersistenceState {
  return jotaiStore.get(agentSessionPersistenceAtomFamily(tabId));
}
