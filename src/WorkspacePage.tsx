import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type SetStateAction,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import type { AttachedImage } from "@/agent/types";
import { useAtomValue } from "jotai";
import ArtifactPane, { useArtifactUpdates } from "@/components/ArtifactPane";
import ConversationCards from "@/components/ConversationCards";
import Terminal from "@/components/Terminal";
import UserMessage from "@/components/UserMessage";
import AgentMessage from "@/components/AgentMessage";
import ToolCallApproval from "@/components/ToolCallApproval";
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
import ReasoningThought from "@/components/ReasoningThought";
import ProjectCommandBar from "@/components/ProjectCommandBar";
import {
  MentionTextarea,
  type MentionTextareaHandle,
} from "@/components/MentionTextarea";
import { Button } from "@/components/ui";
import {
  VoiceInputRecordingRow,
  VoiceInputStateProvider,
  VoiceInputStatusSlot,
  VoiceInputToggleButton,
} from "@/components/voice-input/VoiceInputUi";
import { useVoiceInputController } from "@/components/voice-input/useVoiceInputController";
import { useTabs } from "@/contexts/TabsContext";
import { useAgent } from "@/agent/useAgents";
import { useModels } from "@/agent/useModels";
import { patchAgentState, voiceInputEnabledAtom } from "@/agent/atoms";
import {
  formatSlashCommandHelpMarkdown,
  getSlashCommandCatalog,
  matchesSlashCommandInput,
} from "@/agent/slashCommands";
import { getAllSubagents, getSubagentThemeColorToken } from "@/agent/subagents";
import { groupChatMessagesForBubbles } from "@/agent/chatBubbleGroups";
import { useArtifactContentCache } from "@/components/artifact-pane/useSessionArtifacts";
import { AnimatePresence, motion } from "framer-motion";
import type { ToolCallDisplay } from "@/agent/types";
import {
  findSavedProject,
  inferProjectName,
  resolveSavedProject,
  upsertSavedProject,
  type SavedProject,
} from "@/projects";
import {
  writeProjectScriptsConfig,
  type ProjectCommandConfig,
} from "@/projectScripts";

/* ─────────────────────────────────────────────────────────────────────────────
   Page
───────────────────────────────────────────────────────────────────────────── */

