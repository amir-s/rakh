import { useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { cn } from "@/utils/cn";

/* ────────────────────────────────────────────────────────────────────────────────
   AgentMessage — a message bubble from the AI agent.
   Supports normal, badged, streaming (blinking cursor), and collapsible states.
──────────────────────────────────────────────────────────────────────────────── */

interface AgentMessageProps {
  /** Agent display name (default: "Rakh") */
  name?: string;
  /** Material Symbols icon name shown next to the agent label. */
  icon?: string;
  /** Timestamp string, e.g. "10:43 AM" */
  time?: string;
  /** Short status pill, e.g. "WRITING CODE" */
  badge?: string;
  /** Accent color token or CSS color value for the bubble and name */
  accentColor?: string;
  /** When true, applies the streaming left-border accent */
  streaming?: boolean;
  /** Whether to apply the entrance animation (default: true) */
  animated?: boolean;
  /** When true, message body can be toggled open/closed */
  collapsible?: boolean;
  /** Initial collapsed state when collapsible=true (default: false) */
  defaultCollapsed?: boolean;
  /** Optional header actions rendered on the top-right of the bubble */
  actions?: ReactNode;
  children: ReactNode;
}

export default function AgentMessage({
  name = "Rakh",
  icon = "chess_knight",
  time,
  badge,
  accentColor,
  streaming = false,
  animated = true,
  collapsible = false,
  defaultCollapsed = false,
  actions,
  children,
}: AgentMessageProps) {
  const [collapsed, setCollapsed] = useState(collapsible && defaultCollapsed);
  const bodyCollapsed = collapsible && collapsed;
  const style = accentColor
    ? ({ "--msg-agent-color": accentColor } as CSSProperties)
    : undefined;

  const handleCollapsedBubbleClickCapture = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (!bodyCollapsed) return;
    event.preventDefault();
    event.stopPropagation();
    setCollapsed(false);
  };

  const handleCollapsedBubbleKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (!bodyCollapsed) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setCollapsed(false);
    }
  };

  return (
    <div
      className={cn(
        "msg",
        streaming && "msg--stream",
        animated && "animate-fade-up",
        bodyCollapsed && "msg--collapsed-click-target",
      )}
      style={style}
      onClickCapture={handleCollapsedBubbleClickCapture}
      onKeyDown={handleCollapsedBubbleKeyDown}
      role={bodyCollapsed ? "button" : undefined}
      tabIndex={bodyCollapsed ? 0 : undefined}
      aria-expanded={collapsible ? !collapsed : undefined}
      aria-label={bodyCollapsed ? `Expand ${name} message` : undefined}
    >
      <div className="msg-header">
        <span className="msg-role msg-role--agent">
          <span className="material-symbols-outlined msg-role-icon">
            {icon}
          </span>
          <span>{name}</span>
        </span>
        {time && <span className="msg-time">{time}</span>}
        {badge && !collapsed && <span className="msg-badge">{badge}</span>}
        {(actions || collapsible) && (
          <div className="msg-header-actions">
            {actions ? <div className="msg-bubble-actions">{actions}</div> : null}
            {collapsible && (
              <button
                type="button"
                className="msg-collapse-toggle"
                onClick={() => setCollapsed((v) => !v)}
                aria-expanded={!collapsed}
              >
                {collapsed && streaming && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                )}
                <span
                  className={cn(
                    "material-symbols-outlined msg-reasoning-chevron",
                    !collapsed && "msg-reasoning-chevron--open",
                  )}
                >
                  expand_more
                </span>
              </button>
            )}
          </div>
        )}
      </div>
      <div
        className={cn(
          "msg-body-wrap",
          bodyCollapsed && "msg-body-wrap--collapsed",
        )}
      >
        <div
          className={cn(
            "msg-body msg-body--agent",
            bodyCollapsed && "msg-body--collapsed",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
