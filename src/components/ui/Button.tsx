import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./variants";
import { cn } from "@/utils/cn";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "sm",
    fullWidth = false,
    loading = false,
    leftIcon,
    rightIcon,
    className,
    children,
    disabled,
    ...props
  },
  ref,
) {
  const isDisabled = Boolean(disabled || loading);

  return (
    <button
      ref={ref}
      className={buttonClasses({ variant, size, fullWidth, className })}
      disabled={isDisabled}
      {...props}
    >
      {loading && (
        <span
          className="inline-block h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin"
          aria-hidden="true"
        />
      )}
      {!loading && leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});

export default Button;

export function buttonVariantForStatus(status: "allow" | "deny" | "danger") {
  if (status === "allow") return "primary";
  if (status === "danger") return "danger";
  return "ghost";
}

export function msgButtonClassFromVariant(
  variant: "primary" | "secondary" | "ghost" | "danger",
): string {
  return cn("ui-btn", `ui-btn--${variant}`, "ui-btn--xxs");
}
