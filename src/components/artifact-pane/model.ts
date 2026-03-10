import type { ArtifactManifest } from "@/agent/tools/artifacts";
import { getArtifactFrameworkMetadata } from "@/agent/tools/artifacts";
import type {
  ArtifactFilterOption,
  ArtifactFilterValue,
  ArtifactKindCount,
  ArtifactRenderKind,
  CopyReviewPayload,
  ParsedArtifactResult,
  ReviewReportPayload,
  SecurityReportPayload,
  SessionArtifactGroup,
  SessionArtifactInventory,
} from "./types";
import { ARTIFACT_FILTER_ALL } from "./types";

const KNOWN_RENDER_KINDS = new Set<ArtifactRenderKind>([
  "plan",
  "review-report",
  "security-report",
  "copy-review",
  "mcp-attachment",
  "text",
  "markdown",
  "unified-diff",
  "json",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function byLatestVersionDesc(a: ArtifactManifest, b: ArtifactManifest) {
  return b.version - a.version || b.createdAt - a.createdAt;
}

export function sortArtifactVersions(
  manifests: ArtifactManifest[],
): ArtifactManifest[] {
  return [...manifests].sort(byLatestVersionDesc);
}

export function getArtifactRendererSource(manifest: ArtifactManifest): string {
  const framework = getArtifactFrameworkMetadata(manifest.metadata);
  return framework?.artifactType ?? manifest.kind;
}

export function resolveArtifactRenderKind(
  manifest: ArtifactManifest,
): ArtifactRenderKind {
  const source = getArtifactRendererSource(manifest);
  if (KNOWN_RENDER_KINDS.has(source as ArtifactRenderKind)) {
    return source as ArtifactRenderKind;
  }
  return manifest.contentFormat;
}

export function buildArtifactInventoryFingerprint(
  groups: SessionArtifactGroup[],
): string {
  return groups
    .map(
      (group) =>
        `${group.artifactId}:${group.latest.version}:${group.latest.createdAt}:${group.kind}`,
    )
    .join("|");
}

export function buildSessionArtifactInventory(
  manifests: ArtifactManifest[],
): SessionArtifactInventory {
  const grouped = new Map<string, ArtifactManifest[]>();

  for (const manifest of manifests) {
    const bucket = grouped.get(manifest.artifactId);
    if (bucket) {
      bucket.push(manifest);
    } else {
      grouped.set(manifest.artifactId, [manifest]);
    }
  }

  const groups: SessionArtifactGroup[] = Array.from(grouped.entries())
    .map(([artifactId, versions]) => {
      const sortedVersions = sortArtifactVersions(versions);
      const latest = sortedVersions[0];
      return {
        artifactId,
        kind: latest.kind,
        renderKind: resolveArtifactRenderKind(latest),
        latest,
        versions: sortedVersions,
      };
    })
    .sort((a, b) => b.latest.createdAt - a.latest.createdAt);

  const kindCounts = Array.from(
    groups.reduce<Map<string, number>>((acc, group) => {
      acc.set(group.kind, (acc.get(group.kind) ?? 0) + 1);
      return acc;
    }, new Map<string, number>()),
  )
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind));

  return {
    groups,
    kindCounts,
    latestPlanGroup:
      groups.find((group) => group.renderKind === "plan" || group.kind === "plan") ??
      null,
    fingerprint: buildArtifactInventoryFingerprint(groups),
  };
}

export function filterArtifactGroups(
  groups: SessionArtifactGroup[],
  filterValue: ArtifactFilterValue,
): SessionArtifactGroup[] {
  if (filterValue === ARTIFACT_FILTER_ALL) return groups;
  return groups.filter((group) => group.kind === filterValue);
}

export function buildArtifactFilterOptions(
  kindCounts: ArtifactKindCount[],
): ArtifactFilterOption[] {
  const total = kindCounts.reduce((sum, entry) => sum + entry.count, 0);
  return [
    { value: ARTIFACT_FILTER_ALL, label: "All", count: total },
    ...kindCounts.map((entry) => ({
      value: entry.kind,
      label: entry.kind,
      count: entry.count,
    })),
  ];
}

export function buildTodoSnapshot(
  todos: Array<{ id: string; status: string; text: string }>,
): string {
  return JSON.stringify(
    todos.map((todo) => ({
      id: todo.id,
      status: todo.status,
      text: todo.text,
    })),
  );
}

export function getArtifactContentKey(
  artifactId: string,
  version: number,
): string {
  return `${artifactId}@${version}`;
}

