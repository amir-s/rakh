import {
  editProjectLearnedFact,
  loadSavedProjectForWorkspace,
  mergeProjectLearnedFacts,
  removeProjectLearnedFacts,
  upsertSavedProject,
  type ProjectLearnedFact,
} from "@/projects";
import { getAgentState } from "../atoms";
import type { ToolResult } from "../types";

export interface ProjectMemoryRuntimeContext {
  agentId?: string;
}

export interface ProjectMemoryAddInput {
  facts?: string[];
}

export interface ProjectMemoryAddOutput {
  projectPath: string;
  learnedFacts: ProjectLearnedFact[];
  addedFacts: ProjectLearnedFact[];
  updated: boolean;
}

export interface ProjectMemoryRemoveInput {
  factIds?: string[];
}

export interface ProjectMemoryRemoveOutput {
  projectPath: string;
  learnedFacts: ProjectLearnedFact[];
  removedFacts: ProjectLearnedFact[];
  updated: boolean;
}

export interface ProjectMemoryEditInput {
  factId?: string;
  text?: string;
}

export interface ProjectMemoryEditOutput {
  projectPath: string;
  learnedFacts: ProjectLearnedFact[];
  updatedFact?: ProjectLearnedFact;
  updated: boolean;
}

function canWriteProjectMemory(agentId: string | undefined): boolean {
  const callerId = agentId?.trim() || "agent_main";
  return callerId === "agent_main" || callerId === "agent_compact";
}

async function loadProjectMemoryTarget(tabId: string) {
  const state = getAgentState(tabId);
  return loadSavedProjectForWorkspace(
    state.config.projectPath,
    state.config.cwd,
  );
}

function missingProjectMemoryProject(): ToolResult<never> {
  return {
    ok: false,
    error: {
      code: "NOT_FOUND",
      message:
        "No saved project record is associated with this session, so project memory cannot be updated.",
    },
  };
}

function nextProjectWithLearnedFacts(
  project: NonNullable<Awaited<ReturnType<typeof loadProjectMemoryTarget>>>,
  learnedFacts: ProjectLearnedFact[] | undefined,
) {
  const nextProject = {
    ...project,
    ...(learnedFacts?.length ? { learnedFacts } : {}),
  };
  if (!learnedFacts?.length) {
    delete nextProject.learnedFacts;
  }
  return nextProject;
}

export async function projectMemoryAdd(
  tabId: string,
  runtime: ProjectMemoryRuntimeContext | undefined,
  input: ProjectMemoryAddInput,
): Promise<ToolResult<ProjectMemoryAddOutput>> {
  if (!canWriteProjectMemory(runtime?.agentId)) {
    return {
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message:
          "Project memory can only be updated by the main agent or context compaction subagent.",
      },
    };
  }

  try {
    const project = await loadProjectMemoryTarget(tabId);
    if (!project) {
      return missingProjectMemoryProject();
    }

    const merged = mergeProjectLearnedFacts(
      project.learnedFacts,
      Array.isArray(input.facts) ? input.facts : [],
    );

    if (!merged.updated) {
      return {
        ok: true,
        data: {
          projectPath: project.path,
          learnedFacts: project.learnedFacts ?? [],
          addedFacts: [],
          updated: false,
        },
      };
    }

    const savedProjects = await upsertSavedProject({
      ...project,
      ...(merged.learnedFacts?.length
        ? { learnedFacts: merged.learnedFacts }
        : {}),
    });
    const persisted =
      savedProjects.find((entry) => entry.path === project.path) ?? {
        ...project,
        ...(merged.learnedFacts?.length
          ? { learnedFacts: merged.learnedFacts }
          : {}),
      };

    return {
      ok: true,
      data: {
        projectPath: persisted.path,
        learnedFacts: persisted.learnedFacts ?? [],
        addedFacts: merged.addedFacts,
        updated: true,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message:
          error instanceof Error ? error.message : "Failed to update project memory.",
      },
    };
  }
}

export async function projectMemoryRemove(
  tabId: string,
  runtime: ProjectMemoryRuntimeContext | undefined,
  input: ProjectMemoryRemoveInput,
): Promise<ToolResult<ProjectMemoryRemoveOutput>> {
  if (!canWriteProjectMemory(runtime?.agentId)) {
    return {
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message:
          "Project memory can only be updated by the main agent or context compaction subagent.",
      },
    };
  }

  try {
    const project = await loadProjectMemoryTarget(tabId);
    if (!project) {
      return missingProjectMemoryProject();
    }

    const removed = removeProjectLearnedFacts(
      project.learnedFacts,
      Array.isArray(input.factIds) ? input.factIds : [],
    );

    if (!removed.updated) {
      return {
        ok: true,
        data: {
          projectPath: project.path,
          learnedFacts: project.learnedFacts ?? [],
          removedFacts: [],
          updated: false,
        },
      };
    }

    const nextProject = nextProjectWithLearnedFacts(project, removed.learnedFacts);
    const savedProjects = await upsertSavedProject(nextProject);
    const persisted =
      savedProjects.find((entry) => entry.path === project.path) ?? nextProject;

    return {
      ok: true,
      data: {
        projectPath: persisted.path,
        learnedFacts: persisted.learnedFacts ?? [],
        removedFacts: removed.removedFacts,
        updated: true,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message:
          error instanceof Error ? error.message : "Failed to update project memory.",
      },
    };
  }
}

export async function projectMemoryEdit(
  tabId: string,
  runtime: ProjectMemoryRuntimeContext | undefined,
  input: ProjectMemoryEditInput,
): Promise<ToolResult<ProjectMemoryEditOutput>> {
  if (!canWriteProjectMemory(runtime?.agentId)) {
    return {
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message:
          "Project memory can only be updated by the main agent or context compaction subagent.",
      },
    };
  }

  try {
    const project = await loadProjectMemoryTarget(tabId);
    if (!project) {
      return missingProjectMemoryProject();
    }

    const edited = editProjectLearnedFact(
      project.learnedFacts,
      input.factId,
      input.text,
    );

    if (edited.error === "missing_fact") {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "The requested project-memory fact does not exist.",
        },
      };
    }
    if (edited.error === "duplicate_text") {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message:
            "Another learned fact already has that exact text. Remove the duplicate instead of editing into it.",
        },
      };
    }

    if (!edited.updated) {
      return {
        ok: true,
        data: {
          projectPath: project.path,
          learnedFacts: project.learnedFacts ?? [],
          ...(edited.updatedFact ? { updatedFact: edited.updatedFact } : {}),
          updated: false,
        },
      };
    }

    const nextProject = nextProjectWithLearnedFacts(project, edited.learnedFacts);
    const savedProjects = await upsertSavedProject(nextProject);
    const persisted =
      savedProjects.find((entry) => entry.path === project.path) ?? nextProject;
    const updatedFact =
      persisted.learnedFacts?.find((fact) => fact.id === input.factId) ??
      edited.updatedFact;

    return {
      ok: true,
      data: {
        projectPath: persisted.path,
        learnedFacts: persisted.learnedFacts ?? [],
        ...(updatedFact ? { updatedFact } : {}),
        updated: true,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message:
          error instanceof Error ? error.message : "Failed to update project memory.",
      },
    };
  }
}
