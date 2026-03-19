import {
  DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS,
  evaluateAutoContextCompactionTrigger,
  type AutoContextCompactionTrigger,
} from "../contextCompaction";
import {
  autoContextCompactionSettingsAtom,
  getAgentState,
  jotaiStore,
  patchAgentState,
} from "../atoms";
import { providersAtom } from "../db";
import { estimateCurrentContextStats } from "../sessionStats";
import { getSubagent } from "../subagents";
import type { SubagentDefinition } from "../subagents";
import { artifactGet } from "../tools/artifacts";
import { buildConversationCard } from "../tools/agentControl";
import type { ApiMessage, ChatMessage, TodoItem } from "../types";
import type { LogContext } from "@/logging/types";
import {
  cloneLearnedFacts,
  loadSavedProjectForWorkspace,
  upsertSavedProject,
  type ProjectLearnedFact,
} from "@/projects";

import { appendChatMessage, msgId } from "./chatState";
import { buildMainSystemPromptForState } from "./mainSystemPrompt";
import { runSubagentLoop } from "./subagentLoop";

export const COMPACT_TRIGGER_SUBAGENT_ID = "compact";
export const COMPACT_SUMMARY_CARD_TITLE = "Compacted Context";

const COMPACT_REQUIRED_SECTIONS = [
  "[COMPACTED HISTORY]",
  "Current task",
  "User goal",
  "Hard constraints",
  "What has been done",
  "Important facts discovered",
  "Files / artifacts / outputs created",
  "Decisions already made",
  "Unresolved issues",
  "Exact next step",
] as const;

interface ProjectMemorySnapshot {
  projectPath: string;
  learnedFacts?: ProjectLearnedFact[];
}

type ContextCompactionPayload =
  | {
      ok: true;
      systemPrompt: string;
      message: string;
      projectMemorySnapshot: ProjectMemorySnapshot | null;
    }
  | {
      ok: false;
      error: string;
    };

type MainContextCompactionResult =
  | { ok: true; compactedContent: string }
  | { ok: false; message: string; error?: unknown };

export type AutoMainContextCompactionResult =
  | { status: "skipped"; reason: string }
  | {
      status: "compacted";
      trigger: AutoContextCompactionTrigger;
      compactedContent: string;
    }
  | {
      status: "failed";
      trigger: AutoContextCompactionTrigger;
      message: string;
      error?: unknown;
    };

function projectTodoForCompaction(todo: TodoItem): Record<string, unknown> {
  return {
    id: todo.id,
    title: todo.title,
    state: todo.state,
    ...(todo.completionNote ? { completionNote: todo.completionNote } : {}),
    filesTouched: [...todo.filesTouched],
    thingsLearned: todo.thingsLearned.map((note) => ({
      text: note.text,
      verified: note.verified,
    })),
    criticalInfo: todo.criticalInfo.map((note) => ({
      text: note.text,
      verified: note.verified,
    })),
  };
}

async function restoreProjectMemorySnapshot(
  snapshot: ProjectMemorySnapshot | null,
): Promise<void> {
  if (!snapshot) return;

  const project = await loadSavedProjectForWorkspace(snapshot.projectPath);
  if (!project) return;

  const restoredProject = { ...project };
  if (snapshot.learnedFacts?.length) {
    restoredProject.learnedFacts = cloneLearnedFacts(snapshot.learnedFacts);
  } else {
    delete restoredProject.learnedFacts;
  }
  await upsertSavedProject(restoredProject);
}

