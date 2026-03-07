import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { BadgeVariant } from "@/components/ui/variants";
import {
  appUpdaterStateAtom,
  defaultAppUpdaterState,
  jotaiStore,
  type AppUpdaterState,
} from "@/agent/atoms";

interface CheckForAppUpdatesOptions {
  silent?: boolean;
}

interface InstallAppUpdateOptions {
  beforeInstall?: () => Promise<void>;
}

let pendingUpdate: Update | null = null;
let activeCheckPromise: Promise<Update | null> | null = null;
let activeInstallPromise: Promise<void> | null = null;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isPreviewMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("preview") === "true";
}

function isUpdaterRuntime(): boolean {
  return isTauriRuntime() && !isPreviewMode();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Unknown updater error.";
}

function truncateReleaseNotes(body?: string): string | null {
  const trimmed = body?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 420) return trimmed;
  return `${trimmed.slice(0, 417).trimEnd()}...`;
}

function patchUpdaterState(
  patch:
    | Partial<AppUpdaterState>
    | ((prev: AppUpdaterState) => AppUpdaterState),
): void {
  const prev = jotaiStore.get(appUpdaterStateAtom);
  jotaiStore.set(
    appUpdaterStateAtom,
    typeof patch === "function" ? patch(prev) : { ...prev, ...patch },
  );
}

async function closePendingUpdate(nextUpdate?: Update | null): Promise<void> {
  if (pendingUpdate && pendingUpdate !== nextUpdate) {
    await pendingUpdate.close().catch(() => undefined);
  }
  pendingUpdate = nextUpdate ?? null;
}

function applyDownloadEvent(progress: DownloadEvent): void {
  if (progress.event === "Started") {
    patchUpdaterState((prev) => ({
      ...prev,
      status: "downloading",
      contentLength: progress.data.contentLength ?? null,
      downloadedBytes: 0,
      error: null,
    }));
    return;
  }

  if (progress.event === "Progress") {
    patchUpdaterState((prev) => ({
      ...prev,
      status: "downloading",
      downloadedBytes: prev.downloadedBytes + progress.data.chunkLength,
    }));
    return;
  }

  patchUpdaterState((prev) => ({
    ...prev,
    status: "installing",
  }));
}

export async function checkForAppUpdates(
  options: CheckForAppUpdatesOptions = {},
): Promise<Update | null> {
  if (!isUpdaterRuntime()) return null;
  if (activeInstallPromise) return null;
  if (activeCheckPromise) return activeCheckPromise;
  const previousState = jotaiStore.get(appUpdaterStateAtom);

  patchUpdaterState((prev) => ({
    ...prev,
    status: "checking",
    error: null,
  }));

  activeCheckPromise = (async () => {
    try {
      const nextUpdate = await check();
      await closePendingUpdate(nextUpdate);

      if (nextUpdate) {
        patchUpdaterState({
          status: "available",
          availableVersion: nextUpdate.version,
          availableDate: nextUpdate.date ?? null,
          releaseNotes: truncateReleaseNotes(nextUpdate.body),
          lastCheckedAt: Date.now(),
          error: null,
          downloadedBytes: 0,
          contentLength: null,
        });
        return nextUpdate;
      }

      patchUpdaterState({
        status: "up-to-date",
        availableVersion: null,
        availableDate: null,
        releaseNotes: null,
        lastCheckedAt: Date.now(),
        error: null,
        downloadedBytes: 0,
        contentLength: null,
      });
      return null;
    } catch (error) {
      const message = toErrorMessage(error);
      console.error("rakh: failed to check for updates", error);

      patchUpdaterState((prev) => {
        if (previousState.availableVersion) {
          return {
            ...previousState,
            status: "available",
            error: message,
            lastCheckedAt: Date.now(),
          };
        }

        if (options.silent) {
          return { ...previousState };
        }

        return {
          ...defaultAppUpdaterState,
          status: "error",
          error: message,
          lastCheckedAt: Date.now(),
        };
      });
      return null;
    } finally {
      activeCheckPromise = null;
    }
  })();

  return activeCheckPromise;
}

export async function installAppUpdate(
  options: InstallAppUpdateOptions = {},
): Promise<void> {
  if (!isUpdaterRuntime()) return;
  if (activeInstallPromise) return activeInstallPromise;
  if (!pendingUpdate) {
    throw new Error("No update is ready to install.");
  }

  const updateToInstall = pendingUpdate;

  activeInstallPromise = (async () => {
    try {
      patchUpdaterState((prev) => ({
        ...prev,
        status: "installing",
        error: null,
        downloadedBytes: 0,
        contentLength: null,
      }));

      if (options.beforeInstall) {
        await options.beforeInstall();
      }

      await updateToInstall.downloadAndInstall(applyDownloadEvent);
      await closePendingUpdate(null);

      patchUpdaterState({
        status: "restarting",
        availableVersion: null,
        availableDate: null,
        releaseNotes: null,
        lastCheckedAt: Date.now(),
        error: null,
        downloadedBytes: 0,
        contentLength: null,
      });

      await relaunch();
    } catch (error) {
      const message = toErrorMessage(error);
      console.error("rakh: failed to install update", error);

      patchUpdaterState((prev) =>
        prev.availableVersion
          ? {
              ...prev,
              status: "available",
              error: message,
            }
          : {
              ...prev,
              status: "error",
              error: message,
            },
      );
      throw error;
    } finally {
      activeInstallPromise = null;
    }
  })();

  return activeInstallPromise;
}

export function shouldShowAppUpdateBadge(state: AppUpdaterState): boolean {
  return state.status === "available";
}

export function getAppUpdaterStatusLabel(state: AppUpdaterState): string {
  switch (state.status) {
    case "checking":
      return "Checking";
    case "available":
      return "Update ready";
    case "up-to-date":
      return "Up to date";
    case "downloading":
      return "Downloading";
    case "installing":
      return "Installing";
    case "restarting":
      return "Restarting";
    case "error":
      return "Issue detected";
    case "idle":
    default:
      return "Not checked";
  }
}

export function getAppUpdaterStatusVariant(
  state: AppUpdaterState,
): BadgeVariant {
  switch (state.status) {
    case "available":
      return "primary";
    case "up-to-date":
      return "success";
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

export function getAppUpdaterProgressValue(
  state: AppUpdaterState,
): number | null {
  if (!state.contentLength || state.contentLength <= 0) return null;
  return Math.min(100, Math.round((state.downloadedBytes / state.contentLength) * 100));
}
