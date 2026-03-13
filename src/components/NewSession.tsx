import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { useModels, useSelectedModel } from "@/agent/useModels";
import { useAtom } from "jotai";
import { providersAtom } from "@/agent/db";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { cn } from "@/utils/cn";
import { useTabs } from "@/contexts/TabsContext";
import NewSessionModelSelector from "@/components/NewSessionModelSelector";
import ProviderSetupHint from "@/components/ProviderSetupHint";
import ProjectSettingsModal, {
  type ProjectSettingsSavePayload,
} from "@/components/ProjectSettingsModal";
import { Button, IconButton } from "@/components/ui";
import type {
  AdvancedModelOptions,
  LatencyCostProfile,
  ReasoningEffort,
  ReasoningVisibility,
} from "@/agent/types";
import { DEFAULT_ADVANCED_OPTIONS } from "@/agent/types";
import {
  loadSavedProjects,
  removeSavedProject,
  resolveSavedProject,
  resolveSavedProjects,
  upsertSavedProject,
  type SavedProject,
} from "@/projects";
import { writeProjectScriptsConfig } from "@/projectScripts";
import { logFrontendSoon } from "@/logging/client";
import {
  listenForSessionChanges,
  loadArchivedSessions,
  sessionChangeAffectsArchivedSessions,
  setSessionPinned,
  type PersistedSession,
} from "@/agent/persistence";
import { restoreArchivedTab } from "@/agent/sessionRestore";
import {
  buildArchivedSessionItems,
  partitionArchivedSessionItems,
  type ArchivedSessionItem,
} from "@/components/archivedTabsMenuModel";

/* ─────────────────────────────────────────────────────────────────────────────
   Advanced options — localStorage helpers
─────────────────────────────────────────────────────────────────────────── */

const ADVANCED_OPTIONS_STORAGE_KEY = "rakh.new-session.advanced-options";

function loadAdvancedOptions(): AdvancedModelOptions {
  try {
    const stored = localStorage.getItem(ADVANCED_OPTIONS_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_ADVANCED_OPTIONS };
    const parsed = JSON.parse(stored) as Partial<AdvancedModelOptions>;
    return {
      reasoningVisibility: (
        ["off", "auto", "detailed"] as ReasoningVisibility[]
      ).includes(parsed.reasoningVisibility as ReasoningVisibility)
        ? (parsed.reasoningVisibility as ReasoningVisibility)
        : DEFAULT_ADVANCED_OPTIONS.reasoningVisibility,
      reasoningEffort: (
        ["low", "medium", "high"] as ReasoningEffort[]
      ).includes(parsed.reasoningEffort as ReasoningEffort)
        ? (parsed.reasoningEffort as ReasoningEffort)
        : DEFAULT_ADVANCED_OPTIONS.reasoningEffort,
      latencyCostProfile: (
        ["balanced", "fast", "cheap"] as LatencyCostProfile[]
      ).includes(parsed.latencyCostProfile as LatencyCostProfile)
        ? (parsed.latencyCostProfile as LatencyCostProfile)
        : DEFAULT_ADVANCED_OPTIONS.latencyCostProfile,
    };
  } catch {
    return { ...DEFAULT_ADVANCED_OPTIONS };
  }
}

