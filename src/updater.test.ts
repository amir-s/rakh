import { beforeEach, describe, expect, it, vi } from "vitest";

type MockDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

type MockUpdate = {
  version: string;
  date?: string;
  body?: string;
  downloadAndInstall: (
    onEvent?: (event: MockDownloadEvent) => void,
  ) => Promise<void>;
  close: () => Promise<void>;
};

const { checkMock, relaunchMock } = vi.hoisted(() => ({
  checkMock: vi.fn<() => Promise<MockUpdate | null>>(),
  relaunchMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => checkMock(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: () => relaunchMock(),
}));

function setTauriAvailable(value: boolean): void {
  if (value) {
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: {},
      location: { search: "" },
    };
  } else {
    (globalThis as unknown as { window?: unknown }).window = undefined;
  }
}

function createUpdate(options?: {
  version?: string;
  date?: string;
  body?: string;
  downloadAndInstallImpl?: (
    onEvent?: (event: MockDownloadEvent) => void,
  ) => Promise<void>;
}): MockUpdate {
  const close = vi.fn(async () => undefined);
  const downloadAndInstall = vi.fn(
    async (onEvent?: (event: MockDownloadEvent) => void) => {
      if (options?.downloadAndInstallImpl) {
        await options.downloadAndInstallImpl(onEvent);
        return;
      }

      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Finished" });
    },
  );

  return {
    version: options?.version ?? "0.2.1",
    date: options?.date ?? "2026-03-07",
    body: options?.body ?? "Bug fixes and updater support.",
    downloadAndInstall,
    close,
  };
}

async function loadModules() {
  const atoms = await import("./agent/atoms");
  atoms.jotaiStore.set(atoms.appUpdaterStateAtom, {
    ...atoms.defaultAppUpdaterState,
  });

  const updater = await import("./updater");
  return { atoms, updater };
}

describe("updater service", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    checkMock.mockReset();
    relaunchMock.mockReset();
    relaunchMock.mockResolvedValue(undefined);
    setTauriAvailable(false);
  });

  it("is a no-op outside Tauri", async () => {
    const { atoms, updater } = await loadModules();

    const result = await updater.checkForAppUpdates({ silent: true });

    expect(result).toBeNull();
    expect(checkMock).not.toHaveBeenCalled();
    expect(atoms.jotaiStore.get(atoms.appUpdaterStateAtom)).toEqual(
      atoms.defaultAppUpdaterState,
    );
  });

  it("records an up-to-date check when no update is available", async () => {
    setTauriAvailable(true);
    checkMock.mockResolvedValueOnce(null);
    const { atoms, updater } = await loadModules();

    await updater.checkForAppUpdates();

    const state = atoms.jotaiStore.get(atoms.appUpdaterStateAtom);
    expect(state.status).toBe("up-to-date");
    expect(state.availableVersion).toBeNull();
    expect(state.lastCheckedAt).not.toBeNull();
    expect(updater.shouldShowAppUpdateBadge(state)).toBe(false);
    expect(updater.getAppUpdaterStatusLabel(state)).toBe("Up to date");
  });

  it("stores update metadata and enables the settings badge when an update exists", async () => {
    setTauriAvailable(true);
    checkMock.mockResolvedValueOnce(
      createUpdate({
        version: "0.2.1",
        body: "Updater integration is now available.",
      }),
    );
    const { atoms, updater } = await loadModules();

    await updater.checkForAppUpdates();

    const state = atoms.jotaiStore.get(atoms.appUpdaterStateAtom);
    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("0.2.1");
    expect(state.releaseNotes).toContain("Updater integration");
    expect(updater.shouldShowAppUpdateBadge(state)).toBe(true);
    expect(updater.getAppUpdaterStatusVariant(state)).toBe("primary");
  });

  it("downloads, installs, and requests a relaunch", async () => {
    setTauriAvailable(true);
    const update = createUpdate({
      downloadAndInstallImpl: async (onEvent) => {
        onEvent?.({ event: "Started", data: { contentLength: 100 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 25 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 75 } });
        onEvent?.({ event: "Finished" });
      },
    });
    checkMock.mockResolvedValueOnce(update);
    const beforeInstall = vi.fn(async () => undefined);
    const { atoms, updater } = await loadModules();

    await updater.checkForAppUpdates();
    await updater.installAppUpdate({ beforeInstall });

    const state = atoms.jotaiStore.get(atoms.appUpdaterStateAtom);
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(update.close).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("restarting");
    expect(state.availableVersion).toBeNull();
  });

  it("restores the available state when installation fails", async () => {
    setTauriAvailable(true);
    const update = createUpdate({
      downloadAndInstallImpl: async (onEvent) => {
        onEvent?.({ event: "Started", data: { contentLength: 10 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 5 } });
        throw new Error("disk full");
      },
    });
    checkMock.mockResolvedValueOnce(update);
    const { atoms, updater } = await loadModules();

    await updater.checkForAppUpdates();
    await expect(updater.installAppUpdate()).rejects.toThrow("disk full");

    const state = atoms.jotaiStore.get(atoms.appUpdaterStateAtom);
    expect(state.status).toBe("available");
    expect(state.error).toBe("disk full");
    expect(state.availableVersion).toBe("0.2.1");
    expect(relaunchMock).not.toHaveBeenCalled();
  });
});
