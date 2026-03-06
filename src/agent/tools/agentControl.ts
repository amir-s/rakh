/**
 * Agent control tools (§3 of tools.md)
 * These are pure in-memory operations that read/write the Jotai agent state.
 * They do not touch the filesystem or shell.
 */
import { getAgentState, patchAgentState } from "../atoms";
import { applyEditChanges } from "./workspace";
import type { EditFileChange } from "./workspace";
import type { AgentPlan, TodoItem, TodoStatus, ToolResult } from "../types";

/* ── helpers ────────────────────────────────────────────────────────────────── */

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ── 3.1 agent.plan.set ─────────────────────────────────────────────────────── */

export interface PlanSetInput {
  markdown: string;
}

export interface PlanSetOutput {
  plan: AgentPlan;
}

export function planSet(
  tabId: string,
  input: PlanSetInput,
): ToolResult<PlanSetOutput> {
  const prev = getAgentState(tabId).plan;
  const plan: AgentPlan = {
    markdown: input.markdown,
    updatedAtMs: Date.now(),
    version: prev.version + 1,
  };
  patchAgentState(tabId, { plan });
  return { ok: true, data: { plan } };
}

/* ── 3.2 agent.plan.edit ────────────────────────────────────────────────────── */

export interface PlanEditInput {
  changes: EditFileChange[];
}

export interface PlanEditOutput {
  plan: AgentPlan;
}

export function planEdit(
  tabId: string,
  input: PlanEditInput,
): ToolResult<PlanEditOutput> {
  const prev = getAgentState(tabId).plan;
  let markdown: string;
  try {
    markdown = applyEditChanges(prev.markdown, input.changes);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "CONFLICT",
        message: String(e),
      },
    };
  }
  const plan: AgentPlan = {
    markdown,
    updatedAtMs: Date.now(),
    version: prev.version + 1,
  };
  patchAgentState(tabId, { plan });
  return { ok: true, data: { plan } };
}

/* ── 3.3 agent.plan.get ─────────────────────────────────────────────────────── */

export interface PlanGetOutput {
  plan: AgentPlan;
}

export function planGet(tabId: string): ToolResult<PlanGetOutput> {
  const { plan } = getAgentState(tabId);
  return { ok: true, data: { plan } };
}

/* ── 3.4 agent.todo.add ─────────────────────────────────────────────────────── */

export interface TodoAddInput {
  text: string;
}

export interface TodoAddOutput {
  item: TodoItem;
}

export function todoAdd(
  tabId: string,
  input: TodoAddInput,
): ToolResult<TodoAddOutput> {
  if (!input.text?.trim()) {
    return {
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "text must not be empty" },
    };
  }
  const now = Date.now();
  const item: TodoItem = {
    id: uid(),
    text: input.text.trim(),
    status: "todo",
    createdAtMs: now,
    updatedAtMs: now,
  };
  patchAgentState(tabId, (prev) => ({ ...prev, todos: [...prev.todos, item] }));
  return { ok: true, data: { item } };
}

/* ── 3.5 agent.todo.update ──────────────────────────────────────────────────── */

export interface TodoUpdateInput {
  id: string;
  patch: Partial<Pick<TodoItem, "text" | "status" | "blockedReason">>;
}

export interface TodoUpdateOutput {
  item: TodoItem;
}

export function todoUpdate(
  tabId: string,
  input: TodoUpdateInput,
): ToolResult<TodoUpdateOutput> {
  const { todos } = getAgentState(tabId);
  const idx = todos.findIndex((t) => t.id === input.id);
  if (idx === -1) {
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: `Todo ${input.id} not found` },
    };
  }

  const newStatus: TodoStatus =
    (input.patch.status as TodoStatus) ?? todos[idx].status;

  if (
    newStatus === "blocked" &&
    !input.patch.blockedReason &&
    !todos[idx].blockedReason
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "blockedReason is required when status is 'blocked'",
      },
    };
  }

  const updated: TodoItem = {
    ...todos[idx],
    ...input.patch,
    status: newStatus,
    updatedAtMs: Date.now(),
  };

  const newTodos = [...todos];
  newTodos[idx] = updated;
  patchAgentState(tabId, { todos: newTodos });
  return { ok: true, data: { item: updated } };
}

/* ── 3.6 agent.todo.list ────────────────────────────────────────────────────── */

export interface TodoListInput {
  status?: TodoStatus | "any";
  limit?: number;
}

export interface TodoListOutput {
  items: TodoItem[];
}

export function todoList(
  tabId: string,
  input: TodoListInput,
): ToolResult<TodoListOutput> {
  let { todos } = getAgentState(tabId);
  const filter = input.status ?? "any";
  if (filter !== "any") {
    todos = todos.filter((t) => t.status === filter);
  }
  const limit = input.limit ?? 200;
  return { ok: true, data: { items: todos.slice(0, limit) } };
}

/* ── 3.7 agent.todo.remove ──────────────────────────────────────────────────── */

export interface TodoRemoveInput {
  id: string;
}

export interface TodoRemoveOutput {
  removed: boolean;
}

export function todoRemove(
  tabId: string,
  input: TodoRemoveInput,
): ToolResult<TodoRemoveOutput> {
  const { todos } = getAgentState(tabId);
  const next = todos.filter((t) => t.id !== input.id);
  const removed = next.length !== todos.length;
  patchAgentState(tabId, { todos: next });
  return { ok: true, data: { removed } };
}

/* ── agent.title.set ──────────────────────────────────────────────────────────────── */

export interface TitleSetInput {
  title: string;
}

export interface TitleSetOutput {
  title: string;
}

export function titleSet(
  tabId: string,
  input: TitleSetInput,
): ToolResult<TitleSetOutput> {
  const title = (input.title ?? "").trim();
  patchAgentState(tabId, { tabTitle: title });
  return { ok: true, data: { title } };
}

/* ── agent.title.get ──────────────────────────────────────────────────────────────── */

export interface TitleGetOutput {
  title: string;
}

export function titleGet(tabId: string): ToolResult<TitleGetOutput> {
  const { tabTitle } = getAgentState(tabId);
  return { ok: true, data: { title: tabTitle } };
}
