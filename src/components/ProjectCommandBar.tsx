import type { ReactNode } from "react";
import type { ProjectCommandConfig } from "@/projectScripts";
import { cn } from "@/utils/cn";

export function shouldShowProjectCommandLabel(
  command: Pick<ProjectCommandConfig, "icon" | "showLabel">,
): boolean {
  return command.showLabel !== false || !command.icon?.trim();
}

interface ProjectCommandBarProps {
  commands: ProjectCommandConfig[];
  onCommandClick: (command: ProjectCommandConfig) => void;
  buttonAriaLabel?: (command: ProjectCommandConfig) => string;
  buttonTitle?: (command: ProjectCommandConfig) => string;
  className?: string;
  variant?: "workspace" | "modal";
  trailingContent?: ReactNode;
}

export default function ProjectCommandBar({
  commands,
  onCommandClick,
  buttonAriaLabel = (command) => `Run ${command.label}`,
  buttonTitle = (command) => `${command.label} • ${command.command}`,
  className,
  variant = "workspace",
  trailingContent,
}: ProjectCommandBarProps) {
  if (commands.length === 0) return null;

  return (
    <div
      className={cn("project-command-bar", `project-command-bar--${variant}`, className)}
      role="toolbar"
      aria-label="Project commands"
    >
      <div className="project-command-bar__scroll">
        {commands.map((command, index) => {
          const showLabel = shouldShowProjectCommandLabel(command);
          return (
            <button
              key={command.id ?? `${command.label}-${command.command}-${index}`}
              type="button"
              className={cn(
                "project-command-button",
                !showLabel && "project-command-button--icon-only",
              )}
              title={buttonTitle(command)}
              aria-label={buttonAriaLabel(command)}
              onClick={() => onCommandClick(command)}
            >
              <span
                className="material-symbols-outlined text-base"
                aria-hidden="true"
              >
                {command.icon?.trim() || "terminal"}
              </span>
              {showLabel ? (
                <span className="project-command-button__label">
                  {command.label}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {trailingContent ? (
        <div className="project-command-bar__trailing">{trailingContent}</div>
      ) : null}
    </div>
  );
}
