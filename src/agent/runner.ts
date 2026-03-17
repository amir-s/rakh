/**
 * Agent runner — the core agentic loop facade.
 *
 * Public API lives here. Internal helpers and loops live under ./runner/*.
 */

import {
  cloneLearnedFacts,
  loadSavedProjectForWorkspace,
  type ProjectLearnedFact,
  upsertSavedProject,
} from "@/projects";
import {
  getAgentState,
  patchAgentState,
  jotaiStore,
} from "./atoms";
import { providersAtom } from "./db";
import { getModelCatalogEntry } from "./modelCatalog";
import { execAbort, execStop } from "./tools/exec";
import { findSubagentByTrigger, type SubagentDefinition } from "./subagents";
import { cancelAllApprovals } from "./approvals";
import type {
  ApiMessage,
  AttachedImage,
  AgentQueueState,
  ChatMessage,
  ConversationCard,
  QueuedUserMessage,
  TodoItem,
  ToolApiMessage,
  ToolCallDisplay,
} from "./types";

import {
  type ActiveRun,
  type AgentAbortReason,
  clearActiveRun,
  getActiveRun,
  hasActiveRun,
  nextRunId,
  setActiveRun,
} from "./runner/abortRegistry";
import { agentLoop } from "./runner/agentLoop";
import { msgId, updateLastChatMessage } from "./runner/chatState";
import {
  createMainRunLogContext,
  writeRunnerLog,
} from "./runner/logging";
import { buildProviderOptions } from "./runner/providerOptions";
import { runSubagentLoop } from "./runner/subagentLoop";
import {
  buildSystemPrompt,
  buildSystemPromptRuntimeContext,
} from "./runner/systemPrompt";
import { RunAbortedError, serializeError } from "./runner/utils";
import { artifactGet } from "./tools/artifacts";
import { buildConversationCard } from "./tools/agentControl";

export { buildProviderOptions } from "./runner/providerOptions";
export { serializeError } from "./runner/utils";

function normalizeQueueState(
  queuedMessages: QueuedUserMessage[],
  queueState: AgentQueueState,
): AgentQueueState {
  if (queuedMessages.length === 0) return "idle";
  return queueState === "paused" ? "paused" : "draining";
}

function pauseQueueState(
  queuedMessages: QueuedUserMessage[],
  queueState: AgentQueueState,
): AgentQueueState {
  if (queuedMessages.length === 0) return "idle";
  return queueState === "draining" || queueState === "paused"
    ? "paused"
    : "paused";
}

function setAgentErrorState(
  tabId: string,
  error: string,
  errorDetails?: unknown,
  errorAction: { type: "open-settings-section"; section: "providers"; label: string } | null = null,
): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    status: "error",
    error,
    errorAction,
    errorDetails: errorDetails ?? null,
    streamingContent: null,
    queueState: pauseQueueState(prev.queuedMessages, prev.queueState),
  }));
}

const COMPACT_TRIGGER_SUBAGENT_ID = "compact";
const COMPACT_SUMMARY_CARD_TITLE = "Compacted Context";
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

function appendAssistantChatMessage(
  tabId: string,
  content: string,
  options?: {
    agentName?: string;
    cards?: ConversationCard[];
  },
): void {
  const trimmed = content.trim();
  patchAgentState(tabId, (prev) => ({
    ...prev,
    chatMessages: [
      ...prev.chatMessages,
      {
        id: msgId(),
        role: "assistant",
        content: trimmed,
        timestamp: Date.now(),
        ...(options?.agentName ? { agentName: options.agentName } : {}),
        ...(options?.cards && options.cards.length > 0
          ? { cards: options.cards }
          : {}),
      },
    ],
  }));
}

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

interface ProjectMemorySnapshot {
  projectPath: string;
  learnedFacts?: ProjectLearnedFact[];
}

