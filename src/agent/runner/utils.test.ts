import { describe, expect, it } from "vitest";

import { serializeError, streamDeltaPart } from "./utils";

describe("runner utils", () => {
  it("serializeError captures nested causes", () => {
    const root = new Error("root-cause");
    const err = new Error("top-level");
    (err as Error & { cause?: unknown }).cause = root;

    const serialized = serializeError(err) as Record<string, unknown>;
    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("top-level");
    expect(serialized.cause).toMatchObject({ message: "root-cause" });
  });

  it("strips special tokens from streamed text deltas", () => {
    expect(
      streamDeltaPart(
        { type: "text-delta", text: "Hello<|channel|> world" },
        "text-delta",
      ),
    ).toBe("Hello world");
  });
});
