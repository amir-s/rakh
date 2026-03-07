import { beforeEach, describe, expect, it, vi } from "vitest";

type Todo = {
  id: string;
  text: string;
  status: "todo" | "doing" | "done" | "blocked";
  createdAtMs: number;
  updatedAtMs: number;
  blockedReason?: string;
};

type MockState = {
  plan: { markdown: string; updatedAtMs: number; version: number };
  todos: Todo[];
  tabTitle: string;
};

const { states, getAgentStateMock, patchAgentStateMock, applyEditChangesMock } =
  vi.hoisted(() => ({
    states: {} as Record<string, MockState>,
    getAgentStateMock: vi.fn(),
    patchAgentStateMock: vi.fn(),
    applyEditChangesMock: vi.fn(),
  }));

vi.mock("../atoms", () => ({
  getAgentState: (...args: unknown[]) => getAgentStateMock(...args),
  patchAgentState: (...args: unknown[]) => patchAgentStateMock(...args),
}));

vi.mock("./workspace", () => ({
  applyEditChanges: (...args: unknown[]) => applyEditChangesMock(...args),
}));

import {
  buildConversationCard,
  cardAdd,
  planGet,
  planEdit,
  planSet,
  titleGet,
  titleSet,
  todoAdd,
  todoList,
  todoRemove,
  todoUpdate,
} from "./agentControl";

function setState(tabId: string, state?: Partial<MockState>): void {
  states[tabId] = {
    plan: { markdown: "", updatedAtMs: 0, version: 0 },
    todos: [],
    tabTitle: "",
    ...state,
  };
}

