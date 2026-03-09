import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { EditorRefPlugin } from "@lexical/react/LexicalEditorRefPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $createParagraphNode,
  $createRangeSelection,
  $getCharacterOffsets,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from "lexical";
import type { SlashCommandDefinition } from "@/agent/slashCommands";
import {
  filterSlashCommands,
  matchesSlashCommandInput,
} from "@/agent/slashCommands";
import { cn } from "@/utils/cn";

export interface MentionTextareaProps {
  value: string;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onImageDrop?: (files: File[]) => void;
  onImagePathDrop?: (paths: string[]) => void;
  onDragActiveChange?: (active: boolean) => void;
  cwd?: string;
  slashCommands?: SlashCommandDefinition[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  rows?: number;
}

export interface MentionTextareaHandle {
  focus: () => void;
  blur: () => void;
  setSelectionRange: (start: number, end: number) => void;
}

type SelectionRange = {
  start: number;
  end: number;
};

type AutocompleteState = {
  triggerId: "mention" | "slash";
  query: string;
  startPos: number;
  endPos: number;
};

type TriggerDefinition = {
  id: AutocompleteState["triggerId"];
  match: (textBeforeCursor: string) => null | Omit<AutocompleteState, "triggerId" | "endPos">;
};

type AutocompleteOption = {
  key: string;
  title: string;
  description?: string;
  insertText: string;
  slashCommand?: SlashCommandDefinition;
};

type SelectionPoint =
  | {
      key: NodeKey;
      offset: number;
      type: "element";
    }
  | {
      key: NodeKey;
      offset: number;
      type: "text";
    };

type TauriDragPayload = {
  paths: string[];
  position: { x: number; y: number };
};

type Segment = {
  start: number;
  end: number;
  kind: "text" | "linebreak";
  node: LexicalNode;
};

const MAX_RESULTS = 15;
const MAX_HEIGHT_PX = 120;
const EMPTY_SENTINEL = "\u200B";

function toEditorDocumentText(value: string): string {
  return value.length === 0 ? EMPTY_SENTINEL : value;
}

function fromEditorDocumentText(value: string): string {
  return value.replaceAll(EMPTY_SENTINEL, "");
}

function emitSyntheticChange(
  onChange: MentionTextareaProps["onChange"],
  nextValue: string,
) {
  const syntheticEvent = {
    target: { value: nextValue },
    currentTarget: { value: nextValue },
  } as ChangeEvent<HTMLTextAreaElement>;

  onChange(syntheticEvent);
}

function normalizePath(filePath: string, cwd?: string): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const normalizedCwd = cwd?.replaceAll("\\", "/");

  if (!normalizedCwd) {
    return normalizedPath;
  }

  if (normalizedPath === normalizedCwd) {
    return normalizedPath.split("/").filter(Boolean).pop() ?? normalizedPath;
  }

