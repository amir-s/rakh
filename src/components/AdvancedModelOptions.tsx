import { useRef, useEffect, useState, useCallback } from "react";
import { cn } from "@/utils/cn";
import { SegmentedControl } from "@/components/ui";
import type {
  AdvancedModelOptions,
  LatencyCostProfile,
  ReasoningEffort,
  ReasoningVisibility,
} from "@/agent/types";

/* ─────────────────────────────────────────────────────────────────────────────
   AdvancedModelOptionsButton
   - Only renders for openai / anthropic providers
   - Manages its own open/close state and click-outside dismissal
───────────────────────────────────────────────────────────────────────────── */

interface AdvancedModelOptionsButtonProps {
  provider: string | null;
  value: AdvancedModelOptions;
  onChange: (opts: AdvancedModelOptions) => void;
}

export function AdvancedModelOptionsButton({
  provider,
  value,
  onChange,
}: AdvancedModelOptionsButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const showAdvanced = provider === "openai" || provider === "anthropic";

  /* Close when clicking outside */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const update = useCallback(
    (patch: Partial<AdvancedModelOptions>) => onChange({ ...value, ...patch }),
    [value, onChange],
  );

  if (!showAdvanced) return null;

  return (
    <div className="ns-advanced-wrap" ref={wrapRef}>
      <button
        type="button"
        className={cn(
          "ns-advanced-toggle",
          open && "ns-advanced-toggle--open",
        )}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Advanced model options"
      >
        <span className="material-symbols-outlined text-sm ns-advanced-icon">
          tune
        </span>
      </button>

      {open && (
        <div className="ns-advanced-panel">
          {/* Reasoning visibility */}
          <div className="ns-advanced-row">
            <span className="ns-advanced-label">Reasoning visibility</span>
            <SegmentedControl<ReasoningVisibility>
              className="ns-segment-control"
              options={[
                { value: "off", label: "Off" },
                { value: "auto", label: "Auto" },
                { value: "detailed", label: "Detailed" },
              ]}
              value={value.reasoningVisibility}
              onChange={(v) => update({ reasoningVisibility: v })}
            />
          </div>

          {/* Reasoning effort */}
          <div className="ns-advanced-row">
            <span className="ns-advanced-label">Reasoning effort</span>
            <SegmentedControl<ReasoningEffort>
              className="ns-segment-control"
              options={[
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
              value={value.reasoningEffort}
              onChange={(v) => update({ reasoningEffort: v })}
            />
          </div>

          {/* Latency / cost profile */}
          <div className="ns-advanced-row">
            <span className="ns-advanced-label">Latency / cost</span>
            <SegmentedControl<LatencyCostProfile>
              className="ns-segment-control"
              options={[
                { value: "balanced", label: "Balanced" },
                { value: "fast", label: "Fast" },
                ...(provider === "openai"
                  ? [{ value: "cheap" as LatencyCostProfile, label: "Cheap" }]
                  : []),
              ]}
              value={value.latencyCostProfile}
              onChange={(v) => update({ latencyCostProfile: v })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