async function inspectWorkspaceForSystemPrompt(
  cwd: string,
): Promise<{
  isGitRepo: boolean;
  hasAgentsFile: boolean;
  hasSkillsDir: boolean;
}> {
  let isGitRepo = false;
  let hasAgentsFile = false;
  let hasSkillsDir = false;

  if (!cwd) {
    return { isGitRepo, hasAgentsFile, hasSkillsDir };
  }

  try {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    const gitResult = await tauriInvoke<{ exitCode: number }>("exec_run", {
      command: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd,
      env: {},
      timeoutMs: 5000,
      maxStdoutBytes: 512,
      maxStderrBytes: 512,
      stdin: null,
    });
    isGitRepo = gitResult.exitCode === 0;

    const agentsStat = await tauriInvoke<{ exists: boolean; kind?: string }>(
      "stat_file",
      {
        path: `${cwd}/AGENTS.md`,
      },
    );
    hasAgentsFile = agentsStat.exists && agentsStat.kind === "file";

    const skillsStat = await tauriInvoke<{ exists: boolean; kind?: string }>(
      "stat_file",
      {
        path: `${cwd}/.agents/skills`,
      },
    );
    hasSkillsDir = skillsStat.exists && skillsStat.kind === "dir";
  } catch {
    // Not in Tauri or git not available.
  }

  return { isGitRepo, hasAgentsFile, hasSkillsDir };
}

