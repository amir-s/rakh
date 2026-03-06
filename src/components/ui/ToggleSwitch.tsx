import { cn } from "@/utils/cn";

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
  disabled?: boolean;
  title?: string;
}

export default function ToggleSwitch({
  checked,
  onChange,
  className,
  disabled = false,
  title,
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      className={cn("ui-toggle", checked && "ui-toggle--on", className)}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      disabled={disabled}
      title={title}
    >
      <span className="ui-toggle-thumb" />
    </button>
  );
}
