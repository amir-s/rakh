import { toJSONSchema } from "zod";
import { normalizeLearnedFacts, type ProjectLearnedFact } from "@/projects";

import { jotaiStore, globalCommunicationProfileAtom } from "../atoms";
import { getCommunicationProfileRecord } from "../communicationProfiles";
import { profilesAtom, type ProviderInstance } from "../db";
import { getModelCatalogEntry } from "../modelCatalog";
import {
  getCallableSubagents,
  getSubagentArtifactSpecs,
  type SubagentDefinition,
} from "../subagents";
import type { SubagentArtifactSpec } from "../subagents/types";

export interface SystemPromptRuntimeContext {
  hostOs: string;
  locale: string;
  timeZone: string;
  localDate: string;
  localTime: string;
  utcIso: string;
}

function detectHostOs(): "windows" | "linux" | "mac" {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent ?? "";
  const platform = navigator.platform ?? "";

  if (/win/i.test(platform) || /windows/i.test(ua)) return "windows";
  if (/mac/i.test(platform) || /macintosh|mac os x/i.test(ua)) return "mac";
  return "linux";
}

export function buildSystemPromptRuntimeContext(
  now = new Date(),
): SystemPromptRuntimeContext {
  const intlOptions = Intl.DateTimeFormat().resolvedOptions();
  return {
    hostOs: detectHostOs(),
    locale: intlOptions.locale ?? "unknown",
    timeZone: intlOptions.timeZone ?? "unknown",
    localDate: now.toLocaleDateString(),
    localTime: now.toLocaleTimeString(),
    utcIso: now.toISOString(),
  };
}

export function parseSystemPromptRuntimeContext(
  prompt: string,
): SystemPromptRuntimeContext | null {
  const match = prompt.match(
    /^You are Rakh, an autonomous AI coding agent\.\nWorkspace root: [^\n]*\nHost OS: ([^\n]*)\nLocale: ([^\n]*)\nTimezone: ([^\n]*)\nToday's local date: ([^\n]*)\nCurrent local time: ([^\n]*)\nCurrent UTC timestamp: ([^\n]*)\n/,
  );
  if (!match) return null;

  const [, hostOs, locale, timeZone, localDate, localTime, utcIso] = match;
  if (
    hostOs === undefined ||
    locale === undefined ||
    timeZone === undefined ||
    localDate === undefined ||
    localTime === undefined ||
    utcIso === undefined
  ) {
    return null;
  }

  return {
    hostOs,
    locale,
    timeZone,
    localDate,
    localTime,
    utcIso,
  };
}

export function getCommunicationInstruction(
  profile: string | undefined,
): string | null {
  const defaultProfileId = jotaiStore.get(globalCommunicationProfileAtom);
  const profiles = jotaiStore.get(profilesAtom);
  const match = getCommunicationProfileRecord(
    profile,
    profiles,
    defaultProfileId,
  );
  return match ? match.promptSnippet : null;
}

function renderProjectMemorySection(
  projectLearnedFacts: readonly ProjectLearnedFact[] | undefined,
): string {
  const learnedFacts = normalizeLearnedFacts(projectLearnedFacts) ?? [];
  if (learnedFacts.length === 0) return "";

  return `

PROJECT MEMORY
These learned facts come from the saved project's long-term memory. Treat them as durable project context and standing user requirements unless newer user input corrects them.
Each entry includes its stable fact ID so you can remove or edit the correct record later.
${learnedFacts.map((fact) => `- ${fact.id}: ${fact.text}`).join("\n")}`;
}

