import { invoke } from "@tauri-apps/api/core";
import { atom } from "jotai";
import { jotaiStore } from "./atoms";
import type {
  ContextGatewayConfig,
  ContextGatewayConfigProvider,
} from "./contextGateway";
import type {
  HugeOutputThresholdBand,
  ToolGatewayConfig,
  ToolGatewayConfigProvider,
} from "./toolGateway";

export interface GatewayPolicySettings {
  toolGateway: ToolGatewayConfig;
  contextGateway: ContextGatewayConfig;
}

export const DEFAULT_TOOL_GATEWAY_CONFIG: ToolGatewayConfig = {
  hugeOutput: {
    enabled: true,
    defaultThresholdBytes: 64 * 1024,
    thresholdBands: [
      { minContextUsagePct: 90, maxBytes: 16 * 1024 },
      { minContextUsagePct: 75, maxBytes: 32 * 1024 },
    ],
  },
  summary: {
    enabled: true,
    modelStrategy: "parent",
    maxSummaryChars: 320,
    maxSteps: 5,
    toolArtifactGetMaxBytes: 12_000,
    toolArtifactSearchMaxMatches: 8,
    toolArtifactSearchContextLines: 1,
  },
};

export const DEFAULT_CONTEXT_GATEWAY_CONFIG: ContextGatewayConfig = {
  enabled: true,
  todoNormalization: {
    enabled: true,
    triggerMinContextUsagePct: 75,
    replaceApiMessagesAfterCompaction: true,
    modelStrategy: "override",
    overrideModelId: "openai/gpt-5.2-codex",
  },
};

export const DEFAULT_GATEWAY_POLICY_SETTINGS: GatewayPolicySettings = {
  toolGateway: DEFAULT_TOOL_GATEWAY_CONFIG,
  contextGateway: DEFAULT_CONTEXT_GATEWAY_CONFIG,
};

export const gatewayPolicySettingsAtom = atom<GatewayPolicySettings>(
  DEFAULT_GATEWAY_POLICY_SETTINGS,
);

function toPositiveInt(value: unknown, fallback: number): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : fallback;
}

function toPct(value: unknown, fallback: number): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return Math.max(0, Math.min(100, truncated));
}

function normalizeThresholdBands(
  value: unknown,
  fallback: HugeOutputThresholdBand[],
): HugeOutputThresholdBand[] {
  if (!Array.isArray(value)) return fallback;

  const bands = value
    .map((entry, index) => {
      const raw = entry as Partial<HugeOutputThresholdBand> | null | undefined;
      const fallbackBand = fallback[index] ?? fallback[fallback.length - 1];
      return {
        minContextUsagePct: toPct(
          raw?.minContextUsagePct,
          fallbackBand?.minContextUsagePct ?? 0,
        ),
        maxBytes: toPositiveInt(raw?.maxBytes, fallbackBand?.maxBytes ?? 1),
      };
    })
    .filter((band) => Number.isFinite(band.minContextUsagePct));

  if (bands.length === 0) return fallback;
  return bands.sort(
    (left, right) => right.minContextUsagePct - left.minContextUsagePct,
  );
}

function normalizeOptionalModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeToolGatewayConfig(
  value: Partial<ToolGatewayConfig> | null | undefined,
): ToolGatewayConfig {
  const hugeOutputRaw = value?.hugeOutput;
  const summaryRaw = value?.summary;

  return {
    hugeOutput: {
      enabled:
        typeof hugeOutputRaw?.enabled === "boolean"
          ? hugeOutputRaw.enabled
          : DEFAULT_TOOL_GATEWAY_CONFIG.hugeOutput.enabled,
      defaultThresholdBytes: toPositiveInt(
        hugeOutputRaw?.defaultThresholdBytes,
        DEFAULT_TOOL_GATEWAY_CONFIG.hugeOutput.defaultThresholdBytes,
      ),
      thresholdBands: normalizeThresholdBands(
        hugeOutputRaw?.thresholdBands,
        DEFAULT_TOOL_GATEWAY_CONFIG.hugeOutput.thresholdBands,
      ),
    },
    summary: {
      enabled:
        typeof summaryRaw?.enabled === "boolean"
          ? summaryRaw.enabled
          : DEFAULT_TOOL_GATEWAY_CONFIG.summary.enabled,
      modelStrategy:
        summaryRaw?.modelStrategy === "override" ? "override" : "parent",
      overrideModelId: normalizeOptionalModelId(summaryRaw?.overrideModelId),
      maxSummaryChars: toPositiveInt(
        summaryRaw?.maxSummaryChars,
        DEFAULT_TOOL_GATEWAY_CONFIG.summary.maxSummaryChars,
      ),
      maxSteps: toPositiveInt(
        summaryRaw?.maxSteps,
        DEFAULT_TOOL_GATEWAY_CONFIG.summary.maxSteps,
      ),
      toolArtifactGetMaxBytes: toPositiveInt(
        summaryRaw?.toolArtifactGetMaxBytes,
        DEFAULT_TOOL_GATEWAY_CONFIG.summary.toolArtifactGetMaxBytes,
      ),
      toolArtifactSearchMaxMatches: toPositiveInt(
        summaryRaw?.toolArtifactSearchMaxMatches,
        DEFAULT_TOOL_GATEWAY_CONFIG.summary.toolArtifactSearchMaxMatches,
      ),
      toolArtifactSearchContextLines: toPositiveInt(
        summaryRaw?.toolArtifactSearchContextLines,
        DEFAULT_TOOL_GATEWAY_CONFIG.summary.toolArtifactSearchContextLines,
      ),
    },
  };
}

function normalizeContextGatewayConfig(
  value: Partial<ContextGatewayConfig> | null | undefined,
): ContextGatewayConfig {
  const todoNormalizationRaw = value?.todoNormalization;
  return {
    enabled:
      typeof value?.enabled === "boolean"
        ? value.enabled
        : DEFAULT_CONTEXT_GATEWAY_CONFIG.enabled,
    todoNormalization: {
      enabled:
        typeof todoNormalizationRaw?.enabled === "boolean"
          ? todoNormalizationRaw.enabled
          : DEFAULT_CONTEXT_GATEWAY_CONFIG.todoNormalization.enabled,
      triggerMinContextUsagePct: toPct(
        todoNormalizationRaw?.triggerMinContextUsagePct,
        DEFAULT_CONTEXT_GATEWAY_CONFIG.todoNormalization.triggerMinContextUsagePct,
      ),
      replaceApiMessagesAfterCompaction:
        typeof todoNormalizationRaw?.replaceApiMessagesAfterCompaction ===
        "boolean"
          ? todoNormalizationRaw.replaceApiMessagesAfterCompaction
          : DEFAULT_CONTEXT_GATEWAY_CONFIG.todoNormalization
              .replaceApiMessagesAfterCompaction,
      modelStrategy:
        todoNormalizationRaw?.modelStrategy === "parent" ? "parent" : "override",
      overrideModelId: normalizeOptionalModelId(
        todoNormalizationRaw?.overrideModelId,
      ),
    },
  };
}

export function normalizeGatewayPolicySettings(
  value: Partial<GatewayPolicySettings> | null | undefined,
): GatewayPolicySettings {
  return {
    toolGateway: normalizeToolGatewayConfig(value?.toolGateway),
    contextGateway: normalizeContextGatewayConfig(value?.contextGateway),
  };
}

export async function loadGatewayPolicySettings(): Promise<GatewayPolicySettings> {
  const settings = await invoke<Partial<GatewayPolicySettings>>(
    "gateway_policy_settings_load",
  );
  return normalizeGatewayPolicySettings(settings);
}

export async function saveGatewayPolicySettings(
  settings: GatewayPolicySettings,
): Promise<void> {
  await invoke("gateway_policy_settings_save", {
    settings: normalizeGatewayPolicySettings(settings),
  });
}

export const persistedToolGatewayConfigProvider: ToolGatewayConfigProvider = {
  getConfig: () => jotaiStore.get(gatewayPolicySettingsAtom).toolGateway,
};

export const persistedContextGatewayConfigProvider: ContextGatewayConfigProvider =
  {
    getConfig: () => jotaiStore.get(gatewayPolicySettingsAtom).contextGateway,
  };
