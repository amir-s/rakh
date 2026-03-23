// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  SessionCostSeriesPoint,
  SessionUsageSummary,
} from "@/agent/sessionStats";
import SessionCostModal from "./SessionCostModal";

function makeSummary(): SessionUsageSummary {
  return {
    usage: {
      inputTokens: 6000,
      noCacheInputTokens: 6000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1200,
      reasoningTokens: 300,
      totalTokens: 7200,
    },
    costStatus: "complete",
    knownCostUsd: 0.06,
    missingPricingModels: [],
    breakdown: [
      {
        actorKind: "main",
        actorId: "main",
        actorLabel: "Rakh",
        operationLabels: ["assistant turn"],
        modelIds: ["openai/gpt-5.2"],
        usage: {
          inputTokens: 4000,
          noCacheInputTokens: 4000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 900,
          reasoningTokens: 200,
          totalTokens: 4900,
        },
        costStatus: "complete",
        knownCostUsd: 0.04,
      },
      {
        actorKind: "subagent",
        actorId: "planner",
        actorLabel: "Planner",
        operationLabels: ["assistant turn"],
        modelIds: ["openai/gpt-5.2"],
        usage: {
          inputTokens: 2000,
          noCacheInputTokens: 2000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 300,
          reasoningTokens: 100,
          totalTokens: 2300,
        },
        costStatus: "complete",
        knownCostUsd: 0.02,
      },
    ],
  };
}

function makeSeries(): SessionCostSeriesPoint[] {
  return [
    {
      id: "usage-1",
      index: 0,
      timestamp: 1_710_000_000_000,
      modelId: "openai/gpt-5.2",
      actorKind: "main",
      actorId: "main",
      actorLabel: "Rakh",
      operation: "assistant turn",
      inputTokens: 1500,
      noCacheInputTokens: 1200,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      outputTokens: 500,
      reasoningTokens: 120,
      totalTokens: 2000,
      costStatus: "complete",
      uncachedInputCostUsd: 0.006,
      cacheReadCostUsd: 0.001,
      cacheWriteCostUsd: 0.001,
      outputCostUsd: 0.002,
      callCostUsd: 0.01,
      cumulativeUncachedInputCostUsd: 0.006,
      cumulativeCacheReadCostUsd: 0.001,
      cumulativeCacheWriteCostUsd: 0.001,
      cumulativeOutputCostUsd: 0.002,
      cumulativeKnownCostUsd: 0.01,
    },
    {
      id: "usage-2",
      index: 1,
      timestamp: 1_710_000_060_000,
      modelId: "openai/gpt-5.2",
      actorKind: "subagent",
      actorId: "planner",
      actorLabel: "Planner",
      operation: "assistant turn",
      inputTokens: 1800,
      noCacheInputTokens: 1600,
      cacheReadTokens: 150,
      cacheWriteTokens: 50,
      outputTokens: 400,
      reasoningTokens: 80,
      totalTokens: 2400,
      costStatus: "complete",
      uncachedInputCostUsd: 0.015,
      cacheReadCostUsd: 0.001,
      cacheWriteCostUsd: 0,
      outputCostUsd: 0.004,
      callCostUsd: 0.02,
      cumulativeUncachedInputCostUsd: 0.021,
      cumulativeCacheReadCostUsd: 0.002,
      cumulativeCacheWriteCostUsd: 0.001,
      cumulativeOutputCostUsd: 0.006,
      cumulativeKnownCostUsd: 0.03,
    },
    {
      id: "usage-3",
      index: 2,
      timestamp: 1_710_000_120_000,
      modelId: "openai/gpt-5.2",
      actorKind: "main",
      actorId: "main",
      actorLabel: "Rakh",
      operation: "assistant turn",
      inputTokens: 2000,
      noCacheInputTokens: 1800,
      cacheReadTokens: 100,
      cacheWriteTokens: 100,
      outputTokens: 600,
      reasoningTokens: 140,
      totalTokens: 2800,
      costStatus: "complete",
      uncachedInputCostUsd: 0.021,
      cacheReadCostUsd: 0.003,
      cacheWriteCostUsd: 0.001,
      outputCostUsd: 0.005,
      callCostUsd: 0.03,
      cumulativeUncachedInputCostUsd: 0.042,
      cumulativeCacheReadCostUsd: 0.005,
      cumulativeCacheWriteCostUsd: 0.002,
      cumulativeOutputCostUsd: 0.011,
      cumulativeKnownCostUsd: 0.06,
    },
  ];
}