async function buildMainSystemPromptForState(
  state: ReturnType<typeof getAgentState>,
): Promise<string> {
  const cwd = state.config.cwd;
  const workspaceInfo = await inspectWorkspaceForSystemPrompt(cwd);
  const project = await loadSavedProjectForWorkspace(
    state.config.projectPath,
    cwd,
  );

  return buildSystemPrompt(
    cwd,
    workspaceInfo.isGitRepo,
    workspaceInfo.hasAgentsFile,
    workspaceInfo.hasSkillsDir,
    buildSystemPromptRuntimeContext(),
    project?.learnedFacts,
    state.config.communicationProfile,
  );
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

async function buildManualCompactionPayload(
  apiMessages: ApiMessage[],
  state: ReturnType<typeof getAgentState>,
): Promise<{ ok: true; systemPrompt: string; message: string; projectMemorySnapshot: ProjectMemorySnapshot | null } | {
  ok: false;
  error: string;
}> {
  const firstMessage = apiMessages[0];
  if (!firstMessage || firstMessage.role !== "system") {
    return {
      ok: false,
      error: "Nothing to compact yet. The main agent has no system prompt in its internal history.",
    };
  }

  const messages = apiMessages.slice(1);
  if (messages.length === 0) {
    return {
      ok: false,
      error: "Nothing to compact yet. The main agent has no internal conversation history beyond the system prompt.",
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
}

function validateCompactedHistoryMarkdown(content: string): string | null {
  const missing = COMPACT_REQUIRED_SECTIONS.filter(
    (section) => !content.includes(section),
  );
  if (missing.length === 0) return null;
  return `Compacted history is missing required sections: ${missing.join(", ")}`;
}

async function runManualCompactionTrigger(
  tabId: string,
  userMessage: string,
  triggerSubagent: SubagentDefinition,
  controller: AbortController,
  runId: string,
  currentTurn: number,
  runLogContext: ReturnType<typeof createMainRunLogContext>["childContext"],
): Promise<{ ok: true } | { ok: false; error?: unknown }> {
  const compactArgs = userMessage
    .trim()
    .slice(triggerSubagent.triggerCommand?.length ?? 0)
    .trim();
  if (compactArgs.length > 0) {
    appendAssistantChatMessage(
      tabId,
      "`/compact` does not accept arguments. Run `/compact` by itself.",
      { agentName: triggerSubagent.name },
    );
    return { ok: true };
  }

  const state = getAgentState(tabId);
  const payload = await buildManualCompactionPayload(state.apiMessages, state);
  if (!payload.ok) {
    appendAssistantChatMessage(tabId, payload.error, {
      agentName: triggerSubagent.name,
    });
    return { ok: true };
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
      tabId,
      signal: controller.signal,
      runId,
      currentTurn,
      subagentDef: triggerSubagent,
      message: payload.message,
      parentModelId: state.config.model,
      providers: triggerProviders,
      debugEnabled: triggerDebug,
      logContext: runLogContext,
      suppressChatOutput: false,
    });

    if (!subagentResult.ok) {
      await maybeRestoreProjectMemory();
      appendAssistantChatMessage(tabId, subagentResult.error.message, {
        agentName: triggerSubagent.name,
      });
      return { ok: false, error: subagentResult.error };
    }

    const artifactManifest = subagentResult.data.artifacts[0];
    if (!artifactManifest) {
      await maybeRestoreProjectMemory();
      appendAssistantChatMessage(
        tabId,
        "Compaction finished without producing a compacted context artifact.",
        { agentName: triggerSubagent.name },
      );
      return { ok: false };
    }

    const artifactResult = await artifactGet(tabId, {
      artifactId: artifactManifest.artifactId,
      includeContent: true,
    });
    if (!artifactResult.ok) {
      await maybeRestoreProjectMemory();
      appendAssistantChatMessage(tabId, artifactResult.error.message, {
        agentName: triggerSubagent.name,
      });
      return { ok: false, error: artifactResult.error };
    }

    const compactedContent = artifactResult.data.artifact.content;
    if (typeof compactedContent !== "string" || !compactedContent.trim()) {
      await maybeRestoreProjectMemory();
      appendAssistantChatMessage(
        tabId,
        "Compaction artifact is missing its markdown content.",
        { agentName: triggerSubagent.name },
      );
      return { ok: false };
    }

    const compactedValidationError =
      validateCompactedHistoryMarkdown(compactedContent);
    if (compactedValidationError) {
      await maybeRestoreProjectMemory();
      appendAssistantChatMessage(tabId, compactedValidationError, {
        agentName: triggerSubagent.name,
      });
      return { ok: false };
    }

    const summaryCard = buildConversationCard({
      kind: "summary",
      title: COMPACT_SUMMARY_CARD_TITLE,
      markdown: compactedContent,
    });
    if (!summaryCard.ok) {
      appendAssistantChatMessage(
        tabId,
        `Compaction succeeded but the summary card could not be created: ${summaryCard.error.message}`,
        { agentName: triggerSubagent.name },
      );
      await maybeRestoreProjectMemory();
      return { ok: false, error: summaryCard.error };
    }

    const refreshedSystemPrompt = await buildMainSystemPromptForState(
      getAgentState(tabId),
    );

    patchAgentState(tabId, (prev) => ({
      ...prev,
      apiMessages: [
        { role: "system", content: refreshedSystemPrompt },
        { role: "assistant", content: compactedContent },
      ],
      chatMessages: [
        ...prev.chatMessages,
        {
          id: msgId(),
          role: "assistant",
          content: subagentResult.data.rawText.trim() || "Context compacted.",
          timestamp: Date.now(),
          agentName: triggerSubagent.name,
          cards: [summaryCard.data.card],
        },
      ],
    }));

    return { ok: true };
  } catch (error) {
    await maybeRestoreProjectMemory();
    throw error;
  }
}

function findRunningExecToolCallIds(tabId: string): string[] {
  const state = getAgentState(tabId);
  const ids: string[] = [];
  for (const msg of state.chatMessages) {
    for (const tc of msg.toolCalls ?? []) {
      const gitSetupRunning =
        tc.tool === "git_worktree_init" &&
        tc.status === "running" &&
        tc.args.setupPhase === "running_setup";
      if ((tc.tool === "exec_run" && tc.status === "running") || gitSetupRunning) {
        ids.push(tc.id);
      }
    }
  }
  return ids;
}

function hasRunningExecToolCall(tabId: string, toolCallId: string): boolean {
  const state = getAgentState(tabId);
  for (const msg of state.chatMessages) {
    for (const tc of msg.toolCalls ?? []) {
      if (
        tc.id === toolCallId &&
        tc.status === "running" &&
        (tc.tool === "exec_run" ||
          (tc.tool === "git_worktree_init" &&
            tc.args.setupPhase === "running_setup"))
      ) {
        return true;
      }
    }
  }
  return false;
}

interface IncompleteToolCall {
  toolCallId: string;
  toolName: string;
}

function findIncompleteToolCalls(tabId: string): IncompleteToolCall[] {
  const state = getAgentState(tabId);
  const incomplete: IncompleteToolCall[] = [];

  const completedToolCallIds = new Set<string>();
  for (const msg of state.apiMessages) {
    if (msg.role === "tool") {
      completedToolCallIds.add(msg.tool_call_id);
    }
  }

  for (const msg of state.apiMessages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!completedToolCallIds.has(tc.id)) {
          incomplete.push({
            toolCallId: tc.id,
            toolName: tc.function.name,
          });
        }
      }
    }
  }

  return incomplete;
}

