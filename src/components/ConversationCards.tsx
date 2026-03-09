import { useEffect, useState, type CSSProperties } from "react";
import type { ConversationCard } from "@/agent/types";
import type { ArtifactManifest } from "@/agent/tools/artifacts";
import Markdown from "@/components/Markdown";
import type {
  ArtifactContentEntry,
  SessionArtifactGroup,
  SessionArtifactInventory,
} from "@/components/artifact-pane/types";
import ArtifactDetailModal from "@/components/artifact-pane/ArtifactDetailModal";
import { resolveArtifactRenderKind } from "@/components/artifact-pane/model";
import { ArtifactRenderer } from "@/components/artifact-pane/renderers";
import { Badge, Button, Panel } from "@/components/ui";

function findArtifactGroup(
  inventory: SessionArtifactInventory,
  artifactId: string,
): SessionArtifactGroup | undefined {
  return inventory.groups.find((group) => group.artifactId === artifactId);
}

function resolveArtifactVersion(
  card: Extract<ConversationCard, { kind: "artifact" }>,
  inventory: SessionArtifactInventory,
): number | null {
  if (card.version !== undefined) return card.version;
  return findArtifactGroup(inventory, card.artifactId)?.latest.version ?? null;
}

function resolveArtifactSummary(
  card: Extract<ConversationCard, { kind: "artifact" }>,
  entry: ArtifactContentEntry | undefined,
  group?: SessionArtifactGroup,
): string {
  if (card.title) return card.title;
  if (entry?.artifact?.summary) return entry.artifact.summary;
  if (group?.latest.summary) return group.latest.summary;
  return card.artifactId;
}

function resolveArtifactVersionLabel(
  manifest?: ArtifactManifest,
  version?: number | null,
): string {
  if (manifest) return `v${manifest.version}`;
  if (typeof version === "number") return `v${version}`;
  return "latest";
}

export function buildExecutePlanArtifactMessage(artifactId: string): string {
  return `Execute the plan with artifact ID: ${artifactId}`;
}

