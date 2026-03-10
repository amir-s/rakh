import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ToolCallDisplay } from "@/agent/types";
import { getToolCallIcon, getToolCallLabel } from "@/components/toolDisplay";
import { cn } from "@/utils/cn";
import { Button, ModalShell } from "@/components/ui";

/* ─────────────────────────────────────────────────────────────────────────────
   ToolCallDetailsModal — full-screen overlay that lets the user inspect a
   completed (done / denied / error / running) tool call's parameters and
   result after the fact.
───────────────────────────────────────────────────────────────────────────── */

/** Status badge Tailwind classes */
const STATUS_BADGE: Record<string, { className: string; label: string }> = {
  done: {
    className:
      "bg-[color-mix(in_srgb,var(--color-success)_15%,transparent)] text-success",
    label: "ALLOWED",
  },
  denied: {
    className:
      "bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)] text-error",
    label: "DENIED",
  },
  error: {
    className:
      "bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)] text-error",
    label: "ERROR",
  },
  running: { className: "bg-primary-dim text-primary", label: "RUNNING" },
  pending: {
    className:
      "bg-[color-mix(in_srgb,var(--color-muted)_12%,transparent)] text-muted",
    label: "PENDING",
  },
  awaiting_approval: {
    className: "bg-primary-dim text-primary",
    label: "AWAITING",
  },
  awaiting_setup_action: {
    className:
      "bg-[color-mix(in_srgb,var(--color-warning)_16%,transparent)] text-warning",
    label: "SETUP ACTION",
  },
};

/** Serialize any value to a readable JSON string. */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

interface ToolCallDetailsModalProps {
  toolCall: ToolCallDisplay;
  onClose: () => void;
}

export default function ToolCallDetailsModal({
  toolCall,
  onClose,
}: ToolCallDetailsModalProps) {
  const { tool, args, result, status } = toolCall;

  const icon = getToolCallIcon(toolCall);
  const label = getToolCallLabel(toolCall);
  const badge = STATUS_BADGE[status];

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const rawArgs = stringify(args);
  const rawResult = result !== undefined ? stringify(result) : null;

  const handleCopy = () => {
    const text = [
      `TOOL: ${tool}`,
      `STATUS: ${status}`,
      `\nPARAMETERS:\n${rawArgs}`,
      rawResult != null ? `\nRESULT:\n${rawResult}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  };

  return createPortal(
    <div
      className="error-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label={`Tool call: ${tool}`}
    >
      <ModalShell
        className="error-modal tool-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="error-modal-header">
          <span className="error-modal-title tool-modal-title">
            <span className="material-symbols-outlined text-muted shrink-0 text-md">
              {icon}
            </span>
            {label}
            <span className="text-xxs font-normal tracking-[0.04em] text-muted normal-case opacity-70">
              {tool}
            </span>
            {badge && (
              <span
                className={cn(
                  badge.className,
                  "text-xxs font-bold tracking-[0.06em] px-1.75 py-px rounded ml-1",
                )}
              >
                {badge.label}
              </span>
            )}
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

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="error-modal-body flex flex-col">
          {/* Parameters section */}
          <div className="tool-modal-section">
            <div className="tool-modal-section-label">Parameters</div>
            <pre className="m-0 p-[8px_10px] bg-surface border border-border-subtle rounded-md text-xs leading-[1.6] whitespace-pre-wrap break-all text-text">
              {rawArgs}
            </pre>
          </div>

          {/* Result section — only shown if a result exists */}
          {rawResult != null && (
            <div className="tool-modal-section">
              <div className="tool-modal-section-label">Result</div>
              <pre
                className={cn(
                  "m-0 p-[8px_10px] bg-surface border border-border-subtle rounded-md text-xs leading-[1.6] whitespace-pre-wrap break-all",
                  status === "error" ? "text-error" : "text-text",
                )}
              >
                {rawResult}
              </pre>
            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div className="error-modal-footer">
          <Button onClick={handleCopy} variant="ghost" size="xxs">
            COPY
          </Button>
          <Button onClick={onClose} variant="ghost" size="xxs">
            CLOSE
          </Button>
        </div>
      </ModalShell>
    </div>,
    document.body,
  );
}
