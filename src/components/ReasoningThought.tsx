import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";

interface ReasoningThoughtProps {
  messageId: string;
  reasoning?: string;
  reasoningStreaming?: boolean;
  reasoningStartedAtMs?: number;
  reasoningDurationMs?: number;
  expanded: boolean;
  onToggle: (messageId: string) => void;
}

function buildPreviewText(
  reasoning: string | undefined,
  reasoningStreaming: boolean | undefined,
): string {
  const normalized = (reasoning ?? "").replace(/\s+/g, " ").trim();
  const tail =
    normalized.length > 280 ? `…${normalized.slice(-279)}` : normalized;
  if (tail) return tail;
  return reasoningStreaming ? "Streaming reasoning..." : "";
}

function formatDurationLabel(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const suffix = seconds === 1 ? "" : "s";
  return `Thought for ${seconds} second${suffix}`;
}

export default function ReasoningThought({
  messageId,
  reasoning,
  reasoningStreaming,
  reasoningStartedAtMs,
  reasoningDurationMs,
  expanded,
  onToggle,
}: ReasoningThoughtProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!(reasoningStreaming && typeof reasoningStartedAtMs === "number")) {
      const timeoutId = window.setTimeout(() => setNowMs(Date.now()), 0);
      return () => window.clearTimeout(timeoutId);
    }
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);
    return () => window.clearInterval(interval);
  }, [reasoningStreaming, reasoningStartedAtMs]);

  const previewText = useMemo(
    () => buildPreviewText(reasoning, reasoningStreaming),
    [reasoning, reasoningStreaming],
  );
  const showPreview = !expanded && previewText.length > 0;

  const labelText = useMemo(() => {
    if (reasoningStreaming) return "Thinking";

    if (typeof reasoningDurationMs === "number") {
      return formatDurationLabel(reasoningDurationMs);
    }

    if (typeof reasoningStartedAtMs === "number") {
      return formatDurationLabel(Math.max(0, nowMs - reasoningStartedAtMs));
    }

    return "Thinking";
  }, [nowMs, reasoningDurationMs, reasoningStartedAtMs, reasoningStreaming]);

  const labelKey = reasoningStreaming ? "thinking" : `done-${labelText}`;

  return (
    <div className="msg-reasoning">
      <button
        className="msg-reasoning-head"
        type="button"
        onClick={() => onToggle(messageId)}
        aria-expanded={expanded}
      >
        <div className="msg-reasoning-label-wrap">
          <AnimatePresence initial={false} mode="wait">
            <motion.span
              key={labelKey}
              className="msg-reasoning-label"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
            >
              {labelText}
            </motion.span>
          </AnimatePresence>
        </div>

        <div className="msg-reasoning-preview-wrap">
          {showPreview && (
            <span
              className={`msg-reasoning-preview${reasoningStreaming ? " msg-reasoning-preview--streaming" : ""}`}
            >
              {previewText}
            </span>
          )}
        </div>

        {reasoningStreaming && <span className="msg-reasoning-spinner" />}
        <span
          className={`material-symbols-outlined msg-reasoning-chevron${expanded ? " msg-reasoning-chevron--open" : ""}`}
        >
          expand_more
        </span>
      </button>

      {expanded && reasoning && (
        <div className="msg-reasoning-text">{reasoning}</div>
      )}
    </div>
  );
}
