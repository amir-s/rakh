import { invoke } from "@tauri-apps/api/core";

export interface AgentLoopSettings {
  warningThreshold: number;
  hardLimit: number;
}

export const DEFAULT_AGENT_LOOP_SETTINGS: AgentLoopSettings = {
  warningThreshold: 40,
  hardLimit: 50,
};

export const AGENT_LOOP_LIMIT_TOOL_NAME = "agent_loop_limit_guard" as const;
export const AGENT_LOOP_NEAR_LIMIT_WINDOW = 10;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

export function normalizeAgentLoopSettings(
  value: Partial<AgentLoopSettings> | null | undefined,
): AgentLoopSettings {
  const hardLimit = Math.max(
    2,
    normalizePositiveInteger(value?.hardLimit, DEFAULT_AGENT_LOOP_SETTINGS.hardLimit),
  );
  let warningThreshold = Math.max(
    1,
    normalizePositiveInteger(
      value?.warningThreshold,
      DEFAULT_AGENT_LOOP_SETTINGS.warningThreshold,
    ),
  );

  if (warningThreshold >= hardLimit) {
    warningThreshold = Math.max(1, hardLimit - 1);
  }

  return { warningThreshold, hardLimit };
}

export async function loadAgentLoopSettings(): Promise<AgentLoopSettings> {
  if (!isTauri()) {
    return DEFAULT_AGENT_LOOP_SETTINGS;
  }

  const settings = await invoke<Partial<AgentLoopSettings>>("agent_settings_load");
  return normalizeAgentLoopSettings(settings);
}

export async function saveAgentLoopSettings(
  settings: AgentLoopSettings,
): Promise<void> {
  if (!isTauri()) return;

  await invoke("agent_settings_save", {
    settings: normalizeAgentLoopSettings(settings),
  });
}
