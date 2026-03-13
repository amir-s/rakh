import {
  artifactCreate,
  type ArtifactManifest,
} from "../tools/artifacts";
import type {
  McpToolCallResponse,
  McpToolRegistration,
} from "../mcp";
import type { LogContext } from "@/logging/types";

import { nextTraceId, writeRunnerLog } from "./logging";
import { isRecord } from "./utils";

type McpArtifactPayloadCandidate =
  | {
      payload: Record<string, unknown>;
      originalType: string;
      mimeType?: string;
      filename?: string;
      dataEncoding?: "base64" | "utf8";
    }
  | {
      payload: Record<string, unknown>;
      originalType: "resource";
      mimeType?: string;
      filename?: string;
      dataEncoding?: "base64" | "utf8";
    };

interface McpArtifactReference {
  artifactId: string;
  version: number;
  mimeType?: string;
  originalType: string;
  filename?: string;
}

function getMcpArtifactPayloadCandidate(
  value: unknown,
): McpArtifactPayloadCandidate | null {
  if (!isRecord(value)) return null;

  const payloadType =
    typeof value.type === "string" && value.type.trim()
      ? value.type.trim()
      : "file";
  const mimeType =
    typeof value.mimeType === "string" && value.mimeType.trim()
      ? value.mimeType.trim()
      : undefined;
  const filename =
    typeof value.filename === "string" && value.filename.trim()
      ? value.filename.trim()
      : typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : undefined;

  if (
    typeof value.data === "string" &&
    (payloadType === "image" ||
      payloadType === "audio" ||
      payloadType === "file" ||
      mimeType !== undefined)
  ) {
    return {
      payload: value,
      originalType: payloadType,
      mimeType,
      filename,
      dataEncoding: "base64",
    };
  }

  if (payloadType !== "resource" || !isRecord(value.resource)) {
    return null;
  }

  const resourceMimeType =
    typeof value.resource.mimeType === "string" && value.resource.mimeType.trim()
      ? value.resource.mimeType.trim()
      : undefined;
  const resourceFilename =
    typeof value.resource.name === "string" && value.resource.name.trim()
      ? value.resource.name.trim()
      : typeof value.resource.uri === "string" && value.resource.uri.trim()
        ? value.resource.uri.trim()
        : filename;

  if (typeof value.resource.blob === "string") {
    return {
      payload: value,
      originalType: "resource",
      mimeType: resourceMimeType,
      filename: resourceFilename,
      dataEncoding: "base64",
    };
  }

  if (typeof value.resource.text === "string") {
    return {
      payload: value,
      originalType: "resource",
      mimeType: resourceMimeType,
      filename: resourceFilename,
      dataEncoding: "utf8",
    };
  }

  return null;
}

