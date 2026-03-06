import type { ReactNode } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   UserMessage — a message bubble from the human operator.
───────────────────────────────────────────────────────────────────────────── */

interface UserMessageProps {
  /** Display name shown in the header (default: "YOU") */
  name?: string;
  children: ReactNode;
}

export default function UserMessage({
  name = "YOU",
  children,
}: UserMessageProps) {
  return (
    <div className="msg animate-fade-up">
      <div className="msg-header">
        <span className="msg-role msg-role--user">{name}</span>
      </div>
      <div className="msg-body">{children}</div>
    </div>
  );
}
