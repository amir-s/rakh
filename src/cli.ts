import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const CLI_OPEN_REQUEST_EVENT = "rakh_cli_open_request";

export interface CliStatus {
  installed: boolean;
  commandPath?: string;
  binDir: string;
  appExecutablePath: string;
  onPath: boolean;
  manualPathSnippet?: string;
  needsTerminalRestart: boolean;
}

export interface CliOpenRequest {
  path?: string;
  addProject: boolean;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function emptyCliStatus(): CliStatus {
  return {
    installed: false,
    binDir: "",
    appExecutablePath: "",
    onPath: false,
    needsTerminalRestart: false,
  };
}

export async function getCliStatus(): Promise<CliStatus> {
  if (!isTauriRuntime()) {
    return emptyCliStatus();
  }
  return invoke<CliStatus>("cli_get_status");
}

export async function installCli(): Promise<CliStatus> {
  if (!isTauriRuntime()) {
    return emptyCliStatus();
  }
  return invoke<CliStatus>("cli_install");
}

export async function uninstallCli(): Promise<CliStatus> {
  if (!isTauriRuntime()) {
    return emptyCliStatus();
  }
  return invoke<CliStatus>("cli_uninstall");
}

export async function takePendingCliRequests(): Promise<CliOpenRequest[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return invoke<CliOpenRequest[]>("cli_take_pending_requests");
}

export async function listenForCliOpenRequests(
  onRequest: (request: CliOpenRequest) => void,
): Promise<UnlistenFn | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  return listen<CliOpenRequest>(CLI_OPEN_REQUEST_EVENT, (event) => {
    onRequest(event.payload);
  });
}
