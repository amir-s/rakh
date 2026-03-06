import { useEffect, useMemo, useState } from "react";
import type { ArtifactManifest } from "@/agent/tools/artifacts";
import { Badge, Panel } from "@/components/ui";
import ArtifactKindFilterStrip from "./ArtifactKindFilterStrip";
import type {
  ArtifactContentEntry,
  ArtifactFilterValue,
  SessionArtifactGroup,
  SessionArtifactInventory,
} from "./types";
import { ARTIFACT_FILTER_ALL } from "./types";
import {
  buildArtifactFilterOptions,
  filterArtifactGroups,
  formatArtifactVersionLabel,
} from "./model";
import ArtifactVersionDropdown from "./ArtifactVersionDropdown";
import ArtifactDetailModal from "./ArtifactDetailModal";
import PaneEmptyState from "./PaneEmptyState";
import { ArtifactRenderer, ArtifactValidationBadge } from "./renderers";

function getSelectedManifest(
  group: SessionArtifactGroup,
  selectedVersions: Record<string, number>,
): ArtifactManifest {
  const selectedVersion = selectedVersions[group.artifactId];
  return (
    group.versions.find((version) => version.version === selectedVersion) ??
    group.latest
  );
}

function ArtifactCard({
  group,
  selectedManifest,
  entry,
  onVersionChange,
  onOpen,
  ensureArtifactContent,
}: {
  group: SessionArtifactGroup;
  selectedManifest: ArtifactManifest;
  entry?: ArtifactContentEntry;
  onVersionChange: (version: number) => void;
  onOpen: () => void;
  ensureArtifactContent: (artifactId: string, version: number) => Promise<void>;
}) {
  useEffect(() => {
    void ensureArtifactContent(group.artifactId, selectedManifest.version);
  }, [ensureArtifactContent, group.artifactId, selectedManifest.version]);

  const hydratedArtifact = entry?.artifact;

  return (
    <Panel
      variant="inset"
      className="artifact-browser-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="artifact-browser-card-header">
        <div className="artifact-browser-card-meta">
          <div className="artifact-chip-row">
            <Badge variant="primary">{group.kind}</Badge>
            {group.versions.length > 1 ? (
              <Badge variant="muted">{group.versions.length} versions</Badge>
            ) : null}
            <ArtifactValidationBadge
              validationStatus={hydratedArtifact?.validation ?? selectedManifest.validation}
            />
          </div>
          <div className="artifact-browser-card-title">
            {selectedManifest.summary || group.artifactId}
          </div>
          <div className="artifact-browser-card-subtitle">
            {group.artifactId} · updated{" "}
            {new Date(selectedManifest.createdAt).toLocaleString()}
          </div>
        </div>

        {group.versions.length > 1 ? (
          <ArtifactVersionDropdown
            versions={group.versions}
            selectedVersion={selectedManifest.version}
            onVersionChange={onVersionChange}
          />
        ) : (
          <div className="artifact-browser-card-version">
            {formatArtifactVersionLabel(selectedManifest)}
          </div>
        )}
      </div>

      <div className="artifact-browser-card-body">
        {entry?.status === "error" ? (
          <p className="artifact-inline-error">{entry.error}</p>
        ) : entry?.status === "loaded" && hydratedArtifact ? (
          <ArtifactRenderer artifact={hydratedArtifact} mode="compact" />
        ) : (
          <p className="artifact-loading-copy">Loading preview…</p>
        )}
      </div>
    </Panel>
  );
}

interface ArtifactsPaneProps {
  inventory: SessionArtifactInventory;
  loading: boolean;
  error: string | null;
  getContentEntry: (artifactId: string, version: number) => ArtifactContentEntry | undefined;
  ensureArtifactContent: (artifactId: string, version: number) => Promise<void>;
}

