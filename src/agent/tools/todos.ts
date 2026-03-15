import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { patchAgentState } from "../atoms";
import type {
  MutationIntent,
  TodoItem,
  TodoOwner,
  ToolErrorCode,
  ToolResult,
} from "../types";

type TodoListItem = Omit<TodoItem, "mutationLog">;

export interface TodoRuntimeContext {
  currentTurn: number;
  agentId: string;
}

export interface TodoChangeEvent {
  sessionId: string;
  todoId?: string;
  change: string;
  changedAt: number;
}

interface TodoMutationResponse {
  items: TodoItem[];
  item?: TodoItem;
  removed: boolean;
}

export interface TodoAddInput {
  title: string;
}

export interface TodoUpdateInput {
  id: string;
  patch?: Partial<Pick<TodoItem, "title" | "state" | "completionNote">>;
}

export interface TodoListInput {
  status?: TodoItem["state"] | "any";
  limit?: number;
}

export interface TodoRemoveInput {
  id: string;
}

export interface TodoNoteAddInput {
  kind: "learned" | "critical";
  text: string;
  todoId?: string;
}

export interface TodoMutationTrackingInput {
  actor: TodoOwner;
  turn: number;
  tool: string;
  toolCallId: string;
  mutationIntent: MutationIntent;
  paths: string[];
}

export interface TodoContextEnrichmentTodoUpdateInput {
  todoId: string;
  verifyThingsLearnedNoteIds?: string[];
  verifyCriticalInfoNoteIds?: string[];
  appendThingsLearned?: string[];
  appendCriticalInfo?: string[];
  removeDuplicateThingsLearnedNoteIds?: string[];
  removeDuplicateCriticalInfoNoteIds?: string[];
}

export interface TodoContextEnrichmentInput {
  turn: number;
  updates: TodoContextEnrichmentTodoUpdateInput[];
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function parseInvokeError(err: unknown): { code: ToolErrorCode; message: string } {
  const message = String(err);
  const normalized = message.replace(/^Error:\s*/, "");
  if (normalized.startsWith("INVALID_ARGUMENT:")) {
    return { code: "INVALID_ARGUMENT", message };
  }
  if (normalized.startsWith("NOT_FOUND:")) {
    return { code: "NOT_FOUND", message };
  }
  if (normalized.startsWith("CONFLICT:")) {
    return { code: "CONFLICT", message };
  }
  return { code: "INTERNAL", message };
}

function ownerFromAgentId(agentId: string): TodoOwner {
  const trimmed = agentId.trim();
  if (!trimmed || trimmed === "agent_main") return "main";
  if (trimmed.startsWith("agent_")) {
    const owner = trimmed.slice("agent_".length).trim();
    return owner || "main";
  }
  return trimmed;
}

function syncTodos(tabId: string, items: TodoItem[]): void {
  patchAgentState(tabId, { todos: items });
}

export async function loadSessionTodos(sessionId: string): Promise<TodoItem[]> {
  if (!sessionId.trim() || !isTauriRuntime()) return [];
  try {
    return await invoke<TodoItem[]>("todo_store_load", { sessionId });
  } catch {
    return [];
  }
}

export async function getSessionTodoPath(sessionId: string): Promise<string | null> {
  if (!sessionId.trim() || !isTauriRuntime()) return null;
  try {
    return await invoke<string>("todo_store_get_path", { sessionId });
  } catch {
    return null;
  }
}

export async function listenForTodoChanges(
  sessionId: string,
  onChange: (event: TodoChangeEvent) => void,
): Promise<UnlistenFn | null> {
  if (!sessionId.trim() || !isTauriRuntime()) return null;
  try {
    return await listen<TodoChangeEvent>("todo_changed", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      onChange(event.payload);
    });
  } catch {
    return null;
  }
}

export async function todoAdd(
  tabId: string,
  runtime: TodoRuntimeContext,
  input: TodoAddInput,
): Promise<ToolResult<{ item: TodoItem }>> {
  try {
    const response = await invoke<TodoMutationResponse>("todo_store_add", {
      sessionId: tabId,
      input: {
        title: input.title,
        owner: ownerFromAgentId(runtime.agentId),
        turn: runtime.currentTurn,
      },
    });
    syncTodos(tabId, response.items);
    return response.item
      ? { ok: true, data: { item: response.item } }
      : { ok: false, error: { code: "INTERNAL", message: "Todo add returned no item" } };
  } catch (err) {
    return { ok: false, error: parseInvokeError(err) };
  }
}

