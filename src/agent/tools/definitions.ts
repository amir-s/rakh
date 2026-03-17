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

const mutationIntentEnum = z.enum([
  "exploration",
  "implementation",
  "refactor",
  "fix",
  "test",
  "build",
  "docs",
  "setup",
  "cleanup",
  "other",
]);

const mutationPolicySchema = z.object({
  mutationIntent: mutationIntentEnum.describe(
    "Why this mutation is happening, for todo and audit tracking.",
  ),
  todoHandling: z.object({
    mode: z
      .enum(["track_active", "skip"])
      .describe(
        "Use 'track_active' to attach this mutation to the current active todo, or 'skip' to explicitly bypass todo tracking.",
      ),
    skipReason: z
      .string()
      .optional()
      .describe(
        "Required when mode is 'skip'. Explain why this mutation should not be tied to a todo.",
      ),
    touchedPaths: z
      .array(z.string())
      .optional()
      .describe(
        "Optional workspace-relative paths this command mutates. Required for non-file mutation tools when you want file tracking recorded.",
      ),
  }),
});

function withMutationPolicy<T extends z.ZodObject>(schema: T): T {
  return schema.extend(mutationPolicySchema.shape) as unknown as T;
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
      "Set overwrite: true to replace an existing file. " +
      "You must also provide mutationIntent and todoHandling.",
    inputSchema: withMutationPolicy(z.object({
      path: z.string().describe("Workspace-relative path for the file"),
      content: z.string().describe("Full file content to write"),
      overwrite: z
        .boolean()
        .describe(
          "Allow overwriting an existing file (default: false — fails if file exists)",
        )
        .optional(),
    })),
  }),
  tool({
    name: "workspace_editFile",
    description:
      "Edit an existing file by applying one or more find-and-replace changes in sequence. " +
      "Each change specifies an oldString to find and a newString to replace it with. " +
      "Returns CONFLICT if any oldString is not found, or if it appears more than once and replaceAll is not true. " +
      "Make oldString long enough to be unique within the file. Set replaceAll: true only when you intentionally want every occurrence replaced. " +
      "You must also provide mutationIntent and todoHandling.",
    inputSchema: withMutationPolicy(z.object({
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
    })),
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
      "You must also provide mutationIntent and todoHandling. Use todoHandling.mode='skip' with a skipReason when the command should not be tracked against the active todo. " +
      "The system will automatically prompt the user to approve or deny the command before it runs — " +
      "do NOT use user_input to ask for permission first. " +
      "Use `requireUserApproval: true` for potentially destructive commands or when you want to give the user control over when the command runs. " +
      "IMPORTANT: `args` are passed directly to the process — shell operators (`&&`, `|`, `;`, redirects) are NOT interpreted. " +
      "To chain commands, use `command: 'sh'` with `args: ['-c', 'cmd1 && cmd2']`.",
    inputSchema: withMutationPolicy(z.object({
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
    })),
  }),

  /* ── agent.todo ───────────────────────────────────────────────────────────── */
  tool({
    name: "agent_todo_add",
    description: "Add a new todo item.",
    inputSchema: z.object({
      title: z.string().describe("Short todo title"),
    }),
  }),
  tool({
    name: "agent_todo_update",
    description:
      "Update the title, state, or completionNote of an existing todo item.",
    inputSchema: z.object({
      id: z.string().describe("Todo item ID"),
      patch: z
        .object({
          title: z.string().optional(),
          state: z.enum(["todo", "doing", "done", "blocked"]).optional(),
          completionNote: z.string().optional(),
        })
        .optional(),
    }),
  }),
  tool({
    name: "agent_todo_note_add",
    description:
      "Attach a learned fact or critical note to a todo. Defaults to the current active todo when todoId is omitted.",
    inputSchema: z.object({
      kind: z.enum(["learned", "critical"]),
      text: z.string().describe("The note to attach"),
      todoId: z.string().optional().describe("Optional explicit todo ID"),
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
  tool({
    name: "agent_project_memory_add",
    description:
      "Append durable learned facts to the current saved project's long-term memory. " +
      "Use this when the user asks you to remember stable repo facts or standing requirements for future sessions, " +
      "or when compaction extracts durable facts worth keeping. " +
      "Do not store transient task state, temporary plans, debugging breadcrumbs, or next steps.",
    inputSchema: z.object({
      facts: z
        .array(z.string())
        .describe("New learned facts to append to project memory"),
    }),
  }),
  tool({
    name: "agent_project_memory_remove",
    description:
      "Remove durable learned facts from the current saved project's long-term memory. " +
      "Use this when the user asks you to forget stale or incorrect project memory, or when compaction confirms an existing learned fact is no longer true. " +
      "Removal is ID-based, so pass the exact stored fact ID you want removed.",
    inputSchema: z.object({
      factIds: z
        .array(z.string())
        .describe("Stored learned fact IDs to remove from project memory"),
    }),
  }),
  tool({
    name: "agent_project_memory_edit",
    description:
      "Edit one durable learned fact in the current saved project's long-term memory by stable ID. " +
      "Use this when an existing project-memory fact is still relevant but needs corrected wording.",
    inputSchema: z.object({
      factId: z
        .string()
        .describe("Stable ID of the stored learned fact to update"),
      text: z
        .string()
        .describe("Replacement fact text"),
    }),
  }),
  tool({
    name: "agent_card_add",
    description:
      "Add a user-visible conversation card directly below the current assistant message. " +
      "Use summary cards for user-facing Markdown summaries. Use artifact cards only as lightweight references after the artifact already exists. " +
      'Always include `kind`. For `kind: "summary"`, include `markdown`. For `kind: "artifact"`, include `artifactId` and optionally `version`.',
    inputSchema: z.object({
      kind: z
        .enum(["summary", "artifact"])
        .describe(
          'Card type. Use `"summary"` for Markdown summaries and `"artifact"` for artifact reference cards.',
        ),
      title: z
        .string()
        .optional()
        .describe("Optional short card title shown above the card"),
      markdown: z
        .string()
        .optional()
        .describe('Required when `kind` is `"summary"`; user-visible Markdown content'),
      artifactId: z
        .string()
        .optional()
        .describe(
          'Required when `kind` is `"artifact"`; stable artifact ID to reference',
        ),
      version: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Optional artifact version when `kind` is `"artifact"` (default: latest)',
        ),
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
      "You must also provide mutationIntent and todoHandling. " +
      "Returns immediately if a worktree already exists or was previously declined.",
    inputSchema: withMutationPolicy(z.object({
      suggestedBranch: z
        .string()
        .describe(
          "Short branch name to suggest to the user (e.g. 'feat/add-dark-mode')",
        ),
    })),
  }),

  /* ── subagent ───────────────────────────────────────────────────────── */
  tool({
    name: "agent_subagent_call",
    description:
      "Delegate a task to a specialized subagent. " +
      "The subagent will run its own reasoning loop, explore the workspace as needed, " +
      "and return conversation cards plus any artifact references. Those returned cards are already visible to the user, so do not recreate them with agent_card_add. Summary cards contain full Markdown text; artifact cards only contain refs and tell you to read the artifact directly. Use this when a task is better handled by a " +
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
