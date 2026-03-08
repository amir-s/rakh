// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createRef,
  useEffect,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MentionTextarea,
  type MentionTextareaHandle,
} from "./MentionTextarea";

const tauriMocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  TauriEvent: {
    DRAG_ENTER: "tauri://drag-enter",
    DRAG_DROP: "tauri://drag-drop",
    DRAG_LEAVE: "tauri://drag-leave",
  },
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    tauriMocks.handlers.set(event, handler);
    return Promise.resolve(() => {
      tauriMocks.handlers.delete(event);
    });
  },
}));

function setEditorRect(element: HTMLElement) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 40,
      height: 40,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => null,
    }),
  });
}

function installSelectionGeometryPolyfills() {
  const rect = () => ({
    bottom: 20,
    height: 20,
    left: 0,
    right: 120,
    top: 0,
    width: 120,
    x: 0,
    y: 0,
    toJSON: () => null,
  });

  Object.defineProperty(Text.prototype, "getBoundingClientRect", {
    configurable: true,
    value: rect,
  });
  Object.defineProperty(Text.prototype, "getClientRects", {
    configurable: true,
    value: () => ({
      item: () => null,
      length: 0,
      [Symbol.iterator]: function* iterator() {
        yield rect();
      },
    }),
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: rect,
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => ({
      item: () => null,
      length: 0,
      [Symbol.iterator]: function* iterator() {
        yield rect();
      },
    }),
  });
}

function ControlledMentionTextarea({
  cwd = "/repo",
  handleRef,
  initialValue = "",
  onKeyDown,
}: {
  cwd?: string;
  handleRef?: RefObject<MentionTextareaHandle | null>;
  initialValue?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (!handleRef?.current) return;
    handleRef.current.setSelectionRange(value.length, value.length);
  }, [handleRef, value]);

  return (
    <>
      <MentionTextarea
        ref={handleRef}
        cwd={cwd}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type a message…"
        value={value}
      />
      <div data-testid="value">{value}</div>
    </>
  );
}

