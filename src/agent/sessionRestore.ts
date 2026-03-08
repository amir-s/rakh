import type { Tab } from "@/contexts/TabsContext";
import { patchAgentState } from "./atoms";
import {
  loadArchivedSessions,
  restoreSession,
  type PersistedSession,
} from "./persistence";
import type { AdvancedModelOptions } from "./types";

interface HydratePersistedSessionOptions {
  restoreError?: string | null;
}

type AddTabWithId = (tab: Tab) => void;

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
    status: "idle",
    mode: session.mode as Tab["mode"],
  };
}

export function hydratePersistedSession(
  session: PersistedSession,
  options: HydratePersistedSessionOptions = {},
): void {
  const restoreError = options.restoreError ?? null;

  patchAgentState(session.id, {
    status: restoreError ? "error" : "idle",
    tabTitle: session.tabTitle,
    config: {
      cwd: session.cwd,
      model: session.model,
      worktreePath: session.worktreePath || undefined,
      worktreeBranch: session.worktreeBranch || undefined,
      worktreeDeclined: session.worktreeDeclined || undefined,
      advancedOptions: parseAdvancedOptions(session.advancedOptions),
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
    streamingContent: null,
    error: restoreError,
    showDebug: session.showDebug ?? false,
  });
}

export async function restoreArchivedTab(
  session: PersistedSession,
  addTabWithId: AddTabWithId,
): Promise<void> {
  await restoreSession(session);

  try {
    hydratePersistedSession(session);
  } catch (error) {
    console.error("rakh: failed to hydrate restored session", error);
  }

  addTabWithId(buildTabFromSession(session));
}

export async function restoreMostRecentArchivedTab(
  addTabWithId: AddTabWithId,
): Promise<PersistedSession | null> {
  const [session] = await loadArchivedSessions();
  if (!session) return null;

  await restoreArchivedTab(session, addTabWithId);
  return session;
}
