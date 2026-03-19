import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type SetStateAction,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { AttachedImage } from "@/agent/types";
import { useAtomValue } from "jotai";
import ArtifactPane, { useArtifactUpdates } from "@/components/ArtifactPane";
import ConversationCards from "@/components/ConversationCards";
import Terminal from "@/components/Terminal";
import UserMessage from "@/components/UserMessage";
import AgentMessage from "@/components/AgentMessage";
import ToolCallApproval from "@/components/ToolCallApproval";
import CopyableCodePill from "@/components/CopyableCodePill";
import UserInputCard from "@/components/UserInputCard";
import Markdown from "@/components/Markdown";
import NewSession from "@/components/NewSession";
import ChatControls from "@/components/ChatControls";
import AutoScrollArea from "@/components/AutoScrollArea";
import BusyComposerTray from "@/components/BusyComposerTray";
import ErrorDetailsModal, {
  type ErrorModalState,
} from "@/components/ErrorDetailsModal";
import ProjectSettingsModal, {
  type ProjectSettingsSavePayload,
} from "@/components/ProjectSettingsModal";
import ToolCallDetailsModal from "@/components/ToolCallDetailsModal";
import ModelPickerModal from "@/components/ModelPickerModal";
import CompactToolCall from "@/components/CompactToolCall";
import GroupedInlineToolCall from "@/components/GroupedInlineToolCall";
import ReasoningThought from "@/components/ReasoningThought";
import ProjectCommandBar from "@/components/ProjectCommandBar";
import GitHubIssuesControl from "@/components/GitHubIssuesControl";
import {
  MentionTextarea,
  type MentionTextareaHandle,
} from "@/components/MentionTextarea";
import { Button, IconButton, ModalShell, TextField } from "@/components/ui";
import {
  VoiceInputRecordingRow,
  VoiceInputStateProvider,
  VoiceInputStatusSlot,
  VoiceInputToggleButton,
} from "@/components/voice-input/VoiceInputUi";
import { useVoiceInputController } from "@/components/voice-input/useVoiceInputController";
import { useTabs, type Tab } from "@/contexts/TabsContext";
import { useAgent, useStopAgent } from "@/agent/useAgents";
import { useModels } from "@/agent/useModels";
import {
  getAgentState,
  patchAgentState,
  setGlobalDebugMode,
  voiceInputEnabledAtom,
} from "@/agent/atoms";
import {
  formatSlashCommandHelpMarkdown,
  getSlashCommandCatalog,
  matchesSlashCommandInput,
} from "@/agent/slashCommands";
import { getAllSubagents, getSubagentThemeColorToken } from "@/agent/subagents";
import {
  groupChatMessagesForBubbles,
  type ChatBubbleGroup,
} from "@/agent/chatBubbleGroups";
import {
  bubbleGroupContainsStreaming,
  buildForkedAgentState,
  serializeChatBubbleGroupAsMarkdown,
} from "@/agent/chatBubbleActions";
import { useArtifactContentCache } from "@/components/artifact-pane/useSessionArtifacts";
import {
  buildToolCallRenderItemsByMessage,
  type ToolCallRenderKind,
  type ToolCallRenderItem,
} from "@/components/toolCallRenderItems";
import { AnimatePresence, motion } from "framer-motion";
import type { ToolCallDisplay } from "@/agent/types";
import {
  DEFAULT_PROJECT_ICON,
  findSavedProject,
  inferProjectName,
  resolveSavedProject,
  upsertSavedProject,
  upsertSavedProjectPreservingLearnedFacts,
  type SavedProject,
} from "@/projects";
import { probeGitHubRepository } from "@/githubIntegration";
import {
  writeProjectScriptsConfig,
  type ProjectCommandConfig,
} from "@/projectScripts";
import { execRun } from "@/agent/tools/exec";
import { replaceSessionTodos } from "@/agent/tools/todos";
import { cloneSessionArtifacts } from "@/agent/tools/artifacts";
import {
  detachGitHead,
  readGitHeadState,
  stageAllGitChanges,
  switchToGitBranch,
} from "@/agent/tools/git";
import { upsertSession } from "@/agent/persistence";
import { cn } from "@/utils/cn";
import {
  DEFAULT_LOG_VIEWER_LEVELS,
  openLogViewerWindow,
} from "@/logging/window";

const OPEN_IN_EDITOR_COMMAND_ID = "__open-in-editor__";
const OPEN_SHELL_COMMAND_ID = "__open-shell__";
const DEFAULT_HANDOFF_COMMIT_MESSAGE = "changes from rakh";
const COPY_BUBBLE_SUCCESS_DURATION_MS = 2500;

interface WorktreeHandoffState {
  loading: boolean;
  branchHeld: boolean;
  hasChanges: boolean;
  error: string | null;
}

interface ProjectGitHubState {
  enabled: boolean;
  repoSlug: string | null;
  eligible: boolean;
}

const IDLE_WORKTREE_HANDOFF_STATE: WorktreeHandoffState = {
  loading: false,
  branchHeld: false,
  hasChanges: false,
  error: null,
};

const EMPTY_PROJECT_GITHUB_STATE: ProjectGitHubState = {
  enabled: false,
  repoSlug: null,
  eligible: false,
};

interface WorktreeHandoffModalProps {
  branch: string;
  commitMessage: string;
  status: { type: "idle" | "running" | "error"; message?: string };
  onChangeCommitMessage: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

function WorktreeHandoffModal({
  branch,
  commitMessage,
  status,
  onChangeCommitMessage,
  onClose,
  onConfirm,
}: WorktreeHandoffModalProps) {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && status.type !== "running") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, status.type]);

  return createPortal(
    <div
      className="error-modal-backdrop"
      onClick={status.type === "running" ? undefined : onClose}
      role="dialog"
      aria-modal
      aria-label="Handoff session branch"
    >
      <ModalShell
        className="error-modal tool-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="error-modal-header">
          <span className="error-modal-title tool-modal-title">
            <span className="material-symbols-outlined text-muted shrink-0 text-md">
              move_item
            </span>
            Handoff
            <span className="text-xxs font-normal tracking-[0.04em] text-muted normal-case opacity-70">
              {branch}
            </span>
          </span>
          <Button
            className="error-modal-close"
            onClick={onClose}
            title="Close (Esc)"
            variant="ghost"
            size="xxs"
            disabled={status.type === "running"}
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </Button>
        </div>

        <div className="error-modal-body flex flex-col gap-4">
          <div className="tool-modal-section">
            <div className="tool-modal-section-label">Session branch</div>
            <CopyableCodePill value={branch} label="session branch" />
          </div>
          <div className="tool-modal-section">
            <div className="tool-modal-section-label">Commit message</div>
            <TextField
              autoFocus
              value={commitMessage}
              onChange={(event) => onChangeCommitMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (status.type !== "running" && commitMessage.trim()) {
                    onConfirm();
                  }
                }
              }}
              placeholder={DEFAULT_HANDOFF_COMMIT_MESSAGE}
            />
          </div>
          {status.type === "error" ? (
            <div className="text-xxs text-error whitespace-pre-wrap break-words">
              {status.message}
            </div>
          ) : null}
        </div>

        <div className="error-modal-footer">
          <Button
            onClick={onClose}
            variant="ghost"
            size="xxs"
            disabled={status.type === "running"}
          >
            CANCEL
          </Button>
          <Button
            onClick={onConfirm}
            variant="primary"
            size="xxs"
            loading={status.type === "running"}
            disabled={!commitMessage.trim()}
          >
            COMMIT
          </Button>
        </div>
      </ModalShell>
    </div>,
    document.body,
  );
}

