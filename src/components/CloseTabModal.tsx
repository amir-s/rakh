import { useEffect, useRef } from "react";
import { Button, ModalShell } from "@/components/ui";

interface CloseTabModalProps {
  tabLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function CloseTabModal({
  tabLabel,
  onCancel,
  onConfirm,
}: CloseTabModalProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus the cancel button by default (safe option)
  useEffect(() => {
    const cancelBtn = document.querySelector<HTMLButtonElement>(
      ".close-tab-modal .modal-cancel",
    );
    cancelBtn?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, onConfirm]);

  return (
    <div className="close-tab-modal-overlay" onClick={onCancel}>
      <ModalShell
        className="close-tab-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-tab-modal-title"
      >
        <div className="modal-icon">
          <span className="material-symbols-outlined text-4xl">warning</span>
        </div>
        <h2 id="close-tab-modal-title" className="modal-title">
          Agent is still running
        </h2>
        <p className="modal-body">
          <strong>{tabLabel || "This tab"}</strong> has an active agent. Closing
          it will interrupt the current task.
        </p>
        <div className="modal-actions">
          <Button
            className="modal-cancel"
            variant="ghost"
            size="sm"
            onClick={onCancel}
          >
            Keep open
          </Button>
          <Button
            ref={confirmRef}
            className="modal-confirm modal-confirm--danger"
            variant="danger"
            size="sm"
            onClick={onConfirm}
          >
            Close anyway
          </Button>
        </div>
      </ModalShell>
    </div>
  );
}
