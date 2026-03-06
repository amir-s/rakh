import { describe, expect, it } from "vitest";
import { getExecCommandBadge } from "./compactToolCallStatus";

describe("getExecCommandBadge", () => {
  it("returns success for completed commands with exit code 0", () => {
    expect(
      getExecCommandBadge({
        tool: "exec_run",
        status: "done",
        result: { exitCode: 0 },
      }),
    ).toEqual({
      label: "SUCCESS",
      variant: "success",
      title: "Command exited with code 0",
    });
  });

  it("returns failure for completed commands with non-zero exit codes", () => {
    expect(
      getExecCommandBadge({
        tool: "exec_run",
        status: "done",
        result: { exitCode: 42 },
      }),
    ).toEqual({
      label: "FAILED",
      variant: "danger",
      title: "Command exited with code 42",
    });
  });

  it("returns failure for exec tool errors", () => {
    expect(
      getExecCommandBadge({
        tool: "exec_run",
        status: "error",
        result: { message: "TIMEOUT" },
      }),
    ).toEqual({
      label: "FAILED",
      variant: "danger",
      title: "TIMEOUT",
    });
  });

  it("returns stopped when the command was terminated by the user", () => {
    expect(
      getExecCommandBadge({
        tool: "exec_run",
        status: "done",
        result: { exitCode: 130, terminatedByUser: true },
      }),
    ).toEqual({
      label: "STOPPED",
      variant: "muted",
      title: "Command stopped with exit code 130",
    });
  });

  it("ignores non-exec tools and incomplete exec states", () => {
    expect(
      getExecCommandBadge({
        tool: "workspace_readFile",
        status: "done",
        result: {},
      }),
    ).toBeNull();

    expect(
      getExecCommandBadge({
        tool: "exec_run",
        status: "running",
        result: { exitCode: 0 },
      }),
    ).toBeNull();
  });
});
