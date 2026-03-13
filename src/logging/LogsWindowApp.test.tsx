// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "./types";

const logsMocks = vi.hoisted(() => ({
  queryLogsMock: vi.fn(),
  listenForLogEntriesMock: vi.fn(),
  exportLogsMock: vi.fn(),
  windowListenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: (...args: unknown[]) => logsMocks.windowListenMock(...args),
  }),
}));

vi.mock("./client", () => ({
  queryLogs: (...args: unknown[]) => logsMocks.queryLogsMock(...args),
  listenForLogEntries: (...args: unknown[]) =>
    logsMocks.listenForLogEntriesMock(...args),
  exportLogs: (...args: unknown[]) => logsMocks.exportLogsMock(...args),
}));

import LogsWindowApp from "./LogsWindowApp";

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  const timestampMs = overrides.timestampMs ?? 1_700_000_000_000;
  return {
    id: overrides.id ?? `entry-${timestampMs}`,
    timestamp: overrides.timestamp ?? new Date(timestampMs).toISOString(),
    timestampMs,
    level: overrides.level ?? "info",
    source: overrides.source ?? "frontend",
    tags: overrides.tags ?? ["test"],
    event: overrides.event ?? "logs.test",
    message: overrides.message ?? "Log message",
    depth: overrides.depth ?? 0,
    kind: overrides.kind ?? "event",
    expandable: overrides.expandable ?? false,
    ...(overrides.traceId ? { traceId: overrides.traceId } : {}),
    ...(overrides.correlationId ? { correlationId: overrides.correlationId } : {}),
    ...(overrides.parentId ? { parentId: overrides.parentId } : {}),
    ...(typeof overrides.durationMs === "number"
      ? { durationMs: overrides.durationMs }
      : {}),
    ...(overrides.data !== undefined ? { data: overrides.data } : {}),
  };
}

