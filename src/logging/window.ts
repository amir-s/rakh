import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { LogQueryFilter } from "./types";

export const LOG_WINDOW_LABEL = "logs";
export const LOG_WINDOW_MODE = "logs";
export const LOG_WINDOW_NAVIGATE_EVENT = "logs:navigate";
export const LOG_WINDOW_PAYLOAD_QUERY_KEY = "logsPayload";
export const DEFAULT_LOG_LIMIT = 500;

export interface LogWindowNavigatePayload {
  filter: LogQueryFilter;
  origin: "manual" | "debug-pane" | "assistant-message" | "tool-call";
  tailEnabled?: boolean;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LOG_LIMIT;
  return Math.max(1, Math.min(1000, Math.floor(limit ?? DEFAULT_LOG_LIMIT)));
}

export function normalizeLogNavigatePayload(
  payload: LogWindowNavigatePayload,
): LogWindowNavigatePayload {
  return {
    ...payload,
    filter: {
      ...payload.filter,
      limit: normalizeLimit(payload.filter.limit),
    },
    tailEnabled: payload.tailEnabled ?? true,
  };
}

export function parseLogNavigatePayloadFromSearch(
  search: string,
): LogWindowNavigatePayload | null {
  const params = new URLSearchParams(search);
  const raw = params.get(LOG_WINDOW_PAYLOAD_QUERY_KEY);
  if (!raw) return null;

  try {
    return normalizeLogNavigatePayload(
      JSON.parse(raw) as LogWindowNavigatePayload,
    );
  } catch {
    return null;
  }
}

function buildLogViewerUrl(payload: LogWindowNavigatePayload): string {
  const current = new URL(window.location.href);
  current.searchParams.delete("preview");
  current.searchParams.set("window", LOG_WINDOW_MODE);
  current.searchParams.set(
    LOG_WINDOW_PAYLOAD_QUERY_KEY,
    JSON.stringify(normalizeLogNavigatePayload(payload)),
  );
  return current.toString();
}

async function focusWindow(win: WebviewWindow): Promise<void> {
  try {
    await win.show();
  } catch {
    // Best effort.
  }

  try {
    await win.unminimize();
  } catch {
    // Best effort.
  }

  try {
    await win.setFocus();
  } catch {
    // Best effort.
  }
}

async function waitForWindowCreated(win: WebviewWindow): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    void win.once("tauri://created", () => {
      finish(resolve);
    });
    void win.once("tauri://error", (event) => {
      finish(() =>
        reject(
          event.payload instanceof Error
            ? event.payload
            : new Error(String(event.payload)),
        ),
      );
    });
  });
}

export async function openLogViewerWindow(
  payload: LogWindowNavigatePayload,
): Promise<boolean> {
  if (!isTauriRuntime()) return false;

  const normalized = normalizeLogNavigatePayload(payload);
  const existing = await WebviewWindow.getByLabel(LOG_WINDOW_LABEL);
  if (existing) {
    await emitTo(LOG_WINDOW_LABEL, LOG_WINDOW_NAVIGATE_EVENT, normalized);
    await focusWindow(existing);
    return true;
  }

  const created = new WebviewWindow(LOG_WINDOW_LABEL, {
    title: "Rakh Logs",
    url: buildLogViewerUrl(normalized),
    width: 980,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    center: true,
    resizable: true,
    focus: true,
  });
  await waitForWindowCreated(created);
  await focusWindow(created);

  // The initial payload is also embedded in the URL for first-boot reliability.
  try {
    await emitTo(LOG_WINDOW_LABEL, LOG_WINDOW_NAVIGATE_EVENT, normalized);
  } catch {
    // The window reads the payload from the URL on first load.
  }

  return true;
}
