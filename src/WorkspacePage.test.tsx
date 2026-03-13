// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspacePage from "./WorkspacePage";

type MockToolCall = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: string;
};

type MockChatMessage = {
  id?: string;
  role?: string;
  content?: string;
  timestamp?: number;
  traceId?: string;
  toolCalls?: MockToolCall[];
};

type MockChatBubbleGroup =
  | {
      kind: "assistant";
      key: string;
      messages: MockChatMessage[];
      agentName?: string;
    }
  | {
      kind: "user";
      key: string;
      message: MockChatMessage;
    };

const workspaceMocks = vi.hoisted(() => ({
  sendMessageMock: vi.fn<(message: string) => void>(),
  queueMessageMock: vi.fn<(message: string) => void>(),
  steerMessageMock: vi.fn<(message: string, queuedMessageId?: string) => void>(),
  resumeQueueMock: vi.fn(),
  removeQueuedMessageMock: vi.fn<(messageId: string) => void>(),
  clearQueuedMessagesMock: vi.fn(),
  stopAgentMock: vi.fn<(tabId: string) => void>(),
  stopMock: vi.fn(),
  setConfigMock: vi.fn(),
  setAutoApproveEditsMock: vi.fn(),
  setAutoApproveCommandsMock: vi.fn(),
  openSettingsTabMock: vi.fn<(section?: string) => void>(),
  patchAgentStateMock: vi.fn(),
  updateTabMock: vi.fn(),
  findSavedProjectMock: vi.fn(),
  inferProjectNameMock: vi.fn((path: string) => path.split("/").pop() ?? path),
  resolveSavedProjectMock: vi.fn(),
  upsertSavedProjectMock: vi.fn(),
  agentState: {
    autoApproveCommands: "no" as const,
    autoApproveEdits: false,
    chatMessages: [] as MockChatMessage[],
    config: {
      cwd: "/repo",
      model: "model-1",
      projectPath: undefined as string | undefined,
      worktreeBranch: "main",
      worktreePath: undefined as string | undefined,
    },
    contextWindowKb: null,
    contextWindowPct: null,
    error: null as string | null,
    errorAction: null as
      | null
      | {
          type: "open-settings-section";
          section: "providers";
          label: string;
        },
    clearQueuedMessages: null as null | (() => void),
    errorDetails: null as unknown,
    groupInlineToolCalls: true,
    queueMessage: null as null | ((message: string) => void),
    queueState: "idle" as "idle" | "draining" | "paused",
    queuedMessages: [] as Array<{ id: string; content: string; createdAtMs: number }>,
    removeQueuedMessage: null as null | ((messageId: string) => void),
    resumeQueue: null as null | (() => void),
    sendMessage: null as null | ((message: string) => void),
    setAutoApproveCommands: null as null | ((value: "no" | "agent" | "yes") => void),
    setAutoApproveEdits: null as null | ((value: boolean) => void),
    setConfig: null as null | ((config: unknown) => void),
    showDebug: false,
    lastRunTraceId: undefined as string | undefined,
    steerMessage: null as null | ((message: string, queuedMessageId?: string) => void),
    status: "idle" as "idle" | "thinking" | "working" | "done" | "error",
    stop: null as null | (() => void),
    tabTitle: "",
    retry: vi.fn(),
  },
  transcriptCallback: null as null | ((transcript: string) => void),
  invokeMock: vi.fn(),
  execRunMock: vi.fn(),
  readGitHeadStateMock: vi.fn(),
  stageAllGitChangesMock: vi.fn(),
  switchToGitBranchMock: vi.fn(),
  detachGitHeadMock: vi.fn(),
  upsertSessionMock: vi.fn(),
  openLogViewerWindowMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  chatBubbleGroups: [] as MockChatBubbleGroup[],
  terminalProps: null as null | {
    isOpen: boolean;
    cwd?: string;
    commandRequest?: { id: number; command: string } | null;
  },
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
    openSettingsTab: workspaceMocks.openSettingsTabMock,
    updateTab: workspaceMocks.updateTabMock,
  }),
}));

vi.mock("@/projects", () => ({
  findSavedProject: (projectPath: string) =>
    workspaceMocks.findSavedProjectMock(projectPath),
  inferProjectName: (path: string) => workspaceMocks.inferProjectNameMock(path),
  resolveSavedProject: (project: unknown) =>
    workspaceMocks.resolveSavedProjectMock(project),
  upsertSavedProject: (project: unknown) =>
    workspaceMocks.upsertSavedProjectMock(project),
}));

