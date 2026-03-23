import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  SessionCostSeriesPoint,
  SessionUsageSummary,
} from "@/agent/sessionStats";
import { Button, ModalShell } from "@/components/ui";

const CHART_WIDTH = 640;
const CHART_HEIGHT = 180;
const CHART_PADDING_LEFT = 16;
const CHART_PADDING_RIGHT = 16;
const CHART_PADDING_TOP = 14;
const CHART_PADDING_BOTTOM = 18;
const GRID_RATIOS = [1, 0.75, 0.5, 0.25, 0];

type CostSeriesKey =
  | "total"
  | "uncachedInput"
  | "cacheRead"
  | "cacheWrite"
  | "output";

type ChartMode = "per-call" | "cumulative";

interface SessionCostModalProps {
  summary: SessionUsageSummary;
  series: SessionCostSeriesPoint[];
  onClose: () => void;
  onOpenProvidersSettings?: () => void;
}

interface CostSeriesDefinition {
  key: CostSeriesKey;
  label: string;
  color: string;
  description: string;
  valueFor: (point: SessionCostSeriesPoint, mode: ChartMode) => number | null;
}

interface HoveredSeriesPoint {
  definition: CostSeriesDefinition;
  value: number | null;
  x: number;
  y: number | null;
}

const COST_SERIES_DEFINITIONS: CostSeriesDefinition[] = [
  {
    key: "total",
    label: "Total",
    color: "var(--color-primary)",
    description: "All priced cost",
    valueFor: (point, mode) =>
      mode === "per-call" ? point.callCostUsd : point.cumulativeKnownCostUsd,
  },
  {
    key: "uncachedInput",
    label: "Uncached input",
    color: "var(--color-warning)",
    description: "Prompt tokens billed at full rate",
    valueFor: (point, mode) =>
      mode === "per-call"
        ? point.uncachedInputCostUsd
        : point.cumulativeUncachedInputCostUsd,
  },
  {
    key: "cacheRead",
    label: "Cache read",
    color: "var(--color-success)",
    description: "Prompt cache hits",
    valueFor: (point, mode) =>
      mode === "per-call"
        ? point.cacheReadCostUsd
        : point.cumulativeCacheReadCostUsd,
  },
  {
    key: "cacheWrite",
    label: "Cache write",
    color: "color-mix(in srgb, var(--color-info) 72%, var(--color-warning))",
    description: "Prompt cache writes",
    valueFor: (point, mode) =>
      mode === "per-call"
        ? point.cacheWriteCostUsd
        : point.cumulativeCacheWriteCostUsd,
  },
  {
    key: "output",
    label: "Output",
    color: "var(--color-info)",
    description: "Completion and reasoning tokens",
    valueFor: (point, mode) =>
      mode === "per-call" ? point.outputCostUsd : point.cumulativeOutputCostUsd,
  },
];

function formatUsd(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}K`;
  }
  return tokens.toLocaleString();
}

function formatFullTokens(tokens: number): string {
  return tokens.toLocaleString();
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function getXPositionByIndex(index: number, totalCount: number): number {
  const chartWidth = CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
  if (totalCount <= 1) return CHART_PADDING_LEFT + chartWidth / 2;
  return CHART_PADDING_LEFT + (index / (totalCount - 1)) * chartWidth;
}

function getYPosition(value: number, maxValue: number): number {
  const chartHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
  return CHART_PADDING_TOP + chartHeight - (value / maxValue) * chartHeight;
}

function buildLinePath(points: Array<{ x: number; y: number }>): string {
  return points
    .map((point, index) =>
      `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    )
    .join(" ");
}

function clampTooltipPct(value: number): number {
  return Math.min(94, Math.max(6, value));
}

function buildSliceBounds(totalCount: number) {
  const centers = Array.from({ length: totalCount }, (_, index) =>
    getXPositionByIndex(index, totalCount),
  );

  return centers.map((center, index) => {
    const start =
      index === 0 ? CHART_PADDING_LEFT : (centers[index - 1] + center) / 2;
    const end =
      index === totalCount - 1
        ? CHART_WIDTH - CHART_PADDING_RIGHT
        : (center + centers[index + 1]) / 2;

    return {
      x: start,
      width: Math.max(1, end - start),
      center,
    };
  });
}

