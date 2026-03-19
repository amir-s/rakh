import { describe, expect, it } from "vitest";
import type { ToolCallDisplay } from "@/agent/types";
import { buildCollapsedArgPreview } from "./compactToolCallSummary";

describe("buildCollapsedArgPreview", () => {
  it("summarizes the loop-limit guard outcome for history views", () => {
    const preview = buildCollapsedArgPreview({
      id: "tc-loop-limit",
      tool: "agent_loop_limit_guard",
      args: {
        currentIteration: 41,
        remainingTurns: 10,
        hardLimit: 50,
      },
      result: {
        action: "continue",
      },
      status: "done",
    } as ToolCallDisplay);

    expect(preview).toBe("turn 41 of 50 -> continued");
  });
});