export async function todoUpdate(
  tabId: string,
  runtime: TodoRuntimeContext,
  input: TodoUpdateInput,
): Promise<ToolResult<{ item: TodoItem }>> {
  try {
    const response = await invoke<TodoMutationResponse>("todo_store_update", {
      sessionId: tabId,
      input: {
        id: input.id,
        owner: ownerFromAgentId(runtime.agentId),
        turn: runtime.currentTurn,
        patch: {
          ...(input.patch?.title !== undefined ? { title: input.patch.title } : {}),
          ...(input.patch?.state !== undefined ? { state: input.patch.state } : {}),
          ...(input.patch?.completionNote !== undefined
            ? { completionNote: input.patch.completionNote }
            : {}),
        },
      },
    });
    syncTodos(tabId, response.items);
    return response.item
      ? { ok: true, data: { item: response.item } }
      : { ok: false, error: { code: "INTERNAL", message: "Todo update returned no item" } };
  } catch (err) {
    return { ok: false, error: parseInvokeError(err) };
  }
}

export async function todoList(
  tabId: string,
  input: TodoListInput,
): Promise<ToolResult<{ items: TodoListItem[] }>> {
  const items = await loadSessionTodos(tabId);
  syncTodos(tabId, items);
  const status = input.status ?? "any";
  const limit = input.limit ?? 200;
  if (limit <= 0) {
    return {
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "limit must be greater than 0" },
    };
  }
  const filtered =
    status === "any" ? items : items.filter((item) => item.state === status);
  return {
    ok: true,
    data: {
      items: filtered.slice(0, limit).map(({ mutationLog: _mutationLog, ...item }) => item),
    },
  };
}

export async function todoRemove(
  tabId: string,
  input: TodoRemoveInput,
): Promise<ToolResult<{ removed: boolean }>> {
  try {
    const response = await invoke<TodoMutationResponse>("todo_store_remove", {
      sessionId: tabId,
      input,
    });
    syncTodos(tabId, response.items);
    return { ok: true, data: { removed: response.removed } };
  } catch (err) {
    return { ok: false, error: parseInvokeError(err) };
  }
}

export async function todoNoteAdd(
  tabId: string,
  runtime: TodoRuntimeContext,
  input: TodoNoteAddInput,
): Promise<ToolResult<{ item: TodoItem }>> {
  try {
    const response = await invoke<TodoMutationResponse>("todo_store_note_add", {
      sessionId: tabId,
      input: {
        todoId: input.todoId ?? null,
        kind: input.kind,
        text: input.text,
        author: ownerFromAgentId(runtime.agentId),
        turn: runtime.currentTurn,
      },
    });
    syncTodos(tabId, response.items);
    return response.item
      ? { ok: true, data: { item: response.item } }
      : { ok: false, error: { code: "INTERNAL", message: "Todo note returned no item" } };
  } catch (err) {
    return { ok: false, error: parseInvokeError(err) };
  }
}

export async function recordTodoMutation(
  tabId: string,
  input: TodoMutationTrackingInput,
): Promise<ToolResult<{ item: TodoItem }>> {
  try {
    const response = await invoke<TodoMutationResponse>("todo_store_record_mutation", {
      sessionId: tabId,
      input,
    });
    syncTodos(tabId, response.items);
    return response.item
      ? { ok: true, data: { item: response.item } }
      : {
          ok: false,
          error: {
            code: "INTERNAL",
            message: "Todo mutation tracking returned no item",
          },
        };
  } catch (err) {
    return { ok: false, error: parseInvokeError(err) };
  }
}

export function resolveTodoOwner(agentId: string): TodoOwner {
  return ownerFromAgentId(agentId);
}

export async function applyTodoContextEnrichment(
  tabId: string,
  input: TodoContextEnrichmentInput,
): Promise<ToolResult<{ items: TodoItem[] }>> {
  try {
    const response = await invoke<TodoMutationResponse>("todo_store_context_enrich", {
      sessionId: tabId,
      input,
    });
    syncTodos(tabId, response.items);
    return { ok: true, data: { items: response.items } };
  } catch (err) {
    return { ok: false, error: parseInvokeError(err) };
  }
}
