import type { SelectHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {}

export default function SelectField({
  className,
  children,
  ...props
}: SelectFieldProps) {
  return (
    <select className={cn("ui-select", className)} {...props}>
      {children}
    </select>
  );
}