export function getArtifactPlainTextExcerpt(
  content: string,
  maxLength = 220,
): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function formatArtifactVersionLabel(manifest: ArtifactManifest): string {
  const createdAt = new Date(manifest.createdAt);
  const includeYear = createdAt.getFullYear() !== new Date().getFullYear();
  const formatter = new Intl.DateTimeFormat(undefined, {
    ...(includeYear ? { year: "numeric" as const } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return `v${manifest.version} · ${formatter.format(createdAt)}`;
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function parseJsonContent(content: string): ParsedArtifactResult<unknown> {
  try {
    return { ok: true, data: JSON.parse(content) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Artifact content is not valid JSON",
    };
  }
}

export function parseArtifactJson(
  content: string | undefined,
): ParsedArtifactResult<unknown> {
  if (typeof content !== "string") {
    return { ok: false, error: "Artifact content is missing" };
  }
  return parseJsonContent(content);
}

export function parseReviewReportArtifact(
  content: string | undefined,
): ParsedArtifactResult<ReviewReportPayload> {
  const parsed = parseArtifactJson(content);
  if (!parsed.ok) return parsed;

  try {
    if (!isRecord(parsed.data)) {
      throw new Error("Artifact payload must be an object");
    }
    const findings = parsed.data.findings;
    if (!Array.isArray(findings)) {
      throw new Error("findings must be an array");
    }
    return {
      ok: true,
      data: {
        summary: readString(parsed.data.summary, "summary"),
        findings: findings.map((finding, index) => {
          if (!isRecord(finding)) {
            throw new Error(`findings[${index}] must be an object`);
          }
          const severity = readString(finding.severity, `findings[${index}].severity`);
          if (!["high", "medium", "low"].includes(severity)) {
            throw new Error(`findings[${index}].severity is invalid`);
          }
          return {
            file: readString(finding.file, `findings[${index}].file`),
            location: readString(finding.location, `findings[${index}].location`),
            severity: severity as ReviewReportPayload["findings"][number]["severity"],
            issue: readString(finding.issue, `findings[${index}].issue`),
            suggestion: readString(
              finding.suggestion,
              `findings[${index}].suggestion`,
            ),
            reason: readString(finding.reason, `findings[${index}].reason`),
          };
        }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid review report",
      parsed: parsed.data,
    };
  }
}

export function parseSecurityReportArtifact(
  content: string | undefined,
): ParsedArtifactResult<SecurityReportPayload> {
  const parsed = parseArtifactJson(content);
  if (!parsed.ok) return parsed;

  try {
    if (!isRecord(parsed.data)) {
      throw new Error("Artifact payload must be an object");
    }
    const findings = parsed.data.findings;
    if (!Array.isArray(findings)) {
      throw new Error("findings must be an array");
    }
    return {
      ok: true,
      data: {
        summary: readString(parsed.data.summary, "summary"),
        findings: findings.map((finding, index) => {
          if (!isRecord(finding)) {
            throw new Error(`findings[${index}] must be an object`);
          }
          const severity = readString(finding.severity, `findings[${index}].severity`);
          if (!["critical", "high", "medium", "low"].includes(severity)) {
            throw new Error(`findings[${index}].severity is invalid`);
          }
          const confidence = readString(
            finding.confidence,
            `findings[${index}].confidence`,
          );
          if (!["high", "medium", "low"].includes(confidence)) {
            throw new Error(`findings[${index}].confidence is invalid`);
          }
          return {
            file: readString(finding.file, `findings[${index}].file`),
            location: readString(finding.location, `findings[${index}].location`),
            severity:
              severity as SecurityReportPayload["findings"][number]["severity"],
            confidence:
              confidence as SecurityReportPayload["findings"][number]["confidence"],
            category: readString(finding.category, `findings[${index}].category`),
            issue: readString(finding.issue, `findings[${index}].issue`),
            impact: readString(finding.impact, `findings[${index}].impact`),
            remediation: readString(
              finding.remediation,
              `findings[${index}].remediation`,
            ),
          };
        }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid security report",
      parsed: parsed.data,
    };
  }
}

export function parseCopyReviewArtifact(
  content: string | undefined,
): ParsedArtifactResult<CopyReviewPayload> {
  const parsed = parseArtifactJson(content);
  if (!parsed.ok) return parsed;

  try {
    if (!isRecord(parsed.data)) {
      throw new Error("Artifact payload must be an object");
    }
    const suggestions = parsed.data.suggestions;
    if (!Array.isArray(suggestions)) {
      throw new Error("suggestions must be an array");
    }
    return {
      ok: true,
      data: {
        ...(typeof parsed.data.tone === "string" ? { tone: parsed.data.tone } : {}),
        summary: readString(parsed.data.summary, "summary"),
        suggestions: suggestions.map((suggestion, index) => {
          if (!isRecord(suggestion)) {
            throw new Error(`suggestions[${index}] must be an object`);
          }
          return {
            file: readString(suggestion.file, `suggestions[${index}].file`),
            location: readString(
              suggestion.location,
              `suggestions[${index}].location`,
            ),
            original: readString(
              suggestion.original,
              `suggestions[${index}].original`,
            ),
            suggested: readString(
              suggestion.suggested,
              `suggestions[${index}].suggested`,
            ),
            reason: readString(suggestion.reason, `suggestions[${index}].reason`),
          };
        }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid copy review",
      parsed: parsed.data,
    };
  }
}

export interface McpAttachmentPreviewPayload {
  mimeType?: string;
  filename?: string;
  previewUrl: string | null;
  prettyJson: string;
}

function isImageMimeType(value: unknown): value is string {
  return typeof value === "string" && value.toLowerCase().startsWith("image/");
}

function buildImageDataUrl(
  mimeType: string | undefined,
  encoding: "base64" | "text",
  payload: string,
): string | null {
  if (!isImageMimeType(mimeType) || !payload.trim()) return null;
  if (encoding === "base64") {
    return `data:${mimeType};base64,${payload}`;
  }
  return `data:${mimeType};charset=utf-8,${encodeURIComponent(payload)}`;
}

export function parseMcpAttachmentArtifact(
  content: string | undefined,
): ParsedArtifactResult<McpAttachmentPreviewPayload> {
  const parsed = parseArtifactJson(content);
  if (!parsed.ok) return parsed;

  const prettyJson = safePrettyJson(parsed.data);
  if (!isRecord(parsed.data)) {
    return {
      ok: true,
      data: {
        prettyJson,
        previewUrl: null,
      },
    };
  }

  const filename =
    typeof parsed.data.filename === "string" && parsed.data.filename.trim()
      ? parsed.data.filename.trim()
      : typeof parsed.data.name === "string" && parsed.data.name.trim()
        ? parsed.data.name.trim()
        : undefined;

  if (typeof parsed.data.data === "string") {
    return {
      ok: true,
      data: {
        mimeType:
          typeof parsed.data.mimeType === "string" ? parsed.data.mimeType : undefined,
        filename,
        previewUrl: buildImageDataUrl(
          typeof parsed.data.mimeType === "string" ? parsed.data.mimeType : undefined,
          "base64",
          parsed.data.data,
        ),
        prettyJson,
      },
    };
  }

  if (!isRecord(parsed.data.resource)) {
    return {
      ok: true,
      data: {
        previewUrl: null,
        prettyJson,
        filename,
      },
    };
  }

  const resourceMimeType =
    typeof parsed.data.resource.mimeType === "string"
      ? parsed.data.resource.mimeType
      : undefined;
  const resourceFilename =
    typeof parsed.data.resource.name === "string" && parsed.data.resource.name.trim()
      ? parsed.data.resource.name.trim()
      : typeof parsed.data.resource.uri === "string" && parsed.data.resource.uri.trim()
        ? parsed.data.resource.uri.trim()
        : filename;

  if (typeof parsed.data.resource.blob === "string") {
    return {
      ok: true,
      data: {
        mimeType: resourceMimeType,
        filename: resourceFilename,
        previewUrl: buildImageDataUrl(
          resourceMimeType,
          "base64",
          parsed.data.resource.blob,
        ),
        prettyJson,
      },
    };
  }

  if (typeof parsed.data.resource.text === "string") {
    return {
      ok: true,
      data: {
        mimeType: resourceMimeType,
        filename: resourceFilename,
        previewUrl: buildImageDataUrl(
          resourceMimeType,
          "text",
          parsed.data.resource.text,
        ),
        prettyJson,
      },
    };
  }

  return {
    ok: true,
    data: {
      mimeType: resourceMimeType,
      filename: resourceFilename,
      previewUrl: null,
      prettyJson,
    },
  };
}

export function summarizeSeverityCounts<
  T extends { severity: string },
>(findings: T[]): string[] {
  const counts = findings.reduce<Map<string, number>>((acc, finding) => {
    acc.set(finding.severity, (acc.get(finding.severity) ?? 0) + 1);
    return acc;
  }, new Map<string, number>());

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([severity, count]) => `${severity} ${count}`);
}

export function safePrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function isStringList(value: unknown): value is string[] {
  return isStringArray(value);
}