async function readWorktreeHandoffState(
  gitPath: string,
  sessionBranch: string,
): Promise<WorktreeHandoffState> {
  const [headResult, statusResult] = await Promise.all([
    readGitHeadState(gitPath),
    execRun(gitPath, {
      command: "git",
      args: ["status", "--porcelain"],
      timeoutMs: 10_000,
      maxStdoutBytes: 12_000,
      maxStderrBytes: 12_000,
    }),
  ]);

  const branchHeld =
    headResult.ok &&
    headResult.data.mode === "branch" &&
    headResult.data.branch === sessionBranch;
  const hasChanges =
    statusResult.ok && statusResult.data.stdout.trim().length > 0;
  const error = !headResult.ok
    ? headResult.error.message
    : !statusResult.ok
      ? statusResult.error.message
      : null;

  return {
    loading: false,
    branchHeld,
    hasChanges,
    error,
  };
}

function renderCompactToolCall(
  item: {
    kind: "tool";
    toolCall: ToolCallDisplay;
    renderKind: ToolCallRenderKind;
  },
  cwd: string | undefined,
  showDebug: boolean,
  setToolDetailsModal: (toolCall: ToolCallDisplay) => void,
  onOpenLogs: (toolCall: ToolCallDisplay) => void,
) {
  const toolCall = item.toolCall;
  return (
    <CompactToolCall
      key={toolCall.id}
      tc={toolCall}
      onInspect={() => setToolDetailsModal(toolCall)}
      onOpenLogs={() => onOpenLogs(toolCall)}
      cwd={cwd}
      showDebug={showDebug}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Page
───────────────────────────────────────────────────────────────────────────── */

export default function WorkspacePage() {
  const { tabs, activeTabId, addTab, openSettingsTab, updateTab } = useTabs();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isNewSession = activeTab?.mode !== "workspace";
  const persistActiveTabChanges = useCallback(
    async (changes: Partial<Tab>) => {
      if (!activeTab) return;
      updateTab(activeTabId, changes);
      const nextTab: Tab = { ...activeTab, ...changes };
      if (nextTab.mode === "workspace") {
        await upsertSession(nextTab);
      }
    },
    [activeTab, activeTabId, updateTab],
  );
  const artifactInventoryEnabled = activeTab?.mode === "workspace";
  const voiceInputEnabled = useAtomValue(voiceInputEnabledAtom);

  // Agent state — always called (hooks must not be conditional)
  const agent = useAgent(activeTabId);
  const stopAgent = useStopAgent();
  const isAgentBusy = agent.status === "thinking" || agent.status === "working";
  const { models } = useModels();

  const [inputByTab, setInputByTab] = useState<Record<string, string>>({});
  const input = inputByTab[activeTabId] ?? "";
  const setInput = useCallback(
    (next: SetStateAction<string>) => {
      setInputByTab((prev) => {
        const current = prev[activeTabId] ?? "";
        const resolved =
          typeof next === "function"
            ? (next as (prevState: string) => string)(current)
            : next;
        if (resolved === current) return prev;
        return { ...prev, [activeTabId]: resolved };
      });
    },
    [activeTabId],
  );
  const [attachedImagesByTab, setAttachedImagesByTab] = useState<
    Record<string, AttachedImage[]>
  >({});
  const attachedImages = useMemo(
    () => attachedImagesByTab[activeTabId] ?? [],
    [attachedImagesByTab, activeTabId],
  );

  const addAttachedImages = useCallback(
    async (files: File[]) => {
      const readAsDataUrl = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      const newImages = await Promise.all(
        files.map(async (file) => ({
          id: Math.random().toString(36).slice(2) + Date.now().toString(36),
          name: file.name,
          previewUrl: await readAsDataUrl(file),
          mimeType: file.type || "image/",
        })),
      );
      setAttachedImagesByTab((prev) => ({
        ...prev,
        [activeTabId]: [...(prev[activeTabId] ?? []), ...newImages],
      }));
    },
    [activeTabId],
  );

  const removeAttachedImage = useCallback(
    (id: string) => {
      setAttachedImagesByTab((prev) => {
        const current = prev[activeTabId] ?? [];
        const removed = current.find((img) => img.id === id);
        if (removed?.previewUrl.startsWith("blob:"))
          URL.revokeObjectURL(removed.previewUrl);
        return {
          ...prev,
          [activeTabId]: current.filter((img) => img.id !== id),
        };
      });
    },
    [activeTabId],
  );

  const clearAttachedImages = useCallback(() => {
    setAttachedImagesByTab((prev) => {
      const current = prev[activeTabId] ?? [];
      for (const img of current) {
        if (img.previewUrl.startsWith("blob:"))
          URL.revokeObjectURL(img.previewUrl);
      }
      return { ...prev, [activeTabId]: [] };
    });
  }, [activeTabId]);

  const handleImagePathDrop = useCallback(
    async (paths: string[]) => {
      const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
      const newImages = await Promise.all(
        paths.map(async (filePath) => {
          const result = await tauriInvoke<{ data: string; mimeType: string }>(
            "read_file_base64",
            { path: filePath },
          );
          const dataUrl = `data:${result.mimeType};base64,${result.data}`;
          const name = filePath.split("/").pop() ?? filePath;
          return {
            id: Math.random().toString(36).slice(2) + Date.now().toString(36),
            name,
            previewUrl: dataUrl,
            mimeType: result.mimeType,
          } satisfies AttachedImage;
        }),
      );
      setAttachedImagesByTab((prev) => ({
        ...prev,
        [activeTabId]: [...(prev[activeTabId] ?? []), ...newImages],
      }));
    },
    [activeTabId],
  );

  const [isChatDropActive, setIsChatDropActive] = useState(false);

  const [leftWidth, setLeftWidth] = useState(70);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [artifactOpen, setArtifactOpen] = useState(true);
  const [errorModal, setErrorModal] = useState<ErrorModalState | null>(null);
  const [toolDetailsModal, setToolDetailsModal] =
    useState<ToolCallDisplay | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [projectSettingsProject, setProjectSettingsProject] =
    useState<SavedProject | null>(null);
  const [projectCommands, setProjectCommands] = useState<
    ProjectCommandConfig[]
  >([]);
  const [projectGitHubState, setProjectGitHubState] =
    useState<ProjectGitHubState>(EMPTY_PROJECT_GITHUB_STATE);
  const [terminalCommandRequest, setTerminalCommandRequest] = useState<{
    id: number;
    command: string;
  } | null>(null);
  const [handoffModalOpen, setHandoffModalOpen] = useState(false);
  const [handoffCommitMessage, setHandoffCommitMessage] = useState(
    DEFAULT_HANDOFF_COMMIT_MESSAGE,
  );
  const [handoffStatus, setHandoffStatus] = useState<{
    type: "idle" | "running" | "error";
    message?: string;
  }>({ type: "idle" });
  const [handoffState, setHandoffState] = useState<WorktreeHandoffState>(
    IDLE_WORKTREE_HANDOFF_STATE,
  );
  const [reasoningExpandedById, setReasoningExpandedById] = useState<
    Record<string, boolean>
  >({});
  const terminalCommandRequestIdRef = useRef(0);
  const cwd = agent.config.cwd.trim();
  const worktreePath = agent.config.worktreePath?.trim() ?? "";
  const worktreeBranch = agent.config.worktreeBranch?.trim() ?? "";
  const hasManagedWorktree =
    worktreePath.length > 0 && worktreeBranch.length > 0;

  // Track unseen updates even when pane is collapsed
  const {
    activeTab: activeArtifactTab,
    unseenTabs,
    handleTabClick,
    artifactInventory,
    artifactInventoryLoading,
    artifactInventoryError,
  } = useArtifactUpdates(
    activeTabId,
    artifactInventoryEnabled,
    !artifactOpen,
    agent.showDebug ?? false,
  );
  const artifactHasUpdates = unseenTabs.size > 0;
  const { getEntry: getArtifactContentEntry, ensureArtifactContent } =
    useArtifactContentCache(activeTabId);
  const worktreeToolCallStatusKey = useMemo(
    () =>
      agent.chatMessages
        .flatMap((message) => message.toolCalls ?? [])
        .map((toolCall) => `${toolCall.id}:${toolCall.status}`)
        .join("|"),
    [agent.chatMessages],
  );

  // Chat controls state
  const contextWindowPct = agent.contextWindowPct;
  const contextWindowKb = agent.contextWindowKb;
  const chatBubbleGroups = useMemo(
    () => groupChatMessagesForBubbles(agent.chatMessages),
    [agent.chatMessages],
  );
  const [copiedBubbleKey, setCopiedBubbleKey] = useState<string | null>(null);
  const copyBubbleResetTimeoutRef = useRef<number | null>(null);
  const subagentMetaByName = useMemo(() => {
    const byName = new Map<string, { color: string; icon: string }>();
    for (const subagent of getAllSubagents()) {
      byName.set(subagent.name, {
        color: getSubagentThemeColorToken(subagent.id),
        icon: subagent.icon,
      });
    }
    return byName;
  }, []);
  const slashCommands = useMemo(() => getSlashCommandCatalog(), []);
  const helpCommand = useMemo(
    () => slashCommands.find((command) => command.command === "/help") ?? null,
    [slashCommands],
  );
  useEffect(() => {
    return () => {
      if (copyBubbleResetTimeoutRef.current !== null) {
        window.clearTimeout(copyBubbleResetTimeoutRef.current);
      }
    };
  }, []);
  const handleCopyBubbleMarkdown = useCallback(async (group: ChatBubbleGroup) => {
    const markdown = serializeChatBubbleGroupAsMarkdown(group);
    if (!markdown || !navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopiedBubbleKey(group.key);
      if (copyBubbleResetTimeoutRef.current !== null) {
        window.clearTimeout(copyBubbleResetTimeoutRef.current);
      }
      copyBubbleResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedBubbleKey((current) => (current === group.key ? null : current));
        copyBubbleResetTimeoutRef.current = null;
      }, COPY_BUBBLE_SUCCESS_DURATION_MS);
      return true;
    } catch {
      // Clipboard copy is a convenience action.
      return false;
    }
  }, []);
  const handleForkBubble = useCallback(
    async (group: ChatBubbleGroup) => {
      if (!activeTab || activeTab.mode !== "workspace") return;

      const messageIds =
        group.kind === "user"
          ? [group.message.id]
          : group.messages.map((message) => message.id);
      const forkedState = buildForkedAgentState(
        getAgentState(activeTabId),
        messageIds,
      );
      if (!forkedState) return;

      const nextLabelBase = activeTab.label.trim() || "Session";
      const nextLabel = `${nextLabelBase} fork`;
      const nextTabId = addTab({
        mode: "workspace",
        label: nextLabel,
        icon: activeTab.icon,
        status: "idle",
      });
      const nextTab: Tab = {
        id: nextTabId,
        label: nextLabel,
        icon: activeTab.icon,
        status: "idle",
        mode: "workspace",
      };

      patchAgentState(nextTabId, () => forkedState);

      await upsertSession(nextTab);
      await Promise.all([
        replaceSessionTodos(nextTabId, forkedState.todos),
        cloneSessionArtifacts(activeTabId, nextTabId),
      ]);
    },
    [activeTab, activeTabId, addTab],
  );
  const textareaRef = useRef<MentionTextareaHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  // Sync agent status → tab status (so TopChrome indicator stays current)
  useEffect(() => {
    updateTab(activeTabId, { status: agent.status });
  }, [agent.status, activeTabId, updateTab]);

  // Sync agent tabTitle → tab label (format: "<folder> [branch] :: <title>" or just "<folder>")
  useEffect(() => {
    const cwd = agent.config.cwd;
    if (!cwd) return; // still in new-session mode
    const folder = cwd.split("/").filter(Boolean).pop() ?? cwd;
    const branch = agent.config.worktreeBranch;
    const branchStr = branch ? ` [${branch}]` : "";
    const label = agent.tabTitle
      ? `${folder}${branchStr} :: ${agent.tabTitle}`
      : `${folder}${branchStr}`;
    updateTab(activeTabId, { label });
  }, [
    agent.tabTitle,
    agent.config.cwd,
    agent.config.worktreeBranch,
    activeTabId,
    updateTab,
  ]);

  // Auto-focus chat input when switching from new session to workspace
  useEffect(() => {
    if (!isNewSession) {
      textareaRef.current?.focus();
    }
  }, [isNewSession]);

  useEffect(() => {
    if (isNewSession) {
      setProjectCommands([]);
      setProjectGitHubState(EMPTY_PROJECT_GITHUB_STATE);
      return;
    }

    const projectPath = agent.config.projectPath?.trim();
    if (!projectPath) {
      setProjectCommands([]);
      setProjectGitHubState(EMPTY_PROJECT_GITHUB_STATE);
      return;
    }

    let cancelled = false;
    const savedProject = findSavedProject(projectPath) ?? {
      path: projectPath,
      name: inferProjectName(projectPath),
      icon: DEFAULT_PROJECT_ICON,
    };

    void Promise.all([
      resolveSavedProject(savedProject),
      probeGitHubRepository(projectPath),
    ])
      .then(([resolvedProject, githubProbe]) => {
        if (cancelled) return;
        const nextIcon = resolvedProject.icon || DEFAULT_PROJECT_ICON;
        setProjectCommands(resolvedProject.commands ?? []);
        setProjectGitHubState({
          enabled: Boolean(resolvedProject.githubIntegrationEnabled),
          repoSlug: githubProbe.repoSlug,
          eligible: githubProbe.eligible,
        });
        if (activeTab?.mode === "workspace" && activeTab.icon !== nextIcon) {
          void persistActiveTabChanges({ icon: nextIcon });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setProjectCommands([]);
        setProjectGitHubState(EMPTY_PROJECT_GITHUB_STATE);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, agent.config.projectPath, isNewSession, persistActiveTabChanges]);

  const toggleTerminal = useCallback(() => setTerminalOpen((v) => !v), []);
  const openTerminal = useCallback(() => setTerminalOpen(true), []);
  const toggleArtifacts = useCallback(() => setArtifactOpen((v) => !v), []);
  const handleOpenLatestLogs = useCallback(() => {
    void openLogViewerWindow({
      origin: "debug-pane",
      filter: agent.lastRunTraceId
        ? { traceId: agent.lastRunTraceId, levels: DEFAULT_LOG_VIEWER_LEVELS }
        : { levels: DEFAULT_LOG_VIEWER_LEVELS },
    });
  }, [agent.lastRunTraceId]);
  const handleOpenAssistantLogs = useCallback((traceId: string) => {
    void openLogViewerWindow({
      origin: "assistant-message",
      filter: { traceId, levels: DEFAULT_LOG_VIEWER_LEVELS },
    });
  }, []);
  const handleOpenFileReferenceError = useCallback((details: unknown) => {
    setErrorModal({
      title: "Could not open editor",
      details,
    });
  }, []);
  const renderBubbleActions = useCallback(
    (group: ChatBubbleGroup) => {
      const forkDisabled = bubbleGroupContainsStreaming(group);
      const copied = copiedBubbleKey === group.key;
      const traceId =
        group.kind === "assistant" && (agent.showDebug ?? false)
          ? [...group.messages]
              .reverse()
              .find(
                (message) =>
                  typeof message.traceId === "string" &&
                  message.traceId.length > 0,
              )?.traceId
          : null;

      return (
        <>
          {traceId ? (
            <IconButton
              type="button"
              className="msg-header-action-btn"
              title="View trace logs"
              aria-label="View trace logs"
              onClick={(event) => {
                event.stopPropagation();
                handleOpenAssistantLogs(traceId);
              }}
            >
              <span className="material-symbols-outlined text-sm" aria-hidden="true">
                timeline
              </span>
            </IconButton>
          ) : null}
          <IconButton
            type="button"
            className={cn(
              "msg-header-action-btn",
              copied && "msg-header-action-btn--success",
            )}
            title="Copy bubble as markdown"
            aria-label="Copy bubble as markdown"
            onClick={(event) => {
              event.stopPropagation();
              void handleCopyBubbleMarkdown(group);
            }}
          >
            <span className="material-symbols-outlined text-sm" aria-hidden="true">
              {copied ? "check" : "content_copy"}
            </span>
          </IconButton>
          <IconButton
            type="button"
            className="msg-header-action-btn"
            title={
              forkDisabled
                ? "Wait for the message to finish streaming before forking."
                : "Fork from this bubble"
            }
            aria-label="Fork from this bubble"
            disabled={forkDisabled}
            onClick={(event) => {
              event.stopPropagation();
              void handleForkBubble(group);
            }}
          >
            <span className="material-symbols-outlined text-sm" aria-hidden="true">
              fork_right
            </span>
          </IconButton>
        </>
      );
    },
    [
      agent.showDebug,
      copiedBubbleKey,
      handleCopyBubbleMarkdown,
      handleForkBubble,
      handleOpenAssistantLogs,
    ],
  );
  const handleOpenToolLogs = useCallback((toolCall: ToolCallDisplay) => {
    void openLogViewerWindow({
      origin: "tool-call",
      filter: {
        correlationId: toolCall.id,
        levels: DEFAULT_LOG_VIEWER_LEVELS,
      },
    });
  }, []);
  const toggleReasoning = useCallback((messageId: string) => {
    setReasoningExpandedById((prev) => ({
      ...prev,
      [messageId]: !(prev[messageId] ?? false),
    }));
  }, []);

  const refreshWorktreeHandoffState = useCallback(async () => {
    if (!hasManagedWorktree) {
      setHandoffState(IDLE_WORKTREE_HANDOFF_STATE);
      return;
    }

    setHandoffState((prev) => ({ ...prev, loading: true, error: null }));
    const nextState = await readWorktreeHandoffState(
      worktreePath,
      worktreeBranch,
    );
    setHandoffState(nextState);
  }, [hasManagedWorktree, worktreeBranch, worktreePath]);

  useEffect(() => {
    void refreshWorktreeHandoffState();
  }, [
    activeTabId,
    agent.status,
    hasManagedWorktree,
    refreshWorktreeHandoffState,
    worktreeToolCallStatusKey,
  ]);

  useEffect(() => {
    if (!hasManagedWorktree) {
      setHandoffModalOpen(false);
      setHandoffCommitMessage(DEFAULT_HANDOFF_COMMIT_MESSAGE);
      setHandoffStatus({ type: "idle" });
      return;
    }

    const handleFocus = () => {
      void refreshWorktreeHandoffState();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [hasManagedWorktree, refreshWorktreeHandoffState]);

  const appendTranscriptToInput = useCallback(
    (transcript: string) => {
      let nextValue = transcript;
      setInput((prev) => {
        const trimmed = prev.trim();
        nextValue = !trimmed ? transcript : `${trimmed}\n${transcript}`;
        return nextValue;
      });

      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(
          nextValue.length,
          nextValue.length,
        );
      });
    },
    [setInput],
  );

  const voiceInput = useVoiceInputController({
    enabled: voiceInputEnabled,
    scopeKey: activeTabId,
    onTranscript: appendTranscriptToInput,
  });

  const queueBusyComposerMessage = useCallback(() => {
    const text = input.trim();
    if (!text) return;

    agent.queueMessage(text);
    setInput("");

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [agent, input, setInput]);

  const handleQueuedItemSendNow = useCallback(
    (itemId: string) => {
      const item = agent.queuedMessages.find((entry) => entry.id === itemId);
      if (!item) return;
      agent.steerMessage(item.content, item.id);
    },
    [agent],
  );

  const handleRemoveQueuedItem = useCallback(
    (itemId: string) => {
      agent.removeQueuedMessage(itemId);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    [agent],
  );

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setLeftWidth(Math.max(20, Math.min(75, pct)));
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, []);

  const openCurrentProjectSettings = useCallback(() => {
    const projectPath = agent.config.projectPath?.trim();
    if (!projectPath) return;

    const savedProject = findSavedProject(projectPath) ?? {
      path: projectPath,
      name: inferProjectName(projectPath),
      icon: DEFAULT_PROJECT_ICON,
      ...(agent.config.setupCommand
        ? { setupCommand: agent.config.setupCommand }
        : {}),
    };

    void resolveSavedProject(savedProject).then((resolvedProject) => {
      setProjectSettingsProject(resolvedProject);
    });
  }, [agent.config.projectPath, agent.config.setupCommand]);

  const openHandoffModal = useCallback(() => {
    setHandoffCommitMessage(DEFAULT_HANDOFF_COMMIT_MESSAGE);
    setHandoffStatus({ type: "idle" });
    setHandoffModalOpen(true);
  }, []);

  const closeHandoffModal = useCallback(() => {
    if (handoffStatus.type === "running") return;
    setHandoffModalOpen(false);
    setHandoffStatus({ type: "idle" });
  }, [handoffStatus.type]);

  const handleConfirmHandoff = useCallback(async () => {
    if (
      !hasManagedWorktree ||
      !handoffCommitMessage.trim() ||
      activeTab?.mode !== "workspace"
    ) {
      return;
    }

    setHandoffStatus({ type: "running" });

    const stageResult = await stageAllGitChanges(worktreePath);
    if (!stageResult.ok) {
      setHandoffStatus({ type: "error", message: stageResult.error.message });
      await refreshWorktreeHandoffState();
      return;
    }

    const holdResult = await switchToGitBranch(worktreePath, worktreeBranch);
    if (!holdResult.ok) {
      setHandoffStatus({ type: "error", message: holdResult.error.message });
      await refreshWorktreeHandoffState();
      return;
    }

    const commitResult = await execRun(worktreePath, {
      command: "git",
      args: ["commit", "-m", handoffCommitMessage.trim()],
      timeoutMs: 30_000,
      maxStdoutBytes: 40_000,
      maxStderrBytes: 40_000,
      reason: `Commit handoff changes to ${worktreeBranch}.`,
    });
    if (!commitResult.ok || commitResult.data.exitCode !== 0) {
      const message = !commitResult.ok
        ? commitResult.error.message
        : commitResult.data.stderr.trim() ||
          commitResult.data.stdout.trim() ||
          `git commit exited with code ${commitResult.data.exitCode}.`;
      setHandoffStatus({ type: "error", message });
      await refreshWorktreeHandoffState();
      return;
    }

    const detachResult = await detachGitHead(worktreePath);
    if (!detachResult.ok) {
      setHandoffStatus({ type: "error", message: detachResult.error.message });
      await refreshWorktreeHandoffState();
      return;
    }

    await upsertSession(activeTab);
    setHandoffModalOpen(false);
    setHandoffCommitMessage(DEFAULT_HANDOFF_COMMIT_MESSAGE);
    setHandoffStatus({ type: "idle" });
    await refreshWorktreeHandoffState();
  }, [
    activeTab,
    handoffCommitMessage,
    hasManagedWorktree,
    refreshWorktreeHandoffState,
    worktreeBranch,
    worktreePath,
  ]);

  const handleSaveProjectSettings = useCallback(
    async ({ project, writeProjectConfig }: ProjectSettingsSavePayload) => {
      const nextProject: SavedProject = {
        path: project.path,
        name: project.name,
        icon: project.icon || DEFAULT_PROJECT_ICON,
        ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
        ...(project.commands?.length ? { commands: project.commands } : {}),
        ...(project.githubIntegrationEnabled
          ? { githubIntegrationEnabled: true }
          : {}),
      };

      if (writeProjectConfig) {
        await writeProjectScriptsConfig(project.path, {
          ...(project.setupCommand
            ? { setupCommand: project.setupCommand }
            : {}),
          ...(project.commands?.length ? { commands: project.commands } : {}),
          ...(project.githubIntegrationEnabled
            ? { githubIntegrationEnabled: true }
            : {}),
        });
      }

      const savedProjects = await upsertSavedProjectPreservingLearnedFacts(
        nextProject,
      );
      const resolvedProject = await resolveSavedProject(
        savedProjects.find((entry) => entry.path === nextProject.path) ??
          nextProject,
      );
      const githubProbe = await probeGitHubRepository(resolvedProject.path);
      const nextIcon = resolvedProject.icon || DEFAULT_PROJECT_ICON;
      agent.setConfig({
        projectPath: resolvedProject.path,
        ...(resolvedProject.setupCommand
          ? { setupCommand: resolvedProject.setupCommand }
          : { setupCommand: undefined }),
      });
      await persistActiveTabChanges({ icon: nextIcon });
      setProjectCommands(resolvedProject.commands ?? []);
      setProjectGitHubState({
        enabled: Boolean(resolvedProject.githubIntegrationEnabled),
        repoSlug: githubProbe.repoSlug,
        eligible: githubProbe.eligible,
      });
      setProjectSettingsProject(null);
    },
    [agent, persistActiveTabChanges],
  );

  const handleCreateProjectConfig = useCallback(
    async ({ project }: ProjectSettingsSavePayload) => {
      const nextProject: SavedProject = {
        path: project.path,
        name: project.name,
        icon: project.icon || DEFAULT_PROJECT_ICON,
        ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
        ...(project.commands?.length ? { commands: project.commands } : {}),
        ...(project.githubIntegrationEnabled
          ? { githubIntegrationEnabled: true }
          : {}),
      };

      await writeProjectScriptsConfig(project.path, {
        ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
        ...(project.commands?.length ? { commands: project.commands } : {}),
        ...(project.githubIntegrationEnabled
          ? { githubIntegrationEnabled: true }
          : {}),
      });

      const savedProjects = await upsertSavedProjectPreservingLearnedFacts(
        nextProject,
      );
      const resolvedProject = await resolveSavedProject(
        savedProjects.find((entry) => entry.path === nextProject.path) ??
          nextProject,
      );
      const githubProbe = await probeGitHubRepository(resolvedProject.path);
      const nextIcon = resolvedProject.icon || DEFAULT_PROJECT_ICON;
      agent.setConfig({
        projectPath: resolvedProject.path,
        ...(resolvedProject.setupCommand
          ? { setupCommand: resolvedProject.setupCommand }
          : { setupCommand: undefined }),
      });
      await persistActiveTabChanges({ icon: nextIcon });
      setProjectCommands(resolvedProject.commands ?? []);
      setProjectGitHubState({
        enabled: Boolean(resolvedProject.githubIntegrationEnabled),
        repoSlug: githubProbe.repoSlug,
        eligible: githubProbe.eligible,
      });
      setProjectSettingsProject(resolvedProject);
    },
    [agent, persistActiveTabChanges],
  );

  const handleRunProjectCommand = useCallback(
    async (command: ProjectCommandConfig) => {
      if (command.id === OPEN_IN_EDITOR_COMMAND_ID) {
        if (!cwd) return;
        try {
          const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
          await tauriInvoke("open_in_editor", { cwd });
        } catch (error) {
          setErrorModal({
            title: "Could not open editor",
            details: error,
          });
        }
        return;
      }

      if (command.id === OPEN_SHELL_COMMAND_ID) {
        if (!cwd) return;
        try {
          const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
          await tauriInvoke("open_shell", { cwd });
        } catch (error) {
          setErrorModal({
            title: "Could not open shell",
            details: error,
          });
        }
        return;
      }

      const nextId = terminalCommandRequestIdRef.current + 1;
      terminalCommandRequestIdRef.current = nextId;
      openTerminal();
      setTerminalCommandRequest({
        id: nextId,
        command: command.command,
      });
    },
    [cwd, openTerminal],
  );

  const commandBarCommands = useMemo<ProjectCommandConfig[]>(() => {
    if (!cwd) return projectCommands;

    return [
      {
        id: OPEN_IN_EDITOR_COMMAND_ID,
        label: "Open in Editor",
        command: "open_in_editor",
        icon: "edit_square",
      },
      {
        id: OPEN_SHELL_COMMAND_ID,
        label: "Open Shell",
        command: "open_shell",
        icon: "terminal",
      },
      ...projectCommands,
    ];
  }, [cwd, projectCommands]);

  const getCommandBarButtonAriaLabel = useCallback(
    (command: ProjectCommandConfig) => {
      if (command.id === OPEN_IN_EDITOR_COMMAND_ID) {
        return "Open in Editor";
      }
      if (command.id === OPEN_SHELL_COMMAND_ID) {
        return "Open Shell";
      }
      return `Run ${command.label}`;
    },
    [],
  );

  const getCommandBarButtonTitle = useCallback(
    (command: ProjectCommandConfig) => {
      if (command.id === OPEN_IN_EDITOR_COMMAND_ID) {
        return "Open the current working directory in your editor";
      }
      if (command.id === OPEN_SHELL_COMMAND_ID) {
        return "Open a new shell in the current working directory";
      }
      return `${command.label} • ${command.command}`;
    },
    [],
  );

  const handleInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    if (agent.status === "error" || agent.error || agent.errorDetails) {
      patchAgentState(activeTabId, (prev) => {
        if (
          prev.status !== "error" &&
          !prev.error &&
          !prev.errorDetails &&
          !prev.errorAction
        ) {
          return prev;
        }
        return {
          ...prev,
          status: prev.status === "error" ? "idle" : prev.status,
          error: null,
          errorDetails: null,
          errorAction: null,
        };
      });
    }
    if (voiceInput.error) {
      voiceInput.clearError();
    }
  };

  const injectAssistantMessage = useCallback(
    (content: string) => {
      patchAgentState(activeTabId, (prev) => ({
        ...prev,
        chatMessages: [
          ...prev.chatMessages,
          {
            id: Math.random().toString(36).slice(2) + Date.now().toString(36),
            role: "assistant" as const,
            content,
            timestamp: Date.now(),
          },
        ],
      }));
    },
    [activeTabId],
  );

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text && attachedImages.length === 0) return;

    if (helpCommand && matchesSlashCommandInput(text, helpCommand)) {
      injectAssistantMessage(formatSlashCommandHelpMarkdown(slashCommands));
      setInput("");
      return;
    }

    if (text === "/debug") {
      setGlobalDebugMode(!(agent.showDebug ?? false));
      setInput("");
      return;
    }

    if (text === "/toggle-group-tools") {
      const nextValue = !agent.groupInlineToolCalls;
      patchAgentState(activeTabId, {
        groupInlineToolCallsOverride: nextValue,
      });
      setInput("");
      return;
    }

    if (text === "/model") {
      setModelPickerOpen(true);
      setInput("");
      return;
    }

    if (text.startsWith("/model ")) {
      const modelId = text.slice("/model ".length).trim();
      if (isAgentBusy) {
        injectAssistantMessage(
          "⚠ Cannot switch model while the agent is busy.",
        );
        setInput("");
        return;
      }
      const entry = models.find((m) => m.id === modelId);
      if (!entry) {
        injectAssistantMessage(
          `⚠ Unknown model \`${modelId}\`. Use \`/model\` to list available models.`,
        );
      } else {
        agent.setConfig({
          model: modelId,
          contextLength: entry.context_length,
        });
        injectAssistantMessage(
          `✓ Model switched to **${entry.name}** (\`${modelId}\`).`,
        );
      }
      setInput("");
      return;
    }

    if (voiceInput.isRecording) {
      void voiceInput.stopRecording();
      return;
    }

    if (isAgentBusy) {
      queueBusyComposerMessage();
      return;
    }

    if (voiceInput.busy) return;

    const currentAttachments = attachedImages.slice();
    voiceInput.clearError();
    setInput("");
    clearAttachedImages();
    if (currentAttachments.length > 0) {
      agent.sendMessage(text, currentAttachments);
    } else {
      agent.sendMessage(text);
    }
  }, [
    input,
    attachedImages,
    clearAttachedImages,
    activeTabId,
    helpCommand,
    isAgentBusy,
    voiceInput,
    agent,
    setInput,
    models,
    injectAssistantMessage,
    queueBusyComposerMessage,
    slashCommands,
  ]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  // ── Global Keyboard shortcuts ───────────────────────────────────────────
  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      const key = e.key.toLowerCase();

      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        if (key === "t") {
          e.preventDefault();
          toggleTerminal();
        }
        if (key === "a") {
          e.preventDefault();
          toggleArtifacts();
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [toggleTerminal, toggleArtifacts]);

  const executePlanDisabled =
    isAgentBusy || voiceInput.busy || voiceInput.isRecording;
  const handleExecutePlan = useCallback(
    (message: string) => {
      if (executePlanDisabled) return;
      voiceInput.clearError();
      agent.sendMessage(message);
    },
    [agent, executePlanDisabled, voiceInput],
  );

  /* ── New session screen ────────────────────────────────────────────── */
  if (isNewSession) {
    return (
      <NewSession
        onSubmit={(
          message,
          project,
          model,
          contextLength,
          advancedOptions,
          communicationProfile,
        ) => {
          const cwd = project?.path ?? "";
          const folder =
            (cwd.split("/").filter(Boolean).pop() ?? cwd) || "New Tab";
          const nextIcon =
            project?.icon ?? activeTab?.icon ?? "chat_bubble_outline";
          agent.setConfig({
            cwd,
            model,
            contextLength,
            advancedOptions,
            communicationProfile,
            projectPath: project?.path,
            setupCommand: project?.setupCommand,
          });
          void persistActiveTabChanges({
            mode: "workspace",
            label: folder,
            icon: nextIcon,
          });
          // Only send message if not empty
          if (message.trim()) {
            agent.sendMessage(message);
          }
        }}
      />
    );
  }

  const hasSendableText = input.trim().length > 0;
  const canSend = hasSendableText || attachedImages.length > 0;
  const showStopButton = isAgentBusy && !hasSendableText;
  const voiceBusy = voiceInput.busy;
  const showBusyComposerTray = agent.queuedMessages.length > 0;
  const sendTitle = voiceInput.isPreparingModel
    ? "Downloading Whisper model..."
    : voiceInput.isTranscribing
      ? "Transcribing voice..."
      : "Send";
  const handoffButtonDisabled =
    !hasManagedWorktree ||
    handoffState.loading ||
    handoffStatus.type === "running" ||
    !handoffState.branchHeld ||
    !handoffState.hasChanges;
  const handoffButtonTitle = !hasManagedWorktree
    ? "Handoff is only available in managed worktrees."
    : handoffState.loading
      ? "Checking worktree handoff state…"
      : !handoffState.branchHeld
        ? `Handoff is available once this worktree holds ${worktreeBranch}.`
        : !handoffState.hasChanges
          ? "No changes to hand off."
          : `Commit changes to ${worktreeBranch} and release the branch.`;

  return (
    <div className="workspace-outer">
      <ProjectCommandBar
        commands={commandBarCommands}
        onCommandClick={handleRunProjectCommand}
        buttonAriaLabel={getCommandBarButtonAriaLabel}
        buttonTitle={getCommandBarButtonTitle}
        variant="workspace"
        trailingContent={
          <div className="flex items-center gap-2">
            {hasManagedWorktree ? (
              <button
                type="button"
                className={cn(
                  "project-command-button",
                  handoffButtonDisabled && "project-command-button--disabled",
                )}
                title={handoffButtonTitle}
                aria-label="Handoff"
                disabled={handoffButtonDisabled}
                onClick={openHandoffModal}
              >
                <span
                  className="material-symbols-outlined text-base"
                  aria-hidden="true"
                >
                  move_item
                </span>
                <span className="project-command-button__label">Handoff</span>
              </button>
            ) : null}
            {projectGitHubState.enabled &&
            projectGitHubState.eligible &&
            projectGitHubState.repoSlug ? (
              <GitHubIssuesControl
                key={projectGitHubState.repoSlug}
                cwd={cwd}
                repoSlug={projectGitHubState.repoSlug}
              />
            ) : null}
          </div>
        }
      />

      {/* ── Two-pane row ────────────────────────────────────────────── */}
      <div className="workspace" ref={containerRef}>
        {/* ════════════════════════════════════════════════════════════
            LEFT PANE — Chat
        ════════════════════════════════════════════════════════════ */}
        <section
          className="chat-pane"
          style={{
            width: artifactOpen ? `${leftWidth}%` : "100%",
            maxWidth: artifactOpen ? "75%" : "100%",
          }}
        >
          <AutoScrollArea className="chat-messages">
            {chatBubbleGroups.map((group) => {
              if (group.kind === "user") {
                return (
                  <UserMessage
                    key={group.key}
                    images={group.message.attachments}
                    actions={renderBubbleActions(group)}
                  >
                    <Markdown
                      cwd={cwd}
                      onOpenFileReferenceError={handleOpenFileReferenceError}
                    >
                      {group.message.content}
                    </Markdown>
                  </UserMessage>
                );
              }

              const groupMessages = group.messages;
              const latestMessage = groupMessages[groupMessages.length - 1];
              const streaming = groupMessages.some((msg) => msg.streaming);
              const cards = groupMessages.flatMap((msg) => msg.cards ?? []);
              const animated = groupMessages.some(
                (msg) =>
                  !!msg.content ||
                  !!msg.reasoning ||
                  !!msg.reasoningStreaming ||
                  !!(msg.toolCalls && msg.toolCalls.length > 0) ||
                  !!(msg.cards && msg.cards.length > 0),
              );

              const isSubagent = !!group.agentName;
              const subagentMeta = group.agentName
                ? subagentMetaByName.get(group.agentName)
                : undefined;
              const toolCallRenderItemsByMessage =
                buildToolCallRenderItemsByMessage(
                  groupMessages,
                  agent.groupInlineToolCalls,
                  agent.showDebug ?? false,
                );

              return (
                <div key={group.key} className="conversation-group">
                  <AgentMessage
                    name={group.agentName ?? "Rakh"}
                    icon={subagentMeta?.icon}
                    accentColor={subagentMeta?.color}
                    streaming={streaming}
                    badge={latestMessage.badge}
                    animated={animated}
                    collapsible={isSubagent}
                    defaultCollapsed={false}
                    actions={renderBubbleActions(group)}
                  >
                    {(() => {
                      return groupMessages.map((msg) => {
                        const visibleToolCalls = msg.toolCalls ?? [];
                        const toolCallRenderItems =
                          toolCallRenderItemsByMessage[msg.id] ?? [];
                        const showReasoning =
                          !!msg.reasoning || !!msg.reasoningStreaming;
                        const reasoningExpanded =
                          reasoningExpandedById[msg.id] ?? false;
                        const showThinkingDots =
                          !!msg.streaming &&
                          !msg.content &&
                          !showReasoning &&
                          visibleToolCalls.length === 0;
                        const showStreamingCursor =
                          !!msg.streaming && !showThinkingDots;
                        const hasRenderableSegmentContent =
                          showReasoning ||
                          !!msg.content ||
                          showThinkingDots ||
                          showStreamingCursor ||
                          toolCallRenderItems.length > 0;

                        if (!hasRenderableSegmentContent) {
                          return null;
                        }

                        return (
                          <div key={msg.id} className="agent-message-segment">
                            {/* Reasoning content */}
                            {showReasoning && (
                              <ReasoningThought
                                messageId={msg.id}
                                reasoning={msg.reasoning}
                                reasoningStreaming={msg.reasoningStreaming}
                                reasoningStartedAtMs={msg.reasoningStartedAtMs}
                                reasoningDurationMs={msg.reasoningDurationMs}
                                expanded={reasoningExpanded}
                                onToggle={toggleReasoning}
                              />
                            )}

                            {/* Text content */}
                            {msg.content && (
                              <Markdown
                                cwd={cwd}
                                onOpenFileReferenceError={
                                  handleOpenFileReferenceError
                                }
                              >
                                {msg.content}
                              </Markdown>
                            )}

                            {/* Streaming cursor or thinking animation */}
                            {showThinkingDots ? (
                              <div className="thinking-dots mt-0.5 mb-0.5">
                                <span />
                                <span />
                                <span />
                              </div>
                            ) : showStreamingCursor ? (
                              <span className="animate-blink ml-0.5">◍</span>
                            ) : null}

                            {/* Tool calls */}
                            {toolCallRenderItems.length > 0 && (
                              <div className="mt-2 flex flex-col gap-1">
                                {toolCallRenderItems.map((item, index) =>
                                  item.kind === "group" ? (
                                    <GroupedInlineToolCall
                                      key={`group:${item.toolCalls[0]?.id ?? index}`}
                                      toolCalls={item.toolCalls}
                                      onInspect={(toolCall) =>
                                        setToolDetailsModal(toolCall)
                                      }
                                      onOpenLogs={handleOpenToolLogs}
                                      cwd={agent.config.cwd}
                                      showDebug={agent.showDebug ?? false}
                                    />
                                  ) : item.renderKind === "user_input" ? (
                                    <UserInputCard
                                      key={item.toolCall.id}
                                      toolCall={item.toolCall}
                                      tabId={activeTabId}
                                    />
                                  ) : item.renderKind === "approval" ? (
                                    <ToolCallApproval
                                      key={item.toolCall.id}
                                      toolCall={item.toolCall}
                                      cwd={agent.config.cwd}
                                      tabId={activeTabId}
                                      onOpenProjectSettings={
                                        openCurrentProjectSettings
                                      }
                                    />
                                  ) : (
                                    renderCompactToolCall(
                                      item,
                                      agent.config.cwd,
                                      agent.showDebug ?? false,
                                      setToolDetailsModal,
                                      handleOpenToolLogs,
                                    )
                                  ),
                                )}
                              </div>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </AgentMessage>

                  {cards.length > 0 ? (
                    <ConversationCards
                      cards={cards}
                      accentColor={subagentMeta?.color}
                      cwd={cwd}
                      onOpenFileReferenceError={handleOpenFileReferenceError}
                      artifactInventory={artifactInventory}
                      artifactInventoryLoading={artifactInventoryLoading}
                      getArtifactContentEntry={getArtifactContentEntry}
                      ensureArtifactContent={ensureArtifactContent}
                      onExecutePlan={handleExecutePlan}
                      executePlanDisabled={executePlanDisabled}
                    />
                  ) : null}
                </div>
              );
            })}

            {/* Error banner */}
            {agent.status === "error" && agent.error && (
              <div className="flex items-center gap-2 text-error py-2 text-base">
                <span>⚠ {agent.error}</span>
                <Button
                  className="workspace-retry-btn"
                  variant="ghost"
                  size="xxs"
                  onClick={() => agent.retry()}
                >
                  RETRY
                </Button>
                {agent.errorAction?.type === "open-settings-section" ? (
                  <Button
                    className="workspace-error-action-btn"
                    variant="ghost"
                    size="xxs"
                    onClick={() =>
                      openSettingsTab(agent.errorAction?.section ?? "providers")
                    }
                  >
                    {agent.errorAction?.label ?? "Open settings"}
                  </Button>
                ) : null}
                {!!agent.errorDetails && (
                  <Button
                    className="workspace-error-details-btn"
                    variant="ghost"
                    size="xxs"
                    onClick={() =>
                      setErrorModal({
                        title: "API / Runner Error",
                        details: agent.errorDetails,
                        showDebug: agent.showDebug ?? false,
                      })
                    }
                  >
                    DETAILS
                  </Button>
                )}
              </div>
            )}
          </AutoScrollArea>

          {/* ── Input area ──────────────────────────────────────────── */}
          <div
            className="chat-input-wrap"
            onClick={() => textareaRef.current?.focus()}
          >
            {showBusyComposerTray ? (
              <BusyComposerTray
                queuedItems={agent.queuedMessages}
                queueState={agent.queueState}
                onSendQueuedNow={handleQueuedItemSendNow}
                onResumeQueue={agent.resumeQueue}
                onClearQueuedItems={agent.clearQueuedMessages}
                onRemoveQueuedItem={handleRemoveQueuedItem}
              />
            ) : null}
            <ChatControls
              autoApproveEdits={agent.autoApproveEdits}
              autoApproveCommands={agent.autoApproveCommands}
              onChangeAutoApproveEdits={(value) => {
                agent.setAutoApproveEdits(value);
              }}
              onChangeAutoApproveCommands={(value) => {
                agent.setAutoApproveCommands(value);
              }}
              contextWindowPct={contextWindowPct}
              contextCurrentTokens={agent.currentContextStats?.estimatedTokens ?? null}
              contextCurrentKb={contextWindowKb?.currentKb ?? null}
              contextMaxKb={contextWindowKb?.maxKb ?? null}
              sessionUsageSummary={agent.sessionUsageSummary ?? null}
              sessionCostSeries={agent.sessionCostSeries}
              onOpenProvidersSettings={() => openSettingsTab("providers")}
            />
            <VoiceInputStateProvider value={voiceInput}>
              <div className="chat-input-shell">
                {isChatDropActive && (
                  <div className="chat-drop-overlay" aria-hidden="true">
                    <span className="material-symbols-outlined">
                      upload_file
                    </span>
                    <span>Drop to attach</span>
                  </div>
                )}
                <VoiceInputStatusSlot />
                <VoiceInputRecordingRow />
                {attachedImages.length > 0 && (
                  <div className="chat-attachment-strip">
                    {attachedImages.map((img) => (
                      <div key={img.id} className="chat-attachment-chip">
                        <img
                          src={img.previewUrl}
                          alt={img.name}
                          className="chat-attachment-thumb"
                        />
                        <span className="chat-attachment-name">{img.name}</span>
                        <button
                          className="chat-attachment-remove"
                          onClick={() => removeAttachedImage(img.id)}
                          title={`Remove ${img.name}`}
                          aria-label={`Remove ${img.name}`}
                          type="button"
                        >
                          <span
                            className="material-symbols-outlined"
                            style={{ fontSize: 14 }}
                          >
                            close
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <MentionTextarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleInput}
                  onKeyDown={handleKeyDown}
                  onImageDrop={addAttachedImages}
                  onImagePathDrop={handleImagePathDrop}
                  onDragActiveChange={setIsChatDropActive}
                  cwd={agent.config.cwd}
                  slashCommands={slashCommands}
                  placeholder="Type a message…"
                  rows={1}
                  disabled={false}
                />
                <div className="chat-input-actions">
                  <VoiceInputToggleButton />
                  <AnimatePresence initial={false} mode="wait">
                    {showStopButton ? (
                      <motion.button
                        key="stop"
                        type="button"
                        className="chat-input-action-btn chat-input-action-btn--stop"
                        title="Stop current run"
                        aria-label="Stop agent"
                        onClick={() => stopAgent(activeTabId)}
                        initial={{ opacity: 0, scale: 0.92 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.92 }}
                        transition={{ duration: 0.14, ease: "easeOut" }}
                      >
                        <span className="material-symbols-outlined text-lg">
                          stop_circle
                        </span>
                      </motion.button>
                    ) : (
                      <motion.button
                        key="send"
                        type="button"
                        title={sendTitle}
                        aria-label="Send"
                        onClick={() => void handleSubmit()}
                        disabled={voiceBusy || !canSend}
                        initial={{ opacity: 0, scale: 0.92 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.92 }}
                        transition={{ duration: 0.14, ease: "easeOut" }}
                      >
                        <span className="material-symbols-outlined text-lg">
                          {voiceInput.isPreparingModel
                            ? "download"
                            : voiceInput.isTranscribing
                              ? "hourglass_top"
                              : "arrow_upward"}
                        </span>
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </VoiceInputStateProvider>
            <div className="chat-input-meta">
              <button
                className="chat-input-meta-model-btn"
                onClick={() => setModelPickerOpen(true)}
                title="Switch model"
                type="button"
              >
                Model: {agent.config.model || "(none)"}
              </button>
              {agent.config.cwd && (
                <>
                  <span>•</span>
                  <span className="font-mono text-xs">{agent.config.cwd}</span>
                </>
              )}
            </div>
          </div>
        </section>

        {/* ── Vertical resize handle + artifact pane (hidden when collapsed) */}
        <AnimatePresence>
          {artifactOpen ? (
            <motion.div
              key="artifact-pane"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              style={{ display: "flex", flex: 1, minWidth: 0 }}
            >
              <div
                className="pane-divider"
                onMouseDown={handleDividerMouseDown}
              />
              <ArtifactPane
                onOpenLogs={handleOpenLatestLogs}
                onOpenFileReferenceError={handleOpenFileReferenceError}
                onCollapse={toggleArtifacts}
                activeTab={activeArtifactTab}
                unseenTabs={unseenTabs}
                onTabClick={handleTabClick}
                artifactInventory={artifactInventory}
                artifactInventoryLoading={artifactInventoryLoading}
                artifactInventoryError={artifactInventoryError}
                getArtifactContentEntry={getArtifactContentEntry}
                ensureArtifactContent={ensureArtifactContent}
                onRefineEdit={(filePath) => {
                  const hint = `Refine edit in ${filePath}: `;
                  let nextValue = hint;
                  setInput((prev) => {
                    nextValue = prev ? `${prev}\n${hint}` : hint;
                    return nextValue;
                  });
                  requestAnimationFrame(() => {
                    textareaRef.current?.focus();
                    textareaRef.current?.setSelectionRange(
                      nextValue.length,
                      nextValue.length,
                    );
                  });
                }}
              />
            </motion.div>
          ) : (
            <motion.div
              key="artifact-strip"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ position: "absolute", top: 0, right: 0, zIndex: 10 }}
            >
              <div
                className="artifact-collapsed-strip"
                onClick={toggleArtifacts}
                title="Open Artifacts"
              >
                {artifactHasUpdates && (
                  <span className="absolute top-1.75 right-1.75 w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                )}
                <svg
                  className="artifact-collapsed-icon"
                  width={15}
                  height={15}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M15 3v18" />
                </svg>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Terminal — full width, collapsible, resizable from top ─── */}
      <Terminal
        isOpen={terminalOpen}
        onToggle={toggleTerminal}
        onToggleArtifacts={toggleArtifacts}
        activeTabId={activeTabId}
        cwd={agent.config.cwd}
        agentTitle={agent.tabTitle}
        commandRequest={terminalCommandRequest}
      />

      {/* Error details modal */}
      {errorModal && (
        <ErrorDetailsModal
          {...errorModal}
          onClose={() => setErrorModal(null)}
        />
      )}

      {projectSettingsProject && (
        <ProjectSettingsModal
          key={projectSettingsProject.path}
          project={projectSettingsProject}
          onClose={() => setProjectSettingsProject(null)}
          onSave={handleSaveProjectSettings}
          onCreateProjectConfig={handleCreateProjectConfig}
        />
      )}

      {/* Tool call details modal */}
      {toolDetailsModal && (
        <ToolCallDetailsModal
          toolCall={toolDetailsModal}
          onClose={() => setToolDetailsModal(null)}
        />
      )}
      {handoffModalOpen && hasManagedWorktree ? (
        <WorktreeHandoffModal
          branch={worktreeBranch}
          commitMessage={handoffCommitMessage}
          status={handoffStatus}
          onChangeCommitMessage={setHandoffCommitMessage}
          onClose={closeHandoffModal}
          onConfirm={() => {
            void handleConfirmHandoff();
          }}
        />
      ) : null}

      {modelPickerOpen && (
        <ModelPickerModal
          models={models}
          currentModelId={agent.config.model ?? ""}
          currentProfile={agent.config.communicationProfile}
          onSelect={(id, profile) => {
            if (!isAgentBusy) {
              const nextModel = models.find((model) => model.id === id);
              agent.setConfig({
                model: id,
                contextLength: nextModel?.context_length,
                communicationProfile: profile,
              });
            }
            setModelPickerOpen(false);
          }}
          onClose={() => setModelPickerOpen(false)}
        />
      )}
    </div>
  );
}
