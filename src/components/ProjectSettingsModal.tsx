import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_PROJECT_ICON, type SavedProject } from "@/projects";
import { searchMaterialSymbolsOutlined } from "@/materialSymbols";
import { PROJECT_SCRIPTS_CONFIG_PATH } from "@/projectScripts";
import type { ProjectCommandConfig } from "@/projectScripts";
import ProjectCommandBar from "@/components/ProjectCommandBar";
import { Button, ModalShell, TextField, ToggleSwitch } from "@/components/ui";

export interface ProjectSettingsSavePayload {
  project: SavedProject;
  writeProjectConfig: boolean;
}

interface CommandDraft {
  draftId: string;
  label: string;
  command: string;
  icon: string;
  showLabel: boolean;
}

type ProjectConfigStage = "hidden" | "creating" | "visible";

interface EditingCommandState {
  draft: CommandDraft;
  editingId: string | null;
}

interface CommandIconOption {
  value: string;
}

interface IconMenuPosition {
  top: number;
  left: number;
  width: number;
}

const PROJECT_COMMAND_ICON_OPTIONS: CommandIconOption[] = [
  { value: "" },
  { value: "play_arrow" },
  { value: "settings" },
  { value: "pest_control" },
  { value: "cleaning_services" },
  { value: "science" },
  { value: "package_2" },
  { value: "install_desktop" },
];
const PROJECT_ICON_SEARCH_RESULT_LIMIT = 36;

