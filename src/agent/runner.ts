/**
 * Agent runner — the core agentic loop.
 *
 * Each tab gets its own independent async loop. Multiple agents can run in
 * parallel; JavaScript's event loop handles interleaving naturally.
 *
 * Flow per turn:
 *   user message → AI SDK streaming → accumulate text + tool calls
 *   → if tool calls: execute them, append results, loop
 *   → if no tool calls: done
 */

import { getAgentState, patchAgentState, jotaiStore } from "./atoms";
import { providersAtom } from "./db";
import {
  TOOL_DEFINITIONS,
  dispatchTool,
  validateTool,
  getToolDefinitionsByNames,
  type DispatchCallbacks,
} from "./tools";
import { execAbort, execStop } from "./tools/exec";
import {
  getAllSubagents,
  getSubagent,
  findSubagentByTrigger,
  getSubagentArtifactSpec,
  getSubagentArtifactSpecs,
  type SubagentDefinition,
} from "./subagents";
import {
  validateArtifactContentWithValidator,
} from "./subagents/contracts";
import type {
  SubagentArtifactSpec,
  SubagentArtifactValidation,
  SubagentArtifactValidationStatus,
} from "./subagents/types";
import {
  requiresApproval,
  requestApproval,
  requestUserInput,
  cancelAllApprovals,
  consumeApprovalReason,
} from "./approvals";
import type {
  AttachedImage,
  AgentQueueState,
  ConversationCard,
  SerializedConversationCard,
  AdvancedModelOptions,
  ApiMessage,
  ApiToolCall,
  AssistantApiMessage,
  ChatMessage,
  QueuedUserMessage,
  ToolResult,
  ToolCallDisplay,
  ToolApiMessage,
} from "./types";
import {
  ARTIFACT_CARD_PARENT_INSTRUCTION,
  DEFAULT_ADVANCED_OPTIONS,
} from "./types";
import { streamText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getModelCatalogEntry } from "./modelCatalog";
import { toJSONSchema } from "zod";
import {
  buildEditFileDiffFiles,
  buildWriteFileDiffFiles,
} from "@/components/patchDiffFiles";
import { serializeDiff } from "@/components/diffSerialization";
import type {
  EditFileChange,
  SearchFilesOutput,
} from "@/agent/tools/workspace";
import type { ProviderInstance } from "./db";
import {
  artifactGet,
  getArtifactFrameworkMetadata,
  withArtifactFrameworkMetadata,
  type ArtifactManifest,
} from "./tools/artifacts";
import { buildConversationCard, type CardAddInput } from "./tools/agentControl";

/* ─────────────────────────────────────────────────────────────────────────────
   Abort controller registry — one per running agent
───────────────────────────────────────────────────────────────────────────── */

type AgentAbortReason = "user_stop" | "steer" | "superseded";

interface ActiveRun {
  runId: string;
  controller: AbortController;
  abortReason: AgentAbortReason | null;
}

const activeRuns = new Map<string, ActiveRun>();
const runCounters = new Map<string, number>();

function nextRunId(tabId: string): string {
  const next = (runCounters.get(tabId) ?? 0) + 1;
  runCounters.set(tabId, next);
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `run_${iso}_${String(next).padStart(4, "0")}`;
}

function hasActiveRun(tabId: string): boolean {
  return activeRuns.has(tabId);
}

function isActiveRunOwner(tabId: string, activeRun: ActiveRun): boolean {
  return activeRuns.get(tabId) === activeRun;
}

function clearActiveRun(tabId: string, activeRun: ActiveRun): void {
  if (isActiveRunOwner(tabId, activeRun)) {
    activeRuns.delete(tabId);
  }
}

function isCurrentRunId(tabId: string, runId: string): boolean {
  return activeRuns.get(tabId)?.runId === runId;
}

interface SystemPromptRuntimeContext {
  hostOs: string;
  locale: string;
  timeZone: string;
  localDate: string;
  localTime: string;
  utcIso: string;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

type ToolResultOutputLike =
  | { type: "text"; value: string }
  | { type: "json"; value: JsonValue }
  | { type: "execution-denied"; reason?: string }
  | { type: "error-text"; value: string }
  | { type: "error-json"; value: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   buildProviderOptions — maps AdvancedModelOptions to AI SDK providerOptions
─────────────────────────────────────────────────────────────────────────── */

function supportsAnthropicFastMode(modelSdkId?: string): boolean {
  return typeof modelSdkId === "string" && modelSdkId.startsWith("claude-opus-4-6");
}

export function buildProviderOptions(
  provider: string | null,
  opts?: AdvancedModelOptions,
  modelSdkId?: string,
): Record<string, Record<string, JsonValue>> | undefined {
  if (provider !== "openai" && provider !== "anthropic") return undefined;

  const { reasoningVisibility, reasoningEffort, latencyCostProfile } =
    opts ?? DEFAULT_ADVANCED_OPTIONS;

  if (provider === "openai") {
    const openai: Record<string, JsonValue> = {};

    // Reasoning visibility
    if (reasoningVisibility === "auto") {
      openai.reasoningSummary = "auto";
    } else if (reasoningVisibility === "detailed") {
      openai.reasoningSummary = "detailed";
    }
    // "off" → omit reasoningSummary entirely

    // Reasoning effort
    openai.reasoningEffort = reasoningEffort;

    // Latency / cost profile
    if (latencyCostProfile === "fast") {
      openai.serviceTier = "priority";
    } else if (latencyCostProfile === "cheap") {
      openai.serviceTier = "flex";
    } else {
      openai.serviceTier = "auto";
    }

    return { openai };
  }

  // Anthropic
  const anthropic: Record<string, JsonValue> = {};

  // Reasoning visibility
  if (reasoningVisibility === "off") {
    anthropic.thinking = { type: "disabled" };
  } else if (reasoningVisibility === "detailed") {
    anthropic.thinking = { type: "enabled", budgetTokens: 4096 };
  } else {
    anthropic.thinking = { type: "adaptive" };
  }

  // Reasoning effort
  anthropic.effort = reasoningEffort;

  // Fast mode is Anthropic model-specific. Omit the default "standard" mode
  // entirely so unsupported models do not receive an invalid request field.
  if (
    latencyCostProfile === "fast" &&
    supportsAnthropicFastMode(modelSdkId)
  ) {
    anthropic.speed = "fast";
  }

  return { anthropic };
}

function resolveLanguageModel(modelKey: string, providers: ProviderInstance[]) {
  const modelEntry = getModelCatalogEntry(modelKey);
  if (!modelEntry) {
    throw new Error(
      `Unknown model "${modelKey}". Update src/agent/models.catalog.json and pick a valid model.`,
    );
  }

  const provider = providers.find((p) => p.id === modelEntry.providerId);
  const providerModelId = modelEntry.sdk_id.trim();

  if (!provider) {
    throw new Error(
      `Model "${modelEntry.id}" references an unknown provider ID "${modelEntry.providerId}". Did you delete it?`,
    );
  }

  if (!providerModelId) {
    throw new Error(
      `Model "${modelEntry.id}" is missing sdk_id. Update src/agent/models.catalog.json and set sdk_id for this model.`,
    );
  }

  if (provider.type === "openai") {
    const openai = createOpenAI({ apiKey: provider.apiKey });
    return openai(providerModelId);
  }

  if (provider.type === "openai-compatible") {
    const baseURL = (provider.baseUrl || "").trim().replace(/\/+$/, "");
    if (!baseURL) {
      throw new Error(
        `OpenAI-compatible provider "${provider.name}" base URL is not configured. Set it in Settings.`,
      );
    }
    const compat = createOpenAICompatible({
      name: "custom",
      baseURL: `${baseURL}`,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    });
    return compat(providerModelId);
  }

  const anthropic = createAnthropic({
    apiKey: provider.apiKey,
    headers: {
      // Required for browser-based requests to Anthropic from localhost/dev.
      "anthropic-dangerous-direct-browser-access": "true",
    },
  });
  return anthropic(providerModelId);
}

function toJsonValue(value: unknown): JsonValue {
  return (value ?? null) as JsonValue;
}

function parseToolResultOutput(content: string): ToolResultOutputLike {
  try {
    const parsed = JSON.parse(content);
    if (isRecord(parsed) && parsed.ok === false) {
      const parsedError = isRecord(parsed.error) ? parsed.error : null;
      const errorCode =
        parsedError && typeof parsedError.code === "string"
          ? parsedError.code
          : null;
      const errorMessage =
        parsedError && typeof parsedError.message === "string"
          ? parsedError.message
          : undefined;

      if (errorCode === "PERMISSION_DENIED") {
        return {
          type: "execution-denied",
          ...(errorMessage ? { reason: errorMessage } : {}),
        };
      }

      return { type: "error-json", value: toJsonValue(parsed) };
    }
    return { type: "json", value: toJsonValue(parsed) };
  } catch {
    return { type: "text", value: content };
  }
}

function mapApiMessagesToModelMessages(messages: ApiMessage[]): ModelMessage[] {
  const toolNameById = new Map<string, string>();
  const mapped: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolNameById.set(tc.id, tc.function.name);
      }
    }

    if (msg.role === "system") {
      mapped.push({ role: "system", content: msg.content ?? "" });
      continue;
    }

    if (msg.role === "user") {
      const imgs = msg.attachments;
      if (imgs && imgs.length > 0) {
        const parts: Array<Record<string, unknown>> = [
          ...imgs.map((img) => ({
            type: "image",
            image: img.previewUrl,
            mimeType: img.mimeType,
          })),
          ...(msg.content ? [{ type: "text", text: msg.content }] : []),
        ];
        mapped.push({ role: "user", content: parts } as unknown as ModelMessage);
      } else {
        mapped.push({ role: "user", content: msg.content ?? "" });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const contentParts: Array<Record<string, unknown>> = [];

      if (msg.content) {
        contentParts.push({ type: "text", text: msg.content });
      }

      for (const tc of msg.tool_calls ?? []) {
        contentParts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: parseArgs(tc.function.arguments),
        });
      }

