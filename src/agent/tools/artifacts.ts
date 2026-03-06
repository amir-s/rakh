import { invoke } from "@tauri-apps/api/core";
import {
  getSubagentArtifactValidatorById,
} from "../subagents";
import {
  validateArtifactContentWithValidator,
} from "../subagents/contracts";
import type {
  SubagentArtifactValidationIssue,
  SubagentArtifactValidationStatus,
} from "../subagents/types";
import type { ToolErrorCode, ToolResult } from "../types";
import {
  ARTIFACT_CONTENT_FORMAT,
  type ArtifactContentFormat,
} from "./artifactTypes";

export interface ArtifactRef {
  artifactId: string;
  version?: number;
}

export interface ArtifactFrameworkMetadata {
  artifactType?: string;
  validatorId?: string;
}

export interface ArtifactValidationInfo {
  status: SubagentArtifactValidationStatus;
  validatorId: string;
  issues?: SubagentArtifactValidationIssue[];
}

export interface ArtifactManifest {
  sessionId: string;
  runId: string;
  agentId: string;
  artifactSeq: number;
  artifactId: string;
  version: number;
  kind: string;
  summary: string;
  /** Parent artifact this was derived from (e.g. previous version or source artifact). */
  parent?: ArtifactRef;
  metadata: unknown;
  contentFormat: ArtifactContentFormat;
  blobHash: string;
  sizeBytes: number;
  createdAt: number;
  content?: string;
  validation?: ArtifactValidationInfo;
}

export interface ArtifactRuntimeContext {
  runId: string;
  agentId: string;
}

export interface ArtifactCreateInput {
  kind: string;
  summary?: string;
  parent?: ArtifactRef;
  artifactType?: string;
  contentFormat: ArtifactContentFormat;
  content: string;
  metadata?: unknown;
}

export interface ArtifactVersionInput {
  artifactId: string;
  summary?: string;
  parent?: ArtifactRef;
  artifactType?: string;
  contentFormat?: ArtifactContentFormat;
  content?: string;
  metadata?: unknown;
}

export interface ArtifactGetInput {
  artifactId: string;
  version?: number;
  includeContent?: boolean;
}

export interface ArtifactListInput {
  runId?: string;
  agentId?: string;
  kind?: string;
  latestOnly?: boolean;
  limit?: number;
}

const MAX_ARTIFACT_CONTENT_BYTES = 1_000_000;

type ToolFailure = {
  ok: false;
  error: { code: ToolErrorCode; message: string };
};

function makeError(code: ToolErrorCode, message: string): ToolFailure {
  return { ok: false, error: { code, message } };
}

function parseInvokeError(err: unknown): {
  code: ToolErrorCode;
  message: string;
} {
  const message = String(err);
  if (message.startsWith("INVALID_ARGUMENT:")) {
    return { code: "INVALID_ARGUMENT", message };
  }
  if (message.startsWith("NOT_FOUND:")) {
    return { code: "NOT_FOUND", message };
  }
  if (message.startsWith("CONFLICT:")) {
    return { code: "CONFLICT", message };
  }
  if (message.startsWith("TOO_LARGE:")) {
    return { code: "TOO_LARGE", message };
  }
  if (message.startsWith("TIMEOUT:")) {
    return { code: "TIMEOUT", message };
  }
  return { code: "INTERNAL", message };
}

function validateContentFormat(format: string | undefined): ToolFailure | null {
  if (format === undefined) return null;
  if (ARTIFACT_CONTENT_FORMAT.includes(format as ArtifactContentFormat)) {
    return null;
  }
  return makeError(
    "INVALID_ARGUMENT",
    `contentFormat must be one of ${ARTIFACT_CONTENT_FORMAT.join(", ")}`,
  );
}

function validateContentSize(content: string): ToolFailure | null {
  if (new TextEncoder().encode(content).length > MAX_ARTIFACT_CONTENT_BYTES) {
    return makeError(
      "TOO_LARGE",
      `content exceeds ${MAX_ARTIFACT_CONTENT_BYTES} bytes`,
    );
  }
  return null;
}

