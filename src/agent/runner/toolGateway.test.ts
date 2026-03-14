import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createToolArtifactMock,
  getToolArtifactMock,
  searchToolArtifactMock,
  resolveLanguageModelMock,
  buildProviderOptionsMock,
  streamTextMock,
} = vi.hoisted(() => ({
  createToolArtifactMock: vi.fn(),
  getToolArtifactMock: vi.fn(),
  searchToolArtifactMock: vi.fn(),
  resolveLanguageModelMock: vi.fn(),
  buildProviderOptionsMock: vi.fn(),
  streamTextMock: vi.fn(),
}));

vi.mock("../tools/toolArtifacts", () => ({
  createToolArtifact: (...args: unknown[]) => createToolArtifactMock(...args),
  getToolArtifact: (...args: unknown[]) => getToolArtifactMock(...args),
  searchToolArtifact: (...args: unknown[]) => searchToolArtifactMock(...args),
}));

vi.mock("./providerOptions", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModelMock(...args),
  buildProviderOptions: (...args: unknown[]) => buildProviderOptionsMock(...args),
}));

vi.mock("ai", () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
  stepCountIs: (count: number) => count,
  tool: (input: unknown) => input,
}));

import { registerDynamicModels } from "../modelCatalog";
import {
  executeThroughToolGateway,
  type ToolGatewayExecutorResult,
} from "./toolGateway";

describe("tool gateway", () => {
  beforeEach(() => {
    createToolArtifactMock.mockReset();
    getToolArtifactMock.mockReset();
    searchToolArtifactMock.mockReset();
    resolveLanguageModelMock.mockReset();
    buildProviderOptionsMock.mockReset();
    streamTextMock.mockReset();

    createToolArtifactMock.mockResolvedValue({
      ok: true,
      data: {
        artifactId: "toolart_1",
        createdAtMs: 123,
        sizeBytes: 20,
        originalFormat: "text",
        lineCount: 1,
      },
    });
    getToolArtifactMock.mockResolvedValue({
      ok: true,
      data: {
        artifactId: "toolart_1",
        originalFormat: "text",
        content: "artifact content",
        sizeBytes: 20,
        truncated: false,
        createdAtMs: 123,
      },
    });
    searchToolArtifactMock.mockResolvedValue({
      ok: true,
      data: {
        artifactId: "toolart_1",
        matches: [],
        truncated: false,
        matchCount: 0,
        lineCount: 0,
      },
    });
    resolveLanguageModelMock.mockImplementation((modelId: string) => ({ modelId }));
    buildProviderOptionsMock.mockReturnValue(undefined);
    streamTextMock.mockResolvedValue?.(undefined);
    streamTextMock.mockImplementation(() => ({
      text: Promise.resolve("summary"),
      toolCalls: Promise.resolve([]),
    }));

    registerDynamicModels([
      {
        id: "openai/gpt-5.2",
        name: "GPT 5.2",
        providerId: "provider-openai",
        owned_by: "openai",
        tags: [],
        sdk_id: "gpt-5.2",
      },
      {
        id: "openai/gpt-5.2-mini",
        name: "GPT 5.2 Mini",
        providerId: "provider-openai",
        owned_by: "openai",
        tags: [],
        sdk_id: "gpt-5.2-mini",
      },
    ]);
  });

  it("respects injected threshold config and strips intention before executing", async () => {
    const capturedArgs: Record<string, unknown>[] = [];

    const result = await executeThroughToolGateway({
      tabId: "tab-1",
      runId: "run-1",
      agentId: "agent_main",
      toolCallId: "tc-1",
      toolName: "workspace_search",
      rawArgs: {
        pattern: "error",
        intention: "Only keep failures",
      },
      currentModelId: "openai/gpt-5.2",
      apiMessages: [],
      providers: [
        {
          id: "provider-openai",
          name: "OpenAI",
          type: "openai",
          apiKey: "test",
        },
      ],
      logContext: { tabId: "tab-1", traceId: "trace:1", depth: 1 },
      updateToolCallById: vi.fn(),
      configProvider: {
        getConfig: () => ({
          hugeOutput: {
            enabled: true,
            defaultThresholdBytes: 5,
            thresholdBands: [],
          },
          summary: {
            enabled: false,
            modelStrategy: "parent",
            maxSummaryChars: 120,
            maxSteps: 3,
            toolArtifactGetMaxBytes: 1000,
            toolArtifactSearchMaxMatches: 5,
            toolArtifactSearchContextLines: 1,
          },
        }),
      },
      localExecutor: async (args): Promise<ToolGatewayExecutorResult> => {
        capturedArgs.push(args);
        return { result: { ok: true, data: "hello world" } };
      },
    });

    expect(capturedArgs).toEqual([{ pattern: "error" }]);
    expect(createToolArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "tc-1",
        intention: "Only keep failures",
      }),
      expect.any(Object),
    );
    expect(result).toEqual({
      ok: true,
      data: {
        __rakhToolGateway: expect.objectContaining({
          artifactId: "toolart_1",
          lineCount: 1,
          appliedPolicies: ["huge-output"],
        }),
      },
    });
  });

  it("uses the injected override model for summary generation", async () => {
    const result = await executeThroughToolGateway({
      tabId: "tab-1",
      runId: "run-1",
      agentId: "agent_main",
      toolCallId: "tc-2",
      toolName: "exec_run",
      rawArgs: {
        command: "npm",
        intention: "Summarize failures only",
      },
      currentModelId: "openai/gpt-5.2",
      apiMessages: [],
      providers: [
        {
          id: "provider-openai",
          name: "OpenAI",
          type: "openai",
          apiKey: "test",
        },
      ],
      logContext: { tabId: "tab-1", traceId: "trace:1", depth: 1 },
      updateToolCallById: vi.fn(),
      configProvider: {
        getConfig: () => ({
          hugeOutput: {
            enabled: true,
            defaultThresholdBytes: 1,
            thresholdBands: [],
          },
          summary: {
            enabled: true,
            modelStrategy: "override",
            overrideModelId: "openai/gpt-5.2-mini",
            maxSummaryChars: 120,
            maxSteps: 3,
            toolArtifactGetMaxBytes: 1000,
            toolArtifactSearchMaxMatches: 5,
            toolArtifactSearchContextLines: 1,
          },
        }),
      },
      localExecutor: async (): Promise<ToolGatewayExecutorResult> => ({
        result: {
          ok: true,
          data: {
            stdout: "very large output",
          },
        },
      }),
    });

    expect(resolveLanguageModelMock).toHaveBeenCalledWith(
      "openai/gpt-5.2-mini",
      expect.any(Array),
    );
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { modelId: "openai/gpt-5.2-mini" },
    });
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Artifact lines: 1"),
        }),
      ]),
    });
    expect(result).toEqual({
      ok: true,
      data: {
        __rakhToolGateway: expect.objectContaining({
          lineCount: 1,
          appliedPolicies: ["huge-output", "summary"],
          summary: "summary",
        }),
      },
    });
  });
});
