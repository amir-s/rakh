import type { CurrentContextStats } from "./sessionStats";

export const DEFAULT_TOOL_CONTEXT_COMPACTION_ENABLED = true;
export const DEFAULT_TOOL_CONTEXT_COMPACTION_THRESHOLD_KB = 16;

export type AutoContextCompactionThresholdMode = "percentage" | "kb";

export interface AutoContextCompactionSettings {
  enabled: boolean;
  thresholdMode: AutoContextCompactionThresholdMode;
  thresholdPercent: number;
  thresholdKb: number;
}

export interface AutoContextCompactionTrigger {
  mode: AutoContextCompactionThresholdMode;
  threshold: number;
  currentValue: number;
  reason: string;
}

export const DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS: AutoContextCompactionSettings =
  {
    enabled: false,
    thresholdMode: "percentage",
    thresholdPercent: 85,
    thresholdKb: 256,
  };

export function sanitizeToolContextCompactionThresholdKb(
  value: unknown,
): number {
  if (typeof value === "number" && Number.isFinite(value) && Math.round(value) <= 0) {
    return DEFAULT_TOOL_CONTEXT_COMPACTION_THRESHOLD_KB;
  }
  return clampInteger(
    value,
    DEFAULT_TOOL_CONTEXT_COMPACTION_THRESHOLD_KB,
    1,
    1_048_576,
  );
}

function clampInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return Math.min(maximum, Math.max(minimum, rounded));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeAutoContextCompactionSettings(
  value: unknown,
): AutoContextCompactionSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS };
  }

  return {
    enabled: value.enabled === true,
    thresholdMode:
      value.thresholdMode === "kb" ? "kb" : DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS.thresholdMode,
    thresholdPercent: clampInteger(
      value.thresholdPercent,
      DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS.thresholdPercent,
      1,
      100,
    ),
    thresholdKb: clampInteger(
      value.thresholdKb,
      DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS.thresholdKb,
      1,
      1_048_576,
    ),
  };
}

export function evaluateAutoContextCompactionTrigger(
  stats: CurrentContextStats | null,
  settings: AutoContextCompactionSettings,
): AutoContextCompactionTrigger | null {
  if (!settings.enabled || !stats) return null;

  if (settings.thresholdMode === "percentage") {
    if (stats.pct === null) return null;
    if (stats.pct < settings.thresholdPercent) return null;
    return {
      mode: "percentage",
      threshold: settings.thresholdPercent,
      currentValue: stats.pct,
      reason: `Context window usage reached ${stats.pct.toFixed(1)}% (threshold ${settings.thresholdPercent}%).`,
    };
  }

  if (stats.currentKb < settings.thresholdKb) return null;
  return {
    mode: "kb",
    threshold: settings.thresholdKb,
    currentValue: stats.currentKb,
    reason: `Context size reached ${stats.currentKb.toFixed(1)} KB (threshold ${settings.thresholdKb} KB).`,
  };
}
