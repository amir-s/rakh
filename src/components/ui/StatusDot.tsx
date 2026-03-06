import type { HTMLAttributes } from "react";
import { cn } from "@/utils/cn";
import {
  statusDotVariantClass,
  type StatusDotVariant,
} from "./variants";

interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  status?: StatusDotVariant;
}

export default function StatusDot({
  status = "idle",
  className,
  ...props
}: StatusDotProps) {
  return (
    <span
      className={cn("ui-status-dot", statusDotVariantClass(status), className)}
      aria-label={status}
      {...props}
    />
  );
}
