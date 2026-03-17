import { useState, type FC, type ReactNode } from "react";
import type { AutoApproveCommandsMode } from "@/agent/types";
import type {
  SessionCostSeriesPoint,
  SessionUsageSummary,
} from "@/agent/sessionStats";
import CycleOptionSwitch from "@/components/CycleOptionSwitch";
import SessionCostModal from "@/components/SessionCostModal";

export interface ChatControlsProps {
  autoApproveEdits: boolean;
  autoApproveCommands: AutoApproveCommandsMode;
  onChangeAutoApproveEdits: (value: boolean) => void;
  onChangeAutoApproveCommands: (value: AutoApproveCommandsMode) => void;
  /** 0–100, or null if unknown */
  contextWindowPct: number | null;
  contextCurrentTokens: number | null;
  contextCurrentKb: number | null;
  contextMaxKb: number | null;
  sessionUsageSummary: SessionUsageSummary | null;
  sessionCostSeries?: SessionCostSeriesPoint[] | null;
  onOpenProvidersSettings?: () => void;
}

function formatKb(kb: number): string {
  const rounded = kb >= 100 ? kb.toFixed(0) : kb.toFixed(1);
  return `${rounded} KB`;
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

function formatUsd(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

/** Small (i) icon that reveals a popover on hover. */
const InfoPopover: FC<{ children: ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <span className="chat-ctrl-info">
    <span className="material-symbols-outlined chat-ctrl-info-icon text-sm">
      info
    </span>
    <span className={`chat-ctrl-popover ${className ?? ""}`.trim()}>{children}</span>
  </span>
);

const ChatControls: FC<ChatControlsProps> = ({
  autoApproveEdits,
  autoApproveCommands,
  onChangeAutoApproveEdits,
  onChangeAutoApproveCommands,
  contextWindowPct,
  contextCurrentTokens,
  contextCurrentKb,
  contextMaxKb,
  sessionUsageSummary,
  sessionCostSeries,
  onOpenProvidersSettings,
}) => {
  const [sessionCostModalOpen, setSessionCostModalOpen] = useState(false);
  const ctxColor =
    contextWindowPct == null
      ? "var(--color-muted)"
      : contextWindowPct >= 85
        ? "var(--color-error)"
        : contextWindowPct >= 60
          ? "var(--color-warning)"
          : "var(--color-success)";

  return (
    <div className="chat-controls">
      {/* ── Left: switches ───────────────────────────────────────────── */}
      <div className="chat-controls-left">
        <CycleOptionSwitch
          label="Auto edits"
          value={autoApproveEdits}
          options={[
            { value: false, label: "No" },
            { value: true, label: "Yes" },
          ]}
          onChange={onChangeAutoApproveEdits}
        />
        <CycleOptionSwitch
          label="Auto run"
          value={autoApproveCommands}
          options={[
            { value: "no", label: "No" },
            { value: "agent", label: "Agent decides" },
            { value: "yes", label: "Yes" },
          ]}
          onChange={onChangeAutoApproveCommands}
        />

        {/* Single shared info popover for both switches */}
        <InfoPopover>
          <strong>Auto edits</strong> — file writes and patches are approved
          without a prompt.
          <br />
          <strong>Auto run</strong> — `No` always asks, `Yes` always runs, and
          `Agent decides` follows each command's approval hint.
        </InfoPopover>
      </div>

      {/* ── Right: git branch + context window ───────────────────────── */}
      <div className="chat-controls-right">
        {sessionUsageSummary ? (
          <button
            type="button"
            className="chat-ctrl-session"
            style={{
              color:
                sessionUsageSummary.costStatus === "complete"
                  ? "var(--color-primary)"
                  : "var(--color-warning)",
            }}
            onClick={() => setSessionCostModalOpen(true)}
            title={
              sessionUsageSummary.costStatus === "complete"
                ? "Open session cost details"
                : "Open session cost details and pricing warnings"
            }
          >
            <span className="material-symbols-outlined text-sm">
              {sessionUsageSummary.costStatus === "complete"
                ? "price_check"
                : "warning"}
            </span>
            <span className="chat-ctrl-session-label">
              {sessionUsageSummary.costStatus === "missing" ? (
                <>cost?</>
              ) : (
                <>
                  {sessionUsageSummary.costStatus === "partial" ? "~" : ""}
                  {formatUsd(sessionUsageSummary.knownCostUsd)}
                </>
              )}
            </span>
            <InfoPopover className="chat-ctrl-popover--wide">
              <div className="chat-ctrl-popover-section">
                <div className="chat-ctrl-popover-heading">Session usage</div>
                <div className="chat-ctrl-popover-row">
                  <span>Input</span>
                  <strong>{formatTokens(sessionUsageSummary.usage.inputTokens)} tok</strong>
                </div>
                <div className="chat-ctrl-popover-row">
                  <span>Output</span>
                  <strong>{formatTokens(sessionUsageSummary.usage.outputTokens)} tok</strong>
                </div>
                <div className="chat-ctrl-popover-row">
                  <span>Total</span>
                  <strong>{formatTokens(sessionUsageSummary.usage.totalTokens)} tok</strong>
                </div>
                <div className="chat-ctrl-popover-row">
                  <span>
                    {sessionUsageSummary.costStatus === "partial"
                      ? "Known subtotal"
                      : "Cost"}
                  </span>
                  <strong>
                    {sessionUsageSummary.costStatus === "missing"
                      ? "Unavailable"
                      : formatUsd(sessionUsageSummary.knownCostUsd)}
                  </strong>
                </div>
              </div>
              {sessionUsageSummary.breakdown.length > 0 ? (
                <div className="chat-ctrl-popover-section">
                  <div className="chat-ctrl-popover-heading">Breakdown</div>
                  {sessionUsageSummary.breakdown.map((entry) => (
                    <div
                      key={`${entry.actorKind}:${entry.actorId}`}
                      className="chat-ctrl-popover-row"
                    >
                      <span>{entry.actorLabel}</span>
                      <strong>
                        {entry.costStatus === "missing"
                          ? `${formatTokens(entry.usage.totalTokens)} tok`
                          : `${entry.costStatus === "partial" ? "~" : ""}${formatUsd(entry.knownCostUsd)} · ${formatTokens(entry.usage.totalTokens)} tok`}
                      </strong>
                    </div>
                  ))}
                </div>
              ) : null}
              {sessionUsageSummary.missingPricingModels.length > 0 ? (
                <div className="chat-ctrl-popover-section">
                  <div className="chat-ctrl-popover-heading">Missing pricing</div>
                  <div>
                    Update AI Providers metadata for{" "}
                    <strong>
                      {sessionUsageSummary.missingPricingModels
                        .map((model) => model.label)
                        .join(", ")}
                    </strong>
                    .
                  </div>
                </div>
              ) : null}
            </InfoPopover>
          </button>
        ) : null}
        {(contextWindowPct != null || contextCurrentKb != null) && (
          <span className="chat-ctrl-ctx" style={{ color: ctxColor }}>
            <span className="material-symbols-outlined text-sm">
              data_usage
            </span>
            {contextWindowPct != null
              ? `${contextWindowPct.toFixed(0)}% ctx`
              : contextCurrentKb != null
                ? formatKb(contextCurrentKb)
                : null}
            <span className="chat-ctrl-ctx-bar">
              {contextWindowPct != null ? (
                <span
                  className="chat-ctrl-ctx-fill"
                  style={{
                    width: `${Math.min(100, contextWindowPct)}%`,
                    background: ctxColor,
                  }}
                />
              ) : (
                <span
                  className="chat-ctrl-ctx-fill chat-ctrl-ctx-fill--unknown"
                  style={{ background: ctxColor }}
                />
              )}
            </span>
            <InfoPopover>
              {contextWindowPct != null ? (
                <>
                  <strong>{contextWindowPct.toFixed(0)}%</strong> of the
                  model's context window is used. When this approaches{" "}
                  <strong>100%</strong>, older messages will be truncated or
                  the request may fail.
                  {contextCurrentTokens != null && (
                    <>
                      <br />
                      Est. current tokens:{" "}
                      <strong>{formatTokens(contextCurrentTokens)}</strong>.
                    </>
                  )}
                  {contextCurrentKb != null && contextMaxKb != null && (
                    <>
                      <br />
                      Approx size:{" "}
                      <strong>{formatKb(contextCurrentKb)}</strong> /{" "}
                      <strong>{formatKb(contextMaxKb)}</strong>.
                    </>
                  )}
                </>
              ) : (
                <>
                  Current context size:{" "}
                  <strong>
                    {contextCurrentKb != null ? formatKb(contextCurrentKb) : "unknown"}
                  </strong>.
                  {contextCurrentTokens != null && (
                    <>
                      <br />
                      Est. current tokens:{" "}
                      <strong>{formatTokens(contextCurrentTokens)}</strong>.
                    </>
                  )}
                  <br />
                  The maximum context size for this model is not known.
                </>
              )}
            </InfoPopover>
          </span>
        )}
      </div>
      {sessionCostModalOpen && sessionUsageSummary ? (
        <SessionCostModal
          summary={sessionUsageSummary}
          series={sessionCostSeries ?? []}
          onClose={() => setSessionCostModalOpen(false)}
          onOpenProvidersSettings={
            onOpenProvidersSettings
              ? () => {
                  setSessionCostModalOpen(false);
                  onOpenProvidersSettings();
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
};

export default ChatControls;
