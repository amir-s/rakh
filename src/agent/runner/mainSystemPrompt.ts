import {
  jotaiStore,
  toolContextCompactionEnabledAtom,
} from "../atoms";
import type { AgentState } from "../types";
import {
  loadSavedProjectForWorkspace,
  normalizeLearnedFacts,
} from "@/projects";

import {
  buildSystemPrompt,
  buildSystemPromptRuntimeContext,
  getCommunicationInstruction,
  parseSystemPromptRuntimeContext,
  type SystemPromptRuntimeContext,
} from "./systemPrompt";

interface WorkspacePromptCapabilities {
  isGitRepo: boolean;
  hasAgentsFile: boolean;
  hasSkillsDir: boolean;
}

interface MainSystemPromptCacheEntry {
  prompt: string;
  runtimeContext: SystemPromptRuntimeContext;
  structuralKey: string;
}

const mainSystemPromptCache = new Map<string, MainSystemPromptCacheEntry>();

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
  return typeof systemMessage.content === "string" &&
    systemMessage.content.trim().length > 0
    ? systemMessage.content
    : null;
}

function buildStructuralKey(input: {
  cwd: string;
  isGitRepo: boolean;
  hasAgentsFile: boolean;
  hasSkillsDir: boolean;
  communicationInstruction: string | null;
  toolContextCompactionEnabled: boolean;
  projectLearnedFacts: unknown;
}): string {
  return JSON.stringify({
    cwd: input.cwd,
    isGitRepo: input.isGitRepo,
    hasAgentsFile: input.hasAgentsFile,
    hasSkillsDir: input.hasSkillsDir,
    communicationInstruction: input.communicationInstruction ?? "",
    toolContextCompactionEnabled: input.toolContextCompactionEnabled,
    projectLearnedFacts: normalizeLearnedFacts(input.projectLearnedFacts) ?? [],
  });
}

function resolveRuntimeContext(
  state: AgentState,
  cachedEntry: MainSystemPromptCacheEntry | undefined,
): SystemPromptRuntimeContext {
  if (cachedEntry) return cachedEntry.runtimeContext;

  const existingPrompt = getExistingSystemPrompt(state);
  if (existingPrompt) {
    const parsed = parseSystemPromptRuntimeContext(existingPrompt);
    if (parsed) return parsed;
  }

  return buildSystemPromptRuntimeContext();
}

export function clearMainSystemPromptCache(tabId?: string): void {
  if (typeof tabId === "string") {
    mainSystemPromptCache.delete(tabId);
    return;
  }
  mainSystemPromptCache.clear();
}

export async function buildMainSystemPromptForState(
  tabId: string,
  state: AgentState,
): Promise<string> {
  const cwd = state.config.cwd;
  const [workspaceInfo, project] = await Promise.all([
    inspectWorkspaceForSystemPrompt(cwd),
    loadSavedProjectForWorkspace(state.config.projectPath, cwd),
  ]);
  const communicationInstruction = getCommunicationInstruction(
    state.config.communicationProfile,
  );
  const toolContextCompactionEnabled =
    jotaiStore.get(toolContextCompactionEnabledAtom) !== false;

  const structuralKey = buildStructuralKey({
    cwd,
    ...workspaceInfo,
    communicationInstruction,
    toolContextCompactionEnabled,
    projectLearnedFacts: project?.learnedFacts,
  });

  const cachedEntry = mainSystemPromptCache.get(tabId);
  if (cachedEntry?.structuralKey === structuralKey) {
    return cachedEntry.prompt;
  }

  const runtimeContext = resolveRuntimeContext(state, cachedEntry);
  const prompt = buildSystemPrompt(
    cwd,
    workspaceInfo.isGitRepo,
    workspaceInfo.hasAgentsFile,
    workspaceInfo.hasSkillsDir,
    runtimeContext,
    project?.learnedFacts,
    state.config.communicationProfile,
    toolContextCompactionEnabled,
  );

  mainSystemPromptCache.set(tabId, {
    prompt,
    runtimeContext,
    structuralKey,
  });
  return prompt;
}