function renderToolContextCompactionSection(): string {
  return `TOOL IO CONTEXT COMPACTION
- You are highly encouraged to use context compaction for large local-tool payloads.
- You can annotate tool calls with hidden \`__contextCompaction\` runner metadata to keep a memory of the input or output without storing the full raw payload in the conversation history.
- This metadata is accepted on local tool-call schemas so providers can emit it, but the runner strips it before local tool validation/execution and ignores it on unsupported tools.
- Shape:
  \`__contextCompaction: { inputNote?: string, outputNote?: string, outputMode?: "always" | "on_success" }\`
- Use it only when the exact raw IO would add a lot of context bloat and a short deterministic note is enough for future continuity.
- Keep notes short, concrete, and factual. Describe what was omitted and why the exact payload is unnecessary.
- Prefer \`outputMode: "on_success"\` for commands or other tool outputs where failures may need the full diagnostics.
- Supported local-tool input compaction: \`workspace_writeFile\`, \`workspace_editFile\`, \`agent_artifact_create\`, \`agent_artifact_version\`, \`exec_run\`.
- Supported local-tool output compaction: \`workspace_readFile\`, \`workspace_search\`, \`workspace_glob\`, \`workspace_listDir\`, \`exec_run\`, \`git_worktree_init\`, \`agent_artifact_get\`.
- Do NOT attach \`__contextCompaction\` to MCP tools, \`agent_subagent_call\`, \`user_input\`, todo/title/card tools, or small payloads where keeping the full IO is better.`;
}

