import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  invokeMock,
  patchAgentStateMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  patchAgentStateMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../atoms", () => ({
  patchAgentState: (...args: unknown[]) => patchAgentStateMock(...args),
}));

import {
  replaceSessionTodos,
  recordTodoMutation,
  todoAdd,
  todoList,
  todoNoteAdd,
  todoUpdate,
} from "./todos";
import type { TodoItem } from "../types";

function setTauriAvailable(value: boolean): void {
  if (value) {
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: {},
    };
  } else {
    (globalThis as unknown as { window?: unknown }).window = undefined;
  }
}

function makeTodo(id: string, state: TodoItem["state"] = "todo"): TodoItem {
  return {
    id,
    title: `Todo ${id}`,
    state,
    owner: "main",
    createdTurn: 2,
    updatedTurn: 2,
    lastTouchedTurn: 2,
    filesTouched: [],
    thingsLearned: [],
    criticalInfo: [],
    mutationLog: [],
  };
}

describe("tools/todos", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    patchAgentStateMock.mockReset();
    setTauriAvailable(true);
  });

  it("creates todos through the backend store and syncs local state", async () => {
    const created = makeTodo("todo-1");
    invokeMock.mockResolvedValue({
      items: [created],
      item: created,
      removed: false,
    });

    const result = await todoAdd(
      "tab-1",
      { currentTurn: 7, agentId: "agent_main" },
      { title: "Ship todo storage" },
    );

    expect(invokeMock).toHaveBeenCalledWith("todo_store_add", {
      sessionId: "tab-1",
      input: {
        title: "Ship todo storage",
        owner: "main",
        turn: 7,
      },
    });
    expect(patchAgentStateMock).toHaveBeenCalledWith("tab-1", {
      todos: [created],
    });
    expect(result).toEqual({ ok: true, data: { item: created } });
  });

  it("targets explicit todos for notes and forwards subagent ownership for mutations", async () => {
    const updated = makeTodo("todo-2", "doing");
    invokeMock
      .mockResolvedValueOnce({
        items: [updated],
        item: updated,
        removed: false,
      })
      .mockResolvedValueOnce({
        items: [updated],
        item: updated,
        removed: false,
      });

    await todoNoteAdd(
      "tab-2",
      { currentTurn: 11, agentId: "agent_planner" },
      { kind: "critical", text: "Blocked on API shape", todoId: "todo-2" },
    );
    await recordTodoMutation("tab-2", {
      actor: "planner",
      turn: 12,
      tool: "workspace_editFile",
      toolCallId: "tc-2",
      mutationIntent: "fix",
      paths: ["src/agent/types.ts"],
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "todo_store_note_add", {
      sessionId: "tab-2",
      input: {
        todoId: "todo-2",
        kind: "critical",
        text: "Blocked on API shape",
        author: "planner",
        turn: 11,
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "todo_store_record_mutation", {
      sessionId: "tab-2",
      input: {
        actor: "planner",
        turn: 12,
        tool: "workspace_editFile",
        toolCallId: "tc-2",
        mutationIntent: "fix",
        paths: ["src/agent/types.ts"],
      },
    });
  });

  it("filters listed todos client-side after hydrating from the backend store", async () => {
    const todo = makeTodo("todo-3", "todo");
    const done = makeTodo("todo-4", "done");
    invokeMock.mockResolvedValue([todo, done]);

    const result = await todoList("tab-3", { status: "done", limit: 10 });

    expect(invokeMock).toHaveBeenCalledWith("todo_store_load", { sessionId: "tab-3" });
    expect(patchAgentStateMock).toHaveBeenCalledWith("tab-3", {
      todos: [todo, done],
    });
    expect(result).toEqual({
      ok: true,
      data: {
        items: [
          {
            id: "todo-4",
            title: "Todo todo-4",
            state: "done",
            owner: "main",
            createdTurn: 2,
            updatedTurn: 2,
            lastTouchedTurn: 2,
            filesTouched: [],
            thingsLearned: [],
            criticalInfo: [],
          },
        ],
      },
    });
  });

  it("replaces a session todo file and syncs the new list into local state", async () => {
    const todo = makeTodo("todo-5", "doing");
    invokeMock.mockResolvedValue([todo]);

    const result = await replaceSessionTodos("tab-5", [todo]);

    expect(invokeMock).toHaveBeenCalledWith("todo_store_replace", {
      sessionId: "tab-5",
      items: [todo],
    });
    expect(patchAgentStateMock).toHaveBeenCalledWith("tab-5", {
      todos: [todo],
    });
    expect(result).toEqual([todo]);
  });

  it("surfaces backend validation errors from todo updates", async () => {
    invokeMock.mockRejectedValue(
      new Error("INVALID_ARGUMENT: completionNote is required when marking a todo done"),
    );

    const result = await todoUpdate(
      "tab-4",
      { currentTurn: 15, agentId: "agent_main" },
      { id: "todo-4", patch: { state: "done" } },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "Error: INVALID_ARGUMENT: completionNote is required when marking a todo done",
      },
    });
  });

});
