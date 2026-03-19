// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChatControls, { type ChatControlsProps } from "./ChatControls";
import type { SessionCostSeriesPoint } from "@/agent/sessionStats";

function makeSessionUsageSummary(
  overrides: Partial<NonNullable<ChatControlsProps["sessionUsageSummary"]>> = {},
): NonNullable<ChatControlsProps["sessionUsageSummary"]> {
  return {
    usage: {
      inputTokens: 7200,
      noCacheInputTokens: 7200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1800,
      reasoningTokens: 400,
      totalTokens: 9000,
    },
    costStatus: "complete" as const,
    knownCostUsd: 0.036,
    missingPricingModels: [],
    breakdown: [
      {
        actorKind: "main" as const,
        actorId: "main",
        actorLabel: "Rakh",
        operationLabels: ["assistant turn"],
        modelIds: ["openai/gpt-5.2"],
        usage: {
          inputTokens: 7200,
          noCacheInputTokens: 7200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1800,
          reasoningTokens: 400,
          totalTokens: 9000,
        },
        costStatus: "complete" as const,
        knownCostUsd: 0.036,
      },
    ],
    ...overrides,
  };
}

function makeSessionCostSeries(
  overrides: Array<Partial<SessionCostSeriesPoint>> = [],
): SessionCostSeriesPoint[] {
  const base: SessionCostSeriesPoint[] = [
    {
      id: "usage-1",
      index: 0,
      timestamp: 1_710_000_000_000,
      modelId: "openai/gpt-5.2",
      actorKind: "main",
      actorId: "main",
      actorLabel: "Rakh",
      operation: "assistant turn",
      inputTokens: 3200,
      noCacheInputTokens: 3000,
      cacheReadTokens: 100,
      cacheWriteTokens: 100,
      outputTokens: 1000,
      reasoningTokens: 200,
      totalTokens: 4200,
      costStatus: "complete",
      uncachedInputCostUsd: 0.008,
      cacheReadCostUsd: 0.001,
      cacheWriteCostUsd: 0.001,
      outputCostUsd: 0.002,
      callCostUsd: 0.012,
      cumulativeUncachedInputCostUsd: 0.008,
      cumulativeCacheReadCostUsd: 0.001,
      cumulativeCacheWriteCostUsd: 0.001,
      cumulativeOutputCostUsd: 0.002,
      cumulativeKnownCostUsd: 0.012,
    },
    {
      id: "usage-2",
      index: 1,
      timestamp: 1_710_000_060_000,
      modelId: "openai/gpt-5.2",
      actorKind: "main",
      actorId: "main",
      actorLabel: "Rakh",
      operation: "assistant turn",
      inputTokens: 3600,
      noCacheInputTokens: 3200,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      outputTokens: 1200,
      reasoningTokens: 200,
      totalTokens: 4800,
      costStatus: "complete",
      uncachedInputCostUsd: 0.014,
      cacheReadCostUsd: 0.004,
      cacheWriteCostUsd: 0.001,
      outputCostUsd: 0.005,
      callCostUsd: 0.024,
      cumulativeUncachedInputCostUsd: 0.022,
      cumulativeCacheReadCostUsd: 0.005,
      cumulativeCacheWriteCostUsd: 0.002,
      cumulativeOutputCostUsd: 0.007,
      cumulativeKnownCostUsd: 0.036,
    },
  ];

  return base.map((point, index) => ({
    ...point,
    ...(overrides[index] ?? {}),
  }));
}

describe("ChatControls", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders current context and session usage totals", () => {
    const { container } = render(
      <ChatControls
        autoApproveEdits={false}
        autoApproveCommands="agent"
        onChangeAutoApproveEdits={() => {}}
        onChangeAutoApproveCommands={() => {}}
        contextWindowPct={42}
        contextCurrentTokens={10600}
        contextCurrentKb={41.4}
        contextMaxKb={128}
        sessionUsageSummary={makeSessionUsageSummary()}
        sessionCostSeries={makeSessionCostSeries()}
      />,
    );

    expect(screen.getByText("42% ctx")).not.toBeNull();
    expect(screen.getByRole("button", { name: /0\.036/i })).not.toBeNull();
    expect(
      container.querySelector(".chat-ctrl-session-label")?.textContent,
    ).toBe("$0.036");
    const rightControls = container.querySelector(".chat-controls-right");
    expect(rightControls?.firstElementChild?.className).toContain(
      "chat-ctrl-session",
    );
    expect(rightControls?.lastElementChild?.className).toContain("chat-ctrl-ctx");
    expect(screen.getByText("Session usage")).not.toBeNull();
    expect(screen.getByText("Breakdown")).not.toBeNull();
    expect(screen.getByText("Rakh")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /0\.036/i }));

    expect(
      screen.getByRole("dialog", { name: "Session cost" }),
    ).not.toBeNull();
    expect(screen.getByText("Cost per API call")).not.toBeNull();
    expect(screen.getByText("Cumulative session cost")).not.toBeNull();
  });

  it("opens provider settings from the modal when pricing is missing", () => {
    const onOpenProvidersSettings = vi.fn();

    const { container } = render(
      <ChatControls
        autoApproveEdits={false}
        autoApproveCommands="agent"
        onChangeAutoApproveEdits={() => {}}
        onChangeAutoApproveCommands={() => {}}
        contextWindowPct={null}
        contextCurrentTokens={null}
        contextCurrentKb={null}
        contextMaxKb={null}
        sessionUsageSummary={makeSessionUsageSummary({
          costStatus: "missing",
          knownCostUsd: 0,
          missingPricingModels: [
            { modelId: "custom/llama", label: "Llama 3.3 70B" },
          ],
          breakdown: [
            {
              actorKind: "internal",
              actorId: "context-compaction-summary",
              actorLabel: "Context compaction",
              operationLabels: ["artifact summary"],
              modelIds: ["custom/llama"],
              usage: {
                inputTokens: 2000,
                noCacheInputTokens: 2000,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 200,
                reasoningTokens: 0,
                totalTokens: 2200,
              },
              costStatus: "missing",
              knownCostUsd: 0,
            },
          ],
        })}
        sessionCostSeries={makeSessionCostSeries([
          {
            modelId: "custom/llama",
            actorKind: "internal",
            actorId: "context-compaction-summary",
            actorLabel: "Context compaction",
            inputTokens: 2000,
            noCacheInputTokens: 2000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 200,
            reasoningTokens: 0,
            totalTokens: 2200,
            costStatus: "missing",
            uncachedInputCostUsd: null,
            cacheReadCostUsd: null,
            cacheWriteCostUsd: null,
            outputCostUsd: null,
            callCostUsd: null,
            cumulativeUncachedInputCostUsd: 0,
            cumulativeCacheReadCostUsd: 0,
            cumulativeCacheWriteCostUsd: 0,
            cumulativeOutputCostUsd: 0,
            cumulativeKnownCostUsd: 0,
          },
        ])}
        onOpenProvidersSettings={onOpenProvidersSettings}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /cost\?/i }));

    expect(onOpenProvidersSettings).not.toHaveBeenCalled();
    expect(
      container.querySelector(".chat-ctrl-session-label")?.textContent,
    ).toBe("cost?");
    expect(
      screen.getByRole("dialog", { name: "Session cost" }),
    ).not.toBeNull();
    expect(screen.getAllByText(/Update AI Providers metadata/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Llama 3\.3 70B/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /open ai providers/i }));

    expect(onOpenProvidersSettings).toHaveBeenCalledTimes(1);
  });
});
