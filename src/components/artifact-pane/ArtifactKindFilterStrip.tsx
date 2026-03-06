import type { ArtifactFilterOption, ArtifactFilterValue } from "./types";

interface ArtifactKindFilterStripProps {
  options: ArtifactFilterOption[];
  value: ArtifactFilterValue;
  onChange: (next: ArtifactFilterValue) => void;
}

export default function ArtifactKindFilterStrip({
  options,
  value,
  onChange,
}: ArtifactKindFilterStripProps) {
  return (
    <div className="artifact-filter-control" aria-label="Artifact kind filters">
      <div className="artifact-filter-scroll" role="group">
        {options.map((option) => {
          const active = option.value === value;

          return (
            <button
              key={option.value}
              type="button"
              className={`artifact-filter-chip${active ? " artifact-filter-chip--active" : ""}`}
              onClick={() => onChange(option.value)}
              aria-pressed={active}
            >
              <span className="artifact-filter-chip-label">{option.label}</span>
              <span className="artifact-filter-chip-count">{option.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
