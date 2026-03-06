import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderInstance } from "@/agent/db";

export type EnvProviderType = "openai" | "anthropic";

export interface EnvKeyEntry {
  type: EnvProviderType;
  apiKey: string;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function buildUniqueProviderName(
  baseName: string,
  providers: ProviderInstance[],
): string {
  const existingNames = new Set(
    providers.map((provider) => provider.name.trim().toLowerCase()),
  );
  if (!existingNames.has(baseName.toLowerCase())) return baseName;

  let suffix = 2;
  while (existingNames.has(`${baseName} ${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${baseName} ${suffix}`;
}

interface RawProviderEnvApiKeys {
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
}

let envProviderKeysCache: EnvKeyEntry[] | null = null;
let envProviderKeysLoadPromise: Promise<EnvKeyEntry[]> | null = null;

function normalizeProviderEnvApiKeys(result: RawProviderEnvApiKeys): EnvKeyEntry[] {
  return [
    { type: "openai" as const, apiKey: result.openaiApiKey?.trim() ?? "" },
    { type: "anthropic" as const, apiKey: result.anthropicApiKey?.trim() ?? "" },
  ].filter((entry) => entry.apiKey.length > 0);
}

async function loadProviderEnvApiKeysOnce(): Promise<EnvKeyEntry[]> {
  if (envProviderKeysCache) {
    return envProviderKeysCache;
  }
  if (!isTauriRuntime()) {
    envProviderKeysCache = [];
    return envProviderKeysCache;
  }
  if (envProviderKeysLoadPromise) {
    return envProviderKeysLoadPromise;
  }

  envProviderKeysLoadPromise = invoke<RawProviderEnvApiKeys>(
    "load_provider_env_api_keys",
  )
    .then((result) => {
      envProviderKeysCache = normalizeProviderEnvApiKeys(result);
      return envProviderKeysCache;
    })
    .catch(() => {
      envProviderKeysCache = [];
      return envProviderKeysCache;
    })
    .finally(() => {
      envProviderKeysLoadPromise = null;
    });

  return envProviderKeysLoadPromise;
}

/**
 * Warm env provider key cache during app startup so settings can open instantly.
 */
export function preloadEnvProviderKeys(): Promise<EnvKeyEntry[]> {
  return loadProviderEnvApiKeysOnce();
}

/**
 * Returns non-empty provider keys from a shared in-memory cache.
 * The cache is loaded once (and can be preloaded at app boot).
 */
export function useEnvProviderKeys(enabled = true): EnvKeyEntry[] {
  const [entries, setEntries] = useState<EnvKeyEntry[]>(() => envProviderKeysCache ?? []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    void loadProviderEnvApiKeysOnce().then((loadedEntries) => {
      if (cancelled) return;
      setEntries(loadedEntries);
    });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return entries;
}
