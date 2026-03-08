// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspacePage from "./WorkspacePage";

const workspaceMocks = vi.hoisted(() => ({
  sendMessageMock: vi.fn<(message: string) => void>(),
  stopMock: vi.fn(),
  setConfigMock: vi.fn(),
  setAutoApproveEditsMock: vi.fn(),
  setAutoApproveCommandsMock: vi.fn(),
  patchAgentStateMock: vi.fn(),
  updateTabMock: vi.fn(),
  transcriptCallback: null as null | ((transcript: string) => void),
  invokeMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("jotai", async () => {
  const actual = await vi.importActual<typeof import("jotai")>("jotai");
  return {
    ...actual,
    useAtomValue: () => false,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: workspaceMocks.invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  TauriEvent: {
    DRAG_ENTER: "tauri://drag-enter",
    DRAG_DROP: "tauri://drag-drop",
    DRAG_LEAVE: "tauri://drag-leave",
  },
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    workspaceMocks.eventHandlers.set(event, handler);
    return Promise.resolve(() => {
      workspaceMocks.eventHandlers.delete(event);
    });
  },
}));

vi.mock("@/contexts/TabsContext", () => ({
  useTabs: () => ({
    tabs: [
      {
        id: "tab-1",
        label: "Workspace",
        icon: "chat_bubble_outline",
        mode: "workspace" as const,
        status: "idle" as const,
      },
    ],
    activeTabId: "tab-1",
    updateTab: workspaceMocks.updateTabMock,
  }),
}));

vi.mock("@/agent/useAgents", () => ({
  useAgent: () => ({
    autoApproveCommands: "no" as const,
    autoApproveEdits: false,
    chatMessages: [],
    config: {
      cwd: "/repo",
      model: "model-1",
      worktreeBranch: "main",
    },
    contextWindowKb: null,
    contextWindowPct: null,
    error: null,
    errorDetails: null,
    sendMessage: workspaceMocks.sendMessageMock,
    setAutoApproveCommands: workspaceMocks.setAutoApproveCommandsMock,
    setAutoApproveEdits: workspaceMocks.setAutoApproveEditsMock,
    setConfig: workspaceMocks.setConfigMock,
    showDebug: false,
    status: "idle" as const,
    stop: workspaceMocks.stopMock,
    tabTitle: "",
  }),
}));

vi.mock("@/agent/useModels", () => ({
  useModels: () => ({
    models: [{ id: "model-1", name: "Model 1" }],
  }),
}));

vi.mock("@/agent/atoms", () => ({
  patchAgentState: workspaceMocks.patchAgentStateMock,
  voiceInputEnabledAtom: {},
}));

vi.mock("@/agent/subagents", () => ({
  getAllSubagents: () => [],
  getSubagentThemeColorToken: () => "var(--color-primary)",
}));

vi.mock("@/agent/chatBubbleGroups", () => ({
  groupChatMessagesForBubbles: () => [],
}));

vi.mock("@/components/artifact-pane/useSessionArtifacts", () => ({
  useArtifactContentCache: () => ({
    ensureArtifactContent: vi.fn(),
    getEntry: vi.fn(),
  }),
}));

vi.mock("@/components/ArtifactPane", () => ({
  __esModule: true,
  default: ({ onRefineEdit }: { onRefineEdit: (filePath: string) => void }) => (
    <button onClick={() => onRefineEdit("src/test.ts")}>Refine edit</button>
  ),
  useArtifactUpdates: () => ({
    activeTab: "plan",
    unseenTabs: new Set<string>(),
    handleTabClick: vi.fn(),
    artifactInventory: [],
    artifactInventoryLoading: false,
    artifactInventoryError: null,
  }),
}));

vi.mock("@/components/ConversationCards", () => ({
  default: () => null,
}));

vi.mock("@/components/Terminal", () => ({
  default: () => null,
}));

vi.mock("@/components/UserMessage", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/AgentMessage", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ToolCallApproval", () => ({
  default: () => null,
}));

vi.mock("@/components/UserInputCard", () => ({
  default: () => null,
}));

vi.mock("@/components/Markdown", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/NewSession", () => ({
  default: () => null,
}));

vi.mock("@/components/ChatControls", () => ({
  default: () => null,
}));

vi.mock("@/components/AutoScrollArea", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ErrorDetailsModal", () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock("@/components/ToolCallDetailsModal", () => ({
  default: () => null,
}));

