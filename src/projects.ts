import {
  loadProjectScriptsConfig,
  normalizeProjectScriptsConfig,
  type ProjectCommandConfig,
  type ProjectScriptsConfigState,
} from "@/projectScripts";
import { logFrontendSoon } from "@/logging/client";

export const DEFAULT_PROJECT_ICON = "folder";

export interface SavedProject {
  path: string;
  name: string;
  icon?: string;
  setupCommand?: string;
  commands?: ProjectCommandConfig[];
  hasProjectConfigFile?: boolean;
}

let savedProjectsCache: SavedProject[] = [];
let loadSavedProjectsPromise: Promise<SavedProject[]> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
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

function normalizeProjectIcon(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PROJECT_ICON;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_PROJECT_ICON;
}

export function normalizeSavedProject(value: unknown): SavedProject | null {
  if (!isRecord(value)) return null;

  const rawPath = typeof value.path === "string" ? value.path.trim() : "";
  if (!rawPath) return null;

  const rawName = typeof value.name === "string" ? value.name.trim() : "";
  return {
    path: rawPath,
    name: rawName || inferProjectName(rawPath),
    icon: normalizeProjectIcon(value.icon),
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
  const normalized = normalizeSavedProject(project) ?? {
    path: project.path,
    name: inferProjectName(project.path),
    icon: DEFAULT_PROJECT_ICON,
  };
  if (!configState.exists) {
    return normalized;
  }

  return {
    path: normalized.path,
    name: normalized.name,
    icon: normalized.icon,
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

function dedupeSavedProjects(projects: SavedProject[]): SavedProject[] {
  const deduped = new Map<string, SavedProject>();
  for (const project of projects) {
    const normalized = normalizeSavedProject(project);
    if (normalized) {
      deduped.set(normalized.path, normalized);
    }
  }
  return Array.from(deduped.values());
}

function setSavedProjectsCache(projects: SavedProject[]): SavedProject[] {
  savedProjectsCache = dedupeSavedProjects(projects);
  return getSavedProjects();
}

function serializeSavedProject(project: SavedProject): SavedProject {
  const normalized = normalizeSavedProject(project);
  if (!normalized) {
    throw new Error("Cannot serialise an invalid saved project.");
  }

  return {
    path: normalized.path,
    name: normalized.name,
    icon: normalized.icon,
    ...(normalized.setupCommand
      ? { setupCommand: normalized.setupCommand }
      : {}),
    ...(normalized.commands?.length ? { commands: normalized.commands } : {}),
  };
}

export function getSavedProjects(): SavedProject[] {
  return [...savedProjectsCache];
}

export async function loadSavedProjects(): Promise<SavedProject[]> {
  if (typeof window === "undefined" || !isTauriRuntime()) {
    return getSavedProjects();
  }
  if (loadSavedProjectsPromise) {
    return loadSavedProjectsPromise;
  }

  loadSavedProjectsPromise = (async () => {
    try {
      const projects = await invoke<unknown[]>("projects_load");
      if (!Array.isArray(projects)) {
        return setSavedProjectsCache([]);
      }
      return setSavedProjectsCache(
        projects
          .map((project) => normalizeSavedProject(project))
          .filter((project): project is SavedProject => project !== null),
      );
    } catch (error) {
      logFrontendSoon({
        level: "error",
        tags: ["frontend", "system"],
        event: "projects.load.error",
        message: "Failed to load projects from config.",
        data: { error },
      });
      return getSavedProjects();
    } finally {
      loadSavedProjectsPromise = null;
    }
  })();

  return loadSavedProjectsPromise;
}

export async function saveSavedProjects(
  projects: SavedProject[],
): Promise<SavedProject[]> {
  const normalized = projects
    .map((project) => normalizeSavedProject(project))
    .filter((project): project is SavedProject => project !== null)
    .map((project) => serializeSavedProject(project));
  const next = setSavedProjectsCache(normalized);
  if (typeof window === "undefined" || !isTauriRuntime()) {
    return next;
  }

  try {
    await invoke("projects_save", { projects: normalized });
  } catch (error) {
    logFrontendSoon({
      level: "error",
      tags: ["frontend", "system"],
      event: "projects.save.error",
      message: "Failed to save projects to config.",
      data: { error },
    });
  }

  return next;
}

export async function upsertSavedProject(
  project: SavedProject,
): Promise<SavedProject[]> {
  const normalized = normalizeSavedProject(project);
  if (!normalized) return loadSavedProjects();

  const projects = await loadSavedProjects();
  const next = [
    ...projects.filter((entry) => entry.path !== normalized.path),
    normalized,
  ];
  return saveSavedProjects(next);
}

export async function removeSavedProject(projectPath: string): Promise<SavedProject[]> {
  const next = (await loadSavedProjects()).filter(
    (project) => project.path !== projectPath,
  );
  return saveSavedProjects(next);
}

export function findSavedProject(projectPath: string): SavedProject | null {
  return (
    savedProjectsCache.find((project) => project.path === projectPath) ?? null
  );
}