function buildTooltipLabel(mode: ChartMode, point: SessionCostSeriesPoint): string {
  const parts = [
    `Call ${point.index + 1}`,
    formatDateTime(point.timestamp),
    point.actorLabel,
    point.operation,
  ];

  if (point.callCostUsd == null) {
    parts.push("Pricing unavailable");
  }

  return parts.join(" ");
}

function isToolIoReplacementPoint(point: SessionCostSeriesPoint): boolean {
  return point.operation.trim().toLowerCase() === "tool io replacement";
}

function renderTooltipContent({
  point,
  hoveredSeries,
  mode,
}: {
  point: SessionCostSeriesPoint;
  hoveredSeries: HoveredSeriesPoint[];
  mode: ChartMode;
}): ReactNode {
  return (
    <>
      <div className="session-cost-tooltip-title">{`Call ${point.index + 1}`}</div>
      <div className="session-cost-tooltip-copy">
        {formatDateTime(point.timestamp)}
        {" · "}
        {point.actorLabel}
        {" · "}
        {point.operation}
      </div>

      <div className="session-cost-tooltip-section">
        <div className="session-cost-tooltip-section-title">
          {mode === "per-call" ? "Cost breakdown" : "Cumulative cost"}
        </div>
        {hoveredSeries.map(({ definition, value }) => (
          <div key={definition.key} className="session-cost-tooltip-row">
            <div className="session-cost-tooltip-row-label">
              <span
                className="session-cost-tooltip-dot"
                style={{ background: definition.color }}
                aria-hidden="true"
              />
              {definition.label}
            </div>
            <div className="session-cost-tooltip-row-value">
              {value == null ? "Unavailable" : formatUsd(value)}
            </div>
          </div>
        ))}
        {mode === "cumulative" && point.callCostUsd == null ? (
          <div className="session-cost-tooltip-note">
            Call pricing unavailable for this step.
          </div>
        ) : null}
      </div>

      <div className="session-cost-tooltip-section">
        <div className="session-cost-tooltip-section-title">Tokens</div>
        <div className="session-cost-tooltip-row">
          <div className="session-cost-tooltip-row-label">Input</div>
          <div className="session-cost-tooltip-row-value">
            {formatFullTokens(point.inputTokens)}
          </div>
        </div>
        <div className="session-cost-tooltip-row">
          <div className="session-cost-tooltip-row-label">Uncached input</div>
          <div className="session-cost-tooltip-row-value">
            {formatFullTokens(point.noCacheInputTokens)}
          </div>
        </div>
        <div className="session-cost-tooltip-row">
          <div className="session-cost-tooltip-row-label">Cache read</div>
          <div className="session-cost-tooltip-row-value">
            {formatFullTokens(point.cacheReadTokens)}
          </div>
        </div>
        <div className="session-cost-tooltip-row">
          <div className="session-cost-tooltip-row-label">Cache write</div>
          <div className="session-cost-tooltip-row-value">
            {formatFullTokens(point.cacheWriteTokens)}
          </div>
        </div>
        <div className="session-cost-tooltip-row">
          <div className="session-cost-tooltip-row-label">Output</div>
          <div className="session-cost-tooltip-row-value">
            {formatFullTokens(point.outputTokens)}
          </div>
        </div>
        <div className="session-cost-tooltip-row">
          <div className="session-cost-tooltip-row-label">Reasoning</div>
          <div className="session-cost-tooltip-row-value">
            {formatFullTokens(point.reasoningTokens)}
          </div>
        </div>
        <div className="session-cost-tooltip-row">
          <div className="session-cost-tooltip-row-label">Total</div>
          <div className="session-cost-tooltip-row-value">
            {formatFullTokens(point.totalTokens)}
          </div>
        </div>
      </div>
    </>
  );
}

