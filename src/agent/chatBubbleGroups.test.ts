import { describe, expect, it } from "vitest";
import { groupChatMessagesForBubbles } from "@/agent/chatBubbleGroups";
import type { ChatMessage } from "@/agent/types";

function userMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: "user",
    content,
    timestamp: 1,
  };
}

function assistantMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    timestamp: 1,
  };
}

describe("groupChatMessagesForBubbles", () => {
  it("groups consecutive assistant messages into a single bubble group", () => {
    const groups = groupChatMessagesForBubbles([
      userMessage("u1", "Hi"),
      assistantMessage("a1", "First"),
      assistantMessage("a2", "Second"),
      userMessage("u2", "Next"),
      assistantMessage("a3", "Third"),
    ]);

    expect(groups).toHaveLength(4);
    expect(groups[0]).toMatchObject({ kind: "user", key: "user:u1" });
    expect(groups[1]).toMatchObject({
      kind: "assistant",
      key: "assistant:a1",
    });
    if (groups[1].kind !== "assistant") {
      throw new Error("Expected assistant group");
    }
    expect(groups[1].messages.map((msg) => msg.id)).toEqual(["a1", "a2"]);
    expect(groups[2]).toMatchObject({ kind: "user", key: "user:u2" });
    expect(groups[3]).toMatchObject({
      kind: "assistant",
      key: "assistant:a3",
    });
  });

  it("does not group assistant messages across user boundaries", () => {
    const groups = groupChatMessagesForBubbles([
      assistantMessage("a1", "First"),
      userMessage("u1", "Break"),
      assistantMessage("a2", "Second"),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({
      kind: "assistant",
      key: "assistant:a1",
    });
    expect(groups[1]).toMatchObject({ kind: "user", key: "user:u1" });
    expect(groups[2]).toMatchObject({
      kind: "assistant",
      key: "assistant:a2",
    });
  });

  it("returns an empty list for empty input", () => {
    expect(groupChatMessagesForBubbles([])).toEqual([]);
  });
});