describe("SessionCostModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders toggleable series with a shared per-call tooltip", () => {
    render(
      <SessionCostModal
        summary={makeSummary()}
        series={makeSeries()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Session cost" }),
    ).not.toBeNull();
    expect(screen.getAllByText("Rakh").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Planner").length).toBeGreaterThan(0);

    const perCallChart = document.body.querySelector(
      '[data-chart-id="per-call-cost"]',
    );
    expect(perCallChart).not.toBeNull();
    expect(
      perCallChart!.querySelector(".session-cost-chart-scale + .session-cost-chart-panel"),
    ).not.toBeNull();
    expect(
      perCallChart!.querySelector(".session-cost-chart-panel .session-cost-chart-axis"),
    ).not.toBeNull();

    const outputToggle = within(perCallChart as HTMLElement).getByRole("button", {
      name: /Output/i,
    });
    fireEvent.click(outputToggle);
    expect(outputToggle.getAttribute("aria-pressed")).toBe("false");

    const call2 = perCallChart!.querySelector(
      '.session-cost-chart-slice[data-call-index="2"]',
    );
    expect(call2).not.toBeNull();
    fireEvent.mouseEnter(call2!);

    expect(screen.getByRole("tooltip")).not.toBeNull();
    expect(
      perCallChart!.querySelector(".session-cost-chart-plot [role='tooltip']"),
    ).not.toBeNull();
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("Call 2");
    expect(tooltip.textContent).toContain("Planner");
    expect(tooltip.textContent).toContain("Uncached input");
    expect(tooltip.textContent).toContain("2,400");
    expect(tooltip.textContent).not.toContain("$0.0040");
  });

  it("shows the cumulative series in the shared tooltip", () => {
    render(
      <SessionCostModal
        summary={makeSummary()}
        series={makeSeries()}
        onClose={vi.fn()}
      />,
    );

    const cumulativeChart = document.body.querySelector(
      '[data-chart-id="cumulative-cost"]',
    );
    expect(cumulativeChart).not.toBeNull();
    expect(
      cumulativeChart!.querySelector(".session-cost-chart-scale + .session-cost-chart-panel"),
    ).not.toBeNull();

    const call3 = cumulativeChart!.querySelector(
      '.session-cost-chart-slice[data-call-index="3"]',
    );
    expect(call3).not.toBeNull();

    fireEvent.mouseEnter(call3!);

    const tooltip = screen.getByRole("tooltip");
    expect(
      cumulativeChart!.querySelector(".session-cost-chart-plot [role='tooltip']"),
    ).not.toBeNull();
    expect(tooltip.textContent).toContain("Call 3");
    expect(tooltip.textContent).toContain("Cumulative cost");
    expect(tooltip.textContent).toContain("Output");
    expect(tooltip.textContent).toContain("$0.060");
    expect(tooltip.textContent).toContain("$0.011");
  });

  it("renders vertical markers for tool io replacement calls in both charts", () => {
    const toolIoSeries = makeSeries().map((point, index) =>
      index === 1
        ? {
            ...point,
            actorKind: "internal" as const,
            actorId: "main",
            actorLabel: "Rakh",
            operation: "tool io replacement",
          }
        : point,
    );

    render(
      <SessionCostModal
        summary={makeSummary()}
        series={toolIoSeries}
        onClose={vi.fn()}
      />,
    );

    const perCallChart = document.body.querySelector(
      '[data-chart-id="per-call-cost"]',
    );
    const cumulativeChart = document.body.querySelector(
      '[data-chart-id="cumulative-cost"]',
    );

    expect(
      perCallChart?.querySelector(
        '.session-cost-chart-marker--tool-io[data-call-index="2"]',
      ),
    ).not.toBeNull();
    expect(
      cumulativeChart?.querySelector(
        '.session-cost-chart-marker--tool-io[data-call-index="2"]',
      ),
    ).not.toBeNull();
  });

  it("renders vertical markers for context compaction subagent calls in both charts", () => {
    const contextCompactionSeries = makeSeries().map((point, index) =>
      index === 2
        ? {
            ...point,
            actorKind: "subagent" as const,
            actorId: "compact",
            actorLabel: "Context Compaction",
            operation: "assistant turn",
          }
        : point,
    );

    render(
      <SessionCostModal
        summary={makeSummary()}
        series={contextCompactionSeries}
        onClose={vi.fn()}
      />,
    );

    const perCallChart = document.body.querySelector(
      '[data-chart-id="per-call-cost"]',
    );
    const cumulativeChart = document.body.querySelector(
      '[data-chart-id="cumulative-cost"]',
    );

    expect(
      perCallChart?.querySelector(
        '.session-cost-chart-marker--context-compaction[data-call-index="3"]',
      ),
    ).not.toBeNull();
    expect(
      cumulativeChart?.querySelector(
        '.session-cost-chart-marker--context-compaction[data-call-index="3"]',
      ),
    ).not.toBeNull();
  });

  it("does not crash when the hovered call disappears after rerender", () => {
    const { rerender } = render(
      <SessionCostModal
        summary={makeSummary()}
        series={makeSeries()}
        onClose={vi.fn()}
      />,
    );

    const cumulativeChart = document.body.querySelector(
      '[data-chart-id="cumulative-cost"]',
    );
    const call3 = cumulativeChart?.querySelector(
      '.session-cost-chart-slice[data-call-index="3"]',
    );
    expect(call3).not.toBeNull();

    fireEvent.mouseEnter(call3!);
    expect(screen.getByRole("tooltip")).not.toBeNull();

    rerender(
      <SessionCostModal
        summary={makeSummary()}
        series={makeSeries().slice(0, 2)}
        onClose={vi.fn()}
      />,
    );

    expect(
      document.body.querySelector('[data-chart-id="cumulative-cost"]'),
    ).not.toBeNull();
  });
});