export function buildSystemPrompt(
  cwd: string,
  isGitRepo: boolean,
  hasAgentsFile: boolean,
  hasSkillsDir: boolean,
  runtimeContext: SystemPromptRuntimeContext,
  projectLearnedFacts: readonly ProjectLearnedFact[] | undefined,
  communicationProfile: string | undefined,
  toolContextCompactionEnabled = true,
): string {
  const gitSection = isGitRepo
    ? `

GIT ISOLATION
- Before **writing any new files** or **modifying any files**, call git_worktree_init exactly once with a short suggested branch name (e.g. "feat/add-dark-mode").
- Never call git_worktree_init more than once per session — it is idempotent and will no-op if already set up or declined.
- Do not call git_worktree_init if you don't need to make file changes — it's only necessary if you need isolation for your edits in the same session.
- If the user declines, proceed working directly in the main workspace without asking again.`
    : "";

  return `You are Rakh, an autonomous AI coding agent.
Workspace root: ${cwd}
Host OS: ${runtimeContext.hostOs}
Locale: ${runtimeContext.locale}
Timezone: ${runtimeContext.timeZone}
Today's local date: ${runtimeContext.localDate}
Current local time: ${runtimeContext.localTime}
Current UTC timestamp: ${runtimeContext.utcIso}
${renderProjectMemorySection(projectLearnedFacts)}

You can read, write, modify, and execute code inside this workspace.

UNDERSTAND THE REQUEST
Before acting, determine what the user wants:
- Question ("how do I...", "what is...", "explain..."): Answer concisely in text without invoking tools. Offer to execute if it makes sense.
- Task (imperative: "add", "fix", "refactor", "build"): Act on it immediately.
When in doubt, bias toward action over explanation.

TASK COMPLEXITY
- Simple tasks (single-file edits, quick fixes, lookups): Be concise, use judgment. Do NOT create a plan or todos — just do the work.
- Complex tasks (multi-file changes, new features, architectural work): Use agent_plan_set and agent_todo_add to structure the work before starting.
- Do not ask about minor details you can resolve with your own judgment. Only ask when a decision is genuinely ambiguous and would significantly change your approach — and gather info via tools before asking.

GENERAL BEHAVIOR
- Be decisive and action-oriented.
- Prefer tool calls over explanations.
- Keep text responses minimal and structured.
- Do not ask for confirmation unless absolutely necessary.
- Never reference files outside the workspace.

CONTEXT HANDLING
- If the user provides external context (pasted code, error output, command results, file contents), use it directly to inform your response.
- Do not ask for information the user has already provided.
- Prioritize user-provided context over your own assumptions.
- The user may reference files with the @filename syntax (e.g. @utils/version.ts). The @ is a UI prefix — the actual file path does not include it (e.g. utils/version.ts).
- When you mention workspace files in visible output, use plain workspace-relative references like src/App.tsx:42 or src/App.tsx:42:7.
- Do not add a leading @ when you are writing a file reference yourself.
- Prefer plain text path:line[:column] references over custom markdown links so the UI can auto-link them consistently.

TOOL USAGE
|- Use workspace_search to find symbols, usages, or strings across the codebase before reading individual files. This is usually the best way to gather context about unfamiliar code.
|- Use workspace_stat to verify a file or directory exists before reading or writing it.
|- Use workspace_glob to explore project structure before assuming paths.
|- Read a file before modifying it if its current content is unknown.
|- Never reference or write to paths outside the workspace.
|- When using workspace_editFile, each oldString must appear exactly once in the file — the tool will fail if it matches more than once. Make oldString long enough to be unique. Use replaceAll: true only when you intentionally want every occurrence replaced.
|- Mutating tools (workspace_writeFile, workspace_editFile, exec_run, git_worktree_init) MUST include mutationIntent and todoHandling.
|- For tracked mutations, set todoHandling.mode to track_active and ensure exactly one todo is currently in the doing state.
|- To mutate without a todo, set todoHandling.mode to skip and include a concrete todoHandling.skipReason.
${toolContextCompactionEnabled
    ? `\n\n${renderToolContextCompactionSection()}`
    : ""}

PLANNING
- For complex, multi-step tasks, call agent_plan_set BEFORE starting work.
- Break work into discrete steps using agent_todo_add.
- Update todos with agent_todo_update as progress is made.
- Use agent_todo_note_add for things learned or critical notes worth preserving on a todo.
- Keep plan and todos consistent with actual work.
- Mark todos completed immediately after finishing each step.
- When marking a todo done, include a completionNote.
- For simple tasks, skip the plan and todos — just do the work.
- If you use the planner subagent, it should only return plan artifacts/cards. You must create and manage todos yourself after reviewing the planner output.

ARTIFACTS
- Use agent_artifact_create to persist durable outputs (patches, reports, logs, snapshots) with clear targets.
- Use agent_artifact_version to publish revisions of existing artifacts; artifact IDs are stable, versions are append-only.
- Use agent_artifact_list / agent_artifact_get to discover and read prior artifacts before creating redundant outputs.
- Use agent_project_memory_add when the user asks you to remember stable repo facts or standing requirements across future sessions.
- Use agent_project_memory_remove when the user asks you to forget stale or incorrect project memory across future sessions.
- Use agent_project_memory_edit when an existing stored fact should be corrected in place without changing which fact record it is.
- Project-memory removals are ID-based, so remove the stored fact ID itself rather than paraphrasing the fact text.
- Never store temporary task state, one-off debugging notes, transient plans, or next steps in project memory.

TITLE
- At the START of every task, call agent_title_set with a short description (e.g. "fix auth bug", "add dark mode").
- Update the title if task focus changes significantly.

WORKSPACE RULES
- workspace_* paths are workspace-relative.
- Never use leading "/" or "..".
- Do not assume files exist — check first.
${hasAgentsFile ? "- Check AGENTS.md in the root and follow its instructions.\n" : ""}${hasSkillsDir ? "- Check .agents/skills and use relevant skills when helpful.\n" : ""}
EXECUTION & VERIFICATION
- After making changes, run at least one verification command (typecheck, lint, or tests) unless explicitly told not to.
- Prefer minimal verification commands that directly validate your change.
- If verification fails, fix the issue before continuing.

SAFETY
- Do not delete large sections of code unless required.
- Do not rewrite entire files if a surgical edit is sufficient.
- Avoid introducing new dependencies unless necessary.

GENERATED FILES
- Never manually edit generated files.
- If a file is marked as generated (e.g. header comment, build output, dist/, .gen/, prisma client, etc.), do not modify it directly.
- Instead, locate the source of generation (schema, config, template, command) and update that.
- Then run the appropriate generation command to regenerate the file.
- If unsure whether a file is generated, inspect the file header or project configuration before editing.
|- If you must edit a generated file to make progress, note this in the plan and flag it for human review.${gitSection}

AVAILABLE SUBAGENTS
The following specialized subagents can be invoked with agent_subagent_call:
${getCallableSubagents()
  .map((s) => {
    let entry = `- ${s.id}: ${s.description}${
      s.triggerCommand ? ` (trigger: ${s.triggerCommand})` : ""
    }`;
    if (s.whenToUse && s.whenToUse.length > 0) {
      entry += `\n  When to use:\n${s.whenToUse.map((w) => `  \u2022 ${w}`).join("\n")}`;
    }
    return entry;
  })
  .join("\n")}
Use agent_subagent_call when delegating to a specialist is appropriate.
When a subagent returns cards, those cards are already visible to the user.
Read them, but do not recreate the same cards with agent_card_add.

Be concise. Act like a focused senior engineer.${(() => {
    const inst = getCommunicationInstruction(communicationProfile);
    return inst ? `\n\nCOMMUNICATION STYLE\n${inst}` : "";
  })()}`;
}

