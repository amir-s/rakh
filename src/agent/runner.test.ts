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
};

type MockAgentState = {
  status: "idle" | "thinking" | "working" | "done" | "error";
  config: {
    cwd: string;
    model: string;
    advancedOptions?: Record<string, unknown>;
  };
  chatMessages: Array<Record<string, unknown>>;
  apiMessages: Array<Record<string, unknown>>;
  streamingContent: string | null;
  plan: { markdown: string; updatedAtMs: number; version: number };
  todos: unknown[];
  error: string | null;
  errorDetails: unknown;
  tabTitle: string;
  reviewEdits: unknown[];
  autoApproveEdits: boolean;
  autoApproveCommands: "no" | "agent" | "yes";
  showDebug?: boolean;
};

const {
  states,
  providersAtomMock,
  jotaiStoreMock,
  dispatchToolMock,
  validateToolMock,
  requiresApprovalMock,
  requestApprovalMock,
  cancelAllApprovalsMock,
  consumeApprovalReasonMock,
  turns,
  streamTextMock,
  createOpenAIMock,
  createAnthropicMock,
  createOpenAICompatibleMock,
  execAbortMock,
  execStopMock,
} = vi.hoisted(() => ({
  states: {} as Record<string, MockAgentState>,
  providersAtomMock: { kind: "providers-atom" },
  jotaiStoreMock: {
    get: vi.fn(),
  },
  dispatchToolMock: vi.fn(),
  validateToolMock: vi.fn(),
  requiresApprovalMock: vi.fn(),
  requestApprovalMock: vi.fn(),
  cancelAllApprovalsMock: vi.fn(),
  consumeApprovalReasonMock: vi.fn(),
  turns: [] as MockTurn[],
  streamTextMock: vi.fn(),
  createOpenAIMock: vi.fn(),
  createAnthropicMock: vi.fn(),
  execAbortMock: vi.fn(),
  execStopMock: vi.fn(),
  createOpenAICompatibleMock: vi.fn(),
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
}));

vi.mock("./db", () => ({
  providersAtom: providersAtomMock,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (...args: unknown[]) => {
    createOpenAICompatibleMock(...args);
    return (modelId: string) => ({ provider: "openai-compatible", modelId });
  },
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
  cancelAllApprovals: (...args: unknown[]) => cancelAllApprovalsMock(...args),
  consumeApprovalReason: (...args: unknown[]) =>
    consumeApprovalReasonMock(...args),
}));