vi.mock("@/components/CompactToolCall", () => ({
  default: () => null,
}));

vi.mock("@/components/ReasoningThought", () => ({
  default: () => null,
}));

vi.mock("@/components/ui", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));

vi.mock("@/components/voice-input/VoiceInputUi", () => ({
  VoiceInputRecordingRow: () => null,
  VoiceInputStateProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  VoiceInputStatusSlot: () => null,
  VoiceInputToggleButton: () => null,
}));

vi.mock("@/components/voice-input/useVoiceInputController", () => ({
  useVoiceInputController: ({
    onTranscript,
  }: {
    onTranscript: (transcript: string) => void;
  }) => {
    workspaceMocks.transcriptCallback = onTranscript;
    return {
      busy: false,
      clearError: vi.fn(),
      enabled: false,
      error: null,
      isPreparingModel: false,
      isRecording: false,
      isTranscribing: false,
      recordingElapsedMs: 0,
      stopRecording: vi.fn(async () => undefined),
      toggleRecording: vi.fn(),
      waveformCanvasRef: { current: null },
    };
  },
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  type MotionProps = React.PropsWithChildren<Record<string, unknown>>;

  function createMotionComponent(tag: string) {
    return React.forwardRef<HTMLElement, MotionProps>(
      (
        {
          animate: _animate,
          children,
          exit: _exit,
          initial: _initial,
          transition: _transition,
          ...props
        },
        ref,
      ) => React.createElement(tag, { ...props, ref }, children as React.ReactNode),
    );
  }

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy(
      {},
      {
        get: (_target, key) => createMotionComponent(String(key)),
      },
    ),
  };
});

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

function setTextboxRect(element: HTMLElement) {
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

function emitTranscript(text: string) {
  act(() => {
    workspaceMocks.transcriptCallback?.(text);
  });
}

describe("WorkspacePage chat input", () => {
  beforeEach(() => {
    cleanup();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: vi.fn(),
    });
    installSelectionGeometryPolyfills();
    workspaceMocks.sendMessageMock.mockReset();
    workspaceMocks.stopMock.mockReset();
    workspaceMocks.setConfigMock.mockReset();
    workspaceMocks.setAutoApproveEditsMock.mockReset();
    workspaceMocks.setAutoApproveCommandsMock.mockReset();
    workspaceMocks.patchAgentStateMock.mockReset();
    workspaceMocks.updateTabMock.mockReset();
    workspaceMocks.transcriptCallback = null;
    workspaceMocks.eventHandlers.clear();
    workspaceMocks.invokeMock.mockReset();
    workspaceMocks.invokeMock.mockResolvedValue({
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

  it("submits on Enter when no autocomplete menu is open", async () => {
    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("hello world");

    await waitFor(() => {
      expect(textbox.textContent).toBe("hello world");
    });

    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(workspaceMocks.sendMessageMock).toHaveBeenCalledWith("hello world");
  });

  it("uses Enter to accept an active mention instead of submitting", async () => {
    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("@src");

    await waitFor(() => {
      expect(screen.getByText("src/components/MentionTextarea.tsx")).not.toBeNull();
    });

    fireEvent.keyDown(textbox, { key: "Enter" });

    await waitFor(() => {
      expect(textbox.textContent).toBe("@src/components/MentionTextarea.tsx ");
    });
    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();
  });

  it("uses Tab to accept an active mention instead of submitting", async () => {
    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("@READ");

    await waitFor(() => {
      expect(screen.getByText("README.md")).not.toBeNull();
    });

    fireEvent.keyDown(textbox, { key: "Tab" });

    await waitFor(() => {
      expect(textbox.textContent).toBe("@README.md ");
    });
    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();
  });

  it("keeps focus and the caret at the end after voice transcript append and refine edit", async () => {
    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("voice transcript");

    await waitFor(() => {
      expect(textbox.textContent).toBe("voice transcript");
    });

    expect(document.activeElement).toBe(textbox);
    expect(document.getSelection()?.focusNode?.textContent).toBe("voice transcript");

    fireEvent.click(screen.getByRole("button", { name: "Refine edit" }));

    await waitFor(() => {
      expect(textbox.textContent).toContain("Refine edit in src/test.ts: ");
    });

    expect(document.activeElement).toBe(textbox);
    const focusText = document.getSelection()?.focusNode?.textContent ?? "";
    expect(focusText.endsWith("Refine edit in src/test.ts: ")).toBe(true);
  });
});
