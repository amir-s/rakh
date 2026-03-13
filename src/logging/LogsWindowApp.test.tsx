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

const clipboardMock = vi.hoisted(() => ({
  writeText: vi.fn<() => Promise<void>>(),
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
    clipboardMock.writeText.mockReset();
    clipboardMock.writeText.mockResolvedValue(undefined);
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
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardMock.writeText },
    });
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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

  it("renders inline filters and ignores time filters", async () => {
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
    expect(
      screen.getByRole("button", { name: "Tag filter frontend: ignored" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: /Cycle verbosity/ })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Add trace id filter" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Add tool correlation id filter" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Row limit 100" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Source filter backend" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: "Source filter frontend" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      container.querySelector('input[type="datetime-local"]'),
    ).toBeNull();
  });

  it("adds and removes a trace id filter inline", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: { limit: 100 },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add trace id filter" }));
    expect(screen.getByRole("dialog", { name: "Trace ID filter input" })).not.toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Trace ID" }), {
      target: { value: "trace-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ADD" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        traceId: "trace-1",
        limit: 100,
      });
    });

    expect(screen.getByText("trace: trace-1")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove trace id filter" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        limit: 100,
      });
    });
    expect(screen.getByRole("button", { name: "Add trace id filter" })).not.toBeNull();
  });

  it("adds and removes a tool correlation id filter inline", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([
      makeEntry({
        id: "tool-filter-entry",
        correlationId: "tool-1",
        message: "Tool filtered row",
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

    fireEvent.click(screen.getByRole("button", { name: "Add tool correlation id filter" }));
    expect(
      screen.getByRole("dialog", { name: "Tool Correlation ID filter input" }),
    ).not.toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Tool Correlation ID" }), {
      target: { value: "tool-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ADD" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        correlationId: "tool-1",
        limit: 100,
      });
    });

    expect(screen.getByText("tool: tool-1")).not.toBeNull();
    await waitFor(() => {
      expect(
        screen
          .getAllByText("tool: tool-1")
          .some((element) => element.className.includes("border-dashed")),
      ).toBe(true);
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove tool correlation id filter" }),
    );

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        limit: 100,
      });
    });
    expect(
      screen.getByRole("button", { name: "Add tool correlation id filter" }),
    ).not.toBeNull();
  });

  it("updates the row limit from the inline picker", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: { limit: 100 },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Row limit 100" }));
    expect(screen.getByRole("dialog", { name: "Row limit options" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set row limit 500" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        limit: 500,
      });
    });
    expect(screen.getByRole("button", { name: "Row limit 500" })).not.toBeNull();
  });

  it("auto closes regular toasts, keeps export toasts until dismissed, and replaces older notices", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-01-01T12:00:00.000Z"));
      render(
        <LogsWindowApp
          initialPayload={{
            origin: "manual",
            filter: { limit: 100 },
          }}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "CLEAR" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        sinceMs: Date.now(),
        limit: 100,
      });
      expect(
        screen.getByText("Cleared current view. Only new logs will appear."),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Remove clear timestamp filter" }),
      ).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3600);
      });
      expect(
        screen.queryByText("Cleared current view. Only new logs will appear."),
      ).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "EXPORT" }));
        await Promise.resolve();
      });

      expect(
        screen.getByText("Exported 2 log entries to /tmp/rakh-logs.json"),
      ).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(
        screen.getByText("Exported 2 log entries to /tmp/rakh-logs.json"),
      ).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "CLEAR" }));
      expect(
        screen.queryByText("Exported 2 log entries to /tmp/rakh-logs.json"),
      ).toBeNull();
      expect(
        screen.getByText("Cleared current view. Only new logs will appear."),
      ).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
      expect(
        screen.queryByText("Cleared current view. Only new logs will appear."),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it("toggles source pills between backend, frontend, and both", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: { limit: 100 },
        }}
      />,
    );

    const backendButton = screen.getByRole("button", { name: "Source filter backend" });
    const frontendButton = screen.getByRole("button", { name: "Source filter frontend" });

    fireEvent.click(backendButton);

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        source: "backend",
        limit: 100,
      });
    });
    expect(backendButton.getAttribute("aria-pressed")).toBe("true");
    expect(frontendButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(frontendButton);

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        source: "frontend",
        limit: 100,
      });
    });
    expect(backendButton.getAttribute("aria-pressed")).toBe("false");
    expect(frontendButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(frontendButton);

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        limit: 100,
      });
    });
    expect(backendButton.getAttribute("aria-pressed")).toBe("false");
    expect(frontendButton.getAttribute("aria-pressed")).toBe("false");
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

  it("lets trace id row chips add a trace filter", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([
      makeEntry({
        id: "trace-chip-entry",
        traceId: "trace-1",
        message: "Trace chip row",
        data: { ok: true },
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

    await screen.findByText("Trace chip row");

    fireEvent.click(
      screen.getByRole("button", { name: "Add trace filter trace-1" }),
    );

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        traceId: "trace-1",
        limit: 100,
      });
    });
    expect(screen.queryByText("Metadata")).toBeNull();
  });

  it("lets tool id row chips add a tool correlation filter", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([
      makeEntry({
        id: "tool-chip-entry",
        correlationId: "tool-1",
        message: "Tool chip row",
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

    await screen.findByText("Tool chip row");

    fireEvent.click(
      screen.getByRole("button", { name: "Add tool filter tool-1" }),
    );

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        correlationId: "tool-1",
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
    expect(screen.getByLabelText("event").textContent).toBe("•");
    expect(screen.getByLabelText("Level warn").textContent).toBe("W");
    expect(screen.getByLabelText("event").className.includes("h-7")).toBe(true);
    expect(screen.getByLabelText("event").className.includes("w-7")).toBe(true);
    expect(screen.getByLabelText("Level warn").className.includes("h-7")).toBe(true);
    expect(screen.getByLabelText("Level warn").className.includes("w-7")).toBe(true);
    expect(screen.getByText("data_object")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy log row expandable-row JSON" }),
    ).not.toBeNull();
    expect(screen.getByText("content_copy")).not.toBeNull();
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

  it("shows temporary success feedback after copying row JSON", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([
      makeEntry({
        id: "copy-row",
        message: "Copyable log row",
        data: { ok: true },
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

    await screen.findByText("Copyable log row");
    vi.useFakeTimers();

    fireEvent.click(
      screen.getByRole("button", { name: "Copy log row copy-row JSON" }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(clipboardMock.writeText).toHaveBeenCalledTimes(1);
    expect(clipboardMock.writeText).toHaveBeenCalledWith(
      expect.stringContaining('"id": "copy-row"'),
    );
    expect(
      screen.getByRole("button", { name: "Copied log row copy-row JSON" }),
    ).not.toBeNull();
    expect(screen.getByText("check")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(
      screen.getByRole("button", { name: "Copy log row copy-row JSON" }),
    ).not.toBeNull();
    expect(screen.getByText("content_copy")).not.toBeNull();
  });

  it("renders an icon for error kind entries", async () => {
    logsMocks.queryLogsMock.mockResolvedValue([
      makeEntry({
        id: "error-row",
        kind: "error",
        level: "error",
        message: "Error log row",
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

    await screen.findByText("Error log row");
    expect(screen.getByLabelText("error").textContent).toBe("!");
    expect(screen.getByLabelText("Level error").textContent).toBe("E");
    expect(screen.getByLabelText("error").className.includes("h-7")).toBe(true);
    expect(screen.getByLabelText("error").className.includes("w-7")).toBe(true);
    expect(screen.getByLabelText("Level error").className.includes("h-7")).toBe(true);
    expect(screen.getByLabelText("Level error").className.includes("w-7")).toBe(true);
  });

  it("switches to tree mode for trace filters and clears only the current view", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_123_456);
    const traceEntries = [
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
    ];
    logsMocks.queryLogsMock.mockImplementation(async (filter?: { sinceMs?: number }) =>
      typeof filter?.sinceMs === "number" ? [] : traceEntries,
    );

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "assistant-message",
          filter: { traceId: "trace-1", limit: 100 },
        }}
      />,
    );

    await screen.findByText("Root operation");
    expect(screen.getByLabelText("Trace tree view")).not.toBeNull();
    expect(screen.getByText("Child operation")).not.toBeNull();
    expect(
      screen
        .getAllByText("trace: trace-1")
        .some((element) => element.className.includes("border-dashed")),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "EXPORT" }));
    await screen.findByText("Exported 2 log entries to /tmp/rakh-logs.json");

    fireEvent.click(screen.getByRole("button", { name: "CLEAR" }));
    await screen.findByText("Cleared current view. Only new logs will appear.");
    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        traceId: "trace-1",
        sinceMs: 1_700_000_123_456,
        limit: 100,
      });
    });
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

  it("keeps the clear timestamp filter when other filters change", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_123_456);
    logsMocks.queryLogsMock.mockResolvedValue([]);

    render(
      <LogsWindowApp
        initialPayload={{
          origin: "manual",
          filter: { limit: 100 },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "CLEAR" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        sinceMs: 1_700_000_123_456,
        limit: 100,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Source filter backend" }));

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        source: "backend",
        sinceMs: 1_700_000_123_456,
        limit: 100,
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove clear timestamp filter" }),
    );

    await waitFor(() => {
      expect(logsMocks.queryLogsMock).toHaveBeenLastCalledWith({
        source: "backend",
        limit: 100,
      });
    });
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

    await screen.findByRole("button", { name: /TO LIVE/ });
    fireEvent.click(screen.getByRole("button", { name: /TO LIVE/ }));
    await screen.findByText("TAILING");
    expect(screen.queryByRole("button", { name: "JUMP TO LIVE" })).toBeNull();
    expect(scroller.scrollTop).toBe(1000);
  });
});
