import { cn } from "@/utils/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "xxs" | "xs" | "sm" | "md";
export type BadgeVariant =
  | "primary"
  | "success"
  | "warning"
  | "info"
  | "danger"
  | "muted";
export type StatusDotVariant =
  | "idle"
  | "thinking"
  | "working"
  | "done"
  | "error";
export type PanelVariant = "default" | "inset" | "elevated";

export function buttonVariantClass(variant: ButtonVariant): string {
  return `ui-btn--${variant}`;
}

export function buttonSizeClass(size: ButtonSize): string {
  return `ui-btn--${size}`;
}

export function badgeVariantClass(variant: BadgeVariant): string {
  return `ui-badge--${variant}`;
}

export function statusDotVariantClass(status: StatusDotVariant): string {
  return `ui-status-dot--${status}`;
}

export function panelVariantClass(variant: PanelVariant): string {
  if (variant === "default") return "";
  return `ui-panel--${variant}`;
}

export function buttonClasses(params?: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}): string {
  const variant = params?.variant ?? "primary";
  const size = params?.size ?? "sm";
  return cn(
    "ui-btn",
    buttonVariantClass(variant),
    buttonSizeClass(size),
    params?.fullWidth && "ui-btn--full",
    params?.className,
  );
}
