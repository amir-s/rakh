// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactChangeEvent, ArtifactManifest } from "@/agent/tools/artifacts";
import type { ToolResult } from "@/agent/types";

const {
  artifactGetMock,
  artifactListMock,
  eventHandlers,
  listenMock,
} = vi.hoisted(() => ({
  artifactGetMock: vi.fn(),
  artifactListMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@/agent/tools/artifacts", async () => {
  const actual = await vi.importActual<typeof import("@/agent/tools/artifacts")>(
    "@/agent/tools/artifacts",
  );
  return {
    ...actual,
    artifactGet: (...args: unknown[]) => artifactGetMock(...args),
    artifactList: (...args: unknown[]) => artifactListMock(...args),
  };
});

import { useSessionArtifactInventory } from "./useSessionArtifacts";

function makeArtifact(
  artifactId: string,
  version: number,
  createdAt: number,
): ArtifactManifest {
  return {
    sessionId: "tab-1",
    runId: "run_1",
    agentId: "agent_main",
    artifactSeq: 1,
    artifactId,
    version,
    kind: "plan",
    summary: `plan v${version}`,
    metadata: {},
    contentFormat: "markdown",
    blobHash: `blob-${artifactId}-${version}`,
    sizeBytes: 100,
    createdAt,
  };
}

function okResult(
  artifacts: ArtifactManifest[],
): ToolResult<{ artifacts: ArtifactManifest[] }> {
  return {
    ok: true,
    data: { artifacts },
  };
}

function deferredResult() {
  let resolve!: (value: ToolResult<{ artifacts: ArtifactManifest[] }>) => void;
  const promise = new Promise<ToolResult<{ artifacts: ArtifactManifest[] }>>(
    (nextResolve) => {
      resolve = nextResolve;
    },
  );
  return { promise, resolve };
}

function emitArtifactChange(event: ArtifactChangeEvent) {
  act(() => {
    eventHandlers.get("artifact_changed")?.({ payload: event });
  });
}

describe("useSessionArtifactInventory", () => {
  beforeEach(() => {
    artifactGetMock.mockReset();
    artifactListMock.mockReset();
    listenMock.mockReset();
    eventHandlers.clear();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });

    listenMock.mockImplementation(
      async (
        event: string,
        handler: (event: { payload: ArtifactChangeEvent }) => void,
      ) => {
        eventHandlers.set(event, handler as (event: { payload: unknown }) => void);
        return () => {
          eventHandlers.delete(event);
        };
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads once on mount and refreshes only for matching artifact events", async () => {
    artifactListMock
      .mockResolvedValueOnce(okResult([makeArtifact("plan_deadbeef", 1, 100)]))
      .mockResolvedValueOnce(okResult([makeArtifact("plan_deadbeef", 2, 200)]));

    const { result } = renderHook(() => useSessionArtifactInventory("tab-1", true));

    await waitFor(() => {
      expect(result.current.inventory.groups[0]?.latest.version).toBe(1);
    });

    expect(artifactListMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledTimes(1);

    emitArtifactChange({
      sessionId: "tab-2",
      artifactId: "plan_deadbeef",
      version: 2,
      kind: "plan",
      runId: "run_2",
      agentId: "agent_main",
      change: "versioned",
      createdAt: 200,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(artifactListMock).toHaveBeenCalledTimes(1);

    emitArtifactChange({
      sessionId: "tab-1",
      artifactId: "plan_deadbeef",
      version: 2,
      kind: "plan",
      runId: "run_1",
      agentId: "agent_main",
      change: "versioned",
      createdAt: 200,
    });

    await waitFor(() => {
      expect(result.current.inventory.groups[0]?.latest.version).toBe(2);
    });
    expect(artifactListMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces bursty artifact events into one follow-up refresh", async () => {
    const firstRefresh = deferredResult();

    artifactListMock
      .mockResolvedValueOnce(okResult([makeArtifact("plan_deadbeef", 1, 100)]))
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValueOnce(okResult([makeArtifact("plan_deadbeef", 3, 300)]));

    const { result } = renderHook(() => useSessionArtifactInventory("tab-1", true));

    await waitFor(() => {
      expect(result.current.inventory.groups[0]?.latest.version).toBe(1);
    });

    emitArtifactChange({
      sessionId: "tab-1",
      artifactId: "plan_deadbeef",
      version: 2,
      kind: "plan",
      runId: "run_1",
      agentId: "agent_main",
      change: "versioned",
      createdAt: 200,
    });
    emitArtifactChange({
      sessionId: "tab-1",
      artifactId: "plan_deadbeef",
      version: 3,
      kind: "plan",
      runId: "run_1",
      agentId: "agent_main",
      change: "versioned",
      createdAt: 300,
    });

    expect(artifactListMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      firstRefresh.resolve(okResult([makeArtifact("plan_deadbeef", 2, 200)]));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(artifactListMock).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(result.current.inventory.groups[0]?.latest.version).toBe(3);
    });
  });

  it("retries listener registration and does not fall back to polling", async () => {
    vi.useFakeTimers();

    artifactListMock.mockResolvedValue(okResult([makeArtifact("plan_deadbeef", 1, 100)]));
    listenMock
      .mockRejectedValueOnce(new Error("listener unavailable"))
      .mockImplementation(
        async (
          event: string,
          handler: (event: { payload: ArtifactChangeEvent }) => void,
        ) => {
          eventHandlers.set(event, handler as (event: { payload: unknown }) => void);
          return () => {
            eventHandlers.delete(event);
          };
        },
      );

    renderHook(() => useSessionArtifactInventory("tab-1", true));

    await act(async () => {
      await Promise.resolve();
    });

    expect(artifactListMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(listenMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });

    expect(listenMock).toHaveBeenCalledTimes(2);
    expect(artifactListMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
    });

    expect(artifactListMock).toHaveBeenCalledTimes(2);
  });
});
