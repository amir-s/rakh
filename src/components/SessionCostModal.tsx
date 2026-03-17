import { useEffect } from "react";
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

interface SessionCostModalProps {
  summary: SessionUsageSummary;
  series: SessionCostSeriesPoint[];
  onClose: () => void;
  onOpenProvidersSettings?: () => void;
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

function getXPosition(
  point: SessionCostSeriesPoint,
  count: number,
): number {
  const chartWidth = CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
  if (count <= 1) return CHART_PADDING_LEFT + chartWidth / 2;
  return CHART_PADDING_LEFT + (point.index / (count - 1)) * chartWidth;
}

function getYPosition(value: number, maxValue: number): number {
  const chartHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
  return (
    CHART_PADDING_TOP +
    chartHeight -
    (value / maxValue) * chartHeight
  );
}

function buildLinePath(
  points: Array<{ x: number; y: number }>,
): string {
  return points
    .map((point, index) =>
      `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    )
    .join(" ");
}

function buildSeriesTitle(point: SessionCostSeriesPoint): string {
  const costLabel =
    point.callCostUsd == null ? "Pricing unavailable" : formatUsd(point.callCostUsd);
  return [
    `${formatDateTime(point.timestamp)}`,
    `${point.actorLabel} - ${point.operation}`,
    `${costLabel} - ${formatTokens(point.totalTokens)} tok`,
  ].join("\n");
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
}: {
  title: string;
  description: string;
  points: SessionCostSeriesPoint[];
  valueFor: (point: SessionCostSeriesPoint) => number | null;
  lineColor: string;
  emptyCopy: string;
  latestValueLabel: string;
  showMissingMarkers?: boolean;
}) {
  const pointsWithValues = points.map((point) => ({
    point,
    value: valueFor(point),
  }));
  const plottedValues = pointsWithValues
    .map((entry) => entry.value)
    .filter((value): value is number => value !== null);

  if (plottedValues.length === 0) {
    return (
      <section className="session-cost-section">
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
    <section className="session-cost-section">
      <div className="session-cost-section-header">
        <div>
          <div className="session-cost-section-title">{title}</div>
          <div className="session-cost-section-copy">{description}</div>
        </div>
        <div className="session-cost-section-value">{latestValueLabel}</div>
      </div>

      <div className="session-cost-chart-shell">
        <div className="session-cost-chart-scale">
          <span>{formatUsd(maxValue)}</span>
          <span>$0</span>
        </div>
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
                <circle
                  key={point.id}
                  className="session-cost-chart-dot session-cost-chart-dot--missing"
                  cx={x}
                  cy={chartBottom}
                  r={3.5}
                >
                  <title>{buildSeriesTitle(point)}</title>
                </circle>
              ) : null
            ) : (
              <circle
                key={point.id}
                className="session-cost-chart-dot"
                cx={x}
                cy={y}
                r={4}
                fill={lineColor}
              >
                <title>{buildSeriesTitle(point)}</title>
              </circle>
            ),
          )}
        </svg>
        <div className="session-cost-chart-axis">
          <span>Call 1</span>
          <span>Session order</span>
          <span>{`Call ${points.length}`}</span>
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
  const latestPricedCall = [...series]
    .reverse()
    .find((point) => point.callCostUsd !== null);

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
                . Calls without pricing show as gaps in the per-call line.
              </div>
              {onOpenProvidersSettings ? (
                <Button onClick={onOpenProvidersSettings} variant="ghost" size="xxs">
                  OPEN AI PROVIDERS
                </Button>
              ) : null}
            </div>
          ) : null}

          <SessionCostLineChart
            title="Cost per API call"
            description="Each finished model request, in session order."
            points={series}
            valueFor={(point) => point.callCostUsd}
            lineColor="var(--color-primary)"
            emptyCopy="No priced API calls yet. Add pricing metadata for this model to chart call-level spend."
            latestValueLabel={
              latestPricedCall?.callCostUsd != null
                ? `Latest ${formatUsd(latestPricedCall.callCostUsd)}`
                : "Latest unavailable"
            }
            showMissingMarkers={missingCallCount > 0}
          />

          <SessionCostLineChart
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
