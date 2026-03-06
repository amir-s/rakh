import type { FC, ReactNode } from "react";
import type { AutoApproveCommandsMode } from "@/agent/types";
import CycleOptionSwitch from "@/components/CycleOptionSwitch";

export interface ChatControlsProps {
  autoApproveEdits: boolean;
  autoApproveCommands: AutoApproveCommandsMode;
  onChangeAutoApproveEdits: (value: boolean) => void;
  onChangeAutoApproveCommands: (value: AutoApproveCommandsMode) => void;
  /** 0–100, or null if unknown */
  contextWindowPct: number | null;
  contextCurrentKb: number | null;
  contextMaxKb: number | null;
}

function formatKb(kb: number): string {
  const rounded = kb >= 100 ? kb.toFixed(0) : kb.toFixed(1);
  return `${rounded} KB`;
}

/** Small (i) icon that reveals a popover on hover. */
const InfoPopover: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="chat-ctrl-info">
    <span className="material-symbols-outlined chat-ctrl-info-icon text-sm">
      info
    </span>
    <span className="chat-ctrl-popover">{children}</span>
  </span>
);

const ChatControls: FC<ChatControlsProps> = ({
  autoApproveEdits,
  autoApproveCommands,
  onChangeAutoApproveEdits,
  onChangeAutoApproveCommands,
  contextWindowPct,
  contextCurrentKb,
  contextMaxKb,
}) => {
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
                  <br />
                  The maximum context size for this model is not known.
                </>
              )}
            </InfoPopover>
          </span>
        )}
      </div>
    </div>
  );
};

export default ChatControls;
