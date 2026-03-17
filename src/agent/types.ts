import type { SerializedDiff } from "@/components/diffSerialization";

/* ─────────────────────────────────────────────────────────────────────────────
   Shared error / result shapes (from tools.md)
─────────────────────────────────────────────────────────────────────────── */

export type ToolErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "CONFLICT"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "RUN_ABORTED"
  | "INTERNAL";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError };

/* ─────────────────────────────────────────────────────────────────────────────
   API message formats used by the runner and persistence
───────────────────────────────────────────────────────────────────────────── */

export interface ApiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface SystemApiMessage {
  role: "system";
  content: string;
}

export interface UserApiMessage {
  role: "user";
  content: string;
  attachments?: AttachedImage[];
}

export interface AssistantApiMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ApiToolCall[];
}

export interface ToolApiMessage {
  role: "tool";
  tool_call_id: string;
  content: string; // JSON-serialised result
}

export type ApiMessage =
  | SystemApiMessage
  | UserApiMessage
  | AssistantApiMessage
  | ToolApiMessage;

/* ─────────────────────────────────────────────────────────────────────────────
   OpenAI tool definition shape (for the API request)
───────────────────────────────────────────────────────────────────────────── */

export interface OpenAIToolFunction {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Agent control state (plan + todos, from tools.md §3)
───────────────────────────────────────────────────────────────────────────── */

export interface AgentPlan {
  markdown: string;
  updatedAtMs: number;
  version: number;
}

export type TodoStatus = "todo" | "doing" | "done" | "blocked";
export type TodoOwner = "main" | string;
export type TodoNoteSource = "agent";
export type MutationIntent =
  | "exploration"
  | "implementation"
  | "refactor"
  | "fix"
  | "test"
  | "build"
  | "docs"
  | "setup"
  | "cleanup"
  | "other";
export type TodoHandlingMode = "track_active" | "skip";

export interface TodoNoteItem {
  id: string;
  text: string;
  addedTurn: number;
  author: TodoOwner;
  source: TodoNoteSource;
  verified: boolean;
}

export interface TodoMutationLogEntry {
  seq: number;
  tool: string;
  turn: number;
  actor: TodoOwner;
  paths: string[];
  mutationIntent: MutationIntent;
  toolCallId: string;
}

export interface TodoItem {
  id: string;
  title: string;
  state: TodoStatus;
  owner: TodoOwner;
  createdTurn: number;
  updatedTurn: number;
  lastTouchedTurn: number;
  filesTouched: string[];
  thingsLearned: TodoNoteItem[];
  criticalInfo: TodoNoteItem[];
  mutationLog: TodoMutationLogEntry[];
  completionNote?: string;
}

export interface TodoHandlingInput {
  mode: TodoHandlingMode;
  skipReason?: string;
  touchedPaths?: string[];
}

/* ─────────────────────────────────────────────────────────────────────────────
   Review edits — captured from workspace_applyPatch tool calls
───────────────────────────────────────────────────────────────────────────── */

export interface ReviewEdit {
  /** Workspace-relative file path */
  filePath: string;
  /** Pre-computed DiffFile data — serialized for compact storage.
   * Use deserializeDiff() to decode before passing to DiffViewer. */
  diffFile: SerializedDiff;
  /**
   * File content captured before the FIRST patch was applied.
   * Kept so that subsequent patches can recompute the diff as original→final
   * rather than appending patches together.
   */
  originalContent: string;
  /** When this edit was recorded */
  timestamp: number;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Chat display messages (UI layer)
───────────────────────────────────────────────────────────────────────────── */

export interface ToolCallDisplay {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  contextCompaction?: ToolContextCompactionDisplay;
  mcp?: {
    serverId: string;
    serverName: string;
    toolName: string;
    toolTitle?: string;
  };
  result?: unknown;
  /** Live stdout+stderr accumulated while the command is running. */
  streamingOutput?: string;
  /**
   * True when this command is on the deny list — UI shows a danger warning badge.
   * Only set when status is "awaiting_approval".
   */
  dangerous?: boolean;
  /**
   * Cached DiffFile states for UI components to render exactly what was originally proposed.
   * Captured at execution time so that it survives subsequent edits to the same file.
   * Each entry is a SerializedDiff; decode with deserializeDiff() before passing to UI components.
   */
  originalDiffFiles?: SerializedDiff[];
  status:
    | "pending"
    | "awaiting_approval"
    | "awaiting_worktree"
    | "awaiting_branch_release"
  | "awaiting_setup_action"
  | "running"
  | "done"
  | "error"
  | "denied";
}

export type ToolContextCompactionOutputMode = "always" | "on_success";

export interface ToolContextCompactionRequest {
  inputNote?: string;
  outputNote?: string;
  outputMode?: ToolContextCompactionOutputMode;
}

export interface ToolContextCompactionSideDisplay {
  status: "full" | "compacted";
  note?: string;
  reason?: string;
  mode?: ToolContextCompactionOutputMode;
  modelValue?: unknown;
}

export interface ToolContextCompactionDisplay {
  request: ToolContextCompactionRequest;
  input?: ToolContextCompactionSideDisplay;
  output?: ToolContextCompactionSideDisplay;
  warnings?: string[];
}

export type ConversationCardKind = "summary" | "artifact";

interface BaseConversationCard {
  id: string;
  kind: ConversationCardKind;
  title?: string;
}

export interface SummaryConversationCard extends BaseConversationCard {
  kind: "summary";
  markdown: string;
}

export interface ArtifactConversationCard extends BaseConversationCard {
  kind: "artifact";
  artifactId: string;
  version?: number;
}

export type ConversationCard =
  | SummaryConversationCard
  | ArtifactConversationCard;

export const ARTIFACT_CARD_PARENT_INSTRUCTION =
  "Read the artifact directly to get the content." as const;

export interface SerializedSummaryConversationCard {
  kind: "summary";
  title?: string;
  markdown: string;
}

export interface SerializedArtifactConversationCard {
  kind: "artifact";
  title?: string;
  artifactId: string;
  version?: number;
  instruction: typeof ARTIFACT_CARD_PARENT_INSTRUCTION;
}

export type SerializedConversationCard =
  | SerializedSummaryConversationCard
  | SerializedArtifactConversationCard;

export interface AttachedImage {
  id: string;
  name: string;
  previewUrl: string;
  mimeType: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: AttachedImage[];
  /** Structured log trace for this assistant message, when it belongs to a run. */
  traceId?: string;
  /**
   * Display name of the agent that produced this message.
   * Undefined / omitted means the main Rakh agent.
   * Subagent messages carry the subagent's name (e.g. "Planner").
   */
  agentName?: string;
  /** Stable assistant bubble thread key for interleaved assistant messages. */
  bubbleGroupId?: string;
  /** Optional streamed reasoning content for this assistant turn. */
  reasoning?: string;
  /** True while reasoning tokens are still streaming for this assistant turn. */
  reasoningStreaming?: boolean;
  /** Timestamp when reasoning started for this assistant turn. */
  reasoningStartedAtMs?: number;
  /** Final elapsed reasoning duration for this assistant turn. */
  reasoningDurationMs?: number;
  timestamp: number;
  streaming?: boolean;
  /** e.g. "CALLING TOOL" */
  badge?: string;
  toolCalls?: ToolCallDisplay[];
  cards?: ConversationCard[];
}

export interface QueuedUserMessage {
  id: string;
  content: string;
  createdAtMs: number;
}

export type LlmUsageActorKind = "main" | "subagent" | "internal";

export interface LlmUsageRecord {
  id: string;
  timestamp: number;
  modelId: string;
  actorKind: LlmUsageActorKind;
  actorId: string;
  actorLabel: string;
  operation: string;
  inputTokens: number;
  noCacheInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Advanced model / provider options (set at session creation time)
─────────────────────────────────────────────────────────────────────────── */

export type ReasoningVisibility = "off" | "auto" | "detailed";
export type ReasoningEffort = "low" | "medium" | "high";
export type LatencyCostProfile = "balanced" | "fast" | "cheap";

export interface AdvancedModelOptions {
  /** Controls whether reasoning summaries are included in the response. */
  reasoningVisibility: ReasoningVisibility;
  /** Controls how much reasoning effort the model expends. */
  reasoningEffort: ReasoningEffort;
  /** Balances latency vs cost for the request. */
  latencyCostProfile: LatencyCostProfile;
}

export const DEFAULT_ADVANCED_OPTIONS: AdvancedModelOptions = {
  reasoningVisibility: "auto",
  reasoningEffort: "medium",
  latencyCostProfile: "balanced",
};

/* ─────────────────────────────────────────────────────────────────────────────
   Per-agent configuration (each tab has its own)
─────────────────────────────────────────────────────────────────────────── */

export type CommunicationProfileId = "pragmatic" | "friendly" | "kevin" | string;
export interface AgentConfig {
  /** Absolute path to the workspace root */
  cwd: string;
  model: string;
  /** Context window size in tokens, as reported by model catalog for the selected model */
  contextLength?: number;
  /** Absolute path to the originally selected project root */
  projectPath?: string;
  /** Optional project-scoped setup command run after worktree creation */
  setupCommand?: string;
  /** Absolute path to the git worktree created for this session (set once, never changed) */
  worktreePath?: string;
  /** Git branch name for the worktree */
  worktreeBranch?: string;
  /** True when the user declined worktree creation — prevents asking again */
  worktreeDeclined?: boolean;
  /** Provider-level advanced options chosen at session creation time. */
  advancedOptions?: AdvancedModelOptions;
  /** Concrete communication profile id inherited when the session is created. */
  communicationProfile?: string;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Full per-tab agent state stored in Jotai
───────────────────────────────────────────────────────────────────────────── */

export type AgentStatus = "idle" | "thinking" | "working" | "done" | "error";
export type AutoApproveCommandsMode = "no" | "agent" | "yes";
export type AgentQueueState = "idle" | "draining" | "paused";
export type AgentErrorAction = {
  type: "open-settings-section";
  section: "providers";
  label: string;
};

export interface AgentState {
  status: AgentStatus;
  config: AgentConfig;
  /** Monotonic top-level user turn counter for this session. */
  turnCount: number;
  /** Messages shown in the chat pane */
  chatMessages: ChatMessage[];
  /** Full message history sent to the model API */
  apiMessages: ApiMessage[];
  /** Text being streamed in the current assistant turn */
  streamingContent: string | null;
  plan: AgentPlan;
  todos: TodoItem[];
  error: string | null;
  /**
   * Raw error details (not persisted) — populated when an API/runner error
   * occurs, so the UI can surface a "Details" modal with the full error object,
   * status code, stack trace, network info, etc.
   */
  errorDetails: unknown;
  /** Optional actionable follow-up for config-related or recoverable errors. */
  errorAction: AgentErrorAction | null;
  /** Short title describing the agent's current task (set by the agent) */
  tabTitle: string;
  /**
   * File edits captured from successful workspace_applyPatch calls.
   * Multiple patches to the same file are merged into a single entry.
   */
  reviewEdits: ReviewEdit[];
  /** Auto-approve edits for this tab */
  autoApproveEdits: boolean;
  /** Auto-approve commands for this tab */
  autoApproveCommands: AutoApproveCommandsMode;
  /** Null follows the global grouped inline tools preference. */
  groupInlineToolCallsOverride: boolean | null;
  /** Follow-up user notes queued while the agent is busy. */
  queuedMessages: QueuedUserMessage[];
  /** Whether queued follow-ups will auto-drain, stay paused, or are empty. */
  queueState: AgentQueueState;
  /** Raw per-call LLM token usage for session-level accounting and pricing. */
  llmUsageLedger: LlmUsageRecord[];
  /** Controls debug-only UI surfaces for this tab */
  showDebug?: boolean;
  /** Latest known run trace for this tab. Not persisted across restarts. */
  lastRunTraceId?: string;
}