function SessionCostMultiLineChart({
  title,
  description,
  points,
  mode,
  emptyCopy,
  latestValueLabel,
  chartId,
}: {
  title: string;
  description: string;
  points: SessionCostSeriesPoint[];
  mode: ChartMode;
  emptyCopy: string;
  latestValueLabel: string;
  chartId: string;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<CostSeriesKey[]>(
    COST_SERIES_DEFINITIONS.map((definition) => definition.key),
  );
  const safeHoveredIndex =
    hoveredIndex != null && hoveredIndex < points.length ? hoveredIndex : null;

  const visibleSeries = COST_SERIES_DEFINITIONS.filter((definition) =>
    visibleKeys.includes(definition.key),
  );
  const plottedValues = visibleSeries
    .flatMap((definition) =>
      points.map((point) => definition.valueFor(point, mode)),
    )
    .filter((value): value is number => value !== null);

  if (plottedValues.length === 0) {
    return (
      <section className="session-cost-section" data-chart-id={chartId}>
        <div className="session-cost-section-header">
          <div>
            <div className="session-cost-section-title">{title}</div>
            <div className="session-cost-section-copy">{description}</div>
          </div>
          <div className="session-cost-section-value">{latestValueLabel}</div>
        </div>
        <div className="session-cost-legend">
          {COST_SERIES_DEFINITIONS.map((definition) => (
            <button
              key={definition.key}
              type="button"
              className="session-cost-legend-item"
              aria-pressed="true"
              aria-label={`${definition.label}. ${definition.description}`}
              title={definition.description}
              disabled
            >
              <span
                className="session-cost-legend-swatch"
                style={{ background: definition.color }}
                aria-hidden="true"
              />
              <span className="session-cost-legend-label">{definition.label}</span>
              <span className="session-cost-legend-popover" aria-hidden="true">
                {definition.description}
              </span>
            </button>
          ))}
        </div>
        <div className="session-cost-empty">{emptyCopy}</div>
      </section>
    );
  }

  const maxValue = Math.max(...plottedValues, 0.0001);
  const chartBottom = CHART_HEIGHT - CHART_PADDING_BOTTOM;
  const sliceBounds = buildSliceBounds(points.length);
  const hoveredSlice =
    safeHoveredIndex == null ? null : sliceBounds[safeHoveredIndex] ?? null;
  const hoveredPoint =
    safeHoveredIndex == null ? null : points[safeHoveredIndex] ?? null;
  const hoveredSeries = hoveredPoint
    ? visibleSeries.map((definition) => {
        const value = definition.valueFor(hoveredPoint, mode);
        return {
          definition,
          value,
          x: getXPositionByIndex(hoveredPoint.index, points.length),
          y: value === null ? null : getYPosition(value, maxValue),
        };
      })
    : [];
  const tooltipY = hoveredSeries
    .map((entry) => entry.y)
    .filter((value): value is number => value !== null)
    .reduce((min, value) => Math.min(min, value), chartBottom);
  const tooltipLeftPct =
    hoveredSlice == null
      ? null
      : clampTooltipPct((hoveredSlice.center / CHART_WIDTH) * 100);
  const tooltipTopPct =
    hoveredPoint == null
      ? null
      : clampTooltipPct((tooltipY / CHART_HEIGHT) * 100);

  return (
    <section className="session-cost-section" data-chart-id={chartId}>
      <div className="session-cost-section-header">
        <div>
          <div className="session-cost-section-title">{title}</div>
          <div className="session-cost-section-copy">{description}</div>
        </div>
        <div className="session-cost-section-value">{latestValueLabel}</div>
      </div>

      <div className="session-cost-legend">
        {COST_SERIES_DEFINITIONS.map((definition) => {
          const isVisible = visibleKeys.includes(definition.key);
          return (
            <button
              key={definition.key}
              type="button"
              className={`session-cost-legend-item${isVisible ? "" : " session-cost-legend-item--inactive"}`}
              aria-pressed={isVisible}
              aria-label={`${definition.label}. ${definition.description}`}
              title={definition.description}
              onClick={() => {
                setVisibleKeys((current) => {
                  if (current.includes(definition.key)) {
                    return current.length === 1
                      ? current
                      : current.filter((key) => key !== definition.key);
                  }
                  return [...current, definition.key];
                });
              }}
            >
              <span
                className="session-cost-legend-swatch"
                style={{ background: definition.color }}
                aria-hidden="true"
              />
              <span className="session-cost-legend-label">{definition.label}</span>
              <span className="session-cost-legend-popover" aria-hidden="true">
                {definition.description}
              </span>
            </button>
          );
        })}
      </div>

      <div className="session-cost-chart-shell">
        <div className="session-cost-chart-scale" aria-hidden="true">
          <span>{formatUsd(maxValue)}</span>
          <span>$0</span>
        </div>
        <div className="session-cost-chart-panel">
          <div
            className="session-cost-chart-plot"
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <svg
              className="session-cost-chart"
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {GRID_RATIOS.map((ratio) => {
                const y = getYPosition(maxValue * ratio, maxValue);
                return (
                  <line
                    key={ratio}
                    className="session-cost-chart-grid"
                    x1={CHART_PADDING_LEFT}
                    x2={CHART_WIDTH - CHART_PADDING_RIGHT}
                    y1={y}
                    y2={y}
                  />
                );
              })}

              {points.map((point) =>
                isToolIoReplacementPoint(point) ? (
                  <line
                    key={`tool-io-marker-${point.id}`}
                    className="session-cost-chart-marker session-cost-chart-marker--tool-io"
                    data-call-index={point.index + 1}
                    x1={getXPositionByIndex(point.index, points.length)}
                    x2={getXPositionByIndex(point.index, points.length)}
                    y1={CHART_PADDING_TOP}
                    y2={chartBottom}
                  />
                ) : null,
              )}

              {hoveredSlice != null ? (
                <line
                  className="session-cost-chart-guide"
                  x1={hoveredSlice.center}
                  x2={hoveredSlice.center}
                  y1={CHART_PADDING_TOP}
                  y2={chartBottom}
                />
              ) : null}

              {visibleSeries.map((definition) => {
                const pathSegments: string[] = [];
                let currentSegment: Array<{ x: number; y: number }> = [];

                for (const point of points) {
                  const value = definition.valueFor(point, mode);
                  if (value === null) {
                    if (currentSegment.length > 0) {
                      pathSegments.push(buildLinePath(currentSegment));
                      currentSegment = [];
                    }
                    continue;
                  }

                  currentSegment.push({
                    x: getXPositionByIndex(point.index, points.length),
                    y: getYPosition(value, maxValue),
                  });
                }

                if (currentSegment.length > 0) {
                  pathSegments.push(buildLinePath(currentSegment));
                }

                return (
                  <g key={definition.key}>
                    {pathSegments.map((segment, segmentIndex) => (
                      <path
                        key={`${definition.key}-${segmentIndex}`}
                        d={segment}
                        className="session-cost-chart-line"
                        stroke={definition.color}
                      />
                    ))}
                  </g>
                );
              })}

              {points.map((point) => {
                if (point.callCostUsd !== null || mode === "cumulative") return null;
                return (
                  <circle
                    key={`missing-${point.id}`}
                    className="session-cost-chart-dot session-cost-chart-dot--missing"
                    cx={getXPositionByIndex(point.index, points.length)}
                    cy={chartBottom}
                    r={3.5}
                  />
                );
              })}

              {hoveredSeries.map(({ definition, value, x, y }) =>
                value === null || y === null ? null : (
                  <circle
                    key={`hovered-${definition.key}-${hoveredPoint?.id ?? "none"}`}
                    className="session-cost-chart-dot session-cost-chart-dot--hovered"
                    fill={definition.color}
                    cx={x}
                    cy={y}
                    r={4.5}
                  />
                ),
              )}

              {sliceBounds.map((slice, index) => {
                const label = buildTooltipLabel(mode, points[index]);
                return (
                  <rect
                    key={`slice-${points[index].id}`}
                    className="session-cost-chart-slice"
                    data-call-index={index + 1}
                    x={slice.x}
                    y={CHART_PADDING_TOP}
                    width={slice.width}
                    height={chartBottom - CHART_PADDING_TOP}
                    tabIndex={0}
                    role="button"
                    aria-label={label}
                    onMouseEnter={() => setHoveredIndex(index)}
                    onFocus={() => setHoveredIndex(index)}
                    onBlur={() => setHoveredIndex(null)}
                  />
                );
              })}
            </svg>

            {hoveredPoint && tooltipLeftPct !== null && tooltipTopPct !== null ? (
              <div
                className="session-cost-chart-tooltip"
                style={{ left: `${tooltipLeftPct}%`, top: `${tooltipTopPct}%` }}
                role="tooltip"
              >
                {renderTooltipContent({
                  point: hoveredPoint,
                  hoveredSeries,
                  mode,
                })}
              </div>
            ) : null}
          </div>

          <div className="session-cost-chart-axis">
            <span>Call 1</span>
            <span>Session order</span>
            <span>{`Call ${points.length}`}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function SessionCostModal({
  summary,
  series,
  onClose,
  onOpenProvidersSettings,
}: SessionCostModalProps) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const pricedCallCount = series.filter((point) => point.callCostUsd !== null).length;
  const missingCallCount = Math.max(0, series.length - pricedCallCount);

  return createPortal(
    <div
      className="error-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label="Session cost"
    >
      <ModalShell
        className="error-modal session-cost-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="error-modal-header">
          <span className="error-modal-title session-cost-modal-title">
            <span className="material-symbols-outlined text-md shrink-0">
              show_chart
            </span>
            Session cost
          </span>
          <Button
            className="error-modal-close"
            onClick={onClose}
            title="Close (Esc)"
            variant="ghost"
            size="xxs"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </Button>
        </div>

        <div className="session-cost-modal-body">
          <div className="session-cost-summary-grid">
            <div className="session-cost-stat">
              <div className="session-cost-stat-label">
                {summary.costStatus === "partial" ? "Known subtotal" : "Known cost"}
              </div>
              <div className="session-cost-stat-value">
                {summary.costStatus === "missing"
                  ? "Unavailable"
                  : formatUsd(summary.knownCostUsd)}
              </div>
            </div>
            <div className="session-cost-stat">
              <div className="session-cost-stat-label">API calls</div>
              <div className="session-cost-stat-value">{series.length}</div>
            </div>
            <div className="session-cost-stat">
              <div className="session-cost-stat-label">Priced calls</div>
              <div className="session-cost-stat-value">
                {pricedCallCount}/{series.length}
              </div>
            </div>
            <div className="session-cost-stat">
              <div className="session-cost-stat-label">Total tokens</div>
              <div className="session-cost-stat-value">
                {formatTokens(summary.usage.totalTokens)}
              </div>
            </div>
          </div>

          {summary.missingPricingModels.length > 0 ? (
            <div className="session-cost-warning">
              <div className="session-cost-warning-copy">
                Update AI Providers metadata for{" "}
                <strong>
                  {summary.missingPricingModels.map((model) => model.label).join(", ")}
                </strong>
                . Calls without pricing show as gaps in the per-call chart.
              </div>
              {onOpenProvidersSettings ? (
                <Button onClick={onOpenProvidersSettings} variant="ghost" size="xxs">
                  OPEN AI PROVIDERS
                </Button>
              ) : null}
            </div>
          ) : null}

          <SessionCostMultiLineChart
            chartId="per-call-cost"
            title="Cost per API call"
            description="Toggle total, uncached input, cache read, cache write, and output cost lines. Hover any call slice for one combined tooltip."
            points={series}
            mode="per-call"
            emptyCopy="No priced API calls yet. Add pricing metadata for this model to chart call-level spend."
            latestValueLabel={`${series.length} calls${missingCallCount > 0 ? ` · ${missingCallCount} gap${missingCallCount === 1 ? "" : "s"}` : ""}`}
          />

          <SessionCostMultiLineChart
            chartId="cumulative-cost"
            title="Cumulative session cost"
            description="Running subtotal of known cost across the session, split by the same cost components."
            points={pricedCallCount > 0 ? series : []}
            mode="cumulative"
            emptyCopy="No cumulative cost is available yet because none of the calls have pricing metadata."
            latestValueLabel={
              summary.costStatus === "missing"
                ? "Unavailable"
                : formatUsd(summary.knownCostUsd)
            }
          />

          <section className="session-cost-section">
            <div className="session-cost-section-header">
              <div>
                <div className="session-cost-section-title">Breakdown</div>
                <div className="session-cost-section-copy">
                  Cost and tokens by agent actor.
                </div>
              </div>
            </div>
            <div className="session-cost-breakdown">
              {summary.breakdown.map((entry) => (
                <div
                  key={`${entry.actorKind}:${entry.actorId}`}
                  className="session-cost-breakdown-row"
                >
                  <div>
                    <div className="session-cost-breakdown-label">
                      {entry.actorLabel}
                    </div>
                    <div className="session-cost-breakdown-copy">
                      {entry.operationLabels.join(", ")}
                    </div>
                  </div>
                  <div className="session-cost-breakdown-value">
                    {entry.costStatus === "missing"
                      ? `${formatTokens(entry.usage.totalTokens)} tok`
                      : `${entry.costStatus === "partial" ? "~" : ""}${formatUsd(entry.knownCostUsd)} - ${formatTokens(entry.usage.totalTokens)} tok`}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <p className="session-cost-footnote">
            Costs are estimated from recorded token usage and the pricing metadata
            currently configured for each model.
          </p>
        </div>

        <div className="error-modal-footer">
          <Button onClick={onClose} variant="ghost" size="xxs">
            CLOSE
          </Button>
        </div>
      </ModalShell>
    </div>,
    document.body,
  );
}
