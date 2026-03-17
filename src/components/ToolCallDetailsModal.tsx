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
  awaiting_branch_release: {
    className:
      "bg-[color-mix(in_srgb,var(--color-warning)_16%,transparent)] text-warning",
    label: "RELEASE BRANCH",
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
  const { tool, args, result, status, contextCompaction } = toolCall;

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
  const modelInput = contextCompaction?.input;
  const modelOutput = contextCompaction?.output;

  const modelInputText =
    modelInput?.modelValue !== undefined
      ? stringify(modelInput.modelValue)
      : null;
  const modelOutputText =
    modelOutput?.modelValue !== undefined
      ? stringify(modelOutput.modelValue)
      : null;

  const handleCopy = () => {
    const text = [
      `TOOL: ${tool}`,
      `STATUS: ${status}`,
      `\nPARAMETERS:\n${rawArgs}`,
      rawResult != null ? `\nRESULT:\n${rawResult}` : "",
      contextCompaction
        ? `\nMODEL-FACING CONTEXT:\n${stringify(contextCompaction)}`
        : "",
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

          <div className="tool-modal-section">
            <div className="tool-modal-section-label">Model-Facing Context</div>
            <div className="space-y-3 text-xs leading-[1.6] text-text">
              <div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
                <div className="font-semibold">Input</div>
                <div className="text-muted">
                  {modelInput?.status === "compacted"
                    ? "Compacted before this tool call was appended to apiMessages."
                    : "Parameters were kept full in apiMessages."}
                </div>
                {modelInput?.note ? (
                  <div className="mt-1">
                    <span className="text-muted">Note:</span> {modelInput.note}
                  </div>
                ) : null}
                {modelInput?.reason ? (
                  <div className="mt-1">
                    <span className="text-muted">Reason:</span> {modelInput.reason}
                  </div>
                ) : null}
                {modelInputText ? (
                  <pre className="m-0 mt-2 p-[8px_10px] bg-[color-mix(in_srgb,var(--color-surface)_82%,black)] border border-border-subtle rounded-md text-xs leading-[1.6] whitespace-pre-wrap break-all text-text">
                    {modelInputText}
                  </pre>
                ) : null}
              </div>

              <div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
                <div className="font-semibold">Output</div>
                <div className="text-muted">
                  {modelOutput?.status === "compacted"
                    ? "Compacted before the tool result was appended to apiMessages."
                    : "Tool output was kept full in apiMessages."}
                </div>
                {modelOutput?.mode ? (
                  <div className="mt-1">
                    <span className="text-muted">Mode:</span> {modelOutput.mode}
                  </div>
                ) : null}
                {modelOutput?.note ? (
                  <div className="mt-1">
                    <span className="text-muted">Note:</span> {modelOutput.note}
                  </div>
                ) : null}
                {modelOutput?.reason ? (
                  <div className="mt-1">
                    <span className="text-muted">Reason:</span> {modelOutput.reason}
                  </div>
                ) : null}
                {modelOutputText ? (
                  <pre className="m-0 mt-2 p-[8px_10px] bg-[color-mix(in_srgb,var(--color-surface)_82%,black)] border border-border-subtle rounded-md text-xs leading-[1.6] whitespace-pre-wrap break-all text-text">
                    {modelOutputText}
                  </pre>
                ) : null}
              </div>

              {contextCompaction?.warnings && contextCompaction.warnings.length > 0 ? (
                <div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
                  <div className="font-semibold">Warnings</div>
                  <ul className="m-0 mt-1 list-disc pl-5 text-muted">
                    {contextCompaction.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
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
