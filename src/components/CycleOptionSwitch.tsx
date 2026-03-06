import type { FC } from "react";
import { cn } from "@/utils/cn";

type CycleSwitchValue = string | number | boolean;

export interface CycleOption<T extends CycleSwitchValue> {
  value: T;
  label: string;
}

export interface CycleOptionSwitchProps<T extends CycleSwitchValue> {
  label: string;
  value: T;
  options: ReadonlyArray<CycleOption<T>>;
  onChange: (next: T) => void;
}

export function getNextOptionIndex(
  currentIndex: number,
  optionsLength: number,
): number {
  if (optionsLength <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= optionsLength) return 0;
  return (currentIndex + 1) % optionsLength;
}

export function getThumbPositionClass(
  optionsLength: number,
  index: number,
): string {
  if (optionsLength === 2) {
    return index <= 0 ? "chat-cycle-thumb--left" : "chat-cycle-thumb--right";
  }
  if (optionsLength === 3) {
    if (index <= 0) return "chat-cycle-thumb--left";
    if (index >= 2) return "chat-cycle-thumb--right";
    return "chat-cycle-thumb--center";
  }
  return "chat-cycle-thumb--left";
}

export function CycleOptionSwitch<T extends CycleSwitchValue>({
  label,
  value,
  options,
  onChange,
}: CycleOptionSwitchProps<T>) {
  if (options.length !== 2 && options.length !== 3) {
    return null;
  }

  const index = options.findIndex((opt) => opt.value === value);
  const resolvedIndex = index >= 0 ? index : 0;
  const currentOption = options[resolvedIndex];

  return (
    <button
      type="button"
      className={cn(
        "chat-cycle-switch",
        resolvedIndex > 0 && "chat-cycle-switch--active",
      )}
      onClick={() => {
        const nextIndex = getNextOptionIndex(resolvedIndex, options.length);
        if (nextIndex >= 0) onChange(options[nextIndex].value);
      }}
      aria-label={label}
      data-option-count={options.length}
    >
      <span className="chat-cycle-track">
        <span
          className={cn(
            "chat-cycle-thumb",
            getThumbPositionClass(options.length, resolvedIndex),
          )}
        />
      </span>
      <span className="chat-cycle-label">{label}</span>
      <span className="chat-cycle-popover">
        <strong>{label}</strong>: {currentOption.label}
      </span>
    </button>
  );
}

export default CycleOptionSwitch;
