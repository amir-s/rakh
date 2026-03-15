import { describe, expect, it } from "vitest";
import {
  getActiveTodo,
  listDoingTodos,
  parseToolMutationPolicy,
  requiresMutationPolicy,
  stripToolMutationPolicyFields,
} from "./mutationPolicy";
import type { TodoItem } from "./types";

function makeTodo(
  id: string,
  state: TodoItem["state"],
): TodoItem {
  return {
    id,
    title: `Todo ${id}`,
    state,
    owner: "main",
    createdTurn: 1,
    updatedTurn: 1,
    lastTouchedTurn: 1,
    filesTouched: [],
    thingsLearned: [],
    criticalInfo: [],
    mutationLog: [],
  };
}

describe("mutationPolicy", () => {
  it("only requires mutation policy for tracked mutating tools", () => {
    expect(requiresMutationPolicy("exec_run")).toBe(true);
    expect(requiresMutationPolicy("workspace_writeFile")).toBe(true);
    expect(requiresMutationPolicy("workspace_readFile")).toBe(false);
  });

  it("rejects missing mutation metadata for mutating tools", () => {
    expect(parseToolMutationPolicy("exec_run", {})).toEqual({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "mutationIntent is required for mutating tools",
      },
    });
  });

  it("requires skipReason when bypassing todo tracking", () => {
    expect(
      parseToolMutationPolicy("exec_run", {
        mutationIntent: "exploration",
        todoHandling: { mode: "skip" },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message:
          "todoHandling.skipReason is required when todoHandling.mode is 'skip'",
      },
    });
  });

  it("rejects invalid touched paths", () => {
    expect(
      parseToolMutationPolicy("git_worktree_init", {
        mutationIntent: "setup",
        todoHandling: {
          mode: "track_active",
          touchedPaths: ["../escape"],
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message:
          "todoHandling.touchedPaths must be an array of workspace-relative paths without '..'",
      },
    });
  });

  it("accepts valid metadata and strips gateway-only fields before dispatch", () => {
    const args = {
      command: "npm",
      args: ["test"],
      mutationIntent: "test",
      todoHandling: {
        mode: "skip",
        skipReason: "Verification run",
        touchedPaths: ["src/agent/runner.ts", "src/agent/runner.ts"],
      },
    };

    expect(parseToolMutationPolicy("exec_run", args)).toEqual({
      ok: true,
      data: {
        mutationIntent: "test",
        todoHandling: {
          mode: "skip",
          skipReason: "Verification run",
          touchedPaths: ["src/agent/runner.ts"],
        },
      },
    });
    expect(stripToolMutationPolicyFields(args)).toEqual({
      command: "npm",
      args: ["test"],
    });
  });

  it("returns the active todo only when exactly one todo is doing", () => {
    const todos = [makeTodo("a", "todo"), makeTodo("b", "doing")];
    expect(listDoingTodos(todos)).toEqual([todos[1]]);
    expect(getActiveTodo(todos)).toEqual(todos[1]);
    expect(getActiveTodo([makeTodo("a", "doing"), makeTodo("b", "doing")])).toBeNull();
  });
});
