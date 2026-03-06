import type { HTMLAttributes } from "react";
import { cn } from "@/utils/cn";
import { panelVariantClass, type PanelVariant } from "./variants";

interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  variant?: PanelVariant;
}

export default function Panel({
  variant = "default",
  className,
  children,
  ...props
}: PanelProps) {
  return (
    <div className={cn("ui-panel", panelVariantClass(variant), className)} {...props}>
      {children}
    </div>
  );
}
