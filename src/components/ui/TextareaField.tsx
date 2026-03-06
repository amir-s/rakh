import type { TextareaHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

interface TextareaFieldProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  wrapClassName?: string;
}

export default function TextareaField({
  className,
  wrapClassName,
  ...props
}: TextareaFieldProps) {
  return (
    <div className={cn("ui-field-wrap", wrapClassName)}>
      <textarea className={cn("ui-textarea", className)} {...props} />
    </div>
  );
}