vi.mock("@/agent/useAgents", () => ({
  useAgent: () => workspaceMocks.agentState,
  useStopAgent: () => workspaceMocks.stopAgentMock,
}));

vi.mock("@/agent/useModels", () => ({
  useModels: () => ({
    models: [{ id: "model-1", name: "Model 1" }],
  }),
}));

vi.mock("@/agent/tools/exec", () => ({
  execRun: (...args: unknown[]) => workspaceMocks.execRunMock(...args),
}));

vi.mock("@/agent/tools/git", () => ({
  readGitHeadState: (...args: unknown[]) =>
    workspaceMocks.readGitHeadStateMock(...args),
  stageAllGitChanges: (...args: unknown[]) =>
    workspaceMocks.stageAllGitChangesMock(...args),
  switchToGitBranch: (...args: unknown[]) =>
    workspaceMocks.switchToGitBranchMock(...args),
  detachGitHead: (...args: unknown[]) =>
    workspaceMocks.detachGitHeadMock(...args),
}));

vi.mock("@/agent/persistence", () => ({
  upsertSession: (...args: unknown[]) => workspaceMocks.upsertSessionMock(...args),
}));

vi.mock("@/agent/atoms", () => ({
  patchAgentState: workspaceMocks.patchAgentStateMock,
  voiceInputEnabledAtom: {},
}));

vi.mock("@/agent/subagents", () => ({
  getAllSubagents: () => [
    {
      id: "planner",
      name: "Planner",
      icon: "assignment",
      description:
        "Analyses a task, explores the codebase, and writes a structured plan with todos.",
      triggerCommand: "/plan",
      triggerCommandDisplay: "/plan <task>",
      triggerCommandTakesArguments: true,
    },
  ],
  getSubagentThemeColorToken: () => "var(--color-primary)",
}));

vi.mock("@/agent/chatBubbleGroups", () => ({
  groupChatMessagesForBubbles: () => workspaceMocks.chatBubbleGroups,
}));

vi.mock("@/components/artifact-pane/useSessionArtifacts", () => ({
  useArtifactContentCache: () => ({
    ensureArtifactContent: vi.fn(),
    getEntry: vi.fn(),
  }),
}));

