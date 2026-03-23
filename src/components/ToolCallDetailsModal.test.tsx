// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ToolCallDetailsModal from "./ToolCallDetailsModal";

describe("ToolCallDetailsModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders raw IO and model-facing context handling", () => {
    render(
      <ToolCallDetailsModal
        toolCall={{
          id: "tc-read",
          tool: "workspace_readFile",
          args: { path: "src/agent/runner.ts" },
          result: {
            path: "src/agent/runner.ts",
            content: "export const runner = true;\n",
            fileSizeBytes: 28,
            lineCount: 1,
            truncated: false,
          },
          contextCompaction: {
            request: {
              outputNote:
                "Read src/agent/runner.ts for planning; exact file contents omitted from model history.",
              outputMode: "always",
            },
            input: {
              status: "full",
              reason: "Parameters were shown to the model unchanged.",
            },
            output: {
              status: "compacted",
              note:
                "Read src/agent/runner.ts for planning; exact file contents omitted from model history.",
              mode: "always",
              modelValue: {
                __rti: {
                  t: "workspace_readFile",
                  s: "o",
                  k: {
                    p: "src/agent/runner.ts",
                    fs: 28,
                    lc: 1,
                    tr: 0,
                  },
                  o: {
                    f: ["content"],
                    b: 30,
                  },
                  n: "Read src/agent/runner.ts for planning; exact file contents omitted from model history.",
                },
              },
            },
          },
          status: "done",
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Parameters")).not.toBeNull();
    expect(screen.getByText("Result")).not.toBeNull();
    expect(screen.getByText("Model-Facing Context")).not.toBeNull();
    expect(screen.getByText("Input")).not.toBeNull();
    expect(screen.getByText("Output")).not.toBeNull();
    expect(
      screen.getByText(
        "Parameters were kept full in apiMessages.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Stored in compacted form in apiMessages.",
      ),
    ).not.toBeNull();
    expect(
      screen.getAllByText(
        "Read src/agent/runner.ts for planning; exact file contents omitted from model history.",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      document.querySelector(
        '[data-context-compaction-state="compacted"] .tool-call-icon__flare',
      )?.getAttribute("title"),
    ).toBe("Context compaction compacted the model-facing output.");
    expect(screen.getByText(/__rti/)).not.toBeNull();
    expect(screen.getByText(/export const runner = true/)).not.toBeNull();
  });
});
