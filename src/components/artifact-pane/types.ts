import type { ArtifactContentFormat } from "@/agent/tools/artifactTypes";
import type {
  ArtifactManifest,
  ArtifactValidationInfo,
} from "@/agent/tools/artifacts";

export type ArtifactTab =
  | "PLAN"
  | "TODO"
  | "REVIEW"
  | "ARTIFACTS"
  | "DEBUG";

export type KnownArtifactType =
  | "plan"
  | "review-report"
  | "security-report"
  | "copy-review"
  | "mcp-attachment";

export type ArtifactRenderKind = KnownArtifactType | ArtifactContentFormat;

export const ARTIFACT_FILTER_ALL = "__all__";
export type ArtifactFilterValue = typeof ARTIFACT_FILTER_ALL | string;

export interface ArtifactKindCount {
  kind: string;
  count: number;
}

export interface ArtifactFilterOption {
  value: ArtifactFilterValue;
  label: string;
  count: number;
}

export interface SessionArtifactGroup {
  artifactId: string;
  kind: string;
  renderKind: ArtifactRenderKind;
  latest: ArtifactManifest;
  versions: ArtifactManifest[];
}

export interface SessionArtifactInventory {
  groups: SessionArtifactGroup[];
  kindCounts: ArtifactKindCount[];
  latestPlanGroup: SessionArtifactGroup | null;
  fingerprint: string;
}

export interface ArtifactContentEntry {
  status: "idle" | "loading" | "loaded" | "error";
  artifact?: ArtifactManifest;
  error?: string;
}

export type ArtifactContentCache = Record<string, ArtifactContentEntry>;

export interface ReviewReportFinding {
  file: string;
  location: string;
  severity: "high" | "medium" | "low";
  issue: string;
  suggestion: string;
  reason: string;
}

export interface ReviewReportPayload {
  summary: string;
  findings: ReviewReportFinding[];
}

export interface SecurityReportFinding {
  file: string;
  location: string;
  severity: "critical" | "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  category: string;
  issue: string;
  impact: string;
  remediation: string;
}

export interface SecurityReportPayload {
  summary: string;
  findings: SecurityReportFinding[];
}

export interface CopyReviewSuggestion {
  file: string;
  location: string;
  original: string;
  suggested: string;
  reason: string;
}

export interface CopyReviewPayload {
  tone?: string;
  suggestions: CopyReviewSuggestion[];
  summary: string;
}

export type ParsedArtifactResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; parsed?: unknown };

export interface ArtifactDetailSelection {
  manifest: ArtifactManifest;
  validation?: ArtifactValidationInfo;
}
