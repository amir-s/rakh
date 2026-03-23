import { describe, expect, it } from "vitest";

import {
  applyToolIoReplacements,
  createPendingToolIoReplacement,
  reconstructPendingToolIoReplacements,
  toolContextCompactionThresholdKbToBytes,
  validateToolIoReplacementPayload,
} from "./toolContextCompaction";

describe("toolContextCompaction", () => {
  it("converts invalid threshold values back to the default byte threshold", () => {
    expect(toolContextCompactionThresholdKbToBytes(undefined)).toBe(16 * 1024);
    expect(toolContextCompactionThresholdKbToBytes(0)).toBe(16 * 1024);
    expect(toolContextCompactionThresholdKbToBytes(24)).toBe(24 * 1024);
  });

  it("queues delayed tool IO replacement only when the combined payload is oversized", () => {
    const small = createPendingToolIoReplacement(
      "tc-small",
      "workspace_readFile",
      { path: "src/runner.ts" },
      {
        ok: true,
        data: {
          path: "src/runner.ts",
          content: "small",
          fileSizeBytes: 5,
          lineCount: 1,
          truncated: false,
        },
      },
      { thresholdBytes: 1024 },
    );
    expect(small).toBeNull();

    const largeContent = "x".repeat(17000);
    const pending = createPendingToolIoReplacement(
      "tc-large",
      "workspace_readFile",
      { path: "src/runner.ts" },
      {
        ok: true,
        data: {
          path: "src/runner.ts",
          content: largeContent,
          fileSizeBytes: largeContent.length,
          lineCount: 1,
          truncated: false,
        },
      },
    );

    expect(pending).toMatchObject({
      toolCallId: "tc-large",
      toolName: "workspace_readFile",
    });
    expect((pending?.totalBytes ?? 0) > 16 * 1024).toBe(true);
  });

  it("rewrites assistant/tool history from validated delayed replacement notes", () => {
    const largeContent = "x".repeat(17000);
    const pending = createPendingToolIoReplacement(
      "tc-large",
      "workspace_readFile",
      { path: "src/runner.ts" },
      {
        ok: true,
        data: {
          path: "src/runner.ts",
          content: largeContent,
          fileSizeBytes: largeContent.length,
          lineCount: 1,
          truncated: false,
        },
      },
    );
    expect(pending).not.toBeNull();

    const pendingById = new Map([[pending!.toolCallId, pending!]]);
    const validated = validateToolIoReplacementPayload(
      {
        replacements: [
          {
            toolCallId: "tc-large",
            inputNote: "Read src/runner.ts for context.",
            outputNote: "Loaded a large file; exact contents omitted after one turn.",
          },
        ],
      },
      pendingById,
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const apiMessages = applyToolIoReplacements(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tc-large",
              type: "function",
              function: {
                name: "workspace_readFile",
                arguments: JSON.stringify({ path: "src/runner.ts" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "tc-large",
          content: JSON.stringify({
            ok: true,
            data: {
              path: "src/runner.ts",
              content: largeContent,
              fileSizeBytes: largeContent.length,
              lineCount: 1,
              truncated: false,
            },
          }),
        },
      ],
      validated.replacements,
      pendingById,
    );

    expect(
      JSON.parse(
        String(
          (apiMessages[0] as {
            tool_calls: Array<{ function: { arguments: string } }>;
          }).tool_calls[0]?.function.arguments,
        ),
      ),
    ).toMatchObject({
      __tool_io_compacted: {
        tool: "workspace_readFile",
        side: "input",
        path: "src/runner.ts",
      },
    });

    expect(JSON.parse((apiMessages[1] as { content: string }).content)).toMatchObject({
      __tool_io_compacted: {
        tool: "workspace_readFile",
        side: "output",
        path: "src/runner.ts",
      },
    });
  });

  it("reports why a replacement note is invalid", () => {
    const pending = createPendingToolIoReplacement(
      "tc-large",
      "workspace_readFile",
      { path: "src/runner.ts" },
      {
        ok: true,
        data: {
          path: "src/runner.ts",
          content: "x".repeat(17000),
          fileSizeBytes: 17000,
          lineCount: 1,
          truncated: false,
        },
      },
    );
    expect(pending).not.toBeNull();

    const validated = validateToolIoReplacementPayload(
      {
        replacements: [
          {
            toolCallId: "tc-large",
            inputNote: "Read src/runner.ts for context.",
            outputNote: "x".repeat(351),
          },
        ],
      },
      new Map([[pending!.toolCallId, pending!]]),
    );

    expect(validated).toEqual({
      ok: false,
      message:
        'Replacement "tc-large" outputNote must be at most 350 characters (got 351).',
    });
  });

  it("reconstructs pending replacements from chat tool results when api tool content is plain text", () => {
    const rebuilt = reconstructPendingToolIoReplacements(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tc-search",
              type: "function",
              function: {
                name: "workspace_search",
                arguments: JSON.stringify({ pattern: "updater" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "tc-search",
          content: "Found 1 match(es) in 1 file(s)\n\nsrc/updater.ts\n  1: export function updater() {}",
        },
      ],
      [
        {
          id: "m1",
          role: "assistant",
          content: "",
          timestamp: 1,
          toolCalls: [
            {
              id: "tc-search",
              tool: "workspace_search",
              args: { pattern: "updater" },
              result: {
                matchCount: 1,
                searchedFiles: 1,
                truncated: false,
                matches: [
                  {
                    path: "src/updater.ts",
                    lineNumber: 1,
                    line: "export function updater() {}",
                    contextBefore: [],
                    contextAfter: [],
                  },
                ],
              },
              status: "done",
            },
          ],
        },
      ],
      ["tc-search"],
    );

    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;

    expect(rebuilt.pendingByToolCallId.get("tc-search")).toMatchObject({
      toolCallId: "tc-search",
      toolName: "workspace_search",
      rawArgs: { pattern: "updater" },
    });
  });
});
