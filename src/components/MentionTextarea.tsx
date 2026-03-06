import {
  useState,
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  type ChangeEvent,
  type KeyboardEvent,
  type DragEvent,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";

export interface MentionTextareaProps {
  value: string;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  cwd?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  rows?: number;
}

export const MentionTextarea = forwardRef<
  HTMLTextAreaElement,
  MentionTextareaProps
>(
  (
    {
      value,
      onChange,
      onKeyDown,
      cwd,
      placeholder,
      disabled,
      className,
      style,
      rows,
    },
    forwardedRef,
  ) => {
    const internalRef = useRef<HTMLTextAreaElement>(null);
    const ref = (forwardedRef ||
      internalRef) as React.MutableRefObject<HTMLTextAreaElement | null>;

    const [files, setFiles] = useState<string[]>([]);
    const [mentionQuery, setMentionQuery] = useState<{
      query: string;
      index: number;
      startPos: number;
    } | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const mentionListRef = useRef<HTMLUListElement>(null);

    // Fetch files when cwd changes
    useEffect(() => {
      if (!cwd) {
        // We do not clear files array here to avoid React cascading render warnings.
        // `files` will naturally be empty if not populated by search_files.
        return;
      }
      let active = true;
      invoke<{ matches: string[]; truncated: boolean }>("search_files", {
        cwd,
        maxResults: 2000,
      })
        .then((res) => {
          if (active) setFiles(res.matches);
        })
        .catch(console.error);

      return () => {
        active = false;
      };
    }, [cwd]);

    // Check cursor position for mentions
    const checkMention = useCallback(() => {
      if (!ref.current) return;
      const el = ref.current;
      const pos = el.selectionStart;
      const textBeforeCursor = value.substring(0, pos);

      const match = /(?:^|\s)@([a-zA-Z0-9_./-]*)$/.exec(textBeforeCursor);

      if (match) {
        const query = match[1];
        const startPos = pos - query.length - 1; // position of the '@'
        setMentionQuery({ query, index: pos, startPos });
      } else {
        setMentionQuery(null);
      }
    }, [value, ref]);

    useEffect(() => {
      checkMention();
    }, [value, checkMention]);

    const handleSelect = () => checkMention();

    // Use valid index during render instead of cascading render
    const displayFilesLimit = 15;
    const filteredFiles = mentionQuery
      ? files
          .filter((f) =>
            f.toLowerCase().includes(mentionQuery.query.toLowerCase()),
          )
          .slice(0, displayFilesLimit)
      : [];

    // Clamp selectedIndex during render if out of bounds, preventing crashes.
    // True reset to 0 can happen gracefully on next key press if desired, but this handles most cases.
    const safeSelectedIndex =
      filteredFiles.length > 0
        ? Math.min(selectedIndex, filteredFiles.length - 1)
        : 0;

    // Keep the highlighted mention visible while navigating with arrow keys.
    useEffect(() => {
      if (!mentionQuery || filteredFiles.length === 0) return;
      const listEl = mentionListRef.current;
      if (!listEl) return;
      const selectedEl = listEl.querySelector<HTMLElement>(
        `[data-mention-index="${safeSelectedIndex}"]`,
      );
      if (!selectedEl) return;

      const itemTop = selectedEl.offsetTop;
      const itemBottom = itemTop + selectedEl.offsetHeight;
      const viewTop = listEl.scrollTop;
      const viewBottom = viewTop + listEl.clientHeight;

      if (itemTop < viewTop) {
        listEl.scrollTop = itemTop;
      } else if (itemBottom > viewBottom) {
        listEl.scrollTop = itemBottom - listEl.clientHeight;
      }
    }, [mentionQuery, filteredFiles.length, safeSelectedIndex]);

    // Handle Keyboard events
    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionQuery && filteredFiles.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % filteredFiles.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex(
            (i) => (i - 1 + filteredFiles.length) % filteredFiles.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          insertMention(filteredFiles[safeSelectedIndex]);
          setSelectedIndex(0); // Reset after selection
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }

      // Allow WorkspacePage to handle the enter key if not in a dropdown
      if (onKeyDown) onKeyDown(e);
    };

    const insertMention = (file: string) => {
      if (!mentionQuery || !ref.current) return;

      const before = value.substring(0, mentionQuery.startPos);
      const after = value.substring(ref.current.selectionStart);
      const inserted = `@${file} `;

      const newValue = before + inserted + after;

      const syntheticEvent = {
        target: { value: newValue },
      } as ChangeEvent<HTMLTextAreaElement>;

      onChange(syntheticEvent);
      setMentionQuery(null);

      const newCursorPos = before.length + inserted.length;
      setTimeout(() => {
        if (ref.current) {
          ref.current.focus();
          ref.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
    };

    const handleDragOver = (e: DragEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDrop = (e: DragEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        let insertedPaths = "";
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i] as File & { path?: string };
          // Standard web File object usually only has name,
          // Tauri dropped files may have a path property.
          let filePath = file.path || file.name;

          if (cwd && filePath.startsWith(cwd + "/")) {
            filePath = filePath.substring(cwd.length + 1);
          }
          insertedPaths += `@${filePath} `;
        }

        const pos = ref.current?.selectionStart || value.length;
        const before = value.substring(0, pos);
        const after = value.substring(pos);
        const pad = before.endsWith(" ") || before === "" ? "" : " ";
        const newValue = before + pad + insertedPaths + after;

        const syntheticEvent = {
          target: { value: newValue },
        } as ChangeEvent<HTMLTextAreaElement>;
        onChange(syntheticEvent);

        const newCursorPos = before.length + pad.length + insertedPaths.length;
        setTimeout(() => {
          if (ref.current) {
            ref.current.focus();
            ref.current.setSelectionRange(newCursorPos, newCursorPos);
          }
        }, 0);
      }
    };

    return (
      <div className="mention-wrap">
        {mentionQuery && filteredFiles.length > 0 && (
          <ul ref={mentionListRef} className="mention-list">
            {filteredFiles.map((file, i) => (
              <li
                key={file}
                data-mention-index={i}
                onClick={() => insertMention(file)}
                className={`mention-item${i === safeSelectedIndex ? " mention-item--active" : ""}`}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                {file}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          value={value}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleSelect}
          onClick={handleSelect}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          placeholder={placeholder}
          disabled={disabled}
          className={className}
          style={style}
          rows={rows}
        />
      </div>
    );
  },
);

MentionTextarea.displayName = "MentionTextarea";
