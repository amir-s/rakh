import { describe, expect, it } from "vitest";

import { mapApiMessagesToModelMessages, serializeError, streamDeltaPart } from "./utils";

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

  it("adds Anthropic cache breakpoints to the system block and newest messages", () => {
    const mapped = mapApiMessagesToModelMessages(
      [
        { role: "system", content: "system prompt" },
        { role: "user", content: "first user" },
        {
          role: "assistant",
          content: "tool call",
          tool_calls: [
            {
              id: "tool-1",
              type: "function",
              function: { name: "workspace_readFile", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "tool-1",
          content: JSON.stringify({ ok: true, data: { content: "file body" } }),
        },
        { role: "user", content: "second user" },
      ],
      "anthropic",
    );

    expect(mapped).toHaveLength(5);
    expect(mapped[0]?.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(mapped[1]?.providerOptions).toBeUndefined();
    expect(mapped[2]?.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(mapped[3]?.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(mapped[4]?.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("uses the last leading system message as the system cache breakpoint", () => {
    const mapped = mapApiMessagesToModelMessages(
      [
        { role: "system", content: "system part 1" },
        { role: "system", content: "system part 2" },
        { role: "user", content: "question" },
      ],
      "anthropic",
    );

    expect(mapped[0]?.providerOptions).toBeUndefined();
    expect(mapped[1]?.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(mapped[2]?.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("does not add Anthropic cache breakpoints for other providers", () => {
    const mapped = mapApiMessagesToModelMessages(
      [
        { role: "system", content: "system prompt" },
        { role: "user", content: "question" },
      ],
      "openai",
    );

    expect(mapped[0]?.providerOptions).toBeUndefined();
    expect(mapped[1]?.providerOptions).toBeUndefined();
  });
});
