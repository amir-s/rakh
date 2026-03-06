import type { HTMLAttributes } from "react";
import { cn } from "@/utils/cn";

interface ModalShellProps extends HTMLAttributes<HTMLDivElement> {}

export default function ModalShell({
  className,
  children,
  ...props
}: ModalShellProps) {
  return (
    <div className={cn("ui-modal-shell", className)} {...props}>
      {children}
    </div>
  );
}