vi.mock("@/components/ArtifactPane", () => ({
  __esModule: true,
  default: ({
    onRefineEdit,
    onOpenLogs,
  }: {
    onRefineEdit: (filePath: string) => void;
    onOpenLogs: () => void;
  }) => (
    <>
      <button onClick={() => onRefineEdit("src/test.ts")}>Refine edit</button>
      <button onClick={onOpenLogs}>Open artifact logs</button>
    </>
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
  default: ({
    isOpen,
    cwd,
    commandRequest,
  }: {
    isOpen: boolean;
    cwd?: string;
    commandRequest?: { id: number; command: string } | null;
  }) => {
    workspaceMocks.terminalProps = {
      isOpen,
      cwd,
      commandRequest: commandRequest ?? null,
    };
    return (
      <div
        data-testid="terminal"
        data-open={String(isOpen)}
        data-cwd={cwd ?? ""}
        data-command={commandRequest?.command ?? ""}
      />
    );
  },
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

vi.mock("@/components/ModelPickerModal", () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="model-picker-modal">
      <button onClick={onClose}>Close picker</button>
    </div>
  ),
}));

vi.mock("@/components/CompactToolCall", () => ({
  default: () => null,
}));

vi.mock("@/logging/window", () => ({
  openLogViewerWindow: (...args: unknown[]) =>
    workspaceMocks.openLogViewerWindowMock(...args),
}));

vi.mock("@/components/ReasoningThought", () => ({
  default: () => null,
}));

vi.mock("@/components/ui", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onClick,
    disabled,
    title,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
    "aria-label"?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  ModalShell: ({
    children,
    className,
    onClick,
  }: {
    children: ReactNode;
    className?: string;
    onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  }) => (
    <div className={className} onClick={onClick}>
      {children}
    </div>
  ),
  StatusDot: ({ status }: { status: string }) => (
    <span data-testid={`status-dot-${status}`}>{status}</span>
  ),
  TextField: ({
    value,
    onChange,
    onKeyDown,
    placeholder,
    autoFocus,
  }: {
    value?: string;
    onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
    onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
    placeholder?: string;
    autoFocus?: boolean;
  }) => (
    <input
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      autoFocus={autoFocus}
    />
  ),
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

function applyLastPatch<T extends object>(state: T): T {
  const patch = workspaceMocks.patchAgentStateMock.mock.calls.at(-1)?.[1];
  if (typeof patch === "function") {
    return patch(state);
  }
  if (patch && typeof patch === "object") {
    return { ...state, ...patch };
  }
  throw new Error("Expected patchAgentState to be called with a patch");
}

function makeExecRunResult(
  overrides: Partial<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> = {},
) {
  return {
    ok: true as const,
    data: {
      command: "git",
      args: [],
      cwd: "/repo",
      exitCode: overrides.exitCode ?? 0,
      durationMs: 4,
      stdout: overrides.stdout ?? "",
      stderr: overrides.stderr ?? "",
      truncatedStdout: false,
      truncatedStderr: false,
    },
  };
}

type PatchedChatState = {
  chatMessages: Array<{ role?: string; content?: string }>;
  showDebug: boolean;
  groupInlineToolCallsOverride?: boolean | null;
  status: string;
  error: unknown;
  errorAction?: unknown;
  errorDetails: unknown;
};

describe("WorkspacePage chat input", () => {
  beforeEach(() => {
    cleanup();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    installSelectionGeometryPolyfills();
    workspaceMocks.sendMessageMock.mockReset();
    workspaceMocks.queueMessageMock.mockReset();
    workspaceMocks.steerMessageMock.mockReset();
    workspaceMocks.resumeQueueMock.mockReset();
    workspaceMocks.removeQueuedMessageMock.mockReset();
    workspaceMocks.clearQueuedMessagesMock.mockReset();
    workspaceMocks.stopAgentMock.mockReset();
    workspaceMocks.stopMock.mockReset();
    workspaceMocks.setConfigMock.mockReset();
    workspaceMocks.setAutoApproveEditsMock.mockReset();
    workspaceMocks.setAutoApproveCommandsMock.mockReset();
    workspaceMocks.openSettingsTabMock.mockReset();
    workspaceMocks.patchAgentStateMock.mockReset();
    workspaceMocks.updateTabMock.mockReset();
    workspaceMocks.findSavedProjectMock.mockReset();
    workspaceMocks.inferProjectNameMock.mockReset();
    workspaceMocks.resolveSavedProjectMock.mockReset();
    workspaceMocks.upsertSavedProjectMock.mockReset();
    workspaceMocks.transcriptCallback = null;
    workspaceMocks.eventHandlers.clear();
    workspaceMocks.terminalProps = null;
    workspaceMocks.invokeMock.mockReset();
    workspaceMocks.execRunMock.mockReset();
    workspaceMocks.readGitHeadStateMock.mockReset();
    workspaceMocks.stageAllGitChangesMock.mockReset();
    workspaceMocks.switchToGitBranchMock.mockReset();
    workspaceMocks.detachGitHeadMock.mockReset();
    workspaceMocks.upsertSessionMock.mockReset();
    workspaceMocks.openLogViewerWindowMock.mockReset();
    workspaceMocks.invokeMock.mockResolvedValue({
      matches: [
        "src/components/MentionTextarea.tsx",
        "src/utils/audio.ts",
        "README.md",
      ],
      truncated: false,
    });
    workspaceMocks.inferProjectNameMock.mockImplementation(
      (path: string) => path.split("/").pop() ?? path,
    );
    workspaceMocks.upsertSavedProjectMock.mockImplementation((project: { path: string }) => [
      project,
    ]);
    workspaceMocks.resolveSavedProjectMock.mockImplementation(async (project: unknown) => {
      const value = project as { path: string; name?: string; commands?: unknown[] };
      return {
        path: value.path,
        name: value.name ?? (value.path.split("/").pop() || value.path),
        ...(Array.isArray(value.commands) ? { commands: value.commands } : {}),
      };
    });
    workspaceMocks.execRunMock.mockResolvedValue(makeExecRunResult());
    workspaceMocks.readGitHeadStateMock.mockResolvedValue({
      ok: true,
      data: { mode: "detached" },
    });
    workspaceMocks.stageAllGitChangesMock.mockResolvedValue({
      ok: true,
      data: { staged: true },
    });
    workspaceMocks.switchToGitBranchMock.mockResolvedValue({
      ok: true,
      data: { branch: "main" },
    });
    workspaceMocks.detachGitHeadMock.mockResolvedValue({
      ok: true,
      data: { detached: true },
    });
    workspaceMocks.upsertSessionMock.mockResolvedValue(undefined);
    workspaceMocks.openLogViewerWindowMock.mockResolvedValue(true);
    workspaceMocks.chatBubbleGroups = [];
    workspaceMocks.agentState = {
      autoApproveCommands: "no",
      autoApproveEdits: false,
      chatMessages: [],
      config: {
        cwd: "/repo",
        model: "model-1",
        projectPath: undefined,
        worktreeBranch: "main",
        worktreePath: undefined,
      },
      contextWindowKb: null,
      contextWindowPct: null,
      clearQueuedMessages: workspaceMocks.clearQueuedMessagesMock,
      error: null,
      errorAction: null,
      errorDetails: null,
      groupInlineToolCalls: true,
      queueMessage: workspaceMocks.queueMessageMock,
      queueState: "idle",
      queuedMessages: [],
      removeQueuedMessage: workspaceMocks.removeQueuedMessageMock,
      resumeQueue: workspaceMocks.resumeQueueMock,
      sendMessage: workspaceMocks.sendMessageMock,
      setAutoApproveCommands: workspaceMocks.setAutoApproveCommandsMock,
      setAutoApproveEdits: workspaceMocks.setAutoApproveEditsMock,
      setConfig: workspaceMocks.setConfigMock,
      showDebug: false,
      lastRunTraceId: undefined,
      steerMessage: workspaceMocks.steerMessageMock,
      status: "idle",
      stop: workspaceMocks.stopMock,
      tabTitle: "",
      retry: vi.fn(),
    };
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

  it("shows a stop button while busy when the composer is empty", () => {
    workspaceMocks.agentState.status = "thinking";

    render(<WorkspacePage />);

    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    });

    expect(workspaceMocks.stopAgentMock).toHaveBeenCalledWith("tab-1");
  });

  it("opens the detached viewer from the debug pane on the latest run trace", () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      lastRunTraceId: "trace-run-42",
    };

    render(<WorkspacePage />);

    fireEvent.click(screen.getByRole("button", { name: "Open artifact logs" }));

    expect(workspaceMocks.openLogViewerWindowMock).toHaveBeenCalledWith({
      origin: "debug-pane",
      filter: { traceId: "trace-run-42" },
    });
  });

  it("opens assistant trace logs from the chat bubble action", async () => {
    workspaceMocks.chatBubbleGroups = [
      {
        kind: "assistant",
        key: "assistant:msg-1",
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "Finished the run.",
            timestamp: 1,
            traceId: "trace-assistant-1",
          },
        ],
      },
    ];

    render(<WorkspacePage />);

    fireEvent.click(screen.getByRole("button", { name: "VIEW TRACE LOGS" }));

    await waitFor(() => {
      expect(workspaceMocks.openLogViewerWindowMock).toHaveBeenCalledWith({
        origin: "assistant-message",
        filter: { traceId: "trace-assistant-1" },
      });
    });
  });

  it("opens tool correlation logs from grouped tool call rows without debug mode", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      showDebug: false,
    };
    workspaceMocks.chatBubbleGroups = [
      {
        kind: "assistant",
        key: "assistant:msg-2",
        messages: [
          {
            id: "msg-2",
            role: "assistant",
            content: "Checked the workspace.",
            timestamp: 2,
            toolCalls: [
              {
                id: "tc-1",
                tool: "workspace_listDir",
                args: { path: "src" },
                status: "done",
              },
              {
                id: "tc-2",
                tool: "workspace_readFile",
                args: { path: "README.md" },
                status: "done",
              },
            ],
          },
        ],
      },
    ];

    render(<WorkspacePage />);

    fireEvent.click(screen.getByRole("button", { name: "Open logs" }));

    await waitFor(() => {
      expect(workspaceMocks.openLogViewerWindowMock).toHaveBeenCalledWith({
        origin: "tool-call",
        filter: { correlationId: "tc-2" },
      });
    });
  });

  it("groups inline tool calls across assistant messages in the same bubble when no visible block separates them", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      showDebug: false,
    };
    workspaceMocks.chatBubbleGroups = [
      {
        kind: "assistant",
        key: "assistant:msg-grouped-inline",
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "",
            timestamp: 1,
            toolCalls: [
              {
                id: "tc-1",
                tool: "workspace_listDir",
                args: { path: "src" },
                status: "done",
              },
            ],
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "",
            timestamp: 2,
            toolCalls: [
              {
                id: "tc-2",
                tool: "workspace_readFile",
                args: { path: "README.md" },
                status: "done",
              },
            ],
          },
        ],
      },
    ];

    render(<WorkspacePage />);

    const openLogsButtons = screen.getAllByRole("button", { name: "Open logs" });
    expect(openLogsButtons).toHaveLength(1);

    fireEvent.click(openLogsButtons[0]);

    await waitFor(() => {
      expect(workspaceMocks.openLogViewerWindowMock).toHaveBeenCalledWith({
        origin: "tool-call",
        filter: { correlationId: "tc-2" },
      });
    });
  });

  it("keeps the send button available while busy when text is queued", async () => {
    workspaceMocks.agentState.status = "working";

    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("follow up");

    await waitFor(() => {
      expect(textbox.textContent).toBe("follow up");
    });

    expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(workspaceMocks.queueMessageMock).toHaveBeenCalledWith("follow up");
    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop agent" })).not.toBeNull();
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

  it("injects local help content for /help without sending a message", async () => {
    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("/help");

    await waitFor(() => {
      expect(textbox.textContent).toBe("/help");
    });

    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();
    const nextState = applyLastPatch<PatchedChatState>({
      chatMessages: [],
      showDebug: false,
      status: "idle",
      error: null,
      errorDetails: null,
    });
    expect(nextState.chatMessages).toHaveLength(1);
    expect(nextState.chatMessages[0]?.role).toBe("assistant");
    expect(nextState.chatMessages[0]?.content).toContain("**Available slash commands:**");
    expect(nextState.chatMessages[0]?.content).toContain("`/plan <task>`");
    expect(nextState.chatMessages[0]?.content).toContain("`/toggle-group-tools`");
  });

  it("treats /? as an alias for /help", async () => {
    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("/?");

    await waitFor(() => {
      expect(textbox.textContent).toBe("/?");
    });

    fireEvent.keyDown(textbox, { key: "Enter" });

    await waitFor(() => {
      expect(workspaceMocks.patchAgentStateMock).toHaveBeenCalled();
    });

    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();
    const nextState = applyLastPatch<PatchedChatState>({
      chatMessages: [],
      showDebug: false,
      status: "idle",
      error: null,
      errorDetails: null,
    });
    expect(nextState.chatMessages[0]?.content).toContain("`/help`");
  });

  it("accepts /plan from the slash menu before submitting it on the next Enter", async () => {
    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("/pl");

    await waitFor(() => {
      expect(screen.getByText("/plan <task>")).not.toBeNull();
    });

    fireEvent.keyDown(textbox, { key: "Enter" });

    await waitFor(() => {
      expect(textbox.textContent).toBe("/plan ");
    });
    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();

    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(workspaceMocks.sendMessageMock).toHaveBeenCalledWith("/plan");
  });

  it("opens the model picker modal on /model without sending a message", async () => {
    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("/model");

    await waitFor(() => {
      expect(textbox.textContent).toBe("/model");
    });

    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId("model-picker-modal")).not.toBeNull();
    });
  });

  it("keeps the local /debug toggle behavior", async () => {
    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("/debug");

    await waitFor(() => {
      expect(textbox.textContent).toBe("/debug");
    });

    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();
    const nextState = applyLastPatch({
      showDebug: false,
    });
    expect(nextState.showDebug).toBe(true);
  });

  it("toggles grouped inline tool calls for the current session", async () => {
    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("/toggle-group-tools");

    await waitFor(() => {
      expect(textbox.textContent).toBe("/toggle-group-tools");
    });

    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();
    const nextState = applyLastPatch<PatchedChatState>({
      chatMessages: [],
      showDebug: false,
      groupInlineToolCallsOverride: null,
      status: "idle",
      error: null,
      errorDetails: null,
    });
    expect(nextState.groupInlineToolCallsOverride).toBe(false);
    expect(nextState.chatMessages).toHaveLength(0);
  });

  it("renders quick actions for the current cwd and invokes native launch commands", async () => {
    render(<WorkspacePage />);

    const openInEditorButton = await screen.findByRole("button", {
      name: "Open in Editor",
    });
    const openShellButton = screen.getByRole("button", { name: "Open Shell" });
    expect(screen.getByText("Open in Editor")).not.toBeNull();
    expect(screen.getByText("Open Shell")).not.toBeNull();

    workspaceMocks.invokeMock.mockClear();
    workspaceMocks.invokeMock.mockResolvedValue(undefined);

    fireEvent.click(openInEditorButton);
    await waitFor(() => {
      expect(workspaceMocks.invokeMock).toHaveBeenCalledWith("open_in_editor", {
        cwd: "/repo",
      });
    });

    fireEvent.click(openShellButton);
    await waitFor(() => {
      expect(workspaceMocks.invokeMock).toHaveBeenCalledWith("open_shell", {
        cwd: "/repo",
      });
    });
  });

  it("shows handoff in the command bar for managed worktrees and opens the modal", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      config: {
        ...workspaceMocks.agentState.config,
        worktreePath: "/repo/.rakh/feat-session",
        worktreeBranch: "feat/session",
      },
    };
    workspaceMocks.readGitHeadStateMock.mockResolvedValue({
      ok: true,
      data: { mode: "branch", branch: "feat/session" },
    });
    workspaceMocks.execRunMock.mockResolvedValue(
      makeExecRunResult({ stdout: " M src/app.ts\n" }),
    );

    render(<WorkspacePage />);

    const handoffButton = await screen.findByRole("button", {
      name: "Handoff",
    });
    await waitFor(() => {
      expect(handoffButton.hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(handoffButton);

    expect(screen.getByDisplayValue("changes from rakh")).not.toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Handoff session branch" }).textContent,
    ).toContain("feat/session");
  });

  it("re-enables handoff after the worktree holds the branch again", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      status: "working",
      chatMessages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          toolCalls: [
            {
              id: "tc-1",
              tool: "workspace_writeFile",
              args: {},
              status: "awaiting_branch_release",
            },
          ],
        },
      ],
      config: {
        ...workspaceMocks.agentState.config,
        worktreePath: "/repo/.rakh/feat-session",
        worktreeBranch: "feat/session",
      },
    };
    workspaceMocks.readGitHeadStateMock
      .mockResolvedValueOnce({
        ok: true,
        data: { mode: "detached" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { mode: "branch", branch: "feat/session" },
      });
    workspaceMocks.execRunMock.mockResolvedValue(
      makeExecRunResult({ stdout: " M src/app.ts\n" }),
    );

    const view = render(<WorkspacePage />);
    const handoffButton = await screen.findByRole("button", {
      name: "Handoff",
    });

    await waitFor(() => {
      expect(handoffButton.hasAttribute("disabled")).toBe(true);
    });

    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      chatMessages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          toolCalls: [
            {
              id: "tc-1",
              tool: "workspace_writeFile",
              args: {},
              status: "done",
            },
          ],
        },
      ],
    };

    view.rerender(<WorkspacePage />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Handoff" }).hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  it("renders project commands and opens the terminal when one is executed", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      config: {
        ...workspaceMocks.agentState.config,
        projectPath: "/repo",
      },
    };
    workspaceMocks.findSavedProjectMock.mockReturnValue({
      path: "/repo",
      name: "Repo",
    });
    workspaceMocks.resolveSavedProjectMock.mockResolvedValue({
      path: "/repo",
      name: "Repo",
      commands: [
        {
          id: "app",
          label: "App",
          command: "npm run dev",
          icon: "play_arrow",
        },
        {
          id: "lint",
          label: "Lint",
          command: "npm run lint",
          icon: "rule",
          showLabel: false,
        },
      ],
    });

    render(<WorkspacePage />);

    const appButton = await screen.findByRole("button", { name: "Run App" });
    expect(screen.getByText("App")).not.toBeNull();
    expect(screen.queryByText("Lint")).toBeNull();
    expect(screen.getByRole("button", { name: "Run Lint" })).not.toBeNull();
    expect(screen.getByText("Toggle")).not.toBeNull();
    expect(screen.getByText("⌘", { selector: "kbd" })).not.toBeNull();
    expect(screen.getByText("B", { selector: "kbd" })).not.toBeNull();

    fireEvent.click(appButton);

    await waitFor(() => {
      expect(screen.getByTestId("terminal").getAttribute("data-open")).toBe("true");
    });
    expect(screen.getByTestId("terminal").getAttribute("data-command")).toBe(
      "npm run dev",
    );
  });

  it("toggles the project command bar with Cmd+B", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      config: {
        ...workspaceMocks.agentState.config,
        projectPath: "/repo",
      },
    };
    workspaceMocks.findSavedProjectMock.mockReturnValue({
      path: "/repo",
      name: "Repo",
    });
    workspaceMocks.resolveSavedProjectMock.mockResolvedValue({
      path: "/repo",
      name: "Repo",
      commands: [
        {
          id: "app",
          label: "App",
          command: "npm run dev",
          icon: "play_arrow",
        },
      ],
    });

    render(<WorkspacePage />);

    await screen.findByRole("button", { name: "Run App" });
    expect(screen.getByText("Toggle")).not.toBeNull();
    expect(screen.getByText("⌘", { selector: "kbd" })).not.toBeNull();
    expect(screen.getByText("B", { selector: "kbd" })).not.toBeNull();

    fireEvent.keyDown(window, { key: "b", metaKey: true });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Run App" })).toBeNull();
    });
    expect(screen.queryByText("Toggle")).toBeNull();

    fireEvent.keyDown(window, { key: "b", metaKey: true });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Run App" })).not.toBeNull();
    });
  });

  it("does not show the queue strip while the agent is busy with no submitted follow-up", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      status: "working",
    };

    await act(async () => {
      render(<WorkspacePage />);
    });

    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    expect(screen.queryByText("Working")).toBeNull();
  });

  it("does not show a queued row while the user is only typing during a busy run", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      status: "working",
    };

    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("Need the repro steps before phase 2.");

    await waitFor(() => {
      expect(textbox.textContent).toBe("Need the repro steps before phase 2.");
    });

    expect(screen.queryByText("Queued 1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    expect(workspaceMocks.queueMessageMock).not.toHaveBeenCalled();
  });

  it("uses Enter to queue a real follow-up while busy", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      status: "thinking",
    };

    render(<WorkspacePage />);

    const textbox = screen.getByRole("textbox");
    setTextboxRect(textbox);

    emitTranscript("Pause after the UI slice for review.");

    await waitFor(() => {
      expect(textbox.textContent).toBe("Pause after the UI slice for review.");
    });

    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(workspaceMocks.queueMessageMock).toHaveBeenCalledWith(
      "Pause after the UI slice for review.",
    );
    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();
  });

  it("lets the user remove a queued follow-up", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      queuedMessages: [
        {
          id: "queued-1",
          content: "First queued follow-up item.",
          createdAtMs: 100,
        },
      ],
      queueState: "draining",
    };

    render(<WorkspacePage />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove queued note 1" }));
    });

    expect(workspaceMocks.removeQueuedMessageMock).toHaveBeenCalledWith("queued-1");
  });

  it("sends a queued follow-up immediately when Send now is pressed", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      queuedMessages: [
        {
          id: "queued-1",
          content: "Interrupt this run and use the corrected title.",
          createdAtMs: 100,
        },
      ],
      queueState: "draining",
    };

    render(<WorkspacePage />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    });

    expect(workspaceMocks.steerMessageMock).toHaveBeenCalledWith(
      "Interrupt this run and use the corrected title.",
      "queued-1",
    );
    expect(workspaceMocks.sendMessageMock).not.toHaveBeenCalled();
  });

  it("renders paused queue controls in the fixed input area", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      queueState: "paused",
      queuedMessages: [
        {
          id: "queued-1",
          content: "Wait for approval before changing the runner behavior.",
          createdAtMs: 100,
        },
      ],
    };

    await act(async () => {
      render(<WorkspacePage />);
    });

    expect(screen.getByText("Paused")).not.toBeNull();
    expect(
      screen.getByText("Wait for approval before changing the runner behavior."),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Resume" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clear" })).not.toBeNull();
    expect(screen.getByText("Paused")?.closest(".chat-input-wrap")).not.toBeNull();
  });

  it("opens AI Providers from the error banner action", async () => {
    workspaceMocks.agentState = {
      ...workspaceMocks.agentState,
      error: "No OpenAI API key.",
      errorAction: {
        type: "open-settings-section",
        section: "providers",
        label: "Open AI Providers",
      },
      status: "error",
    };

    await act(async () => {
      render(<WorkspacePage />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Open AI Providers" }));

    expect(workspaceMocks.openSettingsTabMock).toHaveBeenCalledWith("providers");
  });
});