function saveAdvancedOptions(opts: AdvancedModelOptions) {
  try {
    localStorage.setItem(ADVANCED_OPTIONS_STORAGE_KEY, JSON.stringify(opts));
  } catch {
    // ignore
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   NewSession — the “create agent” landing shown for every new / empty tab.
   Typing `/test` and pressing Enter triggers `onActivate`, which switches
   the tab into workspace mode populated with sample data.
─────────────────────────────────────────────────────────────────────────── */

interface NewSessionProps {
  onSubmit: (
    message: string,
    project: { path: string; setupCommand?: string } | null,
    model: string,
    contextLength?: number,
    advancedOptions?: AdvancedModelOptions,
    communicationProfile?: string,
  ) => void;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function RecentTabRow({
  item,
  onRestore,
  onTogglePinned,
}: {
  item: ArchivedSessionItem;
  onRestore: (session: PersistedSession) => Promise<void>;
  onTogglePinned: (id: string, pinned: boolean) => Promise<void>;
}) {
  const label = item.session.label || "Untitled";
  const pinLabel = item.session.pinned ? `Unpin ${label}` : `Pin ${label}`;

  return (
    <div className="ns-recent-item">
      <button
        className="ns-recent-item-main"
        onClick={() => void onRestore(item.session)}
        title={`Restore: ${label}`}
      >
        <span
          className="material-symbols-outlined ns-recent-item-icon"
          aria-hidden
        >
          {item.session.icon || "chat_bubble_outline"}
        </span>
        <span className="ns-recent-item-body">
          <span className="ns-recent-item-label">{label}</span>
        </span>
        <span className="ns-recent-item-time">
          {relativeTime(item.session.updatedAt)}
        </span>
      </button>
      <button
        className={cn(
          "ns-recent-item-pin",
          item.session.pinned && "ns-recent-item-pin--active",
        )}
        aria-label={pinLabel}
        title={item.session.pinned ? "Unpin" : "Pin"}
        onClick={() => void onTogglePinned(item.session.id, !item.session.pinned)}
      >
        <span className="material-symbols-outlined text-lg">keep</span>
      </button>
    </div>
  );
}

export default function NewSession({ onSubmit }: NewSessionProps) {
  const [input, setInput] = useState("");
  const [projects, setProjects] = useState<SavedProject[]>(loadSavedProjects);
  const [recentSessions, setRecentSessions] = useState<PersistedSession[]>([]);
  const [selectedProject, setSelectedProject] = useState<SavedProject | null>(
    null,
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [recentScrollbarVisible, setRecentScrollbarVisible] = useState(false);
  const [advancedOptions, setAdvancedOptions] =
    useState<AdvancedModelOptions>(loadAdvancedOptions);
  const [projectSettingsProject, setProjectSettingsProject] =
    useState<SavedProject | null>(null);
  // The global default profile handles fallback later if not provided.
  const [communicationProfile, setCommunicationProfile] =
    useState<string>("global");

  const dropdownRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recentScrollbarTimeoutRef = useRef<number | null>(null);

  const { models, loading: modelsLoading, error: modelsError } = useModels();
  const [selectedModel, setSelectedModel] = useSelectedModel(models);
  const [providers, setProviders] = useAtom(providersAtom);
  const { activeTabId, addTabWithId, closeTab, openSettingsTab } = useTabs();
  const hasAnyProviderKey = providers.length > 0;

  const providerModels = models;
  const selectedModelObj = providerModels.find((m) => m.id === selectedModel);
  const hasProviderModels = providerModels.length > 0;

  /* ── Keep selected model valid for currently configured providers ─────────── */
  useEffect(() => {
    if (providerModels.length === 0) return;
    if (!providerModels.some((m) => m.id === selectedModel)) {
      setSelectedModel(providerModels[0].id);
    }
  }, [providerModels, selectedModel, setSelectedModel]);

  useEffect(() => {
    let cancelled = false;

    void resolveSavedProjects(loadSavedProjects()).then((resolved) => {
      if (cancelled) return;
      setProjects(resolved);
      setSelectedProject((prev) =>
        prev ? resolved.find((project) => project.path === prev.path) ?? prev : prev,
      );
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const refreshRecentSessions = async () => {
      const sessions = await loadArchivedSessions();
      if (cancelled) return;
      setRecentSessions(sessions);
    };

    void refreshRecentSessions();
    void listenForSessionChanges((event) => {
      if (!sessionChangeAffectsArchivedSessions(event)) return;
      void refreshRecentSessions();
    }).then((nextUnlisten) => {
      if (cancelled) {
        nextUnlisten?.();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const archivedItems = useMemo(
    () => buildArchivedSessionItems(recentSessions),
    [recentSessions],
  );
  const { pinned: pinnedRecentItems, unpinned: unpinnedRecentItems } = useMemo(
    () => partitionArchivedSessionItems(archivedItems),
    [archivedItems],
  );
  const recentUnpinnedItems = useMemo(
    () => unpinnedRecentItems.slice(0, 5),
    [unpinnedRecentItems],
  );
  const showRecentTabs =
    pinnedRecentItems.length > 0 || recentUnpinnedItems.length > 0;

  const clearRecentScrollbarTimeout = useCallback(() => {
    if (recentScrollbarTimeoutRef.current !== null) {
      window.clearTimeout(recentScrollbarTimeoutRef.current);
      recentScrollbarTimeoutRef.current = null;
    }
  }, []);

  const showRecentScrollbarTemporarily = useCallback(() => {
    setRecentScrollbarVisible(true);
    clearRecentScrollbarTimeout();
    recentScrollbarTimeoutRef.current = window.setTimeout(() => {
      setRecentScrollbarVisible(false);
      recentScrollbarTimeoutRef.current = null;
    }, 700);
  }, [clearRecentScrollbarTimeout]);

  const handleRecentScrollbarMouseEnter = useCallback(() => {
    clearRecentScrollbarTimeout();
    setRecentScrollbarVisible(true);
  }, [clearRecentScrollbarTimeout]);

  const handleRecentScrollbarMouseLeave = useCallback(() => {
    showRecentScrollbarTemporarily();
  }, [showRecentScrollbarTemporarily]);

  useEffect(() => {
    return () => {
      clearRecentScrollbarTimeout();
    };
  }, [clearRecentScrollbarTimeout]);

  /* ── Auto-resize textarea ──────────────────────────────────────────────── */
  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  /* ── Persist advanced options to localStorage when changed ─────────────── */
  const updateAdvancedOptions = useCallback(
    (patch: Partial<AdvancedModelOptions>) => {
      setAdvancedOptions((prev) => {
        const next = { ...prev, ...patch };
        saveAdvancedOptions(next);
        return next;
      });
    },
    [],
  );

  /* ── Submit on Enter (no shift) ────────────────────────────────────────── */
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!selectedModelObj) {
        openSettingsTab("providers");
        return;
      }
      const text = input.trim();
      const ctxLen = selectedModelObj?.context_length;
      if (text) {
        onSubmit(
          text,
          selectedProject
            ? {
                path: selectedProject.path,
                ...(selectedProject.setupCommand
                  ? { setupCommand: selectedProject.setupCommand }
                  : {}),
              }
            : null,
          selectedModelObj.id,
          ctxLen,
          advancedOptions,
          communicationProfile,
        );
      } else {
        onSubmit(
          "",
          selectedProject
            ? {
                path: selectedProject.path,
                ...(selectedProject.setupCommand
                  ? { setupCommand: selectedProject.setupCommand }
                  : {}),
              }
            : null,
          selectedModelObj.id,
          ctxLen,
          advancedOptions,
          communicationProfile,
        );
      }
    }
  };

  const selectProject = (p: SavedProject) => {
    setSelectedProject(p);
    setDropdownOpen(false);
    textareaRef.current?.focus();
  };

  const addProject = useCallback(async (path: string) => {
    const name = path.split("/").filter(Boolean).pop() ?? path;
    const newProject = { path, name };
    const savedProjects = upsertSavedProject(newProject);
    const resolvedProjects = await resolveSavedProjects(savedProjects);
    const resolvedProject =
      resolvedProjects.find((project) => project.path === path) ?? newProject;

    setProjects(resolvedProjects);
    setSelectedProject(resolvedProject);
    setDropdownOpen(false);
    textareaRef.current?.focus();
  }, []);

  const removeProject = useCallback(
    (e: React.SyntheticEvent, projectPath: string) => {
      e.stopPropagation();
      setProjects(removeSavedProject(projectPath));
      if (selectedProject?.path === projectPath) {
        setSelectedProject(null);
      }
    },
    [selectedProject],
  );

  const saveProjectSettings = useCallback(
    async ({ project, writeProjectConfig }: ProjectSettingsSavePayload) => {
      const nextProject = {
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

      const savedProjects = upsertSavedProject(nextProject);
      const resolvedProjects = await resolveSavedProjects(savedProjects);
      const resolvedProject =
        resolvedProjects.find((entry) => entry.path === nextProject.path) ??
        nextProject;

      setProjects(resolvedProjects);
      setSelectedProject((prev) =>
        prev?.path === resolvedProject.path ? resolvedProject : prev,
      );
      setProjectSettingsProject(null);
    },
    [],
  );

  const createProjectConfig = useCallback(
    async ({ project }: ProjectSettingsSavePayload) => {
      const nextProject = {
        path: project.path,
        name: project.name,
        ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
        ...(project.commands?.length ? { commands: project.commands } : {}),
      };

      await writeProjectScriptsConfig(project.path, {
        ...(project.setupCommand ? { setupCommand: project.setupCommand } : {}),
        ...(project.commands?.length ? { commands: project.commands } : {}),
      });

      const savedProjects = upsertSavedProject(nextProject);
      const resolvedProjects = await resolveSavedProjects(savedProjects);
      const resolvedProject =
        resolvedProjects.find((entry) => entry.path === nextProject.path) ??
        nextProject;

      setProjects(resolvedProjects);
      setSelectedProject((prev) =>
        prev?.path === resolvedProject.path ? resolvedProject : prev,
      );
      setProjectSettingsProject(resolvedProject);
    },
    [],
  );

  const handleAddExistingFolder = async () => {
    try {
      const result = await open({
        directory: true,
        multiple: false,
      });
      if (result) {
        addProject(result);
      }
    } catch (error) {
      logFrontendSoon({
        level: "error",
        tags: ["frontend", "system"],
        event: "new-session.select-folder.error",
        message: "Failed to select a folder.",
        data: { error },
      });
    }
  };

  const handleRestoreRecentTab = useCallback(
    async (session: PersistedSession) => {
      await restoreArchivedTab(session, addTabWithId);
      setRecentSessions((prev) => prev.filter((entry) => entry.id !== session.id));
      closeTab(activeTabId);
    },
    [activeTabId, addTabWithId, closeTab],
  );

  const handleTogglePinned = useCallback(async (id: string, pinned: boolean) => {
    await setSessionPinned(id, pinned);
    setRecentSessions((prev) =>
      prev.map((session) =>
        session.id === id ? { ...session, pinned } : session,
      ),
    );
  }, []);

  /* ── Listen to Tauri drag-drop events ───────────────────────────────────── */
  useEffect(() => {
    let unlistenDragDrop: (() => void) | null = null;
    let unlistenDragEnter: (() => void) | null = null;
    let unlistenDragLeave: (() => void) | null = null;

    (async () => {
      // Listen for drag-drop event (when files are dropped)
      unlistenDragDrop = await listen<{
        paths: string[];
        position: { x: number; y: number };
      }>("tauri://drag-drop", (event) => {
        const paths = event.payload.paths;
        if (paths && paths.length > 0) {
          addProject(paths[0]);
        }
        setIsDragging(false);
      });

      // Listen for drag-enter event (when files are dragged over the window)
      unlistenDragEnter = await listen("tauri://drag-enter", () => {
        setIsDragging(true);
      });

      // Listen for drag-leave event (when files are dragged out of the window)
      unlistenDragLeave = await listen("tauri://drag-leave", () => {
        setIsDragging(false);
      });
    })();

    return () => {
      unlistenDragDrop?.();
      unlistenDragEnter?.();
      unlistenDragLeave?.();
    };
  }, [addProject]);

  return (
    <div className="new-session relative">
      {/* Drag overlay */}
      {isDragging && (
        <div className="ns-drag-overlay">
          Drop folder to add as project
        </div>
      )}

      {/* ── Centered content ────────────────────────────────────────────────── */}
      <div className="ns-center">
        <div className="ns-hero">
          {/* ── Selector row: project + model ────────────────────────────── */}
          <div className="ns-selectors-row">
            {/* Project selector pill */}
            <div className="ns-project-control">
              <div className="ns-project-wrap" ref={dropdownRef}>
                <Button
                  className="ns-project-btn"
                  variant="secondary"
                  size="sm"
                  onClick={() => setDropdownOpen((v) => !v)}
                >
                  <span className="material-symbols-outlined text-lg">
                    account_tree
                  </span>
                  <span>
                    {selectedProject ? selectedProject.name : "Select Project"}
                  </span>
                  <span
                    className={cn(
                      "material-symbols-outlined text-md transition-transform duration-200",
                      dropdownOpen ? "rotate-180" : "rotate-0",
                    )}
                  >
                    expand_more
                  </span>
                </Button>

              {/* Project dropdown */}
              {dropdownOpen && (
                <div className="ns-dropdown">
                  {/* Recent projects */}
                  <div className="ns-dropdown-section">
                    <div className="ns-dropdown-label">RECENT PROJECTS</div>
                    {projects.length === 0 ? (
                      <div className="px-[14px] py-[10px] text-sm text-muted">
                        No projects yet. Add a folder below.
                      </div>
                    ) : (
                      projects.map((p) => (
                        <button
                          key={p.path}
                          className="ns-dropdown-item relative"
                          onClick={() => selectProject(p)}
                        >
                          <span className="material-symbols-outlined text-muted text-lg">
                            folder
                          </span>
                          <span className="ns-dropdown-item-name">{p.name}</span>
                          <span className="ns-dropdown-item-path">{p.path}</span>
                          <div
                            role="button"
                            tabIndex={0}
                            className="ns-dropdown-item-remove ml-auto flex items-center justify-center px-1 py-0.5 border-none bg-transparent cursor-pointer opacity-50 transition-opacity hover:opacity-100"
                            onClick={(e) => removeProject(e, p.path)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                removeProject(e, p.path);
                              }
                            }}
                            title="Remove project"
                          >
                            <span className="material-symbols-outlined text-muted text-md">
                              close
                            </span>
                          </div>
                        </button>
                      ))
                    )}
                  </div>

                  <div className="ns-dropdown-divider" />

                  {/* Drag-and-drop hint */}
                  <div className="px-[14px] py-2 text-xs text-muted opacity-55 italic tracking-wider">
                    Drag &amp; drop a folder to a project!
                  </div>

                  <div className="ns-dropdown-divider" />

                  {/* Actions */}
                  <div className="ns-dropdown-section">
                    <button
                      className="ns-dropdown-item opacity-45 cursor-not-allowed"
                      disabled
                    >
                      <span className="material-symbols-outlined text-primary text-lg">
                        add_box
                      </span>
                      <span>Create new project...</span>
                      <span className="shrink-0 text-xxs font-semibold tracking-[0.04em] uppercase px-1.5 py-0.5 rounded bg-inset text-muted">
                        Coming soon
                      </span>
                    </button>
                    <button
                      className="ns-dropdown-item"
                      onClick={handleAddExistingFolder}
                    >
                      <span className="material-symbols-outlined text-primary text-lg">
                        file_upload
                      </span>
                      <span>Add existing folder...</span>
                    </button>
                  </div>
                </div>
              )}
              </div>
              {selectedProject ? (
                <IconButton
                  className="ns-project-settings-btn"
                  onClick={() => setProjectSettingsProject(selectedProject)}
                  title={`Project settings for ${selectedProject.name}`}
                  type="button"
                >
                  <span className="material-symbols-outlined text-md">tune</span>
                </IconButton>
              ) : null}
            </div>

            <NewSessionModelSelector
              models={providerModels}
              selectedModel={selectedModel}
              onSelectModel={setSelectedModel}
              onModelSelected={() => textareaRef.current?.focus()}
              loading={modelsLoading}
              error={modelsError}
              hasAnyProviderKey={hasAnyProviderKey}
              advancedOptions={advancedOptions}
              onAdvancedOptionsChange={updateAdvancedOptions}
              communicationProfile={communicationProfile}
              onCommunicationProfileChange={setCommunicationProfile}
            />
          </div>
          {/* end ns-selectors-row */}

          {/* Main input */}
          <div className="ns-input-wrap">
            <textarea
              ref={textareaRef}
              className="ns-input"
              placeholder="What are we building?"
              value={input}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              rows={1}
              autoFocus
            />
            {/* Focus underline */}
            <div className="ns-underline" />

            {!hasAnyProviderKey ? (
              <ProviderSetupHint
                className="mt-2"
                providers={providers}
                onProvidersChange={setProviders}
                onOpenSettings={() => openSettingsTab("providers")}
              />
            ) : (
              <div className="flex justify-between items-baseline mt-2">
                {!hasProviderModels ? (
                  <button
                    className="ns-hint flex items-center gap-1 text-sm text-error opacity-90 bg-transparent border-none p-0 cursor-pointer"
                    onClick={() => openSettingsTab("providers")}
                  >
                    <span className="material-symbols-outlined text-md">
                      warning
                    </span>
                    <span>
                      No tool-capable OpenAI/Claude models are available for your
                      configured keys.
                    </span>
                  </button>
                ) : (
                  <p
                    className={cn(
                      "ns-hint pointer-events-none not-italic ns-hint--skip",
                      focused && !input && "ns-hint--skip-visible",
                    )}
                  >
                    Press <kbd className="ns-kbd align-middle">↵</kbd> to skip
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

      </div>

      {showRecentTabs ? (
        <div className="ns-recent-dock">
          <section
            className={cn(
              "ns-recent-panel",
              recentScrollbarVisible && "ns-recent-panel--scrollbar-visible",
            )}
            aria-label="Recent tabs"
            onScroll={showRecentScrollbarTemporarily}
            onMouseEnter={handleRecentScrollbarMouseEnter}
            onMouseLeave={handleRecentScrollbarMouseLeave}
          >
            {pinnedRecentItems.length > 0 ? (
              <div className="ns-recent-section">
                <div className="ns-recent-list">
                  {pinnedRecentItems.map((item) => (
                    <RecentTabRow
                      key={item.session.id}
                      item={item}
                      onRestore={handleRestoreRecentTab}
                      onTogglePinned={handleTogglePinned}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {recentUnpinnedItems.length > 0 ? (
              <div className="ns-recent-section">
                <div className="ns-recent-section-label">
                  <span
                    className="material-symbols-outlined ns-recent-section-icon"
                    aria-hidden
                  >
                    history
                  </span>
                  <span>Recent tabs</span>
                </div>
                <div className="ns-recent-list">
                  {recentUnpinnedItems.map((item) => (
                    <RecentTabRow
                      key={item.session.id}
                      item={item}
                      onRestore={handleRestoreRecentTab}
                      onTogglePinned={handleTogglePinned}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      {/* TODO(issue #55): ⌘+K doesn't work yet, hide footer message for now
      <footer className="ns-footer">
        <span>Select Project</span>
        <kbd className="ns-kbd">⌘ K</kbd>
        <span>or Type Command</span>
      </footer>
      */}
      {projectSettingsProject ? (
        <ProjectSettingsModal
          key={projectSettingsProject.path}
          project={projectSettingsProject}
          onClose={() => setProjectSettingsProject(null)}
          onSave={saveProjectSettings}
          onCreateProjectConfig={createProjectConfig}
        />
      ) : null}
    </div>
  );
}