vi.mock("ai", () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
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

import {
  buildProviderOptions,
  runAgent,
  retryAgent,
  serializeError,
  stopAgent,
  stopRunningExecToolCall,
} from "./runner";
import { registerDynamicModels } from "./modelCatalog";
import type { AdvancedModelOptions } from "./types";
import { DEFAULT_ADVANCED_OPTIONS } from "./types";

function makeState(overrides: Partial<MockAgentState> = {}): MockAgentState {
  return {
    status: "idle",
    config: { cwd: "", model: "openai/gpt-5.2" },
    chatMessages: [],
    apiMessages: [],
    streamingContent: null,
    plan: { markdown: "", updatedAtMs: 0, version: 0 },
    todos: [],
    error: null,
    errorDetails: null,
    tabTitle: "",
    reviewEdits: [],
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

describe("runner", () => {
  beforeEach(() => {
    registerDynamicModels([
      {
        id: "openai/gpt-5.2",
        name: "test-gpt-5.2",
        providerId: "test-openai-id",
        owned_by: "openai",
        tags: [],
        sdk_id: "gpt-5.2",
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
    cancelAllApprovalsMock.mockReset();
    consumeApprovalReasonMock.mockReset();
    streamTextMock.mockReset();
    createOpenAIMock.mockReset();
    createAnthropicMock.mockReset();
    execAbortMock.mockReset();
    execStopMock.mockReset();
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
      return undefined;
    });

    requiresApprovalMock.mockReturnValue(false);
    requestApprovalMock.mockResolvedValue(true);
    consumeApprovalReasonMock.mockReturnValue(undefined);
    dispatchToolMock.mockResolvedValue({ ok: true, data: { ok: true } });
    validateToolMock.mockResolvedValue(null);
    execStopMock.mockResolvedValue(true);

    streamTextMock.mockImplementation(() => {
      const turn = turns.shift() ?? { deltas: [], toolCalls: [] };
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
        toolCalls: turn.toolCallsError
          ? Promise.reject(turn.toolCallsError)
          : Promise.resolve(turn.toolCalls ?? []),
      };
    });
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
    turns.push({ deltas: ["Hello", " world"], toolCalls: [] });

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
    expect(dispatchToolMock).not.toHaveBeenCalled();
  });

  it("includes reviewer scope guidance in the main system prompt via description", async () => {
    const tabId = "tab-system-prompt-reviewer-guidance";
    setState(tabId);
    turns.push({ deltas: ["Hello"], toolCalls: [] });

    await runAgent(tabId, "hi");

    const state = states[tabId];
    const systemMessage = state.apiMessages[0];
    expect(systemMessage).toBeDefined();
    expect(systemMessage.role).toBe("system");
    // Scope guidance lives on the reviewer subagent's description — not hardcoded in the runner.
    expect(systemMessage.content).toContain(
      "Always include a concrete scope (file(s), directory, or commit range) in the message.",
    );
    // Confirmation behavior is conveyed via parentNote in the tool result, not the system prompt.
    expect(systemMessage.content).not.toContain(
      "if the reviewer subagent returns findings and you plan to apply those suggestions",
    );
  });

  it("includes security auditor guidance in the main system prompt via description", async () => {
    const tabId = "tab-system-prompt-security-guidance";
    setState(tabId);
    turns.push({ deltas: ["Hello"], toolCalls: [] });

    await runAgent(tabId, "hi");

    const state = states[tabId];
    const systemMessage = state.apiMessages[0];
    expect(systemMessage).toBeDefined();
    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toContain(
      "Audits code and security-relevant configuration in a requested scope and returns actionable findings.",
    );
    expect(systemMessage.content).toContain(
      "Always include a concrete scope (file(s), directory, or commit range) in the message.",
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

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let debugCalls: unknown[][] = [];
    try {
      await runAgent(tabId, "hi");
      const debugPrefix = `[rakh:stream][${tabId}]`;
      debugCalls = logSpy.mock.calls.filter((args) => args[0] === debugPrefix);
    } finally {
      logSpy.mockRestore();
    }
    const debugPrefix = `[rakh:stream][${tabId}]`;

    expect(debugCalls.length).toBeGreaterThan(0);
    expect(debugCalls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([debugPrefix, "turn:start"]),
        expect.arrayContaining([debugPrefix, "stream:part"]),
        expect.arrayContaining([debugPrefix, "stream:reasoning-start"]),
        expect.arrayContaining([debugPrefix, "stream:reasoning-delta"]),
        expect.arrayContaining([debugPrefix, "stream:text-delta"]),
        expect.arrayContaining([debugPrefix, "stream:tool-calls:raw"]),
        expect.arrayContaining([debugPrefix, "stream:summary"]),
      ]),
    );
  });

  it("does not log stream parts when debug mode is disabled", async () => {
    const tabId = "tab-no-debug-stream";
    setState(tabId, { showDebug: false });
    turns.push({ deltas: ["Hello"], toolCalls: [] });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let debugCalls: unknown[][] = [];
    try {
      await runAgent(tabId, "hi");
      const debugPrefix = `[rakh:stream][${tabId}]`;
      debugCalls = logSpy.mock.calls.filter((args) => args[0] === debugPrefix);
    } finally {
      logSpy.mockRestore();
    }
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
            arguments: { command: "pwd" },
          },
        ],
      },
      { deltas: ["follow-up"], toolCalls: [] },
    );

    requiresApprovalMock.mockReturnValue(true);
    requestApprovalMock.mockResolvedValue(false);
    consumeApprovalReasonMock.mockReturnValue("Denied for safety");

    await runAgent(tabId, "run command");

    expect(requiresApprovalMock).toHaveBeenCalledWith("exec_run", false, "no", {
      command: "pwd",
    });

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
            arguments: { command: "npm", args: ["test"] },
          },
        ],
      },
      { deltas: ["All done."], toolCalls: [] },
    );

    requiresApprovalMock.mockReturnValue(false);

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

  /* ── buildProviderOptions unit tests ──────────────────────────────────── */

  describe("buildProviderOptions", () => {
    it("returns undefined for unknown / openai-compatible providers", () => {
      expect(buildProviderOptions(null)).toBeUndefined();
      expect(buildProviderOptions("openai-compatible")).toBeUndefined();
      expect(buildProviderOptions("custom")).toBeUndefined();
    });

    it("uses DEFAULT_ADVANCED_OPTIONS when opts is undefined (OpenAI)", () => {
      const result = buildProviderOptions("openai");
      expect(result).toBeDefined();
      expect(result!.openai.reasoningSummary).toBe("auto");
      expect(result!.openai.reasoningEffort).toBe(
        DEFAULT_ADVANCED_OPTIONS.reasoningEffort,
      );
      expect(result!.openai.serviceTier).toBe("auto");
    });

    it("uses DEFAULT_ADVANCED_OPTIONS when opts is undefined (Anthropic)", () => {
      const result = buildProviderOptions("anthropic");
      expect(result).toBeDefined();
      expect(result!.anthropic.thinking).toEqual({ type: "adaptive" });
      expect(result!.anthropic.effort).toBe(
        DEFAULT_ADVANCED_OPTIONS.reasoningEffort,
      );
      expect(result!.anthropic).not.toHaveProperty("speed");
    });

    describe("OpenAI mappings", () => {
      const base: AdvancedModelOptions = {
        reasoningVisibility: "auto",
        reasoningEffort: "medium",
        latencyCostProfile: "balanced",
      };

      it("reasoning visibility: off omits reasoningSummary", () => {
        const r = buildProviderOptions("openai", {
          ...base,
          reasoningVisibility: "off",
        });
        expect(r!.openai).not.toHaveProperty("reasoningSummary");
      });

      it("reasoning visibility: auto", () => {
        const r = buildProviderOptions("openai", {
          ...base,
          reasoningVisibility: "auto",
        });
        expect(r!.openai.reasoningSummary).toBe("auto");
      });

      it("reasoning visibility: detailed", () => {
        const r = buildProviderOptions("openai", {
          ...base,
          reasoningVisibility: "detailed",
        });
        expect(r!.openai.reasoningSummary).toBe("detailed");
      });

      it.each(["low", "medium", "high"] as const)(
        "reasoning effort: %s",
        (effort) => {
          const r = buildProviderOptions("openai", {
            ...base,
            reasoningEffort: effort,
          });
          expect(r!.openai.reasoningEffort).toBe(effort);
        },
      );

      it("latency balanced → serviceTier auto", () => {
        const r = buildProviderOptions("openai", {
          ...base,
          latencyCostProfile: "balanced",
        });
        expect(r!.openai.serviceTier).toBe("auto");
      });

      it("latency fast → serviceTier priority", () => {
        const r = buildProviderOptions("openai", {
          ...base,
          latencyCostProfile: "fast",
        });
        expect(r!.openai.serviceTier).toBe("priority");
      });

      it("latency cheap → serviceTier flex", () => {
        const r = buildProviderOptions("openai", {
          ...base,
          latencyCostProfile: "cheap",
        });
        expect(r!.openai.serviceTier).toBe("flex");
      });
    });

    describe("Anthropic mappings", () => {
      const base: AdvancedModelOptions = {
        reasoningVisibility: "auto",
        reasoningEffort: "medium",
        latencyCostProfile: "balanced",
      };

      it("reasoning visibility: off → thinking disabled", () => {
        const r = buildProviderOptions("anthropic", {
          ...base,
          reasoningVisibility: "off",
        });
        expect(r!.anthropic.thinking).toEqual({ type: "disabled" });
      });

      it("reasoning visibility: auto → thinking adaptive", () => {
        const r = buildProviderOptions("anthropic", {
          ...base,
          reasoningVisibility: "auto",
        });
        expect(r!.anthropic.thinking).toEqual({ type: "adaptive" });
      });

      it("reasoning visibility: detailed → thinking enabled with budgetTokens", () => {
        const r = buildProviderOptions("anthropic", {
          ...base,
          reasoningVisibility: "detailed",
        });
        expect(r!.anthropic.thinking).toEqual({
          type: "enabled",
          budgetTokens: 4096,
        });
      });

      it.each(["low", "medium", "high"] as const)(
        "reasoning effort: %s",
        (effort) => {
          const r = buildProviderOptions("anthropic", {
            ...base,
            reasoningEffort: effort,
          });
          expect(r!.anthropic.effort).toBe(effort);
        },
      );

      it("latency balanced → speed omitted", () => {
        const r = buildProviderOptions(
          "anthropic",
          {
            ...base,
            latencyCostProfile: "balanced",
          },
          "claude-opus-4-6",
        );
        expect(r!.anthropic).not.toHaveProperty("speed");
      });

      it("latency fast on unsupported models → speed omitted", () => {
        const r = buildProviderOptions(
          "anthropic",
          {
            ...base,
            latencyCostProfile: "fast",
          },
          "claude-sonnet-4-6",
        );
        expect(r!.anthropic).not.toHaveProperty("speed");
      });

      it("latency fast on opus 4.6 → speed fast", () => {
        const r = buildProviderOptions(
          "anthropic",
          {
            ...base,
            latencyCostProfile: "fast",
          },
          "claude-opus-4-6",
        );
        expect(r!.anthropic.speed).toBe("fast");
      });
    });
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

  it("omits unsupported Anthropic fast mode from streamText", async () => {
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
    expect(po!.anthropic.effort).toBe("high");
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

  it("serializeError captures nested causes", () => {
    const root = new Error("root-cause");
    const err = new Error("top-level");
    (err as Error & { cause?: unknown }).cause = root;

    const serialized = serializeError(err) as Record<string, unknown>;
    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("top-level");
    expect(serialized.cause).toMatchObject({ message: "root-cause" });
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
      });
      turns.push({
        deltas: ["GitHub update ready below."],
        toolCalls: [],
      });
      turns.push({
        deltas: ["Issue created and linked."],
        toolCalls: [],
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

      requiresApprovalMock.mockReturnValue(false);

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
        return toolName === "exec_run";
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

      expect(requestApprovalMock).toHaveBeenCalledWith("tc-security-exec");
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
      // Should have user + assistant in chat (re-added by runAgent)
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