function ArtifactConversationCard({
  card,
  inventory,
  inventoryLoading,
  getArtifactContentEntry,
  ensureArtifactContent,
  onExecutePlan,
  executePlanDisabled = false,
}: {
  card: Extract<ConversationCard, { kind: "artifact" }>;
  inventory: SessionArtifactInventory;
  inventoryLoading: boolean;
  getArtifactContentEntry: (
    artifactId: string,
    version: number,
  ) => ArtifactContentEntry | undefined;
  ensureArtifactContent: (artifactId: string, version: number) => Promise<void>;
  onExecutePlan: (message: string) => void;
  executePlanDisabled?: boolean;
}) {
  const group = findArtifactGroup(inventory, card.artifactId);
  const resolvedVersion = resolveArtifactVersion(card, inventory);
  const previewEntry =
    resolvedVersion !== null
      ? getArtifactContentEntry(card.artifactId, resolvedVersion)
      : undefined;
  const [detailVersionOverride, setDetailVersionOverride] = useState<
    number | null
  >(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailVersion = detailVersionOverride ?? resolvedVersion;
  const detailEntry =
    detailVersion !== null
      ? getArtifactContentEntry(card.artifactId, detailVersion)
      : undefined;

  useEffect(() => {
    if (resolvedVersion === null) return;
    void ensureArtifactContent(card.artifactId, resolvedVersion);
  }, [card.artifactId, ensureArtifactContent, resolvedVersion]);

  useEffect(() => {
    if (detailVersion === null || !detailOpen) return;
    void ensureArtifactContent(card.artifactId, detailVersion);
  }, [card.artifactId, detailOpen, detailVersion, ensureArtifactContent]);

  const hydratedArtifact = previewEntry?.artifact;
  const title = resolveArtifactSummary(card, previewEntry, group);
  const canOpenDetail = group != null && detailVersion !== null;
  const canCopy = typeof hydratedArtifact?.content === "string";
  const isPlanArtifact =
    (hydratedArtifact != null &&
      resolveArtifactRenderKind(hydratedArtifact) === "plan") ||
    group?.renderKind === "plan" ||
    group?.kind === "plan";
  const [copyFeedbackToken, setCopyFeedbackToken] = useState(0);
  const copied = copyFeedbackToken > 0;

  useEffect(() => {
    if (copyFeedbackToken === 0) return;
    const timeoutId = window.setTimeout(() => {
      setCopyFeedbackToken((current) =>
        current === copyFeedbackToken ? 0 : current,
      );
    }, 2200);
    return () => window.clearTimeout(timeoutId);
  }, [copyFeedbackToken]);

  const handleCopy = async () => {
    const content = hydratedArtifact?.content;
    if (typeof content !== "string") return;
    try {
      await navigator.clipboard.writeText(content);
      setCopyFeedbackToken((current) => current + 1);
    } catch {
      // Ignore clipboard failures; the button is a convenience action.
    }
  };

  return (
    <>
      <Panel variant="inset" className="conversation-card">
        <div className="conversation-card-header">
          <div className="conversation-card-heading">
            <div className="conversation-card-chip-row">
              <Badge variant="primary">Artifact</Badge>
              {group ? <Badge variant="muted">{group.kind}</Badge> : null}
            </div>
            <div className="conversation-card-title">{title}</div>
            <div className="conversation-card-meta">
              {card.artifactId} ·{" "}
              {resolveArtifactVersionLabel(hydratedArtifact, resolvedVersion)}
            </div>
          </div>
          <div className="conversation-card-actions">
            <Button
              type="button"
              variant="ghost"
              size="xxs"
              className={`conversation-card-icon-btn${copied ? " conversation-card-icon-btn--success" : ""}`}
              title={
                !canCopy
                  ? "Artifact text unavailable"
                  : copied
                    ? "Copied artifact text"
                    : "Copy artifact text"
              }
              aria-label={copied ? "Artifact text copied" : "Copy artifact text"}
              onClick={() => void handleCopy()}
              disabled={!canCopy}
            >
              <span className="material-symbols-outlined text-base">
                {copied ? "check" : "content_copy"}
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xxs"
              className="conversation-card-icon-btn"
              title={canOpenDetail ? "View artifact" : "Artifact details unavailable"}
              aria-label="View artifact"
              onClick={() => setDetailOpen(true)}
              disabled={!canOpenDetail}
            >
              <span className="material-symbols-outlined text-base">visibility</span>
            </Button>
          </div>
        </div>
        <div className="conversation-card-body">
          {resolvedVersion === null ? (
            <p className="artifact-loading-copy">
              {inventoryLoading
                ? "Resolving artifact preview…"
                : "Artifact preview unavailable."}
            </p>
          ) : previewEntry?.status === "error" ? (
            <p className="artifact-inline-error">{previewEntry.error}</p>
          ) : previewEntry?.status === "loaded" && hydratedArtifact ? (
            <ArtifactRenderer artifact={hydratedArtifact} mode="compact" />
          ) : (
            <p className="artifact-loading-copy">Loading preview…</p>
          )}
          {isPlanArtifact ? (
            <div className="mt-3 flex flex-wrap justify-end">
              <Button
                type="button"
                variant="secondary"
                size="xxs"
                onClick={() =>
                  onExecutePlan(
                    buildExecutePlanArtifactMessage(card.artifactId),
                  )
                }
                disabled={executePlanDisabled}
                title={
                  executePlanDisabled
                    ? "Wait for the current run to finish before executing this plan"
                    : "Send this plan to the agent for execution"
                }
              >
                Execute the plan
              </Button>
            </div>
          ) : null}
        </div>
      </Panel>

      {detailOpen && group && detailVersion !== null ? (
        <ArtifactDetailModal
          artifact={detailEntry?.artifact ?? null}
          group={group}
          selectedVersion={detailVersion}
          loading={detailEntry?.status === "loading" || detailEntry == null}
          error={
            detailEntry?.status === "error" ? detailEntry.error : undefined
          }
          onVersionChange={setDetailVersionOverride}
          onClose={() => {
            setDetailOpen(false);
            setDetailVersionOverride(null);
          }}
        />
      ) : null}
    </>
  );
}

export default function ConversationCards({
  cards,
  accentColor,
  artifactInventory,
  artifactInventoryLoading,
  getArtifactContentEntry,
  ensureArtifactContent,
  onExecutePlan,
  executePlanDisabled = false,
}: {
  cards: ConversationCard[];
  accentColor?: string;
  artifactInventory: SessionArtifactInventory;
  artifactInventoryLoading: boolean;
  getArtifactContentEntry: (
    artifactId: string,
    version: number,
  ) => ArtifactContentEntry | undefined;
  ensureArtifactContent: (artifactId: string, version: number) => Promise<void>;
  onExecutePlan: (message: string) => void;
  executePlanDisabled?: boolean;
}) {
  if (cards.length === 0) return null;

  const style = accentColor
    ? ({ "--conversation-card-accent": accentColor } as CSSProperties)
    : undefined;

  return (
    <div className="conversation-cards" style={style}>
      {cards.map((card) =>
        card.kind === "summary" ? (
          <Panel key={card.id} variant="inset" className="conversation-card">
            <div className="conversation-card-header">
              <div className="conversation-card-heading">
                <div className="conversation-card-chip-row">
                  <Badge variant="muted">Summary</Badge>
                </div>
                <div className="conversation-card-title">
                  {card.title || "Summary"}
                </div>
              </div>
            </div>
            <div className="conversation-card-body">
              <div className="conversation-card-markdown">
                <Markdown>{card.markdown}</Markdown>
              </div>
            </div>
          </Panel>
        ) : (
          <ArtifactConversationCard
            key={card.id}
            card={card}
            inventory={artifactInventory}
            inventoryLoading={artifactInventoryLoading}
            getArtifactContentEntry={getArtifactContentEntry}
            ensureArtifactContent={ensureArtifactContent}
            onExecutePlan={onExecutePlan}
            executePlanDisabled={executePlanDisabled}
          />
        ),
      )}
    </div>
  );
}
