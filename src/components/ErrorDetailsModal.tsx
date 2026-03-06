import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Button, ModalShell } from "@/components/ui";

/* ─────────────────────────────────────────────────────────────────────────────
   ErrorDetailsModal — full-screen overlay that shows raw error details so you
   can debug API errors, tool errors, and network failures.

   Usage:
     const [errorModal, setErrorModal] = useState<ErrorModalState | null>(null);
     // open:  setErrorModal({ title: "API Error", details: errorObj })
     // close: setErrorModal(null)
     {errorModal && (
       <ErrorDetailsModal {...errorModal} onClose={() => setErrorModal(null)} />
     )}
───────────────────────────────────────────────────────────────────────────── */

export interface ErrorModalState {
  title: string;
  details: unknown;
  showDebug?: boolean;
}

interface ErrorDetailsModalProps extends ErrorModalState {
  onClose: () => void;
}

/** Serialize any value to a readable string for display. */
function stringify(details: unknown): string {
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details, null, 2) ?? String(details);
  } catch {
    return String(details);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compactNameMessage(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name : null;
  const message = typeof value.message === "string" ? value.message : null;
  if (!name || !message) return null;
  return { name, message };
}

function compactStreamErrors(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => compactNameMessage(entry))
    .filter((entry): entry is Record<string, string> => entry !== null);
}

function summarizeErrorDetails(details: unknown): unknown {
  if (!isRecord(details)) return details;

  const root =
    compactNameMessage(details) ??
    compactNameMessage(details.error) ??
    compactNameMessage(details.cause);

  if (!root) return details;

  const compact: Record<string, unknown> = { ...root };
  const cause =
    compactNameMessage(details.cause) ??
    compactNameMessage(details.error) ??
    compactStreamErrors(details.streamErrors)[0] ??
    null;

  if (cause) compact.cause = cause;
  return compact;
}

export default function ErrorDetailsModal({
  title,
  details,
  showDebug,
  onClose,
}: ErrorDetailsModalProps) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const raw = stringify(showDebug ? details : summarizeErrorDetails(details));

  const handleCopy = () => {
    navigator.clipboard.writeText(raw).catch(() => {});
  };

  return createPortal(
    <div
      className="error-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label={title}
    >
      <ModalShell
        className="error-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="error-modal-header">
          <span className="error-modal-title">
            <span className="material-symbols-outlined text-md text-error shrink-0">
              error
            </span>
            {title}
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

        {/* ── Body — raw error dump ───────────────────────────────────────── */}
        <pre className="error-modal-body">{raw}</pre>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
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
