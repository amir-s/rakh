import { z } from "zod";
import type { SubagentDefinition } from "./types";

export const reviewerSubagent: SubagentDefinition = {
  id: "reviewer",
  name: "Code Reviewer",
  icon: "rate_review",
  color: {
    dark: "#f6bc5b",
    light: "#a76400",
  },
  description:
    "Reviews code in a requested scope and returns actionable findings to the parent agent. Always include a concrete scope (file(s), directory, or commit range) in the message. Does not modify code.",
  triggerCommand: "/review",
  requiresApproval: false,
  recommendedModels: [],
  whenToUse: [
    'User asks to "review code", "do a code review", "audit this change", or similar.',
    "User sends the /review trigger command.",
    "Parent agent wants a second-pass quality/safety review before editing.",
    "User requests suggestions first, before any code modifications are made.",
  ],
  tools: [
    // Read-only workspace exploration
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
    // Clarifying questions
    "user_input",
  ],
  output: {
    finalMessageInstructions:
      'After posting your cards, your final message must be a short status line only, for example "Review ready below." Do not repeat the summary or raw JSON.',
    parentNote:
      "Use the returned summary card as the user-facing review summary. " +
      "Read the returned review artifact with agent_artifact_get before summarizing the findings for the user or acting on them. " +
      "Ask for explicit yes/no confirmation before making any code edits based on them. " +
      "Wait for the user's response before calling workspace_editFile or workspace_writeFile. " +
      "For future calls, always include a concrete scope (file(s), directory, or commit range) in the message.",
    artifacts: [
      {
        artifactType: "review-report",
        kind: "review-report",
        contentFormat: "json",
        validator: {
          id: "reviewer.review-report",
          validationMode: "reject",
          schema: z.object({
            summary: z
              .string()
              .describe(
                "Brief review summary; if no issues are found, clearly state that",
              ),
            findings: z
              .array(
                z.object({
                  file: z.string().describe("Workspace-relative file path"),
                  location: z
                    .string()
                    .describe(
                      "Line number or code location (e.g. 'line 42', 'AuthService.login')",
                    ),
                  severity: z
                    .enum(["high", "medium", "low"])
                    .describe("Relative risk/severity of this finding"),
                  issue: z.string().describe("What is wrong or risky"),
                  suggestion: z.string().describe("Concrete recommended change"),
                  reason: z
                    .string()
                    .describe("Why this suggestion improves the code"),
                }),
              )
              .describe(
                "Actionable findings; use an empty array when no issues are found",
              ),
          }),
        },
      },
    ],
  },
  systemPrompt: `You are Code Reviewer, a specialized code review subagent for Rakh.

Your sole responsibility is to review code in the requested scope and return actionable findings. You do NOT modify the codebase.

PROCESS
1. Determine review scope from the task message:
   - Named files/directories: inspect only those paths unless asked to expand.
   - "last commit" / "latest commit": use workspace tools to inspect likely touched files if the scope is already provided; if scope is missing or ambiguous, ask via user_input.
   - "entire codebase": sample and prioritize high-impact areas first, then widen as needed.
2. If scope remains ambiguous and materially affects results, ask one concise user_input question before reviewing.
3. Read files in scope and identify concrete issues worth surfacing.
4. Create a JSON artifact via agent_artifact_create with:
   - artifactType: "review-report"
   - kind: "review-report"
   - contentFormat: "json"
   - content: a JSON object containing summary + findings
5. Call agent_card_add with kind: "summary" and a concise Markdown summary of the review for the user.
6. After saving the artifact, you may call agent_card_add with kind: "artifact" to reference it.

REVIEW RULES
- Never edit/write files and never attempt to call write/edit tools.
- Focus on correctness, reliability, readability, and maintainability.
- Keep findings actionable and specific to code locations.
- If no issues are found, use findings: [] in the artifact and say so in summary.
- Do not claim you ran commands/tools you did not actually run.
- The summary card body is Markdown.
- Your final message must be a short status line only, such as "Review ready below."`,
};
