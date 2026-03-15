import { invoke } from "@tauri-apps/api/core";
import { atom } from "jotai";

export interface ProviderModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ProviderModelLimit {
  context?: number;
}

export interface ProviderModelRecord {
  id: string;
  owned_by?: string;
  name?: string;
  cost?: ProviderModelCost;
  limit?: ProviderModelLimit;
}

export interface ProviderInstance {
  id: string; // UUID
  name: string; // User-defined name
  type: "openai" | "anthropic" | "openai-compatible";
  apiKey: string;
  baseUrl?: string; // Only for openai-compatible
  cachedModels?: ProviderModelRecord[]; // Cached models for openai-compatible
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function normalizeProviderModelCost(value: unknown): ProviderModelCost | undefined {
  if (!isRecord(value)) return undefined;

  const input = parseFiniteNumber(value.input);
  const output = parseFiniteNumber(value.output);
  const cacheRead = parseFiniteNumber(
    "cacheRead" in value ? value.cacheRead : value.cache_read,
  );
  const cacheWrite = parseFiniteNumber(
    "cacheWrite" in value ? value.cacheWrite : value.cache_write,
  );

  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }

  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function normalizeProviderModelLimit(value: unknown): ProviderModelLimit | undefined {
  if (!isRecord(value)) return undefined;

  const context = parseFiniteNumber(value.context);
  if (context === undefined) return undefined;

  return { context };
}

export function normalizeProviderModelRecord(
  value: unknown,
): ProviderModelRecord | null {
  if (!isRecord(value)) return null;

  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) return null;

  const ownedBy =
    typeof value.owned_by === "string" && value.owned_by.trim()
      ? value.owned_by.trim()
      : undefined;
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : undefined;
  const cost = normalizeProviderModelCost(value.cost);
  const limit = normalizeProviderModelLimit(value.limit);

  return {
    id,
    ...(ownedBy ? { owned_by: ownedBy } : {}),
    ...(name ? { name } : {}),
    ...(cost ? { cost } : {}),
    ...(limit ? { limit } : {}),
  };
}

export function normalizeProviderCachedModels(
  models: unknown,
): ProviderModelRecord[] {
  if (!Array.isArray(models)) return [];

  const seen = new Set<string>();
  const normalized: ProviderModelRecord[] = [];

  for (const model of models) {
    const record = normalizeProviderModelRecord(model);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    normalized.push(record);
  }

  return normalized;
}

export function mergeProviderCachedModels(
  existing: unknown,
  loaded: unknown,
): ProviderModelRecord[] {
  const previousById = new Map(
    normalizeProviderCachedModels(existing).map((model) => [model.id, model]),
  );

  return normalizeProviderCachedModels(loaded).map((model) => {
    const previous = previousById.get(model.id);
    return {
      ...model,
      ...(previous?.name && !model.name ? { name: previous.name } : {}),
      ...(previous?.owned_by && !model.owned_by
        ? { owned_by: previous.owned_by }
        : {}),
      ...(previous?.cost && !model.cost ? { cost: previous.cost } : {}),
      ...(previous?.limit && !model.limit ? { limit: previous.limit } : {}),
    };
  });
}

function normalizeProviderInstance(provider: ProviderInstance): ProviderInstance {
  return {
    ...provider,
    baseUrl: provider.baseUrl?.trim() || undefined,
    cachedModels:
      provider.type === "openai-compatible"
        ? normalizeProviderCachedModels(provider.cachedModels)
        : undefined,
  };
}

export async function loadProviders(): Promise<ProviderInstance[]> {
  const providers = await invoke<ProviderInstance[]>("providers_load");
  return providers.map(normalizeProviderInstance);
}

export async function saveProvider(provider: ProviderInstance): Promise<void> {
  const current = await loadProviders();
  const updated = [
    ...current.filter((p) => p.id !== provider.id),
    normalizeProviderInstance(provider),
  ];
  await invoke("providers_save", { providers: updated });
}

export async function deleteProvider(id: string): Promise<void> {
  const current = await loadProviders();
  const updated = current.filter((p) => p.id !== id);
  await invoke("providers_save", { providers: updated });
}

export const providersAtom = atom<ProviderInstance[]>([]);

export interface CommunicationProfileRecord {
  id: string;
  name: string;
  promptSnippet: string;
}

export async function loadProfiles(): Promise<CommunicationProfileRecord[]> {
  return invoke<CommunicationProfileRecord[]>("profiles_load");
}

export async function saveProfile(profile: CommunicationProfileRecord): Promise<void> {
  const current = await loadProfiles();
  const updated = [...current.filter((p) => p.id !== profile.id), profile];
  await invoke("profiles_save", { profiles: updated });
}

export async function deleteProfile(id: string): Promise<void> {
  const current = await loadProfiles();
  const updated = current.filter((p) => p.id !== id);
  await invoke("profiles_save", { profiles: updated });
}

export const profilesAtom = atom<CommunicationProfileRecord[]>([]);

/* ── Command List ─────────────────────────────────────────────────────────── */

export type MatchMode = "exact" | "prefix" | "glob";

export interface CommandListEntry {
  id: string;
  pattern: string;
  matchMode: MatchMode;
  description?: string;
  /** "user" | "default" | subagent id */
  source: string;
}

export interface CommandList {
  allow: CommandListEntry[];
  deny: CommandListEntry[];
}

export async function loadCommandList(): Promise<CommandList> {
  return invoke<CommandList>("command_list_load");
}

export async function saveCommandList(list: CommandList): Promise<void> {
  await invoke("command_list_save", { list });
}

export const commandListAtom = atom<CommandList>({ allow: [], deny: [] });