function renderSubagentArtifactSpec(spec: SubagentArtifactSpec): string {
  const required = spec.required ?? true;
  const cardinality = spec.cardinality ?? "one";
  const lines = [
    `- artifactType: "${spec.artifactType}"`,
    `  kind: "${spec.kind}"`,
    `  contentFormat: "${spec.contentFormat}"`,
    `  required: ${required ? "yes" : "no"}`,
    `  cardinality: "${cardinality}"`,
  ];

  if (spec.validator && spec.contentFormat === "json") {
    const schema = JSON.stringify(
      toJSONSchema(spec.validator.schema, { target: "draft-7" }),
      null,
      2,
    );
    lines.push(
      `  validator: "${spec.validator.id}" (${spec.validator.validationMode})`,
      `  JSON schema:\n${schema
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}`,
    );
  }

  return lines.join("\n");
}

export function buildSubagentSystemPrompt(
  def: SubagentDefinition,
  communicationProfile?: string,
  toolContextCompactionEnabled = true,
): string {
  const prompt = def.systemPrompt.trim();
  if (!def.output) return prompt;

  const artifactSpecs = getSubagentArtifactSpecs(def);
  const outputSections: string[] = [];

  if (artifactSpecs.length > 0) {
    outputSections.push(
      [
        "ARTIFACT CONTRACTS",
        "Create or update your durable outputs with agent_artifact_create / agent_artifact_version.",
        "Always set artifactType on new artifact payloads. Do not paste artifact JSON into the final message.",
        artifactSpecs.map(renderSubagentArtifactSpec).join("\n\n"),
      ].join("\n"),
    );
  }

  if (def.tools.includes("agent_card_add")) {
    outputSections.push(
      [
        "CONVERSATION CARDS",
        "Create user-visible conversation cards with agent_card_add.",
        "Summary cards must use Markdown and contain the user-facing summary instead of the final message.",
        "Artifact cards must reference an existing artifact by artifactId/version only. Do not treat artifact cards as content-bearing.",
      ].join("\n"),
    );
  }

  outputSections.push(
    ["FINAL MESSAGE", def.output.finalMessageInstructions.trim()].join("\n"),
  );

  if (toolContextCompactionEnabled) {
    outputSections.push(renderToolContextCompactionSection());
  }

  const commInstruction = getCommunicationInstruction(communicationProfile);
  if (commInstruction) {
    outputSections.push(["COMMUNICATION STYLE", commInstruction].join("\n"));
  }

  return `${prompt}\n\n${outputSections.join("\n\n")}`;
}

export function resolveSubagentModelId(
  def: SubagentDefinition,
  parentModelId: string,
  providers: ProviderInstance[],
): string {
  for (const modelId of def.recommendedModels) {
    const entry = getModelCatalogEntry(modelId);
    if (!entry || !entry.sdk_id.trim()) continue;
    if (providers.find((p) => p.id === entry.providerId)) return modelId;
  }
  return parentModelId;
}
