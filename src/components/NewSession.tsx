import {
  useState,
  useRef,
  useEffect,
  useCallback,
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
import { Button } from "@/components/ui";
import type {
  AdvancedModelOptions,
  LatencyCostProfile,
  ReasoningEffort,
  ReasoningVisibility,
} from "@/agent/types";
import { DEFAULT_ADVANCED_OPTIONS } from "@/agent/types";

/* ─────────────────────────────────────────────────────────────────────────────
   Projects
───────────────────────────────────────────────────────────────────────────── */

type Project = { path: string; name: string };

const PROJECTS_STORAGE_KEY = "rakh-projects";

function loadProjects(): Project[] {
  try {
    const stored = localStorage.getItem(PROJECTS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveProjects(projects: Project[]) {
  try {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch (error) {
    console.error("Failed to save projects:", error);
  }
}

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
    cwd: string,
    model: string,
    contextLength?: number,
    advancedOptions?: AdvancedModelOptions,
  ) => void;
}

export default function NewSession({ onSubmit }: NewSessionProps) {
  const [input, setInput] = useState("");
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [advancedOptions, setAdvancedOptions] = useState<AdvancedModelOptions>(loadAdvancedOptions);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { models, loading: modelsLoading, error: modelsError } = useModels();
  const [selectedModel, setSelectedModel] = useSelectedModel(models);
  const [providers, setProviders] = useAtom(providersAtom);
  const { openSettingsTab } = useTabs();
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
        onSubmit(text, selectedProject?.path ?? "", selectedModelObj.id, ctxLen, advancedOptions);
      } else {
        onSubmit("", selectedProject?.path ?? "", selectedModelObj.id, ctxLen, advancedOptions);
      }
    }
  };

  const selectProject = (p: Project) => {
    setSelectedProject(p);
    setDropdownOpen(false);
    textareaRef.current?.focus();
  };

  /* ── Persist projects to localStorage whenever they change ────────────────── */
  useEffect(() => {
    saveProjects(projects);
  }, [projects]);

  const addProject = useCallback((path: string) => {
    const name = path.split("/").filter(Boolean).pop() ?? path;
    const newProject = { path, name };

    // Check if project already exists
    setProjects((prev) => {
      if (prev.some((p) => p.path === path)) {
        return prev;
      }
      return [...prev, newProject];
    });

    setSelectedProject(newProject);
    setDropdownOpen(false);
    textareaRef.current?.focus();
  }, []);

  const removeProject = useCallback(
    (e: React.SyntheticEvent, projectPath: string) => {
      e.stopPropagation();
      setProjects((prev) => prev.filter((p) => p.path !== projectPath));
      if (selectedProject?.path === projectPath) {
        setSelectedProject(null);
      }
    },
    [selectedProject],
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
      console.error("Failed to select folder:", error);
    }
  };

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
        {/* ── Selector row: project + model ────────────────────────────── */}
        <div className="ns-selectors-row">
          {/* Project selector pill */}
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

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      {/* TODO(issue #55): ⌘+K doesn't work yet, hide footer message for now
      <footer className="ns-footer">
        <span>Select Project</span>
        <kbd className="ns-kbd">⌘ K</kbd>
        <span>or Type Command</span>
      </footer>
      */}
    </div>
  );
}
