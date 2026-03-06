import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ArtifactManifest } from "@/agent/tools/artifacts";
import { Button, ModalShell } from "@/components/ui";
import type { SessionArtifactGroup } from "./types";
import ArtifactVersionDropdown from "./ArtifactVersionDropdown";
import { formatArtifactVersionLabel } from "./model";
import { ArtifactRenderer, ArtifactValidationBadge } from "./renderers";

interface ArtifactDetailModalProps {
  artifact: ArtifactManifest | null;
  group: SessionArtifactGroup;
  selectedVersion: number;
  loading: boolean;
  error?: string;
  onVersionChange: (version: number) => void;
  onClose: () => void;
}

export default function ArtifactDetailModal({
  artifact,
  group,
  selectedVersion,
  loading,
  error,
  onVersionChange,
  onClose,
}: ArtifactDetailModalProps) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const selectedManifest =
    group.versions.find((version) => version.version === selectedVersion) ??
    group.latest;

  return createPortal(
    <div
      className="error-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label={`Artifact ${group.artifactId}`}
    >
      <ModalShell
        className="error-modal artifact-detail-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="error-modal-header">
          <span className="error-modal-title artifact-detail-modal-title">
            <span className="material-symbols-outlined text-muted shrink-0 text-md">
              inventory_2
            </span>
            {selectedManifest.summary || selectedManifest.artifactId}
          </span>
          <div className="artifact-detail-header-actions">
            <ArtifactValidationBadge
              validationStatus={artifact?.validation ?? selectedManifest.validation}
            />
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
        </div>

        <div className="error-modal-body artifact-detail-modal-body">
          <div className="artifact-detail-toolbar">
            <div className="artifact-detail-kicker">{selectedManifest.kind}</div>
            {group.versions.length > 1 ? (
              <ArtifactVersionDropdown
                versions={group.versions}
                selectedVersion={selectedVersion}
                onVersionChange={onVersionChange}
                className="artifact-version-dropdown--detail"
              />
            ) : (
              <div className="artifact-detail-version-pill">
                {formatArtifactVersionLabel(selectedManifest)}
              </div>
            )}
          </div>

          <div className="artifact-detail-meta-grid">
            <div>
              <div className="artifact-summary-label">Artifact ID</div>
              <div className="artifact-summary-value">{selectedManifest.artifactId}</div>
            </div>
            <div>
              <div className="artifact-summary-label">Kind</div>
              <div className="artifact-summary-value">{selectedManifest.kind}</div>
            </div>
            <div>
              <div className="artifact-summary-label">Format</div>
              <div className="artifact-summary-value">
                {selectedManifest.contentFormat}
              </div>
            </div>
            <div>
              <div className="artifact-summary-label">Updated</div>
              <div className="artifact-summary-value">
                {new Date(selectedManifest.createdAt).toLocaleString()}
              </div>
            </div>
          </div>

          {loading ? (
            <p className="artifact-loading-copy">Loading artifact content…</p>
          ) : error ? (
            <p className="artifact-inline-error">{error}</p>
          ) : artifact ? (
            <ArtifactRenderer artifact={artifact} mode="detail" />
          ) : (
            <p className="artifact-empty-copy">Artifact content unavailable.</p>
          )}
        </div>
      </ModalShell>
    </div>,
    document.body,
  );
}
