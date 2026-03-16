import {
  loadSavedProjectForWorkspace,
  mergeProjectLearnedFacts,
  upsertSavedProject,
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
  learnedFacts: string[];
  addedFacts: string[];
  updated: boolean;
}

function canWriteProjectMemory(agentId: string | undefined): boolean {
  const callerId = agentId?.trim() || "agent_main";
  return callerId === "agent_main" || callerId === "agent_compact";
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

  const state = getAgentState(tabId);

  try {
    const project = await loadSavedProjectForWorkspace(
      state.config.projectPath,
      state.config.cwd,
    );
    if (!project) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message:
            "No saved project record is associated with this session, so project memory cannot be updated.",
        },
      };
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
