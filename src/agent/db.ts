import { invoke } from "@tauri-apps/api/core";
import { atom } from "jotai";

export interface ProviderInstance {
  id: string; // UUID
  name: string; // User-defined name
  type: "openai" | "anthropic" | "openai-compatible";
  apiKey: string;
  baseUrl?: string; // Only for openai-compatible
  cachedModels?: Record<string, unknown>[]; // Cached models for openai-compatible
}

export async function loadProviders(): Promise<ProviderInstance[]> {
  return invoke<ProviderInstance[]>("providers_load");
}

export async function saveProvider(provider: ProviderInstance): Promise<void> {
  const current = await loadProviders();
  const updated = [...current.filter((p) => p.id !== provider.id), provider];
  await invoke("providers_save", { providers: updated });
}

export async function deleteProvider(id: string): Promise<void> {
  const current = await loadProviders();
  const updated = current.filter((p) => p.id !== id);
  await invoke("providers_save", { providers: updated });
}

export const providersAtom = atom<ProviderInstance[]>([]);
