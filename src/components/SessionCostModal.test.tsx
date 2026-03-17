// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
      totalTokens: 2000,
      costStatus: "complete",
      callCostUsd: 0.01,
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
      totalTokens: 2400,
      costStatus: "complete",
      callCostUsd: 0.02,
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
      totalTokens: 2800,
      costStatus: "complete",
      callCostUsd: 0.03,
      cumulativeKnownCostUsd: 0.06,
    },
  ];
}

describe("SessionCostModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders separate actor lines at global session positions", () => {
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

    const circles = Array.from(perCallChart!.querySelectorAll("circle"));
    expect(circles.length).toBe(3);

    const call1 = perCallChart!.querySelector('circle[data-call-index="1"]');
    const call2 = perCallChart!.querySelector('circle[data-call-index="2"]');
    const call3 = perCallChart!.querySelector('circle[data-call-index="3"]');

    expect(call1?.getAttribute("cx")).toBe("16");
    expect(call2?.getAttribute("cx")).toBe("320");
    expect(call3?.getAttribute("cx")).toBe("624");

    fireEvent.mouseEnter(call2!);

    expect(screen.getByRole("tooltip")).not.toBeNull();
    expect(screen.getByText(/Call 2/)).not.toBeNull();
    expect(screen.getByText(/Planner - assistant turn/)).not.toBeNull();
  });

  it("shows cumulative total in the cumulative chart tooltip", () => {
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

    const call3 = cumulativeChart!.querySelector('circle[data-call-index="3"]');
    expect(call3).not.toBeNull();

    fireEvent.mouseEnter(call3!);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("Call 3");
    expect(tooltip.textContent).toContain("Total so far $0.060");
    expect(tooltip.textContent).toContain("Call cost $0.030");
  });
});
