import { invoke } from "@tauri-apps/api/core";

import {
  DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS,
  DEFAULT_TOOL_CONTEXT_COMPACTION_ENABLED,
  sanitizeAutoContextCompactionSettings,
  type AutoContextCompactionSettings,
} from "./contextCompaction";

export interface PersistedCompactionSettings {
  toolContextCompactionEnabled: boolean;
  autoContextCompaction: AutoContextCompactionSettings;
}

export const DEFAULT_PERSISTED_COMPACTION_SETTINGS: PersistedCompactionSettings =
  {
    toolContextCompactionEnabled: DEFAULT_TOOL_CONTEXT_COMPACTION_ENABLED,
    autoContextCompaction: DEFAULT_AUTO_CONTEXT_COMPACTION_SETTINGS,
  };

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalizeCompactionSettings(
  value: Partial<PersistedCompactionSettings> | null | undefined,
): PersistedCompactionSettings {
  return {
    toolContextCompactionEnabled:
      value?.toolContextCompactionEnabled !== false,
    autoContextCompaction: sanitizeAutoContextCompactionSettings(
      value?.autoContextCompaction,
    ),
  };
}

export async function loadCompactionSettings(): Promise<PersistedCompactionSettings> {
  if (!isTauri()) {
    return DEFAULT_PERSISTED_COMPACTION_SETTINGS;
  }

  const settings = await invoke<Partial<PersistedCompactionSettings>>(
    "compaction_settings_load",
  );
  return normalizeCompactionSettings(settings);
}

export async function saveCompactionSettings(
  settings: PersistedCompactionSettings,
): Promise<void> {
  if (!isTauri()) return;

  await invoke("compaction_settings_save", {
    settings: normalizeCompactionSettings(settings),
  });
}
