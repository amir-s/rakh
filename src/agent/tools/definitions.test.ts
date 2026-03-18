import { describe, expect, it } from "vitest";
import { toJSONSchema, z } from "zod";

import { allowHiddenToolContextCompaction } from "./definitions";

describe("allowHiddenToolContextCompaction", () => {
  it("allows __contextCompaction without allowing arbitrary extra params", () => {
    const schema = allowHiddenToolContextCompaction(
      z.object({
        path: z.string(),
      }),
    );
    const parsed = schema.parse({
      path: "README.md",
      unexpected: true,
    });

    expect(
      schema.safeParse({
        path: "README.md",
        __contextCompaction: {
          outputNote: "File contents omitted from model-facing context.",
          outputMode: "always",
        },
      }).success,
    ).toBe(true);

    expect(parsed).toEqual({ path: "README.md" });

    expect(toJSONSchema(schema, { target: "draft-7" })).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        __contextCompaction: {
          type: "object",
        },
      },
    });
  });

  it("omits __contextCompaction when the feature is disabled", () => {
    const schema = allowHiddenToolContextCompaction(
      z.object({
        path: z.string(),
      }),
      false,
    );
    const parsed = schema.parse({
      path: "README.md",
      __contextCompaction: {
        outputNote: "Should not be accepted when disabled.",
        outputMode: "always",
      },
    });

    expect(parsed).toEqual({ path: "README.md" });

    expect(toJSONSchema(schema, { target: "draft-7" })).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
      },
    });
    expect(
      toJSONSchema(schema, { target: "draft-7" }).properties,
    ).not.toHaveProperty("__contextCompaction");
  });
});
