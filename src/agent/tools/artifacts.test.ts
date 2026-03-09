// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock, eventHandlers } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  type ArtifactChangeEvent,
  artifactCreate,
  artifactGet,
  artifactList,
  artifactVersion,
  listenForArtifactChanges,
} from "./artifacts";

describe("artifact tools", () => {
  beforeEach(() => {
    invokeMock.mockReset();
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

  it("validates create input before invoking", async () => {
    const res = await artifactCreate(
      "tab-1",
      { runId: "run_1", agentId: "agent_main" },
      {
        kind: "",
        contentFormat: "markdown",
        content: "x",
      },
    );

    expect(res).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns TOO_LARGE when content exceeds max bytes", async () => {
    const res = await artifactCreate(
      "tab-1",
      { runId: "run_1", agentId: "agent_main" },
      {
        kind: "report",
        contentFormat: "text",
        content: "x".repeat(1_000_001),
      },
    );

    expect(res).toMatchObject({
      ok: false,
      error: { code: "TOO_LARGE" },
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("invokes db_artifact_create with runtime context", async () => {
    invokeMock.mockResolvedValueOnce({
      artifactId: "report_deadbeef",
      version: 1,
    });

    const res = await artifactCreate(
      "tab-1",
      { runId: "run_1", agentId: "agent_main" },
      {
        kind: "report",
        contentFormat: "markdown",
        content: "# Report",
      },
    );

    expect(invokeMock).toHaveBeenCalledWith("db_artifact_create", {
      sessionId: "tab-1",
      runId: "run_1",
      agentId: "agent_main",
      input: expect.objectContaining({ kind: "report" }),
    });
    expect(res).toMatchObject({
      ok: true,
      data: { artifact: { version: 1 } },
    });
  });

  it("persists artifactType in framework metadata on create", async () => {
    invokeMock.mockResolvedValueOnce({
      artifactId: "review_1",
      version: 1,
    });

    await artifactCreate(
      "tab-1",
      { runId: "run_1", agentId: "agent_reviewer" },
      {
        artifactType: "review-report",
        kind: "review-report",
        contentFormat: "json",
        content: '{"summary":"ok","findings":[]}',
        metadata: { scope: "src/agent/runner.ts" },
      },
    );

    expect(invokeMock).toHaveBeenCalledWith("db_artifact_create", {
      sessionId: "tab-1",
      runId: "run_1",
      agentId: "agent_reviewer",
      input: expect.objectContaining({
        kind: "review-report",
        metadata: {
          scope: "src/agent/runner.ts",
          __rakh: { artifactType: "review-report" },
        },
      }),
    });
  });

  it("rejects version input when contentFormat is set without content", async () => {
    const res = await artifactVersion(
      "tab-1",
      { runId: "run_1", agentId: "agent_main" },
      {
        artifactId: "report_deadbeef",
        contentFormat: "json",
      },
    );

    expect(res).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("invokes version command without content to reuse latest blob", async () => {
    invokeMock.mockResolvedValueOnce({
      artifactId: "report_deadbeef",
      version: 2,
      blobHash: "abc",
    });

    const res = await artifactVersion(
      "tab-1",
      { runId: "run_1", agentId: "agent_main" },
      {
        artifactId: "report_deadbeef",
        summary: "new summary",
      },
    );

    expect(invokeMock).toHaveBeenCalledWith("db_artifact_version", {
      sessionId: "tab-1",
      runId: "run_1",
      agentId: "agent_main",
      input: {
        artifactId: "report_deadbeef",
        summary: "new summary",
      },
    });
    expect(res).toMatchObject({
      ok: true,
      data: { artifact: { version: 2 } },
    });
  });

  it("preserves prior framework metadata when versioning without content", async () => {
    invokeMock
      .mockResolvedValueOnce({
        artifactId: "review_1",
        version: 1,
        metadata: {
          scope: "src/agent/runner.ts",
          __rakh: {
            artifactType: "review-report",
            validatorId: "reviewer.review-report",
          },
        },
      })
      .mockResolvedValueOnce({
        artifactId: "review_1",
        version: 2,
        metadata: {
          scope: "src/agent/runner.ts",
          __rakh: {
            artifactType: "review-report",
            validatorId: "reviewer.review-report",
          },
        },
      });

    await artifactVersion(
      "tab-1",
      { runId: "run_1", agentId: "agent_reviewer" },
      {
        artifactId: "review_1",
        artifactType: "review-report",
        summary: "same content",
      },
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "db_artifact_get", {
      sessionId: "tab-1",
      artifactId: "review_1",
      version: null,
      includeContent: false,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "db_artifact_version", {
      sessionId: "tab-1",
      runId: "run_1",
      agentId: "agent_reviewer",
      input: {
        artifactId: "review_1",
        summary: "same content",
        metadata: {
          scope: "src/agent/runner.ts",
          __rakh: {
            artifactType: "review-report",
            validatorId: "reviewer.review-report",
          },
        },
      },
    });
  });

  it("invokes get and list commands", async () => {
    invokeMock
      .mockResolvedValueOnce({ artifactId: "a1", version: 2 })
      .mockResolvedValueOnce([{ artifactId: "a1", version: 2 }]);

    const got = await artifactGet("tab-1", { artifactId: "a1" });
    const listed = await artifactList("tab-1", {});

    expect(invokeMock).toHaveBeenNthCalledWith(1, "db_artifact_get", {
      sessionId: "tab-1",
      artifactId: "a1",
      version: null,
      includeContent: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "db_artifact_list", {
      sessionId: "tab-1",
      input: { latestOnly: true, limit: 200 },
    });
    expect(got).toMatchObject({ ok: true });
    expect(listed).toMatchObject({
      ok: true,
      data: { artifacts: [{ artifactId: "a1", version: 2 }] },
    });
  });

  it("returns validation status when reading a validator-backed artifact", async () => {
    invokeMock.mockResolvedValueOnce({
      artifactId: "review_1",
      version: 1,
      kind: "review-report",
      metadata: {
        __rakh: {
          artifactType: "review-report",
          validatorId: "reviewer.review-report",
        },
      },
      contentFormat: "json",
      content: '{"summary":"ok"}',
    });

    const res = await artifactGet("tab-1", { artifactId: "review_1" });

    expect(res).toMatchObject({
      ok: true,
      data: {
        artifact: {
          artifactId: "review_1",
          validation: {
            status: "failed",
            validatorId: "reviewer.review-report",
          },
        },
      },
    });
  });

  it("rejects empty string contentFormat on create", async () => {
    const res = await artifactCreate(
      "tab-1",
      { runId: "run_1", agentId: "agent_main" },
      {
        kind: "report",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        contentFormat: "" as any,
        content: "hello",
      },
    );
    expect(res).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("generates a unique runId when runtime context is absent", async () => {
    invokeMock.mockResolvedValueOnce({
      artifactId: "report_deadbeef",
      version: 1,
    });

    await artifactCreate("tab-1", undefined, {
      kind: "report",
      contentFormat: "text",
      content: "hello",
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const call = invokeMock.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof call.runId).toBe("string");
    expect((call.runId as string).length).toBeGreaterThan(0);
    // Fallback runId must NOT be the old fixed _0000 suffix
    expect(call.runId).not.toMatch(/_0000$/);
    expect(call.agentId).toBe("agent_main");
  });

  it("maps invoke errors to ToolError codes", async () => {
    invokeMock.mockRejectedValueOnce("NOT_FOUND: artifact a1 not found");
    const res = await artifactGet("tab-1", { artifactId: "a1" });
    expect(res).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "NOT_FOUND: artifact a1 not found",
      },
    });
  });

  it("listens for artifact changes and filters by session", async () => {
    const onChange = vi.fn();
    const unlisten = await listenForArtifactChanges("tab-1", onChange);
    const handler = eventHandlers.get("artifact_changed");

    expect(listenMock).toHaveBeenCalledWith(
      "artifact_changed",
      expect.any(Function),
    );
    expect(handler).toBeTypeOf("function");

    handler?.({
      payload: {
        sessionId: "tab-1",
        artifactId: "plan_deadbeef",
        version: 1,
        kind: "plan",
        runId: "run_1",
        agentId: "agent_main",
        change: "created",
        createdAt: 123,
      } satisfies ArtifactChangeEvent,
    });
    handler?.({
      payload: {
        sessionId: "tab-2",
        artifactId: "plan_deadbeef",
        version: 2,
        kind: "plan",
        runId: "run_2",
        agentId: "agent_main",
        change: "versioned",
        createdAt: 124,
      } satisfies ArtifactChangeEvent,
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "tab-1",
        artifactId: "plan_deadbeef",
        change: "created",
      }),
    );

    await unlisten?.();
    expect(eventHandlers.has("artifact_changed")).toBe(false);
  });
});
