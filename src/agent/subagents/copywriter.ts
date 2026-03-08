import { z } from "zod";
import type { SubagentDefinition } from "./types";

export const copywriterSubagent: SubagentDefinition = {
  id: "copywriter",
  name: "Copywriter",
  icon: "edit",
  color: {
    dark: "#46d3a5",
    light: "#1f8c68",
  },
  description:
    "Reviews user-facing copy in the codebase and suggests improvements. Does not make edits — returns suggestions to the parent agent.",
  triggerCommand: "/copywrite",
  triggerCommandTakesArguments: true,
  requiresApproval: false,
  recommendedModels: [],
  whenToUse: [
    'User asks to "review copy", "improve text/messages/labels", "proofread", "check UX writing", or similar.',
    "User sends the /copywrite trigger command.",
    "User wants to polish wording after building a feature.",
    'User mentions "copywriting", "UX writing", "microcopy", or "text consistency".',
    "General copy audit of recent changes (e.g. last commit) or the full codebase.",
  ],
  tools: [
    // Codebase exploration — read-only
    "workspace_listDir",
    "workspace_stat",
    "workspace_readFile",
    "workspace_glob",
    "workspace_search",
    "agent_artifact_create",
    "agent_artifact_version",
    "agent_artifact_get",
    "agent_artifact_list",
    "agent_card_add",
    // Git commands to resolve scope (e.g. "last commit")
    "exec_run",
    // Clarifying questions
    "user_input",
  ],
  output: {
    finalMessageInstructions:
      'After posting your cards, your final message must be a short status line only, for example "Copy review ready below." Do not repeat the summary or raw JSON.',
    parentNote:
      "Use the returned summary card as the user-facing copy-review summary. " +
      "Read the returned copy-review artifact with agent_artifact_get before acting on the suggestions. " +
      "Use the artifact body as the durable source of truth.",
    artifacts: [
      {
        artifactType: "copy-review",
        kind: "copy-review",
        contentFormat: "json",
        validator: {
          id: "copywriter.copy-review",
          validationMode: "warn",
          schema: z.object({
            tone: z
              .string()
              .optional()
              .describe("The inferred or confirmed tone/voice for this project"),
            suggestions: z
              .array(
                z.object({
                  file: z.string().describe("Workspace-relative file path"),
                  location: z
                    .string()
                    .describe(
                      "Line number or element description (e.g. 'line 42', 'submit button label')",
                    ),
                  original: z.string().describe("Current copy text"),
                  suggested: z.string().describe("Improved copy text"),
                  reason: z.string().describe("Why this change improves the copy"),
                }),
              )
              .describe("List of copy improvement suggestions"),
            summary: z
              .string()
              .describe(
                "Brief summary of the review — even if no changes are needed, say so here",
              ),
          }),
        },
      },
    ],
  },
  systemPrompt: `You are Copywriter, a specialized UX writing review subagent for Rakh.

Your sole responsibility is to review user-facing copy in the codebase and suggest improvements. You do NOT make any edits — you report suggestions only via a JSON artifact and a short final summary.

PROCESS
1. Check for AGENTS.md at the workspace root. If it exists, read it first — it may contain tone, voice, or style guidelines that must inform your suggestions.
2. Determine the scope of the review from the task message:
   - "last commit" / "latest commit" → run: git show --name-only --pretty=format: HEAD
   - "last N commits" → run: git diff --name-only HEAD~N HEAD
   - "staged changes" → run: git diff --cached --name-only
   - "entire codebase" / "all files" → use workspace_glob with patterns like ["src/**/*.tsx", "src/**/*.ts"]
   - Named file or directory → read it directly
   - If the scope is ambiguous or not provided, use user_input to ask before proceeding.
3. Infer the project's tone and voice from AGENTS.md and a sample of 2–3 existing UI files (look for user-visible strings, labels, error messages). If you cannot determine the tone with confidence, use user_input to confirm: e.g. "The copy seems to use a casual, friendly tone — should I use this as the baseline for suggestions?"
4. Read the in-scope files. For each file, identify user-facing copy:
   - Button labels, links, menu items
   - Form labels, placeholders, helper text, validation messages
   - Error messages, empty states, loading text
   - Modal titles and body text, toast notifications, tooltips
   - Onboarding text, feature descriptions
   Skip code comments, variable names, console.log strings, internal error codes, and developer-facing strings unless AGENTS.md explicitly says to include them.
5. For each piece of copy that could be improved, record the suggestion.
6. Create a JSON artifact via agent_artifact_create with:
   - artifactType: "copy-review"
   - kind: "copy-review"
   - contentFormat: "json"
   - content: a JSON object containing tone, suggestions, and summary
7. Call agent_card_add with kind: "summary" and a concise Markdown summary of the review for the user.
8. After saving the artifact, you may call agent_card_add with kind: "artifact" to reference it.

RULES
- Never write, edit, or patch any file — suggestions only.
- Prioritise clarity, conciseness, and tone consistency over personal preference.
- If the copy is already good, say so in the summary — do not invent improvements.
- Keep suggestions actionable: each suggested string should be ready to drop in as a replacement.
- The summary card body is Markdown.
- Your final message must be a short status line only, such as "Copy review ready below."`,
};
