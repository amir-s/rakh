import type { Tab } from "@/contexts/TabsContext";
import { logFrontendSoon } from "@/logging/client";
import {
  defaultCommunicationProfileAtom,
  jotaiStore,
  patchAgentState,
} from "./atoms";
import { resolveCommunicationProfileId } from "./communicationProfiles";
import { profilesAtom } from "./db";
import {
  loadArchivedSessions,
  restoreSession,
  type PersistedSession,
} from "./persistence";
import type {
  AdvancedModelOptions,
  AgentQueueState,
  LlmUsageRecord,
  QueuedUserMessage,
} from "./types";

interface HydratePersistedSessionOptions {
  restoreError?: string | null;
}

type AddTabWithId = (tab: Tab) => void;
type SetActiveTab = (id: string) => void;

function parseAdvancedOptions(
  advancedOptions: string,
): AdvancedModelOptions | undefined {
  try {
    const parsed = advancedOptions
      ? (JSON.parse(advancedOptions) as Partial<AdvancedModelOptions>)
      : {};

    if (
      parsed.reasoningVisibility ||
      parsed.reasoningEffort ||
      parsed.latencyCostProfile
    ) {
      return parsed as AdvancedModelOptions;
    }
  } catch {
    // Ignore malformed JSON and fall back to defaults.
  }

  return undefined;
}

function buildTabFromSession(session: PersistedSession): Tab {
  return {
    id: session.id,
    label: session.label,
    icon: session.icon,
    pinned: session.pinned,
    status: "idle",
    mode: session.mode as Tab["mode"],
  };
}

async function openPersistedSessionTab(
  session: PersistedSession,
  addTabWithId: AddTabWithId,
  restoreArchived: boolean,
): Promise<void> {
  if (restoreArchived) {
    await restoreSession(session);
  }

  try {
    hydratePersistedSession(session);
  } catch (error) {
    logFrontendSoon({
      level: "error",
      tags: ["frontend", "db", "system"],
      event: "sessionRestore.hydrate.error",
      message: "Failed to hydrate restored session",
      kind: "error",
      data: { sessionId: session.id, error },
    });
  }

  addTabWithId(buildTabFromSession(session));
}

function parseQueuedMessages(queuedMessages: string): QueuedUserMessage[] {
  try {
    const parsed = queuedMessages
      ? (JSON.parse(queuedMessages) as QueuedUserMessage[])
      : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseLlmUsageLedger(llmUsageLedger: string): LlmUsageRecord[] {
  try {
    const parsed = llmUsageLedger
      ? (JSON.parse(llmUsageLedger) as LlmUsageRecord[])
      : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseQueueState(
  queueState: string,
  queuedMessages: QueuedUserMessage[],
): AgentQueueState {
  if (queuedMessages.length === 0) return "idle";
  if (queueState === "paused") return "paused";
  if (queueState === "draining" && queuedMessages.length > 0) {
    // Restored sessions must never auto-resume queued follow-ups.
    return "paused";
  }
  return "paused";
}

export function hydratePersistedSession(
  session: PersistedSession,
  options: HydratePersistedSessionOptions = {},
): void {
  const restoreError = options.restoreError ?? null;
  const queuedMessages = parseQueuedMessages(session.queuedMessages);
  const queueState = parseQueueState(session.queueState, queuedMessages);
  const llmUsageLedger = parseLlmUsageLedger(session.llmUsageLedger);
  const communicationProfile = resolveCommunicationProfileId(
    session.communicationProfile,
    jotaiStore.get(profilesAtom),
    jotaiStore.get(defaultCommunicationProfileAtom),
  );

  patchAgentState(session.id, {
    status: restoreError ? "error" : "idle",
    tabTitle: session.tabTitle,
    config: {
      cwd: session.cwd,
      projectPath: session.projectPath || undefined,
      setupCommand: session.setupCommand || undefined,
      model: session.model,
      worktreePath: session.worktreePath || undefined,
      worktreeBranch: session.worktreeBranch || undefined,
      worktreeDeclined: session.worktreeDeclined || undefined,
      advancedOptions: parseAdvancedOptions(session.advancedOptions),
      communicationProfile,
    },
    plan: {
      markdown: session.planMarkdown,
      version: session.planVersion,
      updatedAtMs: session.planUpdatedAt,
    },
    chatMessages: JSON.parse(session.chatMessages),
    apiMessages: JSON.parse(session.apiMessages),
    todos: JSON.parse(session.todos),
    reviewEdits: JSON.parse(session.reviewEdits ?? "[]"),
    queuedMessages,
    queueState,
    llmUsageLedger,
    streamingContent: null,
    error: restoreError,
    showDebug: session.showDebug ?? false,
  });
}

export async function restoreArchivedTab(
  session: PersistedSession,
  addTabWithId: AddTabWithId,
): Promise<void> {
  await openPersistedSessionTab(session, addTabWithId, true);
}

export async function focusOrOpenPersistedSession(
  session: PersistedSession,
  options: {
    addTabWithId: AddTabWithId;
    setActiveTab: SetActiveTab;
    tabs: Tab[];
  },
): Promise<"focused" | "restored" | "opened"> {
  if (options.tabs.some((tab) => tab.id === session.id)) {
    options.setActiveTab(session.id);
    return "focused";
  }

  await openPersistedSessionTab(
    session,
    options.addTabWithId,
    session.archived,
  );
  return session.archived ? "restored" : "opened";
}

export async function restoreMostRecentArchivedTab(
  addTabWithId: AddTabWithId,
): Promise<PersistedSession | null> {
  const [session] = await loadArchivedSessions();
  if (!session) return null;

  await restoreArchivedTab(session, addTabWithId);
  return session;
}