describe("agentControl tools", () => {
  beforeEach(() => {
    for (const key of Object.keys(states)) {
      delete states[key];
    }
    getAgentStateMock.mockReset();
    patchAgentStateMock.mockReset();
    applyEditChangesMock.mockReset();

    getAgentStateMock.mockImplementation((tabId: unknown) => states[String(tabId)]);
    patchAgentStateMock.mockImplementation(
      (
        tabId: unknown,
        patch: Partial<MockState> | ((prev: MockState) => MockState),
      ) => {
        const key = String(tabId);
        states[key] =
          typeof patch === "function" ? patch(states[key]) : { ...states[key], ...patch };
      },
    );
  });

  it("planSet stores markdown and increments plan version", () => {
    setState("tab", { plan: { markdown: "old", updatedAtMs: 10, version: 2 } });

    const result = planSet("tab", { markdown: "new plan" });

    expect(result).toMatchObject({
      ok: true,
      data: { plan: { markdown: "new plan", version: 3 } },
    });
    expect(states.tab.plan.markdown).toBe("new plan");
    expect(states.tab.plan.version).toBe(3);
  });

  it("planEdit returns CONFLICT when a change does not apply", () => {
    setState("tab", { plan: { markdown: "# Plan", updatedAtMs: 0, version: 1 } });
    applyEditChangesMock.mockImplementation(() => {
      throw new Error('String not found: "missing"');
    });

    const result = planEdit("tab", { changes: [{ oldString: "missing", newString: "new" }] });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CONFLICT",
        message: 'Error: String not found: "missing"',
      },
    });
  });

  it("planEdit updates plan when all changes apply successfully", () => {
    setState("tab", { plan: { markdown: "# Plan", updatedAtMs: 0, version: 1 } });
    applyEditChangesMock.mockReturnValue("# Updated Plan");

    const result = planEdit("tab", { changes: [{ oldString: "# Plan", newString: "# Updated Plan" }] });

    expect(result).toMatchObject({
      ok: true,
      data: { plan: { markdown: "# Updated Plan", version: 2 } },
    });
    expect(states.tab.plan.markdown).toBe("# Updated Plan");
  });

  it("todoAdd rejects blank text and trims valid input", () => {
    setState("tab");

    const blank = todoAdd("tab", { text: "   " });
    expect(blank).toEqual({
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "text must not be empty" },
    });

    const added = todoAdd("tab", { text: "  write tests  " });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("expected add success");
    expect(added.data.item.text).toBe("write tests");
    expect(states.tab.todos).toHaveLength(1);
  });

  it("todoUpdate validates missing ids and blocked reason rules", () => {
    setState("tab", {
      todos: [
        {
          id: "t1",
          text: "one",
          status: "todo",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    });

    const missing = todoUpdate("tab", { id: "missing", patch: { status: "done" } });
    expect(missing).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Todo missing not found" },
    });

    const blockedWithoutReason = todoUpdate("tab", {
      id: "t1",
      patch: { status: "blocked" },
    });
    expect(blockedWithoutReason).toEqual({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "blockedReason is required when status is 'blocked'",
      },
    });
  });

  it("todoUpdate updates todo fields and todoList filters/limits", () => {
    setState("tab", {
      todos: [
        {
          id: "a",
          text: "A",
          status: "todo",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        {
          id: "b",
          text: "B",
          status: "doing",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    });

    const updated = todoUpdate("tab", {
      id: "b",
      patch: { status: "blocked", blockedReason: "waiting" },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("expected success");
    expect(updated.data.item.status).toBe("blocked");
    expect(updated.data.item.blockedReason).toBe("waiting");

    const blockedOnly = todoList("tab", { status: "blocked" });
    expect(blockedOnly).toMatchObject({
      ok: true,
      data: { items: [{ id: "b", status: "blocked" }] },
    });

    const limited = todoList("tab", { status: "any", limit: 1 });
    expect(limited.ok).toBe(true);
    if (!limited.ok) throw new Error("expected list success");
    expect(limited.data.items).toHaveLength(1);
  });

  it("todoRemove reports removal state", () => {
    setState("tab", {
      todos: [
        {
          id: "a",
          text: "A",
          status: "todo",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    });

    const removed = todoRemove("tab", { id: "a" });
    expect(removed).toEqual({ ok: true, data: { removed: true } });
    expect(states.tab.todos).toHaveLength(0);

    const notRemoved = todoRemove("tab", { id: "missing" });
    expect(notRemoved).toEqual({ ok: true, data: { removed: false } });
  });

  it("titleSet trims title and titleGet returns current value", () => {
    setState("tab", { tabTitle: "" });

    const set = titleSet("tab", { title: "  Fix runner tests  " });
    expect(set).toEqual({ ok: true, data: { title: "Fix runner tests" } });

    const got = titleGet("tab");
    expect(got).toEqual({ ok: true, data: { title: "Fix runner tests" } });
  });

  it("planGet returns stored plan", () => {
    setState("tab", {
      plan: { markdown: "## Plan", updatedAtMs: 123, version: 4 },
    });
    expect(planGet("tab")).toEqual({
      ok: true,
      data: { plan: { markdown: "## Plan", updatedAtMs: 123, version: 4 } },
    });
  });

  it("buildConversationCard validates summary/artifact inputs and returns normalized cards", () => {
    expect(
      buildConversationCard({} as never),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "kind must be 'summary' or 'artifact'",
      },
    });

    expect(
      buildConversationCard({
        kind: "summary",
        markdown: "   ",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "summary markdown must not be empty",
      },
    });

    const summary = buildConversationCard({
      kind: "summary",
      title: "  Review Summary  ",
      markdown: "## Looks good",
    });
    expect(summary.ok).toBe(true);
    if (!summary.ok) throw new Error("expected summary card success");
    expect(summary.data.card).toMatchObject({
      kind: "summary",
      title: "Review Summary",
      markdown: "## Looks good",
    });

    expect(
      buildConversationCard({
        kind: "artifact",
        artifactId: "  ",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "artifactId must not be empty",
      },
    });

    const artifact = buildConversationCard({
      kind: "artifact",
      title: "  Plan Artifact ",
      artifactId: "plan_123",
      version: 2,
    });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) throw new Error("expected artifact card success");
    expect(artifact.data.card).toMatchObject({
      kind: "artifact",
      title: "Plan Artifact",
      artifactId: "plan_123",
      version: 2,
    });
  });

  it("cardAdd returns only the minimal acknowledgement payload", () => {
    setState("tab");

    const result = cardAdd("tab", {
      kind: "summary",
      markdown: "Summary body",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected card add success");
    expect(result.data).toMatchObject({
      kind: "summary",
    });
    expect(Object.keys(result.data)).toEqual(["cardId", "kind"]);
  });
});