function buildContextCompactionPayload(
  apiMessages: ApiMessage[],
  state: ReturnType<typeof getAgentState>,
): Promise<ContextCompactionPayload> {
  return (async () => {
    const firstMessage = apiMessages[0];
    if (!firstMessage || firstMessage.role !== "system") {
      return {
        ok: false,
        error:
          "Nothing to compact yet. The main agent has no system prompt in its internal history.",
      };
    }

    const messages = apiMessages.slice(1);
    if (messages.length === 0) {
      return {
        ok: false,
        error:
          "Nothing to compact yet. The main agent has no internal conversation history beyond the system prompt.",
      };
    }

    const project = await loadSavedProjectForWorkspace(
      state.config.projectPath,
      state.config.cwd,
    );
    const payload = {
      system_prompt: firstMessage.content,
      messages,
      current_plan: {
        markdown: state.plan.markdown,
        version: state.plan.version,
        updatedAtMs: state.plan.updatedAtMs,
      },
      todos: state.todos.map(projectTodoForCompaction),
      project_memory: {
        project_path: project?.path ?? null,
        learned_facts: project?.learnedFacts ?? [],
        writable: project !== null,
      },
    };

    return {
      ok: true,
      systemPrompt: firstMessage.content,
      message: JSON.stringify(payload, null, 2),
      projectMemorySnapshot: project
        ? {
            projectPath: project.path,
            ...(project.learnedFacts?.length
              ? { learnedFacts: cloneLearnedFacts(project.learnedFacts) }
              : {}),
          }
        : null,
    };
  })();
}

function validateCompactedHistoryMarkdown(content: string): string | null {
  const missing = COMPACT_REQUIRED_SECTIONS.filter(
    (section) => !content.includes(section),
  );
  if (missing.length === 0) return null;
  return `Compacted history is missing required sections: ${missing.join(", ")}`;
}

function createCompactionSummaryChatMessage(
  subagentDef: SubagentDefinition,
  content: string,
  markdown: string,
): { ok: true; message: ChatMessage } | { ok: false; message: string } {
  const summaryCard = buildConversationCard({
    kind: "summary",
    title: COMPACT_SUMMARY_CARD_TITLE,
    markdown,
  });
  if (!summaryCard.ok) {
    return {
      ok: false,
      message: `Compaction succeeded but the summary card could not be created: ${summaryCard.error.message}`,
    };
  }

  return {
    ok: true,
    message: {
      id: msgId(),
      role: "assistant",
      content,
      timestamp: Date.now(),
      agentName: subagentDef.name,
      cards: [summaryCard.data.card],
    },
  };
}

function isCompactedHistoryHandoffMessage(
  message: ApiMessage | undefined,
): boolean {
  return (
    message?.role === "user" &&
    typeof message.content === "string" &&
    message.content.includes("[COMPACTED HISTORY]")
  );
}

export function hasOnlyCompactedHistory(apiMessages: ApiMessage[]): boolean {
  return (
    apiMessages.length <= 2 &&
    apiMessages[0]?.role === "system" &&
    isCompactedHistoryHandoffMessage(apiMessages[1])
  );
}

