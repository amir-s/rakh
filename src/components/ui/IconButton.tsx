import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/utils/cn";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

export default function IconButton({
  className,
  children,
  ...props
}: IconButtonProps) {
  return (
    <button className={cn("ui-icon-btn", className)} {...props}>
      {children}
    </button>
  );
}