describe("LogsWindowApp", () => {
  let liveHandler: ((entry: LogEntry) => void) | null;

  beforeEach(() => {
    cleanup();
    liveHandler = null;
    logsMocks.queryLogsMock.mockReset();
    logsMocks.listenForLogEntriesMock.mockReset();
    logsMocks.exportLogsMock.mockReset();
    logsMocks.windowListenMock.mockReset();
    logsMocks.windowListenMock.mockResolvedValue(() => {});
    logsMocks.queryLogsMock.mockResolvedValue([]);
    logsMocks.listenForLogEntriesMock.mockImplementation(async (handler) => {
      liveHandler = handler as (entry: LogEntry) => void;
      return () => {};
    });
    logsMocks.exportLogsMock.mockResolvedValue({
      path: "/tmp/rakh-logs.json",
      count: 2,
    });
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads history and merges live updates by entry id", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([
      makeEntry({
        id: "shared-entry",
        timestampMs: 10,
        message: "Initial query message",
      }),
    ]);

    render(
      <LogsWindowApp
        initialPayload={{ origin: "manual", filter: { limit: 100 } }}
      />,
    );

    await screen.findByText("Initial query message");

    await act(async () => {
      liveHandler?.(
        makeEntry({
          id: "shared-entry",
          timestampMs: 20,
          message: "Updated live message",
        }),
      );
      liveHandler?.(
        makeEntry({
          id: "live-entry",
          timestampMs: 30,
          message: "Fresh live message",
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    await waitFor(() => {
      expect(screen.getByText("Updated live message")).not.toBeNull();
      expect(screen.getByText("Fresh live message")).not.toBeNull();
    });
    expect(screen.queryByText("Initial query message")).toBeNull();
  });

  it("starts compact, expands filters on demand, and ignores time filters", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([]);

    const { container } = render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: {
            sinceMs: 10,
            untilMs: 20,
            limit: 100,
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenCalledWith({ limit: 100 });
    });

    expect(screen.queryByPlaceholderText("trace id")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Log filters" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "SHOW FILTERS" }));

    expect(screen.getByRole("dialog", { name: "Log filters" })).not.toBeNull();
    expect(screen.getByPlaceholderText("trace id")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Tag filter frontend: ignored" }),
    ).not.toBeNull();
    expect(screen.getByText("Verbosity")).not.toBeNull();
    expect(
      container.querySelector('input[type="datetime-local"]'),
    ).toBeNull();
  });

  it("toggles the filter popover with backquote", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: { limit: 100 },
        }}
      />,
    );

    expect(screen.queryByRole("dialog", { name: "Log filters" })).toBeNull();

    fireEvent.keyDown(window, { key: "`", code: "Backquote" });
    expect(screen.getByRole("dialog", { name: "Log filters" })).not.toBeNull();

    fireEvent.keyDown(window, { key: "`", code: "Backquote" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Log filters" })).toBeNull();
    });
  });

  it("passes excluded tags through to history queries", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: {
            tags: ["agent-loop"],
            excludeTags: ["debug", "system"],
            limit: 250,
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenCalledWith({
        tags: ["agent-loop"],
        excludeTags: ["debug", "system"],
        limit: 250,
      });
    });
  });

  it("cycles tag pills through include, exclude, and ignore", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: { limit: 100 },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "SHOW FILTERS" }));
    fireEvent.click(screen.getByRole("button", { name: "Tag filter agent-loop: ignored" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        tags: ["agent-loop"],
        limit: 100,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Tag filter agent-loop: included" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        excludeTags: ["agent-loop"],
        limit: 100,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Tag filter agent-loop: excluded" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        limit: 100,
      });
    });
  });

  it("maps verbosity selection to level thresholds", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: { limit: 100 },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "SHOW FILTERS" }));
    fireEvent.click(screen.getByRole("button", { name: /Cycle verbosity/ }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        levels: ["error"],
        limit: 100,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /Cycle verbosity/ }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        levels: ["error", "warn"],
        limit: 100,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /Cycle verbosity/ }));
    fireEvent.click(screen.getByRole("button", { name: /Cycle verbosity/ }));
    fireEvent.click(screen.getByRole("button", { name: /Cycle verbosity/ }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        limit: 100,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /Cycle verbosity/ }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        levels: ["error"],
        limit: 100,
      });
    });
  });

  it("lets tag chips add include and exclude filters", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([
      makeEntry({
        id: "tagged-entry",
        message: "Tagged log row",
        tags: ["agent-loop"],
      }),
    ]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: { limit: 100 },
        }}
      />,
    );

    await screen.findByText("Tagged log row");

    fireEvent.click(
      screen.getByRole("button", { name: "Filter options for tag agent-loop" }),
    );
    fireEvent.mouseDown(screen.getByRole("button", { name: "INCLUDE" }));
    fireEvent.click(screen.getByRole("button", { name: "INCLUDE" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        tags: ["agent-loop"],
        limit: 100,
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Filter options for tag agent-loop" }),
    );
    fireEvent.mouseDown(screen.getByRole("button", { name: "EXCLUDE" }));
    fireEvent.click(screen.getByRole("button", { name: "EXCLUDE" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        excludeTags: ["agent-loop"],
        limit: 100,
      });
    });
  });

  it("toggles row details when the summary row is clicked", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([
      makeEntry({
        id: "expandable-row",
        level: "warn",
        message: "Expandable log row",
        data: { status: "ok" },
      }),
    ]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: { limit: 100 },
        }}
      />,
    );

    await screen.findByText("Expandable log row");
    expect(screen.getByLabelText("Level warn").textContent).toBe("W");
    expect(screen.queryByText("Metadata")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand log row expandable-row" }));
    await screen.findByText("Metadata");

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse log row expandable-row" }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Metadata")).toBeNull();
    });
  });

  it("switches to tree mode for trace filters and clears only the current view", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([
      makeEntry({
        id: "child",
        parentId: "root",
        traceId: "trace-1",
        timestampMs: 20,
        depth: 1,
        message: "Child operation",
      }),
      makeEntry({
        id: "root",
        traceId: "trace-1",
        timestampMs: 10,
        depth: 0,
        kind: "start",
        message: "Root operation",
      }),
    ]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "assistant-message",
          filter: { traceId: "trace-1", limit: 100 },
        }}
      />,
    );

    await screen.findByText("Root operation");
    expect(screen.getByText("Grouped by trace lineage")).not.toBeNull();
    expect(screen.getByText("Child operation")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "EXPORT" }));
    await screen.findByText("Exported 2 log entries to /tmp/rakh-logs.json");

    fireEvent.click(screen.getByRole("button", { name: "CLEAR" }));
    await screen.findByText("Cleared current view. Only new logs will appear.");
    expect(screen.queryByText("Root operation")).toBeNull();

    await act(async () => {
      liveHandler?.(
        makeEntry({
          id: "post-clear",
          traceId: "trace-1",
          timestampMs: Date.now() + 1,
          message: "New live log after clear",
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    await screen.findByText("New live log after clear");
  });

  it("pauses tailing when the user scrolls away from live output", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([
      makeEntry({
        id: "entry-1",
        timestampMs: 10,
        message: "Scrollable log row",
      }),
    ]);

    const { container } = render(
      <LogsWindowApp
        initialPayload={{ origin: "manual", filter: { limit: 100 } }}
      />,
    );

    await screen.findByText("Scrollable log row");

    const scroller = container.querySelector('[class*="overflow-y-auto"]');
    if (!(scroller instanceof HTMLDivElement)) {
      throw new Error("Expected the log scroller to be rendered");
    }

    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 100,
    });

    fireEvent.scroll(scroller);

    await screen.findByText("PAUSED");
    fireEvent.click(screen.getByRole("button", { name: "JUMP TO LIVE" }));
    await screen.findByText("TAILING");
    expect(screen.queryByRole("button", { name: "JUMP TO LIVE" })).toBeNull();
    expect(scroller.scrollTop).toBe(1000);
  });
});
