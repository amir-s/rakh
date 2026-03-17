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
      totalTokens: 4200,
      costStatus: "complete",
      callCostUsd: 0.012,
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
      totalTokens: 4800,
      costStatus: "complete",
      callCostUsd: 0.024,
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
            totalTokens: 2200,
            costStatus: "missing",
            callCostUsd: null,
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
