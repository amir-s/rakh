import { useState, useCallback, useMemo } from "react";
import { useAtomValue } from "jotai";
import { providersAtom } from "./db";
import { rankFuzzyItems } from "@/utils/fuzzySearch";
import {
  STATIC_MODEL_CATALOG,
  DEFAULT_SELECTED_MODEL,
  getModelCatalogEntry,
  registerDynamicModels,
  type ModelCatalogEntry,
} from "./modelCatalog";

export type GatewayModel = ModelCatalogEntry;

const MODEL_PREF_KEY = "rakh.selected-model";

/** Format context length as "128K" or "1M". Returns "" if unknown. */
export function fmtCtx(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  return `${Math.round(n / 1_000)}K`;
}

/** Format prompt price per 1M tokens. Returns "free" or "$0.15/M". */
export function fmtPrice(pricing?: { prompt: string }): string {
  if (!pricing?.prompt) return "";
  const perToken = parseFloat(pricing.prompt);
  if (isNaN(perToken) || perToken === 0) return "free";
  const perM = perToken * 1_000_000;
  return `$${perM < 1 ? perM.toFixed(3) : perM.toFixed(2)}/M`;
}

function getModelSearchFields(model: GatewayModel): string[] {
  const providerAliases =
    model.owned_by === "openai-compatible"
      ? "openai compatible compatible custom"
      : model.owned_by;

  return [
    model.name,
    model.id,
    model.providerId,
    model.tags.join(" "),
    providerAliases,
  ];
}

export function filterModelsForQuery(
  models: GatewayModel[],
  query: string,
  limit = 80,
): GatewayModel[] {
  return rankFuzzyItems(models, query, getModelSearchFields)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * useModels — builds dynamic models across all configured providers.
 */
export function useModels() {
  const providers = useAtomValue(providersAtom);

  const models = useMemo(() => {
    const list: ModelCatalogEntry[] = [];

    for (const provider of providers) {
      if (provider.type === "openai" || provider.type === "anthropic") {
        // Find matching models from the static catalog
        const matchingModels = STATIC_MODEL_CATALOG.filter(
          (m) => m.owned_by === provider.type,
        );
        for (const staticModel of matchingModels) {
          list.push({
            ...staticModel,
            id: `${provider.name}/${staticModel.id}`,
            name: `${staticModel.name}`,
            providerId: provider.id,
          });
        }
      } else if (
        provider.type === "openai-compatible" &&
        provider.cachedModels
      ) {
        for (const m of provider.cachedModels) {
          const rawId =
            typeof m.id === "string" ? m.id : String(m.id ?? "unknown");
          list.push({
            id: `${provider.name}/${rawId}`,
            providerId: provider.id,
            name: rawId,
            owned_by: "openai-compatible",
            tags: [],
            sdk_id: rawId,
          });
        }
      }
    }

    // Keep the dynamic registry in sync so getModelCatalogEntry works in the runner
    registerDynamicModels(list);
    return list;
  }, [providers]);

  return {
    models,
    loading: false,
    error: null,
  };
}

/**
 * useFilteredModels — returns models filtered by a search query (memoised)
 */
export function useFilteredModels(
  models: GatewayModel[],
  query: string,
  limit = 80,
): GatewayModel[] {
  return useMemo(
    () => filterModelsForQuery(models, query, limit),
    [models, query, limit],
  );
}

/**
 * useSelectedModel — reads/writes selected model key to localStorage.
 * Falls back to DEFAULT_SELECTED_MODEL when saved value is missing/invalid.
 */
export function useSelectedModel(
  allModels?: GatewayModel[],
): [string, (m: string) => void] {
  const [model, setModelState] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_SELECTED_MODEL;
    const saved = localStorage.getItem(MODEL_PREF_KEY);
    return saved ? saved : DEFAULT_SELECTED_MODEL;
  });

  const setModel = useCallback(
    (m: string) => {
      // Accept the model if it's in the dynamic registry OR in the provided list
      const inCatalog = getModelCatalogEntry(m);
      const inList = allModels?.find((e) => e.id === m);
      const next = inCatalog?.id ?? inList?.id ?? DEFAULT_SELECTED_MODEL;
      setModelState(next);
      localStorage.setItem(MODEL_PREF_KEY, next);
    },
    [allModels],
  );

  return [model, setModel];
}
