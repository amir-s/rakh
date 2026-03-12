// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  buildFrontendLogEntry,
  listenForLogEntries,
  writeLogEntry,
} from "./client";

describe("logging/client", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("falls back to structured console output outside Tauri", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const entry = buildFrontendLogEntry({
        tags: ["frontend", "system"],
        event: "logging.test",
        message: "console fallback",
      });
      await writeLogEntry(entry);

      expect(invokeMock).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        "[rakh][logging.test]",
        "console fallback",
        expect.objectContaining({
          event: "logging.test",
          message: "console fallback",
          source: "frontend",
        }),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("persists log entries through the Tauri backend when available", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    invokeMock.mockResolvedValueOnce(undefined);

    const entry = buildFrontendLogEntry({
      tags: ["frontend", "messages"],
      event: "logging.persist",
      message: "persist me",
      context: { traceId: "trace:run_1:main", correlationId: "tc-1", depth: 2 },
    });
    await writeLogEntry(entry);

    expect(invokeMock).toHaveBeenCalledWith("logs_write", { entry });
  });

  it("subscribes to live log_entry events in Tauri", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);
    const handler = vi.fn();

    const result = await listenForLogEntries(handler);

    expect(listenMock).toHaveBeenCalledWith(
      "log_entry",
      expect.any(Function),
    );
    expect(result).toBe(unlisten);
  });
});
