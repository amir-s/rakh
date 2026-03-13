import { describe, expect, it } from "vitest";
import type { ToolCallDisplay } from "@/agent/types";
import {
  buildToolCallRenderItemsByMessage,
  buildToolCallRenderItems,
  getToolCallRenderKind,
} from "./toolCallRenderItems";

function makeToolCall(
  id: string,
  tool: string,
  status: ToolCallDisplay["status"] = "done",
): ToolCallDisplay {
  return {
    id,
    tool,
    args: {},
    status,
  };
}

function makeMessage(
  id: string,
  overrides: Partial<{
    content: string;
    reasoning: string;
    reasoningStreaming: boolean;
    streaming: boolean;
    traceId: string;
    toolCalls: ToolCallDisplay[];
  }> = {},
) {
  return {
    id,
    ...overrides,
  };
}

describe("toolCallRenderItems", () => {
  it("groups contiguous inline compact tool calls", () => {
    const items = buildToolCallRenderItems(
      [
        makeToolCall("tc-1", "workspace_listDir"),
        makeToolCall("tc-2", "workspace_readFile"),
        makeToolCall("tc-3", "workspace_glob"),
      ],
      true,
    );

    expect(items).toEqual([
      {
        kind: "group",
        toolCalls: [
          expect.objectContaining({ id: "tc-1" }),
          expect.objectContaining({ id: "tc-2" }),
          expect.objectContaining({ id: "tc-3" }),
        ],
      },
    ]);
  });

  it("leaves single inline compact tool calls ungrouped", () => {
    const items = buildToolCallRenderItems(
      [
        makeToolCall("tc-1", "workspace_listDir"),
        makeToolCall("tc-2", "exec_run"),
      ],
      true,
    );

    expect(items).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCall: expect.objectContaining({ id: "tc-1" }),
      }),
      expect.objectContaining({
        kind: "tool",
        toolCall: expect.objectContaining({ id: "tc-2" }),
      }),
    ]);
  });

  it("treats approval rows and user input as hard boundaries", () => {
    const items = buildToolCallRenderItems(
      [
        makeToolCall("tc-1", "workspace_listDir"),
        makeToolCall("tc-2", "workspace_readFile"),
        makeToolCall("tc-3", "exec_run", "running"),
        makeToolCall("tc-4", "workspace_glob"),
        makeToolCall("tc-5", "user_input"),
        makeToolCall("tc-6", "workspace_search"),
        makeToolCall("tc-7", "workspace_stat"),
      ],
      true,
    );

    expect(items.map((item) => item.kind)).toEqual([
      "group",
      "tool",
      "tool",
      "tool",
      "group",
    ]);
    expect(items[0]).toEqual(
      expect.objectContaining({
        kind: "group",
        toolCalls: [
          expect.objectContaining({ id: "tc-1" }),
          expect.objectContaining({ id: "tc-2" }),
        ],
      }),
    );
    expect(items[4]).toEqual(
      expect.objectContaining({
        kind: "group",
        toolCalls: [
          expect.objectContaining({ id: "tc-6" }),
          expect.objectContaining({ id: "tc-7" }),
        ],
      }),
    );
  });

  it("returns individual rows when grouping is disabled", () => {
    const items = buildToolCallRenderItems(
      [
        makeToolCall("tc-1", "workspace_listDir"),
        makeToolCall("tc-2", "workspace_readFile"),
      ],
      false,
    );

    expect(items.every((item) => item.kind === "tool")).toBe(true);
    expect(items).toHaveLength(2);
  });

  it("classifies awaiting user input separately from approval cards", () => {
    expect(getToolCallRenderKind(makeToolCall("tc-1", "user_input", "awaiting_approval"))).toBe(
      "user_input",
    );
    expect(getToolCallRenderKind(makeToolCall("tc-2", "workspace_writeFile", "awaiting_approval"))).toBe(
      "approval",
    );
    expect(getToolCallRenderKind(makeToolCall("tc-3", "workspace_listDir"))).toBe(
      "compact",
    );
  });

  it("groups inline compact tool calls across assistant messages when nothing visible separates them", () => {
    const itemsByMessage = buildToolCallRenderItemsByMessage(
      [
        makeMessage("msg-1", {
          toolCalls: [makeToolCall("tc-1", "workspace_listDir")],
        }),
        makeMessage("msg-2", {
          toolCalls: [makeToolCall("tc-2", "workspace_readFile")],
        }),
      ],
      true,
    );

    expect(itemsByMessage["msg-1"]).toBeUndefined();
    expect(itemsByMessage["msg-2"]).toEqual([
      {
        kind: "group",
        toolCalls: [
          expect.objectContaining({ id: "tc-1" }),
          expect.objectContaining({ id: "tc-2" }),
        ],
      },
    ]);
  });

  it("treats reasoning blocks between assistant messages as hard boundaries", () => {
    const itemsByMessage = buildToolCallRenderItemsByMessage(
      [
        makeMessage("msg-1", {
          toolCalls: [makeToolCall("tc-1", "workspace_listDir")],
        }),
        makeMessage("msg-2", {
          reasoning: "Checking constraints first.",
        }),
        makeMessage("msg-3", {
          toolCalls: [makeToolCall("tc-2", "workspace_readFile")],
        }),
      ],
      true,
    );

    expect(itemsByMessage["msg-1"]).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCall: expect.objectContaining({ id: "tc-1" }),
      }),
    ]);
    expect(itemsByMessage["msg-3"]).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCall: expect.objectContaining({ id: "tc-2" }),
      }),
    ]);
  });

  it("keeps tool calls on their original messages when cross-message grouping is disabled", () => {
    const itemsByMessage = buildToolCallRenderItemsByMessage(
      [
        makeMessage("msg-1", {
          toolCalls: [makeToolCall("tc-1", "workspace_listDir")],
        }),
        makeMessage("msg-2", {
          toolCalls: [makeToolCall("tc-2", "workspace_readFile")],
        }),
      ],
      false,
    );

    expect(itemsByMessage["msg-1"]).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCall: expect.objectContaining({ id: "tc-1" }),
      }),
    ]);
    expect(itemsByMessage["msg-2"]).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCall: expect.objectContaining({ id: "tc-2" }),
      }),
    ]);
  });
});
