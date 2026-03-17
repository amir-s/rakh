import type { LanguageModelUsage } from "ai";

import { patchAgentState } from "./atoms";
import { estimateContextUsage } from "./contextUsage";
import {
  getModelCatalogEntry,
  type ModelCatalogEntry,
} from "./modelCatalog";
import type {
  ApiMessage,
  LlmUsageActorKind,
  LlmUsageRecord,
} from "./types";

export interface RecordLlmUsageInput {
  modelId: string;
  actorKind: LlmUsageActorKind;
  actorId: string;
  actorLabel: string;
  operation: string;
  usage: LanguageModelUsage;
  timestamp?: number;
}

export interface CurrentContextStats {
  estimatedTokens: number;
  currentKb: number;
  maxKb: number | null;
  pct: number | null;
}

export type SessionCostStatus = "complete" | "partial" | "missing";

export interface SessionUsageBreakdown {
  actorKind: LlmUsageActorKind;
  actorId: string;
  actorLabel: string;
  operationLabels: string[];
  modelIds: string[];
  usage: UsageTotals;
  costStatus: SessionCostStatus;
  knownCostUsd: number;
}

export interface SessionUsageSummary {
  usage: UsageTotals;
  costStatus: SessionCostStatus;
  knownCostUsd: number;
  missingPricingModels: Array<{ modelId: string; label: string }>;
  breakdown: SessionUsageBreakdown[];
}

export interface SessionCostSeriesPoint {
  id: string;
  index: number;
  timestamp: number;
  modelId: string;
  actorKind: LlmUsageActorKind;
  actorId: string;
  actorLabel: string;
  operation: string;
  totalTokens: number;
  costStatus: SessionCostStatus;
  callCostUsd: number | null;
  cumulativeKnownCostUsd: number;
}

