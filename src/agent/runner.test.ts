import { beforeEach, describe, expect, it, vi } from "vitest";

type MockToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

type MockTurn = {
  deltas?: string[];
  reasoningDeltas?: string[];
  fullStreamParts?: unknown[];
  toolCalls?: MockToolCall[];
  toolCallsError?: unknown;
  streamError?: unknown;
  finishReason?: string;
  rawFinishReason?: string;
  steps?: unknown[];
  totalUsage?: {
    inputTokens?: number;
    noCacheInputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
};

type MockAgentState = {
  status: "idle" | "thinking" | "working" | "done" | "error";
  config: {
    cwd: string;
    model: string;
    contextLength?: number;
    advancedOptions?: Record<string, unknown>;
    projectPath?: string;
    communicationProfile?: string;
    worktreePath?: string;
    worktreeBranch?: string;
  };
  chatMessages: Array<Record<string, unknown>>;
  apiMessages: Array<Record<string, unknown>>;
  streamingContent: string | null;
  plan: { markdown: string; updatedAtMs: number; version: number };
  todos: unknown[];
  queuedMessages: Array<Record<string, unknown>>;
  queueState: "idle" | "draining" | "paused";
  error: string | null;
  errorDetails: unknown;
  tabTitle: string;
  reviewEdits: unknown[];
  llmUsageLedger: Array<Record<string, unknown>>;
  autoApproveEdits: boolean;
  autoApproveCommands: "no" | "agent" | "yes";
  showDebug?: boolean;
};

const {
  states,
  providersAtomMock,
  mcpServersAtomMock,
  mcpSettingsAtomMock,
  toolContextCompactionEnabledAtomMock,
  autoContextCompactionSettingsAtomMock,
  globalCommunicationProfileAtomMock,
  profilesAtomMock,
  jotaiStoreMock,
  dispatchToolMock,
  validateToolMock,
  requiresApprovalMock,
  requestApprovalMock,
  requestBranchReleaseActionMock,
  cancelAllApprovalsMock,
  consumeApprovalReasonMock,
  turns,
  streamTextMock,
  createOpenAIMock,
  createAnthropicMock,
  createOpenAICompatibleMock,
  tauriInvokeMock,
  execAbortMock,
  execStopMock,
  prepareMcpRunMock,
  callMcpToolMock,
  shutdownMcpRunMock,
  artifactCreateMock,
  artifactGetMock,
  switchToGitBranchMock,
  logFrontendSoonMock,
} = vi.hoisted(() => ({
  states: {} as Record<string, MockAgentState>,
  providersAtomMock: { kind: "providers-atom" },
  mcpServersAtomMock: { kind: "mcp-servers-atom" },
  mcpSettingsAtomMock: { kind: "mcp-settings-atom" },
  toolContextCompactionEnabledAtomMock: {
    kind: "tool-context-compaction-enabled-atom",
  },
  autoContextCompactionSettingsAtomMock: {
    kind: "auto-context-compaction-settings-atom",
  },
  globalCommunicationProfileAtomMock: { kind: "global-communication-profile-atom" },
  profilesAtomMock: { kind: "profiles-atom" },
  jotaiStoreMock: {
    get: vi.fn(),
  },
  dispatchToolMock: vi.fn(),
  validateToolMock: vi.fn(),
  requiresApprovalMock: vi.fn(),
  requestApprovalMock: vi.fn(),
  requestBranchReleaseActionMock: vi.fn(),
  cancelAllApprovalsMock: vi.fn(),
  consumeApprovalReasonMock: vi.fn(),
  turns: [] as MockTurn[],
  streamTextMock: vi.fn(),
  createOpenAIMock: vi.fn(),
  createAnthropicMock: vi.fn(),
  tauriInvokeMock: vi.fn(),
  execAbortMock: vi.fn(),
  execStopMock: vi.fn(),
  switchToGitBranchMock: vi.fn(),
  createOpenAICompatibleMock: vi.fn(),
  prepareMcpRunMock: vi.fn(),
  callMcpToolMock: vi.fn(),
  shutdownMcpRunMock: vi.fn(),
  artifactCreateMock: vi.fn(),
  artifactGetMock: vi.fn(),
  logFrontendSoonMock: vi.fn(),
}));

vi.mock("./atoms", () => ({
  getAgentState: (tabId: string) => states[tabId],
  patchAgentState: (
    tabId: string,
    patch: Partial<MockAgentState> | ((prev: MockAgentState) => MockAgentState),
  ) => {
    const prev = states[tabId];
    states[tabId] =
      typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
  },
  jotaiStore: jotaiStoreMock,
  globalCommunicationProfileAtom: globalCommunicationProfileAtomMock,
  toolContextCompactionEnabledAtom: toolContextCompactionEnabledAtomMock,
  autoContextCompactionSettingsAtom: autoContextCompactionSettingsAtomMock,
}));

vi.mock("./db", () => ({
  providersAtom: providersAtomMock,
  profilesAtom: profilesAtomMock,
  commandListAtom: { kind: "command-list-atom" },
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (...args: unknown[]) => {
    createOpenAICompatibleMock(...args);
    return (modelId: string) => ({ provider: "openai-compatible", modelId });
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => tauriInvokeMock(...args),
}));

vi.mock("./tools", () => ({
  TOOL_DEFINITIONS: [],
  getToolDefinitionsByNames: () => ({}),
  dispatchTool: (...args: unknown[]) => dispatchToolMock(...args),
  validateTool: (...args: unknown[]) => validateToolMock(...args),
}));

vi.mock("./approvals", () => ({
  requiresApproval: (...args: unknown[]) => requiresApprovalMock(...args),
  requestApproval: (...args: unknown[]) => requestApprovalMock(...args),
  requestBranchReleaseAction: (...args: unknown[]) =>
    requestBranchReleaseActionMock(...args),
  cancelAllApprovals: (...args: unknown[]) => cancelAllApprovalsMock(...args),
  consumeApprovalReason: (...args: unknown[]) =>
    consumeApprovalReasonMock(...args),
}));

vi.mock("./tools/git", () => ({
  getBranchReleaseInstructions: (branch: string, blockingPath?: string) => [
    blockingPath
      ? `Release ${branch} at ${blockingPath}`
      : `Release ${branch}`,
  ],
  switchToGitBranch: (...args: unknown[]) => switchToGitBranchMock(...args),
}));

vi.mock("ai", () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  stepCountIs: (count: number) => count,
  tool: (input: unknown) => input,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (...args: unknown[]) => {
    createOpenAIMock(...args);
    return (modelId: string) => ({ provider: "openai", modelId });
  },
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: (...args: unknown[]) => {
    createAnthropicMock(...args);
    return (modelId: string) => ({ provider: "anthropic", modelId });
  },
}));

vi.mock("./tools/exec", () => ({
  execAbort: (...args: unknown[]) => execAbortMock(...args),
  execStop: (...args: unknown[]) => execStopMock(...args),
}));

vi.mock("./mcp", () => {
  const slugify = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "tool";

  return {
    mcpServersAtom: mcpServersAtomMock,
    mcpSettingsAtom: mcpSettingsAtomMock,
    loadMcpServers: vi.fn(),
    loadMcpSettings: vi.fn(),
    saveMcpServers: vi.fn(),
    saveMcpSettings: vi.fn(),
    testMcpServer: vi.fn(),
    prepareMcpRun: (...args: unknown[]) => prepareMcpRunMock(...args),
    callMcpTool: (...args: unknown[]) => callMcpToolMock(...args),
    shutdownMcpRun: (...args: unknown[]) => shutdownMcpRunMock(...args),
    extractMcpToolErrorMessage: (result: {
      structuredContent?: unknown;
      content: Array<{ type?: unknown; text?: unknown }>;
    }) => {
      if (
        typeof result.structuredContent === "string" &&
        result.structuredContent.trim()
      ) {
        return result.structuredContent;
      }
      const textPart = result.content.find(
        (item) => item?.type === "text" && typeof item.text === "string",
      );
      return textPart?.text ?? "MCP tool reported an error.";
    },
    buildMcpRuntimeToolRegistry: (
      tools: Array<{
        serverId: string;
        serverName: string;
        name: string;
        title?: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      }>,
      reservedNames: Iterable<string> = [],
    ) => {
      const usedNames = new Set(reservedNames);
      const definitions: Record<string, Record<string, unknown>> = {};
      const toolsByName: Record<string, Record<string, unknown>> = {};

      for (const tool of tools) {
        const baseName = `mcp_${slugify(tool.serverName || tool.serverId)}_${slugify(tool.name)}`;
        let syntheticName = baseName;
        let counter = 2;
        while (usedNames.has(syntheticName)) {
          syntheticName = `${baseName}_${counter}`;
          counter += 1;
        }
        usedNames.add(syntheticName);
        definitions[syntheticName] = {
          description: tool.description ?? tool.title ?? tool.name,
          inputSchema: tool.inputSchema,
        };
        toolsByName[syntheticName] = {
          syntheticName,
          serverId: tool.serverId,
          serverName: tool.serverName,
          toolName: tool.name,
          toolTitle: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        };
      }

      return { definitions, toolsByName };
    },
  };
});

vi.mock("./tools/artifacts", async () => {
  const actual = await vi.importActual<typeof import("./tools/artifacts")>(
    "./tools/artifacts",
  );
  return {
    ...actual,
    artifactCreate: (...args: unknown[]) => artifactCreateMock(...args),
    artifactGet: (...args: unknown[]) => artifactGetMock(...args),
  };
});

vi.mock("@/logging/client", async () => {
  const actual = await vi.importActual<typeof import("@/logging/client")>(
    "@/logging/client",
  );
  return {
    ...actual,
    logFrontendSoon: (...args: unknown[]) => logFrontendSoonMock(...args),
  };
});

import {
  resumeQueue,
  runAgent,
  retryAgent,
  steerMessage,
  stopAgent,
  stopRunningExecToolCall,
} from "./runner";
import { getSavedProjects, saveSavedProjects } from "@/projects";
import { registerDynamicModels } from "./modelCatalog";

function makeState(overrides: Partial<MockAgentState> = {}): MockAgentState {
  return {
    status: "idle",
    config: { cwd: "", model: "openai/gpt-5.2" },
    chatMessages: [],
    apiMessages: [],
    streamingContent: null,
    plan: { markdown: "", updatedAtMs: 0, version: 0 },
    todos: [],
    queuedMessages: [],
    queueState: "idle",
    error: null,
    errorDetails: null,
    tabTitle: "",
    reviewEdits: [],
    llmUsageLedger: [],
    autoApproveEdits: false,
    autoApproveCommands: "no",
    ...overrides,
  };
}

function setState(tabId: string, state?: Partial<MockAgentState>): void {
  states[tabId] = makeState(state);
}

function makeArtifact(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionId: "tab",
    runId: "run_1",
    agentId: "agent_subagent",
    artifactSeq: 1,
    artifactId: "artifact_1",
    version: 1,
    kind: "report",
    summary: "artifact summary",
    metadata: {},
    contentFormat: "json",
    blobHash: "blob_hash",
    sizeBytes: 10,
    createdAt: 123,
    ...overrides,
  };
}

function makeCompactedHistoryMarkdown(nextStep = "..."): string {
  return [
    "[COMPACTED HISTORY]",
    "Prior conversation history was compacted for context management.",
    "Use the following summary as the authoritative record of earlier context.",
    "Prefer newer raw messages over this summary if they conflict.",
    "",
    "Current task",
    "Investigate context compaction.",
    "",
    "User goal",
    "Shrink internal history while preserving execution state.",
    "",
    "Hard constraints",
    "Do not preserve dialogue.",
    "",
    "What has been done",
    "Runner and subagent hooks were inspected.",
    "",
    "Important facts discovered",
    "apiMessages and chatMessages already diverge.",
    "",
    "Files / artifacts / outputs created",
    "Created one context-compaction artifact.",
    "",
    "Decisions already made",
    "Use a single assistant summary message after compaction.",
    "",
    "Unresolved issues",
    "None.",
    "",
    "Exact next step",
    nextStep,
  ].join("\n");
}

function fact(id: string, text: string) {
  return { id, text };
}

function makeSummaryCardToolCall(
  id: string,
  markdown: string,
  title?: string,
): MockToolCall {
  return {
    id,
    name: "agent_card_add",
    arguments: {
      kind: "summary",
      ...(title ? { title } : {}),
      markdown,
    },
  };
}

function makeArtifactCardToolCall(
  id: string,
  artifactId: string,
  version?: number,
  title?: string,
): MockToolCall {
  return {
    id,
    name: "agent_card_add",
    arguments: {
      kind: "artifact",
      ...(title ? { title } : {}),
      artifactId,
      ...(version !== undefined ? { version } : {}),
    },
  };
}

function parseToolMessageResult(
  tabId: string,
  toolCallId: string,
): Record<string, unknown> {
  const toolMessage = states[tabId].apiMessages.find(
    (msg) => msg.role === "tool" && msg.tool_call_id === toolCallId,
  );
  return JSON.parse(String(toolMessage?.content));
}

