// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  callMcpTool,
  prepareMcpRun,
  shutdownMcpRun,
} from "./mcp";

describe("agent/mcp", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("passes logContext to MCP backend commands", async () => {
    const logContext = {
      sessionId: "tab-1",
      tabId: "tab-1",
      traceId: "trace:run_1:main",
      correlationId: "tc-mcp",
    };
    invokeMock
      .mockResolvedValueOnce({ tools: [], failures: [] })
      .mockResolvedValueOnce({ content: [], isError: false })
      .mockResolvedValueOnce(undefined);

    await prepareMcpRun("run_1", "/workspace/app", [], logContext);
    await callMcpTool("run_1", "filesystem", "read_file", { path: "README.md" }, logContext);
    await shutdownMcpRun("run_1", logContext);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "mcp_prepare_run", {
      runId: "run_1",
      cwd: "/workspace/app",
      servers: [],
      logContext,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "mcp_call_tool", {
      runId: "run_1",
      serverId: "filesystem",
      toolName: "read_file",
      input: { path: "README.md" },
      logContext,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "mcp_shutdown_run", {
      runId: "run_1",
      logContext,
    });
  });
});