  const prefix = normalizedCwd.endsWith("/") ? normalizedCwd : `${normalizedCwd}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }

  return normalizedPath;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function isImagePath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes("Files");
}

function createParagraphWithText(value: string) {
  const root = $getRoot();
  root.clear();

  const paragraph = $createParagraphNode();
  root.append(paragraph);

  const selection = paragraph.select();
  selection.insertText(toEditorDocumentText(value));
}

function collectSegments(node: LexicalNode, segments: Segment[], cursor: { value: number }) {
  if ($isTextNode(node)) {
    const length = node.getTextContentSize();
    segments.push({
      start: cursor.value,
      end: cursor.value + length,
      kind: "text",
      node,
    });
    cursor.value += length;
    return;
  }

  if ($isLineBreakNode(node)) {
    segments.push({
      start: cursor.value,
      end: cursor.value + 1,
      kind: "linebreak",
      node,
    });
    cursor.value += 1;
    return;
  }

  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      collectSegments(child, segments, cursor);
    }
  }
}

function selectEmptyEditor(root: ElementNode) {
  const firstTextNode = root.getFirstDescendant<LexicalNode>();
  if (
    firstTextNode &&
    $isTextNode(firstTextNode) &&
    firstTextNode.getTextContent() === EMPTY_SENTINEL
  ) {
    $setSelection(firstTextNode.select(1, 1));
    return;
  }

  const firstChild = root.getFirstChild<ElementNode>();
  if (firstChild && $isElementNode(firstChild)) {
    $setSelection(firstChild.select(0, 0));
    return;
  }
  $setSelection(root.selectStart());
}

function createElementPoint(element: ElementNode, offset: number): SelectionPoint {
  return {
    key: element.getKey(),
    offset,
    type: "element",
  };
}

function resolveSelectionPoint(root: ElementNode, targetOffset: number): SelectionPoint {
  const segments: Segment[] = [];
  collectSegments(root, segments, { value: 0 });

  if (segments.length === 0) {
    const firstChild = root.getFirstChild<ElementNode>();
    return createElementPoint(firstChild ?? root, 0);
  }

  const totalLength = segments[segments.length - 1].end;
  const clamped = Math.max(0, Math.min(targetOffset, totalLength));

  for (const segment of segments) {
    if (segment.kind === "text" && clamped >= segment.start && clamped <= segment.end) {
      return {
        key: segment.node.getKey(),
        offset: clamped - segment.start,
        type: "text",
      };
    }

    if (segment.kind === "linebreak") {
      const parent = segment.node.getParentOrThrow<ElementNode>();
      const childIndex = segment.node.getIndexWithinParent();

      if (clamped <= segment.start) {
        return createElementPoint(parent, childIndex);
      }

      if (clamped <= segment.end) {
        return createElementPoint(parent, childIndex + 1);
      }
    }
  }

  const lastSegment = segments[segments.length - 1];
  if (lastSegment.kind === "linebreak") {
    const parent = lastSegment.node.getParentOrThrow<ElementNode>();
    return createElementPoint(parent, lastSegment.node.getIndexWithinParent() + 1);
  }

  return {
    key: lastSegment.node.getKey(),
    offset: lastSegment.end - lastSegment.start,
    type: "text",
  };
}

function setSelectionByOffsets(root: ElementNode, start: number, end: number) {
  const hasSentinel = root.getTextContent().startsWith(EMPTY_SENTINEL);
  const nextStart = resolveSelectionPoint(root, hasSentinel ? start + 1 : start);
  const nextEnd = resolveSelectionPoint(root, hasSentinel ? end + 1 : end);
  const selection = $createRangeSelection();

  selection.anchor.set(nextStart.key, nextStart.offset, nextStart.type);
  selection.focus.set(nextEnd.key, nextEnd.offset, nextEnd.type);

  $setSelection(selection);
}

function EditableStatePlugin({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  return null;
}

export const MentionTextarea = forwardRef<
  MentionTextareaHandle,
  MentionTextareaProps
>(function MentionTextarea(
  {
    value,
    onChange,
    onKeyDown,
    onImageDrop,
    onImagePathDrop,
    onDragActiveChange,
    cwd,
    slashCommands = [],
    placeholder,
    disabled = false,
    className,
    style,
    rows: _rows,
  },
  forwardedRef,
) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const editorElementRef = useRef<HTMLDivElement | null>(null);
  const propValueRef = useRef(value);
  const editorTextRef = useRef(value);
  const selectionRef = useRef<SelectionRange>({ start: value.length, end: value.length });
  const suppressOnChangeRef = useRef(false);
  const autocompleteListRef = useRef<HTMLUListElement>(null);
  const domDragDepthRef = useRef(0);

  const [files, setFiles] = useState<string[]>([]);
  const [autocomplete, setAutocomplete] = useState<AutocompleteState | null>(null);
  const [autocompleteSelection, setAutocompleteSelection] = useState<{
    key: string | null;
    index: number;
  }>({
    key: null,
    index: 0,
  });
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const triggerDefinitions = useMemo<TriggerDefinition[]>(
    () => [
      {
        id: "slash",
        match(textBeforeCursor) {
          const match = /^\/([^\s]*)$/.exec(textBeforeCursor);
          if (!match) return null;

          return {
            query: match[1],
            startPos: 0,
          };
        },
      },
      {
        id: "mention",
        match(textBeforeCursor) {
          const match = /(?:^|\s)@([a-zA-Z0-9_./-]*)$/.exec(textBeforeCursor);
          if (!match) return null;

          return {
            query: match[1],
            startPos: textBeforeCursor.length - match[1].length - 1,
          };
        },
      },
    ],
    [],
  );

  const setEditorValue = useCallback(
    (editor: LexicalEditor, nextValue: string, nextSelection?: SelectionRange) => {
      suppressOnChangeRef.current = true;
      editor.update(
        () => {
          createParagraphWithText(nextValue);
          const root = $getRoot();
          if (nextSelection) {
            setSelectionByOffsets(root, nextSelection.start, nextSelection.end);
          } else if (nextValue.length === 0) {
            selectEmptyEditor(root);
          }
        },
        { discrete: true },
      );
    },
    [],
  );

  const ensureVisibleEmptySelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || editorTextRef.current.length > 0) return;

    editor.update(
      () => {
        selectEmptyEditor($getRoot());
      },
      { discrete: true },
    );
  }, []);

  const syncAutocomplete = useCallback(
    (nextText: string, nextSelection: SelectionRange) => {
      if (nextSelection.start !== nextSelection.end) {
        setAutocomplete(null);
        return;
      }

      const textBeforeCursor = nextText.slice(0, nextSelection.start);
      for (const definition of triggerDefinitions) {
        const match = definition.match(textBeforeCursor);
        if (match) {
          setAutocomplete({
            triggerId: definition.id,
            query: match.query,
            startPos: match.startPos,
            endPos: nextSelection.start,
          });
          return;
        }
      }

      setAutocomplete(null);
    },
    [triggerDefinitions],
  );

  const applyControlledValue = useCallback(
    (
      nextValue: string,
      nextSelection?: SelectionRange,
      options?: { emitChange?: boolean },
    ) => {
      const editor = editorRef.current;
      if (!editor) return;

      const resolvedSelection =
        nextSelection ?? ({ start: nextValue.length, end: nextValue.length } satisfies SelectionRange);

      editorTextRef.current = nextValue;
      selectionRef.current = resolvedSelection;
      syncAutocomplete(nextValue, resolvedSelection);
      setEditorValue(editor, nextValue, resolvedSelection);

      if (options?.emitChange) {
        emitSyntheticChange(onChange, nextValue);
      }
    },
    [onChange, setEditorValue, syncAutocomplete],
  );

  const autocompleteOptions = useMemo<AutocompleteOption[]>(() => {
    if (!autocomplete) {
      return [];
    }

    if (autocomplete.triggerId === "mention") {
      const normalizedQuery = autocomplete.query.toLowerCase();
      return files
        .filter((file) => file.toLowerCase().includes(normalizedQuery))
        .slice(0, MAX_RESULTS)
        .map((file) => ({
          key: `mention:${file}`,
          title: file,
          insertText: `@${file} `,
        }));
    }

    return filterSlashCommands(slashCommands, autocomplete.query, MAX_RESULTS).map(
      (definition) => ({
        key: `slash:${definition.command}`,
        title: definition.displayLabel ?? definition.command,
        description: definition.description,
        insertText: definition.insertText ?? definition.command,
        slashCommand: definition,
      }),
    );
  }, [autocomplete, files, slashCommands]);

  const autocompleteKey = autocomplete
    ? `${autocomplete.triggerId}:${autocomplete.query}`
    : null;
  const selectedIndex =
    autocompleteKey !== null && autocompleteSelection.key === autocompleteKey
      ? autocompleteSelection.index
      : 0;

  const safeSelectedIndex =
    autocompleteOptions.length > 0
      ? Math.min(selectedIndex, autocompleteOptions.length - 1)
      : 0;

  const applyAutocompleteSelection = useCallback(
    (option: AutocompleteOption) => {
      const currentValue = editorTextRef.current;
      const currentSelection = selectionRef.current;
      const activeAutocomplete = autocomplete;

      if (!activeAutocomplete) return;

      const before = currentValue.slice(0, activeAutocomplete.startPos);
      const after = currentValue.slice(currentSelection.end);
      const inserted = option.insertText;
      const nextValue = before + inserted + after;
      const nextCursor = before.length + inserted.length;

      setAutocomplete(null);
      setAutocompleteSelection({ key: null, index: 0 });
      applyControlledValue(
        nextValue,
        { start: nextCursor, end: nextCursor },
        { emitChange: true },
      );
    },
    [applyControlledValue, autocomplete],
  );

  const insertDroppedPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;

      const currentValue = editorTextRef.current;
      const currentSelection = selectionRef.current;
      const normalized = paths.map((path) => normalizePath(path, cwd));
      const insertedPaths = normalized.map((path) => `@${path}`).join(" ");
      const before = currentValue.slice(0, currentSelection.start);
      const after = currentValue.slice(currentSelection.end);
      const pad =
        before === "" || /\s$/.test(before) ? "" : " ";
      const inserted = `${insertedPaths} `;
      const nextValue = before + pad + inserted + after;
      const nextCursor = before.length + pad.length + inserted.length;

      applyControlledValue(
        nextValue,
        { start: nextCursor, end: nextCursor },
        { emitChange: true },
      );
    },
    [applyControlledValue, cwd],
  );

  const handleImageFiles = useCallback(
    (files: File[]) => {
      if (files.length > 0 && onImageDrop) {
        onImageDrop(files);
      }
    },
    [onImageDrop],
  );

  const isPositionInsideEditor = useCallback((position: { x: number; y: number }) => {
    const element = editorElementRef.current;
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    return (
      position.x >= rect.left &&
      position.x <= rect.right &&
      position.y >= rect.top &&
      position.y <= rect.bottom
    );
  }, []);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus() {
        const editor = editorRef.current;
        if (!editor) return;

        editor.getRootElement()?.focus();
        editor.focus(() => {
          ensureVisibleEmptySelection();
        }, { defaultSelection: "rootEnd" });
      },
      blur() {
        const editor = editorRef.current;
        if (!editor) return;

        editor.getRootElement()?.blur();
        editor.blur();
      },
      setSelectionRange(start, end) {
        const editor = editorRef.current;
        if (!editor) return;

        selectionRef.current = { start, end };
        editor.update(
          () => {
            const root = $getRoot();
            setSelectionByOffsets(root, start, end);
          },
          { discrete: true },
        );
      },
    }),
    [ensureVisibleEmptySelection],
  );

  useEffect(() => {
    propValueRef.current = value;
    if (value === editorTextRef.current) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const preservedSelection = Math.min(selectionRef.current.end, value.length);
    const nextSelection = {
      start: preservedSelection,
      end: preservedSelection,
    };

    editorTextRef.current = value;
    selectionRef.current = nextSelection;
    setEditorValue(editor, value, nextSelection);
  }, [setEditorValue, value]);

  useEffect(() => {
    if (!cwd) {
      return;
    }

    let active = true;
    invoke<{ matches: string[]; truncated: boolean }>("search_files", {
      cwd,
      maxResults: 2000,
    })
      .then((result) => {
        if (active) {
          setFiles(result.matches);
        }
      })
      .catch(console.error);

    return () => {
      active = false;
    };
  }, [cwd]);

  useEffect(() => {
    if (!autocomplete || autocompleteOptions.length === 0) return;

    const list = autocompleteListRef.current;
    if (!list) return;

    const selected = list.querySelector<HTMLElement>(
      `[data-autocomplete-index="${safeSelectedIndex}"]`,
    );
    if (!selected) return;

    const itemTop = selected.offsetTop;
    const itemBottom = itemTop + selected.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;

    if (itemTop < viewTop) {
      list.scrollTop = itemTop;
    } else if (itemBottom > viewBottom) {
      list.scrollTop = itemBottom - list.clientHeight;
    }
  }, [autocomplete, autocompleteOptions.length, safeSelectedIndex]);

  useEffect(() => {
    const unlistenFns: Array<() => void> = [];
    let mounted = true;

    async function registerListeners() {
      const unlistenDragEnter = await listen<TauriDragPayload>(
        TauriEvent.DRAG_ENTER,
        (event) => {
          if (!mounted) return;
          onDragActiveChange?.(true);
          setIsDropTarget(isPositionInsideEditor(event.payload.position));
        },
      );
      const unlistenDragLeave = await listen(TauriEvent.DRAG_LEAVE, () => {
        if (!mounted) return;
        onDragActiveChange?.(false);
        setIsDropTarget(false);
      });
      const unlistenDragDrop = await listen<TauriDragPayload>(
        TauriEvent.DRAG_DROP,
        (event) => {
          if (!mounted) return;
          onDragActiveChange?.(false);
          setIsDropTarget(false);
          if (!isPositionInsideEditor(event.payload.position)) {
            return;
          }
          // Split: image paths go to onImagePathDrop, everything else inserts @path text.
          const imagePaths = event.payload.paths.filter((p) => isImagePath(p));
          const nonImagePaths = event.payload.paths.filter(
            (p) => !isImagePath(p),
          );
          if (imagePaths.length > 0) onImagePathDrop?.(imagePaths);
          insertDroppedPaths(nonImagePaths);
        },
      );

      unlistenFns.push(unlistenDragEnter, unlistenDragLeave, unlistenDragDrop);
    }

    void registerListeners();

    return () => {
      mounted = false;
      for (const unlisten of unlistenFns) {
        unlisten();
      }
    };
  }, [insertDroppedPaths, isPositionInsideEditor, onImagePathDrop, onDragActiveChange]);

  const handleEditorRef = useCallback(
    (editor: LexicalEditor | null) => {
      editorRef.current = editor;
      if (editor && editorTextRef.current !== value) {
        setEditorValue(editor, value, {
          start: value.length,
          end: value.length,
        });
      }
    },
    [setEditorValue, value],
  );

  const handleLexicalChange = useCallback(
    (editorState: EditorState) => {
      let normalizedText = "";
      let normalizedSelection: SelectionRange = { start: 0, end: 0 };
      let shouldRewriteSentinel = false;

      editorState.read(() => {
        const nextText = $getRoot().getTextContent();
        const nextValue = fromEditorDocumentText(nextText);
        const selection = $getSelection();
        const nextSelection =
          selection && $isRangeSelection(selection)
            ? (() => {
                const [anchor, focus] = $getCharacterOffsets(selection);
                const offsetAdjustment = nextText.startsWith(EMPTY_SENTINEL) ? 1 : 0;
                const start = Math.max(0, Math.min(anchor, focus) - offsetAdjustment);
                const end = Math.max(0, Math.max(anchor, focus) - offsetAdjustment);
                return { start, end };
              })()
            : {
                start: nextValue.length,
                end: nextValue.length,
              };

        normalizedText = nextValue;
        normalizedSelection = nextSelection;
        shouldRewriteSentinel =
          nextText.startsWith(EMPTY_SENTINEL) && nextValue.length > 0;

        editorTextRef.current = nextValue;
        selectionRef.current = nextSelection;
        syncAutocomplete(nextValue, nextSelection);

        if (suppressOnChangeRef.current) {
          suppressOnChangeRef.current = false;
          return;
        }

        if (nextValue !== propValueRef.current) {
          emitSyntheticChange(onChange, nextValue);
        }
      });

      if (shouldRewriteSentinel && editorRef.current) {
        setEditorValue(editorRef.current, normalizedText, normalizedSelection);
      }
    },
    [onChange, setEditorValue, syncAutocomplete],
  );

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const consumeEvent = () => {
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation?.();
      };

      if (autocomplete && autocompleteOptions.length > 0) {
        if (event.key === "ArrowDown") {
          consumeEvent();
          setAutocompleteSelection((current) => {
            const currentIndex = current.key === autocompleteKey ? current.index : 0;
            return {
              key: autocompleteKey,
              index: (currentIndex + 1) % autocompleteOptions.length,
            };
          });
          return;
        }

        if (event.key === "ArrowUp") {
          consumeEvent();
          setAutocompleteSelection((current) => {
            const currentIndex = current.key === autocompleteKey ? current.index : 0;
            return {
              key: autocompleteKey,
              index:
                (currentIndex - 1 + autocompleteOptions.length) %
                autocompleteOptions.length,
            };
          });
          return;
        }

        if (event.key === "Enter" || event.key === "Tab") {
          const selectedOption = autocompleteOptions[safeSelectedIndex];
          const shouldSubmitExactSlashCommand =
            event.key === "Enter" &&
            autocomplete.triggerId === "slash" &&
            !!selectedOption?.slashCommand &&
            selectedOption.slashCommand.takesArguments === false &&
            matchesSlashCommandInput(
              editorTextRef.current,
              selectedOption.slashCommand,
            );

          if (shouldSubmitExactSlashCommand) {
            onKeyDown?.(event as unknown as KeyboardEvent<HTMLTextAreaElement>);
            return;
          }

          consumeEvent();
          applyAutocompleteSelection(selectedOption);
          return;
        }

        if (event.key === "Escape") {
          consumeEvent();
          setAutocomplete(null);
          setAutocompleteSelection({ key: null, index: 0 });
          return;
        }
      }

      onKeyDown?.(event as unknown as KeyboardEvent<HTMLTextAreaElement>);
    },
    [
      applyAutocompleteSelection,
      autocomplete,
      autocompleteKey,
      autocompleteOptions,
      onKeyDown,
      safeSelectedIndex,
    ],
  );

  const handleFocusCapture = useCallback(() => {
    setIsFocused(true);
    ensureVisibleEmptySelection();
  }, [ensureVisibleEmptySelection]);

  const handleBlurCapture = useCallback(() => {
    setIsFocused(false);
  }, []);

  const handleDomDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;

    event.preventDefault();
    event.stopPropagation();
    domDragDepthRef.current += 1;
    setIsDropTarget(true);
  }, []);

  const handleDomDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;

    event.preventDefault();
    event.stopPropagation();
    domDragDepthRef.current = Math.max(0, domDragDepthRef.current - 1);
    if (domDragDepthRef.current === 0) {
      setIsDropTarget(false);
    }
  }, []);

  const handleDomDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setIsDropTarget(true);
  }, []);

  const handleDomDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;

      event.preventDefault();
      event.stopPropagation();

      domDragDepthRef.current = 0;
      setIsDropTarget(false);

      const allFiles = Array.from(event.dataTransfer.files);
      const imageFiles = allFiles.filter(isImageFile);
      const nonImageFiles = allFiles.filter((f) => !isImageFile(f));

      handleImageFiles(imageFiles);

      const paths = nonImageFiles
        .map((file) => {
          const tauriFile = file as File & { path?: string };
          return tauriFile.path ?? file.name;
        })
        .filter(Boolean);

      insertDroppedPaths(paths);
    },
    [insertDroppedPaths, handleImageFiles],
  );

  const initialValueRef = useRef(value);

  const initialConfig = useMemo(
    () => ({
      editable: !disabled,
      namespace: "rakh-mention-textarea",
      onError(error: Error) {
        throw error;
      },
      editorState() {
        createParagraphWithText(initialValueRef.current);
      },
      theme: {},
    }),
    [disabled],
  );

  return (
    <div
      className={cn(
        "mention-wrap",
        value.length === 0 && "mention-wrap--empty",
        isFocused && "mention-wrap--focused",
        isDropTarget && "mention-wrap--drop-target",
      )}
    >
      {placeholder && value.length === 0 && (
        <div aria-hidden="true" className="mention-textarea__placeholder">
          {placeholder}
        </div>
      )}
      {autocomplete && autocompleteOptions.length > 0 && (
        <ul ref={autocompleteListRef} className="mention-list">
          {autocompleteOptions.map((option, index) => (
            <li
              key={option.key}
              data-autocomplete-index={index}
              className={cn(
                "mention-item",
                index === safeSelectedIndex && "mention-item--active",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                applyAutocompleteSelection(option);
              }}
              onMouseEnter={() =>
                setAutocompleteSelection({
                  key: autocompleteKey,
                  index,
                })
              }
            >
              <div className="mention-item__title">{option.title}</div>
              {option.description ? (
                <div className="mention-item__description">{option.description}</div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <LexicalComposer initialConfig={initialConfig}>
        <EditorRefPlugin editorRef={handleEditorRef} />
        <EditableStatePlugin disabled={disabled} />
        <HistoryPlugin />
        <OnChangePlugin
          ignoreHistoryMergeTagChange={true}
          ignoreSelectionChange={false}
          onChange={handleLexicalChange}
        />
        <PlainTextPlugin
          ErrorBoundary={LexicalErrorBoundary}
          contentEditable={
            <ContentEditable
              ref={editorElementRef}
              className={cn("mention-textarea__editor", className)}
              onDragEnter={handleDomDragEnter}
              onDragLeave={handleDomDragLeave}
              onDragOver={handleDomDragOver}
              onDrop={handleDomDrop}
              onBlurCapture={handleBlurCapture}
              onFocusCapture={handleFocusCapture}
              onKeyDownCapture={handleKeyDownCapture}
              spellCheck={false}
              style={{
                ...style,
                maxHeight: `${MAX_HEIGHT_PX}px`,
              }}
            />
          }
          placeholder={null}
        />
      </LexicalComposer>
    </div>
  );
});

MentionTextarea.displayName = "MentionTextarea";
