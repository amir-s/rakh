import type { AgentState } from "../types";
import { loadSavedProjectForWorkspace } from "@/projects";

import {
  buildSystemPrompt,
  buildSystemPromptRuntimeContext,
} from "./systemPrompt";

interface WorkspacePromptCapabilities {
  isGitRepo: boolean;
  hasAgentsFile: boolean;
  hasSkillsDir: boolean;
}

const LEGACY_TOOL_CONTEXT_COMPACTION_MARKERS = [
  "__contextCompaction",
  "TOOL IO CONTEXT COMPACTION",
];

async function inspectWorkspaceForSystemPrompt(
  cwd: string,
): Promise<WorkspacePromptCapabilities> {
  let isGitRepo = false;
  let hasAgentsFile = false;
  let hasSkillsDir = false;

  if (!cwd) {
    return { isGitRepo, hasAgentsFile, hasSkillsDir };
  }

  try {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    const gitResult = await tauriInvoke<{ exitCode: number }>("exec_run", {
      command: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd,
      env: {},
      timeoutMs: 5000,
      maxStdoutBytes: 512,
      maxStderrBytes: 512,
      stdin: null,
    });
    isGitRepo = gitResult.exitCode === 0;

    const agentsStat = await tauriInvoke<{ exists: boolean; kind?: string }>(
      "stat_file",
      {
        path: `${cwd}/AGENTS.md`,
      },
    );
    hasAgentsFile = agentsStat.exists && agentsStat.kind === "file";

    const skillsStat = await tauriInvoke<{ exists: boolean; kind?: string }>(
      "stat_file",
      {
        path: `${cwd}/.agents/skills`,
      },
    );
    hasSkillsDir = skillsStat.exists && skillsStat.kind === "dir";
  } catch {
    // Not in Tauri or git not available.
  }

  return { isGitRepo, hasAgentsFile, hasSkillsDir };
}

function getExistingSystemPrompt(state: AgentState): string | null {
  const systemMessage = state.apiMessages[0];
  if (systemMessage?.role !== "system") return null;
  if (
    typeof systemMessage.content !== "string" ||
    systemMessage.content.trim().length === 0
  ) {
    return null;
  }
  if (
    LEGACY_TOOL_CONTEXT_COMPACTION_MARKERS.some((marker) =>
      systemMessage.content.includes(marker),
    )
  ) {
    return null;
  }
  return systemMessage.content;
}

interface BuildMainSystemPromptOptions {
  forceRefresh?: boolean;
}

export async function buildMainSystemPromptForState(
  state: AgentState,
  options: BuildMainSystemPromptOptions = {},
): Promise<string> {
  if (!options.forceRefresh) {
    const existingPrompt = getExistingSystemPrompt(state);
    if (existingPrompt) return existingPrompt;
  }

  const cwd = state.config.cwd;
  const [workspaceInfo, project] = await Promise.all([
    inspectWorkspaceForSystemPrompt(cwd),
    loadSavedProjectForWorkspace(state.config.projectPath, cwd),
  ]);

  return buildSystemPrompt(
    cwd,
    workspaceInfo.isGitRepo,
    workspaceInfo.hasAgentsFile,
    workspaceInfo.hasSkillsDir,
    buildSystemPromptRuntimeContext(),
    project?.learnedFacts,
    state.config.communicationProfile,
  );
}
