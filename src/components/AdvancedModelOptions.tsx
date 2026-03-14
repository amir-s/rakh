import { useRef, useEffect, useState, useCallback } from "react";
import { cn } from "@/utils/cn";
import { SegmentedControl } from "@/components/ui";
import type {
  AdvancedModelOptions,
  LatencyCostProfile,
  ReasoningEffort,
  ReasoningVisibility,
} from "@/agent/types";
import { defaultCommunicationProfileAtom } from "@/agent/atoms";
import { resolveCommunicationProfileId } from "@/agent/communicationProfiles";

/* ─────────────────────────────────────────────────────────────────────────────
   AdvancedModelOptionsButton
   - Manages its own open/close state and click-outside dismissal
   - Allows choosing communication profile & provider-specific advanced options
───────────────────────────────────────────────────────────────────────────── */

import { profilesAtom } from "@/agent/db";
import { useAtomValue } from "jotai";

interface AdvancedModelOptionsButtonProps {
  provider: string | null;
  value: AdvancedModelOptions;
  onChange: (opts: AdvancedModelOptions) => void;
  communicationProfile?: string;
  onCommunicationProfileChange?: (profile: string) => void;
}

export function AdvancedModelOptionsButton({
  provider,
  value,
  onChange,
  communicationProfile,
  onCommunicationProfileChange,
}: AdvancedModelOptionsButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const showAdvanced = provider === "openai" || provider === "anthropic";
  const profiles = useAtomValue(profilesAtom);
  const defaultCommunicationProfile = useAtomValue(
    defaultCommunicationProfileAtom,
  );
  const resolvedCommunicationProfile = resolveCommunicationProfileId(
    communicationProfile,
    profiles,
    defaultCommunicationProfile,
  );

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
          {/* Profile Override */}
          {communicationProfile !== undefined && onCommunicationProfileChange && (
            <div className="ns-advanced-row">
              <span className="ns-advanced-label">Communication Profile</span>
              <select
                className="w-full bg-transparent border border-border-subtle rounded px-2 py-1 text-sm focus:outline-none focus:border-border cursor-pointer appearance-none text-right placeholder-muted pr-6 relative"
                value={resolvedCommunicationProfile ?? ""}
                disabled={profiles.length === 0}
                onChange={(e) => onCommunicationProfileChange(e.target.value)}
                style={{
                  backgroundImage: `url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%239ba1a6%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 0.5rem top 50%",
                  backgroundSize: "0.65rem auto",
                }}
              >
                {profiles.length === 0 ? (
                  <option value="" className="bg-popover text-popover-foreground">
                    No profiles available
                  </option>
                ) : (
                  profiles.map((p) => (
                    <option
                      key={p.id}
                      value={p.id}
                      className="bg-popover text-popover-foreground"
                    >
                      {p.name}
                    </option>
                  ))
                )}
              </select>
            </div>
          )}

          {showAdvanced && (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
