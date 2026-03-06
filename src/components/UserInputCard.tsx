import { useState } from "react";
import type { ToolCallDisplay } from "@/agent/types";
import { resolveUserInput, cancelUserInput } from "@/agent/approvals";
import { Button, TextField } from "@/components/ui";

/* ─────────────────────────────────────────────────────────────────────────────
   UserInputCard — rendered when a user_input tool call is in
   "awaiting_approval" state. Shows the question, optional suggestion buttons,
   a free-text input, and a Skip button.
───────────────────────────────────────────────────────────────────────────── */

interface UserInputCardProps {
  toolCall: ToolCallDisplay;
}

export default function UserInputCard({ toolCall }: UserInputCardProps) {
  const { id, args } = toolCall;
  const question =
    typeof args.question === "string"
      ? args.question
      : "The agent needs more information to continue.";
  const options: string[] = Array.isArray(args.options)
    ? (args.options as unknown[]).filter(
        (o): o is string => typeof o === "string",
      )
    : [];

  const [customInput, setCustomInput] = useState("");

  const submit = (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    resolveUserInput(id, trimmed);
  };

  const skip = () => cancelUserInput(id);

  return (
    <div className="msg-card animate-fade-up mt-1.5">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="msg-card-head">
        <div className="msg-card-label">
          <span className="material-symbols-outlined text-base">
            contact_support
          </span>
          QUESTION
        </div>
        <div className="text-xxs text-muted font-mono opacity-60">
          user_input
        </div>
      </div>

      {/* ── Question text ───────────────────────────────────────────────── */}
      <div className="px-3 py-2.5 border-b border-border-subtle">
        <p className="text-sm leading-relaxed">{question}</p>
      </div>

      {/* ── Suggested options ───────────────────────────────────────────── */}
      {options.length > 0 && (
        <div className="px-3 py-2 border-b border-border-subtle flex flex-col gap-1">
          {options.map((opt) => (
            <Button
              key={opt}
              variant="secondary"
              size="xxs"
              className="w-full justify-start! p-4!"
              onClick={() => submit(opt)}
            >
              {opt}
            </Button>
          ))}
        </div>
      )}

      {/* ── Free-text input ─────────────────────────────────────────────── */}
      <div className="px-3 py-2.5 flex gap-2 items-center border-b border-border-subtle">
        <TextField
          type="text"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(customInput);
          }}
          placeholder="Type your answer…"
          className="bg-inset py-[5px] px-2 text-xs"
          wrapClassName="flex-1 border border-border-mid rounded"
          autoFocus={options.length === 0}
        />
        <Button
          variant="primary"
          size="xxs"
          onClick={() => submit(customInput)}
          disabled={!customInput.trim()}
        >
          SEND
        </Button>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div className="msg-card-footer">
        <Button variant="ghost" size="xxs" onClick={skip}>
          SKIP
        </Button>
      </div>
    </div>
  );
}
