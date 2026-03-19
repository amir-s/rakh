import {
  loadProjectScriptsConfig,
  normalizeProjectScriptsConfig,
  type ProjectCommandConfig,
  type ProjectScriptsConfigState,
} from "@/projectScripts";
import { logFrontendSoon } from "@/logging/client";

export const DEFAULT_PROJECT_ICON = "folder";
export const MAX_PROJECT_LEARNED_FACTS = 50;

export interface ProjectLearnedFact {
  id: string;
  text: string;
}

export interface SavedProject {
  path: string;
  name: string;
  icon?: string;
  setupCommand?: string;
  commands?: ProjectCommandConfig[];
  githubIntegrationEnabled?: boolean;
  learnedFacts?: ProjectLearnedFact[];
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

function normalizeProjectLookupPath(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
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

function normalizeGitHubIntegrationEnabled(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeProjectIcon(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PROJECT_ICON;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_PROJECT_ICON;
}

function createProjectLearnedFactId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (typeof randomUUID === "function") {
    return `fact_${randomUUID()}`;
  }
  return `fact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeLearnedFactText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLearnedFactId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLearnedFact(value: unknown): ProjectLearnedFact | null {
  if (typeof value === "string") {
    const text = normalizeLearnedFactText(value);
    return text ? { id: createProjectLearnedFactId(), text } : null;
  }

  if (!isRecord(value)) return null;
  const text = normalizeLearnedFactText(value.text);
  if (!text) return null;

  return {
    id: normalizeLearnedFactId(value.id) ?? createProjectLearnedFactId(),
    text,
  };
}

export function normalizeLearnedFacts(
  value: unknown,
): ProjectLearnedFact[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const facts: ProjectLearnedFact[] = [];
  const seenTexts = new Set<string>();
  for (const entry of value) {
    const fact = normalizeLearnedFact(entry);
    if (!fact || seenTexts.has(fact.text)) continue;
    seenTexts.add(fact.text);
    facts.push(fact);
  }

  if (facts.length === 0) return undefined;
  return facts.slice(-MAX_PROJECT_LEARNED_FACTS);
}

function normalizeIncomingLearnedFactTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const facts: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = normalizeLearnedFactText(entry);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    facts.push(text);
  }

  return facts;
}

function normalizeLearnedFactIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const id = normalizeLearnedFactId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

export function cloneLearnedFacts(
  learnedFacts: readonly ProjectLearnedFact[] | undefined,
): ProjectLearnedFact[] | undefined {
  const normalized = normalizeLearnedFacts(learnedFacts);
  return normalized?.map((fact) => ({ ...fact }));
}

export function getLearnedFactTexts(
  learnedFacts: readonly ProjectLearnedFact[] | undefined,
): string[] {
  return (normalizeLearnedFacts(learnedFacts) ?? []).map((fact) => fact.text);
}

export function mergeProjectLearnedFacts(
  existing: readonly ProjectLearnedFact[] | undefined,
  incoming: readonly string[] | undefined,
): {
  learnedFacts?: ProjectLearnedFact[];
  addedFacts: ProjectLearnedFact[];
  updated: boolean;
} {
  const current = normalizeLearnedFacts(existing) ?? [];
  const nextCandidates = normalizeIncomingLearnedFactTexts(incoming);
  if (nextCandidates.length === 0) {
    return {
      ...(current.length > 0 ? { learnedFacts: cloneLearnedFacts(current) } : {}),
      addedFacts: [],
      updated: false,
    };
  }

  const merged = current.map((fact) => ({ ...fact }));
  const seenTexts = new Set(current.map((fact) => fact.text));
  const addedFacts: ProjectLearnedFact[] = [];
  for (const text of nextCandidates) {
    if (seenTexts.has(text)) continue;
    seenTexts.add(text);
    const fact = { id: createProjectLearnedFactId(), text };
    merged.push(fact);
    addedFacts.push(fact);
  }

  const learnedFacts = merged.slice(-MAX_PROJECT_LEARNED_FACTS);
  return {
    ...(learnedFacts.length > 0 ? { learnedFacts } : {}),
    addedFacts,
    updated: addedFacts.length > 0,
  };
}

export function removeProjectLearnedFacts(
  existing: readonly ProjectLearnedFact[] | undefined,
  removals: readonly string[] | undefined,
): {
  learnedFacts?: ProjectLearnedFact[];
  removedFacts: ProjectLearnedFact[];
  updated: boolean;
} {
  const current = normalizeLearnedFacts(existing) ?? [];
  const nextRemovals = normalizeLearnedFactIds(removals);
  if (current.length === 0 || nextRemovals.length === 0) {
    return {
      ...(current.length > 0 ? { learnedFacts: cloneLearnedFacts(current) } : {}),
      removedFacts: [],
      updated: false,
    };
  }

  const toRemove = new Set(nextRemovals);
  const learnedFacts = current.filter((fact) => !toRemove.has(fact.id));
  const removedFacts = current.filter((fact) => toRemove.has(fact.id));
  return {
    ...(learnedFacts.length > 0 ? { learnedFacts } : {}),
    removedFacts,
    updated: removedFacts.length > 0,
  };
}

export function editProjectLearnedFact(
  existing: readonly ProjectLearnedFact[] | undefined,
  factId: string | undefined,
  nextText: string | undefined,
): {
  learnedFacts?: ProjectLearnedFact[];
  updatedFact?: ProjectLearnedFact;
  updated: boolean;
  error?: "duplicate_text" | "missing_fact";
} {
  const current = normalizeLearnedFacts(existing) ?? [];
  const normalizedFactId = normalizeLearnedFactId(factId);
  const normalizedNextText = normalizeLearnedFactText(nextText);
  if (current.length === 0 || !normalizedFactId || !normalizedNextText) {
    return {
      ...(current.length > 0 ? { learnedFacts: cloneLearnedFacts(current) } : {}),
      updated: false,
      error: "missing_fact",
    };
  }

  const target = current.find((fact) => fact.id === normalizedFactId);
  if (!target) {
    return {
      learnedFacts: cloneLearnedFacts(current),
      updated: false,
      error: "missing_fact",
    };
  }

  if (target.text === normalizedNextText) {
    return {
      learnedFacts: cloneLearnedFacts(current),
      updatedFact: { ...target },
      updated: false,
    };
  }

  const duplicate = current.find(
    (fact) => fact.id !== normalizedFactId && fact.text === normalizedNextText,
  );
  if (duplicate) {
    return {
      learnedFacts: cloneLearnedFacts(current),
      updated: false,
      error: "duplicate_text",
    };
  }

  const learnedFacts = current.map((fact) =>
    fact.id === normalizedFactId ? { ...fact, text: normalizedNextText } : { ...fact },
  );
  const updatedFact = learnedFacts.find((fact) => fact.id === normalizedFactId);
  return {
    learnedFacts,
    ...(updatedFact ? { updatedFact } : {}),
    updated: true,
  };
}

function findSavedProjectInList(
  projects: SavedProject[],
  projectPath: string | undefined,
  cwd?: string,
): SavedProject | null {
  const normalizedProjectPath = normalizeProjectLookupPath(projectPath);
  if (normalizedProjectPath) {
    const match =
      projects.find((project) => project.path === normalizedProjectPath) ?? null;
    if (match) return match;
  }

  const normalizedCwd = normalizeProjectLookupPath(cwd);
  if (!normalizedCwd) return null;
  return projects.find((project) => project.path === normalizedCwd) ?? null;
}

export function normalizeSavedProject(value: unknown): SavedProject | null {
  if (!isRecord(value)) return null;

  const rawPath = typeof value.path === "string" ? value.path.trim() : "";
  if (!rawPath) return null;

  const rawName = typeof value.name === "string" ? value.name.trim() : "";
  const setupCommand = normalizeSetupCommand(value.setupCommand);
  const commands = normalizeCommands(value.commands);
  const githubIntegrationEnabled = normalizeGitHubIntegrationEnabled(
    value.githubIntegrationEnabled,
  );
  const learnedFacts = normalizeLearnedFacts(value.learnedFacts);
  return {
    path: rawPath,
    name: rawName || inferProjectName(rawPath),
    icon: normalizeProjectIcon(value.icon),
    ...(setupCommand ? { setupCommand } : {}),
    ...(commands ? { commands } : {}),
    ...(githubIntegrationEnabled === true
      ? { githubIntegrationEnabled: true }
      : {}),
    ...(learnedFacts ? { learnedFacts } : {}),
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
    ...(normalized.learnedFacts?.length
      ? { learnedFacts: cloneLearnedFacts(normalized.learnedFacts) }
      : {}),
    hasProjectConfigFile: true,
    ...(configState.config?.setupCommand
      ? { setupCommand: configState.config.setupCommand }
      : {}),
    ...(configState.config?.commands?.length
      ? { commands: configState.config.commands }
      : {}),
    ...(configState.config?.githubIntegrationEnabled === true
      ? { githubIntegrationEnabled: true }
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

function cloneSavedProject(project: SavedProject): SavedProject {
  return {
    ...project,
    ...(project.learnedFacts?.length
      ? { learnedFacts: cloneLearnedFacts(project.learnedFacts) }
      : {}),
    ...(project.commands?.length
      ? { commands: [...project.commands] }
      : {}),
  };
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
    ...(normalized.learnedFacts?.length
      ? { learnedFacts: cloneLearnedFacts(normalized.learnedFacts) }
      : {}),
    ...(normalized.setupCommand
      ? { setupCommand: normalized.setupCommand }
      : {}),
    ...(normalized.commands?.length ? { commands: normalized.commands } : {}),
    ...(normalized.githubIntegrationEnabled === true
      ? { githubIntegrationEnabled: true }
      : {}),
  };
}

export function getSavedProjects(): SavedProject[] {
  return savedProjectsCache.map((project) => cloneSavedProject(project));
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

export async function upsertSavedProjectPreservingLearnedFacts(
  project: SavedProject,
): Promise<SavedProject[]> {
  const normalized = normalizeSavedProject(project);
  if (!normalized) return loadSavedProjects();

  const projects = await loadSavedProjects();
  const existing =
    projects.find((entry) => entry.path === normalized.path) ?? null;
  const nextProject =
    !normalized.learnedFacts && existing?.learnedFacts?.length
      ? {
          ...normalized,
          learnedFacts: cloneLearnedFacts(existing.learnedFacts),
        }
      : normalized;
  const next = [
    ...projects.filter((entry) => entry.path !== normalized.path),
    nextProject,
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
  const project =
    savedProjectsCache.find((entry) => entry.path === projectPath) ?? null;
  return project ? cloneSavedProject(project) : null;
}

export function findSavedProjectForWorkspace(
  projectPath?: string,
  cwd?: string,
): SavedProject | null {
  const project = findSavedProjectInList(savedProjectsCache, projectPath, cwd);
  return project ? cloneSavedProject(project) : null;
}

export async function loadSavedProjectForWorkspace(
  projectPath?: string,
  cwd?: string,
): Promise<SavedProject | null> {
  const projects = await loadSavedProjects();
  return findSavedProjectInList(projects, projectPath, cwd);
}