export default function WorkspacePage() {
  const { tabs, activeTabId, openSettingsTab, updateTab } = useTabs();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isNewSession = activeTab?.mode !== "workspace";
  const artifactInventoryEnabled = activeTab?.mode === "workspace";
  const voiceInputEnabled = useAtomValue(voiceInputEnabledAtom);

  // Agent state — always called (hooks must not be conditional)
  const agent = useAgent(activeTabId);
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
  const [projectCommands, setProjectCommands] = useState<ProjectCommandConfig[]>([]);
  const [commandBarOpen, setCommandBarOpen] = useState(true);
  const [terminalCommandRequest, setTerminalCommandRequest] = useState<{
    id: number;
    command: string;
  } | null>(null);
  const [reasoningExpandedById, setReasoningExpandedById] = useState<
    Record<string, boolean>
  >({});
  const terminalCommandRequestIdRef = useRef(0);

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

  // Chat controls state
  const contextWindowPct = agent.contextWindowPct;
  const contextWindowKb = agent.contextWindowKb;
  const chatBubbleGroups = useMemo(
    () => groupChatMessagesForBubbles(agent.chatMessages),
    [agent.chatMessages],
  );
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
      return;
    }

    const projectPath = agent.config.projectPath?.trim();
    if (!projectPath) {
      setProjectCommands([]);
      return;
    }

    let cancelled = false;
    const savedProject =
      findSavedProject(projectPath) ?? {
        path: projectPath,
        name: inferProjectName(projectPath),
      };

    void resolveSavedProject(savedProject)
      .then((resolvedProject) => {
        if (cancelled) return;
        setProjectCommands(resolvedProject.commands ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setProjectCommands([]);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTabId, agent.config.projectPath, isNewSession]);

  const toggleTerminal = useCallback(() => setTerminalOpen((v) => !v), []);
  const toggleCommandBar = useCallback(() => setCommandBarOpen((v) => !v), []);
  const openTerminal = useCallback(() => setTerminalOpen(true), []);
  const toggleArtifacts = useCallback(() => setArtifactOpen((v) => !v), []);
  const toggleReasoning = useCallback((messageId: string) => {
    setReasoningExpandedById((prev) => ({
      ...prev,
      [messageId]: !(prev[messageId] ?? false),
    }));
  }, []);

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
        textareaRef.current?.setSelectionRange(nextValue.length, nextValue.length);
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

    const savedProject =
      findSavedProject(projectPath) ?? {
        path: projectPath,
        name: inferProjectName(projectPath),
        ...(agent.config.setupCommand
          ? { setupCommand: agent.config.setupCommand }
          : {}),
      };

    void resolveSavedProject(savedProject).then((resolvedProject) => {
      setProjectSettingsProject(resolvedProject);
    });
  }, [agent.config.projectPath, agent.config.setupCommand]);

  const handleSaveProjectSettings = useCallback(
    async ({ project, writeProjectConfig }: ProjectSettingsSavePayload) => {
      const nextProject: SavedProject = {
        path: project.path,
        name: project.name,
        ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
        ...(project.commands?.length ? { commands: project.commands } : {}),
      };

      if (writeProjectConfig) {
        await writeProjectScriptsConfig(project.path, {
          ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
          ...(project.commands?.length ? { commands: project.commands } : {}),
        });
      }

      const resolvedProject = await resolveSavedProject(
        upsertSavedProject(nextProject).find(
          (entry) => entry.path === nextProject.path,
        ) ?? nextProject,
      );
      agent.setConfig({
        projectPath: resolvedProject.path,
        ...(resolvedProject.setupCommand
          ? { setupCommand: resolvedProject.setupCommand }
          : { setupCommand: undefined }),
      });
      setProjectCommands(resolvedProject.commands ?? []);
      setProjectSettingsProject(null);
    },
    [agent],
  );

  const handleCreateProjectConfig = useCallback(
    async ({ project }: ProjectSettingsSavePayload) => {
      const nextProject: SavedProject = {
        path: project.path,
        name: project.name,
        ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
        ...(project.commands?.length ? { commands: project.commands } : {}),
      };

      await writeProjectScriptsConfig(project.path, {
        ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
        ...(project.commands?.length ? { commands: project.commands } : {}),
      });

      const resolvedProject = await resolveSavedProject(
        upsertSavedProject(nextProject).find(
          (entry) => entry.path === nextProject.path,
        ) ?? nextProject,
      );
      agent.setConfig({
        projectPath: resolvedProject.path,
        ...(resolvedProject.setupCommand
          ? { setupCommand: resolvedProject.setupCommand }
          : { setupCommand: undefined }),
      });
      setProjectCommands(resolvedProject.commands ?? []);
      setProjectSettingsProject(resolvedProject);
    },
    [agent],
  );

  const handleRunProjectCommand = useCallback(
    (command: ProjectCommandConfig) => {
      const nextId = terminalCommandRequestIdRef.current + 1;
      terminalCommandRequestIdRef.current = nextId;
      openTerminal();
      setTerminalCommandRequest({
        id: nextId,
        command: command.command,
      });
    },
    [openTerminal],
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
      patchAgentState(activeTabId, (prev) => ({
        ...prev,
        showDebug: !(prev.showDebug ?? false),
      }));
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
        injectAssistantMessage("⚠ Cannot switch model while the agent is busy.");
        setInput("");
        return;
      }
      const entry = models.find((m) => m.id === modelId);
      if (!entry) {
        injectAssistantMessage(
          `⚠ Unknown model \`${modelId}\`. Use \`/model\` to list available models.`,
        );
      } else {
        agent.setConfig({ model: modelId });
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
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
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

      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === "b") {
        e.preventDefault();
        toggleCommandBar();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [toggleTerminal, toggleArtifacts, toggleCommandBar]);

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
          agent.setConfig({
            cwd,
            model,
            contextLength,
            advancedOptions,
            communicationProfile,
            projectPath: project?.path,
            setupCommand: project?.setupCommand,
          });
          // Rename tab to folder basename
          const folder =
            (cwd.split("/").filter(Boolean).pop() ?? cwd) || "New Tab";
          updateTab(activeTabId, { mode: "workspace", label: folder });
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
  const voiceBusy = voiceInput.busy;
  const showBusyComposerTray = agent.queuedMessages.length > 0;
  const sendTitle = voiceInput.isPreparingModel
    ? "Downloading Whisper model..."
    : voiceInput.isTranscribing
      ? "Transcribing voice..."
      : "Send";
  const commandBarShortcutKeys =
    typeof navigator !== "undefined" &&
    (((navigator.platform ?? "").toLowerCase().startsWith("mac")) ||
      navigator.userAgent.toLowerCase().includes("mac os"))
      ? ["⌘", "B"]
      : ["Ctrl", "B"];

  return (
    <div className="workspace-outer">
      {commandBarOpen ? (
        <ProjectCommandBar
          commands={projectCommands}
          onCommandClick={handleRunProjectCommand}
          variant="workspace"
          trailingContent={
            <span className="project-command-bar__shortcut-hint">
              <span className="project-command-bar__shortcut-label">Toggle</span>
              <span className="project-command-bar__shortcut-keys" aria-hidden="true">
                {commandBarShortcutKeys.map((key) => (
                  <kbd
                    key={key}
                    className="project-command-bar__shortcut-key"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            </span>
          }
        />
      ) : null}

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
                  >
                    <Markdown>{group.message.content}</Markdown>
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
                >
                  {groupMessages.map((msg) => {
                      const visibleToolCalls = msg.toolCalls ?? [];
                      const showReasoning =
                        !!msg.reasoning || !!msg.reasoningStreaming;
                      const reasoningExpanded =
                        reasoningExpandedById[msg.id] ?? false;

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
                          {msg.content && <Markdown>{msg.content}</Markdown>}

                          {/* Streaming cursor or thinking animation */}
                          {msg.streaming &&
                            (!msg.content &&
                            !showReasoning &&
                            visibleToolCalls.length === 0 ? (
                              <div className="thinking-dots mt-0.5 mb-0.5">
                                <span />
                                <span />
                                <span />
                              </div>
                            ) : (
                              <span className="animate-blink ml-0.5">◍</span>
                            ))}

                          {/* Tool calls */}
                          {visibleToolCalls.length > 0 && (
                            <div className="mt-2 flex flex-col gap-1">
                              {visibleToolCalls.map((tc) =>
                                tc.tool === "user_input" &&
                                tc.status === "awaiting_approval" ? (
                                  <UserInputCard key={tc.id} toolCall={tc} tabId={activeTabId} />
                                ) : tc.status === "awaiting_approval" ||
                                  tc.status === "awaiting_worktree" ||
                                  tc.status === "awaiting_setup_action" ||
                                  (tc.tool === "git_worktree_init" &&
                                    tc.status === "running") ||
                                  (tc.tool === "exec_run" &&
                                    tc.status === "running") ? (
                                  <ToolCallApproval
                                    key={tc.id}
                                    toolCall={tc}
                                    cwd={agent.config.cwd}
                                    tabId={activeTabId}
                                    onOpenProjectSettings={openCurrentProjectSettings}
                                  />
                                ) : (
                                  <CompactToolCall
                                    key={tc.id}
                                    tc={tc}
                                    onInspect={() => setToolDetailsModal(tc)}
                                    cwd={agent.config.cwd}
                                    showDebug={agent.showDebug ?? false}
                                  />
                                ),
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </AgentMessage>

                  {cards.length > 0 ? (
                    <ConversationCards
                      cards={cards}
                      accentColor={subagentMeta?.color}
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
              contextCurrentKb={contextWindowKb?.currentKb ?? null}
              contextMaxKb={contextWindowKb?.maxKb ?? null}
            />
            <VoiceInputStateProvider value={voiceInput}>
              <div
                className={`chat-input-shell${isAgentBusy ? " chat-input-shell--busy" : ""}`}
              >
                {isChatDropActive && (
                  <div className="chat-drop-overlay" aria-hidden="true">
                    <span className="material-symbols-outlined">upload_file</span>
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
                          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
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
                  {isAgentBusy ? null : (
                    <button
                      title={sendTitle}
                      aria-label="Send"
                      onClick={() => void handleSubmit()}
                      disabled={voiceBusy || !canSend}
                    >
                      <span className="material-symbols-outlined text-lg">
                        {voiceInput.isPreparingModel
                          ? "download"
                          : voiceInput.isTranscribing
                            ? "hourglass_top"
                            : "arrow_upward"}
                      </span>
                    </button>
                  )}
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

      {modelPickerOpen && (
        <ModelPickerModal
          models={models}
          currentModelId={agent.config.model ?? ""}
          currentProfile={agent.config.communicationProfile}
          onSelect={(id, profile) => {
            if (!isAgentBusy) {
              agent.setConfig({ model: id, communicationProfile: profile });
            }
            setModelPickerOpen(false);
          }}
          onClose={() => setModelPickerOpen(false)}
        />
      )}
    </div>
  );
}
