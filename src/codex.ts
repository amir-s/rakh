import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const CODEX_SESSION_EVENT = "codex_session_event";

export interface CodexStatus {
  available: boolean;
  version: string | null;
  commandPath: string | null;
  error: string | null;
}

export interface CodexSessionStartResult {
  runtimeId: string;
}

export interface CodexSessionSendTurnInput {
  runtimeId: string;
  cwd: string;
  prompt: string;
  profilePrompt?: string | null;
  threadId?: string | null;
}

export interface CodexSessionSendTurnResult {
  threadId: string | null;
}

export interface CodexSessionEventEnvelope {
  runtimeId: string;
  event: Record<string, unknown>;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function unavailableStatus(): CodexStatus {
  return {
    available: false,
    version: null,
    commandPath: null,
    error: null,
  };
}

export async function getCodexStatus(): Promise<CodexStatus> {
  if (!isTauriRuntime()) return unavailableStatus();
  return invoke<CodexStatus>("codex_get_status");
}

export async function codexSessionStart(): Promise<CodexSessionStartResult> {
  return invoke<CodexSessionStartResult>("codex_session_start");
}

export async function codexSessionSendTurn(
  input: CodexSessionSendTurnInput,
): Promise<CodexSessionSendTurnResult> {
  return invoke<CodexSessionSendTurnResult>("codex_session_send_turn", { input });
}

export async function codexSessionInterrupt(runtimeId: string): Promise<void> {
  await invoke("codex_session_interrupt", { input: { runtimeId } });
}

export async function codexSessionClose(runtimeId: string): Promise<void> {
  await invoke("codex_session_close", { input: { runtimeId } });
}

export async function listenForCodexSessionEvents(
  onEvent: (event: CodexSessionEventEnvelope) => void,
): Promise<UnlistenFn | null> {
  if (!isTauriRuntime()) return null;
  return listen<CodexSessionEventEnvelope>(CODEX_SESSION_EVENT, (event) => {
    onEvent(event.payload);
  });
}