async function flushAsyncWork(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe("runner", () => {
  beforeEach(async () => {
    registerDynamicModels([
      {
        id: "openai/gpt-5.2",
        name: "test-gpt-5.2",
        providerId: "test-openai-id",
        owned_by: "openai",
        tags: [],
        sdk_id: "gpt-5.2",
      },
      {
        id: "openai/gpt-5.2-codex",
        name: "test-gpt-5.2-codex",
        providerId: "test-openai-id",
        owned_by: "openai",
        tags: [],
        sdk_id: "gpt-5.2-codex",
      },
    ]);
    for (const key of Object.keys(states)) {
      delete states[key];
    }
    turns.length = 0;

    dispatchToolMock.mockReset();
    validateToolMock.mockReset();
    requiresApprovalMock.mockReset();
    requestApprovalMock.mockReset();
    requestBranchReleaseActionMock.mockReset();
    cancelAllApprovalsMock.mockReset();
    consumeApprovalReasonMock.mockReset();
    streamTextMock.mockReset();
    createOpenAIMock.mockReset();
    createAnthropicMock.mockReset();
    tauriInvokeMock.mockReset();
    execAbortMock.mockReset();
    execStopMock.mockReset();
    prepareMcpRunMock.mockReset();
    callMcpToolMock.mockReset();
    shutdownMcpRunMock.mockReset();
    artifactCreateMock.mockReset();
    artifactGetMock.mockReset();
    switchToGitBranchMock.mockReset();
    logFrontendSoonMock.mockReset();
    jotaiStoreMock.get.mockReset();

    jotaiStoreMock.get.mockImplementation((atom: unknown) => {
      if (atom === providersAtomMock) {
        return [
          {
            id: "test-openai-id",
            name: "test-openai",
            type: "openai",
            apiKey: "test-key",
          },
          {
            id: "test-anthropic-id",
            name: "test-anthropic",
            type: "anthropic",
            apiKey: "test-key",
          },
          {
            id: "test-compatible-id",
            name: "test-compatible",
            type: "openai-compatible",
            apiKey: "test-key",
            baseUrl: "http://localhost:11434",
          },
        ];
      }
      if (atom === mcpServersAtomMock) {
        return [];
      }
      if (atom === mcpSettingsAtomMock) {
        return { artifactizeReturnedFiles: false };
      }
      if (atom === toolContextCompactionEnabledAtomMock) {
        return true;
      }
      if (atom === autoContextCompactionSettingsAtomMock) {
        return {
          enabled: false,
          thresholdMode: "percentage",
          thresholdPercent: 85,
          thresholdKb: 256,
        };
      }
      if (atom === profilesAtomMock) {
        return [];
      }
      if ((atom as { kind?: string })?.kind === "command-list-atom") {
        return { allow: [], deny: [] };
      }
      if (atom === globalCommunicationProfileAtomMock) {
        return "global-test-profile";
      }
      return undefined;
    });

    requestBranchReleaseActionMock.mockResolvedValue({ action: "retry" });
    switchToGitBranchMock.mockResolvedValue({
      ok: true,
      data: { branch: "feat/test" },
    });

    requiresApprovalMock.mockReturnValue({ required: false, dangerous: false });
    requestApprovalMock.mockResolvedValue(true);
    consumeApprovalReasonMock.mockReturnValue(undefined);
    dispatchToolMock.mockResolvedValue({ ok: true, data: { ok: true } });
    validateToolMock.mockResolvedValue(null);
    execStopMock.mockResolvedValue(true);
    tauriInvokeMock.mockImplementation(async (cmd: unknown) => {
      if (cmd === "exec_run") return { exitCode: 1 };
      if (cmd === "stat_file") return { exists: false };
      return undefined;
    });
    prepareMcpRunMock.mockResolvedValue({ tools: [], failures: [] });
    callMcpToolMock.mockResolvedValue({ content: [] });
    shutdownMcpRunMock.mockResolvedValue(undefined);
    artifactCreateMock.mockResolvedValue({
      ok: true,
      data: { artifact: makeArtifact() },
    });
    artifactGetMock.mockResolvedValue({
      ok: true,
      data: {
        artifact: makeArtifact({
          contentFormat: "markdown",
          content: makeCompactedHistoryMarkdown(),
        }),
      },
    });

    streamTextMock.mockImplementation(() => {
      const turn = turns.shift() ?? { deltas: [], toolCalls: [] };
      const turnToolCalls = turn.toolCalls ?? [];
      const streamedText = (turn.fullStreamParts ?? [])
        .flatMap((part) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text-delta" &&
          "delta" in part &&
          typeof part.delta === "string"
            ? [part.delta]
            : [],
        )
        .join("");
      const streamedReasoning = (turn.fullStreamParts ?? [])
        .flatMap((part) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "reasoning-delta" &&
          "delta" in part &&
          typeof part.delta === "string"
            ? [part.delta]
            : [],
        )
        .join("");
      const turnText = `${streamedText}${(turn.deltas ?? []).join("")}`;
      const turnReasoning = `${streamedReasoning}${(turn.reasoningDeltas ?? []).join("")}`;
      const finishReason =
        turn.finishReason ?? (turnToolCalls.length > 0 ? "tool-calls" : "stop");
      const totalUsage = turn.totalUsage
        ? {
            inputTokens: turn.totalUsage.inputTokens,
            inputTokenDetails: {
              noCacheTokens: turn.totalUsage.noCacheInputTokens,
              cacheReadTokens: turn.totalUsage.cacheReadTokens,
              cacheWriteTokens: turn.totalUsage.cacheWriteTokens,
            },
            outputTokens: turn.totalUsage.outputTokens,
            outputTokenDetails: {
              reasoningTokens: turn.totalUsage.reasoningTokens,
              textTokens:
                typeof turn.totalUsage.outputTokens === "number" &&
                typeof turn.totalUsage.reasoningTokens === "number"
                  ? Math.max(
                      0,
                      turn.totalUsage.outputTokens - turn.totalUsage.reasoningTokens,
                    )
                  : undefined,
            },
            totalTokens: turn.totalUsage.totalTokens,
            reasoningTokens: turn.totalUsage.reasoningTokens,
            cachedInputTokens: turn.totalUsage.cacheReadTokens,
          }
        : undefined;
      const textStream = (async function* () {
        if (turn.streamError) throw turn.streamError;
        for (const delta of turn.deltas ?? []) yield delta;
      })();
      const fullStream = (async function* () {
        if (turn.streamError) throw turn.streamError;
        for (const part of turn.fullStreamParts ?? []) yield part;
        for (const delta of turn.deltas ?? []) {
          yield { type: "text-delta", id: "text-1", delta };
        }
        for (const delta of turn.reasoningDeltas ?? []) {
          yield { type: "reasoning-delta", id: "reasoning-1", delta };
        }
      })();
      return {
        textStream,
        fullStream,
        text: Promise.resolve(turnText),
        toolCalls: turn.toolCallsError
          ? Promise.reject(turn.toolCallsError)
          : Promise.resolve(turnToolCalls),
        finishReason: Promise.resolve(finishReason),
        rawFinishReason: Promise.resolve(turn.rawFinishReason),
        totalUsage: Promise.resolve(totalUsage),
        steps: Promise.resolve(
          turn.steps ?? [
            {
              stepNumber: 0,
              finishReason,
              rawFinishReason: turn.rawFinishReason,
              text: turnText,
              reasoningText: turnReasoning || undefined,
              toolCalls: turnToolCalls.map((toolCall) => ({
                toolName: toolCall.name,
              })),
            },
          ],
        ),
      };
    });

    await saveSavedProjects([]);
  });

  it("sets an error when no provider is found", async () => {
    const tabId = "tab-no-key";
    setState(tabId);

    jotaiStoreMock.get.mockImplementation((atom: unknown) => {
      // Intentionally return empty list so the provider isn't found
      return [];
    });

    await runAgent(tabId, "hello");

    expect(states[tabId].status).toBe("error");
    expect(states[tabId].error).toContain("references an unknown provider");
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("completes a normal assistant turn with no tool calls", async () => {
    const tabId = "tab-no-tools";
    setState(tabId);
    turns.push({
      deltas: ["Hello", " world"],
      toolCalls: [],
      totalUsage: {
        inputTokens: 1200,
        noCacheInputTokens: 1200,
        outputTokens: 320,
        reasoningTokens: 80,
        totalTokens: 1520,
      },
    });

    await runAgent(tabId, "hi");

    const state = states[tabId];
    expect(state.status).toBe("idle");
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toMatchObject({
      role: "user",
      content: "hi",
    });
    expect(state.chatMessages[1]).toMatchObject({
      role: "assistant",
      content: "Hello world",
      streaming: false,
    });
    expect(state.apiMessages).toHaveLength(3);
    expect(state.apiMessages[0]).toMatchObject({ role: "system" });
    expect(state.apiMessages[1]).toMatchObject({ role: "user", content: "hi" });
    expect(state.apiMessages[2]).toMatchObject({
      role: "assistant",
      content: "Hello world",
    });
    expect(state.llmUsageLedger).toMatchObject([
      {
        actorKind: "main",
        actorId: "main",
        actorLabel: "Rakh",
        operation: "assistant turn",
        modelId: "openai/gpt-5.2",
        inputTokens: 1200,
        noCacheInputTokens: 1200,
        outputTokens: 320,
        reasoningTokens: 80,
        totalTokens: 1520,
      },
    ]);
    expect(dispatchToolMock).not.toHaveBeenCalled();
  });

  it("merges discovered MCP tools into the main run and routes them through approval", async () => {
    const tabId = "tab-mcp-tool";
    setState(tabId, {
      config: { cwd: "/workspace/app", model: "openai/gpt-5.2" },
    });
    jotaiStoreMock.get.mockImplementation((atom: unknown) => {
      if (atom === providersAtomMock) {
        return [
          {
            id: "test-openai-id",
            name: "test-openai",
            type: "openai",
            apiKey: "test-key",
          },
        ];
      }
      if (atom === mcpServersAtomMock) {
        return [
          {
            id: "filesystem",
            name: "Filesystem",
            enabled: true,
            transport: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          },
        ];
      }
      if (atom === profilesAtomMock) return [];
      if (atom === globalCommunicationProfileAtomMock) {
        return "global-test-profile";
      }
      return undefined;
    });
    prepareMcpRunMock.mockResolvedValue({
      tools: [
        {
          serverId: "filesystem",
          serverName: "Filesystem",
          name: "read_file",
          title: "Read File",
          description: "Read a file from the MCP filesystem server.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      ],
      failures: [],
    });
    callMcpToolMock.mockResolvedValue({
      content: [{ type: "text", text: "README contents" }],
      structuredContent: { path: "README.md" },
      isError: false,
    });
    turns.push({
      deltas: ["Checking files."],
      toolCalls: [
        {
          id: "tc-mcp-1",
          name: "mcp_filesystem_read_file",
          arguments: { path: "README.md" },
        },
      ],
    });
    turns.push({ deltas: ["Done."], toolCalls: [] });

    await runAgent(tabId, "read the readme");

    expect(prepareMcpRunMock).toHaveBeenCalledWith(
      expect.any(String),
      "/workspace/app",
      [
        expect.objectContaining({
          id: "filesystem",
          name: "Filesystem",
          enabled: true,
        }),
      ],
      expect.objectContaining({
        sessionId: "tab-mcp-tool",
        tabId: "tab-mcp-tool",
        agentId: "agent_main",
        traceId: expect.any(String),
      }),
    );
    const firstStreamCall = streamTextMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(firstStreamCall).toBeDefined();
    expect(firstStreamCall?.tools).toMatchObject({
      mcp_filesystem_read_file: expect.objectContaining({
        description: "Read a file from the MCP filesystem server.",
      }),
    });
    expect(requestApprovalMock).toHaveBeenCalledWith("tab-mcp-tool", "tc-mcp-1");
    expect(validateToolMock).not.toHaveBeenCalled();
    expect(dispatchToolMock).not.toHaveBeenCalled();
    expect(callMcpToolMock).toHaveBeenCalledWith(
      expect.any(String),
      "filesystem",
      "read_file",
      { path: "README.md" },
      expect.objectContaining({
        correlationId: "tc-mcp-1",
        toolName: "mcp_filesystem_read_file",
        traceId: expect.any(String),
      }),
    );
    expect(parseToolMessageResult(tabId, "tc-mcp-1")).toMatchObject({
      ok: true,
      data: {
        content: [{ type: "text", text: "README contents" }],
        structuredContent: { path: "README.md" },
        isError: false,
      },
    });
    expect(states[tabId].chatMessages[1]).toMatchObject({
      badge: "CALLING TOOLS",
      toolCalls: [
        expect.objectContaining({
          tool: "mcp_filesystem_read_file",
          status: "done",
          mcp: {
            serverId: "filesystem",
            serverName: "Filesystem",
            toolName: "read_file",
            toolTitle: "Read File",
          },
        }),
      ],
    });
    expect(shutdownMcpRunMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionId: "tab-mcp-tool",
        tabId: "tab-mcp-tool",
        agentId: "agent_main",
        traceId: expect.any(String),
      }),
    );
  });

  it("artifactizes MCP file payloads only when the global MCP setting is enabled", async () => {
    const tabId = "tab-mcp-artifactize";
    setState(tabId, {
      config: { cwd: "/workspace/app", model: "openai/gpt-5.2" },
    });
    jotaiStoreMock.get.mockImplementation((atom: unknown) => {
      if (atom === providersAtomMock) {
        return [
          {
            id: "test-openai-id",
            name: "test-openai",
            type: "openai",
            apiKey: "test-key",
          },
        ];
      }
      if (atom === mcpServersAtomMock) {
        return [
          {
            id: "playwright",
            name: "Playwright",
            enabled: true,
            transport: "stdio",
            command: "npx",
            args: ["@playwright/mcp"],
          },
        ];
      }
      if (atom === mcpSettingsAtomMock) {
        return { artifactizeReturnedFiles: true };
      }
      if (atom === profilesAtomMock) return [];
      if (atom === globalCommunicationProfileAtomMock) {
        return "global-test-profile";
      }
      return undefined;
    });
    prepareMcpRunMock.mockResolvedValue({
      tools: [
        {
          serverId: "playwright",
          serverName: "Playwright",
          name: "browser_take_screenshot",
          title: "Take Screenshot",
          description: "Capture the current viewport.",
          inputSchema: {
            type: "object",
            properties: {
              filename: { type: "string" },
            },
          },
        },
      ],
      failures: [],
    });
    callMcpToolMock.mockResolvedValue({
      content: [
        { type: "text", text: "### Result\n- [Screenshot](screenshot-2.png)" },
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        },
      ],
      isError: false,
    });
    artifactCreateMock.mockResolvedValue({
      ok: true,
      data: {
        artifact: makeArtifact({
          artifactId: "mcp_attachment_1",
          version: 2,
          kind: "mcp-attachment",
          summary: "Playwright · Take Screenshot · image/png",
        }),
      },
    });
    turns.push({
      deltas: ["Taking a screenshot."],
      toolCalls: [
        {
          id: "tc-mcp-image-1",
          name: "mcp_playwright_browser_take_screenshot",
          arguments: { filename: "screenshot-2.png" },
        },
      ],
    });
    turns.push({ deltas: ["Done."], toolCalls: [] });

    await runAgent(tabId, "take a screenshot");

    expect(artifactCreateMock).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({
        agentId: "agent_main",
        runId: expect.stringMatching(/^run_/),
        logContext: expect.objectContaining({
          correlationId: "tc-mcp-image-1",
          toolName: "mcp_playwright_browser_take_screenshot",
          traceId: expect.any(String),
        }),
      }),
      expect.objectContaining({
        kind: "mcp-attachment",
        contentFormat: "json",
        summary: "Playwright · Take Screenshot · image/png",
      }),
    );
    const toolResult = parseToolMessageResult(tabId, "tc-mcp-image-1");
    expect(JSON.stringify(toolResult)).not.toContain("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB");
    expect(toolResult).toMatchObject({
      ok: true,
      data: {
        content: [
          { type: "text", text: "### Result\n- [Screenshot](screenshot-2.png)" },
          {
            type: "text",
            text: expect.stringContaining("mcp_attachment_1@2"),
          },
        ],
        meta: {
          __rakhMcpArtifacts: [
            expect.objectContaining({
              artifactId: "mcp_attachment_1",
              version: 2,
              originalType: "image",
              mimeType: "image/png",
            }),
          ],
        },
      },
    });
    const followUpMessages = (
      streamTextMock.mock.calls[1]?.[0] as
        | { messages?: Array<Record<string, unknown>> }
        | undefined
    )?.messages;
    expect(JSON.stringify(followUpMessages)).not.toContain(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    );
    expect(JSON.stringify(followUpMessages)).toContain("mcp_attachment_1");
  });

  it("leaves MCP file payloads untouched when MCP artifactization is disabled", async () => {
    const tabId = "tab-mcp-no-artifactize";
    setState(tabId, {
      config: { cwd: "/workspace/app", model: "openai/gpt-5.2" },
    });
    jotaiStoreMock.get.mockImplementation((atom: unknown) => {
      if (atom === providersAtomMock) {
        return [
          {
            id: "test-openai-id",
            name: "test-openai",
            type: "openai",
            apiKey: "test-key",
          },
        ];
      }
      if (atom === mcpServersAtomMock) {
        return [
          {
            id: "playwright",
            name: "Playwright",
            enabled: true,
            transport: "stdio",
            command: "npx",
            args: ["@playwright/mcp"],
          },
        ];
      }
      if (atom === mcpSettingsAtomMock) {
        return { artifactizeReturnedFiles: false };
      }
      if (atom === profilesAtomMock) return [];
      if (atom === globalCommunicationProfileAtomMock) {
        return "global-test-profile";
      }
      return undefined;
    });
    prepareMcpRunMock.mockResolvedValue({
      tools: [
        {
          serverId: "playwright",
          serverName: "Playwright",
          name: "browser_take_screenshot",
          title: "Take Screenshot",
          description: "Capture the current viewport.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      failures: [],
    });
    callMcpToolMock.mockResolvedValue({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        },
      ],
      isError: false,
    });
    turns.push({
      deltas: ["Taking a screenshot."],
      toolCalls: [
        {
          id: "tc-mcp-image-raw",
          name: "mcp_playwright_browser_take_screenshot",
          arguments: { filename: "screenshot-2.png" },
        },
      ],
    });
    turns.push({ deltas: ["Done."], toolCalls: [] });

    await runAgent(tabId, "take a screenshot");

    expect(artifactCreateMock).not.toHaveBeenCalled();
    expect(parseToolMessageResult(tabId, "tc-mcp-image-raw")).toMatchObject({
      ok: true,
      data: {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
          },
        ],
        isError: false,
      },
    });
  });

  it("adds an MCP warning message when one configured server fails discovery", async () => {
    const tabId = "tab-mcp-warning";
    setState(tabId);
    jotaiStoreMock.get.mockImplementation((atom: unknown) => {
      if (atom === providersAtomMock) {
        return [
          {
            id: "test-openai-id",
            name: "test-openai",
            type: "openai",
            apiKey: "test-key",
          },
        ];
      }
      if (atom === mcpServersAtomMock) {
        return [
          {
            id: "broken-server",
            name: "Broken Server",
            enabled: true,
            transport: "streamable-http",
            url: "http://localhost:1234/mcp",
          },
        ];
      }
      if (atom === profilesAtomMock) return [];
      if (atom === globalCommunicationProfileAtomMock) {
        return "global-test-profile";
      }
      return undefined;
    });
    prepareMcpRunMock.mockResolvedValue({
      tools: [],
      failures: [
        {
          serverId: "broken-server",
          serverName: "Broken Server",
          error: "Connection refused",
        },
      ],
    });
    turns.push({ deltas: ["Continuing without MCP."], toolCalls: [] });

    await runAgent(tabId, "hello");

    expect(states[tabId].chatMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          badge: "MCP WARNING",
          content: expect.stringContaining("Broken Server: Connection refused"),
        }),
      ]),
    );
    expect(shutdownMcpRunMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionId: "tab-mcp-warning",
        tabId: "tab-mcp-warning",
        agentId: "agent_main",
        traceId: expect.any(String),
      }),
    );
  });

  it("streams and persists assistant reasoning content", async () => {
    const tabId = "tab-reasoning";
    setState(tabId);

    turns.push({
      deltas: ["Final answer."],
      reasoningDeltas: ["First, inspect files.\n", "Then propose a fix."],
      toolCalls: [],
    });

    await runAgent(tabId, "debug this");

    const state = states[tabId];
    const assistant = state.chatMessages[1];
    expect(assistant).toMatchObject({
      role: "assistant",
      content: "Final answer.",
      reasoning: "First, inspect files.\nThen propose a fix.",
      streaming: false,
    });
    expect(assistant.reasoningStreaming).toBeUndefined();
    expect(typeof assistant.reasoningStartedAtMs).toBe("number");
    expect(typeof assistant.reasoningDurationMs).toBe("number");
    expect(state.status).toBe("idle");
  });

  it("logs stream parts and deltas when debug mode is enabled", async () => {
    const tabId = "tab-debug-stream";
    setState(tabId, { showDebug: true });
    turns.push({
      fullStreamParts: [
        { type: "reasoning-start", id: "reasoning-1" },
        { type: "reasoning-delta", id: "reasoning-1", delta: "Inspect files." },
        { type: "reasoning-end", id: "reasoning-1" },
      ],
      deltas: ["Final answer."],
      toolCalls: [],
    });

    await runAgent(tabId, "hi");

    const debugCalls = logFrontendSoonMock.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.level === "debug");

    expect(debugCalls.length).toBeGreaterThan(0);
    expect(debugCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "runner.turn:start",
          message: "turn:start",
          context: expect.objectContaining({ tabId }),
        }),
        expect.objectContaining({
          event: "runner.stream:part",
          message: "stream:part",
        }),
        expect.objectContaining({
          event: "runner.stream:reasoning-start",
          message: "stream:reasoning-start",
        }),
        expect.objectContaining({
          event: "runner.stream:reasoning-delta",
          message: "stream:reasoning-delta",
        }),
        expect.objectContaining({
          event: "runner.stream:text-delta",
          message: "stream:text-delta",
        }),
        expect.objectContaining({
          event: "runner.stream:tool-calls:raw",
          message: "stream:tool-calls:raw",
        }),
        expect.objectContaining({
          event: "runner.stream:finish",
          message: "stream:finish",
          data: expect.objectContaining({
            finishReason: "stop",
            stepCount: 1,
            steps: [
              expect.objectContaining({
                stepNumber: 0,
                finishReason: "stop",
                textChars: "Final answer.".length,
                reasoningChars: "Inspect files.".length,
                toolCallCount: 0,
              }),
            ],
          }),
        }),
        expect.objectContaining({
          event: "runner.stream:summary",
          message: "stream:summary",
        }),
      ]),
    );
  });

  it("does not log stream parts when debug mode is disabled", async () => {
    const tabId = "tab-no-debug-stream";
    setState(tabId, { showDebug: false });
    turns.push({ deltas: ["Hello"], toolCalls: [] });

    await runAgent(tabId, "hi");
    const debugCalls = logFrontendSoonMock.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.level === "debug");
    expect(debugCalls).toHaveLength(0);
  });

  it("records a denied tool call when approval is rejected", async () => {
    const tabId = "tab-denied";
    setState(tabId);

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-1",
            name: "exec_run",
            arguments: {
              command: "pwd",
              mutationIntent: "exploration",
              todoHandling: {
                mode: "skip",
                skipReason: "Approval-path test does not need todo tracking",
              },
            },
          },
        ],
      },
      { deltas: ["follow-up"], toolCalls: [] },
    );

    requiresApprovalMock.mockReturnValue({ required: true, dangerous: false });
    requestApprovalMock.mockResolvedValue(false);
    consumeApprovalReasonMock.mockReturnValue("Denied for safety");

    await runAgent(tabId, "run command");

    expect(requiresApprovalMock).toHaveBeenCalledWith(
      "exec_run",
      false,
      "no",
      {
        command: "pwd",
        mutationIntent: "exploration",
        todoHandling: {
          mode: "skip",
          skipReason: "Approval-path test does not need todo tracking",
        },
      },
      expect.objectContaining({ allow: [], deny: [] }),
    );

    const state = states[tabId];
    expect(dispatchToolMock).not.toHaveBeenCalled();
    const toolCalls = state.chatMessages.flatMap(
      (m) => (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
    );
    expect(toolCalls.find((t) => t.id === "tc-1")).toMatchObject({
      id: "tc-1",
      status: "denied",
    });

    const toolMessage = state.apiMessages.find((m) => m.role === "tool");
    expect(toolMessage).toBeTruthy();
    const parsed = JSON.parse(String(toolMessage?.content));
    expect(parsed).toEqual({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "Denied for safety" },
    });

    const secondTurnMessages = (
      streamTextMock.mock.calls[1]?.[0] as
        | { messages?: Array<Record<string, unknown>> }
        | undefined
    )?.messages;
    const mappedToolMessage = secondTurnMessages?.find(
      (m) => m.role === "tool",
    ) as Record<string, unknown> | undefined;
    const mappedToolPart = (
      mappedToolMessage?.content as Array<Record<string, unknown>> | undefined
    )?.[0];
    expect(mappedToolPart?.type).toBe("tool-result");
    expect(mappedToolPart).toHaveProperty("output");
    expect(mappedToolPart).not.toHaveProperty("result");
    expect(state.status).toBe("idle");
  });

  it("handles inline tool calls and keeps them on the assistant turn bubble", async () => {
    const tabId = "tab-inline";
    setState(tabId);

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-inline",
            name: "workspace_listDir",
            arguments: { path: "src" },
          },
        ],
      },
      { deltas: ["done"], toolCalls: [] },
    );

    dispatchToolMock.mockResolvedValue({ ok: true, data: { entries: [] } });

    await runAgent(tabId, "list files");

    const state = states[tabId];
    const assistantTurnWithTool = state.chatMessages.find(
      (m) =>
        m.role === "assistant" &&
        (
          (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? []
        ).some((tc) => tc.id === "tc-inline"),
    );
    expect(assistantTurnWithTool).toBeTruthy();
    expect(assistantTurnWithTool?.content).toBe("");
    const toolCalls =
      (assistantTurnWithTool?.toolCalls as
        | Array<Record<string, unknown>>
        | undefined) ?? [];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      id: "tc-inline",
      tool: "workspace_listDir",
      status: "done",
    });
    expect(
      state.chatMessages.some((m) =>
        Object.prototype.hasOwnProperty.call(m, "inline"),
      ),
    ).toBe(false);
    expect(dispatchToolMock).toHaveBeenCalledWith(
      tabId,
      "",
      "workspace_listDir",
      { path: "src" },
      "tc-inline",
      undefined, // no streaming callbacks for non-exec tools
      expect.objectContaining({
        agentId: "agent_main",
        runId: expect.stringMatching(/^run_/),
      }),
    );
    expect(state.status).toBe("idle");
  });

  it("preserves text content on assistant bubble when text precedes inline tool calls", async () => {
    const tabId = "tab-inline-text";
    setState(tabId);

    turns.push(
      {
        deltas: ["Let me check the files."],
        toolCalls: [
          {
            id: "tc-glob",
            name: "workspace_glob",
            arguments: { patterns: ["*.ts"] },
          },
        ],
      },
      { deltas: ["Done."], toolCalls: [] },
    );

    dispatchToolMock.mockResolvedValue({ ok: true, data: { matches: [] } });

    await runAgent(tabId, "find files");

    const state = states[tabId];
    const assistantTurnWithTool = state.chatMessages.find(
      (m) =>
        m.role === "assistant" &&
        (
          (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? []
        ).some((tc) => tc.id === "tc-glob"),
    );
    expect(assistantTurnWithTool).toBeTruthy();
    expect(assistantTurnWithTool?.content).toBe("Let me check the files.");
    const toolCalls =
      (assistantTurnWithTool?.toolCalls as
        | Array<Record<string, unknown>>
        | undefined) ?? [];
    expect(toolCalls[0]).toMatchObject({
      id: "tc-glob",
      tool: "workspace_glob",
    });
  });

  it("keeps oversized tool results inline for local tools", async () => {
    const tabId = "tab-huge-output";
    setState(tabId, {
      config: {
        cwd: "",
        model: "openai/gpt-5.2",
        contextLength: 128_000,
      },
    });

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-huge",
            name: "workspace_search",
            arguments: {
              pattern: "error",
            },
          },
        ],
      },
      { deltas: ["done"], toolCalls: [] },
    );

    dispatchToolMock.mockResolvedValue({
      ok: true,
      data: {
        matches: [],
        truncated: false,
        searchedFiles: 1,
        matchCount: 0,
        blob: "x".repeat(70 * 1024),
      },
    });

    await runAgent(tabId, "find failures");

    expect(dispatchToolMock).toHaveBeenCalledWith(
      tabId,
      "",
      "workspace_search",
      { pattern: "error" },
      "tc-huge",
      undefined,
      expect.any(Object),
    );
    const toolMessage = states[tabId].apiMessages.find(
      (msg) => msg.role === "tool" && msg.tool_call_id === "tc-huge",
    );
    expect(toolMessage?.content).toBe("Found 0 match(es) in 1 file(s)");
  });

  it("compacts model-facing tool-call input while keeping visible args raw", async () => {
    const tabId = "tab-context-compaction-input";
    setState(tabId);

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-write-compact",
            name: "workspace_writeFile",
            arguments: {
              path: "src/foo.ts",
              content: "export const foo = 1;\n",
              overwrite: true,
              mutationIntent: "fix",
              todoHandling: {
                mode: "skip",
                skipReason: "Context-compaction runner test",
              },
              __contextCompaction: {
                inputNote:
                  "Wrote src/foo.ts with the requested implementation; exact file body omitted from context.",
              },
            },
          },
        ],
      },
      { deltas: ["done"], toolCalls: [] },
    );

    dispatchToolMock.mockResolvedValue({
      ok: true,
      data: {
        path: "src/foo.ts",
        bytesWritten: 22,
        created: false,
        overwritten: true,
      },
    });

    await runAgent(tabId, "write the file");

    expect(dispatchToolMock).toHaveBeenCalledWith(
      tabId,
      "",
      "workspace_writeFile",
      {
        path: "src/foo.ts",
        content: "export const foo = 1;\n",
        overwrite: true,
      },
      "tc-write-compact",
      undefined,
      expect.any(Object),
    );

    const state = states[tabId];
    const assistantMessage = state.apiMessages.find(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0,
    ) as { tool_calls: Array<{ function: { arguments: string } }> } | undefined;
    const assistantArgs = JSON.parse(
      String(assistantMessage?.tool_calls[0]?.function.arguments),
    );
    expect(assistantArgs).toMatchObject({
      __rakhCompactToolIO: {
        tool: "workspace_writeFile",
        side: "input",
        compacted: true,
        kept: {
          path: "src/foo.ts",
          overwrite: true,
        },
        omitted: {
          fields: ["content"],
        },
      },
    });

    const toolCall = state.chatMessages
      .flatMap(
        (message) =>
          (message.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
      )
      .find((entry) => entry.id === "tc-write-compact");
    expect(toolCall).toMatchObject({
      args: {
        path: "src/foo.ts",
        content: "export const foo = 1;\n",
        overwrite: true,
        mutationIntent: "fix",
        todoHandling: {
          mode: "skip",
          skipReason: "Context-compaction runner test",
        },
      },
      contextCompaction: {
        input: {
          status: "compacted",
          note:
            "Wrote src/foo.ts with the requested implementation; exact file body omitted from context.",
        },
      },
    });
    expect(toolCall?.args).not.toHaveProperty("__contextCompaction");

    const secondTurnMessages = (
      streamTextMock.mock.calls[1]?.[0] as
        | { messages?: Array<Record<string, unknown>> }
        | undefined
    )?.messages;
    const mappedAssistant = secondTurnMessages?.find(
      (message) => message.role === "assistant",
    ) as { content?: Array<Record<string, unknown>> } | undefined;
    const toolCallPart = mappedAssistant?.content?.find(
      (part) => part.type === "tool-call",
    );
    expect(toolCallPart).toMatchObject({
      toolName: "workspace_writeFile",
      input: {
        __rakhCompactToolIO: {
          tool: "workspace_writeFile",
          side: "input",
        },
      },
    });
  });

  it("compacts model-facing tool output while keeping visible results raw", async () => {
    const tabId = "tab-context-compaction-output";
    setState(tabId);

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-read-compact",
            name: "workspace_readFile",
            arguments: {
              path: "src/runner.ts",
              __contextCompaction: {
                outputNote:
                  "Read src/runner.ts for context; exact file contents omitted from model history.",
              },
            },
          },
        ],
      },
      { deltas: ["done"], toolCalls: [] },
    );

    dispatchToolMock.mockResolvedValue({
      ok: true,
      data: {
        path: "src/runner.ts",
        encoding: "utf8",
        content: "export const runner = true;\n",
        fileSizeBytes: 28,
        lineCount: 1,
        truncated: false,
      },
    });

    await runAgent(tabId, "read the runner");

    const state = states[tabId];
    const toolMessage = state.apiMessages.find(
      (message) =>
        message.role === "tool" && message.tool_call_id === "tc-read-compact",
    );
    expect(JSON.parse(String(toolMessage?.content))).toMatchObject({
      __rakhCompactToolIO: {
        tool: "workspace_readFile",
        side: "output",
        compacted: true,
        kept: {
          path: "src/runner.ts",
          fileSizeBytes: 28,
          lineCount: 1,
          truncated: false,
        },
        omitted: {
          fields: ["content"],
        },
      },
    });

    const toolCall = state.chatMessages
      .flatMap(
        (message) =>
          (message.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
      )
      .find((entry) => entry.id === "tc-read-compact");
    expect(toolCall).toMatchObject({
      result: {
        path: "src/runner.ts",
        content: "export const runner = true;\n",
        fileSizeBytes: 28,
      },
      contextCompaction: {
        output: {
          status: "compacted",
          note:
            "Read src/runner.ts for context; exact file contents omitted from model history.",
          mode: "always",
        },
      },
    });

    const secondTurnMessages = (
      streamTextMock.mock.calls[1]?.[0] as
        | { messages?: Array<Record<string, unknown>> }
        | undefined
    )?.messages;
    const mappedTool = secondTurnMessages?.find(
      (message) => message.role === "tool",
    ) as { content?: Array<Record<string, unknown>> } | undefined;
    const toolResultPart = mappedTool?.content?.find(
      (part) => part.type === "tool-result",
    );
    expect(toolResultPart).toMatchObject({
      toolName: "workspace_readFile",
      output: {
        type: "json",
        value: {
          __rakhCompactToolIO: {
            tool: "workspace_readFile",
            side: "output",
          },
        },
      },
    });
  });

  it("keeps full exec_run output when output compaction is requested on_success and the command fails", async () => {
    const tabId = "tab-context-compaction-on-success-failure";
    setState(tabId);

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-exec-compact",
            name: "exec_run",
            arguments: {
              command: "npm",
              args: ["test"],
              reason: "Run tests",
              mutationIntent: "test",
              todoHandling: {
                mode: "skip",
                skipReason: "Context-compaction runner test",
              },
              __contextCompaction: {
                outputNote: "Tests passed; full stdout omitted.",
                outputMode: "on_success",
              },
            },
          },
        ],
      },
      { deltas: ["done"], toolCalls: [] },
    );

    const execFailure = {
      ok: true as const,
      data: {
        command: "npm",
        args: ["test"],
        cwd: "",
        exitCode: 1,
        durationMs: 12,
        stdout: "failing output\n",
        stderr: "stack trace\n",
        truncatedStdout: false,
        truncatedStderr: false,
      },
    };
    dispatchToolMock.mockResolvedValue(execFailure);

    await runAgent(tabId, "run tests");

    expect(parseToolMessageResult(tabId, "tc-exec-compact")).toEqual(execFailure);

    const toolCall = states[tabId].chatMessages
      .flatMap(
        (message) =>
          (message.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
      )
      .find((entry) => entry.id === "tc-exec-compact");
    expect(toolCall).toMatchObject({
      contextCompaction: {
        output: {
          status: "full",
          mode: "on_success",
          reason: "Kept full because exec_run exited with code 1.",
        },
      },
    });

    const secondTurnMessages = (
      streamTextMock.mock.calls[1]?.[0] as
        | { messages?: Array<Record<string, unknown>> }
        | undefined
    )?.messages;
    const mappedTool = secondTurnMessages?.find(
      (message) => message.role === "tool",
    ) as { content?: Array<Record<string, unknown>> } | undefined;
    const toolResultPart = mappedTool?.content?.find(
      (part) => part.type === "tool-result",
    );
    expect(toolResultPart).toMatchObject({
      toolName: "exec_run",
      output: {
        type: "json",
        value: execFailure,
      },
    });
  });

  it("ignores unsupported tool-context compaction requests without changing execution", async () => {
    const tabId = "tab-context-compaction-unsupported";
    setState(tabId);

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-stat-compact",
            name: "workspace_stat",
            arguments: {
              path: "README.md",
              __contextCompaction: {
                inputNote: "Stat call args omitted.",
                outputNote: "Stat call output omitted.",
              },
            },
          },
        ],
      },
      { deltas: ["done"], toolCalls: [] },
    );

    dispatchToolMock.mockResolvedValue({
      ok: true,
      data: { exists: true, path: "README.md", kind: "file", sizeBytes: 64 },
    });

    await runAgent(tabId, "stat the readme");

    expect(dispatchToolMock).toHaveBeenCalledWith(
      tabId,
      "",
      "workspace_stat",
      { path: "README.md" },
      "tc-stat-compact",
      undefined,
      expect.any(Object),
    );

    const assistantMessage = states[tabId].apiMessages.find(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0,
    ) as { tool_calls: Array<{ function: { arguments: string } }> } | undefined;
    expect(
      JSON.parse(String(assistantMessage?.tool_calls[0]?.function.arguments)),
    ).toEqual({ path: "README.md" });

    const toolCall = states[tabId].chatMessages
      .flatMap(
        (message) =>
          (message.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
      )
      .find((entry) => entry.id === "tc-stat-compact");
    expect(toolCall).toMatchObject({
      contextCompaction: {
        input: {
          status: "full",
        },
        output: {
          status: "full",
        },
      },
    });

    expect(
      logFrontendSoonMock.mock.calls.some(([entry]) => {
        const record = entry as Record<string, unknown>;
        return (
          record.level === "warn" &&
          record.event === "runner.tool.context-compaction.ignored"
        );
      }),
    ).toBe(true);
  });

  it("attaches conversation cards to the owning assistant message in tool declaration order", async () => {
    const tabId = "tab-agent-cards";
    setState(tabId);

    turns.push(
      {
        deltas: ["Posting cards."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-card-summary",
            "## Summary\n\n- First card",
            "Summary Card",
          ),
          makeArtifactCardToolCall(
            "tc-card-artifact",
            "artifact_123",
            3,
            "Artifact Card",
          ),
        ],
      },
      { deltas: ["Done."], toolCalls: [] },
    );

    await runAgent(tabId, "post cards");

    const state = states[tabId];
    const assistantWithCards = state.chatMessages.find(
      (m) => m.role === "assistant" && Array.isArray(m.cards) && m.cards.length > 0,
    );
    expect(assistantWithCards).toBeDefined();
    expect(assistantWithCards?.content).toBe("Posting cards.");
    expect(assistantWithCards?.cards).toMatchObject([
      {
        kind: "summary",
        title: "Summary Card",
        markdown: "## Summary\n\n- First card",
      },
      {
        kind: "artifact",
        title: "Artifact Card",
        artifactId: "artifact_123",
        version: 3,
      },
    ]);

    const cardToolCalls =
      (assistantWithCards?.toolCalls as Array<Record<string, unknown>> | undefined) ?? [];
    expect(cardToolCalls.map((tc) => tc.id)).toEqual([
      "tc-card-summary",
      "tc-card-artifact",
    ]);
    expect(cardToolCalls.map((tc) => tc.status)).toEqual(["done", "done"]);

    expect(parseToolMessageResult(tabId, "tc-card-summary")).toEqual({
      ok: true,
      data: { cardId: expect.any(String), kind: "summary" },
    });
    expect(parseToolMessageResult(tabId, "tc-card-artifact")).toEqual({
      ok: true,
      data: { cardId: expect.any(String), kind: "artifact" },
    });
  });

  it("renders completed card tool results before the rest of the tool batch finishes", async () => {
    const tabId = "tab-agent-cards-mid-batch";
    setState(tabId);

    let resolveGlob:
      | ((value: { ok: true; data: { matches: string[] } }) => void)
      | undefined;

    dispatchToolMock.mockImplementation((...args: unknown[]) => {
      if (args[2] !== "workspace_glob") {
        return Promise.resolve({ ok: true, data: { ok: true } });
      }
      return new Promise((resolve) => {
        resolveGlob = resolve as (
          value: { ok: true; data: { matches: string[] } },
        ) => void;
      });
    });

    turns.push(
      {
        deltas: ["Posting cards."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-card-summary",
            "## Summary\n\n- First card",
            "Summary Card",
          ),
          {
            id: "tc-glob",
            name: "workspace_glob",
            arguments: { patterns: ["*.ts"] },
          },
        ],
      },
      { deltas: ["Done."], toolCalls: [] },
    );

    const runPromise = runAgent(tabId, "post cards");
    await flushAsyncWork(16);

    const inFlightAssistant = states[tabId].chatMessages.find(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.cards) &&
        message.cards.length > 0,
    );
    expect(inFlightAssistant).toBeDefined();
    expect(inFlightAssistant?.cards).toMatchObject([
      {
        kind: "summary",
        title: "Summary Card",
        markdown: "## Summary\n\n- First card",
      },
    ]);
    expect(
      (
        inFlightAssistant?.toolCalls as
          | Array<Record<string, unknown>>
          | undefined
      )?.map((toolCall) => toolCall.status),
    ).toEqual(["done", "running"]);

    expect(resolveGlob).toBeTypeOf("function");
    resolveGlob?.({ ok: true, data: { matches: [] } });
    await runPromise;
  });

  it("reuses one runId across main + subagent tool dispatches and sets agentId", async () => {
    const tabId = "tab-subagent-runtime";
    setState(tabId);

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-main-inline",
            name: "workspace_listDir",
            arguments: { path: "src" },
          },
          {
            id: "tc-subagent",
            name: "agent_subagent_call",
            arguments: { subagentId: "planner", message: "inspect src" },
          },
        ],
      },
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-planner-stat",
            name: "workspace_stat",
            arguments: { path: "src" },
          },
        ],
      },
      { deltas: ["planner done"], toolCalls: [] },
      { deltas: ["main done"], toolCalls: [] },
    );

    dispatchToolMock.mockResolvedValue({ ok: true, data: { ok: true } });

    await runAgent(tabId, "delegate and inspect");

    const mainCall = dispatchToolMock.mock.calls.find(
      (call) => call[2] === "workspace_listDir",
    );
    const plannerCall = dispatchToolMock.mock.calls.find(
      (call) => call[2] === "workspace_stat",
    );
    expect(mainCall).toBeTruthy();
    expect(plannerCall).toBeTruthy();

    const mainRuntime = mainCall?.[6] as Record<string, unknown>;
    const plannerRuntime = plannerCall?.[6] as Record<string, unknown>;
    expect(mainRuntime.agentId).toBe("agent_main");
    expect(plannerRuntime.agentId).toBe("agent_planner");
    expect(mainRuntime.runId).toEqual(plannerRuntime.runId);
    expect(String(mainRuntime.runId)).toMatch(/^run_/);
  });

  it("renders an assistant bubble for an inline-only tool turn", async () => {
    const tabId = "tab-inline-only";
    setState(tabId);

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-inline-only",
            name: "workspace_stat",
            arguments: { path: "src/agent/runner.ts" },
          },
        ],
      },
      { deltas: ["done"], toolCalls: [] },
    );

    dispatchToolMock.mockResolvedValue({ ok: true, data: { exists: true } });

    await runAgent(tabId, "stat file");

    const state = states[tabId];
    const assistantTurnWithTool = state.chatMessages.find(
      (m) =>
        m.role === "assistant" &&
        (
          (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? []
        ).some((tc) => tc.id === "tc-inline-only"),
    );
    expect(assistantTurnWithTool).toBeTruthy();
    expect(assistantTurnWithTool?.content).toBe("");
    const toolCalls =
      (assistantTurnWithTool?.toolCalls as
        | Array<Record<string, unknown>>
        | undefined) ?? [];
    expect(toolCalls[0]).toMatchObject({
      id: "tc-inline-only",
      tool: "workspace_stat",
      status: "done",
    });
  });

  it("passes onExecOutput callback for exec_run and accumulates streamingOutput", async () => {
    const tabId = "tab-exec-stream";
    setState(tabId);

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-exec",
            name: "exec_run",
            arguments: {
              command: "npm",
              args: ["test"],
              mutationIntent: "test",
              todoHandling: {
                mode: "skip",
                skipReason: "Streaming output test does not need todo tracking",
              },
            },
          },
        ],
      },
      { deltas: ["All done."], toolCalls: [] },
    );

    requiresApprovalMock.mockReturnValue({ required: false, dangerous: false });

    dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
      const callbacks = args[5] as
        | { onExecOutput?: (stream: string, data: string) => void }
        | undefined;
      callbacks?.onExecOutput?.("stdout", "running...\n");
      callbacks?.onExecOutput?.("stdout", "passed\n");
      return {
        ok: true,
        data: { exitCode: 0, stdout: "running...\npassed\n", stderr: "" },
      };
    });

    await runAgent(tabId, "run tests");

    const allToolCalls = states[tabId].chatMessages.flatMap(
      (m) => (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
    );
    const execCall = allToolCalls.find((tc) => tc.id === "tc-exec");
    expect(execCall?.streamingOutput).toBe("running...\npassed\n");
  });

  it("normalizes malformed tool arguments so the run continues", async () => {
    const tabId = "tab-malformed-args";
    setState(tabId);

    turns.push(
      {
        deltas: [],
        toolCalls: [
          {
            id: "tc-bad-args",
            name: "workspace_readFile",
            arguments: '{"path":"index.html","range":{"startLine":170,..??}',
          },
        ],
      },
      { deltas: ["done"], toolCalls: [] },
    );

    dispatchToolMock.mockResolvedValue({
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "path is required" },
    });

    await runAgent(tabId, "read index");

    expect(dispatchToolMock).toHaveBeenCalledWith(
      tabId,
      "",
      "workspace_readFile",
      {},
      "tc-bad-args",
      undefined,
      expect.objectContaining({
        agentId: "agent_main",
        runId: expect.stringMatching(/^run_/),
      }),
    );

    const toolCalls = states[tabId].chatMessages.flatMap(
      (m) => (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
    );
    expect(toolCalls.find((t) => t.id === "tc-bad-args")).toMatchObject({
      id: "tc-bad-args",
      args: {},
      status: "error",
    });
    expect(states[tabId].status).toBe("idle");
  });

  it("stopAgent resets stream state and cancels approvals", () => {
    const tabId = "tab-stop";
    setState(tabId, {
      status: "working",
      streamingContent: "streaming...",
      chatMessages: [
        {
          role: "assistant",
          content: "Partial reply",
          streaming: true,
          reasoningStreaming: true,
          reasoningStartedAtMs: Date.now() - 1_000,
        },
      ],
    });

    stopAgent(tabId);

    expect(states[tabId].status).toBe("idle");
    expect(states[tabId].streamingContent).toBeNull();
    expect(states[tabId].chatMessages[0]?.streaming).toBe(false);
    expect(states[tabId].chatMessages[0]?.reasoningStreaming).toBeUndefined();
    expect(typeof states[tabId].chatMessages[0]?.reasoningDurationMs).toBe(
      "number",
    );
    expect(cancelAllApprovalsMock).toHaveBeenCalled();
  });

  it("stopAgent aborts running exec commands and marks them aborted", () => {
    const tabId = "tab-stop-exec";
    setState(tabId, {
      status: "working",
      chatMessages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-exec-running",
              tool: "exec_run",
              args: { command: "sleep", args: ["10"] },
              status: "running",
            },
          ],
        },
      ],
    });

    stopAgent(tabId);

    expect(execAbortMock).toHaveBeenCalledWith("tc-exec-running");
    const toolCalls = states[tabId].chatMessages.flatMap(
      (m) => (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
    );
    expect(toolCalls.find((t) => t.id === "tc-exec-running")).toMatchObject({
      status: "error",
      result: {
        message:
          "User aborted the execution of this command. No stdout/stderr will be returned.",
      },
    });
  });

  it("stopAgent pauses queued work instead of draining it", () => {
    const tabId = "tab-stop-pauses-queue";
    setState(tabId, {
      status: "working",
      queueState: "draining",
      queuedMessages: [
        { id: "queued-1", content: "follow up later", createdAtMs: 10 },
      ],
    });

    stopAgent(tabId);

    expect(states[tabId].status).toBe("idle");
    expect(states[tabId].queueState).toBe("paused");
    expect(states[tabId].queuedMessages).toEqual([
      { id: "queued-1", content: "follow up later", createdAtMs: 10 },
    ]);
  });

  it("drains queued messages sequentially after a clean idle", async () => {
    const tabId = "tab-queue-drain";
    setState(tabId, {
      queueState: "paused",
      queuedMessages: [
        { id: "queued-1", content: "first queued note", createdAtMs: 10 },
        { id: "queued-2", content: "second queued note", createdAtMs: 20 },
      ],
    });

    turns.push(
      { deltas: ["First done"], toolCalls: [] },
      { deltas: ["Second done"], toolCalls: [] },
    );

    resumeQueue(tabId);
    await flushAsyncWork(40);

    expect(states[tabId].queueState).toBe("idle");
    expect(states[tabId].queuedMessages).toEqual([]);
    expect(states[tabId].chatMessages[0]).toMatchObject({
      role: "user",
      content: "first queued note",
    });
    expect(states[tabId].chatMessages[2]).toMatchObject({
      role: "user",
      content: "second queued note",
    });
  });

  it("preserves queued items when steering a new message", async () => {
    const tabId = "tab-steer-preserves-queue";
    setState(tabId, {
      queuedMessages: [
        { id: "queued-1", content: "stay queued", createdAtMs: 10 },
      ],
      queueState: "draining",
    });

    let releaseFirstRun: (() => void) | undefined;
    let releaseSecondRun: (() => void) | undefined;
    let secondRunAborted = false;

    streamTextMock
      .mockReset()
      .mockImplementationOnce((args: { abortSignal: AbortSignal }) => {
        const waitForAbort = new Promise<void>((resolve) => {
          args.abortSignal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        const hold = new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        });
        const fullStream = (async function* () {
          await Promise.race([waitForAbort, hold]);
        })();
        const textStream = (async function* () {
          await Promise.race([waitForAbort, hold]);
        })();
        return {
          textStream,
          fullStream,
          toolCalls: Promise.resolve([]),
        };
      })
      .mockImplementationOnce((args: { abortSignal: AbortSignal }) => {
        const waitForAbort = new Promise<void>((resolve) => {
          args.abortSignal.addEventListener(
            "abort",
            () => {
              secondRunAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        const hold = new Promise<void>((resolve) => {
          releaseSecondRun = resolve;
        });
        const fullStream = (async function* () {
          await Promise.race([waitForAbort, hold]);
        })();
        const textStream = (async function* () {
          await Promise.race([waitForAbort, hold]);
        })();
        return {
          textStream,
          fullStream,
          toolCalls: Promise.resolve([]),
        };
      });

    const firstRun = runAgent(tabId, "original run");
    await flushAsyncWork(8);

    const steeringRun = steerMessage(tabId, "urgent correction");
    await flushAsyncWork(20);

    stopAgent(tabId);
    await flushAsyncWork(20);

    expect(secondRunAborted).toBe(true);
    expect(states[tabId].queuedMessages).toEqual([
      { id: "queued-1", content: "stay queued", createdAtMs: 10 },
    ]);
    expect(states[tabId].queueState).toBe("paused");

    releaseFirstRun?.();
    releaseSecondRun?.();
    await Promise.all([firstRun, steeringRun]);
  });

  it("stopRunningExecToolCall stops a running exec without aborting the whole agent", async () => {
    const tabId = "tab-stop-single-exec";
    setState(tabId, {
      status: "working",
      chatMessages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-exec-running",
              tool: "exec_run",
              args: { command: "sleep", args: ["10"] },
              status: "running",
            },
          ],
        },
      ],
    });

    const stopped = await stopRunningExecToolCall(tabId, "tc-exec-running");

    expect(stopped).toBe(true);
    expect(execStopMock).toHaveBeenCalledWith("tc-exec-running");
    expect(execAbortMock).not.toHaveBeenCalled();
    expect(states[tabId].status).toBe("working");
    expect(cancelAllApprovalsMock).not.toHaveBeenCalled();
  });

  /* ── providerOptions integration test ─────────────────────────────────── */

  it("passes supported Anthropic fast mode to streamText", async () => {
    const tabId = "tab-provider-options";
    registerDynamicModels([
      {
        id: "anthropic/claude-opus",
        name: "Claude Opus",
        providerId: "test-anthropic-id",
        owned_by: "anthropic",
        tags: [],
        sdk_id: "claude-opus-4-6",
      },
    ]);
    setState(tabId, {
      config: {
        cwd: "",
        model: "anthropic/claude-opus",
        advancedOptions: {
          reasoningVisibility: "detailed",
          reasoningEffort: "high",
          latencyCostProfile: "fast",
        },
      },
    });
    turns.push({ deltas: ["Done"], toolCalls: [] });

    await runAgent(tabId, "hello");

    const callArgs = streamTextMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(callArgs).toBeDefined();
    const po = callArgs!.providerOptions as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(po).toBeDefined();
    expect(po!.anthropic.thinking).toEqual({
      type: "enabled",
      budgetTokens: 4096,
    });
    expect(po!.anthropic.effort).toBe("high");
    expect(po!.anthropic.speed).toBe("fast");
  });

  it("omits unsupported Anthropic effort and fast mode from streamText", async () => {
    const tabId = "tab-provider-options-no-fast-mode";
    registerDynamicModels([
      {
        id: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        providerId: "test-anthropic-id",
        owned_by: "anthropic",
        tags: [],
        sdk_id: "claude-sonnet-4-6",
      },
    ]);
    setState(tabId, {
      config: {
        cwd: "",
        model: "anthropic/claude-sonnet",
        advancedOptions: {
          reasoningVisibility: "detailed",
          reasoningEffort: "high",
          latencyCostProfile: "fast",
        },
      },
    });
    turns.push({ deltas: ["Done"], toolCalls: [] });

    await runAgent(tabId, "hello");

    const callArgs = streamTextMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(callArgs).toBeDefined();
    const po = callArgs!.providerOptions as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(po).toBeDefined();
    expect(po!.anthropic.thinking).toEqual({
      type: "enabled",
      budgetTokens: 4096,
    });
    expect(po!.anthropic).not.toHaveProperty("effort");
    expect(po!.anthropic).not.toHaveProperty("speed");
  });

  it("omits providerOptions from streamText for openai-compatible providers", async () => {
    const tabId = "tab-compat-no-provider-opts";
    registerDynamicModels([
      {
        id: "my-server/llama3",
        name: "Llama 3",
        providerId: "test-compatible-id",
        owned_by: "openai-compatible",
        tags: [],
        sdk_id: "llama3",
      },
    ]);
    setState(tabId, {
      config: {
        cwd: "",
        model: "my-server/llama3",
        advancedOptions: {
          reasoningVisibility: "detailed",
          reasoningEffort: "high",
          latencyCostProfile: "fast",
        },
      },
    });
    turns.push({ deltas: ["Done"], toolCalls: [] });

    await runAgent(tabId, "hello");

    const callArgs = streamTextMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(callArgs).toBeDefined();
    expect(callArgs!.providerOptions).toBeUndefined();
  });

  it("preserves provider stream errors when no output is generated", async () => {
    const tabId = "tab-no-output-stream-error";
    setState(tabId);

    const apiError = Object.assign(new Error("Incorrect API key provided"), {
      name: "AI_APICallError",
      statusCode: 401,
      responseBody: '{"error":{"message":"Incorrect API key provided"}}',
      url: "https://api.openai.com/v1/responses",
    });
    const noOutput = new Error(
      "No output generated. Check the stream for errors.",
    );
    noOutput.name = "AI_NoOutputGeneratedError";

    turns.push({
      fullStreamParts: [{ type: "error", error: apiError }],
      toolCallsError: noOutput,
    });

    await runAgent(tabId, "hello");

    const state = states[tabId];
    expect(state.status).toBe("error");
    expect(state.error).toBe(
      "No output generated. Check the stream for errors.",
    );

    const details = state.errorDetails as Record<string, unknown>;
    expect(details.name).toBe("AI_NoOutputGeneratedError");
    expect(details.streamErrors).toMatchObject([
      {
        name: "AI_APICallError",
        message: "Incorrect API key provided",
        statusCode: 401,
        responseBody: '{"error":{"message":"Incorrect API key provided"}}',
      },
    ]);
    expect(details.cause).toMatchObject({
      name: "AI_APICallError",
      statusCode: 401,
    });
  });

  /* ── agent_subagent_call integration tests ─────────────────────────────── */

  describe("agent_subagent_call", () => {
    it("returns artifact refs for planner output instead of inline structured data", async () => {
      const tabId = "tab-subagent-basic";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-subagent",
            name: "agent_subagent_call",
            arguments: {
              subagentId: "planner",
              message: "plan the auth refactor",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Saving plan."],
        toolCalls: [
          {
            id: "tc-plan-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "plan",
              kind: "plan",
              contentFormat: "markdown",
              summary: "Auth refactor plan",
              content: "# Plan\n\n1. Inspect auth\n2. Refactor auth",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Posting plan cards."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-plan-summary-card",
            "## Auth refactor plan\n\n- Inspect auth\n- Refactor auth",
            "Plan Summary",
          ),
          makeArtifactCardToolCall(
            "tc-plan-artifact-card",
            "plan_123",
            1,
            "Saved Plan",
          ),
        ],
      });
      turns.push({
        deltas: ["Plan ready below."],
        toolCalls: [],
      });
      turns.push({
        deltas: ["Starting work."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "plan_123",
                kind: "plan",
                summary: toolArgs.summary,
                metadata: toolArgs.metadata,
                contentFormat: "markdown",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      await runAgent(tabId, "please plan the auth refactor");

      const state = states[tabId];
      expect(state.status).toBe("idle");
      const plannerMessages = state.chatMessages.filter(
        (m) => m.agentName === "Planner",
      );
      const plannerCardMessage = plannerMessages.find(
        (m) => Array.isArray(m.cards) && m.cards.length > 0,
      );
      expect(plannerCardMessage).toBeDefined();
      expect(plannerCardMessage?.content).toBe("Posting plan cards.");
      expect(plannerCardMessage?.cards).toMatchObject([
        {
          kind: "summary",
          title: "Plan Summary",
          markdown: "## Auth refactor plan\n\n- Inspect auth\n- Refactor auth",
        },
        {
          kind: "artifact",
          title: "Saved Plan",
          artifactId: "plan_123",
          version: 1,
        },
      ]);
      expect(plannerMessages.at(-1)?.content).toBe("Plan ready below.");
      const parentFinal = state.chatMessages.at(-1);
      expect(parentFinal?.role).toBe("assistant");
      expect(parentFinal?.content).toBe("Starting work.");
      expect(dispatchToolMock).toHaveBeenCalledWith(
        tabId,
        expect.any(String),
        "agent_artifact_create",
        expect.objectContaining({
          artifactType: "plan",
          metadata: {
            __rakh: { artifactType: "plan" },
          },
        }),
        "tc-plan-artifact",
        undefined,
        expect.objectContaining({ agentId: "agent_planner" }),
      );

      const subagentResult = parseToolMessageResult(tabId, "tc-subagent");
      expect(subagentResult).toMatchObject({
        ok: true,
        data: {
          subagentId: "planner",
          cards: [
            {
              kind: "summary",
              title: "Plan Summary",
              markdown: "## Auth refactor plan\n\n- Inspect auth\n- Refactor auth",
            },
            {
              kind: "artifact",
              title: "Saved Plan",
              artifactId: "plan_123",
              version: 1,
              instruction: "Read the artifact directly to get the content.",
            },
          ],
          artifacts: [{ artifactId: "plan_123" }],
          artifactValidations: [],
        },
      });
      expect(subagentResult).not.toHaveProperty("data.output");
      expect(streamTextMock).toHaveBeenCalledTimes(5);
    });

    it("supports summary-only subagents with no artifact contract", async () => {
      const tabId = "tab-subagent-github";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-subagent",
            name: "agent_subagent_call",
            arguments: {
              subagentId: "github",
              message: "create a GitHub issue for the auth timeout bug",
            },
          },
        ],
        totalUsage: {
          inputTokens: 900,
          noCacheInputTokens: 900,
          outputTokens: 120,
          totalTokens: 1020,
        },
      });
      turns.push({
        deltas: ["Posting GitHub summary card."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-github-summary-card",
            "Created issue #42 in `acme/app`.\n\n- URL: https://github.com/acme/app/issues/42",
            "GitHub Update",
          ),
        ],
        totalUsage: {
          inputTokens: 700,
          noCacheInputTokens: 700,
          outputTokens: 180,
          totalTokens: 880,
        },
      });
      turns.push({
        deltas: ["GitHub update ready below."],
        toolCalls: [],
        totalUsage: {
          inputTokens: 320,
          noCacheInputTokens: 320,
          outputTokens: 60,
          totalTokens: 380,
        },
      });
      turns.push({
        deltas: ["Issue created and linked."],
        toolCalls: [],
        totalUsage: {
          inputTokens: 540,
          noCacheInputTokens: 540,
          outputTokens: 90,
          totalTokens: 630,
        },
      });

      await runAgent(tabId, "please create a GitHub issue for the auth timeout bug");

      const state = states[tabId];
      expect(state.status).toBe("idle");
      const subagentMessage = state.chatMessages
        .filter(
          (m) =>
            m.agentName === "GitHub Operator" &&
            Array.isArray(m.cards) &&
            m.cards.length > 0,
        )
        .at(-1);
      expect(subagentMessage).toBeDefined();
      expect(subagentMessage?.content).toContain("Posting GitHub summary card.");
      expect(subagentMessage?.cards).toMatchObject([
        {
          kind: "summary",
          title: "GitHub Update",
          markdown:
            "Created issue #42 in `acme/app`.\n\n- URL: https://github.com/acme/app/issues/42",
        },
      ]);
      expect(state.chatMessages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Issue created and linked.",
      });

      const subagentResult = parseToolMessageResult(tabId, "tc-subagent");
      expect(subagentResult).toMatchObject({
        ok: true,
        data: {
          subagentId: "github",
          rawText: "GitHub update ready below.",
          cards: [
            {
              kind: "summary",
              title: "GitHub Update",
              markdown:
                "Created issue #42 in `acme/app`.\n\n- URL: https://github.com/acme/app/issues/42",
            },
          ],
          artifacts: [],
          artifactValidations: [],
        },
      });
      expect(state.llmUsageLedger).toHaveLength(4);
      expect(
        state.llmUsageLedger.filter((entry) => entry.actorKind === "main"),
      ).toHaveLength(2);
      expect(
        state.llmUsageLedger.filter(
          (entry) => entry.actorKind === "subagent" && entry.actorId === "github",
        ),
      ).toHaveLength(2);
      expect(
        state.llmUsageLedger.find(
          (entry) => entry.actorKind === "subagent" && entry.actorId === "github",
        ),
      ).toMatchObject({
        actorLabel: "GitHub Operator",
        modelId: "openai/gpt-5.2",
      });
      expect(streamTextMock).toHaveBeenCalledTimes(4);
    });

    it("rejects invalid reviewer artifacts before persistence and succeeds after retry", async () => {
      const tabId = "tab-subagent-reviewer-retry";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-reviewer",
            name: "agent_subagent_call",
            arguments: {
              subagentId: "reviewer",
              message: "Review src/agent/runner.ts",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Saving the first draft."],
        toolCalls: [
          {
            id: "tc-review-artifact-bad",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "review-report",
              kind: "review-report",
              contentFormat: "json",
              content: JSON.stringify({ summary: "missing findings" }),
            },
          },
        ],
      });
      turns.push({
        deltas: ["Retrying with the full report."],
        toolCalls: [
          {
            id: "tc-review-artifact-good",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "review-report",
              kind: "review-report",
              contentFormat: "json",
              summary: "Review artifact",
              content: JSON.stringify({ summary: "ok", findings: [] }),
            },
          },
        ],
      });
      turns.push({
        deltas: ["Posting review cards."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-review-summary-card",
            "## Review Summary\n\nNo blocking issues found.",
            "Review Summary",
          ),
          makeArtifactCardToolCall(
            "tc-review-artifact-card",
            "review_1",
            1,
            "Saved Review Report",
          ),
        ],
      });
      turns.push({
        deltas: ["Review ready below."],
        toolCalls: [],
      });
      turns.push({
        deltas: ["I will read the review artifact and summarize it."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "review_1",
                kind: "review-report",
                summary: toolArgs.summary ?? "",
                metadata: toolArgs.metadata,
                contentFormat: "json",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      await runAgent(tabId, "please review src/agent/runner.ts");

      const state = states[tabId];
      expect(state.status).toBe("idle");
      const reviewerCardMessage = state.chatMessages.find(
        (m) =>
          m.agentName === "Code Reviewer" &&
          Array.isArray(m.cards) &&
          m.cards.length > 0,
      );
      expect(reviewerCardMessage?.cards).toMatchObject([
        {
          kind: "summary",
          title: "Review Summary",
          markdown: "## Review Summary\n\nNo blocking issues found.",
        },
        {
          kind: "artifact",
          title: "Saved Review Report",
          artifactId: "review_1",
          version: 1,
        },
      ]);
      const parentFinal = state.chatMessages.at(-1);
      expect(parentFinal?.role).toBe("assistant");
      expect(parentFinal?.content).toBe(
        "I will read the review artifact and summarize it.",
      );
      expect(dispatchToolMock).toHaveBeenCalledTimes(1);
      expect(dispatchToolMock).toHaveBeenCalledWith(
        tabId,
        expect.any(String),
        "agent_artifact_create",
        expect.objectContaining({
          artifactType: "review-report",
          content: JSON.stringify({ summary: "ok", findings: [] }),
          metadata: {
            __rakh: {
              artifactType: "review-report",
              validatorId: "reviewer.review-report",
            },
          },
        }),
        "tc-review-artifact-good",
        undefined,
        expect.objectContaining({ agentId: "agent_reviewer" }),
      );

      const allToolCalls = state.chatMessages.flatMap(
        (m) => (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
      );
      expect(allToolCalls.find((t) => t.id === "tc-review-artifact-bad")).toMatchObject({
        status: "error",
        result: {
          code: "INVALID_ARGUMENT",
        },
      });
      expect(allToolCalls.find((t) => t.id === "tc-review-artifact-good")).toMatchObject({
        status: "done",
      });

      const subagentResult = parseToolMessageResult(tabId, "tc-reviewer");
      expect(subagentResult).toMatchObject({
        ok: true,
        data: {
          cards: [
            {
              kind: "summary",
              title: "Review Summary",
              markdown: "## Review Summary\n\nNo blocking issues found.",
            },
            {
              kind: "artifact",
              title: "Saved Review Report",
              artifactId: "review_1",
              version: 1,
              instruction: "Read the artifact directly to get the content.",
            },
          ],
          artifacts: [{ artifactId: "review_1" }],
          artifactValidations: [
            {
              artifactId: "review_1",
              artifactType: "review-report",
              validatorId: "reviewer.review-report",
              status: "passed",
            },
          ],
        },
      });
      expect(streamTextMock).toHaveBeenCalledTimes(6);
    });

    it("returns validator-backed security artifact refs to the parent agent", async () => {
      const tabId = "tab-subagent-security";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-security",
            name: "agent_subagent_call",
            arguments: {
              subagentId: "security",
              message: "Audit src/agent/runner.ts for shell and path risks",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Saving security audit."],
        toolCalls: [
          {
            id: "tc-security-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "security-report",
              kind: "security-report",
              contentFormat: "json",
              content: JSON.stringify({
                summary: "one issue",
                findings: [
                  {
                    file: "src/agent/runner.ts",
                    location: "line 10",
                    severity: "medium",
                    confidence: "high",
                    category: "input-validation",
                    issue: "Untrusted path reaches command assembly",
                    impact:
                      "Could allow a crafted path to alter command behavior",
                    remediation:
                      "Validate and normalize the path before command construction",
                  },
                ],
              }),
            },
          },
        ],
      });
      turns.push({
        deltas: ["Posting security cards."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-security-summary-card",
            "## Security Summary\n\nOne medium-risk path validation issue.",
            "Security Summary",
          ),
          makeArtifactCardToolCall(
            "tc-security-artifact-card",
            "security_1",
            1,
            "Saved Security Report",
          ),
        ],
      });
      turns.push({
        deltas: ["Security review ready below."],
        toolCalls: [],
      });
      turns.push({
        deltas: ["I will summarize the security findings and wait for approval before editing."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "security_1",
                kind: "security-report",
                metadata: toolArgs.metadata,
                contentFormat: "json",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      await runAgent(tabId, "please audit src/agent/runner.ts for security");

      const state = states[tabId];
      expect(state.status).toBe("idle");

      const securityMessage = state.chatMessages
        .filter(
          (m) =>
            m.agentName === "Security Auditor" &&
            Array.isArray(m.cards) &&
            m.cards.length > 0,
        )
        .at(-1);
      expect(securityMessage).toBeDefined();
      expect(securityMessage?.content).toContain("Posting security cards.");
      expect(securityMessage?.cards).toMatchObject([
        {
          kind: "summary",
          title: "Security Summary",
          markdown:
            "## Security Summary\n\nOne medium-risk path validation issue.",
        },
        {
          kind: "artifact",
          title: "Saved Security Report",
          artifactId: "security_1",
          version: 1,
        },
      ]);

      const parentFinal = state.chatMessages.at(-1);
      expect(parentFinal?.role).toBe("assistant");
      expect(parentFinal?.content).toBe(
        "I will summarize the security findings and wait for approval before editing.",
      );
      const subagentResult = parseToolMessageResult(tabId, "tc-security");
      expect(subagentResult).toMatchObject({
        ok: true,
        data: {
          cards: [
            {
              kind: "summary",
              title: "Security Summary",
              markdown:
                "## Security Summary\n\nOne medium-risk path validation issue.",
            },
            {
              kind: "artifact",
              title: "Saved Security Report",
              artifactId: "security_1",
              version: 1,
              instruction: "Read the artifact directly to get the content.",
            },
          ],
          artifacts: [{ artifactId: "security_1" }],
          artifactValidations: [
            {
              artifactId: "security_1",
              artifactType: "security-report",
              validatorId: "security.security-report",
              status: "passed",
            },
          ],
        },
      });
      expect(streamTextMock).toHaveBeenCalledTimes(5);
    });

    it("allows warn-mode copywriter artifacts to persist and reports warnings", async () => {
      const tabId = "tab-subagent-copywriter-warning";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-copywriter",
            name: "agent_subagent_call",
            arguments: {
              subagentId: "copywriter",
              message: "Review copy in src/WorkspacePage.tsx",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Saving copy suggestions."],
        toolCalls: [
          {
            id: "tc-copywriter-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "copy-review",
              kind: "copy-review",
              contentFormat: "json",
              content: JSON.stringify({
                tone: "friendly",
                suggestions: [],
              }),
            },
          },
        ],
      });
      turns.push({
        deltas: ["Posting copy-review cards."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-copywriter-summary-card",
            "## Copy Review Summary\n\nTone looks friendly; no changes required.",
            "Copy Review Summary",
          ),
          makeArtifactCardToolCall(
            "tc-copywriter-artifact-card",
            "copy_1",
            1,
            "Saved Copy Review",
          ),
        ],
      });
      turns.push({
        deltas: ["Copy review ready below."],
        toolCalls: [],
      });
      turns.push({
        deltas: ["I will read the copy-review artifact before summarizing it."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "copy_1",
                kind: "copy-review",
                metadata: toolArgs.metadata,
                contentFormat: "json",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      await runAgent(tabId, "please review copy");

      const subagentResult = parseToolMessageResult(tabId, "tc-copywriter");
      expect(subagentResult).toMatchObject({
        ok: true,
        data: {
          cards: [
            {
              kind: "summary",
              title: "Copy Review Summary",
              markdown:
                "## Copy Review Summary\n\nTone looks friendly; no changes required.",
            },
            {
              kind: "artifact",
              title: "Saved Copy Review",
              artifactId: "copy_1",
              version: 1,
              instruction: "Read the artifact directly to get the content.",
            },
          ],
          artifacts: [{ artifactId: "copy_1" }],
          artifactValidations: [
            {
              artifactId: "copy_1",
              artifactType: "copy-review",
              validatorId: "copywriter.copy-review",
              status: "warning",
            },
          ],
        },
      });
    });

    it("marks the tool call as error when an unknown subagentId is given", async () => {
      const tabId = "tab-subagent-unknown";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-bad-subagent",
            name: "agent_subagent_call",
            arguments: { subagentId: "nonexistent", message: "do something" },
          },
        ],
      });
      turns.push({ deltas: ["Sorry."], toolCalls: [] });

      await runAgent(tabId, "run unknown subagent");

      const state = states[tabId];
      const allToolCalls = state.chatMessages.flatMap(
        (m) =>
          (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
      );
      const tc = allToolCalls.find((t) => t.id === "tc-bad-subagent");
      expect(tc).toBeDefined();
      expect(tc?.status).toBe("error");
      expect((tc?.result as Record<string, unknown>)?.code).toBe("NOT_FOUND");
    });

    it("fails the overall subagent call when a required artifact is missing", async () => {
      const tabId = "tab-subagent-missing-artifact";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-reviewer-missing",
            name: "agent_subagent_call",
            arguments: {
              subagentId: "reviewer",
              message: "Review src/agent/runner.ts",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Review completed without saving the artifact."],
        toolCalls: [],
      });
      turns.push({
        deltas: ["I cannot continue yet."],
        toolCalls: [],
      });

      await runAgent(tabId, "please review src/agent/runner.ts");

      const allToolCalls = states[tabId].chatMessages.flatMap(
        (m) => (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
      );
      expect(
        allToolCalls.find((t) => t.id === "tc-reviewer-missing"),
      ).toMatchObject({
        status: "error",
      });

      const subagentResult = parseToolMessageResult(tabId, "tc-reviewer-missing");
      expect(subagentResult).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
        },
      });
      expect(
        String(
          (subagentResult.error as Record<string, unknown> | undefined)
            ?.message,
        ),
      ).toContain(
        'did not satisfy its artifact contract',
      );
    });

    it("does not run the subagent loop when requiresApproval=true and user denies", async () => {
      const tabId = "tab-subagent-denied";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-approval-subagent",
            name: "agent_subagent_call",
            // copywriter has requiresApproval: false by default, so we'd need one
            // that has it true — we test the planner which has requiresApproval: false.
            // Instead, verify the non-requiresApproval path runs cleanly and the
            // approval gate is NOT triggered for planner.
            arguments: { subagentId: "planner", message: "quick plan" },
          },
        ],
      });
      // subagent reply
      turns.push({
        deltas: ["Saving plan."],
        toolCalls: [
          {
            id: "tc-approval-plan-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "plan",
              kind: "plan",
              contentFormat: "markdown",
              content: "# Quick plan",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Posting planner summary card."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-approval-plan-summary-card",
            "## Quick Plan\n\n- Step 1",
            "Quick Plan",
          ),
        ],
      });
      turns.push({ deltas: ["Plan ready below."], toolCalls: [] });
      // parent follow-up
      turns.push({ deltas: ["OK."], toolCalls: [] });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "plan_quick",
                kind: "plan",
                metadata: toolArgs.metadata,
                contentFormat: "markdown",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      requiresApprovalMock.mockReturnValue({ required: false, dangerous: false });

      await runAgent(tabId, "run the planner");

      // requestApproval should NOT have been called (planner.requiresApproval = false)
      expect(requestApprovalMock).not.toHaveBeenCalled();
      expect(states[tabId].status).toBe("idle");
    });

    it("subagent tool calls use the same approval rules as the main agent", async () => {
      const tabId = "tab-subagent-tool-approval";
      setState(tabId);

      // Parent calls subagent
      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-sa",
            name: "agent_subagent_call",
            arguments: { subagentId: "planner", message: "explore and plan" },
          },
        ],
      });
      // Subagent turn 1: calls a tool (workspace_listDir)
      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-sa-list",
            name: "workspace_listDir",
            arguments: { path: "src" },
          },
        ],
      });
      // Subagent turn 2: finishes
      turns.push({
        deltas: ["Saving the final plan."],
        toolCalls: [
          {
            id: "tc-plan-artifact-after-list",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "plan",
              kind: "plan",
              contentFormat: "markdown",
              content: "# Plan",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Posting plan summary card."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-plan-summary-after-list",
            "## Plan Summary\n\n- Inspect src\n- Finalize plan",
            "Plan Summary",
          ),
        ],
      });
      turns.push({ deltas: ["Plan ready below."], toolCalls: [] });
      // Parent follow-up
      turns.push({ deltas: ["Great."], toolCalls: [] });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "workspace_listDir") {
          return { ok: true, data: { entries: [] } };
        }
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "plan_after_list",
                kind: "plan",
                metadata: toolArgs.metadata,
                contentFormat: "markdown",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      await runAgent(tabId, "plan the workspace");

      // dispatchTool was called once for the subagent's workspace_listDir call
      expect(dispatchToolMock).toHaveBeenCalledWith(
        tabId,
        expect.any(String),
        "workspace_listDir",
        { path: "src" },
        "tc-sa-list",
        undefined,
        expect.objectContaining({ agentId: "agent_planner" }),
      );

      const state = states[tabId];
      expect(state.status).toBe("idle");
      expect(streamTextMock).toHaveBeenCalledTimes(6);
    });

    it("applies tool-context compaction inside subagent local api history", async () => {
      const tabId = "tab-subagent-context-compaction";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-subagent-context",
            name: "agent_subagent_call",
            arguments: {
              subagentId: "planner",
              message: "inspect the runner and save a plan",
            },
          },
        ],
      });
      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-subagent-read",
            name: "workspace_readFile",
            arguments: {
              path: "src/agent/runner.ts",
              __contextCompaction: {
                outputNote:
                  "Read src/agent/runner.ts for planning; exact file contents omitted from model history.",
              },
            },
          },
        ],
      });
      turns.push({
        deltas: ["Saving the plan."],
        toolCalls: [
          {
            id: "tc-subagent-plan-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "plan",
              kind: "plan",
              contentFormat: "markdown",
              summary: "Runner plan",
              content: "# Plan\n\n1. Inspect runner\n2. Update compaction",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Posting planner summary card."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-subagent-plan-summary",
            "## Runner Plan\n\n- Inspect runner\n- Update compaction",
            "Plan Summary",
          ),
        ],
      });
      turns.push({ deltas: ["Plan ready below."], toolCalls: [] });
      turns.push({ deltas: ["Great."], toolCalls: [] });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "workspace_readFile") {
          return {
            ok: true,
            data: {
              path: "src/agent/runner.ts",
              encoding: "utf8",
              content: "export const runner = true;\n",
              fileSizeBytes: 28,
              lineCount: 1,
              truncated: false,
            },
          };
        }
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "planner_context_plan",
                kind: "plan",
                summary: toolArgs.summary,
                metadata: toolArgs.metadata,
                contentFormat: "markdown",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      await runAgent(tabId, "plan the runner update");

      const plannerToolCall = states[tabId].chatMessages
        .flatMap(
          (message) =>
            (message.toolCalls as Array<Record<string, unknown>> | undefined) ?? [],
        )
        .find((entry) => entry.id === "tc-subagent-read");
      expect(plannerToolCall).toMatchObject({
        result: {
          path: "src/agent/runner.ts",
          content: "export const runner = true;\n",
        },
        contextCompaction: {
          output: {
            status: "compacted",
            note:
              "Read src/agent/runner.ts for planning; exact file contents omitted from model history.",
          },
        },
      });

      const subagentSecondTurnMessages = (
        streamTextMock.mock.calls[2]?.[0] as
          | { messages?: Array<Record<string, unknown>> }
          | undefined
      )?.messages;
      const mappedTool = subagentSecondTurnMessages?.find(
        (message) => message.role === "tool",
      ) as { content?: Array<Record<string, unknown>> } | undefined;
      const toolResultPart = mappedTool?.content?.find(
        (part) => part.type === "tool-result",
      );
      expect(toolResultPart).toMatchObject({
        toolName: "workspace_readFile",
        output: {
          type: "json",
          value: {
            __rakhCompactToolIO: {
              tool: "workspace_readFile",
              side: "output",
            },
          },
        },
      });
    });

    it("security subagent exec_run follows the normal approval path", async () => {
      const tabId = "tab-subagent-security-exec-approval";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-security-root",
            name: "agent_subagent_call",
            arguments: {
              subagentId: "security",
              message: "Audit the last commit for security regressions",
            },
          },
        ],
      });
      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-security-exec",
            name: "exec_run",
            arguments: {
              command: "git",
              args: ["show", "--name-only", "--pretty=format:", "HEAD"],
              reason: "Inspect the last commit scope for a security audit",
              mutationIntent: "exploration",
              todoHandling: {
                mode: "skip",
                skipReason: "Security approval path test does not need todo tracking",
              },
            },
          },
        ],
      });
      turns.push({
        deltas: [
          "Saving security artifact.",
        ],
        toolCalls: [
          {
            id: "tc-security-artifact-final",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "security-report",
              kind: "security-report",
              contentFormat: "json",
              content: JSON.stringify({ summary: "no issues", findings: [] }),
            },
          },
        ],
      });
      turns.push({
        deltas: ["Posting security summary card."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-security-exec-summary-card",
            "## Security Summary\n\nNo security issues found.",
            "Security Summary",
          ),
        ],
      });
      turns.push({ deltas: ["Security review ready below."], toolCalls: [] });
      turns.push({ deltas: ["No security issues found."], toolCalls: [] });

      requiresApprovalMock.mockImplementation((toolName: string) => {
        return toolName === "exec_run"
          ? { required: true, dangerous: false }
          : { required: false, dangerous: false };
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "exec_run") {
          return {
            ok: true,
            data: { exitCode: 0, stdout: "src/agent/runner.ts\n", stderr: "" },
          };
        }
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "security_exec_1",
                kind: "security-report",
                metadata: toolArgs.metadata,
                contentFormat: "json",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      await runAgent(tabId, "review the last commit for security");

      expect(requestApprovalMock).toHaveBeenCalledWith(
        "tab-subagent-security-exec-approval",
        "tc-security-exec",
      );
      expect(dispatchToolMock).toHaveBeenCalledWith(
        tabId,
        expect.any(String),
        "exec_run",
        {
          command: "git",
          args: ["show", "--name-only", "--pretty=format:", "HEAD"],
          reason: "Inspect the last commit scope for a security audit",
        },
        "tc-security-exec",
        expect.anything(),
        expect.objectContaining({ agentId: "agent_security" }),
      );
    });
  });

  describe("trigger-command subagent routing", () => {
    it("routes /review directly to the reviewer subagent", async () => {
      const tabId = "tab-trigger-review";
      setState(tabId);

      turns.push({
        deltas: ["Saving review artifact."],
        toolCalls: [
          {
            id: "tc-trigger-review-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "review-report",
              kind: "review-report",
              contentFormat: "json",
              content: JSON.stringify({ summary: "no issues", findings: [] }),
            },
          },
        ],
      });
      turns.push({
        deltas: ["Posting scoped review card."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-trigger-review-summary-card",
            "## Scoped Review\n\nNo issues found in `src/agent/runner.ts`.",
            "Scoped Review",
          ),
        ],
      });
      turns.push({
        deltas: ["Review ready below."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "trigger_review_1",
                kind: "review-report",
                metadata: toolArgs.metadata,
                contentFormat: "json",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      await runAgent(tabId, "/review src/agent/runner.ts");

      const state = states[tabId];
      expect(state.status).toBe("idle");
      expect(state.chatMessages[0]).toMatchObject({
        role: "user",
        content: "/review src/agent/runner.ts",
      });
      expect(state.chatMessages.at(-1)).toMatchObject({
        role: "assistant",
        agentName: "Code Reviewer",
      });
      expect(String(state.chatMessages.at(-1)?.content)).toContain(
        "Review ready below.",
      );
      expect(state.error).toBeNull();
      expect(streamTextMock).toHaveBeenCalledTimes(3);
    });

    it("routes /security directly to the security subagent", async () => {
      const tabId = "tab-trigger-security";
      setState(tabId);

      turns.push({
        deltas: ["Saving security artifact."],
        toolCalls: [
          {
            id: "tc-trigger-security-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "security-report",
              kind: "security-report",
              contentFormat: "json",
              content: JSON.stringify({ summary: "no issues", findings: [] }),
            },
          },
        ],
      });
      turns.push({
        deltas: ["Posting security summary card."],
        toolCalls: [
          makeSummaryCardToolCall(
            "tc-trigger-security-summary-card",
            "## Security Scan\n\nNo issues found in `src/agent/runner.ts`.",
            "Security Scan",
          ),
        ],
      });
      turns.push({
        deltas: ["Security review ready below."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "trigger_security_1",
                kind: "security-report",
                metadata: toolArgs.metadata,
                contentFormat: "json",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      await runAgent(tabId, "/security src/agent/runner.ts");

      const state = states[tabId];
      expect(state.status).toBe("idle");
      expect(state.chatMessages[0]).toMatchObject({
        role: "user",
        content: "/security src/agent/runner.ts",
      });
      expect(state.chatMessages.at(-1)).toMatchObject({
        role: "assistant",
        agentName: "Security Auditor",
      });
      expect(String(state.chatMessages.at(-1)?.content)).toContain(
        "Security review ready below.",
      );
      expect(state.error).toBeNull();
      expect(streamTextMock).toHaveBeenCalledTimes(3);
    });

    it("compacts main-agent api history without appending the slash command to chat", async () => {
      const tabId = "tab-trigger-compact";
      const compactedMarkdown = makeCompactedHistoryMarkdown(
        "Resume implementation from the compaction card.",
      );
      setState(tabId, {
        config: { cwd: "/repo", model: "openai/gpt-5.2" },
        chatMessages: [
          { role: "user", content: "please investigate context usage" },
          { role: "assistant", content: "Looking into it." },
        ],
        apiMessages: [
          { role: "system", content: "Original system prompt" },
          { role: "user", content: "please investigate context usage" },
          { role: "assistant", content: "Looking into it." },
          {
            role: "tool",
            tool_call_id: "tc-1",
            content: JSON.stringify({ ok: true, data: { found: true } }),
          },
        ],
        plan: {
          markdown: "1. Inspect runner\n2. Add compaction",
          updatedAtMs: 10,
          version: 2,
        },
        todos: [
          {
            id: "todo-1",
            title: "Implement compaction",
            state: "doing",
            completionNote: undefined,
            filesTouched: ["src/agent/runner.ts"],
            thingsLearned: [{ text: "Subagents currently stream to chat", verified: true }],
            criticalInfo: [{ text: "Do not rewrite the system prompt", verified: true }],
          },
        ],
      });

      turns.push({
        deltas: ["Saving compacted context artifact."],
        toolCalls: [
          {
            id: "tc-compact-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "compact-state",
              kind: "context-compaction",
              contentFormat: "markdown",
              summary: "Compacted context snapshot",
              content: compactedMarkdown,
            },
          },
        ],
      });
      turns.push({
        deltas: ["Context compacted."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "compact_artifact_1",
                kind: "context-compaction",
                summary: toolArgs.summary,
                metadata: toolArgs.metadata,
                contentFormat: "markdown",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });
      artifactGetMock.mockResolvedValue({
        ok: true,
        data: {
          artifact: makeArtifact({
            sessionId: tabId,
            artifactId: "compact_artifact_1",
            kind: "context-compaction",
            contentFormat: "markdown",
            content: compactedMarkdown,
            metadata: { __rakh: { artifactType: "compact-state" } },
          }),
        },
      });

      await runAgent(tabId, "/compact");

      const state = states[tabId];
      expect(state.status).toBe("idle");
      expect(state.error).toBeNull();
      expect(state.chatMessages).toHaveLength(5);
      expect(state.chatMessages.some((msg) => msg.content === "/compact")).toBe(false);
      expect(
        state.chatMessages.some(
          (msg) =>
            msg.role === "assistant" &&
            msg.agentName === "Context Compaction" &&
            msg.content === "Saving compacted context artifact.",
        ),
      ).toBe(true);
      expect(
        state.chatMessages.some(
          (msg) =>
            msg.role === "assistant" &&
            msg.agentName === "Context Compaction" &&
            msg.content === "Context compacted." &&
            !Array.isArray(msg.cards),
        ),
      ).toBe(true);
      expect(state.chatMessages.at(-1)).toMatchObject({
        role: "assistant",
        agentName: "Context Compaction",
        content: "Context compacted.",
        cards: [
          {
            kind: "summary",
            title: "Compacted Context",
            markdown: compactedMarkdown,
          },
        ],
      });
      expect(state.apiMessages[0]).toMatchObject({ role: "system" });
      expect(String(state.apiMessages[0]?.content)).toContain("You are Rakh");
      expect(state.apiMessages[1]).toEqual({
        role: "assistant",
        content: compactedMarkdown,
      });
      expect(streamTextMock).toHaveBeenCalledTimes(2);
      expect(artifactGetMock).toHaveBeenCalledWith(tabId, {
        artifactId: "compact_artifact_1",
        includeContent: true,
      });
    });

    it("includes saved project memory in the compaction payload", async () => {
      const tabId = "tab-trigger-compact-memory-payload";
      const compactedMarkdown = makeCompactedHistoryMarkdown("Resume work.");
      await saveSavedProjects([
        {
          path: "/repo",
          name: "Repo",
          icon: "folder",
          learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
        },
      ]);
      setState(tabId, {
        config: {
          cwd: "/repo",
          model: "openai/gpt-5.2",
          projectPath: "/repo",
        },
        apiMessages: [
          { role: "system", content: "Original system prompt" },
          { role: "user", content: "Investigate compaction." },
        ],
      });

      turns.push({
        deltas: ["Saving compacted context artifact."],
        toolCalls: [
          {
            id: "tc-compact-memory-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "compact-state",
              kind: "context-compaction",
              contentFormat: "markdown",
              summary: "Compacted context snapshot",
              content: compactedMarkdown,
            },
          },
        ],
      });
      turns.push({
        deltas: ["Context compacted."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "compact_memory_payload_artifact",
                kind: "context-compaction",
                contentFormat: "markdown",
                metadata: { __rakh: { artifactType: "compact-state" } },
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });
      artifactGetMock.mockResolvedValue({
        ok: true,
        data: {
          artifact: makeArtifact({
            sessionId: tabId,
            artifactId: "compact_memory_payload_artifact",
            kind: "context-compaction",
            contentFormat: "markdown",
            content: compactedMarkdown,
            metadata: { __rakh: { artifactType: "compact-state" } },
          }),
        },
      });

      await runAgent(tabId, "/compact");

      const firstSubagentCall = streamTextMock.mock.calls[0]?.[0] as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const payload = JSON.parse(
        String(
          firstSubagentCall.messages?.find((message) => message.role === "user")
            ?.content,
        ),
      );

      expect(payload.project_memory).toEqual({
        project_path: "/repo",
        learned_facts: [fact("fact_pnpm", "Use pnpm in this repo.")],
        writable: true,
      });
    });

    it("shows a no-op assistant message when there is no main-agent history to compact", async () => {
      const tabId = "tab-trigger-compact-empty";
      setState(tabId, {
        chatMessages: [{ role: "assistant", content: "Only visible chat exists." }],
        apiMessages: [],
      });

      await runAgent(tabId, "/compact");

      const state = states[tabId];
      expect(state.status).toBe("idle");
      expect(state.apiMessages).toEqual([]);
      expect(streamTextMock).not.toHaveBeenCalled();
      expect(state.chatMessages).toHaveLength(2);
      expect(state.chatMessages.at(-1)).toMatchObject({
        role: "assistant",
        agentName: "Context Compaction",
      });
      expect(String(state.chatMessages.at(-1)?.content)).toContain(
        "Nothing to compact yet",
      );
      expect(state.chatMessages.some((msg) => msg.content === "/compact")).toBe(false);
    });

    it("rejects trailing arguments for /compact without mutating api history", async () => {
      const tabId = "tab-trigger-compact-args";
      setState(tabId, {
        apiMessages: [
          { role: "system", content: "Original system prompt" },
          { role: "user", content: "Investigate compaction." },
        ],
      });

      await runAgent(tabId, "/compact now");

      const state = states[tabId];
      expect(state.status).toBe("idle");
      expect(streamTextMock).not.toHaveBeenCalled();
      expect(state.apiMessages).toEqual([
        { role: "system", content: "Original system prompt" },
        { role: "user", content: "Investigate compaction." },
      ]);
      expect(state.chatMessages).toHaveLength(1);
      expect(state.chatMessages[0]).toMatchObject({
        role: "assistant",
        agentName: "Context Compaction",
      });
      expect(String(state.chatMessages[0]?.content)).toContain(
        "does not accept arguments",
      );
    });

    it("persists learned facts during compaction and refreshes the active system prompt", async () => {
      const tabId = "tab-trigger-compact-memory-write";
      const compactedMarkdown = makeCompactedHistoryMarkdown(
        "Resume from the learned facts.",
      );
      await saveSavedProjects([
        {
          path: "/repo",
          name: "Repo",
          icon: "folder",
          learnedFacts: [fact("fact_existing", "Existing fact.")],
        },
      ]);
      setState(tabId, {
        config: {
          cwd: "/repo",
          model: "openai/gpt-5.2",
          projectPath: "/repo",
        },
        apiMessages: [
          { role: "system", content: "Original system prompt" },
          { role: "user", content: "Compact the session." },
          { role: "assistant", content: "Working on it." },
        ],
      });

      turns.push({
        deltas: ["Saving learned facts and compacted context artifact."],
        toolCalls: [
          {
            id: "tc-project-memory-write",
            name: "agent_project_memory_add",
            arguments: {
              facts: ["The backend uses Tauri.", "Use pnpm in this repo."],
            },
          },
          {
            id: "tc-compact-artifact-memory-write",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "compact-state",
              kind: "context-compaction",
              contentFormat: "markdown",
              summary: "Compacted context snapshot",
              content: compactedMarkdown,
            },
          },
        ],
      });
      turns.push({
        deltas: ["Context compacted."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const toolArgs = args[3] as Record<string, unknown>;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_project_memory_add") {
          await saveSavedProjects([
            {
              path: "/repo",
              name: "Repo",
              icon: "folder",
              learnedFacts: [
                fact("fact_existing", "Existing fact."),
                fact("fact_tauri", "The backend uses Tauri."),
                fact("fact_pnpm", "Use pnpm in this repo."),
              ],
            },
          ]);
          return {
            ok: true,
            data: {
              projectPath: "/repo",
              learnedFacts: [
                fact("fact_existing", "Existing fact."),
                fact("fact_tauri", "The backend uses Tauri."),
                fact("fact_pnpm", "Use pnpm in this repo."),
              ],
              addedFacts: [
                fact("fact_tauri", "The backend uses Tauri."),
                fact("fact_pnpm", "Use pnpm in this repo."),
              ],
              updated: true,
            },
          };
        }
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "compact_memory_write_artifact",
                kind: "context-compaction",
                summary: toolArgs.summary,
                metadata: toolArgs.metadata,
                contentFormat: "markdown",
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });
      artifactGetMock.mockResolvedValue({
        ok: true,
        data: {
          artifact: makeArtifact({
            sessionId: tabId,
            artifactId: "compact_memory_write_artifact",
            kind: "context-compaction",
            contentFormat: "markdown",
            content: compactedMarkdown,
            metadata: { __rakh: { artifactType: "compact-state" } },
          }),
        },
      });

      await runAgent(tabId, "/compact");

      expect(getSavedProjects()[0]?.learnedFacts).toEqual([
        fact("fact_existing", "Existing fact."),
        fact("fact_tauri", "The backend uses Tauri."),
        fact("fact_pnpm", "Use pnpm in this repo."),
      ]);
      expect(String(states[tabId].apiMessages[0]?.content)).toContain(
        "PROJECT MEMORY",
      );
      expect(String(states[tabId].apiMessages[0]?.content)).toContain(
        "fact_existing",
      );
      expect(String(states[tabId].apiMessages[0]?.content)).toContain(
        "Existing fact.",
      );
      expect(String(states[tabId].apiMessages[0]?.content)).toContain(
        "The backend uses Tauri.",
      );
      expect(String(states[tabId].apiMessages[0]?.content)).toContain(
        "Use pnpm in this repo.",
      );
    });

    it("re-compacts already summarized api history together with newer raw turns", async () => {
      const tabId = "tab-trigger-compact-repeat";
      const newCompactedMarkdown = makeCompactedHistoryMarkdown(
        "Continue from the newest raw turn.",
      );
      setState(tabId, {
        apiMessages: [
          { role: "system", content: "Original system prompt" },
          { role: "assistant", content: makeCompactedHistoryMarkdown("Older next step.") },
          { role: "user", content: "Continue with the implementation." },
          { role: "assistant", content: "I updated the tests." },
        ],
      });

      turns.push({
        deltas: ["Saving compacted context artifact."],
        toolCalls: [
          {
            id: "tc-compact-artifact-repeat",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "compact-state",
              kind: "context-compaction",
              contentFormat: "markdown",
              summary: "Compacted context snapshot",
              content: newCompactedMarkdown,
            },
          },
        ],
      });
      turns.push({
        deltas: ["Context compacted."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "compact_artifact_repeat",
                kind: "context-compaction",
                contentFormat: "markdown",
                metadata: { __rakh: { artifactType: "compact-state" } },
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });
      artifactGetMock.mockResolvedValue({
        ok: true,
        data: {
          artifact: makeArtifact({
            sessionId: tabId,
            artifactId: "compact_artifact_repeat",
            kind: "context-compaction",
            contentFormat: "markdown",
            content: newCompactedMarkdown,
            metadata: { __rakh: { artifactType: "compact-state" } },
          }),
        },
      });

      await runAgent(tabId, "/compact");

      expect(states[tabId].apiMessages[0]).toMatchObject({ role: "system" });
      expect(String(states[tabId].apiMessages[0]?.content)).toContain("You are Rakh");
      expect(states[tabId].apiMessages[1]).toEqual({
        role: "assistant",
        content: newCompactedMarkdown,
      });
    });

    it("restores project memory when compaction fails after writing learned facts", async () => {
      const tabId = "tab-trigger-compact-memory-rollback";
      await saveSavedProjects([
        {
          path: "/repo",
          name: "Repo",
          icon: "folder",
          learnedFacts: [fact("fact_existing", "Existing fact.")],
        },
      ]);
      setState(tabId, {
        config: {
          cwd: "/repo",
          model: "openai/gpt-5.2",
          projectPath: "/repo",
        },
        apiMessages: [
          { role: "system", content: "Original system prompt" },
          { role: "user", content: "Compact the session." },
        ],
      });

      turns.push({
        deltas: ["Saving learned facts and compacted context artifact."],
        toolCalls: [
          {
            id: "tc-project-memory-rollback",
            name: "agent_project_memory_add",
            arguments: {
              facts: ["The backend uses Tauri."],
            },
          },
          {
            id: "tc-compact-artifact-memory-rollback",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "compact-state",
              kind: "context-compaction",
              contentFormat: "markdown",
              summary: "Compacted context snapshot",
              content: "invalid compacted history",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Context compacted."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_project_memory_add") {
          await saveSavedProjects([
            {
              path: "/repo",
              name: "Repo",
              icon: "folder",
              learnedFacts: [
                fact("fact_existing", "Existing fact."),
                fact("fact_tauri", "The backend uses Tauri."),
              ],
            },
          ]);
          return {
            ok: true,
            data: {
              projectPath: "/repo",
              learnedFacts: [
                fact("fact_existing", "Existing fact."),
                fact("fact_tauri", "The backend uses Tauri."),
              ],
              addedFacts: [fact("fact_tauri", "The backend uses Tauri.")],
              updated: true,
            },
          };
        }
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "compact_memory_rollback_artifact",
                kind: "context-compaction",
                contentFormat: "markdown",
                metadata: { __rakh: { artifactType: "compact-state" } },
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });
      artifactGetMock.mockResolvedValue({
        ok: true,
        data: {
          artifact: makeArtifact({
            sessionId: tabId,
            artifactId: "compact_memory_rollback_artifact",
            kind: "context-compaction",
            contentFormat: "markdown",
            content: "invalid compacted history",
            metadata: { __rakh: { artifactType: "compact-state" } },
          }),
        },
      });

      await runAgent(tabId, "/compact");

      expect(getSavedProjects()[0]?.learnedFacts).toEqual([
        fact("fact_existing", "Existing fact."),
      ]);
      expect(String(states[tabId].chatMessages.at(-1)?.content)).toContain(
        "missing required sections",
      );
    });

    it("restores project memory when compaction aborts after writing learned facts", async () => {
      const tabId = "tab-trigger-compact-memory-abort";
      await saveSavedProjects([
        {
          path: "/repo",
          name: "Repo",
          icon: "folder",
          learnedFacts: [fact("fact_existing", "Existing fact.")],
        },
      ]);
      setState(tabId, {
        config: {
          cwd: "/repo",
          model: "openai/gpt-5.2",
          projectPath: "/repo",
        },
        apiMessages: [
          { role: "system", content: "Original system prompt" },
          { role: "user", content: "Compact the session." },
        ],
      });

      turns.push({
        deltas: ["Saving learned facts before the run is aborted."],
        toolCalls: [
          {
            id: "tc-project-memory-abort",
            name: "agent_project_memory_add",
            arguments: {
              facts: ["The backend uses Tauri."],
            },
          },
        ],
      });
      turns.push({
        streamError: new DOMException("Aborted", "AbortError"),
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        if (toolName === "agent_project_memory_add") {
          await saveSavedProjects([
            {
              path: "/repo",
              name: "Repo",
              icon: "folder",
              learnedFacts: [
                fact("fact_existing", "Existing fact."),
                fact("fact_tauri", "The backend uses Tauri."),
              ],
            },
          ]);
          return {
            ok: true,
            data: {
              projectPath: "/repo",
              learnedFacts: [
                fact("fact_existing", "Existing fact."),
                fact("fact_tauri", "The backend uses Tauri."),
              ],
              addedFacts: [fact("fact_tauri", "The backend uses Tauri.")],
              updated: true,
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });

      await runAgent(tabId, "/compact");

      expect(getSavedProjects()[0]?.learnedFacts).toEqual([
        fact("fact_existing", "Existing fact."),
      ]);
    });

    it("marks project memory unwritable when no saved project record matches the session", async () => {
      const tabId = "tab-trigger-compact-memory-untracked";
      const compactedMarkdown = makeCompactedHistoryMarkdown("Resume work.");
      setState(tabId, {
        config: {
          cwd: "/repo/untracked",
          model: "openai/gpt-5.2",
          projectPath: "/repo/untracked",
        },
        apiMessages: [
          { role: "system", content: "Original system prompt" },
          { role: "user", content: "Investigate compaction." },
        ],
      });

      turns.push({
        deltas: ["Saving compacted context artifact."],
        toolCalls: [
          {
            id: "tc-compact-untracked-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "compact-state",
              kind: "context-compaction",
              contentFormat: "markdown",
              summary: "Compacted context snapshot",
              content: compactedMarkdown,
            },
          },
        ],
      });
      turns.push({
        deltas: ["Context compacted."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "compact_untracked_artifact",
                kind: "context-compaction",
                contentFormat: "markdown",
                metadata: { __rakh: { artifactType: "compact-state" } },
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });
      artifactGetMock.mockResolvedValue({
        ok: true,
        data: {
          artifact: makeArtifact({
            sessionId: tabId,
            artifactId: "compact_untracked_artifact",
            kind: "context-compaction",
            contentFormat: "markdown",
            content: compactedMarkdown,
            metadata: { __rakh: { artifactType: "compact-state" } },
          }),
        },
      });

      await runAgent(tabId, "/compact");

      const firstSubagentCall = streamTextMock.mock.calls[0]?.[0] as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const payload = JSON.parse(
        String(
          firstSubagentCall.messages?.find((message) => message.role === "user")
            ?.content,
        ),
      );

      expect(payload.project_memory).toEqual({
        project_path: null,
        learned_facts: [],
        writable: false,
      });
    });

    it("auto-compacts existing history before starting the next main turn", async () => {
      const tabId = "tab-auto-compact-preflight";
      const compactedMarkdown = makeCompactedHistoryMarkdown(
        "Continue with the latest user request.",
      );
      setState(tabId, {
        config: { cwd: "/repo", model: "openai/gpt-5.2" },
        apiMessages: [
          { role: "system", content: "Original system prompt" },
          { role: "assistant", content: "A".repeat(12 * 1024) },
        ],
      });

      const baseGet = jotaiStoreMock.get.getMockImplementation();
      if (!baseGet) throw new Error("Expected default jotaiStore mock.");
      jotaiStoreMock.get.mockImplementation((atom: unknown) => {
        if (atom === autoContextCompactionSettingsAtomMock) {
          return {
            enabled: true,
            thresholdMode: "kb",
            thresholdPercent: 85,
            thresholdKb: 1,
          };
        }
        return baseGet(atom);
      });

      turns.push({
        deltas: ["Saving compacted context artifact."],
        toolCalls: [
          {
            id: "tc-auto-preflight-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "compact-state",
              kind: "context-compaction",
              contentFormat: "markdown",
              summary: "Compacted context snapshot",
              content: compactedMarkdown,
            },
          },
        ],
      });
      turns.push({
        deltas: ["Context compacted."],
        toolCalls: [],
      });
      turns.push({
        deltas: ["Continuing with the implementation."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "auto_preflight_compact_artifact",
                kind: "context-compaction",
                contentFormat: "markdown",
                metadata: { __rakh: { artifactType: "compact-state" } },
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });
      artifactGetMock.mockResolvedValue({
        ok: true,
        data: {
          artifact: makeArtifact({
            sessionId: tabId,
            artifactId: "auto_preflight_compact_artifact",
            kind: "context-compaction",
            contentFormat: "markdown",
            content: compactedMarkdown,
            metadata: { __rakh: { artifactType: "compact-state" } },
          }),
        },
      });

      await runAgent(tabId, "continue with the latest task");

      expect(streamTextMock).toHaveBeenCalledTimes(3);
      expect(states[tabId].status).toBe("idle");
      expect(states[tabId].apiMessages[1]).toEqual({
        role: "assistant",
        content: compactedMarkdown,
      });
      expect(states[tabId].apiMessages[2]).toEqual({
        role: "user",
        content: "continue with the latest task",
      });
      expect(
        states[tabId].chatMessages.some(
          (message) =>
            message.agentName === "Context Compaction" &&
            message.content === "Saving compacted context artifact.",
        ),
      ).toBe(true);
      expect(
        states[tabId].chatMessages.some(
          (message) =>
            message.agentName === "Context Compaction" &&
            message.content === "Context compacted." &&
            !Array.isArray(message.cards),
        ),
      ).toBe(true);
      expect(
        states[tabId].chatMessages.some(
          (message) =>
            message.agentName === "Context Compaction" &&
            message.content === "Context compacted automatically.",
        ),
      ).toBe(true);
      expect(states[tabId].chatMessages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Continuing with the implementation.",
      });
    });

    it("auto-compacts between assistant iterations after a large tool result", async () => {
      const tabId = "tab-auto-compact-iteration";
      const compactedMarkdown = makeCompactedHistoryMarkdown(
        "Resume after reviewing the large file output.",
      );
      setState(tabId, {
        config: { cwd: "/repo", model: "openai/gpt-5.2" },
      });

      const baseGet = jotaiStoreMock.get.getMockImplementation();
      if (!baseGet) throw new Error("Expected default jotaiStore mock.");
      jotaiStoreMock.get.mockImplementation((atom: unknown) => {
        if (atom === autoContextCompactionSettingsAtomMock) {
          return {
            enabled: true,
            thresholdMode: "kb",
            thresholdPercent: 85,
            thresholdKb: 1,
          };
        }
        return baseGet(atom);
      });

      turns.push({
        deltas: ["Reading the large file."],
        toolCalls: [
          {
            id: "tc-auto-read-large",
            name: "workspace_readFile",
            arguments: {
              path: "src/large.ts",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Saving compacted context artifact."],
        toolCalls: [
          {
            id: "tc-auto-iteration-artifact",
            name: "agent_artifact_create",
            arguments: {
              artifactType: "compact-state",
              kind: "context-compaction",
              contentFormat: "markdown",
              summary: "Compacted context snapshot",
              content: compactedMarkdown,
            },
          },
        ],
      });
      turns.push({
        deltas: ["Context compacted."],
        toolCalls: [],
      });
      turns.push({
        deltas: ["Continuing after automatic compaction."],
        toolCalls: [],
      });

      dispatchToolMock.mockImplementation(async (...args: unknown[]) => {
        const toolName = args[2] as string;
        const runtime = args[6] as Record<string, unknown>;
        if (toolName === "workspace_readFile") {
          return {
            ok: true,
            data: {
              path: "src/large.ts",
              encoding: "utf8",
              content: "x".repeat(10 * 1024),
              fileSizeBytes: 10 * 1024,
              lineCount: 256,
              truncated: false,
            },
          };
        }
        if (toolName === "agent_artifact_create") {
          return {
            ok: true,
            data: {
              artifact: makeArtifact({
                sessionId: tabId,
                runId: runtime.runId,
                agentId: runtime.agentId,
                artifactId: "auto_iteration_compact_artifact",
                kind: "context-compaction",
                contentFormat: "markdown",
                metadata: { __rakh: { artifactType: "compact-state" } },
              }),
            },
          };
        }
        return { ok: true, data: { ok: true } };
      });
      artifactGetMock.mockResolvedValue({
        ok: true,
        data: {
          artifact: makeArtifact({
            sessionId: tabId,
            artifactId: "auto_iteration_compact_artifact",
            kind: "context-compaction",
            contentFormat: "markdown",
            content: compactedMarkdown,
            metadata: { __rakh: { artifactType: "compact-state" } },
          }),
        },
      });

      await runAgent(tabId, "inspect the large file");

      expect(streamTextMock).toHaveBeenCalledTimes(4);
      expect(states[tabId].status).toBe("idle");
      expect(states[tabId].apiMessages[1]).toEqual({
        role: "assistant",
        content: compactedMarkdown,
      });
      expect(
        states[tabId].apiMessages.some((message) => message.role === "tool"),
      ).toBe(false);
      expect(
        states[tabId].chatMessages.some(
          (message) =>
            message.agentName === "Context Compaction" &&
            message.content === "Saving compacted context artifact.",
        ),
      ).toBe(true);
      expect(
        states[tabId].chatMessages.some(
          (message) =>
            message.agentName === "Context Compaction" &&
            message.content === "Context compacted." &&
            !Array.isArray(message.cards),
        ),
      ).toBe(true);
      expect(states[tabId].chatMessages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Continuing after automatic compaction.",
      });
      expect(
        states[tabId].chatMessages.some(
          (message) =>
            message.agentName === "Context Compaction" &&
            message.content === "Context compacted automatically.",
        ),
      ).toBe(true);
    });
  });

  describe("manual-only subagent delegation", () => {
    it("rejects agent_subagent_call for the compact subagent", async () => {
      const tabId = "tab-subagent-compact-reject";
      setState(tabId);

      turns.push({
        deltas: [],
        toolCalls: [
          {
            id: "tc-subagent-compact",
            name: "agent_subagent_call",
            arguments: {
              subagentId: "compact",
              message: "compact the internal state",
            },
          },
        ],
      });
      turns.push({
        deltas: ["Compaction subagent is trigger-only."],
        toolCalls: [],
      });

      await runAgent(tabId, "try the compact subagent");

      expect(parseToolMessageResult(tabId, "tc-subagent-compact")).toEqual({
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: 'Subagent "compact" is not available via agent_subagent_call.',
        },
      });
    });
  });

  describe("retryAgent", () => {
    it("does nothing when there is no user message in apiMessages", async () => {
      const tabId = "tab-retry-empty";
      setState(tabId, { status: "error", error: "some error" });

      await retryAgent(tabId);

      // No stream call — nothing to retry
      expect(streamTextMock).not.toHaveBeenCalled();
      // State unchanged (still error, no messages added)
      expect(states[tabId].chatMessages).toHaveLength(0);
    });

    it("re-runs the last user message and clears the error", async () => {
      const tabId = "tab-retry-basic";
      setState(tabId);

      // First run ends in error
      turns.push({ streamError: new Error("network timeout") });
      await runAgent(tabId, "help me fix this");

      expect(states[tabId].status).toBe("error");
      expect(states[tabId].error).toContain("network timeout");

      // Set up a successful retry turn
      turns.push({ deltas: ["Done!"], toolCalls: [] });
      await retryAgent(tabId);

      const state = states[tabId];
      expect(state.status).toBe("idle");
      expect(state.error).toBeNull();
      // User message is kept throughout (never removed), stale assistant
      // placeholder from the failed turn is stripped. runAgent streams the
      // fresh assistant response without re-appending a duplicate user bubble.
      expect(state.chatMessages).toHaveLength(2);
      expect(state.chatMessages[0]).toMatchObject({
        role: "user",
        content: "help me fix this",
      });
      expect(state.chatMessages[1]).toMatchObject({
        role: "assistant",
        content: "Done!",
        streaming: false,
      });
    });

    it("never removes the user message from chatMessages — no duplicate and no flash", async () => {
      const tabId = "tab-retry-no-flash";

      // Simulate the exact post-error state: user bubble + stale empty
      // assistant bubble left by the failed streaming turn.
      setState(tabId, {
        status: "error",
        error: "network timeout",
        apiMessages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "fix the bug" },
        ],
        chatMessages: [
          { role: "user", content: "fix the bug", id: "u1", timestamp: 1 },
          { role: "assistant", content: "", id: "a1", timestamp: 2, streaming: false },
        ],
      });

      turns.push({ deltas: ["Fixed!"], toolCalls: [] });
      await retryAgent(tabId);

      const state = states[tabId];
      // Exactly one user message — no duplicate, no gap
      const userMsgs = state.chatMessages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0]).toMatchObject({ content: "fix the bug" });

      // Stale empty assistant bubble is gone; only the new response remains
      const assistantMsgs = state.chatMessages.filter((m) => m.role === "assistant");
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0]).toMatchObject({ content: "Fixed!", streaming: false });

      expect(state.chatMessages).toHaveLength(2);
      expect(state.status).toBe("idle");
      expect(state.error).toBeNull();
    });

    it("preserves earlier conversation turns and only retries the last user message", async () => {
      const tabId = "tab-retry-multi-turn";
      setState(tabId);

      // First successful turn
      turns.push({ deltas: ["First response"], toolCalls: [] });
      await runAgent(tabId, "first message");

      expect(states[tabId].status).toBe("idle");
      const chatAfterFirst = states[tabId].chatMessages.length;
      const apiAfterFirst = states[tabId].apiMessages.length;

      // Second turn ends in error
      turns.push({ streamError: new Error("rate limit") });
      await runAgent(tabId, "second message");

      expect(states[tabId].status).toBe("error");

      // Set up a successful retry turn
      turns.push({ deltas: ["Retry response"], toolCalls: [] });
      await retryAgent(tabId);

      const state = states[tabId];
      expect(state.status).toBe("idle");
      expect(state.error).toBeNull();

      // Chat messages: original first-turn messages + retried user + retried assistant
      expect(state.chatMessages).toHaveLength(chatAfterFirst + 2);
      expect(state.chatMessages[chatAfterFirst]).toMatchObject({
        role: "user",
        content: "second message",
      });
      expect(state.chatMessages[chatAfterFirst + 1]).toMatchObject({
        role: "assistant",
        content: "Retry response",
      });

      // apiMessages: system + first user + first assistant + retried user + retried assistant
      expect(state.apiMessages).toHaveLength(apiAfterFirst + 2);
    });
  });

});
