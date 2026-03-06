import rawCatalog from "./models.catalog.json";

export type SupportedProvider = "openai" | "anthropic" | "openai-compatible";

export interface ModelCatalogEntry {
  id: string; // E.g. "MyOpenAI/gpt-4o"
  name: string; // The display name
  providerId: string; // Maps to ProviderInstance.id
  owned_by: SupportedProvider; // UI Badge indicator
  tags: string[];
  context_length?: number;
  pricing?: {
    prompt: string;
    completion: string;
  };
  /**
   * Provider-native model identifier used when constructing the SDK model.
   * E.g. "gpt-4o" or raw compatible model id.
   */
  sdk_id: string;
}

interface ModelCatalogFile {
  version: number;
  generatedAt: string;
  source: string;
  filters?: {
    providers?: string[];
    requiredTag?: string;
  };
  models: ModelCatalogEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSupportedProvider(value: unknown): value is SupportedProvider {
  return (
    value === "openai" || value === "anthropic" || value === "openai-compatible"
  );
}

function normalizeCatalog(input: unknown): ModelCatalogFile {
  if (!isRecord(input)) {
    throw new Error("Invalid model catalog: expected object");
  }

  const modelsRaw = Array.isArray(input.models) ? input.models : [];
  const models: ModelCatalogEntry[] = [];

  for (const item of modelsRaw) {
    if (!isRecord(item)) continue;

    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const ownedBy = item.owned_by;
    const sdkId = typeof item.sdk_id === "string" ? item.sdk_id.trim() : "";

    if (!id || !name || !isSupportedProvider(ownedBy)) continue;

    const tags = Array.isArray(item.tags)
      ? item.tags.filter((t): t is string => typeof t === "string")
      : [];

    const context_length =
      typeof item.context_length === "number" &&
      Number.isFinite(item.context_length)
        ? item.context_length
        : undefined;

    let pricing: ModelCatalogEntry["pricing"];
    if (isRecord(item.pricing)) {
      const prompt =
        typeof item.pricing.prompt === "string" ? item.pricing.prompt : "";
      const completion =
        typeof item.pricing.completion === "string"
          ? item.pricing.completion
          : "";
      if (prompt || completion) {
        pricing = { prompt, completion };
      }
    }

    models.push({
      id,
      name,
      providerId: "", // Filled at runtime
      owned_by: ownedBy,
      tags,
      context_length,
      pricing,
      sdk_id: sdkId,
    });
  }

  return {
    version: typeof input.version === "number" ? input.version : 1,
    generatedAt:
      typeof input.generatedAt === "string" ? input.generatedAt : "unknown",
    source: typeof input.source === "string" ? input.source : "unknown",
    models,
  };
}

const catalog = normalizeCatalog(rawCatalog);

export const STATIC_MODEL_CATALOG: ModelCatalogEntry[] = [
  ...catalog.models,
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
