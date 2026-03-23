import { describe, expect, it } from "vitest";
import { toJSONSchema, z } from "zod";

import { buildToolDefinitions } from "./definitions";

describe("buildToolDefinitions", () => {
  it("does not expose hidden tool IO compaction metadata on tool schemas", () => {
    const definitions = buildToolDefinitions();
    const readFileTool = definitions.workspace_readFile as {
      inputSchema: z.ZodTypeAny;
    };

    expect(
      toJSONSchema(readFileTool.inputSchema, { target: "draft-7" }),
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
      },
    });
    expect(
      toJSONSchema(readFileTool.inputSchema, { target: "draft-7" }).properties,
    ).not.toHaveProperty("__contextCompaction");
  });
});
