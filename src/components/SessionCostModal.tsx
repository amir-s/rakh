import { useEffect, useState } from "react";
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
const ACTOR_LINE_COLORS = [
  "var(--color-primary)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-info)",
  "color-mix(in srgb, var(--color-primary) 62%, var(--color-text))",
  "color-mix(in srgb, var(--color-success) 62%, var(--color-text))",
];

interface SessionCostModalProps {
  summary: SessionUsageSummary;
  series: SessionCostSeriesPoint[];
  onClose: () => void;
  onOpenProvidersSettings?: () => void;
}

interface ActorCostSeries {
  key: string;
  label: string;
  color: string;
  points: SessionCostSeriesPoint[];
}

interface ChartTooltipState {
  leftPct: number;
  topPct: number;
  content: string;
}

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

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function getXPosition(point: SessionCostSeriesPoint, totalCount: number): number {
  const chartWidth = CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
  if (totalCount <= 1) return CHART_PADDING_LEFT + chartWidth / 2;
  return CHART_PADDING_LEFT + (point.index / (totalCount - 1)) * chartWidth;
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

function buildPerCallTooltipContent(point: SessionCostSeriesPoint): string {
  const costLabel =
    point.callCostUsd == null ? "Pricing unavailable" : formatUsd(point.callCostUsd);
  return [
    `Call ${point.index + 1}`,
    `${formatDateTime(point.timestamp)}`,
    `${point.actorLabel} - ${point.operation}`,
    `${costLabel} - ${formatTokens(point.totalTokens)} tok`,
  ].join("\n");
}

function buildCumulativeTooltipContent(point: SessionCostSeriesPoint): string {
  const pointCostLabel =
    point.callCostUsd == null
      ? "Call pricing unavailable"
      : `Call cost ${formatUsd(point.callCostUsd)}`;
  return [
    `Call ${point.index + 1}`,
    `${formatDateTime(point.timestamp)}`,
    `${point.actorLabel} - ${point.operation}`,
    `Total so far ${formatUsd(point.cumulativeKnownCostUsd)}`,
    `${pointCostLabel} - ${formatTokens(point.totalTokens)} tok`,
  ].join("\n");
}

function buildTooltipState(
  content: string,
  x: number,
  y: number,
): ChartTooltipState {
  const leftPct = Math.min(94, Math.max(6, (x / CHART_WIDTH) * 100));
  const topPct = Math.min(92, Math.max(8, (y / CHART_HEIGHT) * 100));
  return {
    leftPct,
    topPct,
    content,
  };
}

function buildActorCostSeries(points: SessionCostSeriesPoint[]): ActorCostSeries[] {
  const grouped = new Map<string, ActorCostSeries>();

  for (const point of points) {
    const key = `${point.actorKind}:${point.actorId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.points.push(point);
      continue;
    }

    grouped.set(key, {
      key,
      label: point.actorLabel,
      color: ACTOR_LINE_COLORS[grouped.size % ACTOR_LINE_COLORS.length],
      points: [point],
    });
  }

  return Array.from(grouped.values());
}

function SessionActorCostLineChart({
  title,
  description,
  points,
  emptyCopy,
  showMissingMarkers = false,
  chartId,
}: {
  title: string;
  description: string;
  points: SessionCostSeriesPoint[];
  emptyCopy: string;
  showMissingMarkers?: boolean;
  chartId?: string;
}) {
  const [tooltip, setTooltip] = useState<ChartTooltipState | null>(null);
  const actorSeries = buildActorCostSeries(points);
  const plottedValues = points
    .map((point) => point.callCostUsd)
    .filter((value): value is number => value !== null);

  if (plottedValues.length === 0) {
    return (
      <section className="session-cost-section" data-chart-id={chartId}>
        <div className="session-cost-section-header">
          <div>
            <div className="session-cost-section-title">{title}</div>
            <div className="session-cost-section-copy">{description}</div>
          </div>
          <div className="session-cost-section-value">{points.length} calls</div>
        </div>
        <div className="session-cost-empty">{emptyCopy}</div>
      </section>
    );
  }

  const maxValue = Math.max(...plottedValues, 0.0001);
  const chartBottom = CHART_HEIGHT - CHART_PADDING_BOTTOM;
  const gridValues = [1, 0.75, 0.5, 0.25, 0];

  return (
    <section className="session-cost-section" data-chart-id={chartId}>
      <div className="session-cost-section-header">
        <div>
          <div className="session-cost-section-title">{title}</div>
          <div className="session-cost-section-copy">{description}</div>
        </div>
        <div className="session-cost-section-value">
          {actorSeries.length} actors · {points.length} calls
        </div>
      </div>

      {actorSeries.length > 1 ? (
        <div className="session-cost-legend">
          {actorSeries.map((seriesEntry) => (
            <div key={seriesEntry.key} className="session-cost-legend-item">
              <span
                className="session-cost-legend-swatch"
                style={{ background: seriesEntry.color }}
                aria-hidden="true"
              />
              <span className="session-cost-legend-label">{seriesEntry.label}</span>
              <span className="session-cost-legend-copy">
                {seriesEntry.points.length} call
                {seriesEntry.points.length === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="session-cost-chart-shell">
        <div className="session-cost-chart-scale" aria-hidden="true">
          <span>{formatUsd(maxValue)}</span>
          <span>$0</span>
        </div>
        <div className="session-cost-chart-panel">
          <div className="session-cost-chart-plot">
            <svg
              className="session-cost-chart"
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {gridValues.map((ratio) => {
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

              {actorSeries.map((seriesEntry) => {
                const positioned = seriesEntry.points.map((point) => ({
                  point,
                  x: getXPosition(point, points.length),
                  y:
                    point.callCostUsd === null
                      ? null
                      : getYPosition(point.callCostUsd, maxValue),
                }));

                const pathSegments: string[] = [];
                let currentSegment: Array<{ x: number; y: number }> = [];
                for (const entry of positioned) {
                  if (entry.y === null) {
                    if (currentSegment.length > 0) {
                      pathSegments.push(buildLinePath(currentSegment));
                      currentSegment = [];
                    }
                    continue;
                  }
                  currentSegment.push({ x: entry.x, y: entry.y });
                }
                if (currentSegment.length > 0) {
                  pathSegments.push(buildLinePath(currentSegment));
                }

                return (
                  <g key={seriesEntry.key}>
                    {pathSegments.map((segment, index) => (
                      <path
                        key={`${seriesEntry.key}-${index}`}
                        d={segment}
                        className="session-cost-chart-line"
                        stroke={seriesEntry.color}
                      />
                    ))}
                    {positioned.map(({ point, x, y }) =>
                      y === null ? (
                        showMissingMarkers ? (
                          (() => {
                            const tooltipContent = buildPerCallTooltipContent(point);
                            return (
                              <circle
                                key={point.id}
                                className="session-cost-chart-dot session-cost-chart-dot--missing"
                                data-call-index={point.index + 1}
                                cx={x}
                                cy={chartBottom}
                                r={3.5}
                                aria-label={tooltipContent.replaceAll("\n", " ")}
                                tabIndex={0}
                                onMouseEnter={() =>
                                  setTooltip(buildTooltipState(tooltipContent, x, chartBottom))
                                }
                                onMouseMove={() =>
                                  setTooltip(buildTooltipState(tooltipContent, x, chartBottom))
                                }
                                onMouseLeave={() => setTooltip(null)}
                                onFocus={() =>
                                  setTooltip(buildTooltipState(tooltipContent, x, chartBottom))
                                }
                                onBlur={() => setTooltip(null)}
                              />
                            );
                          })()
                        ) : null
                      ) : (
                        (() => {
                          const tooltipContent = buildPerCallTooltipContent(point);
                          return (
                            <circle
                              key={point.id}
                              className="session-cost-chart-dot"
                              data-call-index={point.index + 1}
                              cx={x}
                              cy={y}
                              r={4}
                              fill={seriesEntry.color}
                              aria-label={tooltipContent.replaceAll("\n", " ")}
                              tabIndex={0}
                              onMouseEnter={() =>
                                setTooltip(buildTooltipState(tooltipContent, x, y))
                              }
                              onMouseMove={() =>
                                setTooltip(buildTooltipState(tooltipContent, x, y))
                              }
                              onMouseLeave={() => setTooltip(null)}
                              onFocus={() => setTooltip(buildTooltipState(tooltipContent, x, y))}
                              onBlur={() => setTooltip(null)}
                            />
                          );
                        })()
                      ),
                    )}
                  </g>
                );
              })}
            </svg>
            {tooltip ? (
              <div
                className="session-cost-chart-tooltip"
                style={{ left: `${tooltip.leftPct}%`, top: `${tooltip.topPct}%` }}
                role="tooltip"
              >
                {tooltip.content}
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

function SessionCostLineChart({
  title,
  description,
  points,
  valueFor,
  lineColor,
  emptyCopy,
  latestValueLabel,
  showMissingMarkers = false,
  chartId,
  buildTooltipContent = buildPerCallTooltipContent,
}: {
  title: string;
  description: string;
  points: SessionCostSeriesPoint[];
  valueFor: (point: SessionCostSeriesPoint) => number | null;
  lineColor: string;
  emptyCopy: string;
  latestValueLabel: string;
  showMissingMarkers?: boolean;
  chartId?: string;
  buildTooltipContent?: (point: SessionCostSeriesPoint) => string;
}) {
  const [tooltip, setTooltip] = useState<ChartTooltipState | null>(null);
  const pointsWithValues = points.map((point) => ({
    point,
    value: valueFor(point),
  }));
  const plottedValues = pointsWithValues
    .map((entry) => entry.value)
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
        <div className="session-cost-empty">{emptyCopy}</div>
      </section>
    );
  }

  const maxValue = Math.max(...plottedValues, 0.0001);
  const chartBottom = CHART_HEIGHT - CHART_PADDING_BOTTOM;
  const gridValues = [1, 0.75, 0.5, 0.25, 0];
  const positioned = pointsWithValues.map(({ point, value }) => ({
    point,
    value,
    x: getXPosition(point, points.length),
    y: value === null ? null : getYPosition(value, maxValue),
  }));

  const pathSegments: string[] = [];
  let currentSegment: Array<{ x: number; y: number }> = [];
  for (const entry of positioned) {
    if (entry.y === null) {
      if (currentSegment.length > 0) {
        pathSegments.push(buildLinePath(currentSegment));
        currentSegment = [];
      }
      continue;
    }
    currentSegment.push({ x: entry.x, y: entry.y });
  }
  if (currentSegment.length > 0) {
    pathSegments.push(buildLinePath(currentSegment));
  }

  return (
    <section className="session-cost-section" data-chart-id={chartId}>
      <div className="session-cost-section-header">
        <div>
          <div className="session-cost-section-title">{title}</div>
          <div className="session-cost-section-copy">{description}</div>
        </div>
        <div className="session-cost-section-value">{latestValueLabel}</div>
      </div>

      <div className="session-cost-chart-shell">
        <div className="session-cost-chart-scale" aria-hidden="true">
          <span>{formatUsd(maxValue)}</span>
          <span>$0</span>
        </div>
        <div className="session-cost-chart-panel">
          <div className="session-cost-chart-plot">
            <svg
              className="session-cost-chart"
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {gridValues.map((ratio) => {
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
              {pathSegments.map((segment, index) => (
                <path
                  key={`${title}-${index}`}
                  d={segment}
                  className="session-cost-chart-line"
                  stroke={lineColor}
                />
              ))}
              {positioned.map(({ point, value, x, y }) =>
                y === null ? (
                  showMissingMarkers ? (
                    (() => {
                      const tooltipContent = buildTooltipContent(point);
                      return (
                        <circle
                          key={point.id}
                          className="session-cost-chart-dot session-cost-chart-dot--missing"
                          data-call-index={point.index + 1}
                          cx={x}
                          cy={chartBottom}
                          r={3.5}
                          aria-label={tooltipContent.replaceAll("\n", " ")}
                          tabIndex={0}
                          onMouseEnter={() =>
                            setTooltip(buildTooltipState(tooltipContent, x, chartBottom))
                          }
                          onMouseMove={() =>
                            setTooltip(buildTooltipState(tooltipContent, x, chartBottom))
                          }
                          onMouseLeave={() => setTooltip(null)}
                          onFocus={() =>
                            setTooltip(buildTooltipState(tooltipContent, x, chartBottom))
                          }
                          onBlur={() => setTooltip(null)}
                        />
                      );
                    })()
                  ) : null
                ) : (
                  (() => {
                    const tooltipContent = buildTooltipContent(point);
                    return (
                      <circle
                        key={point.id}
                        className="session-cost-chart-dot"
                        data-call-index={point.index + 1}
                        cx={x}
                        cy={y}
                        r={4}
                        fill={lineColor}
                        aria-label={tooltipContent.replaceAll("\n", " ")}
                        tabIndex={0}
                        onMouseEnter={() =>
                          setTooltip(buildTooltipState(tooltipContent, x, y))
                        }
                        onMouseMove={() =>
                          setTooltip(buildTooltipState(tooltipContent, x, y))
                        }
                        onMouseLeave={() => setTooltip(null)}
                        onFocus={() => setTooltip(buildTooltipState(tooltipContent, x, y))}
                        onBlur={() => setTooltip(null)}
                      />
                    );
                  })()
                ),
              )}
            </svg>
            {tooltip ? (
              <div
                className="session-cost-chart-tooltip"
                style={{ left: `${tooltip.leftPct}%`, top: `${tooltip.topPct}%` }}
                role="tooltip"
              >
                {tooltip.content}
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

          <SessionActorCostLineChart
            chartId="per-call-cost"
            title="Cost per API call"
            description="Separate line per actor, positioned by where each call happened in the session."
            points={series}
            emptyCopy="No priced API calls yet. Add pricing metadata for this model to chart call-level spend."
            showMissingMarkers={missingCallCount > 0}
          />

          <SessionCostLineChart
            chartId="cumulative-cost"
            title="Cumulative session cost"
            description="Running subtotal of known cost across the session."
            points={pricedCallCount > 0 ? series : []}
            valueFor={(point) => point.cumulativeKnownCostUsd}
            lineColor="var(--color-success)"
            emptyCopy="No cumulative cost is available yet because none of the calls have pricing metadata."
            latestValueLabel={
              summary.costStatus === "missing"
                ? "Unavailable"
                : formatUsd(summary.knownCostUsd)
            }
            buildTooltipContent={buildCumulativeTooltipContent}
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