describe("MentionTextarea", () => {
  beforeEach(() => {
    cleanup();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    installSelectionGeometryPolyfills();
    tauriMocks.invokeMock.mockReset();
    tauriMocks.handlers.clear();
    tauriMocks.invokeMock.mockResolvedValue({
      matches: [
        "src/components/MentionTextarea.tsx",
        "src/utils/audio.ts",
        "README.md",
      ],
      truncated: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows mention suggestions, supports keyboard navigation, and inserts with Enter", async () => {
    const handleRef = createRef<MentionTextareaHandle>();

    render(
      <ControlledMentionTextarea
        handleRef={handleRef}
        initialValue="@src"
      />,
    );

    const textbox = screen.getByRole("textbox");
    setEditorRect(textbox);

    act(() => {
      handleRef.current?.focus();
      handleRef.current?.setSelectionRange(4, 4);
    });

    await waitFor(() => {
      expect(screen.getByText("src/components/MentionTextarea.tsx")).not.toBeNull();
    });

    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    fireEvent.keyDown(textbox, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("value").textContent).toBe("@src/utils/audio.ts ");
    });
  });

  it("inserts the selected suggestion with Tab", async () => {
    const handleRef = createRef<MentionTextareaHandle>();

    render(
      <ControlledMentionTextarea
        handleRef={handleRef}
        initialValue="@READ"
      />,
    );

    const textbox = screen.getByRole("textbox");
    setEditorRect(textbox);

    act(() => {
      handleRef.current?.focus();
      handleRef.current?.setSelectionRange(5, 5);
    });

    await waitFor(() => {
      expect(screen.getByText("README.md")).not.toBeNull();
    });

    fireEvent.keyDown(textbox, { key: "Tab" });

    await waitFor(() => {
      expect(screen.getByTestId("value").textContent).toBe("@README.md ");
    });
  });

  it("dismisses the autocomplete on Escape and lets Enter reach the parent handler afterwards", async () => {
    const handleRef = createRef<MentionTextareaHandle>();
    const onKeyDown = vi.fn((event: KeyboardEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
    });

    render(
      <MentionTextarea
        ref={handleRef}
        cwd="/repo"
        onChange={vi.fn()}
        onKeyDown={onKeyDown}
        placeholder="Type a message…"
        value="@src"
      />,
    );

    const textbox = screen.getByRole("textbox");
    setEditorRect(textbox);

    act(() => {
      handleRef.current?.focus();
      handleRef.current?.setSelectionRange(4, 4);
    });

    await waitFor(() => {
      expect(screen.getByText("src/components/MentionTextarea.tsx")).not.toBeNull();
    });

    act(() => {
      fireEvent.keyDown(textbox, { key: "Escape" });
    });

    await waitFor(() => {
      expect(screen.queryByText("src/components/MentionTextarea.tsx")).toBeNull();
    });

    act(() => {
      fireEvent.keyDown(textbox, { key: "Enter" });
    });

    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("syncs external value updates into the editor without firing onChange", async () => {
    const onChange = vi.fn();
    const handleRef = createRef<MentionTextareaHandle>();
    const { rerender } = render(
      <MentionTextarea
        ref={handleRef}
        cwd="/repo"
        onChange={onChange}
        placeholder="Type a message…"
        value="hello"
      />,
    );

    const textbox = screen.getByRole("textbox");
    setEditorRect(textbox);

    rerender(
      <MentionTextarea
        ref={handleRef}
        cwd="/repo"
        onChange={onChange}
        placeholder="Type a message…"
        value="external update"
      />,
    );

    await waitFor(() => {
      expect(textbox.textContent).toBe("external update");
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("handles DOM and Tauri file drops and normalizes repo-relative paths", async () => {
    const handleRef = createRef<MentionTextareaHandle>();

    render(<ControlledMentionTextarea handleRef={handleRef} />);

    const textbox = screen.getByRole("textbox");
    setEditorRect(textbox);

    act(() => {
      handleRef.current?.focus();
      handleRef.current?.setSelectionRange(0, 0);
    });

    const domFile = Object.assign(new File([""], "audio.ts"), {
      path: "/repo/src/utils/audio.ts",
    });
    const domDataTransfer = {
      dropEffect: "",
      files: [domFile],
      types: ["Files"],
    } as unknown as DataTransfer;

    fireEvent.dragEnter(textbox, { dataTransfer: domDataTransfer });
    expect(textbox.closest(".mention-wrap")?.className).toContain(
      "mention-wrap--drop-target",
    );
    fireEvent.dragOver(textbox, { dataTransfer: domDataTransfer });
    fireEvent.drop(textbox, { dataTransfer: domDataTransfer });

    await waitFor(() => {
      expect(screen.getByTestId("value").textContent).toBe("@src/utils/audio.ts ");
    });

    act(() => {
      tauriMocks.handlers.get("tauri://drag-enter")?.({
        payload: {
          paths: ["/repo/README.md"],
          position: { x: 10, y: 10 },
        },
      });
    });

    expect(textbox.closest(".mention-wrap")?.className).toContain(
      "mention-wrap--drop-target",
    );

    act(() => {
      tauriMocks.handlers.get("tauri://drag-drop")?.({
        payload: {
          paths: ["/repo/README.md"],
          position: { x: 10, y: 10 },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("value").textContent).toBe(
        "@src/utils/audio.ts @README.md ",
      );
    });
  });

  it("exposes focus, blur, and selection updates through the forwarded handle", async () => {
    const handleRef = createRef<MentionTextareaHandle>();

    render(
      <ControlledMentionTextarea
        handleRef={handleRef}
        initialValue="x @src"
      />,
    );

    const textbox = screen.getByRole("textbox");
    setEditorRect(textbox);

    act(() => {
      handleRef.current?.focus();
      handleRef.current?.setSelectionRange(6, 6);
    });

    expect(document.activeElement).toBe(textbox);
    await waitFor(() => {
      expect(screen.getByText("src/components/MentionTextarea.tsx")).not.toBeNull();
    });

    act(() => {
      handleRef.current?.setSelectionRange(0, 0);
    });

    await waitFor(() => {
      expect(screen.queryByText("src/components/MentionTextarea.tsx")).toBeNull();
    });

    act(() => {
      handleRef.current?.blur();
    });

    expect(document.activeElement).not.toBe(textbox);
  });
});