      if (contentParts.length === 0) {
        mapped.push({ role: "assistant", content: "" });
      } else if (
        contentParts.length === 1 &&
        contentParts[0].type === "text" &&
        typeof contentParts[0].text === "string"
      ) {
        mapped.push({ role: "assistant", content: contentParts[0].text });
      } else {
        mapped.push({
          role: "assistant",
          content: contentParts,
        } as ModelMessage);
      }
      continue;
    }

    const toolName = toolNameById.get(msg.tool_call_id) ?? "unknown_tool";
    const output = parseToolResultOutput(msg.content ?? "");
    mapped.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: msg.tool_call_id,
          toolName,
          output,
        },
      ],
    } as ModelMessage);
  }

  return mapped;
}

function toApiToolCall(raw: unknown): ApiToolCall | null {
  if (!isRecord(raw)) return null;

  const id =
    typeof raw.toolCallId === "string"
      ? raw.toolCallId
      : typeof raw.id === "string"
        ? raw.id
        : null;
  const name =
    typeof raw.toolName === "string"
      ? raw.toolName
      : typeof raw.name === "string"
        ? raw.name
        : null;

  if (!id || !name) return null;

  let argsJson = "{}";
  if (typeof raw.input === "string") {
    argsJson = raw.input;
  } else if (raw.input !== undefined) {
    try {
      const serialized = JSON.stringify(raw.input);
      argsJson = typeof serialized === "string" ? serialized : "{}";
    } catch {
      argsJson = "{}";
    }
  } else if (typeof raw.arguments === "string") {
    argsJson = raw.arguments;
  } else if (raw.arguments !== undefined) {
    try {
      const serialized = JSON.stringify(raw.arguments);
      argsJson = typeof serialized === "string" ? serialized : "{}";
    } catch {
      argsJson = "{}";
    }
  }

  return {
    id,
    type: "function",
    function: {
      name,
      arguments: argsJson,
    },
  };
}