export default function ArtifactsPane({
  inventory,
  loading,
  error,
  getContentEntry,
  ensureArtifactContent,
}: ArtifactsPaneProps) {
  const [filterValue, setFilterValue] = useState<ArtifactFilterValue>(
    ARTIFACT_FILTER_ALL,
  );
  const [selectedVersions, setSelectedVersions] = useState<Record<string, number>>(
    {},
  );
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);

  const effectiveFilterValue =
    filterValue === ARTIFACT_FILTER_ALL ||
    inventory.kindCounts.some((entry) => entry.kind === filterValue)
      ? filterValue
      : ARTIFACT_FILTER_ALL;

  const filterOptions = useMemo(
    () => buildArtifactFilterOptions(inventory.kindCounts),
    [inventory.kindCounts],
  );

  const filteredGroups = useMemo(
    () => filterArtifactGroups(inventory.groups, effectiveFilterValue),
    [effectiveFilterValue, inventory.groups],
  );

  const openGroup = openArtifactId
    ? inventory.groups.find((group) => group.artifactId === openArtifactId) ?? null
    : null;

  const openManifest = openGroup
    ? getSelectedManifest(openGroup, selectedVersions)
    : null;
  const openEntry =
    openGroup && openManifest
      ? getContentEntry(openGroup.artifactId, openManifest.version)
      : undefined;

  useEffect(() => {
    if (!openGroup || !openManifest) return;
    void ensureArtifactContent(openGroup.artifactId, openManifest.version);
  }, [ensureArtifactContent, openGroup, openManifest]);

  if (loading && inventory.groups.length === 0) {
    return (
      <div className="artifact-tab-content">
        <p className="artifact-loading-copy">Loading session artifacts…</p>
      </div>
    );
  }

  if (error && inventory.groups.length === 0) {
    return (
      <div className="artifact-tab-content">
        <p className="artifact-inline-error">{error}</p>
      </div>
    );
  }

  if (inventory.groups.length === 0) {
    return (
      <PaneEmptyState message="No artifacts yet — saved outputs for this session will appear here." />
    );
  }

  return (
    <>
      <div className="artifact-tab-content artifact-browser">
        <div className="artifact-browser-toolbar">
          <div>
            <div className="plan-section-label mb-2">Session Artifacts</div>
            <p className="artifact-browser-copy">
              Latest version per artifact, with version history available inline.
            </p>
          </div>
          <ArtifactKindFilterStrip
            options={filterOptions}
            value={effectiveFilterValue}
            onChange={setFilterValue}
          />
        </div>

        {error ? <p className="artifact-inline-error">{error}</p> : null}

        {filteredGroups.length === 0 ? (
          <p className="artifact-empty-copy">No artifacts match the selected kind.</p>
        ) : (
          <div className="artifact-browser-grid">
            {filteredGroups.map((group) => {
              const selectedManifest = getSelectedManifest(group, selectedVersions);
              return (
                <ArtifactCard
                  key={group.artifactId}
                  group={group}
                  selectedManifest={selectedManifest}
                  entry={getContentEntry(group.artifactId, selectedManifest.version)}
                  ensureArtifactContent={ensureArtifactContent}
                  onVersionChange={(version) =>
                    setSelectedVersions((prev) => ({
                      ...prev,
                      [group.artifactId]: version,
                    }))
                  }
                  onOpen={() => setOpenArtifactId(group.artifactId)}
                />
              );
            })}
          </div>
        )}
      </div>

      {openGroup && openManifest ? (
        <ArtifactDetailModal
          group={openGroup}
          selectedVersion={openManifest.version}
          artifact={openEntry?.artifact ?? null}
          loading={openEntry?.status === "loading" || openEntry == null}
          error={openEntry?.status === "error" ? openEntry.error : undefined}
          onVersionChange={(version) =>
            setSelectedVersions((prev) => ({
              ...prev,
              [openGroup.artifactId]: version,
            }))
          }
          onClose={() => setOpenArtifactId(null)}
        />
      ) : null}
    </>
  );
}
