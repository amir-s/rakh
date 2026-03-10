import Markdown from "@/components/Markdown";
import { Badge, Panel } from "@/components/ui";
import { cn } from "@/utils/cn";
import type { ArtifactManifest } from "@/agent/tools/artifacts";
import {
  getArtifactPlainTextExcerpt,
  parseArtifactJson,
  parseCopyReviewArtifact,
  parseMcpAttachmentArtifact,
  parseReviewReportArtifact,
  parseSecurityReportArtifact,
  resolveArtifactRenderKind,
  safePrettyJson,
  summarizeSeverityCounts,
} from "./model";

type RenderMode = "compact" | "detail";

interface ArtifactRendererProps {
  artifact: ArtifactManifest;
  mode: RenderMode;
}

function validationVariant(status: string) {
  if (status === "passed") return "success";
  if (status === "failed") return "danger";
  return "muted";
}

export function ArtifactValidationBadge({
  validationStatus,
}: {
  validationStatus?: ArtifactManifest["validation"];
}) {
  if (!validationStatus) return null;
  return (
    <Badge variant={validationVariant(validationStatus.status)}>
      {validationStatus.status}
    </Badge>
  );
}

function CompactFallbackText({ content }: { content: string }) {
  return <p className="artifact-card-excerpt">{getArtifactPlainTextExcerpt(content)}</p>;
}

function ArtifactRawText({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return <pre className={cn("artifact-pre", className)}>{content}</pre>;
}

function ParseErrorState({
  error,
  content,
  mode,
}: {
  error: string;
  content?: string;
  mode: RenderMode;
}) {
  return (
    <div className="artifact-render-stack">
      <p className="artifact-inline-error">Couldn&apos;t parse artifact content: {error}</p>
      {typeof content === "string" && content.trim() ? (
        mode === "compact" ? (
          <CompactFallbackText content={content} />
        ) : (
          <ArtifactRawText content={content} />
        )
      ) : null}
    </div>
  );
}

function ArtifactSummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="artifact-summary-line">
      <span className="artifact-summary-label">{label}</span>
      <span className="artifact-summary-value">{value}</span>
    </div>
  );
}

