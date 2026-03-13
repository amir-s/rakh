import { useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

function formatScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  return String(value);
}

function nodeLabel(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value && typeof value === "object") {
    return `Object(${Object.keys(value as Record<string, unknown>).length})`;
  }
  return formatScalar(value);
}

function keyLabel(keyName: string | null, value: unknown): ReactNode {
  if (keyName == null) return nodeLabel(value);
  return (
    <>
      <span className="text-muted">{keyName}</span>
      <span className="text-muted/70">: </span>
      <span>{nodeLabel(value)}</span>
    </>
  );
}

interface LogJsonNodeProps {
  value: unknown;
  keyName?: string;
  depth?: number;
}

function LogJsonNode({
  value,
  keyName,
  depth = 0,
}: LogJsonNodeProps) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isArray = Array.isArray(value);
  const isObject =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
  const isBranch = isArray || isObject;

  if (!isBranch) {
    return (
      <div className="font-mono text-[11px] leading-5 break-all">
        {keyLabel(keyName ?? null, value)}
      </div>
    );
  }

  const entries = isArray
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className="inline-flex items-center gap-1 font-mono text-[11px] leading-5 text-left"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span
          className={cn(
            "material-symbols-outlined text-[14px] leading-none text-muted transition-transform",
            expanded ? "rotate-90" : "rotate-0",
          )}
        >
          chevron_right
        </span>
        {keyLabel(keyName ?? null, value)}
      </button>
      {expanded ? (
        <div className="ml-4 border-l border-border-subtle pl-3 flex flex-col gap-1">
          {entries.map(([childKey, childValue]) => (
            <LogJsonNode
              key={`${depth}:${childKey}`}
              value={childValue}
              keyName={childKey}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function LogJsonTree({ value }: { value: unknown }) {
  return <LogJsonNode value={value} />;
}
