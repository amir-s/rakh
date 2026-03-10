// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Terminal from "./Terminal";

const terminalMocks = vi.hoisted(() => {
  class MockXTerm {
    rows = 24;
    cols = 80;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
  }

  class MockFitAddon {
    fit = vi.fn();
  }

  class MockWebglAddon {}

  return {
    MockFitAddon,
    MockWebglAddon,
    MockXTerm,
    exitHandlers: new Map<string, (event: { payload: unknown }) => void>(),
    invokeMock: vi.fn(),
    outputHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: terminalMocks.invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    if (event.startsWith("pty-exit-")) {
      terminalMocks.exitHandlers.set(event, handler);
    }
    if (event.startsWith("pty-output-")) {
      terminalMocks.outputHandlers.set(event, handler);
    }
    return Promise.resolve(vi.fn());
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: terminalMocks.MockXTerm,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: terminalMocks.MockFitAddon,
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: terminalMocks.MockWebglAddon,
}));

describe("Terminal command execution", () => {
  let spawnCount = 0;

  beforeEach(() => {
    spawnCount = 0;
    terminalMocks.exitHandlers.clear();
    terminalMocks.outputHandlers.clear();
    terminalMocks.invokeMock.mockReset();
    terminalMocks.invokeMock.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "spawn_pty") {
          spawnCount += 1;
          return `session-${spawnCount}`;
        }
        if (command === "write_pty") {
          return undefined;
        }
        if (command === "resize_pty") {
          return undefined;
        }
        throw new Error(`Unexpected invoke ${command} ${JSON.stringify(args ?? {})}`);
      },
    );

    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes requested commands into the active PTY session", async () => {
    const props = {
      isOpen: false,
      onToggle: vi.fn(),
      onToggleArtifacts: vi.fn(),
      activeTabId: "tab-1",
      cwd: "/repo",
      agentTitle: "Agent",
      commandRequest: null,
    } as const;

    const { rerender } = render(<Terminal {...props} />);

    await waitFor(() => {
      expect(terminalMocks.invokeMock).toHaveBeenCalledWith("spawn_pty", {
        cwd: "/repo",
        rows: 24,
        cols: 80,
      });
    });

    rerender(
      <Terminal
        {...props}
        commandRequest={{ id: 1, command: "npm run dev" }}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.invokeMock).toHaveBeenCalledWith("write_pty", {
        sessionId: "session-1",
        data: "npm run dev\r",
      });
    });
  });

  it("restarts an exited shell before running the requested command", async () => {
    const props = {
      isOpen: false,
      onToggle: vi.fn(),
      onToggleArtifacts: vi.fn(),
      activeTabId: "tab-1",
      cwd: "/repo",
      agentTitle: "Agent",
      commandRequest: null,
    } as const;

    const { rerender } = render(<Terminal {...props} />);

    await waitFor(() => {
      expect(terminalMocks.invokeMock).toHaveBeenCalledWith("spawn_pty", {
        cwd: "/repo",
        rows: 24,
        cols: 80,
      });
    });

    terminalMocks.exitHandlers.get("pty-exit-session-1")?.({
      payload: { exitCode: 1 },
    });

    rerender(
      <Terminal
        {...props}
        commandRequest={{ id: 1, command: "npm run lint" }}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.invokeMock).toHaveBeenCalledWith("spawn_pty", {
        cwd: "/repo",
        rows: 24,
        cols: 80,
      });
      expect(terminalMocks.invokeMock).toHaveBeenCalledWith("write_pty", {
        sessionId: "session-2",
        data: "npm run lint\r",
      });
    });
  });
});