function findRunningExecToolCallIds(tabId: string): string[] {
  const state = getAgentState(tabId);
  const ids: string[] = [];
  for (const msg of state.chatMessages) {
    for (const tc of msg.toolCalls ?? []) {
      if (tc.tool === "exec_run" && tc.status === "running") {
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
        tc.tool === "exec_run" &&
        tc.status === "running"
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Tool call that was emitted by the model but lacks a corresponding result. */
interface IncompleteToolCall {
  toolCallId: string;
  toolName: string;
}

/**
 * Find all tool calls in apiMessages that don't have a corresponding tool result.
 * This can happen when the agent is stopped mid-turn before tool execution completes.
 */
function findIncompleteToolCalls(tabId: string): IncompleteToolCall[] {
  const state = getAgentState(tabId);
  const incomplete: IncompleteToolCall[] = [];

  // Build set of tool_call_ids that have results in apiMessages
  const completedToolCallIds = new Set<string>();
  for (const msg of state.apiMessages) {
    if (msg.role === "tool") {
      completedToolCallIds.add(msg.tool_call_id);
    }
  }

  // Find assistant messages with tool_calls that lack results
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

function detectHostOs(): "windows" | "linux" | "mac" {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent ?? "";
  const platform = navigator.platform ?? "";

  if (/win/i.test(platform) || /windows/i.test(ua)) return "windows";
  if (/mac/i.test(platform) || /macintosh|mac os x/i.test(ua)) return "mac";
  return "linux";
}

function buildSystemPromptRuntimeContext(
  now = new Date(),
): SystemPromptRuntimeContext {
  const intlOptions = Intl.DateTimeFormat().resolvedOptions();
  return {
    hostOs: detectHostOs(),
    locale: intlOptions.locale ?? "unknown",
    timeZone: intlOptions.timeZone ?? "unknown",
    localDate: now.toLocaleDateString(),
    localTime: now.toLocaleTimeString(),
    utcIso: now.toISOString(),
  };
}

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
  const activeRun = activeRuns.get(tabId);
  if (activeRun) {
    activeRun.abortReason = reason;
    activeRun.controller.abort();
  }

  // Find incomplete tool calls and synthesize error results for them
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

  // Helper to check if a tool call status is incomplete
  const isIncompleteStatus = (status: ToolCallDisplay["status"]): boolean =>
    status === "pending" ||
    status === "awaiting_approval" ||
    status === "awaiting_worktree" ||
    status === "running";

  patchAgentState(tabId, (prev) => ({
    ...prev,
    status: "idle",
    streamingContent: null,
    queueState: options.pauseQueue
      ? pauseQueueState(prev.queuedMessages, prev.queueState)
      : normalizeQueueState(prev.queuedMessages, prev.queueState),
    // Append synthesized tool results to apiMessages
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

  void maybeStartQueuedRun(tabId).catch(console.error);
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
  void maybeStartQueuedRun(tabId).catch(console.error);
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

/**
 * Stop a single running exec_run tool call while keeping the agent loop alive.
 * The command result is still returned to the model (with terminatedByUser=true).
 */
export async function stopRunningExecToolCall(
  tabId: string,
  toolCallId: string,
): Promise<boolean> {
  if (!hasRunningExecToolCall(tabId, toolCallId)) return false;
  return execStop(toolCallId);
}

/* ─────────────────────────────────────────────────────────────────────────────
   System prompt
───────────────────────────────────────────────────────────────────────────── */

function buildSystemPrompt(
  cwd: string,
  isGitRepo: boolean,
  hasAgentsFile: boolean,
  hasSkillsDir: boolean,
  runtimeContext: SystemPromptRuntimeContext,
): string {
  const gitSection = isGitRepo
    ? `

GIT ISOLATION
- Before **writing any new files** or **modifying any files**, call git_worktree_init exactly once with a short suggested branch name (e.g. "feat/add-dark-mode").
- Never call git_worktree_init more than once per session — it is idempotent and will no-op if already set up or declined.
- Do not call git_worktree_init if you don't need to make file changes — it's only necessary if you need isolation for your edits in the same session.
- If the user declines, proceed working directly in the main workspace without asking again.`
    : "";

  return `You are Rakh, an autonomous AI coding agent.
Workspace root: ${cwd}
Host OS: ${runtimeContext.hostOs}
Locale: ${runtimeContext.locale}
Timezone: ${runtimeContext.timeZone}
Today's local date: ${runtimeContext.localDate}
Current local time: ${runtimeContext.localTime}
Current UTC timestamp: ${runtimeContext.utcIso}

You can read, write, modify, and execute code inside this workspace.

UNDERSTAND THE REQUEST
Before acting, determine what the user wants:
- Question ("how do I...", "what is...", "explain..."): Answer concisely in text without invoking tools. Offer to execute if it makes sense.
- Task (imperative: "add", "fix", "refactor", "build"): Act on it immediately.
When in doubt, bias toward action over explanation.

TASK COMPLEXITY
- Simple tasks (single-file edits, quick fixes, lookups): Be concise, use judgment. Do NOT create a plan or todos — just do the work.
- Complex tasks (multi-file changes, new features, architectural work): Use agent_plan_set and agent_todo_add to structure the work before starting.
- Do not ask about minor details you can resolve with your own judgment. Only ask when a decision is genuinely ambiguous and would significantly change your approach — and gather info via tools before asking.

GENERAL BEHAVIOR
- Be decisive and action-oriented.
- Prefer tool calls over explanations.
- Keep text responses minimal and structured.
- Do not ask for confirmation unless absolutely necessary.
- Never reference files outside the workspace.

CONTEXT HANDLING
- If the user provides external context (pasted code, error output, command results, file contents), use it directly to inform your response.
- Do not ask for information the user has already provided.
- Prioritize user-provided context over your own assumptions.
- The user may reference files with the @filename syntax (e.g. @utils/version.ts). The @ is a UI prefix — the actual file path does not include it (e.g. utils/version.ts).

TOOL USAGE
|- Use workspace_search to find symbols, usages, or strings across the codebase before reading individual files. This is usually the best way to gather context about unfamiliar code.
|- Use workspace_stat to verify a file or directory exists before reading or writing it.
|- Use workspace_glob to explore project structure before assuming paths.
|- Read a file before modifying it if its current content is unknown.
|- Never reference or write to paths outside the workspace.
|- When using workspace_editFile, each oldString must appear exactly once in the file — the tool will fail if it matches more than once. Make oldString long enough to be unique. Use replaceAll: true only when you intentionally want every occurrence replaced.

PLANNING
- For complex, multi-step tasks, call agent_plan_set BEFORE starting work.
- Break work into discrete steps using agent_todo_add.
- Update todos with agent_todo_update as progress is made.
- Keep plan and todos consistent with actual work.
- Mark todos completed immediately after finishing each step.
- For simple tasks, skip the plan and todos — just do the work.

ARTIFACTS
- Use agent_artifact_create to persist durable outputs (patches, reports, logs, snapshots) with clear targets.
- Use agent_artifact_version to publish revisions of existing artifacts; artifact IDs are stable, versions are append-only.
- Use agent_artifact_list / agent_artifact_get to discover and read prior artifacts before creating redundant outputs.

TITLE
- At the START of every task, call agent_title_set with a short description (e.g. "fix auth bug", "add dark mode").
- Update the title if task focus changes significantly.

WORKSPACE RULES
- workspace_* paths are workspace-relative.
- Never use leading "/" or "..".
- Do not assume files exist — check first.
${hasAgentsFile ? "- Check AGENTS.md in the root and follow its instructions.\n" : ""}${hasSkillsDir ? "- Check .agents/skills and use relevant skills when helpful.\n" : ""}
EXECUTION & VERIFICATION
- After making changes, run at least one verification command (typecheck, lint, or tests) unless explicitly told not to.
- Prefer minimal verification commands that directly validate your change.
- If verification fails, fix the issue before continuing.

SAFETY
- Do not delete large sections of code unless required.
- Do not rewrite entire files if a surgical edit is sufficient.
- Avoid introducing new dependencies unless necessary.

GENERATED FILES
- Never manually edit generated files.
- If a file is marked as generated (e.g. header comment, build output, dist/, .gen/, prisma client, etc.), do not modify it directly.
- Instead, locate the source of generation (schema, config, template, command) and update that.
- Then run the appropriate generation command to regenerate the file.
- If unsure whether a file is generated, inspect the file header or project configuration before editing.
|- If you must edit a generated file to make progress, note this in the plan and flag it for human review.${gitSection}

AVAILABLE SUBAGENTS
The following specialized subagents can be invoked with agent_subagent_call:
${getAllSubagents()
  .map((s) => {
    let entry = `- ${s.id}: ${s.description}${
      s.triggerCommand ? ` (trigger: ${s.triggerCommand})` : ""
    }`;
    if (s.whenToUse && s.whenToUse.length > 0) {
      entry += `\n  When to use:\n${s.whenToUse.map((w) => `  \u2022 ${w}`).join("\n")}`;
    }
    return entry;
  })
  .join("\n")}
Use agent_subagent_call when delegating to a specialist is appropriate.
When a subagent returns cards, those cards are already visible to the user.
Read them, but do not recreate the same cards with agent_card_add.

Be concise. Act like a focused senior engineer.`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Chat message helpers
───────────────────────────────────────────────────────────────────────────── */

function msgId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function appendChatMessage(tabId: string, msg: ChatMessage): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    chatMessages: [...prev.chatMessages, msg],
  }));
}

function updateLastChatMessage(
  tabId: string,
  updater: (msg: ChatMessage) => ChatMessage,
): void {
  patchAgentState(tabId, (prev) => {
    const msgs = [...prev.chatMessages];
    if (msgs.length === 0) return prev;
    msgs[msgs.length - 1] = updater(msgs[msgs.length - 1]);
    return { ...prev, chatMessages: msgs };
  });
}

function appendCardsToChatMessage(
  tabId: string,
  messageId: string,
  cards: ConversationCard[],
): void {
  patchAgentState(tabId, (prev) => ({
    ...prev,
    chatMessages: prev.chatMessages.map((msg) =>
      msg.id !== messageId
        ? msg
        : {
            ...msg,
            cards: cards.length > 0 ? cards : undefined,
          },
    ),
  }));
}

type ConversationCardSlot =
  | { status: "pending" }
  | { status: "done"; card: ConversationCard }
  | { status: "skipped" };

function createConversationCardAccumulator(
  tabId: string,
  messageId: string,
  toolCalls: ApiToolCall[],
): {
  markDone: (toolCallId: string, card: ConversationCard) => void;
  markSkipped: (toolCallId: string) => void;
  getResolvedCards: () => ConversationCard[];
} {
  const existingCards =
    getAgentState(tabId).chatMessages.find((msg) => msg.id === messageId)
      ?.cards ?? [];
  const slotIndexByToolCallId = new Map<string, number>();
  const slots: ConversationCardSlot[] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.function.name !== "agent_card_add") continue;
    slotIndexByToolCallId.set(toolCall.id, slots.length);
    slots.push({ status: "pending" });
  }

  function publishResolvedPrefix(): void {
    if (slots.length === 0) return;
    const visibleCards: ConversationCard[] = [];
    for (const slot of slots) {
      if (slot.status === "pending") break;
      if (slot.status === "done") visibleCards.push(slot.card);
    }
    appendCardsToChatMessage(tabId, messageId, [
      ...existingCards,
      ...visibleCards,
    ]);
  }

  function updateSlot(toolCallId: string, next: ConversationCardSlot): void {
    const slotIndex = slotIndexByToolCallId.get(toolCallId);
    if (slotIndex === undefined) return;
    slots[slotIndex] = next;
    publishResolvedPrefix();
  }

  return {
    markDone(toolCallId: string, card: ConversationCard): void {
      updateSlot(toolCallId, { status: "done", card });
    },
    markSkipped(toolCallId: string): void {
      updateSlot(toolCallId, { status: "skipped" });
    },
    getResolvedCards(): ConversationCard[] {
      return slots.flatMap((slot) =>
        slot.status === "done" ? [slot.card] : [],
      );
    },
  };
}

function toLoggable(value: unknown): unknown {
  return value instanceof Error ? serializeError(value) : value;
}

function logStreamDebug(
  tabId: string,
  debugEnabled: boolean,
  event: string,
  payload?: unknown,
): void {
  if (!debugEnabled) return;
  const prefix = `[rakh:stream][${tabId}]`;
  if (payload === undefined) {
    console.log(prefix, event);
    return;
  }
  console.log(prefix, event, toLoggable(payload));
}

/* ─────────────────────────────────────────────────────────────────────────────
   Subagent execution helpers
───────────────────────────────────────────────────────────────────────────── */

type ToolFailureResult = Extract<ToolResult<unknown>, { ok: false }>;

interface PreparedSubagentArtifactToolCall {
  args: Record<string, unknown>;
  spec?: SubagentArtifactSpec;
  validation?: Omit<SubagentArtifactValidation, "artifactId">;
}

interface PreparedConversationCardToolCall {
  card: ConversationCard;
  result: {
    ok: true;
    data: { cardId: string; kind: ConversationCard["kind"] };
  };
}

function makeSubagentToolError(
  message: string,
  details?: Record<string, unknown>,
): ToolFailureResult {
  return {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message,
      ...(details ? { details } : {}),
    },
  };
}

function normalizeSubagentArtifactValidation(
  spec: SubagentArtifactSpec,
  status: SubagentArtifactValidationStatus,
  issues?: SubagentArtifactValidation["issues"],
): Omit<SubagentArtifactValidation, "artifactId"> | undefined {
  const validatorId = spec.validator?.id;
  if (!validatorId) return undefined;
  return {
    artifactType: spec.artifactType,
    validatorId,
    status,
    ...(issues && issues.length > 0 ? { issues } : {}),
  };
}

function validateSubagentArtifactContent(
  spec: SubagentArtifactSpec,
  content: string,
): Omit<SubagentArtifactValidation, "artifactId"> | undefined {
  if (!spec.validator || spec.contentFormat !== "json") return undefined;
  const validation = validateArtifactContentWithValidator(spec.validator, content);
  return normalizeSubagentArtifactValidation(
    spec,
    validation.status,
    validation.issues,
  );
}

function renderSubagentArtifactSpec(spec: SubagentArtifactSpec): string {
  const required = spec.required ?? true;
  const cardinality = spec.cardinality ?? "one";
  const lines = [
    `- artifactType: "${spec.artifactType}"`,
    `  kind: "${spec.kind}"`,
    `  contentFormat: "${spec.contentFormat}"`,
    `  required: ${required ? "yes" : "no"}`,
    `  cardinality: "${cardinality}"`,
  ];

  if (spec.validator && spec.contentFormat === "json") {
    const schema = JSON.stringify(
      toJSONSchema(spec.validator.schema, { target: "draft-7" }),
      null,
      2,
    );
    lines.push(
      `  validator: "${spec.validator.id}" (${spec.validator.validationMode})`,
      `  JSON schema:\n${schema
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}`,
    );
  }

  return lines.join("\n");
}

function prepareConversationCardToolCall(
  rawArgs: Record<string, unknown>,
): { ok: true; data: PreparedConversationCardToolCall } | {
  ok: false;
  result: ToolFailureResult;
} {
  const built = buildConversationCard(rawArgs as CardAddInput);
  if (!built.ok) {
    return { ok: false, result: built };
  }
  return {
    ok: true,
    data: {
      card: built.data.card,
      result: {
        ok: true,
        data: {
          cardId: built.data.cardId,
          kind: built.data.kind,
        },
      },
    },
  };
}

function serializeConversationCardForParent(
  card: ConversationCard,
): SerializedConversationCard {
  if (card.kind === "summary") {
    return {
      kind: "summary",
      ...(card.title ? { title: card.title } : {}),
      markdown: card.markdown,
    };
  }

  return {
    kind: "artifact",
    ...(card.title ? { title: card.title } : {}),
    artifactId: card.artifactId,
    ...(card.version !== undefined ? { version: card.version } : {}),
    instruction: ARTIFACT_CARD_PARENT_INSTRUCTION,
  };
}

/** Build the full system prompt for a subagent (base + output section). */
function buildSubagentSystemPrompt(def: SubagentDefinition): string {
  const prompt = def.systemPrompt.trim();
  if (!def.output) return prompt;

  const artifactSpecs = getSubagentArtifactSpecs(def);
  const outputSections: string[] = [];

  if (artifactSpecs.length > 0) {
    outputSections.push(
      [
        "ARTIFACT CONTRACTS",
        "Create or update your durable outputs with agent_artifact_create / agent_artifact_version.",
        "Always set artifactType on new artifact payloads. Do not paste artifact JSON into the final message.",
        artifactSpecs.map(renderSubagentArtifactSpec).join("\n\n"),
      ].join("\n"),
    );
  }

  if (def.tools.includes("agent_card_add")) {
    outputSections.push(
      [
        "CONVERSATION CARDS",
        "Create user-visible conversation cards with agent_card_add.",
        "Summary cards must use Markdown and contain the user-facing summary instead of the final message.",
        "Artifact cards must reference an existing artifact by artifactId/version only. Do not treat artifact cards as content-bearing.",
      ].join("\n"),
    );
  }

  outputSections.push(
    ["FINAL MESSAGE", def.output.finalMessageInstructions.trim()].join("\n"),
  );

  return `${prompt}\n\n${outputSections.join("\n\n")}`;
}

/** Select the best available model for a subagent, falling back to the parent model. */
function resolveSubagentModelId(
  def: SubagentDefinition,
  parentModelId: string,
  providers: ProviderInstance[],
): string {
  for (const modelId of def.recommendedModels) {
    const entry = getModelCatalogEntry(modelId);
    if (!entry || !entry.sdk_id.trim()) continue;
    if (providers.find((p) => p.id === entry.providerId)) return modelId;
  }
  return parentModelId;
}

export interface SubagentCallResult {
  subagentId: string;
  name: string;
  modelId: string;
  startedAtMs: number;
  finishedAtMs: number;
  turns: number;
  /** Raw final text of the subagent's last assistant message. */
  rawText: string;
  /**
   * Instructions for the parent agent on how to handle this result.
   * Sourced from output.parentNote on the SubagentDefinition.
   */
  note?: string;
  /** User-visible cards serialized for the parent agent. */
  cards: SerializedConversationCard[];
  /** Declared artifact manifests created or versioned during this subagent run. */
  artifacts: ArtifactManifest[];
  /** Validation outcomes for validator-backed artifacts produced during this run. */
  artifactValidations: SubagentArtifactValidation[];
}

interface SubagentLoopOptions {
  tabId: string;
  signal: AbortSignal;
  runId: string;
  subagentDef: SubagentDefinition;
  /** Task description or question to pass to the subagent. */
  message: string;
  /** The parent tab's currently selected model (used as fallback). */
  parentModelId: string;
  providers: ProviderInstance[];
  debugEnabled: boolean;
}

/**
 * Execute a subagent agentic loop.
 *
 * The subagent maintains its own private API message history but appends its
 * streaming chat messages directly to the parent tab's chatMessages (with
 * agentName set) so they appear in the UI under the subagent's name.
 *
 * Tool approval rules are identical to the main agent: inline tools skip the
 * gate, and the tab's autoApproveEdits / autoApproveCommands flags apply.
 */
async function runSubagentLoop(
  opts: SubagentLoopOptions,
): Promise<
  | { ok: true; data: SubagentCallResult }
  | { ok: false; error: { code: string; message: string } }
> {
  const {
    tabId,
    signal,
    runId,
    subagentDef,
    message,
    parentModelId,
    providers,
    debugEnabled,
  } = opts;

  const startedAtMs = Date.now();
  const modelId = resolveSubagentModelId(subagentDef, parentModelId, providers);

  let languageModel;
  try {
    languageModel = resolveLanguageModel(modelId, providers);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const toolDefs = getToolDefinitionsByNames(subagentDef.tools);
  const systemPromptText = buildSubagentSystemPrompt(subagentDef);

  // Local API message history — not merged into the parent tab's apiMessages.
  const localApiMessages: ApiMessage[] = [
    { role: "system", content: systemPromptText },
    {
      role: "user",
      content:
        message.trim() || "(No task provided — please ask what you should do.)",
    },
  ];

  let finalText = "";
  let turns = 0;
  const MAX_SUBAGENT_ITERATIONS = 15;
  const collectedCards: ConversationCard[] = [];
  const collectedArtifacts: ArtifactManifest[] = [];
  const artifactValidations: SubagentArtifactValidation[] = [];

  async function prepareSubagentArtifactToolCall(
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): Promise<
    | { ok: true; data: PreparedSubagentArtifactToolCall }
    | { ok: false; result: ToolFailureResult }
  > {
    const declaredArtifacts = getSubagentArtifactSpecs(subagentDef);
    if (declaredArtifacts.length === 0) {
      return { ok: true, data: { args: rawArgs } };
    }

    if (
      toolName !== "agent_artifact_create" &&
      toolName !== "agent_artifact_version"
    ) {
      return { ok: true, data: { args: rawArgs } };
    }

    const requestedArtifactType =
      typeof rawArgs.artifactType === "string" ? rawArgs.artifactType.trim() : "";

    if (toolName === "agent_artifact_create") {
      if (!requestedArtifactType) {
        return {
          ok: false,
          result: makeSubagentToolError(
            `Subagent "${subagentDef.id}" must set artifactType when creating artifact payloads.`,
          ),
        };
      }

      const spec = getSubagentArtifactSpec(subagentDef, requestedArtifactType);
      if (!spec) {
        return {
          ok: false,
          result: makeSubagentToolError(
            `Unknown artifactType "${requestedArtifactType}" for subagent "${subagentDef.id}".`,
            { artifactType: requestedArtifactType },
          ),
        };
      }

      const kind = typeof rawArgs.kind === "string" ? rawArgs.kind : "";
      if (kind !== spec.kind) {
        return {
          ok: false,
          result: makeSubagentToolError(
            `artifactType "${requestedArtifactType}" must use kind "${spec.kind}".`,
            { artifactType: requestedArtifactType, expectedKind: spec.kind, actualKind: kind },
          ),
        };
      }

      const contentFormat =
        typeof rawArgs.contentFormat === "string" ? rawArgs.contentFormat : "";
      if (contentFormat !== spec.contentFormat) {
        return {
          ok: false,
          result: makeSubagentToolError(
            `artifactType "${requestedArtifactType}" must use contentFormat "${spec.contentFormat}".`,
            {
              artifactType: requestedArtifactType,
              expectedContentFormat: spec.contentFormat,
              actualContentFormat: contentFormat,
            },
          ),
        };
      }

      const content = typeof rawArgs.content === "string" ? rawArgs.content : null;
      if (content === null) {
        return {
          ok: false,
          result: makeSubagentToolError(
            `artifactType "${requestedArtifactType}" requires string content.`,
          ),
        };
      }

      const validation = validateSubagentArtifactContent(spec, content);
      if (validation?.status === "failed") {
        return {
          ok: false,
          result: makeSubagentToolError(
            `Artifact "${requestedArtifactType}" failed validation.`,
            {
              artifactType: requestedArtifactType,
              validatorId: validation.validatorId,
              issues: validation.issues,
            },
          ),
        };
      }

      return {
        ok: true,
        data: {
          args: {
            ...rawArgs,
            artifactType: requestedArtifactType,
            metadata: withArtifactFrameworkMetadata(
              rawArgs.metadata,
              requestedArtifactType,
              spec.validator?.id,
            ),
          },
          spec,
          validation,
        },
      };
    }

    const artifactId =
      typeof rawArgs.artifactId === "string" ? rawArgs.artifactId.trim() : "";
    if (!artifactId) {
      return {
        ok: false,
        result: makeSubagentToolError("artifactId must not be empty"),
      };
    }

    const latestResult = await artifactGet(tabId, {
      artifactId,
      includeContent: true,
    });
    if (!latestResult.ok) {
      return {
        ok: false,
        result: latestResult,
      };
    }

    const latestArtifact = latestResult.data.artifact;
    const frameworkMetadata = getArtifactFrameworkMetadata(latestArtifact.metadata);
    const resolvedArtifactType =
      requestedArtifactType || frameworkMetadata?.artifactType || "";

    if (!resolvedArtifactType) {
      return {
        ok: false,
        result: makeSubagentToolError(
          `artifactType is required when versioning artifact "${artifactId}" because the existing artifact has no framework metadata.`,
        ),
      };
    }

    const spec = getSubagentArtifactSpec(subagentDef, resolvedArtifactType);
    if (!spec) {
      return {
        ok: false,
        result: makeSubagentToolError(
          `Unknown artifactType "${resolvedArtifactType}" for subagent "${subagentDef.id}".`,
          { artifactId, artifactType: resolvedArtifactType },
        ),
      };
    }

    if (latestArtifact.kind !== spec.kind) {
      return {
        ok: false,
        result: makeSubagentToolError(
          `artifactType "${resolvedArtifactType}" must version kind "${spec.kind}".`,
          {
            artifactId,
            artifactType: resolvedArtifactType,
            expectedKind: spec.kind,
            actualKind: latestArtifact.kind,
          },
        ),
      };
    }

    const nextContentFormat =
      typeof rawArgs.content === "string"
        ? typeof rawArgs.contentFormat === "string"
          ? rawArgs.contentFormat
          : latestArtifact.contentFormat
        : latestArtifact.contentFormat;
    if (nextContentFormat !== spec.contentFormat) {
      return {
        ok: false,
        result: makeSubagentToolError(
          `artifactType "${resolvedArtifactType}" must use contentFormat "${spec.contentFormat}".`,
          {
            artifactId,
            artifactType: resolvedArtifactType,
            expectedContentFormat: spec.contentFormat,
            actualContentFormat: nextContentFormat,
          },
        ),
      };
    }

    const contentForValidation =
      typeof rawArgs.content === "string" ? rawArgs.content : latestArtifact.content;
    if (
      spec.validator &&
      spec.contentFormat === "json" &&
      typeof contentForValidation !== "string"
    ) {
      return {
        ok: false,
        result: makeSubagentToolError(
          `Artifact "${artifactId}" content could not be loaded for validator "${spec.validator.id}".`,
          { artifactId, artifactType: resolvedArtifactType, validatorId: spec.validator.id },
        ),
      };
    }

    const validation =
      typeof contentForValidation === "string"
        ? validateSubagentArtifactContent(spec, contentForValidation)
        : undefined;
    if (validation?.status === "failed") {
      return {
        ok: false,
        result: makeSubagentToolError(
          `Artifact "${resolvedArtifactType}" failed validation.`,
          {
            artifactId,
            artifactType: resolvedArtifactType,
            validatorId: validation.validatorId,
            issues: validation.issues,
          },
        ),
      };
    }

    return {
      ok: true,
      data: {
        args: {
          ...rawArgs,
          artifactType: resolvedArtifactType,
          metadata: withArtifactFrameworkMetadata(
            rawArgs.metadata ?? latestArtifact.metadata,
            resolvedArtifactType,
            spec.validator?.id,
          ),
        },
        spec,
        validation,
      },
    };
  }

  function finalizeSubagentArtifacts():
    | { ok: true }
    | { ok: false; result: ToolFailureResult } {
    const declaredArtifacts = getSubagentArtifactSpecs(subagentDef);
    if (declaredArtifacts.length === 0) {
      return { ok: true };
    }

    const artifactIdsByType = new Map<string, Set<string>>();
    for (const artifact of collectedArtifacts) {
      const artifactType = getArtifactFrameworkMetadata(artifact.metadata)?.artifactType;
      if (!artifactType) continue;
      const bucket = artifactIdsByType.get(artifactType) ?? new Set<string>();
      bucket.add(artifact.artifactId);
      artifactIdsByType.set(artifactType, bucket);
    }

    const missingRequired: string[] = [];
    const cardinalityErrors: Array<{ artifactType: string; count: number }> = [];

    for (const spec of declaredArtifacts) {
      const producedIds = artifactIdsByType.get(spec.artifactType) ?? new Set<string>();
      const required = spec.required ?? true;
      const cardinality = spec.cardinality ?? "one";

      if (required && producedIds.size === 0) {
        missingRequired.push(spec.artifactType);
      }
      if (cardinality === "one" && producedIds.size > 1) {
        cardinalityErrors.push({
          artifactType: spec.artifactType,
          count: producedIds.size,
        });
      }
    }

    if (missingRequired.length === 0 && cardinalityErrors.length === 0) {
      return { ok: true };
    }

    return {
      ok: false,
      result: makeSubagentToolError(
        `Subagent "${subagentDef.id}" did not satisfy its artifact contract.`,
        {
          ...(missingRequired.length > 0 ? { missingRequired } : {}),
          ...(cardinalityErrors.length > 0 ? { cardinalityErrors } : {}),
        },
      ),
    };
  }

  for (let iteration = 0; iteration < MAX_SUBAGENT_ITERATIONS; iteration++) {
    if (signal.aborted) break;
    turns++;

    let accText = "";
    let accReasoning = "";
    let reasoningActive = false;
    let reasoningStartedAtMs: number | null = null;
    let reasoningDurationMs: number | null = null;
    const streamErrors: unknown[] = [];

    const assistantChatId = msgId();
    appendChatMessage(tabId, {
      id: assistantChatId,
      role: "assistant",
      agentName: subagentDef.name,
      content: "",
      timestamp: Date.now(),
      streaming: true,
    });
    patchAgentState(tabId, { streamingContent: "" });

    const mappedMessages = mapApiMessagesToModelMessages(localApiMessages);
    const result = streamText({
      model: languageModel,
      messages: mappedMessages,
      tools: toolDefs,
      abortSignal: signal,
    });

    const updateSubagentStreamMsg = () => {
      updateLastChatMessage(tabId, (m) =>
        m.id === assistantChatId
          ? {
              ...m,
              agentName: subagentDef.name,
              content: accText,
              reasoning: accReasoning || undefined,
              reasoningStreaming: reasoningActive ? true : undefined,
              reasoningStartedAtMs: reasoningStartedAtMs ?? undefined,
              reasoningDurationMs: reasoningDurationMs ?? undefined,
            }
          : m,
      );
    };

    try {
      const ensureReasoningStart = () => {
        if (reasoningStartedAtMs === null) reasoningStartedAtMs = Date.now();
      };
      const finalizeReasoningDuration = () => {
        if (reasoningStartedAtMs === null || reasoningDurationMs !== null)
          return;
        reasoningDurationMs = Math.max(0, Date.now() - reasoningStartedAtMs);
      };

      const fullStream = (result as { fullStream?: AsyncIterable<unknown> })
        .fullStream;
      if (fullStream) {
        for await (const part of fullStream) {
          if (signal.aborted) break;
          const streamError = streamPartError(part);
          if (streamError !== null) {
            streamErrors.push(streamError);
            continue;
          }
          if (isRecord(part) && part.type === "reasoning-start") {
            ensureReasoningStart();
            reasoningActive = true;
            updateSubagentStreamMsg();
            continue;
          }
          if (isRecord(part) && part.type === "reasoning-end") {
            reasoningActive = false;
            finalizeReasoningDuration();
            updateSubagentStreamMsg();
            continue;
          }
          const textDelta = streamDeltaPart(part, "text-delta");
          if (textDelta !== null) {
            accText += textDelta;
            patchAgentState(tabId, { streamingContent: accText });
            updateSubagentStreamMsg();
            continue;
          }
          const reasoningDelta = streamDeltaPart(part, "reasoning-delta");
          if (reasoningDelta !== null) {
            ensureReasoningStart();
            reasoningActive = true;
            accReasoning += reasoningDelta;
            updateSubagentStreamMsg();
          }
        }
      } else {
        for await (const delta of result.textStream) {
          if (signal.aborted) break;
          accText += delta;
          patchAgentState(tabId, { streamingContent: accText });
          updateSubagentStreamMsg();
        }
      }
    } catch (err) {
      if (!signal.aborted) throw attachStreamErrors(err, streamErrors);
      break;
    }

    let sdkToolCalls: unknown;
    try {
      sdkToolCalls = await result.toolCalls;
    } catch (err) {
      throw attachStreamErrors(err, streamErrors);
    }

    if (reasoningStartedAtMs !== null && reasoningDurationMs === null) {
      reasoningDurationMs = Math.max(0, Date.now() - reasoningStartedAtMs);
    }
    patchAgentState(tabId, { streamingContent: null });

    const parsedToolCalls: ApiToolCall[] = (
      Array.isArray(sdkToolCalls) ? sdkToolCalls : []
    )
      .map((tc) => toApiToolCall(tc))
      .filter((tc): tc is ApiToolCall => tc !== null);

    const pendingToolCallDisplays: ToolCallDisplay[] = parsedToolCalls.map(
      (tc) => ({
        id: tc.id,
        tool: tc.function.name,
        args: parseArgs(tc.function.arguments),
        status: "pending" as const,
      }),
    );

    // Finalise the streaming assistant message.
    updateLastChatMessage(tabId, (m) => {
      if (m.id !== assistantChatId) return m;
      return {
        ...m,
        agentName: subagentDef.name,
        content: accText,
        reasoning: accReasoning || undefined,
        reasoningStreaming: undefined,
        reasoningStartedAtMs: reasoningStartedAtMs ?? undefined,
        reasoningDurationMs: reasoningDurationMs ?? undefined,
        streaming: false,
        badge: parsedToolCalls.length > 0 ? "CALLING TOOLS" : undefined,
        toolCalls:
          parsedToolCalls.length > 0 ? pendingToolCallDisplays : undefined,
      };
    });

    finalText = accText;

    // Append to local (private) API history.
    localApiMessages.push({
      role: "assistant",
      content: accText || null,
      ...(parsedToolCalls.length > 0 ? { tool_calls: parsedToolCalls } : {}),
    });

    // No tool calls → turn is complete.
    if (parsedToolCalls.length === 0) break;

    const turnCardAccumulator = createConversationCardAccumulator(
      tabId,
      assistantChatId,
      parsedToolCalls,
    );

    // Execute tool calls with identical approval rules as the main agent.
    const toolResults = await Promise.all(
      parsedToolCalls.map(async (tc) => {
        const tcId = tc.id;

        function updateToolCallById(patch: Partial<ToolCallDisplay>): void {
          if (signal.aborted || !isCurrentRunId(tabId, runId)) return;
          patchAgentState(tabId, (prev) => ({
            ...prev,
            chatMessages: prev.chatMessages.map((m) =>
              m.toolCalls
                ? {
                    ...m,
                    toolCalls: m.toolCalls.map((t) =>
                      t.id === tcId ? { ...t, ...patch } : t,
                    ),
                  }
                : m,
            ),
          }));
        }

        // ── user_input interception ───────────────────────────────────
        // Pause the subagent loop and wait for the user to answer.
        if (tc.function.name === "user_input") {
          updateToolCallById({ status: "awaiting_approval" });
          const answer = await requestUserInput(tabId, tcId);
          if (answer === null) {
            updateToolCallById({ status: "denied" });
            return {
              tool_call_id: tcId,
              result: {
                ok: false as const,
                error: {
                  code: "PERMISSION_DENIED" as const,
                  message: "User skipped the question.",
                },
              },
            };
          }
          updateToolCallById({ status: "done", result: { answer } });
          return {
            tool_call_id: tcId,
            result: { ok: true as const, data: { answer } },
          };
        }

        if (tc.function.name === "agent_card_add") {
          updateToolCallById({ status: "running" });
          const preparedCard = prepareConversationCardToolCall(
            parseArgs(tc.function.arguments),
          );
          if (!preparedCard.ok) {
            turnCardAccumulator.markSkipped(tcId);
            updateToolCallById({
              status: "error",
              result: preparedCard.result.error,
            });
            return {
              tool_call_id: tcId,
              result: preparedCard.result,
            };
          }

          updateToolCallById({
            status: "done",
            result: preparedCard.data.result.data,
          });
          turnCardAccumulator.markDone(tcId, preparedCard.data.card);
          return {
            tool_call_id: tcId,
            result: preparedCard.data.result,
            card: preparedCard.data.card,
          };
        }

        const preArgs = parseArgs(tc.function.arguments);
        const preCwd = getAgentState(tabId).config.cwd;
        const preparedArtifactCall = await prepareSubagentArtifactToolCall(
          tc.function.name,
          preArgs,
        );
        if (!preparedArtifactCall.ok) {
          updateToolCallById({
            status: "error",
            result: preparedArtifactCall.result.error,
          });
          return { tool_call_id: tcId, result: preparedArtifactCall.result };
        }
        const preparedArgs = preparedArtifactCall.data.args;

        // Pre-validation (same as main agent)
        const validationResult = await validateTool(
          tabId,
          preCwd,
          tc.function.name,
          preparedArgs,
        );
        if (validationResult && !validationResult.ok) {
          updateToolCallById({
            status: "error",
            result: validationResult.error,
          });
          return { tool_call_id: tcId, result: validationResult };
        }

        // Pre-compute UI diffs (same as main agent)
        if (tc.function.name === "workspace_editFile") {
          const path = typeof preArgs.path === "string" ? preArgs.path : null;
          const changes = Array.isArray(preArgs.changes)
            ? (preArgs.changes as EditFileChange[])
            : null;
          if (path && changes) {
            const diffs = await buildEditFileDiffFiles(path, changes, preCwd);
            if (diffs)
              updateToolCallById({
                originalDiffFiles: diffs.map(serializeDiff),
              });
          }
        } else if (tc.function.name === "workspace_writeFile") {
          const path = typeof preArgs.path === "string" ? preArgs.path : null;
          const content =
            typeof preArgs.content === "string" ? preArgs.content : "";
          const overwrite = preArgs.overwrite === true;
          if (path) {
            const diffs = await buildWriteFileDiffFiles(
              path,
              content,
              overwrite,
              preCwd,
            );
            if (diffs)
              updateToolCallById({
                originalDiffFiles: diffs.map(serializeDiff),
              });
          }
        }

        // Approval gate — reads tab-level auto-approve flags (identical to main agent)
        const subState = getAgentState(tabId);
        if (
          requiresApproval(
            tc.function.name,
            subState.autoApproveEdits,
            subState.autoApproveCommands,
            preparedArgs,
          )
        ) {
          updateToolCallById({ status: "awaiting_approval" });
          const approved = await requestApproval(tabId, tcId);
          if (!approved) {
            const reason = consumeApprovalReason(tabId, tcId);
            updateToolCallById({ status: "denied" });
            return {
              tool_call_id: tcId,
              result: {
                ok: false as const,
                error: {
                  code: "PERMISSION_DENIED" as const,
                  message: reason ?? "Tool call denied by user",
                },
              },
            };
          }
        }

        updateToolCallById({ status: "running" });

        const args = preparedArgs;
        const currentCwd = getAgentState(tabId).config.cwd;
        let streamBuf = "";
        const callbacks: DispatchCallbacks | undefined =
          tc.function.name === "exec_run"
            ? {
                onExecOutput: (_stream, data) => {
                  streamBuf += data;
                  updateToolCallById({ streamingOutput: streamBuf });
                },
              }
            : undefined;

        const toolResult = await dispatchTool(
          tabId,
          currentCwd,
          tc.function.name,
          args,
          tcId,
          callbacks,
          { runId, agentId: `agent_${subagentDef.id}` },
        );
        updateToolCallById({
          status: toolResult.ok ? "done" : "error",
          result: toolResult.ok ? toolResult.data : toolResult.error,
        });

        if (
          toolResult.ok &&
          preparedArtifactCall.data.spec &&
          (tc.function.name === "agent_artifact_create" ||
            tc.function.name === "agent_artifact_version")
        ) {
          const d = toolResult.data as Record<string, unknown>;
          if (d.artifact && typeof d.artifact === "object") {
            const artifact = d.artifact as ArtifactManifest;
            collectedArtifacts.push(artifact);
            if (preparedArtifactCall.data.validation) {
              artifactValidations.push({
                ...preparedArtifactCall.data.validation,
                artifactId: artifact.artifactId,
              });
            }
          }
        }

        return { tool_call_id: tcId, result: toolResult };
      }),
    );
    if (signal.aborted || !isCurrentRunId(tabId, runId)) {
      const abortError = new Error("Subagent run aborted");
      abortError.name = "AbortError";
      throw abortError;
    }

    // Append tool results to local API history.
    const toolApiMessages: ApiMessage[] = toolResults.map(
      ({ tool_call_id, result }) => ({
        role: "tool" as const,
        tool_call_id,
        content: serializeToolResultForModel(
          tool_call_id,
          parsedToolCalls,
          result,
        ),
      }),
    );
    localApiMessages.push(...toolApiMessages);

    const resolvedTurnCards = turnCardAccumulator.getResolvedCards();
    if (resolvedTurnCards.length > 0) {
      collectedCards.push(...resolvedTurnCards);
    }

    if (debugEnabled) {
      console.log(
        `[rakh:subagent][${tabId}][${subagentDef.id}]`,
        `iteration=${iteration} toolCalls=${parsedToolCalls.length}`,
      );
    }
  }

  const contractResult = finalizeSubagentArtifacts();
  if (!contractResult.ok) {
    return {
      ok: false,
      error: contractResult.result.error,
    };
  }

  const note = subagentDef.output?.parentNote;

  return {
    ok: true,
    data: {
      subagentId: subagentDef.id,
      name: subagentDef.name,
      modelId,
      startedAtMs,
      finishedAtMs: Date.now(),
      turns,
      rawText: finalText,
      cards: collectedCards.map(serializeConversationCardForParent),
      artifacts: collectedArtifacts,
      artifactValidations,
      ...(note !== undefined ? { note } : {}),
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   Main runAgent — public API
───────────────────────────────────────────────────────────────────────────── */

/**
 * Retry the last user message after an error.
 * Strips the failed assistant turn from both histories but keeps the user chat
 * message visible throughout, then calls runAgent which re-adds it to the API
 * history and streams a fresh assistant response.
 */
export async function retryAgent(tabId: string): Promise<void> {
  const state = getAgentState(tabId);

  // Find the last user message in apiMessages
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

  // No user message found in history — nothing to retry
  if (!lastUserMessage) return;

  // Strip apiMessages back to before the last user message
  const strippedApiMessages = state.apiMessages.slice(0, lastUserIndex);

  // Keep the last user chat message visible so the UI never shows a blank
  // gap between the strip and runAgent re-appending it. Only strip the
  // failed assistant turn(s) that follow it.
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

  // Reset state — the user message stays in chatMessages so it remains
  // visible. runAgent is told not to re-append it to avoid a duplicate.
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

/**
 * Start (or continue) an agent conversation for a tab.
 * Multiple calls for different tabIds run concurrently.
 * If the agent is already running for this tab, the previous run is aborted first.
 */
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
  const activeRun: ActiveRun = {
    runId,
    controller,
    abortReason: null,
  };
  activeRuns.set(tabId, activeRun);

  let completedCleanly = false;

  // ── Trigger command detection ──────────────────────────────────────────────
  // If the message starts with a registered subagent trigger (e.g. "/plan …"),
  // route directly to that subagent — the main agent loop is skipped entirely.
  const triggerMatch = findSubagentByTrigger(userMessage);
  if (triggerMatch) {
    const { subagent: triggerSubagent, subMessage } = triggerMatch;
    const triggerState = getAgentState(tabId);
    const triggerProviders = jotaiStore.get(providersAtom);
    const triggerDebug = triggerState.showDebug ?? false;

    const triggerUserMsg: ChatMessage = {
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
      chatMessages: options?.skipUserChatAppend
        ? prev.chatMessages
        : [...prev.chatMessages, triggerUserMsg],
      streamingContent: null,
    }));

    try {
      const triggerResult = await runSubagentLoop({
        tabId,
        signal: controller.signal,
        runId,
        subagentDef: triggerSubagent,
        message: subMessage,
        parentModelId: triggerState.config.model,
        providers: triggerProviders,
        debugEnabled: triggerDebug,
      });
      if (!triggerResult.ok) {
        setAgentErrorState(
          tabId,
          triggerResult.error.message,
          triggerResult.error,
        );
      } else {
        completedCleanly = true;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setAgentErrorState(tabId, msg, serializeError(err));
      updateLastChatMessage(tabId, (m) =>
        m.role === "assistant" ? { ...m, streaming: false } : m,
      );
      return;
    } finally {
      clearActiveRun(tabId, activeRun);
      if (activeRun.abortReason !== null) return;
      if (completedCleanly) {
        patchAgentState(tabId, (prev) => ({
          ...prev,
          status: "idle",
          streamingContent: null,
          queueState: normalizeQueueState(prev.queuedMessages, prev.queueState),
        }));
        void maybeStartQueuedRun(tabId).catch(console.error);
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

  console.log(
    `Starting agent with model ${model} (provider: ${provider}) in workspace ${cwd}`,
  );

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
      `Selected model is missing sdk_id. Please update src/agent/models.catalog.json for ${modelEntry.id}.`,
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

  // 1. Add user message to both chat display and API history
  const userChatMsg: ChatMessage = {
    id: msgId(),
    role: "user",
    content: userMessage,
    timestamp: Date.now(),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
  dequeueQueuedMessage(tabId, options.queuedMessageId);

  // Detect git repo on first turn so the system prompt can include the GIT ISOLATION section.
  let isGitRepo = false;
  let hasAgentsFile = false;
  let hasSkillsDir = false;
  if (state.apiMessages.length === 0 && cwd) {
    try {
      const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
      const r = await tauriInvoke<{ exitCode: number }>("exec_run", {
        command: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd,
        env: {},
        timeoutMs: 5000,
        maxStdoutBytes: 512,
        maxStderrBytes: 512,
        stdin: null,
      });
      isGitRepo = r.exitCode === 0;
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
      // Not in Tauri or git not available — leave false
    }
  }

  const newApiMessages: ApiMessage[] = [
    // Inject system prompt if this is the first message
    ...(state.apiMessages.length === 0
      ? [
          {
            role: "system" as const,
            content: buildSystemPrompt(
              cwd,
              isGitRepo,
              hasAgentsFile,
              hasSkillsDir,
              buildSystemPromptRuntimeContext(),
            ),
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
    );
    completedCleanly = !controller.signal.aborted;
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    const msg = err instanceof Error ? err.message : String(err);
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
    void maybeStartQueuedRun(tabId).catch(console.error);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Internal agentic loop
───────────────────────────────────────────────────────────────────────────── */

async function agentLoop(
  tabId: string,
  signal: AbortSignal,
  modelId: string,
  providers: ProviderInstance[],
  debugEnabled: boolean,
  runId: string,
): Promise<void> {
  const languageModel = resolveLanguageModel(modelId, providers);
  const modelEntry = getModelCatalogEntry(modelId);
  const provider = modelEntry?.owned_by ?? null;
  const advancedOpts = getAgentState(tabId).config.advancedOptions;
  const providerOptions = buildProviderOptions(
    provider,
    advancedOpts,
    modelEntry?.sdk_id?.trim(),
  );

  // Loop until the model returns a turn with no tool calls
  for (let iteration = 0; iteration < 50; iteration++) {
    if (signal.aborted) return;

    const turnStartedAtMs = Date.now();
    const currentApiMessages = getAgentState(tabId).apiMessages;
    logStreamDebug(tabId, debugEnabled, "turn:start", {
      iteration,
      apiMessageCount: currentApiMessages.length,
      modelId,
    });
    let usedFullStream = false;
    let streamPartCount = 0;
    let streamErrorPartCount = 0;
    let textDeltaCount = 0;
    let textDeltaChars = 0;
    let reasoningDeltaCount = 0;
    let reasoningDeltaChars = 0;
    let reasoningStartCount = 0;
    let reasoningEndCount = 0;

    // --- Streaming turn ---
    let accText = "";
    let accReasoning = "";
    let reasoningActive = false;
    let reasoningStartedAtMs: number | null = null;
    let reasoningDurationMs: number | null = null;
    const streamErrors: unknown[] = [];

    // Create a placeholder assistant chat message for streaming
    const assistantChatId = msgId();
    appendChatMessage(tabId, {
      id: assistantChatId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      streaming: true,
    });

    patchAgentState(tabId, { status: "thinking", streamingContent: "" });

    const mappedMessages = mapApiMessagesToModelMessages(currentApiMessages);

    const result = streamText({
      model: languageModel,
      messages: mappedMessages,
      tools: TOOL_DEFINITIONS,
      abortSignal: signal,
      ...(providerOptions ? { providerOptions } : {}),
    });

    try {
      const ensureReasoningStart = () => {
        if (reasoningStartedAtMs === null) {
          reasoningStartedAtMs = Date.now();
        }
      };

      const finalizeReasoningDuration = () => {
        if (reasoningStartedAtMs === null || reasoningDurationMs !== null) {
          return;
        }
        reasoningDurationMs = Math.max(0, Date.now() - reasoningStartedAtMs);
      };

      const updateStreamingMessage = () => {
        updateLastChatMessage(tabId, (m) =>
          m.id === assistantChatId
            ? {
                ...m,
                content: accText,
                reasoning: accReasoning || undefined,
                reasoningStreaming: reasoningActive ? true : undefined,
                reasoningStartedAtMs: reasoningStartedAtMs ?? undefined,
                reasoningDurationMs: reasoningDurationMs ?? undefined,
              }
            : m,
        );
      };

      const fullStream = (result as { fullStream?: AsyncIterable<unknown> })
        .fullStream;
      if (fullStream) {
        usedFullStream = true;
        for await (const part of fullStream) {
          if (signal.aborted) return;
          streamPartCount += 1;
          logStreamDebug(tabId, debugEnabled, "stream:part", part);

          const streamError = streamPartError(part);
          if (streamError !== null) {
            streamErrorPartCount += 1;
            logStreamDebug(
              tabId,
              debugEnabled,
              "stream:error-part",
              streamError,
            );
            streamErrors.push(streamError);
            continue;
          }

          if (isRecord(part) && part.type === "reasoning-start") {
            reasoningStartCount += 1;
            ensureReasoningStart();
            reasoningActive = true;
            logStreamDebug(tabId, debugEnabled, "stream:reasoning-start");
            updateStreamingMessage();
            continue;
          }

          if (isRecord(part) && part.type === "reasoning-end") {
            reasoningEndCount += 1;
            reasoningActive = false;
            finalizeReasoningDuration();
            logStreamDebug(tabId, debugEnabled, "stream:reasoning-end", {
              reasoningDurationMs,
            });
            updateStreamingMessage();
            continue;
          }

          const textDelta = streamDeltaPart(part, "text-delta");
          if (textDelta !== null) {
            accText += textDelta;
            textDeltaCount += 1;
            textDeltaChars += textDelta.length;
            logStreamDebug(tabId, debugEnabled, "stream:text-delta", {
              delta: textDelta,
              deltaLength: textDelta.length,
              accumulatedLength: accText.length,
            });
            patchAgentState(tabId, { streamingContent: accText });
            updateStreamingMessage();
            continue;
          }

          const reasoningDelta = streamDeltaPart(part, "reasoning-delta");
          if (reasoningDelta !== null) {
            ensureReasoningStart();
            reasoningActive = true;
            accReasoning += reasoningDelta;
            reasoningDeltaCount += 1;
            reasoningDeltaChars += reasoningDelta.length;
            logStreamDebug(tabId, debugEnabled, "stream:reasoning-delta", {
              delta: reasoningDelta,
              deltaLength: reasoningDelta.length,
              accumulatedLength: accReasoning.length,
            });
            updateStreamingMessage();
          }
        }
      } else {
        // Backward-compatible fallback for environments that only expose textStream.
        for await (const delta of result.textStream) {
          if (signal.aborted) return;
          accText += delta;
          textDeltaCount += 1;
          textDeltaChars += delta.length;
          logStreamDebug(tabId, debugEnabled, "stream:text-delta:textStream", {
            delta,
            deltaLength: delta.length,
            accumulatedLength: accText.length,
          });

          patchAgentState(tabId, { streamingContent: accText });
          updateStreamingMessage();
        }
      }
    } catch (err) {
      logStreamDebug(tabId, debugEnabled, "stream:throw", err);
      // Re-throw if it's not a generic abort
      if (!signal.aborted) throw attachStreamErrors(err, streamErrors);
      return;
    }

    let sdkToolCalls: unknown;
    try {
      sdkToolCalls = await result.toolCalls;
      logStreamDebug(
        tabId,
        debugEnabled,
        "stream:tool-calls:raw",
        sdkToolCalls,
      );
    } catch (err) {
      logStreamDebug(tabId, debugEnabled, "stream:tool-calls:error", err);
      throw attachStreamErrors(err, streamErrors);
    }

    // --- Turn complete ---
    if (reasoningStartedAtMs !== null && reasoningDurationMs === null) {
      reasoningDurationMs = Math.max(0, Date.now() - reasoningStartedAtMs);
    }
    patchAgentState(tabId, { streamingContent: null });

    // Build the assistant API message
    const parsedToolCalls: ApiToolCall[] = (
      Array.isArray(sdkToolCalls) ? sdkToolCalls : []
    )
      .map((tc) => toApiToolCall(tc))
      .filter((tc): tc is ApiToolCall => tc !== null);
    logStreamDebug(tabId, debugEnabled, "stream:tool-calls:parsed", {
      count: parsedToolCalls.length,
      toolCallIds: parsedToolCalls.map((tc) => tc.id),
      toolNames: parsedToolCalls.map((tc) => tc.function.name),
    });
    logStreamDebug(tabId, debugEnabled, "stream:summary", {
      iteration,
      turnDurationMs: Math.max(0, Date.now() - turnStartedAtMs),
      usedFullStream,
      streamPartCount,
      streamErrorPartCount,
      textDeltaCount,
      textDeltaChars,
      reasoningStartCount,
      reasoningEndCount,
      reasoningDeltaCount,
      reasoningDeltaChars,
      assistantTextChars: accText.length,
      assistantReasoningChars: accReasoning.length,
      toolCallCount: parsedToolCalls.length,
      reasoningDurationMs: reasoningDurationMs ?? undefined,
    });

    const assistantApiMsg: AssistantApiMessage = {
      role: "assistant",
      content: accText || null,
      ...(parsedToolCalls.length > 0 ? { tool_calls: parsedToolCalls } : {}),
    };

    const pendingToolCallDisplays: ToolCallDisplay[] = parsedToolCalls.map(
      (tc) => ({
        id: tc.id,
        tool: tc.function.name,
        args: parseArgs(tc.function.arguments),
        status: "pending" as const,
      }),
    );

    // Finalise the streaming chat message. Every assistant turn maps to one
    // assistant bubble; tool calls for this turn stay attached to this bubble.
    updateLastChatMessage(tabId, (m) => {
      if (m.id !== assistantChatId) return m;
      return {
        ...m,
        content: accText,
        reasoning: accReasoning || undefined,
        reasoningStreaming: undefined,
        reasoningStartedAtMs: reasoningStartedAtMs ?? undefined,
        reasoningDurationMs: reasoningDurationMs ?? undefined,
        streaming: false,
        badge: parsedToolCalls.length > 0 ? "CALLING TOOLS" : undefined,
        toolCalls:
          parsedToolCalls.length > 0 ? pendingToolCallDisplays : undefined,
      };
    });

    // Append assistant message to API history
    patchAgentState(tabId, (prev) => ({
      ...prev,
      apiMessages: [...prev.apiMessages, assistantApiMsg],
    }));

    // --- No tool calls → agent is done ---
    if (parsedToolCalls.length === 0) {
      patchAgentState(tabId, { status: "idle" });
      return;
    }

    // --- Execute tool calls in parallel ---
    patchAgentState(tabId, { status: "working" });

    const turnCardAccumulator = createConversationCardAccumulator(
      tabId,
      assistantChatId,
      parsedToolCalls,
    );

    const toolResults = await Promise.all(
      parsedToolCalls.map(async (tc) => {
        const tcId = tc.id;

        /** Update this specific tool call (by id) regardless of which message hosts it. */
        function updateToolCallById(patch: Partial<ToolCallDisplay>): void {
          if (signal.aborted || !isCurrentRunId(tabId, runId)) return;
          patchAgentState(tabId, (prev) => ({
            ...prev,
            chatMessages: prev.chatMessages.map((m) =>
              m.toolCalls
                ? {
                    ...m,
                    toolCalls: m.toolCalls.map((t) =>
                      t.id === tcId ? { ...t, ...patch } : t,
                    ),
                  }
                : m,
            ),
          }));
        }

        // ── Subagent call interception ────────────────────────────────────
        // agent_subagent_call bypasses the normal tool dispatch and runs a
        // full subagent loop instead.
        if (tc.function.name === "agent_subagent_call") {
          const saPreArgs = parseArgs(tc.function.arguments);
          const subagentId =
            typeof saPreArgs.subagentId === "string"
              ? saPreArgs.subagentId
              : "";
          const subagentMessage =
            typeof saPreArgs.message === "string" ? saPreArgs.message : "";
          const subagentDef = getSubagent(subagentId);

          if (!subagentDef) {
            updateToolCallById({
              status: "error",
              result: {
                code: "NOT_FOUND",
                message: `Unknown subagent "${subagentId}"`,
              },
            });
            return {
              tool_call_id: tcId,
              result: {
                ok: false as const,
                error: {
                  code: "NOT_FOUND" as const,
                  message: `Unknown subagent "${subagentId}"`,
                },
              },
            };
          }

          // Optional per-subagent invocation approval.
          if (subagentDef.requiresApproval) {
            updateToolCallById({ status: "awaiting_approval" });
            const approved = await requestApproval(tabId, tcId);
            if (!approved) {
              const reason = consumeApprovalReason(tabId, tcId);
              updateToolCallById({ status: "denied" });
              return {
                tool_call_id: tcId,
                result: {
                  ok: false as const,
                  error: {
                    code: "PERMISSION_DENIED" as const,
                    message: reason ?? "Subagent call denied by user",
                  },
                },
              };
            }
          }

          updateToolCallById({ status: "running" });

          const saResult = await runSubagentLoop({
            tabId,
            signal,
            runId,
            subagentDef,
            message: subagentMessage,
            parentModelId: modelId,
            providers,
            debugEnabled,
          });

          updateToolCallById({
            status: saResult.ok ? "done" : "error",
            result: saResult.ok ? saResult.data : saResult.error,
          });
          return { tool_call_id: tcId, result: saResult };
        }

        // ── user_input interception ─────────────────────────────────
        // Pause the agent loop and wait for the user to answer.
        if (tc.function.name === "user_input") {
          updateToolCallById({ status: "awaiting_approval" });
          const answer = await requestUserInput(tabId, tcId);
          if (answer === null) {
            updateToolCallById({ status: "denied" });
            return {
              tool_call_id: tcId,
              result: {
                ok: false as const,
                error: {
                  code: "PERMISSION_DENIED" as const,
                  message: "User skipped the question.",
                },
              },
            };
          }
          updateToolCallById({ status: "done", result: { answer } });
          return {
            tool_call_id: tcId,
            result: { ok: true as const, data: { answer } },
          };
        }

        if (tc.function.name === "agent_card_add") {
          updateToolCallById({ status: "running" });
          const preparedCard = prepareConversationCardToolCall(
            parseArgs(tc.function.arguments),
          );
          if (!preparedCard.ok) {
            turnCardAccumulator.markSkipped(tcId);
            updateToolCallById({
              status: "error",
              result: preparedCard.result.error,
            });
            return {
              tool_call_id: tcId,
              result: preparedCard.result,
            };
          }

          updateToolCallById({
            status: "done",
            result: preparedCard.data.result.data,
          });
          turnCardAccumulator.markDone(tcId, preparedCard.data.card);
          return {
            tool_call_id: tcId,
            result: preparedCard.data.result,
            card: preparedCard.data.card,
          };
        }

        // ── Pre-validation gate ───────────────────────────────────────────
        const preArgs = parseArgs(tc.function.arguments);
        const preCwd = getAgentState(tabId).config.cwd;

        const validationResult = await validateTool(
          tabId,
          preCwd,
          tc.function.name,
          preArgs,
        );
        if (validationResult && !validationResult.ok) {
          updateToolCallById({
            status: "error",
            result: validationResult.error,
          });
          return { tool_call_id: tcId, result: validationResult };
        }

        // ── Pre-compute UI Diffs ──────────────────────────────────────────
        // Capture diff off the current disk state *before* execution so that
        // later, when the tool is expanded in the chat, the diff is exact.
        if (tc.function.name === "workspace_editFile") {
          const path = typeof preArgs.path === "string" ? preArgs.path : null;
          const changes = Array.isArray(preArgs.changes)
            ? (preArgs.changes as EditFileChange[])
            : null;
          if (path && changes) {
            const diffs = await buildEditFileDiffFiles(path, changes, preCwd);
            if (diffs)
              updateToolCallById({
                originalDiffFiles: diffs.map(serializeDiff),
              });
          }
        } else if (tc.function.name === "workspace_writeFile") {
          const path = typeof preArgs.path === "string" ? preArgs.path : null;
          const content =
            typeof preArgs.content === "string" ? preArgs.content : "";
          const overwrite = preArgs.overwrite === true;
          if (path) {
            const diffs = await buildWriteFileDiffFiles(
              path,
              content,
              overwrite,
              preCwd,
            );
            if (diffs)
              updateToolCallById({
                originalDiffFiles: diffs.map(serializeDiff),
              });
          }
        }

        // ── Approval gate ─────────────────────────────────────────────────
        if (
          requiresApproval(
            tc.function.name,
            getAgentState(tabId).autoApproveEdits,
            getAgentState(tabId).autoApproveCommands,
            preArgs,
          )
        ) {
          updateToolCallById({ status: "awaiting_approval" });

          const approved = await requestApproval(tabId, tcId);

          if (!approved) {
            const reason = consumeApprovalReason(tabId, tcId);
            updateToolCallById({ status: "denied" });
            return {
              tool_call_id: tcId,
              result: {
                ok: false as const,
                error: {
                  code: "PERMISSION_DENIED" as const,
                  message: reason ?? "Tool call denied by user",
                },
              },
            };
          }
        }

        // Mark tool call as running
        updateToolCallById({ status: "running" });

        const args = parseArgs(tc.function.arguments);
        // Read cwd fresh — it may have changed if git_worktree_init switched the workspace.
        const currentCwd = getAgentState(tabId).config.cwd;

        // For exec_run, stream output chunks into the tool call display.
        let streamBuf = "";
        const callbacks: DispatchCallbacks | undefined =
          tc.function.name === "exec_run"
            ? {
                onExecOutput: (_stream, data) => {
                  streamBuf += data;
                  updateToolCallById({ streamingOutput: streamBuf });
                },
              }
            : undefined;

        const result = await dispatchTool(
          tabId,
          currentCwd,
          tc.function.name,
          args,
          tcId,
          callbacks,
          { runId, agentId: "agent_main" },
        );

        // Mark tool call as done/error
        updateToolCallById({
          status: result.ok ? "done" : "error",
          result: result.ok ? result.data : result.error,
        });

        return { tool_call_id: tcId, result };
      }),
    );
    if (signal.aborted || !isCurrentRunId(tabId, runId)) return;

    // Append tool result messages to API history
    const toolApiMessages: ApiMessage[] = toolResults.map(
      ({ tool_call_id, result }) => ({
        role: "tool" as const,
        tool_call_id,
        content: serializeToolResultForModel(
          tool_call_id,
          parsedToolCalls,
          result,
        ),
      }),
    );

    patchAgentState(tabId, (prev) => ({
      ...prev,
      apiMessages: [...prev.apiMessages, ...toolApiMessages],
    }));

    // Loop for another LLM turn
  }

  // Safety: hit iteration cap
  setAgentErrorState(tabId, "Reached maximum iteration limit (50 turns)");
}

/* ─────────────────────────────────────────────────────────────────────────────
   Utility
─────────────────────────────────────────────────────────────────────────────── */

/**
 * Produce a compact, token-friendly model output for workspace_search results.
 * Format mirrors ripgrep --heading output:
 *
 *   path/to/file.ts
 *     40- context line
 *     41: matched line      ← colon = match, dash = context
 *     42- context line
 *
 *   path/to/other.ts
 *     10: matched line
 */
function serializeSearchResultForModel(output: SearchFilesOutput): string {
  const { matches, truncated, matchCount, searchedFiles } = output;

  const header =
    `Found ${matchCount} match(es) in ${searchedFiles} file(s)` +
    (truncated ? " [TRUNCATED — not all results shown]" : "");

  if (matches.length === 0) return header;

  const lines: string[] = [header];

  let lastPath = "";
  for (const m of matches) {
    if (m.path !== lastPath) {
      lines.push("", m.path);
      lastPath = m.path;
    }
    const ctxBeforeStart = m.lineNumber - m.contextBefore.length;
    for (let i = 0; i < m.contextBefore.length; i++) {
      lines.push(`  ${ctxBeforeStart + i}- ${m.contextBefore[i]}`);
    }
    lines.push(`  ${m.lineNumber}: ${m.line}`);
    for (let i = 0; i < m.contextAfter.length; i++) {
      lines.push(`  ${m.lineNumber + 1 + i}- ${m.contextAfter[i]}`);
    }
  }

  return lines.join("\n");
}

/**
 * Choose the right model-facing serialization for a tool result.
 * workspace_search gets a compact text format; everything else falls back to JSON.
 */
function serializeToolResultForModel(
  toolCallId: string,
  toolCalls: ApiToolCall[],
  result: unknown,
): string {
  const tc = toolCalls.find((t) => t.id === toolCallId);
  const toolName = tc?.function.name;

  if (
    toolName === "workspace_search" &&
    isRecord(result) &&
    result.ok === true &&
    isRecord(result.data)
  ) {
    return serializeSearchResultForModel(
      result.data as unknown as SearchFilesOutput,
    );
  }

  return JSON.stringify(result);
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return {};

  try {
    const parsed = JSON.parse(raw || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Some models (e.g. gpt-4.1 series) leak internal control tokens into the
 * streamed text when constrained/structured generation is active.
 * Strip them so they never reach the UI or API history.
 */
const SPECIAL_TOKEN_RE = /<\|[a-zA-Z0-9_\-]+\|>/g;

function sanitizeTextDelta(text: string): string {
  return text.replace(SPECIAL_TOKEN_RE, "");
}

function streamDeltaPart(
  part: unknown,
  type: "text-delta" | "reasoning-delta",
): string | null {
  if (!isRecord(part) || part.type !== type) return null;
  const raw =
    typeof part.text === "string"
      ? part.text
      : typeof part.delta === "string"
        ? part.delta
        : typeof part.textDelta === "string"
          ? part.textDelta
          : null;
  return raw === null ? null : sanitizeTextDelta(raw);
}

function streamPartError(part: unknown): unknown | null {
  if (!isRecord(part) || part.type !== "error") return null;
  if ("error" in part) return part.error;
  if ("errorText" in part) return part.errorText;
  return part;
}

function attachStreamErrors(err: unknown, streamErrors: unknown[]): unknown {
  if (streamErrors.length === 0) return err;

  const serializedStreamErrors = streamErrors.map((item) =>
    serializeError(item),
  );

  if (err instanceof Error) {
    const enhanced = err as Error & {
      streamErrors?: unknown[];
      cause?: unknown;
    };

    try {
      enhanced.streamErrors = serializedStreamErrors;
      if (enhanced.cause === undefined) {
        enhanced.cause =
          serializedStreamErrors.length === 1
            ? serializedStreamErrors[0]
            : serializedStreamErrors;
      }
    } catch {
      // If the error object is not extensible, fall back to returning it as-is.
    }
    return enhanced;
  }

  return {
    error: serializeError(err),
    streamErrors: serializedStreamErrors,
  };
}

/**
 * Serialize any thrown value into a plain object that can be JSON-stringified
 * and shown in the ErrorDetailsModal. Captures all own properties of Error
 * objects including non-enumerable ones (name, message, stack) plus HTTP-style
 * fields (status, statusText, response body) and network-error causes.
 */
export function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    const result: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    if (err.stack) result.stack = err.stack;
    // Capture all own property names (includes non-enumerable standard fields)
    for (const key of Object.getOwnPropertyNames(err)) {
      if (key in result) continue; // already set above
      try {
        result[key] = (err as unknown as Record<string, unknown>)[key];
      } catch {
        // skip unreadable properties
      }
    }
    // Recurse into cause (e.g. network TypeError wrapping a fetch failure)
    if (err.cause !== undefined) {
      result.cause = serializeError(err.cause);
    }
    return result;
  }
  if (typeof err === "object" && err !== null) {
    try {
      // Try round-trip to strip non-serialisable values
      return JSON.parse(JSON.stringify(err));
    } catch {
      return String(err);
    }
  }
  return err;
}
