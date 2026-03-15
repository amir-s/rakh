import type {
  MutationIntent,
  TodoHandlingInput,
  TodoStatus,
  ToolError,
  TodoItem,
} from "./types";

export const MUTATION_INTENTS = [
  "exploration",
  "implementation",
  "refactor",
  "fix",
  "test",
  "build",
  "docs",
  "setup",
  "cleanup",
  "other",
] as const satisfies MutationIntent[];

const TRACKED_MUTATING_TOOLS = new Set([
  "workspace_writeFile",
  "workspace_editFile",
  "exec_run",
  "git_worktree_init",
]);

export interface ToolMutationPolicy {
  mutationIntent: MutationIntent;
  todoHandling: TodoHandlingInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTouchedPaths(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const normalized = entry.trim().replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/")) return null;
    if (normalized.split("/").includes("..")) return null;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

export function requiresMutationPolicy(toolName: string): boolean {
  return TRACKED_MUTATING_TOOLS.has(toolName);
}

export function getActiveTodo(
  todos: TodoItem[],
): TodoItem | null {
  const active = todos.filter((todo) => todo.state === "doing");
  return active.length === 1 ? active[0] : null;
}

export function parseToolMutationPolicy(
  toolName: string,
  args: Record<string, unknown>,
): { ok: true; data: ToolMutationPolicy } | { ok: false; error: ToolError } | null {
  if (!requiresMutationPolicy(toolName)) return null;

  const rawIntent = typeof args.mutationIntent === "string" ? args.mutationIntent.trim() : "";
  if (!rawIntent) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "mutationIntent is required for mutating tools",
      },
    };
  }
  if (!MUTATION_INTENTS.includes(rawIntent as MutationIntent)) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: `mutationIntent must be one of ${MUTATION_INTENTS.join(", ")}`,
      },
    };
  }

  if (!isRecord(args.todoHandling)) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "todoHandling is required for mutating tools",
      },
    };
  }

  const mode = typeof args.todoHandling.mode === "string"
    ? args.todoHandling.mode.trim()
    : "";
  if (mode !== "track_active" && mode !== "skip") {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "todoHandling.mode must be 'track_active' or 'skip'",
      },
    };
  }

  const skipReason =
    typeof args.todoHandling.skipReason === "string"
      ? args.todoHandling.skipReason.trim()
      : undefined;
  if (mode === "skip" && !skipReason) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "todoHandling.skipReason is required when todoHandling.mode is 'skip'",
      },
    };
  }

  const touchedPaths = validateTouchedPaths(args.todoHandling.touchedPaths);
  if (touchedPaths === null) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message:
          "todoHandling.touchedPaths must be an array of workspace-relative paths without '..'",
      },
    };
  }

  return {
    ok: true,
    data: {
      mutationIntent: rawIntent as MutationIntent,
      todoHandling: {
        mode,
        ...(skipReason ? { skipReason } : {}),
        ...(touchedPaths.length > 0 ? { touchedPaths } : {}),
      },
    },
  };
}

export function stripToolMutationPolicyFields(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const strippedArgs = { ...args };
  delete strippedArgs.mutationIntent;
  delete strippedArgs.todoHandling;
  return strippedArgs;
}

export function listDoingTodos(todos: TodoItem[]): TodoItem[] {
  return todos.filter((todo) => todo.state === "doing");
}

export function isTodoState(value: string): value is TodoStatus {
  return value === "todo" || value === "doing" || value === "blocked" || value === "done";
}
