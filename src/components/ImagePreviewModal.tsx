import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { AttachedImage } from "@/agent/types";

interface ImagePreviewModalProps {
  image: AttachedImage;
  onClose: () => void;
}

export default function ImagePreviewModal({
  image,
  onClose,
}: ImagePreviewModalProps) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return createPortal(
    <div
      className="image-preview-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label={image.name}
    >
      <div
        className="image-preview-shell"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="image-preview-header">
          <span className="image-preview-name">{image.name}</span>
          <button
            className="image-preview-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        <div className="image-preview-body">
          <img
            src={image.previewUrl}
            alt={image.name}
            className="image-preview-img"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
