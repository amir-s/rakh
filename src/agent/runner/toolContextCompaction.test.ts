import { describe, expect, it } from "vitest";

import {
  buildToolContextCompactedInput,
  buildToolContextCompactedOutput,
  prepareToolContextCompaction,
} from "./toolContextCompaction";

describe("toolContextCompaction", () => {
  it("strips hidden metadata and leaves unsupported local tools full", () => {
    const prepared = prepareToolContextCompaction(
      "workspace_stat",
      {
        path: "README.md",
        __contextCompaction: {
          inputNote: "Stat params omitted.",
          outputNote: "Stat output omitted.",
        },
      },
      "local",
    );

    expect(prepared.strippedArgs).toEqual({ path: "README.md" });
    expect(prepared.inputPlan).toBeUndefined();
    expect(prepared.outputPlan).toBeUndefined();

    const input = buildToolContextCompactedInput("workspace_stat", prepared);
    expect(JSON.parse(input.argumentsJson)).toEqual({ path: "README.md" });
    expect(input.display?.input).toMatchObject({
      status: "full",
    });
    expect(input.display?.input?.reason).toContain("not allowlisted");

    const output = buildToolContextCompactedOutput(
      "workspace_stat",
      {
        ok: true,
        data: { exists: true, path: "README.md" },
      },
      prepared,
      JSON.stringify({
        ok: true,
        data: { exists: true, path: "README.md" },
      }),
    );
    expect(JSON.parse(output.content)).toEqual({
      ok: true,
      data: { exists: true, path: "README.md" },
    });
    expect(output.display?.output).toMatchObject({
      status: "full",
    });
    expect(output.display?.output?.reason).toContain("not allowlisted");
  });

  it("ignores compaction requests on synthetic tools", () => {
    const prepared = prepareToolContextCompaction(
      "agent_card_add",
      {
        kind: "summary",
        markdown: "hello",
        __contextCompaction: {
          inputNote: "Card input omitted.",
        },
      },
      "synthetic",
    );

    expect(prepared.strippedArgs).toEqual({
      kind: "summary",
      markdown: "hello",
    });
    expect(prepared.inputPlan).toBeUndefined();
    expect(prepared.warnings).toContain(
      'Ignored __contextCompaction on agent_card_add: only local tools are supported.',
    );

    const input = buildToolContextCompactedInput("agent_card_add", prepared);
    expect(JSON.parse(input.argumentsJson)).toEqual({
      kind: "summary",
      markdown: "hello",
    });
    expect(input.display?.input?.reason).toContain("synthetic tools");
  });

  it("ignores compaction requests on MCP tools", () => {
    const prepared = prepareToolContextCompaction(
      "mcp_filesystem_read_file",
      {
        path: "README.md",
        __contextCompaction: {
          outputNote: "File contents omitted.",
        },
      },
      "mcp",
    );

    expect(prepared.outputPlan).toBeUndefined();
    expect(prepared.warnings).toContain(
      "Ignored __contextCompaction on mcp_filesystem_read_file: only local tools are supported.",
    );

    const output = buildToolContextCompactedOutput(
      "mcp_filesystem_read_file",
      {
        ok: true,
        data: { content: "hello" },
      },
      prepared,
      JSON.stringify({ ok: true, data: { content: "hello" } }),
    );
    expect(JSON.parse(output.content)).toEqual({
      ok: true,
      data: { content: "hello" },
    });
    expect(output.display?.output?.reason).toContain("mcp tools");
  });
});