function createCommandDraft(command?: ProjectCommandConfig): CommandDraft {
  return {
    draftId:
      command?.id?.trim() ||
      `cmd-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
    label: command?.label ?? "",
    command: command?.command ?? "",
    icon: command?.icon ?? "",
    showLabel: command?.showLabel ?? true,
  };
}

function buildCommands(drafts: CommandDraft[]): ProjectCommandConfig[] {
  return drafts
    .map<ProjectCommandConfig | null>((draft) => {
      const label = draft.label.trim();
      const command = draft.command.trim();
      const icon = draft.icon.trim();
      if (!label || !command) return null;

      return {
        id: draft.draftId,
        label,
        command,
        ...(icon ? { icon } : {}),
        ...(draft.showLabel !== true ? { showLabel: false } : {}),
      };
    })
    .filter((command): command is ProjectCommandConfig => command !== null);
}

function normalizeCommandDraft(draft: CommandDraft): CommandDraft | null {
  const label = draft.label.trim();
  const command = draft.command.trim();
  const icon = draft.icon.trim();
  if (!label || !command) return null;

  return {
    ...draft,
    label,
    command,
    icon,
  };
}

function getCommandIconOptions(currentIcon: string): CommandIconOption[] {
  const normalizedIcon = currentIcon.trim();
  if (
    !normalizedIcon ||
    PROJECT_COMMAND_ICON_OPTIONS.some(
      (option) => option.value === normalizedIcon,
    )
  ) {
    return PROJECT_COMMAND_ICON_OPTIONS;
  }

  return [{ value: normalizedIcon }, ...PROJECT_COMMAND_ICON_OPTIONS];
}

function getCommandIconAriaLabel(icon: string): string {
  return icon || "No icon";
}

interface ProjectSettingsModalProps {
  project: SavedProject;
  onClose: () => void;
  onSave: (payload: ProjectSettingsSavePayload) => void | Promise<void>;
  onCreateProjectConfig: (
    payload: ProjectSettingsSavePayload,
  ) => void | Promise<void>;
}

function buildProjectPayload(
  project: SavedProject,
  projectName: string,
  projectIcon: string,
  setupCommand: string,
  commands: CommandDraft[],
): SavedProject {
  const normalizedName = projectName.trim() || project.name;
  const normalizedIcon = projectIcon.trim() || DEFAULT_PROJECT_ICON;
  const nextCommands = buildCommands(commands);
  return {
    name: normalizedName,
    path: project.path,
    icon: normalizedIcon,
    ...(setupCommand.trim() ? { setupCommand: setupCommand.trim() } : {}),
    ...(nextCommands.length > 0 ? { commands: nextCommands } : {}),
  };
}

export default function ProjectSettingsModal({
  project,
  onClose,
  onSave,
  onCreateProjectConfig,
}: ProjectSettingsModalProps) {
  const [projectName, setProjectName] = useState(project.name);
  const [projectIcon, setProjectIcon] = useState(
    project.icon?.trim() || DEFAULT_PROJECT_ICON,
  );
  const [projectIconPickerOpen, setProjectIconPickerOpen] = useState(false);
  const [projectIconSearchQuery, setProjectIconSearchQuery] = useState("");
  const [setupCommand, setSetupCommand] = useState(project.setupCommand ?? "");
  const [commands, setCommands] = useState<CommandDraft[]>(
    project.commands?.map((command) => createCommandDraft(command)) ?? [],
  );
  const [editingCommand, setEditingCommand] =
    useState<EditingCommandState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [hasProjectConfigFile, setHasProjectConfigFile] = useState(
    Boolean(project.hasProjectConfigFile),
  );
  const [projectConfigStage, setProjectConfigStage] =
    useState<ProjectConfigStage>(
      project.hasProjectConfigFile ? "visible" : "hidden",
    );
  const [projectConfigError, setProjectConfigError] = useState<string | null>(
    null,
  );
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconMenuPosition, setIconMenuPosition] =
    useState<IconMenuPosition | null>(null);
  const [projectIconMenuPosition, setProjectIconMenuPosition] =
    useState<IconMenuPosition | null>(null);
  const iconTriggerRef = useRef<HTMLButtonElement | null>(null);
  const iconMenuRef = useRef<HTMLDivElement | null>(null);
  const projectIconTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectIconSearchInputRef = useRef<HTMLInputElement | null>(null);
  const projectIconMenuRef = useRef<HTMLDivElement | null>(null);
  const projectConfigPath = `${project.path}/${PROJECT_SCRIPTS_CONFIG_PATH}`;
  const shouldShowRepoConfigSection =
    !hasProjectConfigFile && projectConfigStage !== "visible";
  const selectedCommandIcon = editingCommand?.draft.icon.trim() ?? "";
  const commandIconOptions = getCommandIconOptions(selectedCommandIcon);
  const normalizedProjectIcon = projectIcon.trim();
  const projectIconMatches = useMemo(
    () =>
      searchMaterialSymbolsOutlined(
        projectIconSearchQuery,
        PROJECT_ICON_SEARCH_RESULT_LIMIT,
      ),
    [projectIconSearchQuery],
  );
  const previewCommands = useMemo<ProjectCommandConfig[]>(
    () =>
      commands.map((command) => ({
        id: command.draftId,
        label: command.label.trim() || "Untitled",
        command: command.command.trim(),
        ...(command.icon.trim() ? { icon: command.icon.trim() } : {}),
        ...(command.showLabel !== true ? { showLabel: false } : {}),
      })),
    [commands],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (projectIconPickerOpen) {
        setProjectIconPickerOpen(false);
        return;
      }
      if (iconPickerOpen) {
        setIconPickerOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [iconPickerOpen, onClose, projectIconPickerOpen]);

  useEffect(() => {
    setIconPickerOpen(false);
    setIconMenuPosition(null);
  }, [editingCommand?.draft.draftId]);

  useEffect(() => {
    if (!projectIconPickerOpen) return;

    const updateProjectIconMenuPosition = () => {
      const rect = projectIconTriggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      setProjectIconMenuPosition({
        top: rect.bottom + 8,
        left: rect.left,
        width: Math.max(rect.width + 220, 320),
      });
    };

    const handlePointerDown = (event: MouseEvent) => {
      if (
        projectIconTriggerRef.current?.contains(event.target as Node) ||
        projectIconMenuRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setProjectIconPickerOpen(false);
    };

    updateProjectIconMenuPosition();
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", updateProjectIconMenuPosition);
    window.addEventListener("scroll", updateProjectIconMenuPosition, true);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", updateProjectIconMenuPosition);
      window.removeEventListener("scroll", updateProjectIconMenuPosition, true);
    };
  }, [projectIconPickerOpen]);

  useEffect(() => {
    if (projectIconPickerOpen) return;
    setProjectIconMenuPosition(null);
  }, [projectIconPickerOpen]);

  useEffect(() => {
    if (!iconPickerOpen) return;

    const updateIconMenuPosition = () => {
      const rect = iconTriggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      setIconMenuPosition({
        top: rect.bottom + 8,
        left: rect.left,
        width: Math.max(rect.width, 176),
      });
    };

    const handlePointerDown = (event: MouseEvent) => {
      if (
        iconTriggerRef.current?.contains(event.target as Node) ||
        iconMenuRef.current?.contains(event.target as Node)
      ) {
        return;
      }

      setIconPickerOpen(false);
    };

    updateIconMenuPosition();
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", updateIconMenuPosition);
    window.addEventListener("scroll", updateIconMenuPosition, true);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", updateIconMenuPosition);
      window.removeEventListener("scroll", updateIconMenuPosition, true);
    };
  }, [iconPickerOpen]);

  useEffect(() => {
    if (iconPickerOpen) return;
    setIconMenuPosition(null);
  }, [iconPickerOpen]);

  const iconMenu =
    iconPickerOpen && iconMenuPosition
      ? createPortal(
          <div
            ref={iconMenuRef}
            className="project-settings-modal__icon-menu"
            role="listbox"
            aria-label="Command icon options"
            onClick={(event) => event.stopPropagation()}
            style={{
              top: `${iconMenuPosition.top}px`,
              left: `${iconMenuPosition.left}px`,
              minWidth: `${iconMenuPosition.width}px`,
            }}
          >
            {commandIconOptions.map((option) => {
              const isSelected = option.value === selectedCommandIcon;

              return (
                <button
                  key={option.value || "none"}
                  type="button"
                  role="option"
                  aria-label={getCommandIconAriaLabel(option.value)}
                  aria-selected={isSelected}
                  className="project-settings-modal__icon-option"
                  onClick={() => {
                    setEditingCommand((prev) =>
                      prev
                        ? {
                            ...prev,
                            draft: {
                              ...prev.draft,
                              icon: option.value,
                            },
                          }
                        : prev,
                    );
                    setIconPickerOpen(false);
                  }}
                >
                  {option.value ? (
                    <span
                      className="material-symbols-outlined text-base"
                      aria-hidden="true"
                    >
                      {option.value}
                    </span>
                  ) : (
                    <span
                      className="project-settings-modal__icon-placeholder"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  const projectIconMenu =
    projectIconPickerOpen && projectIconMenuPosition
      ? createPortal(
          <div
            ref={projectIconMenuRef}
            className="project-settings-modal__project-icon-menu"
            role="dialog"
            aria-label="Project icon picker"
            onClick={(event) => event.stopPropagation()}
            style={{
              top: `${projectIconMenuPosition.top}px`,
              left: `${projectIconMenuPosition.left}px`,
              minWidth: `${projectIconMenuPosition.width}px`,
            }}
          >
            <TextField
              ref={projectIconSearchInputRef}
              type="text"
              value={projectIconSearchQuery}
              onChange={(event) => setProjectIconSearchQuery(event.target.value)}
              placeholder="Search icons"
              className="project-settings-modal__input"
              wrapClassName="project-settings-modal__input-wrap"
              aria-label="Search project icons"
              autoComplete="off"
            />
            <div
              className="project-settings-modal__project-icon-list"
              role="listbox"
              aria-label="Project icon options"
            >
            {projectIconMatches.length > 0 ? (
              projectIconMatches.map((iconName) => (
                <button
                  key={iconName}
                  type="button"
                  role="option"
                  aria-label={iconName}
                  aria-selected={iconName === normalizedProjectIcon}
                  className="project-settings-modal__project-icon-option"
                  onClick={() => {
                    setProjectIcon(iconName);
                    setProjectIconPickerOpen(false);
                    setProjectIconSearchQuery("");
                  }}
                >
                  <span
                    className="material-symbols-outlined text-base"
                    aria-hidden="true"
                  >
                    {iconName}
                  </span>
                  <span className="project-settings-modal__project-icon-option-label">
                    {iconName}
                  </span>
                </button>
              ))
            ) : (
              <div className="project-settings-modal__project-icon-empty">
                No matching Material Symbols icons.
              </div>
            )}
            </div>
          </div>,
          document.body,
        )
      : null;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const nextProject = buildProjectPayload(
        project,
        projectName,
        projectIcon,
        setupCommand,
        commands,
      );
      await onSave({
        project: nextProject,
        writeProjectConfig: hasProjectConfigFile,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateProjectConfig = async () => {
    setProjectConfigError(null);
    setProjectConfigStage("creating");
    try {
      const nextProject = buildProjectPayload(
        project,
        projectName,
        projectIcon,
        setupCommand,
        commands,
      );
      await onCreateProjectConfig({
        project: nextProject,
        writeProjectConfig: true,
      });
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 2400);
      });
      setHasProjectConfigFile(true);
      setProjectConfigStage("visible");
    } catch (error) {
      setProjectConfigStage("hidden");
      setProjectConfigError(String(error));
    }
  };

  const saveEditingCommand = () => {
    if (!editingCommand) return;
    const normalizedDraft = normalizeCommandDraft(editingCommand.draft);
    if (!normalizedDraft) return;

    setCommands((prev) => {
      const next = normalizedDraft;
      if (editingCommand.editingId) {
        return prev.map((command) =>
          command.draftId === editingCommand.editingId ? next : command,
        );
      }
      return [...prev, next];
    });
    setEditingCommand(null);
  };

  const openProjectIconPicker = () => {
    setProjectIconPickerOpen(true);
    setProjectIconSearchQuery("");
    window.requestAnimationFrame(() => {
      projectIconSearchInputRef.current?.focus();
    });
  };

  return createPortal(
    <div
      className="error-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label={`Project settings for ${project.name}`}
    >
      <ModalShell
        className="error-modal tool-modal project-settings-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="error-modal-header">
          <span className="error-modal-title tool-modal-title">
            <span className="material-symbols-outlined text-muted shrink-0 text-md">
              tune
            </span>
            Project Settings
          </span>
          <Button
            className="error-modal-close"
            onClick={onClose}
            title="Close (Esc)"
            variant="ghost"
            size="xxs"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </Button>
        </div>

        <div className="error-modal-body project-settings-modal__body">
          <div className="tool-modal-section">
            <div className="tool-modal-section-label">Project</div>
            <div className="project-settings-modal__path">{project.path}</div>
            <div className="project-settings-modal__project-row">
              <button
                ref={projectIconTriggerRef}
                type="button"
                className="project-settings-modal__project-icon-preview"
                aria-label={`Selected project icon ${normalizedProjectIcon || DEFAULT_PROJECT_ICON}`}
                onClick={openProjectIconPicker}
              >
                <span className="material-symbols-outlined text-base">
                  {normalizedProjectIcon || DEFAULT_PROJECT_ICON}
                </span>
              </button>
              <TextField
                type="text"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="Project name"
                className="project-settings-modal__input"
                wrapClassName="project-settings-modal__input-wrap"
                autoFocus
                aria-label="Project name"
              />
            </div>
          </div>

          <div className="tool-modal-section">
            <div className="tool-modal-section-label">Setup Command</div>
            <TextField
              type="text"
              value={setupCommand}
              onChange={(event) => setSetupCommand(event.target.value)}
              placeholder="npm install && npm run build"
              className="project-settings-modal__input"
              wrapClassName="project-settings-modal__input-wrap"
            />
            <p className="project-settings-modal__hint">
              Runs inside the new worktree after branch creation and before the
              agent continues.
            </p>
          </div>

          <div className="tool-modal-section">
            <div className="project-settings-modal__commands-header">
              <div>
                <div className="tool-modal-section-label">Project Commands</div>
                <p className="project-settings-modal__hint">
                  Add shortcuts for commands you frequently run in this project.
                </p>
              </div>
              <Button
                variant="primary"
                size="xxs"
                leftIcon={
                  <span
                    className="material-symbols-outlined text-base"
                    aria-hidden="true"
                  >
                    add
                  </span>
                }
                onClick={() =>
                  setEditingCommand({
                    draft: createCommandDraft(),
                    editingId: null,
                  })
                }
                type="button"
                disabled={editingCommand !== null}
              >
                ADD
              </Button>
            </div>

            <ProjectCommandBar
              commands={previewCommands}
              variant="modal"
              buttonAriaLabel={(command) => `Edit command ${command.label}`}
              buttonTitle={(command) => `Edit ${command.label}`}
              onCommandClick={(command) => {
                const matchingCommand = commands.find(
                  (entry) => entry.draftId === command.id,
                );
                if (!matchingCommand) return;
                setEditingCommand({
                  draft: { ...matchingCommand },
                  editingId: matchingCommand.draftId,
                });
              }}
            />

            {editingCommand ? (
              <div className="project-settings-modal__command-card">
                <div className="project-settings-modal__command-grid">
                  <TextField
                    type="text"
                    value={editingCommand.draft.label}
                    onChange={(event) =>
                      setEditingCommand((prev) =>
                        prev
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                label: event.target.value,
                              },
                            }
                          : prev,
                      )
                    }
                    placeholder="Label (e.g. Run app)"
                    className="project-settings-modal__input"
                    wrapClassName="project-settings-modal__input-wrap"
                  />
                  <div className="project-settings-modal__icon-picker">
                    <button
                      type="button"
                      ref={iconTriggerRef}
                      className="project-settings-modal__icon-trigger"
                      aria-label={`Command icon ${getCommandIconAriaLabel(selectedCommandIcon)}`}
                      aria-haspopup="listbox"
                      aria-expanded={iconPickerOpen}
                      onClick={() => setIconPickerOpen((prev) => !prev)}
                    >
                      {selectedCommandIcon ? (
                        <span
                          className="material-symbols-outlined text-base"
                          aria-hidden="true"
                        >
                          {selectedCommandIcon}
                        </span>
                      ) : (
                        <span
                          className="project-settings-modal__icon-placeholder"
                          aria-hidden="true"
                        />
                      )}
                      <span
                        className="material-symbols-outlined text-base project-settings-modal__icon-trigger-chevron"
                        aria-hidden="true"
                      >
                        expand_more
                      </span>
                    </button>
                  </div>
                </div>
                <TextField
                  type="text"
                  value={editingCommand.draft.command}
                  onChange={(event) =>
                    setEditingCommand((prev) =>
                      prev
                        ? {
                            ...prev,
                            draft: {
                              ...prev.draft,
                              command: event.target.value,
                            },
                          }
                        : prev,
                    )
                  }
                  placeholder="Command (e.g. npm run dev)"
                  className="project-settings-modal__input"
                  wrapClassName="project-settings-modal__input-wrap"
                />
                <div className="project-settings-modal__command-footer">
                  <label className="project-settings-modal__show-label">
                    <span>Show label</span>
                    <ToggleSwitch
                      checked={editingCommand.draft.showLabel}
                      onChange={(next) =>
                        setEditingCommand((prev) =>
                          prev
                            ? {
                                ...prev,
                                draft: { ...prev.draft, showLabel: next },
                              }
                            : prev,
                        )
                      }
                      title="Toggle label visibility"
                    />
                  </label>
                  <div className="project-settings-modal__command-editor-actions">
                    {editingCommand.editingId ? (
                      <Button
                        variant="danger"
                        size="xxs"
                        type="button"
                        leftIcon={
                          <span
                            className="material-symbols-outlined text-base"
                            aria-hidden="true"
                          >
                            delete
                          </span>
                        }
                        onClick={() => {
                          setCommands((prev) =>
                            prev.filter(
                              (entry) =>
                                entry.draftId !== editingCommand.editingId,
                            ),
                          );
                          setEditingCommand(null);
                        }}
                      >
                        DELETE
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="xxs"
                      type="button"
                      onClick={() => setEditingCommand(null)}
                    >
                      CANCEL
                    </Button>
                    <Button
                      variant="primary"
                      size="xxs"
                      type="button"
                      onClick={saveEditingCommand}
                    >
                      SAVE
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {shouldShowRepoConfigSection ? (
            <div className="tool-modal-section project-settings-modal__repo-config">
              <div className="project-settings-modal__repo-row">
                <div className="project-settings-modal__repo-copy">
                  <div className="tool-modal-section-label">
                    Project Config File
                  </div>
                  <p className="project-settings-modal__hint">
                    Save scripts to{" "}
                    <code className="text-primary">
                      {PROJECT_SCRIPTS_CONFIG_PATH}
                    </code>{" "}
                    inside this repo.
                  </p>
                  {projectConfigError ? (
                    <p className="project-settings-modal__hint text-error">
                      {projectConfigError}
                    </p>
                  ) : null}
                </div>

                <div className="project-settings-modal__repo-actions">
                  <Button
                    variant="primary"
                    size="xxs"
                    type="button"
                    loading={projectConfigStage === "creating"}
                    onClick={() => {
                      void handleCreateProjectConfig();
                    }}
                    disabled={projectConfigStage === "creating" || isSaving}
                  >
                    {projectConfigStage === "creating"
                      ? "CREATING REPO CONFIG FILE"
                      : "CREATE REPO CONFIG FILE"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="error-modal-footer project-settings-modal__footer">
          <div className="project-settings-modal__footer-meta">
            {hasProjectConfigFile || projectConfigStage === "visible" ? (
              <>
                <span className="project-settings-modal__footer-meta-label">
                  stored in
                </span>{" "}
                <span className="project-settings-modal__footer-path">
                  {projectConfigPath}
                </span>
              </>
            ) : null}
          </div>
          <div className="project-settings-modal__footer-actions">
            <Button
              onClick={onClose}
              variant="ghost"
              size="xxs"
              disabled={isSaving || projectConfigStage === "creating"}
            >
              CANCEL
            </Button>
            <Button
              onClick={() => {
                void handleSave();
              }}
              variant="primary"
              size="xxs"
              loading={isSaving}
              disabled={isSaving || projectConfigStage === "creating"}
            >
              SAVE
            </Button>
          </div>
        </div>
      </ModalShell>
      {iconMenu}
      {projectIconMenu}
    </div>,
    document.body,
  );
}