export async function executeMainContextCompaction(opts: {
  tabId: string;
  signal: AbortSignal;
  runId: string;
  currentTurn: number;
  logContext: LogContext;
  mode: "manual" | "automatic";
}): Promise<MainContextCompactionResult> {
  const subagentDef = getSubagent(COMPACT_TRIGGER_SUBAGENT_ID);
  if (!subagentDef) {
    return {
      ok: false,
      message: 'Internal error: missing "compact" subagent definition.',
    };
  }

  const state = getAgentState(opts.tabId);
  const payload = await buildContextCompactionPayload(state.apiMessages, state);
  if (!payload.ok) {
    return { ok: false, message: payload.error };
  }

  const triggerProviders = jotaiStore.get(providersAtom);
  const triggerDebug = state.showDebug ?? false;
  let restoredProjectMemory = false;

  const maybeRestoreProjectMemory = async (): Promise<void> => {
    if (restoredProjectMemory) return;
    restoredProjectMemory = true;
    await restoreProjectMemorySnapshot(payload.projectMemorySnapshot);
  };

  try {
    const subagentResult = await runSubagentLoop({
      tabId: opts.tabId,
      signal: opts.signal,
      runId: opts.runId,
      currentTurn: opts.currentTurn,
      subagentDef,
      message: payload.message,
      parentModelId: state.config.model,
      providers: triggerProviders,
      debugEnabled: triggerDebug,
      logContext: opts.logContext,
      suppressChatOutput: false,
    });

    if (!subagentResult.ok) {
      await maybeRestoreProjectMemory();
      return {
        ok: false,
        message: subagentResult.error.message,
        error: subagentResult.error,
      };
    }

    const artifactManifest = subagentResult.data.artifacts[0];
    if (!artifactManifest) {
      await maybeRestoreProjectMemory();
      return {
        ok: false,
        message:
          "Compaction finished without producing a compacted context artifact.",
      };
    }

    const artifactResult = await artifactGet(opts.tabId, {
      artifactId: artifactManifest.artifactId,
      includeContent: true,
    });
    if (!artifactResult.ok) {
      await maybeRestoreProjectMemory();
      return {
        ok: false,
        message: artifactResult.error.message,
        error: artifactResult.error,
      };
    }

    const compactedContent = artifactResult.data.artifact.content;
    if (typeof compactedContent !== "string" || !compactedContent.trim()) {
      await maybeRestoreProjectMemory();
      return {
        ok: false,
        message: "Compaction artifact is missing its markdown content.",
      };
    }

    const compactedValidationError =
      validateCompactedHistoryMarkdown(compactedContent);
    if (compactedValidationError) {
      await maybeRestoreProjectMemory();
      return { ok: false, message: compactedValidationError };
    }

    const refreshedSystemPrompt = await buildMainSystemPromptForState(
      getAgentState(opts.tabId),
      { forceRefresh: true },
    );

    const summaryMessage = createCompactionSummaryChatMessage(
      subagentDef,
      opts.mode === "automatic"
        ? "Context compacted automatically."
        : subagentResult.data.rawText.trim() || "Context compacted.",
      compactedContent,
    );
    if (!summaryMessage.ok) {
      await maybeRestoreProjectMemory();
      return { ok: false, message: summaryMessage.message };
    }

    patchAgentState(opts.tabId, (prev) => ({
      ...prev,
      apiMessages: [
        { role: "system", content: refreshedSystemPrompt },
        {
          role: "user",
          content:
            "Synthetic compacted-history handoff for context management.\n" +
            "Treat this as runner-provided state, not as a new user request.\n\n" +
            compactedContent,
        },
      ],
    }));
    appendChatMessage(opts.tabId, summaryMessage.message);

    return { ok: true, compactedContent };
  } catch (error) {
    await maybeRestoreProjectMemory();
    throw error;
  }
}

export async function maybeRunAutomaticMainContextCompaction(opts: {
  tabId: string;
  signal: AbortSignal;
  runId: string;
  currentTurn: number;
  logContext: LogContext;
}): Promise<AutoMainContextCompactionResult> {
  const state = getAgentState(opts.tabId);
  if (hasOnlyCompactedHistory(state.apiMessages)) {
    return {
      status: "skipped",
      reason: "Only the compacted summary remains in apiMessages.",
    };
  }

  const settings =
    jotaiStore.get(autoContextCompactionSettingsAtom) ??
    DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS;
  const trigger = evaluateAutoContextCompactionTrigger(
    estimateCurrentContextStats(state.apiMessages, state.config.contextLength),
    settings,
  );
  if (!trigger) {
    return {
      status: "skipped",
      reason: "Automatic compaction threshold has not been reached.",
    };
  }

  const result = await executeMainContextCompaction({
    tabId: opts.tabId,
    signal: opts.signal,
    runId: opts.runId,
    currentTurn: opts.currentTurn,
    logContext: opts.logContext,
    mode: "automatic",
  });

  if (!result.ok) {
    return {
      status: "failed",
      trigger,
      message: result.message,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  return {
    status: "compacted",
    trigger,
    compactedContent: result.compactedContent,
  };
}