function buildMcpArtifactReferenceMessage(
  reference: McpArtifactReference,
): string {
  const payloadLabel = [
    reference.originalType,
    reference.mimeType,
    reference.filename,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");
  const prefix = payloadLabel
    ? `MCP payload stored as artifact (${payloadLabel})`
    : "MCP payload stored as artifact";
  return (
    `${prefix}: ${reference.artifactId}@${reference.version}. ` +
    "Retrieve it from the artifact repository with agent_artifact_get."
  );
}

function buildMcpArtifactReferenceRecord(
  reference: McpArtifactReference,
): Record<string, unknown> {
  return {
    artifactId: reference.artifactId,
    version: reference.version,
    originalType: reference.originalType,
    ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
    ...(reference.filename ? { filename: reference.filename } : {}),
    note: "Binary MCP payload removed from model context. Retrieve it from the artifact repository with agent_artifact_get.",
  };
}

async function createMcpPayloadArtifact(
  tabId: string,
  runId: string,
  mcpTool: McpToolRegistration,
  candidate: McpArtifactPayloadCandidate,
  logContext?: LogContext,
): Promise<McpArtifactReference | null> {
  const summaryParts = [
    mcpTool.serverName,
    mcpTool.toolTitle ?? mcpTool.toolName,
    candidate.mimeType ?? candidate.originalType,
  ];
  const summary = summaryParts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");
  const artifactInput = {
    kind: "mcp-attachment",
    summary,
    contentFormat: "json" as const,
    content: JSON.stringify(candidate.payload, null, 2),
    metadata: {
      source: {
        type: "mcp",
        serverId: mcpTool.serverId,
        serverName: mcpTool.serverName,
        toolName: mcpTool.toolName,
        ...(mcpTool.toolTitle ? { toolTitle: mcpTool.toolTitle } : {}),
      },
      attachment: {
        originalType: candidate.originalType,
        ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
        ...(candidate.filename ? { filename: candidate.filename } : {}),
        ...(candidate.dataEncoding ? { dataEncoding: candidate.dataEncoding } : {}),
      },
    },
  };
  const artifactResult = await artifactCreate(
    tabId,
    { runId, agentId: "agent_main", logContext },
    artifactInput,
  );
  if (!artifactResult.ok) {
    writeRunnerLog({
      level: "warn",
      tags: ["frontend", "tool-calls", "system"],
      event: "runner.mcp.artifactize.warn",
      message: "Failed to artifactize MCP payload",
      data: {
        serverId: mcpTool.serverId,
        toolName: mcpTool.toolName,
        error: artifactResult.error,
      },
      context:
        logContext ??
        {
          sessionId: tabId,
          tabId,
          traceId: nextTraceId("trace", runId, "main"),
          depth: 1,
          agentId: "agent_main",
        },
    });
    return null;
  }

  return {
    artifactId: artifactResult.data.artifact.artifactId,
    version: artifactResult.data.artifact.version,
    originalType: candidate.originalType,
    ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
    ...(candidate.filename ? { filename: candidate.filename } : {}),
  };
}

async function sanitizeMcpStructuredValue(
  value: unknown,
  tabId: string,
  runId: string,
  mcpTool: McpToolRegistration,
  artifactRefs: McpArtifactReference[],
  logContext?: LogContext,
): Promise<unknown> {
  const candidate = getMcpArtifactPayloadCandidate(value);
  if (candidate) {
    const artifactRef = await createMcpPayloadArtifact(
      tabId,
      runId,
      mcpTool,
      candidate,
      logContext,
    );
    if (!artifactRef) return value;
    artifactRefs.push(artifactRef);
    return buildMcpArtifactReferenceRecord(artifactRef);
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((entry) =>
        sanitizeMcpStructuredValue(
          entry,
          tabId,
          runId,
          mcpTool,
          artifactRefs,
          logContext,
        ),
      ),
    );
  }

  if (!isRecord(value)) {
    return value;
  }

  const entries = await Promise.all(
    Object.entries(value).map(async ([key, entry]) => [
      key,
      await sanitizeMcpStructuredValue(
        entry,
        tabId,
        runId,
        mcpTool,
        artifactRefs,
        logContext,
      ),
    ]),
  );
  return Object.fromEntries(entries);
}

export async function maybeArtifactizeMcpToolResult(
  tabId: string,
  runId: string,
  mcpTool: McpToolRegistration,
  result: McpToolCallResponse,
  artifactizeReturnedFiles: boolean,
  logContext?: LogContext,
): Promise<McpToolCallResponse> {
  if (!artifactizeReturnedFiles) {
    return result;
  }

  const artifactRefs: McpArtifactReference[] = [];
  const nextContent = await Promise.all(
    result.content.map(async (item) => {
      const candidate = getMcpArtifactPayloadCandidate(item);
      if (!candidate) return item;

      const artifactRef = await createMcpPayloadArtifact(
        tabId,
        runId,
        mcpTool,
        candidate,
        logContext,
      );
      if (!artifactRef) return item;
      artifactRefs.push(artifactRef);
      return {
        type: "text",
        text: buildMcpArtifactReferenceMessage(artifactRef),
      };
    }),
  );
  const nextStructuredContent =
    result.structuredContent === undefined
      ? undefined
      : await sanitizeMcpStructuredValue(
          result.structuredContent,
          tabId,
          runId,
          mcpTool,
          artifactRefs,
          logContext,
        );
  const nextMeta =
    result.meta === undefined
      ? undefined
      : await sanitizeMcpStructuredValue(
          result.meta,
          tabId,
          runId,
          mcpTool,
          artifactRefs,
          logContext,
        );

  if (artifactRefs.length === 0) {
    return result;
  }

  const metaRecord = isRecord(nextMeta) ? { ...nextMeta } : {};
  metaRecord.__rakhMcpArtifacts = artifactRefs.map((reference) =>
    buildMcpArtifactReferenceRecord(reference),
  );

  return {
    ...result,
    content: nextContent,
    ...(result.structuredContent !== undefined
      ? { structuredContent: nextStructuredContent }
      : {}),
    meta: metaRecord,
  };
}
