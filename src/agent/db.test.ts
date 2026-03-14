import { describe, expect, it } from "vitest";
import {
  mergeProviderCachedModels,
  normalizeProviderCachedModels,
} from "./db";

describe("provider cached models", () => {
  it("normalizes persisted numeric metadata", () => {
    const models = normalizeProviderCachedModels([
      {
        id: "meta/llama-3.3-70b",
        cost: { input: "0.15", output: 0.6 },
        limit: { context: "131072" },
      },
    ]);

    expect(models).toEqual([
      {
        id: "meta/llama-3.3-70b",
        cost: { input: 0.15, output: 0.6 },
        limit: { context: 131072 },
      },
    ]);
  });

  it("preserves custom metadata when refreshing loaded models", () => {
    const merged = mergeProviderCachedModels(
      [
        {
          id: "meta/llama-3.3-70b",
          cost: { input: 0.15, output: 0.6 },
          limit: { context: 131072 },
        },
      ],
      [
        { id: "meta/llama-3.3-70b", owned_by: "openai-compatible" },
        { id: "qwen/qwen-2.5-coder", owned_by: "openai-compatible" },
      ],
    );

    expect(merged).toEqual([
      {
        id: "meta/llama-3.3-70b",
        owned_by: "openai-compatible",
        cost: { input: 0.15, output: 0.6 },
        limit: { context: 131072 },
      },
      {
        id: "qwen/qwen-2.5-coder",
        owned_by: "openai-compatible",
      },
    ]);
  });
});
