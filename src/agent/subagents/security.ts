import { z } from "zod";
import type { SubagentDefinition } from "./types";

export const securitySubagent: SubagentDefinition = {
  id: "security",
  name: "Security Auditor",
  icon: "security",
  color: {
    dark: "#ff8a65",
    light: "#b45309",
  },
  description:
    "Audits code and security-relevant configuration in a requested scope and returns actionable findings. Always include a concrete scope (file(s), directory, or commit range) in the message. Does not modify code.",
  triggerCommand: "/security",
  triggerCommandTakesArguments: true,
  requiresApproval: false,
  recommendedModels: [],
  whenToUse: [
    'User explicitly asks for a "security review", "security audit", "threat model", or similar.',
    "The task touches auth/authz, key or token handling, local storage of secrets, or permission boundaries.",
    "The code handles untrusted input, HTML/Markdown rendering, filesystem paths, shell execution, or external content.",
    "The task touches privileged APIs, platform bridges, file/system capabilities, or remote-content permissions.",
    "User wants a security pass on recent changes before merge or release.",
  ],
  tools: [
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
    "exec_run",
    "user_input",
  ],
  output: {
    finalMessageInstructions:
      'After posting your cards, your final message must be a short status line only, for example "Security review ready below." Do not repeat the summary or raw JSON.',
    parentNote:
      "Use the returned summary card as the user-facing security summary. " +
      "Read the returned security artifact with agent_artifact_get before summarizing the findings for the user. " +
      "If no issues are found, say so plainly. " +
      "If there are findings and you plan to make edits, ask for explicit yes/no confirmation before calling workspace_editFile or workspace_writeFile. " +
      "Wait for the user's response before making security-driven code changes.",
    artifacts: [
      {
        artifactType: "security-report",
        kind: "security-report",
        contentFormat: "json",
        validator: {
          id: "security.security-report",
          validationMode: "reject",
          schema: z.object({
            summary: z
              .string()
              .describe(
                "Brief audit summary; if no issues are found, clearly state that",
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
                    .enum(["critical", "high", "medium", "low"])
                    .describe("Relative security risk of this finding"),
                  confidence: z
                    .enum(["high", "medium", "low"])
                    .describe("Confidence that the issue is real and exploitable"),
                  category: z
                    .string()
                    .describe("Security category (e.g. authz, secrets, injection)"),
                  issue: z.string().describe("What is wrong or risky"),
                  impact: z
                    .string()
                    .describe("Potential exploit path or security impact"),
                  remediation: z
                    .string()
                    .describe("Concrete recommendation to reduce or remove the risk"),
                }),
              )
              .describe(
                "Actionable security findings; use an empty array when no issues are found",
              ),
          }),
        },
      },
    ],
  },
  systemPrompt: `You are Security Auditor, a specialized security review subagent for Rakh.

Your sole responsibility is to audit code and security-relevant configuration in the requested scope and return actionable findings. You do NOT modify the codebase.

PROCESS
1. Check for AGENTS.md at the workspace root. If it exists, read it before continuing.
2. Determine audit scope from the task message:
   - Named files/directories: inspect only those paths unless asked to expand.
   - "last commit" / "latest commit": run a read-only git command such as git show --name-only --pretty=format: HEAD to discover touched files.
   - "last N commits": run a read-only git command such as git diff --name-only HEAD~N HEAD.
   - "staged changes": run a read-only git command such as git diff --cached --name-only.
   - "entire codebase" / "all files": sample high-risk areas first, then widen as needed.
3. If the scope remains ambiguous and materially affects results, ask one concise user_input question before auditing.
4. Read the in-scope code and security-relevant configuration. Prioritize auth/authz flows, secrets and token storage, untrusted input handling, content rendering, path traversal and filesystem access, shell execution, prompt/tool misuse, privileged API exposure, and remote-content permissions.
5. Use exec_run only for read-only git inspection commands that clarify review scope. Do not use shell commands for any other purpose.
6. Create a JSON artifact via agent_artifact_create with:
   - artifactType: "security-report"
   - kind: "security-report"
   - contentFormat: "json"
   - content: a JSON object containing summary + findings
7. Call agent_card_add with kind: "summary" and a concise Markdown summary of the audit for the user.
8. After saving the artifact, you may call agent_card_add with kind: "artifact" to reference it.

AUDIT RULES
- Never edit/write files and never attempt to call patch, write, or edit tools.
- Do not claim a vulnerability unless the code or config you inspected supports it.
- Keep findings actionable and specific to code locations.
- If no issues are found, use findings: [] in the artifact and say so in summary.
- The summary card body is Markdown.
- Your final message must be a short status line only, such as "Security review ready below."`,
};
