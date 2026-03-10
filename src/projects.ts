import {
  loadProjectScriptsConfig,
  normalizeProjectScriptsConfig,
  type ProjectCommandConfig,
  type ProjectScriptsConfigState,
} from "@/projectScripts";

export interface SavedProject {
  path: string;
  name: string;
  setupCommand?: string;
  commands?: ProjectCommandConfig[];
  hasProjectConfigFile?: boolean;
}

export const PROJECTS_STORAGE_KEY = "rakh-projects";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function inferProjectName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function normalizeSetupCommand(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCommands(value: unknown): ProjectCommandConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const commands = normalizeProjectScriptsConfig({ commands: value })?.commands ?? [];
  return commands.length > 0 ? commands : undefined;
}

export function normalizeSavedProject(value: unknown): SavedProject | null {
  if (!isRecord(value)) return null;

  const rawPath = typeof value.path === "string" ? value.path.trim() : "";
  if (!rawPath) return null;

  const rawName = typeof value.name === "string" ? value.name.trim() : "";
  return {
    path: rawPath,
    name: rawName || inferProjectName(rawPath),
    ...(normalizeSetupCommand(value.setupCommand)
      ? { setupCommand: normalizeSetupCommand(value.setupCommand) }
      : {}),
    ...(normalizeCommands(value.commands)
      ? { commands: normalizeCommands(value.commands) }
      : {}),
  };
}

export function applyProjectScriptsConfig(
  project: SavedProject,
  configState: ProjectScriptsConfigState,
): SavedProject {
  if (!configState.exists) {
    const normalized = normalizeSavedProject(project);
    return normalized ?? {
      path: project.path,
      name: project.name,
    };
  }

  return {
    path: project.path,
    name: project.name,
    hasProjectConfigFile: true,
    ...(configState.config?.setupCommand
      ? { setupCommand: configState.config.setupCommand }
      : {}),
    ...(configState.config?.commands?.length
      ? { commands: configState.config.commands }
      : {}),
  };
}

export async function resolveSavedProject(project: SavedProject): Promise<SavedProject> {
  const configState = await loadProjectScriptsConfig(project.path);
  return applyProjectScriptsConfig(project, configState);
}

export async function resolveSavedProjects(
  projects: SavedProject[],
): Promise<SavedProject[]> {
  return Promise.all(projects.map((project) => resolveSavedProject(project)));
}

export function loadSavedProjects(): SavedProject[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    const deduped = new Map<string, SavedProject>();
    for (const item of parsed) {
      const normalized = normalizeSavedProject(item);
      if (normalized) {
        deduped.set(normalized.path, normalized);
      }
    }
    return Array.from(deduped.values());
  } catch {
    return [];
  }
}

export function saveSavedProjects(projects: SavedProject[]): void {
  if (typeof window === "undefined") return;

  try {
    const normalized = projects
      .map((project) => normalizeSavedProject(project))
      .filter((project): project is SavedProject => project !== null);
    window.localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch (error) {
    console.error("Failed to save projects:", error);
  }
}

export function upsertSavedProject(project: SavedProject): SavedProject[] {
  const normalized = normalizeSavedProject(project);
  if (!normalized) return loadSavedProjects();

  const projects = loadSavedProjects();
  const next = [
    ...projects.filter((entry) => entry.path !== normalized.path),
    normalized,
  ];
  saveSavedProjects(next);
  return next;
}

export function removeSavedProject(projectPath: string): SavedProject[] {
  const next = loadSavedProjects().filter((project) => project.path !== projectPath);
  saveSavedProjects(next);
  return next;
}

export function findSavedProject(projectPath: string): SavedProject | null {
  return loadSavedProjects().find((project) => project.path === projectPath) ?? null;
}
