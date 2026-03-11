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