function ReviewReportRenderer({ artifact, mode }: ArtifactRendererProps) {
  const parsed = parseReviewReportArtifact(artifact.content);
  if (!parsed.ok) {
    return <ParseErrorState error={parsed.error} content={artifact.content} mode={mode} />;
  }

  if (mode === "compact") {
    return (
      <div className="artifact-render-stack">
        <p className="artifact-card-excerpt">
          {getArtifactPlainTextExcerpt(parsed.data.summary, 180)}
        </p>
        <div className="artifact-chip-row">
          <Badge variant="primary">{parsed.data.findings.length} findings</Badge>
          {summarizeSeverityCounts(parsed.data.findings)
            .slice(0, 3)
            .map((label) => (
              <Badge key={label} variant="muted">
                {label}
              </Badge>
            ))}
        </div>
      </div>
    );
  }

  return (
    <div className="artifact-render-stack">
      <p className="artifact-detail-summary">{parsed.data.summary}</p>
      <div className="artifact-chip-row">
        <Badge variant="primary">{parsed.data.findings.length} findings</Badge>
        {summarizeSeverityCounts(parsed.data.findings).map((label) => (
          <Badge key={label} variant="muted">
            {label}
          </Badge>
        ))}
      </div>
      {parsed.data.findings.length === 0 ? (
        <p className="artifact-empty-copy">No findings.</p>
      ) : (
        <div className="artifact-detail-list">
          {parsed.data.findings.map((finding, index) => (
            <Panel
              key={`${finding.file}:${finding.location}:${index}`}
              variant="inset"
              className="artifact-detail-panel"
            >
              <div className="artifact-detail-header">
                <div>
                  <div className="artifact-detail-title">{finding.issue}</div>
                  <div className="artifact-detail-meta">
                    {finding.file} · {finding.location}
                  </div>
                </div>
                <Badge variant={finding.severity === "high" ? "danger" : "muted"}>
                  {finding.severity}
                </Badge>
              </div>
              <div className="artifact-detail-grid">
                <ArtifactSummaryLine label="Suggestion" value={finding.suggestion} />
                <ArtifactSummaryLine label="Why" value={finding.reason} />
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

function SecurityReportRenderer({ artifact, mode }: ArtifactRendererProps) {
  const parsed = parseSecurityReportArtifact(artifact.content);
  if (!parsed.ok) {
    return <ParseErrorState error={parsed.error} content={artifact.content} mode={mode} />;
  }

  if (mode === "compact") {
    return (
      <div className="artifact-render-stack">
        <p className="artifact-card-excerpt">
          {getArtifactPlainTextExcerpt(parsed.data.summary, 180)}
        </p>
        <div className="artifact-chip-row">
          <Badge variant="primary">{parsed.data.findings.length} findings</Badge>
          {summarizeSeverityCounts(parsed.data.findings)
            .slice(0, 3)
            .map((label) => (
              <Badge key={label} variant="muted">
                {label}
              </Badge>
            ))}
        </div>
      </div>
    );
  }

  return (
    <div className="artifact-render-stack">
      <p className="artifact-detail-summary">{parsed.data.summary}</p>
      <div className="artifact-chip-row">
        <Badge variant="primary">{parsed.data.findings.length} findings</Badge>
        {summarizeSeverityCounts(parsed.data.findings).map((label) => (
          <Badge key={label} variant="muted">
            {label}
          </Badge>
        ))}
      </div>
      {parsed.data.findings.length === 0 ? (
        <p className="artifact-empty-copy">No findings.</p>
      ) : (
        <div className="artifact-detail-list">
          {parsed.data.findings.map((finding, index) => (
            <Panel
              key={`${finding.file}:${finding.location}:${index}`}
              variant="inset"
              className="artifact-detail-panel"
            >
              <div className="artifact-detail-header">
                <div>
                  <div className="artifact-detail-title">{finding.issue}</div>
                  <div className="artifact-detail-meta">
                    {finding.file} · {finding.location}
                  </div>
                </div>
                <div className="artifact-chip-row">
                  <Badge
                    variant={
                      finding.severity === "critical" || finding.severity === "high"
                        ? "danger"
                        : "muted"
                    }
                  >
                    {finding.severity}
                  </Badge>
                  <Badge variant="muted">{finding.confidence} confidence</Badge>
                </div>
              </div>
              <div className="artifact-detail-grid">
                <ArtifactSummaryLine label="Category" value={finding.category} />
                <ArtifactSummaryLine label="Impact" value={finding.impact} />
                <ArtifactSummaryLine
                  label="Remediation"
                  value={finding.remediation}
                />
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyReviewRenderer({ artifact, mode }: ArtifactRendererProps) {
  const parsed = parseCopyReviewArtifact(artifact.content);
  if (!parsed.ok) {
    return <ParseErrorState error={parsed.error} content={artifact.content} mode={mode} />;
  }

  if (mode === "compact") {
    return (
      <div className="artifact-render-stack">
        <p className="artifact-card-excerpt">
          {getArtifactPlainTextExcerpt(parsed.data.summary, 180)}
        </p>
        <div className="artifact-chip-row">
          <Badge variant="primary">
            {parsed.data.suggestions.length} suggestions
          </Badge>
          {parsed.data.tone ? <Badge variant="muted">{parsed.data.tone}</Badge> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="artifact-render-stack">
      <p className="artifact-detail-summary">{parsed.data.summary}</p>
      <div className="artifact-chip-row">
        <Badge variant="primary">
          {parsed.data.suggestions.length} suggestions
        </Badge>
        {parsed.data.tone ? <Badge variant="muted">{parsed.data.tone}</Badge> : null}
      </div>
      {parsed.data.suggestions.length === 0 ? (
        <p className="artifact-empty-copy">No copy suggestions.</p>
      ) : (
        <div className="artifact-detail-list">
          {parsed.data.suggestions.map((suggestion, index) => (
            <Panel
              key={`${suggestion.file}:${suggestion.location}:${index}`}
              variant="inset"
              className="artifact-detail-panel"
            >
              <div className="artifact-detail-header">
                <div>
                  <div className="artifact-detail-title">{suggestion.location}</div>
                  <div className="artifact-detail-meta">{suggestion.file}</div>
                </div>
              </div>
              <div className="artifact-copy-comparison">
                <div>
                  <div className="artifact-summary-label">Original</div>
                  <div className="artifact-copy-text">{suggestion.original}</div>
                </div>
                <div>
                  <div className="artifact-summary-label">Suggested</div>
                  <div className="artifact-copy-text artifact-copy-text--suggested">
                    {suggestion.suggested}
                  </div>
                </div>
              </div>
              <ArtifactSummaryLine label="Reason" value={suggestion.reason} />
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanRenderer({ artifact, mode }: ArtifactRendererProps) {
  const content = artifact.content ?? "";
  if (mode === "compact") {
    return <CompactFallbackText content={content} />;
  }
  return (
    <div className="artifact-markdown">
      <Markdown>{content}</Markdown>
    </div>
  );
}

function McpAttachmentRenderer({ artifact, mode }: ArtifactRendererProps) {
  const parsed = parseMcpAttachmentArtifact(artifact.content);
  if (!parsed.ok) {
    return <ParseErrorState error={parsed.error} content={artifact.content} mode={mode} />;
  }

  const { previewUrl, mimeType, filename, prettyJson } = parsed.data;

  if (!previewUrl) {
    if (mode === "compact") {
      return <CompactFallbackText content={prettyJson} />;
    }
    return <ArtifactRawText content={prettyJson} />;
  }

  return (
    <div className="artifact-render-stack">
      <div
        className={cn(
          "artifact-media-frame",
          mode === "compact" && "artifact-media-frame--compact",
        )}
      >
        <img
          src={previewUrl}
          alt={artifact.summary || artifact.artifactId}
          className={cn(
            "artifact-media-preview",
            mode === "compact" && "artifact-media-preview--compact",
          )}
        />
      </div>
      <div className="artifact-chip-row">
        {mimeType ? <Badge variant="muted">{mimeType}</Badge> : null}
        {filename ? <Badge variant="muted">{filename}</Badge> : null}
      </div>
      {mode === "detail" ? <ArtifactRawText content={prettyJson} /> : null}
    </div>
  );
}

function JsonRenderer({ artifact, mode }: ArtifactRendererProps) {
  const parsed = parseArtifactJson(artifact.content);
  if (!parsed.ok) {
    return <ParseErrorState error={parsed.error} content={artifact.content} mode={mode} />;
  }
  const pretty = safePrettyJson(parsed.data);
  if (mode === "compact") {
    return <CompactFallbackText content={pretty} />;
  }
  return <ArtifactRawText content={pretty} />;
}

function MarkdownRenderer({ artifact, mode }: ArtifactRendererProps) {
  const content = artifact.content ?? "";
  if (mode === "compact") {
    return <CompactFallbackText content={content} />;
  }
  return (
    <div className="artifact-markdown">
      <Markdown>{content}</Markdown>
    </div>
  );
}

function TextRenderer({ artifact, mode }: ArtifactRendererProps) {
  const content = artifact.content ?? "";
  if (mode === "compact") {
    return <CompactFallbackText content={content} />;
  }
  return <ArtifactRawText content={content} />;
}

function UnifiedDiffRenderer({ artifact, mode }: ArtifactRendererProps) {
  const content = artifact.content ?? "";
  if (mode === "compact") {
    return <CompactFallbackText content={content} />;
  }
  return <ArtifactRawText content={content} className="artifact-pre--diff" />;
}

export function ArtifactRenderer({ artifact, mode }: ArtifactRendererProps) {
  switch (resolveArtifactRenderKind(artifact)) {
    case "plan":
      return <PlanRenderer artifact={artifact} mode={mode} />;
    case "review-report":
      return <ReviewReportRenderer artifact={artifact} mode={mode} />;
    case "security-report":
      return <SecurityReportRenderer artifact={artifact} mode={mode} />;
    case "copy-review":
      return <CopyReviewRenderer artifact={artifact} mode={mode} />;
    case "mcp-attachment":
      return <McpAttachmentRenderer artifact={artifact} mode={mode} />;
    case "markdown":
      return <MarkdownRenderer artifact={artifact} mode={mode} />;
    case "json":
      return <JsonRenderer artifact={artifact} mode={mode} />;
    case "unified-diff":
      return <UnifiedDiffRenderer artifact={artifact} mode={mode} />;
    case "text":
    default:
      return <TextRenderer artifact={artifact} mode={mode} />;
  }
}
