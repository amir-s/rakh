import { useState } from "react";
import type { TodoItem } from "@/agent/types";
import { getSessionTodoPath } from "@/agent/tools/todos";
import { cn } from "@/utils/cn";
import PaneEmptyState from "./PaneEmptyState";

const CHECK_ICON = (
  <svg
    width={9}
    height={9}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={3}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export default function TodoPane({
  sessionId,
  todos,
}: {
  sessionId: string;
  todos: TodoItem[];
}) {
  const [openingJson, setOpeningJson] = useState(false);
  const doneCount = todos.filter((todo) => todo.state === "done").length;

  const handleOpenJson = async () => {
    if (openingJson) return;
    setOpeningJson(true);
    try {
      const path = await getSessionTodoPath(sessionId);
      if (!path) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_in_editor", { cwd: path });
    } finally {
      setOpeningJson(false);
    }
  };

  if (todos.length === 0) {
    return (
      <div className="artifact-tab-content todo-content">
        <div className="flex items-center justify-between gap-3">
          <div className="plan-section-label">TODO</div>
          <button
            className="artifact-pane-open-json-btn"
            onClick={() => {
              void handleOpenJson();
            }}
            disabled={openingJson}
          >
            {openingJson ? "Opening..." : "Open JSON"}
          </button>
        </div>
        <PaneEmptyState message="No todos yet — the agent will add them as it plans work." />
      </div>
    );
  }

  return (
    <div className="artifact-tab-content todo-content">
      <div className="flex items-center justify-between gap-3">
        <div className="plan-section-label">
          TODO · {doneCount} of {todos.length} complete
        </div>
        <button
          className="artifact-pane-open-json-btn"
          onClick={() => {
            void handleOpenJson();
          }}
          disabled={openingJson}
        >
          {openingJson ? "Opening..." : "Open JSON"}
        </button>
      </div>
      <ul className="todo-list">
        {todos.map((item) => {
          const isDone = item.state === "done";
          const isDoing = item.state === "doing";
          const isBlocked = item.state === "blocked";

          return (
            <li
              key={item.id}
              className={cn("todo-item", isDone && "todo-item--done")}
            >
              <div
                className={cn(
                  "todo-checkbox",
                  isDone && "todo-checkbox--done",
                  isDoing && "border-primary bg-primary-dim",
                  isBlocked &&
                    "border-error bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)]",
                )}
              >
                {isDone && CHECK_ICON}
                {isDoing && (
                  <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                )}
                {isBlocked && (
                  <div className="w-1.75 h-0.5 rounded-sm bg-error" />
                )}
              </div>

              <div>
                <span>{item.title}</span>
                {isDoing && (
                  <div className="text-xxs text-primary mt-0.5">In progress</div>
                )}
                {isBlocked && item.criticalInfo.length > 0 && (
                  <div className="text-xxs text-error mt-0.5">
                    Blocked
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
