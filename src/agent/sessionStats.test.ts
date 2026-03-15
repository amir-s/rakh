import { describe, expect, it } from "vitest";

import {
  estimateCurrentContextStats,
  summarizeSessionUsage,
} from "./sessionStats";
import type { LlmUsageRecord } from "./types";

function makeUsageRecord(
  overrides: Partial<LlmUsageRecord> = {},
): LlmUsageRecord {
  return {
    id: "usage-1",
    timestamp: 1,
    modelId: "openai/gpt-5.2",
    actorKind: "main",
    actorId: "main",
    actorLabel: "Rakh",
    operation: "assistant turn",
    inputTokens: 1200,
    noCacheInputTokens: 1200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 300,
    reasoningTokens: 50,
    totalTokens: 1500,
    ...overrides,
  };
}

describe("sessionStats", () => {
  it("aggregates complete session usage and cost by actor", () => {
    const summary = summarizeSessionUsage(
      [
        makeUsageRecord(),
        makeUsageRecord({
          id: "usage-2",
          actorKind: "subagent",
          actorId: "planner",
          actorLabel: "Planner",
          modelId: "anthropic/claude-sonnet-4-5",
          inputTokens: 800,
          noCacheInputTokens: 800,
          outputTokens: 200,
          totalTokens: 1000,
        }),
      ],
      (modelId) => {
        if (modelId === "openai/gpt-5.2") {
          return {
            id: modelId,
            name: "GPT 5.2",
            providerId: "provider-openai",
            owned_by: "openai",
            tags: [],
            sdk_id: "gpt-5.2",
            pricing: { prompt: 1, completion: 4 },
          };
        }

        return {
          id: modelId,
          name: "Claude Sonnet 4.5",
          providerId: "provider-anthropic",
          owned_by: "anthropic",
          tags: [],
          sdk_id: "claude-sonnet-4-5",
          pricing: { prompt: 3, completion: 15 },
        };
      },
    );

    expect(summary).toMatchObject({
      costStatus: "complete",
      usage: {
        inputTokens: 2000,
        outputTokens: 500,
        totalTokens: 2500,
      },
      breakdown: [
        expect.objectContaining({
          actorKind: "main",
          actorLabel: "Rakh",
          usage: expect.objectContaining({ totalTokens: 1500 }),
        }),
        expect.objectContaining({
          actorKind: "subagent",
          actorLabel: "Planner",
          usage: expect.objectContaining({ totalTokens: 1000 }),
        }),
      ],
    });
    expect(summary?.knownCostUsd).toBeCloseTo(0.0078, 6);
  });

  it("marks pricing as partial when some models are missing metadata", () => {
    const summary = summarizeSessionUsage(
      [
        makeUsageRecord(),
        makeUsageRecord({
          id: "usage-2",
          actorKind: "internal",
          actorId: "context-compaction-summary",
          actorLabel: "Context compaction",
          modelId: "custom/missing",
          inputTokens: 500,
          noCacheInputTokens: 500,
          outputTokens: 100,
          totalTokens: 600,
        }),
      ],
      (modelId) =>
        modelId === "openai/gpt-5.2"
          ? {
              id: modelId,
              name: "GPT 5.2",
              providerId: "provider-openai",
              owned_by: "openai",
              tags: [],
              sdk_id: "gpt-5.2",
              pricing: { prompt: 1, completion: 4 },
            }
          : null,
    );

    expect(summary).toMatchObject({
      costStatus: "partial",
      missingPricingModels: [{ modelId: "custom/missing", label: "custom/missing" }],
    });
    expect(summary?.knownCostUsd).toBeCloseTo(0.0024, 6);
  });

  it("estimates current context from live api messages", () => {
    const stats = estimateCurrentContextStats(
      [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello there" },
        { role: "assistant", content: "world", tool_calls: [] },
      ],
      1000,
    );

    expect(stats).toMatchObject({
      estimatedTokens: 8,
      pct: 0.8,
    });
    expect(stats?.currentKb).toBeCloseTo((8 * 4) / 1024, 6);
    expect(stats?.maxKb).toBeCloseTo((1000 * 4) / 1024, 6);
  });
});