function ensureRuntimeContext(
  runtime: ArtifactRuntimeContext | undefined,
): ArtifactRuntimeContext {
  if (runtime?.runId && runtime?.agentId) return runtime;
  // Fallback: generate a unique runId so concurrent calls don't share the
  // same (run_id, agent_id, artifact_seq) tuple and hit the unique index.
  return {
    runId: `run_${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`,
    agentId: "agent_main",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneMetadataRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

export function getArtifactFrameworkMetadata(
  metadata: unknown,
): ArtifactFrameworkMetadata | null {
  if (!isRecord(metadata) || !isRecord(metadata.__rakh)) return null;
  const artifactType =
    typeof metadata.__rakh.artifactType === "string"
      ? metadata.__rakh.artifactType
      : undefined;
  const validatorId =
    typeof metadata.__rakh.validatorId === "string"
      ? metadata.__rakh.validatorId
      : undefined;
  if (!artifactType && !validatorId) return null;
  return {
    ...(artifactType ? { artifactType } : {}),
    ...(validatorId ? { validatorId } : {}),
  };
}

export function withArtifactFrameworkMetadata(
  metadata: unknown,
  artifactType?: string,
  validatorId?: string,
): Record<string, unknown> {
  const nextMetadata = cloneMetadataRecord(metadata);
  const frameworkMetadata = {
    ...(getArtifactFrameworkMetadata(nextMetadata) ?? {}),
    ...(artifactType ? { artifactType } : {}),
    ...(validatorId ? { validatorId } : {}),
  };
  if (Object.keys(frameworkMetadata).length === 0) {
    if ("__rakh" in nextMetadata && !isRecord(nextMetadata.__rakh)) {
      delete nextMetadata.__rakh;
    }
    return nextMetadata;
  }
  nextMetadata.__rakh = frameworkMetadata;
  return nextMetadata;
}

async function getLatestArtifactForFrameworkMetadata(
  sessionId: string,
  artifactId: string,
): Promise<ArtifactManifest> {
  return invoke<ArtifactManifest>("db_artifact_get", {
    sessionId,
    artifactId,
    version: null,
    includeContent: false,
  });
}

function toArtifactCreateInvokeInput(
  input: ArtifactCreateInput,
): Omit<ArtifactCreateInput, "artifactType"> {
  return {
    kind: input.kind,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    contentFormat: input.contentFormat,
    content: input.content,
    ...(input.metadata !== undefined || input.artifactType !== undefined
      ? {
          metadata: withArtifactFrameworkMetadata(
            input.metadata,
            input.artifactType,
          ),
        }
      : {}),
  };
}

async function toArtifactVersionInvokeInput(
  sessionId: string,
  input: ArtifactVersionInput,
): Promise<Omit<ArtifactVersionInput, "artifactType">> {
  let metadata = input.metadata;

  if (input.artifactType !== undefined && metadata === undefined) {
    const latest = await getLatestArtifactForFrameworkMetadata(
      sessionId,
      input.artifactId,
    );
    metadata = latest.metadata;
  }

  return {
    artifactId: input.artifactId,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    ...(input.contentFormat !== undefined
      ? { contentFormat: input.contentFormat }
      : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(metadata !== undefined || input.artifactType !== undefined
      ? {
          metadata: withArtifactFrameworkMetadata(metadata, input.artifactType),
        }
      : {}),
  };
}

function withArtifactValidation(artifact: ArtifactManifest): ArtifactManifest {
  if (artifact.contentFormat !== "json" || typeof artifact.content !== "string") {
    return artifact;
  }

  const frameworkMetadata = getArtifactFrameworkMetadata(artifact.metadata);
  if (!frameworkMetadata?.validatorId) return artifact;

  const validatorEntry = getSubagentArtifactValidatorById(
    frameworkMetadata.validatorId,
  );
  if (!validatorEntry) return artifact;

  const validation = validateArtifactContentWithValidator(
    validatorEntry.validator,
    artifact.content,
  );
  return {
    ...artifact,
    validation,
  };
}

export async function artifactCreate(
  sessionId: string,
  runtime: ArtifactRuntimeContext | undefined,
  input: ArtifactCreateInput,
): Promise<ToolResult<{ artifact: ArtifactManifest }>> {
  if (!input.kind?.trim()) {
    return makeError("INVALID_ARGUMENT", "kind must not be empty");
  }
  const formatErr = validateContentFormat(input.contentFormat);
  if (formatErr) return formatErr;
  const sizeErr = validateContentSize(input.content);
  if (sizeErr) return sizeErr;

  try {
    const runtimeCtx = ensureRuntimeContext(runtime);
    const artifact = await invoke<ArtifactManifest>("db_artifact_create", {
      sessionId,
      runId: runtimeCtx.runId,
      agentId: runtimeCtx.agentId,
      input: toArtifactCreateInvokeInput(input),
    });
    return { ok: true, data: { artifact } };
  } catch (err) {
    const parsed = parseInvokeError(err);
    return { ok: false, error: parsed };
  }
}

export async function artifactVersion(
  sessionId: string,
  runtime: ArtifactRuntimeContext | undefined,
  input: ArtifactVersionInput,
): Promise<ToolResult<{ artifact: ArtifactManifest }>> {
  if (!input.artifactId?.trim()) {
    return makeError("INVALID_ARGUMENT", "artifactId must not be empty");
  }
  const formatErr = validateContentFormat(input.contentFormat);
  if (formatErr) return formatErr;
  if (!input.content && input.contentFormat) {
    return makeError(
      "INVALID_ARGUMENT",
      "contentFormat cannot be set when content is omitted",
    );
  }
  if (typeof input.content === "string") {
    const sizeErr = validateContentSize(input.content);
    if (sizeErr) return sizeErr;
  }

  try {
    const runtimeCtx = ensureRuntimeContext(runtime);
    const invokeInput = await toArtifactVersionInvokeInput(sessionId, input);
    const artifact = await invoke<ArtifactManifest>("db_artifact_version", {
      sessionId,
      runId: runtimeCtx.runId,
      agentId: runtimeCtx.agentId,
      input: invokeInput,
    });
    return { ok: true, data: { artifact } };
  } catch (err) {
    const parsed = parseInvokeError(err);
    return { ok: false, error: parsed };
  }
}

export async function artifactGet(
  sessionId: string,
  input: ArtifactGetInput,
): Promise<ToolResult<{ artifact: ArtifactManifest }>> {
  if (!input.artifactId?.trim()) {
    return makeError("INVALID_ARGUMENT", "artifactId must not be empty");
  }
  try {
    const artifact = await invoke<ArtifactManifest>("db_artifact_get", {
      sessionId,
      artifactId: input.artifactId,
      version: input.version ?? null,
      includeContent: input.includeContent ?? true,
    });
    return { ok: true, data: { artifact: withArtifactValidation(artifact) } };
  } catch (err) {
    const parsed = parseInvokeError(err);
    return { ok: false, error: parsed };
  }
}

export async function artifactList(
  sessionId: string,
  input: ArtifactListInput,
): Promise<ToolResult<{ artifacts: ArtifactManifest[] }>> {
  const normalizedInput: ArtifactListInput = {
    ...input,
    latestOnly: input.latestOnly ?? true,
    limit: input.limit ?? 200,
  };
  if ((normalizedInput.limit ?? 0) <= 0) {
    return makeError("INVALID_ARGUMENT", "limit must be greater than 0");
  }
  try {
    const artifacts = await invoke<ArtifactManifest[]>("db_artifact_list", {
      sessionId,
      input: normalizedInput,
    });
    return { ok: true, data: { artifacts } };
  } catch (err) {
    const parsed = parseInvokeError(err);
    return { ok: false, error: parsed };
  }
}
