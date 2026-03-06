import type { TodoItem } from "@/agent/types";
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

export default function TodoPane({ todos }: { todos: TodoItem[] }) {
  const doneCount = todos.filter((todo) => todo.status === "done").length;

  if (todos.length === 0) {
    return (
      <PaneEmptyState message="No todos yet — the agent will add them as it plans work." />
    );
  }

  return (
    <div className="artifact-tab-content todo-content">
      <div className="plan-section-label">
        TODO · {doneCount} of {todos.length} complete
      </div>
      <ul className="todo-list">
        {todos.map((item) => {
          const isDone = item.status === "done";
          const isDoing = item.status === "doing";
          const isBlocked = item.status === "blocked";

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
                <span>{item.text}</span>
                {isDoing && (
                  <div className="text-xxs text-primary mt-0.5">In progress</div>
                )}
                {isBlocked && item.blockedReason && (
                  <div className="text-xxs text-error mt-0.5">
                    Blocked: {item.blockedReason}
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
