import rawCatalog from "./models.catalog.json";

export type SupportedProvider = "openai" | "anthropic" | "openai-compatible";

export interface ModelCatalogEntry {
  id: string; // E.g. "MyOpenAI/openai/gpt-5.3-codex"
  name: string; // The display name
  providerId: string; // Maps to ProviderInstance.id
  owned_by: SupportedProvider; // UI Badge indicator
  tags: string[];
  context_length?: number;
  pricing?: {
    prompt: number;
    completion: number;
  };
  /**
   * Provider-native model identifier used when constructing the SDK model.
   * E.g. "gpt-5.3-codex" or a raw compatible model id.
   */
  sdk_id: string;
}

interface ModelCatalogSourceProvider {
  id?: unknown;
  name?: unknown;
}

interface ModelCatalogSourceCost {
  input?: unknown;
  output?: unknown;
}

interface ModelCatalogSourceLimit {
  context?: unknown;
}

interface ModelCatalogSourceModalities {
  input?: unknown;
}

interface ModelCatalogSourceModel {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  tool_call?: unknown;
  structured_output?: unknown;
  modalities?: unknown;
  cost?: unknown;
  limit?: unknown;
}

interface ModelCatalogSourceEntry {
  provider?: unknown;
  model?: unknown;
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function inferTags(model: ModelCatalogSourceModel): string[] {
  const tags: string[] = [];

  if (model.reasoning === true) tags.push("reasoning");
  if (model.tool_call === true) tags.push("tool-use");
  if (model.structured_output === true) tags.push("structured-output");

  if (isRecord(model.modalities)) {
    const modalities = model.modalities as ModelCatalogSourceModalities;
    const inputModalities = isStringArray(modalities.input)
      ? modalities.input
      : [];

    if (inputModalities.includes("image")) tags.push("vision");
    if (inputModalities.includes("pdf")) tags.push("file-input");
  }

  return tags;
}

function normalizePrice(
  pricing: unknown,
): ModelCatalogEntry["pricing"] | undefined {
  if (!isRecord(pricing)) return undefined;

  const cost = pricing as ModelCatalogSourceCost;
  const prompt = getFiniteNumber(cost.input);
  const completion = getFiniteNumber(cost.output);

  if (prompt === undefined && completion === undefined) {
    return undefined;
  }

  return {
    prompt: prompt ?? 0,
    completion: completion ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSupportedProvider(value: unknown): value is SupportedProvider {
  return (
    value === "openai" || value === "anthropic" || value === "openai-compatible"
  );
}

function normalizeCatalog(input: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(input)) {
    throw new Error("Invalid model catalog: expected array");
  }

  const models: ModelCatalogEntry[] = [];

  for (const item of input) {
    if (!isRecord(item)) continue;

    const provider = isRecord((item as ModelCatalogSourceEntry).provider)
      ? ((item as ModelCatalogSourceEntry).provider as ModelCatalogSourceProvider)
      : null;
    const model = isRecord((item as ModelCatalogSourceEntry).model)
      ? ((item as ModelCatalogSourceEntry).model as ModelCatalogSourceModel)
      : null;

    if (!provider || !model) continue;

    const providerKey = typeof provider.id === "string" ? provider.id.trim() : "";
    const modelId = typeof model.id === "string" ? model.id.trim() : "";
    const name = typeof model.name === "string" ? model.name.trim() : "";

    if (!providerKey || !modelId || !name || !isSupportedProvider(providerKey)) {
      continue;
    }

    const limit = isRecord(model.limit)
      ? (model.limit as ModelCatalogSourceLimit)
      : null;
    const context_length = limit ? getFiniteNumber(limit.context) : undefined;

    models.push({
      id: `${providerKey}/${modelId}`,
      name,
      providerId: "", // Filled at runtime
      owned_by: providerKey,
      tags: inferTags(model),
      context_length,
      pricing: normalizePrice(model.cost),
      sdk_id: modelId,
    });
  }

  return models;
}

export const STATIC_MODEL_CATALOG: ModelCatalogEntry[] = [
  ...normalizeCatalog(rawCatalog),
].sort((a, b) => a.id.localeCompare(b.id));

// Fallback for missing configurations
export const DEFAULT_SELECTED_MODEL = "";

/**
 * Registry for dynamically built models across all configured providers.
 */
const dynamicModelRegistry = new Map<string, ModelCatalogEntry>();

/** Register a set of models (replaces any previous set). */
export function registerDynamicModels(entries: ModelCatalogEntry[]): void {
  for (const key of dynamicModelRegistry.keys()) {
    dynamicModelRegistry.delete(key);
  }
  for (const entry of entries) {
    dynamicModelRegistry.set(entry.id, entry);
  }
}

export function getModelCatalogEntry(id: string): ModelCatalogEntry | null {
  return dynamicModelRegistry.get(id) ?? null;
}
