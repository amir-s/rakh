import { useState } from "react";
import type { ReactNode } from "react";
import type { AttachedImage } from "@/agent/types";
import ImagePreviewModal from "@/components/ImagePreviewModal";

/* ─────────────────────────────────────────────────────────────────────────────
   UserMessage — a message bubble from the human operator.
───────────────────────────────────────────────────────────────────────────── */

interface UserMessageProps {
  /** Display name shown in the header (default: "YOU") */
  name?: string;
  children: ReactNode;
  images?: AttachedImage[];
  /** Optional header actions rendered on the top-right of the bubble */
  actions?: ReactNode;
}

export default function UserMessage({
  name = "YOU",
  children,
  images,
  actions,
}: UserMessageProps) {
  const [previewImage, setPreviewImage] = useState<AttachedImage | null>(null);

  return (
    <div className="msg animate-fade-up">
      <div className="msg-header">
        <span className="msg-role msg-role--user">{name}</span>
        {actions ? (
          <div className="msg-header-actions">
            <div className="msg-bubble-actions">{actions}</div>
          </div>
        ) : null}
      </div>
      <div className="msg-body">
        {images && images.length > 0 && (
          <div className="msg-image-row">
            {images.map((img) => (
              <button
                key={img.id}
                className="msg-image-chip"
                onClick={() => setPreviewImage(img)}
                title={img.name}
                type="button"
                aria-label={`View image: ${img.name}`}
              >
                <img
                  src={img.previewUrl}
                  alt={img.name}
                  className="msg-image-thumb"
                />
                <span className="msg-image-name">{img.name}</span>
              </button>
            ))}
          </div>
        )}
        {children}
      </div>
      {previewImage && (
        <ImagePreviewModal
          image={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </div>
  );
}