export interface UsageTotals {
  inputTokens: number;
  noCacheInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function createUsageRecordId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `usage-${uuid}`;
  return `usage-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function normalizeUsageTotals(usage: LanguageModelUsage): UsageTotals {
  const inputTokens = finiteOrZero(usage.inputTokens);
  const cacheReadTokens =
    finiteOrZero(usage.inputTokenDetails?.cacheReadTokens) ||
    finiteOrZero(usage.cachedInputTokens);
  const cacheWriteTokens = finiteOrZero(usage.inputTokenDetails?.cacheWriteTokens);
  const noCacheInputTokens =
    finiteOrZero(usage.inputTokenDetails?.noCacheTokens) ||
    Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = finiteOrZero(usage.outputTokens);
  const reasoningTokens =
    finiteOrZero(usage.outputTokenDetails?.reasoningTokens) ||
    finiteOrZero(usage.reasoningTokens);
  const totalTokens = finiteOrZero(usage.totalTokens) || inputTokens + outputTokens;

  return {
    inputTokens,
    noCacheInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
}

export function recordLlmUsage(tabId: string, input: RecordLlmUsageInput): void {
  const usage = normalizeUsageTotals(input.usage);
  if (usage.totalTokens <= 0 && usage.inputTokens <= 0 && usage.outputTokens <= 0) {
    return;
  }

  const record: LlmUsageRecord = {
    id: createUsageRecordId(),
    timestamp: input.timestamp ?? Date.now(),
    modelId: input.modelId,
    actorKind: input.actorKind,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    operation: input.operation,
    ...usage,
  };

  patchAgentState(tabId, (prev) => ({
    ...prev,
    llmUsageLedger: [...prev.llmUsageLedger, record],
  }));
}

export function estimateCurrentContextStats(
  apiMessages: ApiMessage[],
  contextLength?: number,
): CurrentContextStats | null {
  const usage = estimateContextUsage(apiMessages);
  if (!usage) return null;

  return {
    estimatedTokens: usage.estimatedTokens,
    currentKb: usage.estimatedBytes / 1024,
    maxKb: contextLength ? (contextLength * 4) / 1024 : null,
    pct:
      contextLength && contextLength > 0
        ? Math.min(100, (usage.estimatedTokens / contextLength) * 100)
        : null,
  };
}

function addUsageTotals(target: UsageTotals, source: UsageTotals): UsageTotals {
  return {
    inputTokens: target.inputTokens + source.inputTokens,
    noCacheInputTokens: target.noCacheInputTokens + source.noCacheInputTokens,
    cacheReadTokens: target.cacheReadTokens + source.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + source.cacheWriteTokens,
    outputTokens: target.outputTokens + source.outputTokens,
    reasoningTokens: target.reasoningTokens + source.reasoningTokens,
    totalTokens: target.totalTokens + source.totalTokens,
  };
}

function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    noCacheInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function resolveModelLabel(
  modelId: string,
  modelEntry: ModelCatalogEntry | null,
): string {
  return modelEntry?.name || modelId;
}

function calculateRecordCost(
  record: LlmUsageRecord,
  modelEntry: ModelCatalogEntry | null,
): { status: SessionCostStatus; knownCostUsd: number; label: string } {
  const label = resolveModelLabel(record.modelId, modelEntry);
  const pricing = modelEntry?.pricing;

  const promptRate = pricing?.prompt;
  const completionRate = pricing?.completion;
  const cacheReadRate = pricing?.cacheRead ?? promptRate;
  const cacheWriteRate = pricing?.cacheWrite ?? promptRate;

  const needsPromptRate =
    record.noCacheInputTokens > 0 ||
    (record.cacheReadTokens > 0 && cacheReadRate === undefined) ||
    (record.cacheWriteTokens > 0 && cacheWriteRate === undefined);
  const needsCompletionRate = record.outputTokens > 0;

  if (
    (needsPromptRate && promptRate === undefined) ||
    (needsCompletionRate && completionRate === undefined)
  ) {
    return { status: "missing", knownCostUsd: 0, label };
  }

  const promptCost =
    ((record.noCacheInputTokens * (promptRate ?? 0)) +
      (record.cacheReadTokens * (cacheReadRate ?? 0)) +
      (record.cacheWriteTokens * (cacheWriteRate ?? 0))) /
    1_000_000;
  const completionCost = (record.outputTokens * (completionRate ?? 0)) / 1_000_000;

  return {
    status: "complete",
    knownCostUsd: promptCost + completionCost,
    label,
  };
}

function compareBreakdownRows(
  left: SessionUsageBreakdown,
  right: SessionUsageBreakdown,
): number {
  const order: Record<LlmUsageActorKind, number> = {
    main: 0,
    subagent: 1,
    internal: 2,
  };
  return (
    order[left.actorKind] - order[right.actorKind] ||
    left.actorLabel.localeCompare(right.actorLabel)
  );
}

export function summarizeSessionUsage(
  ledger: LlmUsageRecord[],
  resolveModel: (modelId: string) => ModelCatalogEntry | null = getModelCatalogEntry,
): SessionUsageSummary | null {
  if (ledger.length === 0) return null;

  const totalUsage = emptyUsageTotals();
  const missingPricingModels = new Map<string, string>();
  const grouped = new Map<
    string,
    SessionUsageBreakdown & { operationLabelSet: Set<string>; modelIdSet: Set<string> }
  >();

  let knownCostUsd = 0;
  let pricedRecordCount = 0;

  for (const record of ledger) {
    const usage = addUsageTotals(emptyUsageTotals(), record);
    const modelEntry = resolveModel(record.modelId);
    const cost = calculateRecordCost(record, modelEntry);
    totalUsage.inputTokens += usage.inputTokens;
    totalUsage.noCacheInputTokens += usage.noCacheInputTokens;
    totalUsage.cacheReadTokens += usage.cacheReadTokens;
    totalUsage.cacheWriteTokens += usage.cacheWriteTokens;
    totalUsage.outputTokens += usage.outputTokens;
    totalUsage.reasoningTokens += usage.reasoningTokens;
    totalUsage.totalTokens += usage.totalTokens;

    if (cost.status === "complete") {
      knownCostUsd += cost.knownCostUsd;
      pricedRecordCount += 1;
    } else {
      missingPricingModels.set(record.modelId, cost.label);
    }

    const key = `${record.actorKind}:${record.actorId}`;
    const group = grouped.get(key) ?? {
      actorKind: record.actorKind,
      actorId: record.actorId,
      actorLabel: record.actorLabel,
      operationLabels: [],
      modelIds: [],
      usage: emptyUsageTotals(),
      costStatus: "missing" as SessionCostStatus,
      knownCostUsd: 0,
      operationLabelSet: new Set<string>(),
      modelIdSet: new Set<string>(),
    };

    group.usage = addUsageTotals(group.usage, usage);
    group.knownCostUsd += cost.knownCostUsd;
    if (cost.status === "complete") {
      group.costStatus =
        group.costStatus === "missing" ? "complete" : group.costStatus;
    } else if (group.knownCostUsd > 0) {
      group.costStatus = "partial";
    }
    if (!group.operationLabelSet.has(record.operation)) {
      group.operationLabelSet.add(record.operation);
      group.operationLabels.push(record.operation);
    }
    if (!group.modelIdSet.has(record.modelId)) {
      group.modelIdSet.add(record.modelId);
      group.modelIds.push(record.modelId);
    }
    grouped.set(key, group);
  }

  const breakdown = Array.from(grouped.values())
    .map((group) => {
      let costStatus = group.costStatus;
      if (costStatus === "complete" && missingPricingModels.size > 0) {
        const hasMissingModel = group.modelIds.some((modelId) =>
          missingPricingModels.has(modelId),
        );
        if (hasMissingModel && group.knownCostUsd > 0) {
          costStatus = "partial";
        } else if (hasMissingModel) {
          costStatus = "missing";
        }
      }

      return {
        actorKind: group.actorKind,
        actorId: group.actorId,
        actorLabel: group.actorLabel,
        operationLabels: group.operationLabels,
        modelIds: group.modelIds,
        usage: group.usage,
        costStatus,
        knownCostUsd: group.knownCostUsd,
      };
    })
    .sort(compareBreakdownRows);

  const costStatus =
    pricedRecordCount === 0
      ? "missing"
      : pricedRecordCount === ledger.length
        ? "complete"
        : "partial";

  return {
    usage: totalUsage,
    costStatus,
    knownCostUsd,
    missingPricingModels: Array.from(missingPricingModels, ([modelId, label]) => ({
      modelId,
      label,
    })).sort((left, right) => left.label.localeCompare(right.label)),
    breakdown,
  };
}

export function buildSessionCostSeries(
  ledger: LlmUsageRecord[],
  resolveModel: (modelId: string) => ModelCatalogEntry | null = getModelCatalogEntry,
): SessionCostSeriesPoint[] {
  if (ledger.length === 0) return [];

  const ordered = ledger
    .map((record, originalIndex) => ({ record, originalIndex }))
    .sort(
      (left, right) =>
        left.record.timestamp - right.record.timestamp ||
        left.originalIndex - right.originalIndex,
    );

  let cumulativeKnownCostUsd = 0;

  return ordered.map(({ record }, index) => {
    const cost = calculateRecordCost(record, resolveModel(record.modelId));
    if (cost.status === "complete") {
      cumulativeKnownCostUsd += cost.knownCostUsd;
    }

    return {
      id: record.id,
      index,
      timestamp: record.timestamp,
      modelId: record.modelId,
      actorKind: record.actorKind,
      actorId: record.actorId,
      actorLabel: record.actorLabel,
      operation: record.operation,
      totalTokens: record.totalTokens,
      costStatus: cost.status,
      callCostUsd: cost.status === "complete" ? cost.knownCostUsd : null,
      cumulativeKnownCostUsd,
    };
  });
}
