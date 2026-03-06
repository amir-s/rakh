import { tool as aiTool } from "ai";
import { z } from "zod";
import { ARTIFACT_CONTENT_FORMAT } from "./artifactTypes";

/**
 * Tool specifications are kept with explicit names, then converted to
 * AI SDK tool definitions keyed by those names.
 */
type ToolSpec = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
};

function tool(spec: ToolSpec): ToolSpec {
  return spec;
}

const artifactRefSchema = z.object({
  artifactId: z.string().describe("Stable artifact ID"),
  version: z.number().optional(),
});

const TOOL_SPECS = [
  /* ── workspace ────────────────────────────────────────────────────────────── */
  tool({
    name: "workspace_listDir",
    description:
      "List children of a directory (no recursion). Returns entries with kind, size, and mtime.",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Workspace-relative path (default: workspace root)")
        .optional(),
      includeHidden: z
        .boolean()
        .describe("Include hidden entries (default: false)")
        .optional(),
      maxEntries: z
        .number()
        .describe("Max entries to return (default: 200)")
        .optional(),
    }),
  }),
  tool({
    name: "workspace_stat",
    description:
      "Check if a file or directory exists and get its metadata (size, modification time).",
    inputSchema: z.object({
      path: z
        .string()
        .describe("Workspace-relative path to the file or directory"),
    }),
  }),
  tool({
    name: "workspace_readFile",
    description:
      "Read the content of a file, optionally constrained to a line range.",
    inputSchema: z.object({
      path: z.string().describe("Workspace-relative path to the file"),
      range: z
        .object({
          startLine: z.number(),
          endLine: z.number(),
        })
        .describe("Optional 1-based inclusive line range")
        .optional(),
      maxBytes: z
        .number()
        .describe("Max bytes to read (default: 200000)")
        .optional(),
    }),
  }),
  tool({
    name: "workspace_writeFile",
    description:
      "Create a new file or overwrite an existing file with the given content. " +
      "By default (overwrite: false) fails with CONFLICT if the file already exists. " +
      "Set overwrite: true to replace an existing file.",
    inputSchema: z.object({
      path: z.string().describe("Workspace-relative path for the file"),
      content: z.string().describe("Full file content to write"),
      overwrite: z
        .boolean()
        .describe(
          "Allow overwriting an existing file (default: false — fails if file exists)",
        )
        .optional(),
    }),
  }),
  tool({
    name: "workspace_editFile",
    description:
      "Edit an existing file by applying one or more find-and-replace changes in sequence. " +
      "Each change specifies an oldString to find and a newString to replace it with. " +
      "Returns CONFLICT if any oldString is not found, or if it appears more than once and replaceAll is not true. " +
      "Make oldString long enough to be unique within the file. Set replaceAll: true only when you intentionally want every occurrence replaced.",
    inputSchema: z.object({
      path: z.string().describe("Workspace-relative path to the file"),
      changes: z
        .array(
          z.object({
            oldString: z.string().describe("Exact string to find in the file"),
            newString: z.string().describe("String to replace oldString with"),
            replaceAll: z
              .boolean()
              .describe(
                "Replace all occurrences (default: false). If false, fails with CONFLICT when oldString matches more than once.",
              )
              .optional(),
          }),
        )
        .describe(
          "Ordered list of find-and-replace changes to apply to the file",
        ),
    }),
  }),
  tool({
    name: "workspace_glob",
    description:
      'Find files matching glob patterns (e.g. ["src/**/*.ts", "!**/*.test.ts"]).',
    inputSchema: z.object({
      patterns: z.array(z.string()).describe("Glob patterns"),
      cwd: z
        .string()
        .describe("Workspace-relative base directory (default: root)")
        .optional(),
      maxMatches: z
        .number()
        .describe("Max matches to return (default: 2000)")
        .optional(),
      includeDirs: z
        .boolean()
        .describe("Include directory entries (default: false)")
        .optional(),
      includeHidden: z
        .boolean()
        .describe("Include hidden files/directories like .git (default: false)")
        .optional(),
    }),
  }),
  tool({
    name: "workspace_search",
    description: `Search file contents for a pattern (like ripgrep / rg).

Use this tool when you need to find which files contain a specific string, symbol, function name, or regex pattern. It is faster and more precise than reading files one-by-one.

**When to use:**
- Finding all usages of a function, variable, or class across the workspace
- Locating where a specific string, error message, or config key appears
- Exploring an unfamiliar codebase to understand where things are defined / used

**Key behaviours (rg-compatible):**
- Respects \`.gitignore\` / \`.ignore\` rules automatically — nodemodules, build artefacts, etc. are skipped
- Skips binary files automatically
- Hidden directories (e.g. \`.git\`) are excluded by default (\`includeHidden: false\`)
- \`pattern\` is a regular expression (use \`caseSensitive: false\` for case-insensitive, which is the default)

**Tips:**
- Narrow results with \`includeGlobs\` (e.g. \`["**/*.ts"]\`) or \`excludeGlobs\` (e.g. \`["**/tests/**"]\`)
- Use \`contextLines\` (1–3) when you need a few lines of surrounding code to understand the match
- Use \`rootDir\` to restrict the search to a subdirectory (workspace-relative, default: root)
- Keep \`maxMatches\` low (50–200) unless you need an exhaustive count — results are truncated anyway

**Output format:**
\`\`\`
Found N match(es) in K file(s) [TRUNCATED — not all results shown]

path/to/file.ts
  40- context line before
  41: matched line            ← line with colon = the actual match
  42- context line after

path/to/other.ts
  10: another matched line
\`\`\`
- Each file appears as a header, followed by its matches indented below.
- Matched lines use \`lineNumber: content\` (colon separator).
- Context lines (if \`contextLines > 0\`) use \`lineNumber- content\` (dash separator).
- The \`[TRUNCATED]\` suffix on the header means results were capped at \`maxMatches\`.`,
    inputSchema: z.object({
      pattern: z
        .string()
        .describe(
          "Regular expression to search for (e.g. 'TODO', 'function\\s+foo', 'import.*react')",
        ),
      rootDir: z
        .string()
        .describe(
          "Workspace-relative subdirectory to search within (default: workspace root)",
        )
        .optional(),
      includeGlobs: z
        .array(z.string())
        .describe(
          "Only search files matching these glob patterns (e.g. ['**/*.ts', '**/*.tsx']). Default: all files.",
        )
        .optional(),
      excludeGlobs: z
        .array(z.string())
        .describe(
          "Skip files matching these glob patterns (e.g. ['**/node_modules/**', '**/*.test.ts']). Default: none (gitignore still applies).",
        )
        .optional(),
      maxMatches: z
        .number()
        .describe("Max number of matching lines to return (default: 200)")
        .optional(),
      caseSensitive: z
        .boolean()
        .describe("Case-sensitive matching (default: false)")
        .optional(),
      includeHidden: z
        .boolean()
        .describe("Also search hidden files and directories (default: false)")
        .optional(),
      contextLines: z
        .number()
        .describe(
          "Number of lines of context to include before and after each match (default: 0)",
        )
        .optional(),
      followSymlinks: z
        .boolean()
        .describe("Follow symbolic links (default: false)")
        .optional(),
    }),
  }),

  /* ── exec ─────────────────────────────────────────────────────────────────── */
  tool({
    name: "exec_run",
    description:
      "Run a shell command in the workspace. Returns stdout, stderr, and exit code. " +
      "Always provide a short `reason` (one sentence) explaining why this command needs to run. " +
      "The system will automatically prompt the user to approve or deny the command before it runs — " +
      "do NOT use user_input to ask for permission first. " +
      "Use `requireUserApproval: true` for potentially destructive commands or when you want to give the user control over when the command runs. " +
      "IMPORTANT: `args` are passed directly to the process — shell operators (`&&`, `|`, `;`, redirects) are NOT interpreted. " +
      "To chain commands, use `command: 'sh'` with `args: ['-c', 'cmd1 && cmd2']`.",
    inputSchema: z.object({
      command: z.string().describe("Executable name (e.g. 'npm', 'git')"),
      args: z.array(z.string()).describe("Command arguments").optional(),
      cwd: z
        .string()
        .describe("Working directory (workspace-relative, default: root)")
        .optional(),
      env: z
        .record(z.string(), z.string())
        .describe("Extra environment variables")
        .optional(),
      timeoutMs: z
        .number()
        .describe("Timeout in milliseconds (default: 120000)")
        .optional(),
      stdin: z.string().describe("Optional stdin content").optional(),
      reason: z
        .string()
        .describe(
          "Short one-sentence reason why this command needs to run (shown to the user)",
        )
        .optional(),
      requireUserApproval: z
        .boolean()
        .describe(
          "When true, request approval from user before running this command.",
        )
        .optional(),
    }),
  }),

  /* ── agent.todo ───────────────────────────────────────────────────────────── */
  tool({
    name: "agent_todo_add",
    description: "Add a new todo item.",
    inputSchema: z.object({
      text: z.string().describe("Todo item text"),
    }),
  }),
  tool({
    name: "agent_todo_update",
    description:
      "Update status, text, or blockedReason of an existing todo item.",
    inputSchema: z.object({
      id: z.string().describe("Todo item ID"),
      patch: z
        .object({
          text: z.string().optional(),
          status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
          blockedReason: z.string().optional(),
        })
        .optional(),
    }),
  }),
  tool({
    name: "agent_todo_list",
    description: "List todo items, optionally filtered by status.",
    inputSchema: z.object({
      status: z
        .enum(["todo", "doing", "done", "blocked", "any"])
        .describe("Filter by status (default: 'any')")
        .optional(),
      limit: z
        .number()
        .describe("Max items to return (default: 200)")
        .optional(),
    }),
  }),
  tool({
    name: "agent_todo_remove",
    description: "Remove a todo item by ID.",
    inputSchema: z.object({
      id: z.string().describe("Todo item ID"),
    }),
  }),

  /* ── agent.artifact ───────────────────────────────────────────────────────── */
  tool({
    name: "agent_artifact_create",
    description:
      "Create a new artifact manifest + content blob in the shared per-session artifact store. " +
      "Use this for durable handoff outputs (patches, reports, logs, snapshots).",
    inputSchema: z.object({
      kind: z
        .string()
        .describe("Artifact kind, e.g. patch|file|report|plan|test-log"),
      summary: z.string().optional().describe("Short human-readable summary"),
      parent: artifactRefSchema
        .optional()
        .describe(
          "Optional parent artifact this is derived from (e.g. a previous version or a source artifact being translated)",
        ),
      artifactType: z
        .string()
        .optional()
        .describe(
          "Framework-facing artifact type used by subagent contracts (required for schema-backed subagent outputs)",
        ),
      contentFormat: z
        .enum(ARTIFACT_CONTENT_FORMAT)
        .describe("Content format"),
      content: z.string().describe("Artifact payload content (UTF-8 text)"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional metadata object"),
    }),
  }),
  tool({
    name: "agent_artifact_version",
    description:
      "Create a new version of an existing artifact. " +
      "If content is omitted, the previous version's content blob is reused.",
    inputSchema: z.object({
      artifactId: z.string().describe("Stable artifact ID to version"),
      summary: z.string().optional().describe("Short human-readable summary"),
      parent: artifactRefSchema
        .optional()
        .describe(
          "Optional replacement parent ref (replaces the previous version's parent if provided)",
        ),
      artifactType: z
        .string()
        .optional()
        .describe(
          "Framework-facing artifact type used by subagent contracts. Can be omitted when reusing the latest artifact body and metadata.",
        ),
      contentFormat: z
        .enum(ARTIFACT_CONTENT_FORMAT)
        .optional()
        .describe("Only allowed when content is provided"),
      content: z.string().optional().describe("Optional new payload content"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional replacement metadata"),
    }),
  }),
  tool({
    name: "agent_artifact_get",
    description: "Fetch an artifact by ID, optionally by specific version.",
    inputSchema: z.object({
      artifactId: z.string().describe("Stable artifact ID"),
      version: z
        .number()
        .optional()
        .describe("Specific version (default: latest)"),
      includeContent: z
        .boolean()
        .optional()
        .describe("Include payload content in response (default: true)"),
    }),
  }),
  tool({
    name: "agent_artifact_list",
    description:
      "List artifact manifests in the current session with optional filters.",
    inputSchema: z.object({
      runId: z.string().optional().describe("Filter by run ID"),
      agentId: z.string().optional().describe("Filter by agent ID"),
      kind: z.string().optional().describe("Filter by kind"),
      latestOnly: z
        .boolean()
        .optional()
        .describe("Only include latest version per artifact (default: true)"),
      limit: z.number().optional().describe("Max items (default: 200)"),
    }),
  }),

  /* ── git ────────────────────────────────────────────────────────────── */
  tool({
    name: "git_worktree_init",
    description:
      "Create an isolated git worktree for this session before modifying any files. " +
      "Call this exactly once per session, before any file writes. " +
      "Returns immediately if a worktree already exists or was previously declined.",
    inputSchema: z.object({
      suggestedBranch: z
        .string()
        .describe(
          "Short branch name to suggest to the user (e.g. 'feat/add-dark-mode')",
        ),
    }),
  }),

  /* ── subagent ───────────────────────────────────────────────────────── */
  tool({
    name: "agent_subagent_call",
    description:
      "Delegate a task to a specialized subagent. " +
      "The subagent will run its own reasoning loop, explore the workspace as needed, " +
      "and return any artifact references plus a concise summary. Use this when a task is better handled by a " +
      "focused specialist (e.g. the planner subagent for complex planning tasks).",
    inputSchema: z.object({
      subagentId: z
        .string()
        .describe("ID of the subagent to invoke (e.g. 'planner')"),
      message: z
        .string()
        .describe("Task description or question to send to the subagent"),
    }),
  }),

  /* ── user_input ───────────────────────────────────────────── */
  tool({
    name: "user_input",
    description:
      "Ask the user a clarifying question and pause execution until they respond. " +
      "Use this when: (1) the answer would steer the work in a completely different direction, " +
      "(2) a decision requires user intent that cannot be inferred from the workspace, or " +
      "(3) proceeding without input risks doing the wrong thing entirely. " +
      "Do NOT use this for minor details you can resolve with your own judgment, " +
      "and do NOT use it to ask for approval before running a command or editing a file — " +
      "the system handles those approvals automatically when you call the relevant tools. " +
      "Provide suggested options when the answer set is finite; leave options empty for open-ended questions.",
    inputSchema: z.object({
      question: z.string().describe("The question to display to the user."),
      options: z
        .array(z.string())
        .optional()
        .describe(
          "Suggested answers the user can pick with one click. " +
            "The user can also type a custom answer regardless.",
        ),
    }),
  }),

  /* ── agent.title ─────────────────────────────────────────────── */
  tool({
    name: "agent_title_set",
    description:
      "Set the tab title for this agent. Use a short, minimal description of the current task (e.g. 'fix auth bug', 'add dark mode').",
    inputSchema: z.object({
      title: z.string().describe("Short task title"),
    }),
  }),
  tool({
    name: "agent_title_get",
    description: "Get the current tab title.",
    inputSchema: z.object({}),
  }),
] as const;

export const TOOL_DEFINITIONS = Object.fromEntries(
  TOOL_SPECS.map(({ name, ...definition }) => [name, aiTool(definition)]),
);

/**
 * Return a subset of TOOL_DEFINITIONS containing only the named tools.
 * Used by the runner to give subagents a restricted tool surface.
 */
export function getToolDefinitionsByNames(
  names: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  const allowed = new Set(names);
  return Object.fromEntries(
    Object.entries(TOOL_DEFINITIONS).filter(([name]) => allowed.has(name)),
  );
}
