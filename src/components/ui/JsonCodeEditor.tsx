import { useMemo } from "react";
import CodeMirror, { type ReactCodeMirrorProps } from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { lintGutter, linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { cn } from "@/utils/cn";

interface JsonCodeEditorProps
  extends Omit<
    ReactCodeMirrorProps,
    "extensions" | "value" | "onChange" | "theme"
  > {
  value: string;
  onChange: (value: string) => void;
  themeMode: "dark" | "light";
  validate?: (value: string) => Diagnostic[];
}

export default function JsonCodeEditor({
  value,
  onChange,
  themeMode,
  validate,
  className,
  minHeight = "260px",
  ...props
}: JsonCodeEditorProps) {
  const extensions = useMemo<Extension[]>(() => {
    const baseExtensions: Extension[] = [
      json(),
      lintGutter(),
      linter(jsonParseLinter()),
    ];

    if (validate) {
      baseExtensions.push(linter((view) => validate(view.state.doc.toString())));
    }

    return baseExtensions;
  }, [validate]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={themeMode}
      extensions={extensions}
      minHeight={minHeight}
      basicSetup
      className={cn("json-code-editor", className)}
      {...props}
    />
  );
}
