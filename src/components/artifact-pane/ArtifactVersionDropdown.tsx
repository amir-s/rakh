import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactManifest } from "@/agent/tools/artifacts";
import { cn } from "@/utils/cn";
import { formatArtifactVersionLabel } from "./model";

interface ArtifactVersionDropdownProps {
  versions: ArtifactManifest[];
  selectedVersion: number;
  onVersionChange: (version: number) => void;
  className?: string;
}

export default function ArtifactVersionDropdown({
  versions,
  selectedVersion,
  onVersionChange,
  className,
}: ArtifactVersionDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selectedManifest = useMemo(
    () =>
      versions.find((version) => version.version === selectedVersion) ?? versions[0],
    [selectedVersion, versions],
  );

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={cn("artifact-version-dropdown", className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={cn(
          "artifact-version-trigger",
          open && "artifact-version-trigger--open",
        )}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="artifact-version-trigger-label">
          {formatArtifactVersionLabel(selectedManifest)}
        </span>
        <span
          className={cn(
            "material-symbols-outlined artifact-version-trigger-icon",
            open && "artifact-version-trigger-icon--open",
          )}
          aria-hidden="true"
        >
          expand_more
        </span>
      </button>

      {open ? (
        <div className="artifact-version-menu" role="listbox" aria-label="Artifact versions">
          {versions.map((version) => {
            const isSelected = version.version === selectedVersion;

            return (
              <button
                key={version.version}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={cn(
                  "artifact-version-option",
                  isSelected && "artifact-version-option--selected",
                )}
                onClick={() => {
                  setOpen(false);
                  onVersionChange(version.version);
                }}
              >
                <span className="artifact-version-option-label">
                  {formatArtifactVersionLabel(version)}
                </span>
                {isSelected ? (
                  <span
                    className="material-symbols-outlined artifact-version-option-icon"
                    aria-hidden="true"
                  >
                    check
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
