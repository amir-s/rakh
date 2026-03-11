import type { PersistedSession } from "@/agent/persistence";
import { findSavedProject, inferProjectName } from "@/projects";
import { rankFuzzyItems } from "@/utils/fuzzySearch";

const UNKNOWN_PROJECT_KEY = "__archived_unknown_project__";
export const UNKNOWN_PROJECT_LABEL = "Unknown Project";

export interface ArchivedSessionItem {
  projectKey: string;
  projectLabel: string;
  projectPath: string;
  session: PersistedSession;
}

export interface ArchivedProjectGroup {
  count: number;
  key: string;
  label: string;
  path: string;
  sessions: ArchivedSessionItem[];
  updatedAt: number;
}

export interface ArchivedSearchResult extends ArchivedSessionItem {
  score: number;
}

function getProjectPath(session: PersistedSession): string {
  return session.projectPath.trim() || session.cwd.trim();
}

function getProjectMeta(session: PersistedSession): {
  key: string;
  label: string;
  path: string;
} {
  const projectPath = getProjectPath(session);
  if (!projectPath) {
    return {
      key: UNKNOWN_PROJECT_KEY,
      label: UNKNOWN_PROJECT_LABEL,
      path: "",
    };
  }

  return {
    key: projectPath,
    label: findSavedProject(projectPath)?.name ?? inferProjectName(projectPath),
    path: projectPath,
  };
}

function sortItemsByRecency(a: ArchivedSessionItem, b: ArchivedSessionItem): number {
  return (
    b.session.updatedAt - a.session.updatedAt ||
    a.session.label.localeCompare(b.session.label)
  );
}

export function buildArchivedSessionItems(
  sessions: PersistedSession[],
): ArchivedSessionItem[] {
  return sessions
    .map((session) => {
      const project = getProjectMeta(session);
      return {
        session,
        projectKey: project.key,
        projectLabel: project.label,
        projectPath: project.path,
      };
    })
    .sort(sortItemsByRecency);
}

export function groupArchivedSessionItems(
  items: ArchivedSessionItem[],
): ArchivedProjectGroup[] {
  const groupsByKey = new Map<string, ArchivedProjectGroup>();

  for (const item of items) {
    const existing = groupsByKey.get(item.projectKey);
    if (existing) {
      existing.sessions.push(item);
      existing.count += 1;
      if (item.session.updatedAt > existing.updatedAt) {
        existing.updatedAt = item.session.updatedAt;
      }
      continue;
    }

    groupsByKey.set(item.projectKey, {
      key: item.projectKey,
      label: item.projectLabel,
      path: item.projectPath,
      sessions: [item],
      count: 1,
      updatedAt: item.session.updatedAt,
    });
  }

  return Array.from(groupsByKey.values())
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort(sortItemsByRecency),
    }))
    .sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || a.label.localeCompare(b.label),
    );
}

export function searchArchivedSessionItems(
  items: ArchivedSessionItem[],
  query: string,
): ArchivedSearchResult[] {
  return rankFuzzyItems(items, query, (item) => [
    item.session.label,
    item.session.tabTitle,
    item.projectLabel,
    item.projectPath,
    item.session.cwd,
  ])
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.item.session.updatedAt - a.item.session.updatedAt ||
        a.index - b.index,
    )
    .map(({ item, score }) => ({ ...item, score }));
}
