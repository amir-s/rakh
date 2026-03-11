import { useEffect, useState } from "react";
import { cn } from "@/utils/cn";

interface CopyableCodePillProps {
  value: string;
  label: string;
  multiline?: boolean;
  className?: string;
}

export default function CopyableCodePill({
  value,
  label,
  multiline = false,
  className,
}: CopyableCodePillProps) {
  const [copyFeedbackToken, setCopyFeedbackToken] = useState(0);
  const copied = copyFeedbackToken > 0;

  useEffect(() => {
    if (copyFeedbackToken === 0) return;
    const timeoutId = window.setTimeout(() => {
      setCopyFeedbackToken((current) =>
        current === copyFeedbackToken ? 0 : current,
      );
    }, 1600);
    return () => window.clearTimeout(timeoutId);
  }, [copyFeedbackToken]);

  const handleCopy = async () => {
    if (!value.trim() || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedbackToken((current) => current + 1);
    } catch {
      // Ignore clipboard failures; the copy action is a convenience affordance.
    }
  };

  return (
    <button
      type="button"
      className={cn(
        "group inline-flex max-w-full self-start items-center gap-2 rounded-md border border-border-subtle bg-subtle/50 px-2 py-1 text-left transition-colors hover:border-border-mid hover:bg-subtle/70",
        multiline ? "justify-between" : "",
        className,
      )}
      onClick={() => {
        void handleCopy();
      }}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
    >
      <span
        className={cn(
          "min-w-0 font-mono text-[11px] text-text",
          multiline ? "break-all whitespace-normal" : "truncate",
        )}
      >
        {value}
      </span>
      <span
        className={cn(
          "material-symbols-outlined shrink-0 text-sm transition-opacity",
          copied ? "text-primary opacity-100" : "text-muted opacity-100",
        )}
      >
        {copied ? "check" : "content_copy"}
      </span>
    </button>
  );
}
