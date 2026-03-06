import { useState, useCallback, useMemo } from "react";
import { useAtomValue } from "jotai";
import { providersAtom } from "./db";
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

function normalizeSearchValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[./:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreSubsequence(field: string, token: string): number {
  let tokenIdx = 0;
  let firstMatch = -1;
  let gapCount = 0;

  for (let fieldIdx = 0; fieldIdx < field.length; fieldIdx += 1) {
    if (tokenIdx >= token.length) break;

    if (field[fieldIdx] === token[tokenIdx]) {
      if (firstMatch === -1) firstMatch = fieldIdx;
      tokenIdx += 1;
      continue;
    }

    if (tokenIdx > 0) {
      gapCount += 1;
    }
  }

  if (tokenIdx !== token.length || firstMatch === -1) {
    return 0;
  }

  const proximityBonus = Math.max(0, 20 - firstMatch);
  const gapPenalty = Math.min(28, gapCount);
  return Math.max(1, 42 + proximityBonus - gapPenalty);
}

function scoreTokenInField(field: string, token: string): number {
  if (!field || !token) return 0;

  if (field === token) return 220;
  if (field.startsWith(token)) return 170;

  const words = field.split(" ");
  if (words.some((word) => word.startsWith(token))) return 145;

  const containsIndex = field.indexOf(token);
  if (containsIndex >= 0) {
    return Math.max(90, 130 - containsIndex);
  }

  if (token.length < 2) return 0;
  return scoreSubsequence(field, token);
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
  ]
    .map(normalizeSearchValue)
    .filter(Boolean);
}

export function filterModelsForQuery(
  models: GatewayModel[],
  query: string,
  limit = 80,
): GatewayModel[] {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return models.slice(0, limit);

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (tokens.length === 0) return models.slice(0, limit);

  return models
    .map((model, index) => {
      const fields = getModelSearchFields(model);
      let score = 0;

      for (const token of tokens) {
        let bestTokenScore = 0;
        for (const field of fields) {
          const tokenScore = scoreTokenInField(field, token);
          if (tokenScore > bestTokenScore) {
            bestTokenScore = tokenScore;
          }
        }

        if (bestTokenScore === 0) {
          return null;
        }

        score += bestTokenScore;
      }

      for (const field of fields) {
        if (field === normalizedQuery) {
          score += 140;
          continue;
        }
        if (field.startsWith(normalizedQuery)) {
          score += 90;
          continue;
        }
        if (field.includes(normalizedQuery)) {
          score += 55;
        }
      }

      return { model, index, score };
    })
    .filter((entry): entry is { model: GatewayModel; index: number; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.model);
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
