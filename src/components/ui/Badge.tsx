import type { HTMLAttributes } from "react";
import { cn } from "@/utils/cn";
import { badgeVariantClass, type BadgeVariant } from "./variants";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export default function Badge({
  variant = "muted",
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span className={cn("ui-badge", badgeVariantClass(variant), className)} {...props}>
      {children}
    </span>
  );
}