function interruptActiveRun(
  tabId: string,
  reason: AgentAbortReason,
  options: { pauseQueue: boolean },
): void {
  const stoppedAtMs = Date.now();
  const runningExecIds = findRunningExecToolCallIds(tabId);
  for (const toolCallId of runningExecIds) {
    void execAbort(toolCallId);
  }
  const activeRun = getActiveRun(tabId);
  if (activeRun) {
    activeRun.abortReason = reason;
    activeRun.controller.abort();
  }

  const incompleteToolCalls = findIncompleteToolCalls(tabId);
  const synthesizedToolMessages: ToolApiMessage[] = incompleteToolCalls.map(
    ({ toolCallId, toolName }) => ({
      role: "tool" as const,
      tool_call_id: toolCallId,
      content: JSON.stringify({
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Agent was stopped before tool call "${toolName}" completed.`,
        },
      }),
    }),
  );

  const isIncompleteStatus = (status: ToolCallDisplay["status"]): boolean =>
    status === "pending" ||
    status === "awaiting_approval" ||
    status === "awaiting_worktree" ||
    status === "awaiting_branch_release" ||
    status === "awaiting_setup_action" ||
    status === "running";

  patchAgentState(tabId, (prev) => ({
    ...prev,
    status: "idle",
    streamingContent: null,
    queueState: options.pauseQueue
      ? pauseQueueState(prev.queuedMessages, prev.queueState)
      : normalizeQueueState(prev.queuedMessages, prev.queueState),
    apiMessages:
      synthesizedToolMessages.length > 0
        ? [...prev.apiMessages, ...synthesizedToolMessages]
        : prev.apiMessages,
    chatMessages: prev.chatMessages.map((msg) => {
      const shouldFinalizeReasoningDuration =
        typeof msg.reasoningStartedAtMs === "number" &&
        typeof msg.reasoningDurationMs !== "number";
      const finalizedReasoningDurationMs = shouldFinalizeReasoningDuration
        ? Math.max(0, stoppedAtMs - (msg.reasoningStartedAtMs ?? 0))
        : msg.reasoningDurationMs;

      const nextMsg =
        msg.streaming ||
        msg.reasoningStreaming ||
        shouldFinalizeReasoningDuration
          ? {
              ...msg,
              streaming: false,
              reasoningStreaming: undefined,
              reasoningDurationMs: finalizedReasoningDurationMs,
            }
          : msg;

      if (!nextMsg.toolCalls) return nextMsg;
      return {
        ...nextMsg,
        toolCalls: nextMsg.toolCalls.map((tc) =>
          isIncompleteStatus(tc.status)
            ? {
                ...tc,
                status: "error" as const,
                result: {
                  code: "INTERNAL",
                  message:
                    tc.tool === "exec_run" && tc.status === "running"
                      ? "User aborted the execution of this command. No stdout/stderr will be returned."
                      : "Agent was stopped before this tool call completed.",
                },
              }
            : tc,
        ),
      };
    }),
  }));
  cancelAllApprovals(tabId);
}

async function maybeStartQueuedRun(tabId: string): Promise<void> {
  const state = getAgentState(tabId);
  if (state.queueState !== "draining") return;
  if (hasActiveRun(tabId)) return;

  const nextQueuedMessage = state.queuedMessages[0];
  if (!nextQueuedMessage) {
    patchAgentState(tabId, (prev) =>
      prev.queueState === "draining" ? { ...prev, queueState: "idle" } : prev,
    );
    return;
  }

  await runAgentTurn(tabId, nextQueuedMessage.content, undefined, {
    queuedMessageId: nextQueuedMessage.id,
  });
}

export function queueMessage(tabId: string, userMessage: string): void {
  const content = userMessage.trim();
  if (!content) return;

  patchAgentState(tabId, (prev) => ({
    ...prev,
    queuedMessages: [
      ...prev.queuedMessages,
      {
        id: msgId(),
        content,
        createdAtMs: Date.now(),
      },
    ],
    queueState: prev.queueState === "paused" ? "paused" : "draining",
  }));

  void maybeStartQueuedRun(tabId).catch((error) => {
    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.queue.start.error",
      message: "Failed to start queued run",
      kind: "error",
      data: error,
      context: { sessionId: tabId, tabId, depth: 0 },
    });
  });
}

export async function steerMessage(
  tabId: string,
  userMessage: string,
  queuedMessageId?: string,
): Promise<void> {
  const content = userMessage.trim();
  if (!content) return;

  if (hasActiveRun(tabId)) {
    interruptActiveRun(tabId, "steer", { pauseQueue: false });
  }

  await runAgentTurn(tabId, content, undefined, { queuedMessageId });
}

export function resumeQueue(tabId: string): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    queueState: prev.queuedMessages.length > 0 ? "draining" : "idle",
  }));
  void maybeStartQueuedRun(tabId).catch((error) => {
    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "system"],
      event: "runner.queue.resume.error",
      message: "Failed to resume queued run",
      kind: "error",
      data: error,
      context: { sessionId: tabId, tabId, depth: 0 },
    });
  });
}

export function removeQueuedMessage(tabId: string, messageId: string): void {
  patchAgentState(tabId, (prev) => {
    const queuedMessages = prev.queuedMessages.filter(
      (message) => message.id !== messageId,
    );
    return {
      ...prev,
      queuedMessages,
      queueState:
        queuedMessages.length === 0 ? "idle" : prev.queueState,
    };
  });
}

export function clearQueuedMessages(tabId: string): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    queuedMessages: [],
    queueState: "idle",
  }));
}

export function stopAgent(tabId: string): void {
  interruptActiveRun(tabId, "user_stop", { pauseQueue: true });
}

export async function stopRunningExecToolCall(
  tabId: string,
  toolCallId: string,
): Promise<boolean> {
  if (!hasRunningExecToolCall(tabId, toolCallId)) return false;
  return execStop(toolCallId);
}

export async function retryAgent(tabId: string): Promise<void> {
  const state = getAgentState(tabId);

  let lastUserMessage: string | null = null;
  let lastUserIndex = -1;
  for (let i = state.apiMessages.length - 1; i >= 0; i--) {
    const msg = state.apiMessages[i];
    if (msg.role === "user" && typeof msg.content === "string") {
      lastUserMessage = msg.content;
      lastUserIndex = i;
      break;
    }
  }

  if (!lastUserMessage) return;

  const strippedApiMessages = state.apiMessages.slice(0, lastUserIndex);

  let lastUserChatIndex = -1;
  for (let i = state.chatMessages.length - 1; i >= 0; i--) {
    if (state.chatMessages[i].role === "user") {
      lastUserChatIndex = i;
      break;
    }
  }
  const strippedChatMessages =
    lastUserChatIndex >= 0
      ? state.chatMessages.slice(0, lastUserChatIndex + 1)
      : state.chatMessages;

  patchAgentState(tabId, {
    apiMessages: strippedApiMessages,
    chatMessages: strippedChatMessages,
    error: null,
    errorDetails: null,
    errorAction: null,
  });

  await runAgent(tabId, lastUserMessage, undefined, { skipUserChatAppend: true });
}

interface RunAgentTurnOptions {
  queuedMessageId?: string;
  skipUserChatAppend?: boolean;
}

function dequeueQueuedMessage(
  tabId: string,
  queuedMessageId: string | undefined,
): void {
  if (!queuedMessageId) return;

  patchAgentState(tabId, (prev) => {
    const queuedMessages = prev.queuedMessages.filter(
      (message) => message.id !== queuedMessageId,
    );
    return queuedMessages.length === prev.queuedMessages.length
      ? prev
      : {
          ...prev,
          queuedMessages,
        };
  });
}

export async function runAgent(
  tabId: string,
  userMessage: string,
  attachments?: AttachedImage[],
  options?: { skipUserChatAppend?: boolean },
): Promise<void> {
  if (hasActiveRun(tabId)) {
    interruptActiveRun(tabId, "superseded", { pauseQueue: false });
  }

  await runAgentTurn(tabId, userMessage, attachments, options);
}

async function runAgentTurn(
  tabId: string,
  userMessage: string,
  attachments?: AttachedImage[],
  options: RunAgentTurnOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const runId = nextRunId(tabId);
  const currentTurn = getAgentState(tabId).turnCount + 1;
  const {
    runStartId,
    rootContext: runRootLogContext,
    childContext: runLogContext,
  } = createMainRunLogContext(tabId, runId);
  patchAgentState(tabId, {
    lastRunTraceId: runRootLogContext.traceId,
    turnCount: currentTurn,
  });
  const activeRun: ActiveRun = {
    runId,
    controller,
    abortReason: null,
  };
  setActiveRun(tabId, activeRun);
  writeRunnerLog({
    id: runStartId,
    level: "info",
    tags: ["frontend", "agent-loop", "messages"],
    event: "runner.run.start",
    message: "Agent run started",
    kind: "start",
    expandable: true,
    data: {
      userMessageLength: userMessage.length,
      hasAttachments: Boolean(attachments && attachments.length > 0),
    },
    context: runRootLogContext,
  });

  let completedCleanly = false;

  const triggerMatch = findSubagentByTrigger(userMessage);
  if (triggerMatch) {
    const { subagent: triggerSubagent, subMessage } = triggerMatch;
    const isCompactTrigger = triggerSubagent.id === COMPACT_TRIGGER_SUBAGENT_ID;

    const triggerUserMsg: ChatMessage | null = isCompactTrigger
      ? null
      : {
          id: msgId(),
          role: "user",
          content: userMessage,
          timestamp: Date.now(),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        };
    dequeueQueuedMessage(tabId, options.queuedMessageId);
    patchAgentState(tabId, (prev) => ({
      ...prev,
      status: "working",
      error: null,
      errorAction: null,
      errorDetails: null,
      chatMessages:
        options?.skipUserChatAppend || triggerUserMsg === null
          ? prev.chatMessages
          : [...prev.chatMessages, triggerUserMsg],
      streamingContent: null,
    }));

    try {
      if (isCompactTrigger) {
        const compactResult = await runManualCompactionTrigger(
          tabId,
          userMessage,
          triggerSubagent,
          controller,
          runId,
          currentTurn,
          runLogContext,
        );
        if (!compactResult.ok) {
          writeRunnerLog({
            level: "error",
            tags: ["frontend", "agent-loop", "messages"],
            event: "runner.run.error",
            message: "Manual compaction failed",
            kind: "error",
            ...(compactResult.error !== undefined ? { data: compactResult.error } : {}),
            context: runLogContext,
          });
        }
        completedCleanly = true;
      } else {
        const triggerState = getAgentState(tabId);
        const triggerProviders = jotaiStore.get(providersAtom);
        const triggerDebug = triggerState.showDebug ?? false;
        const triggerResult = await runSubagentLoop({
          tabId,
          signal: controller.signal,
          runId,
          currentTurn,
          subagentDef: triggerSubagent,
          message: subMessage,
          parentModelId: triggerState.config.model,
          providers: triggerProviders,
          debugEnabled: triggerDebug,
          logContext: runLogContext,
        });
        if (!triggerResult.ok) {
          writeRunnerLog({
            level: "error",
            tags: ["frontend", "agent-loop", "messages"],
            event: "runner.run.error",
            message: "Trigger subagent run failed",
            kind: "error",
            data: triggerResult.error,
            context: runLogContext,
          });
          setAgentErrorState(
            tabId,
            triggerResult.error.message,
            triggerResult.error,
          );
        } else {
          completedCleanly = true;
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (err instanceof RunAbortedError) {
        completedCleanly = true;
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      writeRunnerLog({
        level: "error",
        tags: ["frontend", "agent-loop", "messages"],
        event: "runner.run.error",
        message: isCompactTrigger
          ? "Manual compaction threw"
          : "Trigger subagent run threw",
        kind: "error",
        data: err,
        context: runLogContext,
      });
      if (isCompactTrigger) {
        appendAssistantChatMessage(tabId, msg, {
          agentName: triggerSubagent.name,
        });
        completedCleanly = true;
      } else {
        setAgentErrorState(tabId, msg, serializeError(err));
        updateLastChatMessage(tabId, (m) =>
          m.role === "assistant" ? { ...m, streaming: false } : m,
        );
        return;
      }
    } finally {
      clearActiveRun(tabId, activeRun);
      if (activeRun.abortReason !== null) return;
      if (completedCleanly) {
        writeRunnerLog({
          level: "info",
          tags: ["frontend", "agent-loop", "messages"],
          event: "runner.run.end",
          message: "Agent run completed",
          kind: "end",
          context: runLogContext,
        });
        patchAgentState(tabId, (prev) => ({
          ...prev,
          status: "idle",
          streamingContent: null,
          queueState: normalizeQueueState(prev.queuedMessages, prev.queueState),
        }));
        void maybeStartQueuedRun(tabId).catch((error) => {
          writeRunnerLog({
            level: "error",
            tags: ["frontend", "agent-loop", "system"],
            event: "runner.queue.drain.error",
            message: "Failed to drain queued messages",
            kind: "error",
            data: error,
            context: runLogContext,
          });
        });
      }
    }
    return;
  }

  const state = getAgentState(tabId);
  const { cwd, model } = state.config;
  const debugEnabled = state.showDebug ?? false;
  const modelEntry = getModelCatalogEntry(model);
  const provider = modelEntry?.owned_by ?? null;
  const providers = jotaiStore.get(providersAtom);

  writeRunnerLog({
    level: "info",
    tags: ["frontend", "agent-loop", "system"],
    event: "runner.model.resolve",
    message: `Starting agent with model ${model}`,
    data: { model, provider, cwd },
    context: runLogContext,
  });

  if (!modelEntry || !provider) {
    setAgentErrorState(
      tabId,
      "Unknown model. Please choose a model from the New Session list.",
    );
    clearActiveRun(tabId, activeRun);
    return;
  }

  if (!modelEntry.sdk_id.trim()) {
    setAgentErrorState(
      tabId,
      `Selected model is missing a provider model ID. Please update src/agent/models.catalog.json for ${modelEntry.id}.`,
    );
    clearActiveRun(tabId, activeRun);
    return;
  }

  const providerInstance = providers.find(
    (p) => p.id === modelEntry.providerId,
  );
  if (!providerInstance) {
    setAgentErrorState(
      tabId,
      `Model "${modelEntry.id}" references an unknown provider.`,
    );
    clearActiveRun(tabId, activeRun);
    return;
  }

  if (provider === "openai" && !providerInstance.apiKey) {
    setAgentErrorState(
      tabId,
      "No OpenAI API key. Please open the settings to enter your OpenAI API key.",
      null,
      {
        type: "open-settings-section",
        section: "providers",
        label: "Open AI Providers",
      },
    );
    clearActiveRun(tabId, activeRun);
    return;
  }

  if (provider === "anthropic" && !providerInstance.apiKey) {
    setAgentErrorState(
      tabId,
      "No Claude API key. Please open the settings to enter your Claude (Anthropic) API key.",
      null,
      {
        type: "open-settings-section",
        section: "providers",
        label: "Open AI Providers",
      },
    );
    clearActiveRun(tabId, activeRun);
    return;
  }

  const userChatMsg: ChatMessage = {
    id: msgId(),
    role: "user",
    content: userMessage,
    timestamp: Date.now(),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
  dequeueQueuedMessage(tabId, options.queuedMessageId);

  const newApiMessages = [
    ...(state.apiMessages.length === 0
      ? [
          {
            role: "system" as const,
            content: await buildMainSystemPromptForState(state),
          },
        ]
      : []),
    ...state.apiMessages,
    {
      role: "user" as const,
      content: userMessage,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    },
  ];

  patchAgentState(tabId, (prev) => ({
    ...prev,
    status: "thinking",
    error: null,
    errorAction: null,
    errorDetails: null,
    chatMessages: options?.skipUserChatAppend
      ? prev.chatMessages
      : [...prev.chatMessages, userChatMsg],
    apiMessages: newApiMessages,
    streamingContent: null,
  }));

  try {
    await agentLoop(
      tabId,
      controller.signal,
      model,
      providers,
      debugEnabled,
      runId,
      currentTurn,
      runLogContext,
    );
    completedCleanly = !controller.signal.aborted;
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    if (err instanceof RunAbortedError) {
      completedCleanly = true;
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    writeRunnerLog({
      level: "error",
      tags: ["frontend", "agent-loop", "messages"],
      event: "runner.run.error",
      message: "Agent loop failed",
      kind: "error",
      data: err,
      context: runLogContext,
    });
    setAgentErrorState(tabId, msg, serializeError(err));
    updateLastChatMessage(tabId, (m) =>
      m.role === "assistant" ? { ...m, streaming: false } : m,
    );
  } finally {
    clearActiveRun(tabId, activeRun);
    if (activeRun.abortReason !== null) return;
    if (!completedCleanly) return;
    if (getAgentState(tabId).status === "error") return;

    patchAgentState(tabId, (prev) =>
      prev.status === "error"
        ? prev
        : {
            ...prev,
            status: "idle",
            streamingContent: null,
            queueState: normalizeQueueState(prev.queuedMessages, prev.queueState),
          },
    );
    writeRunnerLog({
      level: "info",
      tags: ["frontend", "agent-loop", "messages"],
      event: "runner.run.end",
      message: "Agent run completed",
      kind: "end",
      context: runLogContext,
    });
    void maybeStartQueuedRun(tabId).catch((error) => {
      writeRunnerLog({
        level: "error",
        tags: ["frontend", "agent-loop", "system"],
        event: "runner.queue.drain.error",
        message: "Failed to drain queued messages",
        kind: "error",
        data: error,
        context: runLogContext,
      });
    });
  }
}
