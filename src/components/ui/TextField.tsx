import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/utils/cn";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  endAdornment?: ReactNode;
  startAdornment?: ReactNode;
  wrapClassName?: string;
}

const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { className, wrapClassName, endAdornment, startAdornment, ...props },
  ref,
) {
  return (
    <div className={cn("ui-field-wrap", wrapClassName)}>
      {startAdornment}
      <input ref={ref} className={cn("ui-input", className)} {...props} />
      {endAdornment}
    </div>
  );
});

export default TextField;
