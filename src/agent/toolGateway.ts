import type { ToolResult } from "./types";

export type ToolGatewaySourceKind = "local" | "mcp" | "synthetic";
export type ToolGatewayExecutionOrigin = "agent" | "gateway";
export type ToolGatewayOriginalFormat = "text" | "json";

export interface ToolGatewayStateSnapshot {
  tabId: string;
  runId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  modelId: string;
  sourceKind: ToolGatewaySourceKind;
  executionOrigin: ToolGatewayExecutionOrigin;
  intention?: string;
  contextLength?: number;
  contextUsagePct?: number;
  estimatedTokens?: number;
  estimatedBytes?: number;
}

export interface HugeOutputThresholdBand {
  minContextUsagePct: number;
  maxBytes: number;
}

export interface HugeOutputPolicyConfig {
  /** Master toggle for replacing oversized tool results with artifact refs. */
  enabled: boolean;
  /** Default byte limit when no context-pressure band matches. */
  defaultThresholdBytes: number;
  /** Lower byte limits applied once estimated context usage crosses each band. */
  thresholdBands: HugeOutputThresholdBand[];
}

export interface SummaryPolicyConfig {
  /** Master toggle for generating short summaries for artifactized tool output. */
  enabled: boolean;
  /** Reuse the run model or force a dedicated internal summary model. */
  modelStrategy: "parent" | "override";
  /** Explicit model id used when `modelStrategy` is `"override"`. */
  overrideModelId?: string;
  /** Hard cap for the final plain-text summary returned to the agent. */
  maxSummaryChars: number;
  /** Maximum tool-using reasoning steps the internal summarizer may take. */
  maxSteps: number;
  /** Per-read byte cap for `agent_tool_artifact_get` during summarization. */
  toolArtifactGetMaxBytes: number;
  /** Maximum number of matches returned by `agent_tool_artifact_search`. */
  toolArtifactSearchMaxMatches: number;
  /** Context lines included around each search match during summarization. */
  toolArtifactSearchContextLines: number;
}

export interface ToolGatewayConfig {
  hugeOutput: HugeOutputPolicyConfig;
  summary: SummaryPolicyConfig;
}

export interface ToolGatewayConfigProvider {
  getConfig(input: {
    toolName: string;
    sourceKind: ToolGatewaySourceKind;
    stateSnapshot: ToolGatewayStateSnapshot;
  }): ToolGatewayConfig;
}

export interface ToolGatewayArtifactRef {
  kind: "artifact-ref";
  artifactId: string;
  originalTool: string;
  sizeBytes: number;
  lineCount?: number;
  originalFormat: ToolGatewayOriginalFormat;
  appliedPolicies: string[];
  note: string;
  summary?: string;
}

export interface ToolGatewayArtifactRefEnvelope {
  __rakhToolGateway: ToolGatewayArtifactRef;
}

export const TOOL_GATEWAY_INTENTION_DESCRIPTION =
  "Optional short intention for output handling. Explain what part of the result matters so the gateway can summarize or compress it when needed.";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stripToolGatewayInputFields(args: Record<string, unknown>): {
  strippedArgs: Record<string, unknown>;
  intention?: string;
} {
  const strippedArgs = { ...args };
  const rawIntention =
    typeof strippedArgs.intention === "string"
      ? strippedArgs.intention.trim()
      : undefined;
  delete strippedArgs.intention;
  return {
    strippedArgs,
    ...(rawIntention ? { intention: rawIntention } : {}),
  };
}

export function selectHugeOutputThreshold(
  config: HugeOutputPolicyConfig,
  contextUsagePct?: number,
): number {
  const usagePct =
    typeof contextUsagePct === "number" && Number.isFinite(contextUsagePct)
      ? contextUsagePct
      : 0;
  const sortedBands = [...config.thresholdBands].sort(
    (left, right) => right.minContextUsagePct - left.minContextUsagePct,
  );
  for (const band of sortedBands) {
    if (usagePct >= band.minContextUsagePct) {
      return band.maxBytes;
    }
  }
  return config.defaultThresholdBytes;
}

export function isToolGatewayArtifactRefEnvelope(
  value: unknown,
): value is ToolGatewayArtifactRefEnvelope {
  return (
    isRecord(value) &&
    isRecord(value.__rakhToolGateway) &&
    value.__rakhToolGateway.kind === "artifact-ref" &&
    typeof value.__rakhToolGateway.artifactId === "string"
  );
}

export function getToolGatewayArtifactRef(
  value: unknown,
): ToolGatewayArtifactRef | null {
  return isToolGatewayArtifactRefEnvelope(value) ? value.__rakhToolGateway : null;
}

export function getToolGatewayArtifactRefFromToolResult(
  result: unknown,
): ToolGatewayArtifactRef | null {
  if (
    isRecord(result) &&
    result.ok === true &&
    isRecord(result.data) &&
    isToolGatewayArtifactRefEnvelope(result.data)
  ) {
    return result.data.__rakhToolGateway;
  }
  return null;
}

export function buildToolGatewayArtifactResult(
  data: ToolGatewayArtifactRef,
): ToolResult<ToolGatewayArtifactRefEnvelope> {
  return {
    ok: true,
    data: {
      __rakhToolGateway: data,
    },
  };
}
