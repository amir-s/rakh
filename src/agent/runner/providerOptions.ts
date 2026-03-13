import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { getModelCatalogEntry } from "../modelCatalog";
import { DEFAULT_ADVANCED_OPTIONS, type AdvancedModelOptions } from "../types";
import type { ProviderInstance } from "../db";
import type { JsonValue } from "./utils";

function supportsAnthropicFastMode(modelSdkId?: string): boolean {
  return typeof modelSdkId === "string" && modelSdkId.startsWith("claude-opus-4-6");
}

function supportsAnthropicEffort(modelSdkId?: string): boolean {
  return (
    typeof modelSdkId === "string" &&
    (modelSdkId.startsWith("claude-opus-4-5") ||
      modelSdkId.startsWith("claude-opus-4-6"))
  );
}

export function buildProviderOptions(
  provider: string | null,
  opts?: AdvancedModelOptions,
  modelSdkId?: string,
): Record<string, Record<string, JsonValue>> | undefined {
  if (provider !== "openai" && provider !== "anthropic") return undefined;

  const { reasoningVisibility, reasoningEffort, latencyCostProfile } =
    opts ?? DEFAULT_ADVANCED_OPTIONS;

  if (provider === "openai") {
    const openai: Record<string, JsonValue> = {};

    if (reasoningVisibility === "auto") {
      openai.reasoningSummary = "auto";
    } else if (reasoningVisibility === "detailed") {
      openai.reasoningSummary = "detailed";
    }

    openai.reasoningEffort = reasoningEffort;

    if (latencyCostProfile === "fast") {
      openai.serviceTier = "priority";
    } else if (latencyCostProfile === "cheap") {
      openai.serviceTier = "flex";
    } else {
      openai.serviceTier = "auto";
    }

    return { openai };
  }

  const anthropic: Record<string, JsonValue> = {};

  if (reasoningVisibility === "off") {
    anthropic.thinking = { type: "disabled" };
  } else if (reasoningVisibility === "detailed") {
    anthropic.thinking = { type: "enabled", budgetTokens: 4096 };
  } else {
    anthropic.thinking = { type: "adaptive" };
  }

  if (supportsAnthropicEffort(modelSdkId)) {
    anthropic.effort = reasoningEffort;
  }

  if (
    latencyCostProfile === "fast" &&
    supportsAnthropicFastMode(modelSdkId)
  ) {
    anthropic.speed = "fast";
  }

  return { anthropic };
}

export function resolveLanguageModel(
  modelKey: string,
  providers: ProviderInstance[],
) {
  const modelEntry = getModelCatalogEntry(modelKey);
  if (!modelEntry) {
    throw new Error(
      `Unknown model "${modelKey}". Update src/agent/models.catalog.json and pick a valid model.`,
    );
  }

  const provider = providers.find((p) => p.id === modelEntry.providerId);
  const providerModelId = modelEntry.sdk_id.trim();

  if (!provider) {
    throw new Error(
      `Model "${modelEntry.id}" references an unknown provider ID "${modelEntry.providerId}". Did you delete it?`,
    );
  }

  if (!providerModelId) {
    throw new Error(
      `Model "${modelEntry.id}" is missing a provider model ID. Update src/agent/models.catalog.json for this model.`,
    );
  }

  if (provider.type === "openai") {
    const openai = createOpenAI({ apiKey: provider.apiKey });
    return openai(providerModelId);
  }

  if (provider.type === "openai-compatible") {
    const baseURL = (provider.baseUrl || "").trim().replace(/\/+$/, "");
    if (!baseURL) {
      throw new Error(
        `OpenAI-compatible provider "${provider.name}" base URL is not configured. Set it in Settings.`,
      );
    }
    const compat = createOpenAICompatible({
      name: "custom",
      baseURL: `${baseURL}`,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    });
    return compat(providerModelId);
  }

  const anthropic = createAnthropic({
    apiKey: provider.apiKey,
    headers: {
      "anthropic-dangerous-direct-browser-access": "true",
    },
  });
  return anthropic(providerModelId);
}
