import {
  DEFAULT_TOOL_CONTEXT_COMPACTION_THRESHOLD_KB,
  sanitizeToolContextCompactionThresholdKb,
} from "../contextCompaction";
import type {
  ApiMessage,
  ToolContextCompactionDisplay,
  ToolResult,
} from "../types";

type ToolContextCompactionSide = "input" | "output";

export interface PendingToolIoReplacement {
  toolCallId: string;
  toolName: string;
  rawArgs: Record<string, unknown>;
  result: ToolResult<unknown>;
  inputBytes: number;
  outputBytes: number;
  totalBytes: number;
}

export interface ToolIoReplacementNotes {
  toolCallId: string;
  inputNote: string;
  outputNote: string;
}

interface CompactionSentinelPayload {
  __rakhCompactToolIO: {
    tool: string;
    side: ToolContextCompactionSide;
    compacted: true;
    kept: Record<string, unknown>;
    omitted: Record<string, unknown>;
    note: string;
  };
}

export const DELAYED_TOOL_IO_REPLACEMENT_ENABLED = true;
export const DELAYED_TOOL_IO_REPLACEMENT_THRESHOLD_BYTES =
  DEFAULT_TOOL_CONTEXT_COMPACTION_THRESHOLD_KB * 1024;
export const TOOL_IO_REPLACEMENT_TOOL_NAME = "agent_replace_tool_io";
export const MAX_TOOL_CONTEXT_NOTE_CHARS = 280;

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function mergeWarnings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  const merged = Array.from(
    new Set([...(left ?? []), ...(right ?? [])].filter(Boolean)),
  );
  return merged.length > 0 ? merged : undefined;
}

function safeJsonStringify(value: unknown, fallback: string): string {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : fallback;
  } catch {
    return fallback;
  }
}

function byteSize(value: unknown): number {
  return encoder.encode(safeJsonStringify(value, "null")).length;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizedMetadataKeys(value: unknown): string[] | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length > 0 ? keys : undefined;
}

function sanitizeNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TOOL_CONTEXT_NOTE_CHARS) {
    return undefined;
  }
  return trimmed;
}

function buildSentinel(
  tool: string,
  side: ToolContextCompactionSide,
  kept: Record<string, unknown>,
  omitted: Record<string, unknown>,
  note: string,
): CompactionSentinelPayload {
  return {
    __rakhCompactToolIO: {
      tool,
      side,
      compacted: true,
      kept,
      omitted,
      note,
    },
  };
}

function withFields(
  fields: string[],
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const next = {
    fields,
    ...extras,
  };

  return Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  );
}

function buildGenericFailureSentinel(
  toolName: string,
  note: string,
  result: Extract<ToolResult<unknown>, { ok: false }>,
): CompactionSentinelPayload {
  const detailsBytes =
    result.error.details !== undefined ? byteSize(result.error.details) : 0;
  return buildSentinel(
    toolName,
    "output",
    {
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
      },
    },
    withFields(
      result.error.details !== undefined ? ["error.details"] : [],
      {
        ...(detailsBytes > 0 ? { bytesOmitted: detailsBytes } : {}),
      },
    ),
    note,
  );
}

function buildGenericInputSentinel(
  toolName: string,
  args: Record<string, unknown>,
  note: string,
): CompactionSentinelPayload {
  return buildSentinel(
    toolName,
    "input",
    {},
    withFields(Object.keys(args), {
      bytesOmitted: byteSize(args),
    }),
    note,
  );
}

function buildInputSentinel(
  toolName: string,
  args: Record<string, unknown>,
  note: string,
): CompactionSentinelPayload {
  switch (toolName) {
    case "workspace_writeFile": {
      const content = stringOrUndefined(args.content) ?? "";
      return buildSentinel(
        toolName,
        "input",
        {
          ...(stringOrUndefined(args.path) ? { path: args.path } : {}),
          overwrite: args.overwrite === true,
        },
        withFields(["content"], {
          bytesOmitted: byteSize(content),
        }),
        note,
      );
    }
    case "workspace_editFile": {
      const changes = Array.isArray(args.changes) ? args.changes : [];
      const bytesOmitted = changes.reduce((total, change) => {
        const record = toRecord(change);
        return (
          total +
          byteSize(stringOrUndefined(record.oldString) ?? "") +
          byteSize(stringOrUndefined(record.newString) ?? "")
        );
      }, 0);
      return buildSentinel(
        toolName,
        "input",
        {
          ...(stringOrUndefined(args.path) ? { path: args.path } : {}),
          changeCount: changes.length,
        },
        withFields(["changes[*].oldString", "changes[*].newString"], {
          bytesOmitted,
        }),
        note,
      );
    }
    case "agent_artifact_create":
    case "agent_artifact_version": {
      const content = stringOrUndefined(args.content);
      return buildSentinel(
        toolName,
        "input",
        {
          ...(stringOrUndefined(args.artifactId)
            ? { artifactId: args.artifactId }
            : {}),
          ...(stringOrUndefined(args.kind) ? { kind: args.kind } : {}),
          ...(stringOrUndefined(args.summary) ? { summary: args.summary } : {}),
          ...(stringOrUndefined(args.artifactType)
            ? { artifactType: args.artifactType }
            : {}),
          ...(stringOrUndefined(args.contentFormat)
            ? { contentFormat: args.contentFormat }
            : {}),
          ...(isRecord(args.parent) ? { parent: args.parent } : {}),
          ...(sanitizedMetadataKeys(args.metadata)
            ? { metadataKeys: sanitizedMetadataKeys(args.metadata) }
            : {}),
        },
        withFields(
          content !== undefined ? ["content"] : [],
          content !== undefined ? { bytesOmitted: byteSize(content) } : {},
        ),
        note,
      );
    }
    case "exec_run": {
      const env = toRecord(args.env);
      const envValues = Object.values(env);
      const envBytesOmitted =
        envValues.length > 0 ? byteSize(envValues) : 0;
      const stdin = stringOrUndefined(args.stdin);
      const stdinBytesOmitted = stdin !== undefined ? byteSize(stdin) : 0;
      const fields: string[] = [];
      if (stdin !== undefined) fields.push("stdin");
      if (Object.keys(env).length > 0) fields.push("env");
      return buildSentinel(
        toolName,
        "input",
        {
          ...(stringOrUndefined(args.command) ? { command: args.command } : {}),
          ...(Array.isArray(args.args) ? { args: args.args } : {}),
          ...(stringOrUndefined(args.cwd) ? { cwd: args.cwd } : {}),
          ...(numberOrUndefined(args.timeoutMs) !== undefined
            ? { timeoutMs: args.timeoutMs }
            : {}),
          ...(stringOrUndefined(args.reason) ? { reason: args.reason } : {}),
          ...(booleanOrUndefined(args.requireUserApproval) !== undefined
            ? { requireUserApproval: args.requireUserApproval }
            : {}),
          ...(Object.keys(env).length > 0 ? { envKeys: Object.keys(env) } : {}),
        },
        withFields(fields, {
          bytesOmitted: stdinBytesOmitted + envBytesOmitted,
          ...(stdin !== undefined ? { stdinBytesOmitted } : {}),
          ...(Object.keys(env).length > 0 ? { envBytesOmitted } : {}),
        }),
        note,
      );
    }
    case "agent_subagent_call": {
      const message = stringOrUndefined(args.message) ?? "";
      return buildSentinel(
        toolName,
        "input",
        {
          ...(stringOrUndefined(args.subagentId)
            ? { subagentId: args.subagentId }
            : {}),
        },
        withFields(message ? ["message"] : [], {
          ...(message ? { bytesOmitted: byteSize(message) } : {}),
        }),
        note,
      );
    }
    case "agent_card_add": {
      const markdown = stringOrUndefined(args.markdown);
      return buildSentinel(
        toolName,
        "input",
        {
          ...(stringOrUndefined(args.kind) ? { kind: args.kind } : {}),
          ...(stringOrUndefined(args.title) ? { title: args.title } : {}),
          ...(stringOrUndefined(args.artifactId)
            ? { artifactId: args.artifactId }
            : {}),
          ...(numberOrUndefined(args.version) !== undefined
            ? { version: args.version }
            : {}),
        },
        withFields(markdown !== undefined ? ["markdown"] : [], {
          ...(markdown !== undefined ? { bytesOmitted: byteSize(markdown) } : {}),
        }),
        note,
      );
    }
    default:
      return buildGenericInputSentinel(toolName, args, note);
  }
}

function buildOutputSentinel(
  toolName: string,
  note: string,
  result: ToolResult<unknown>,
): CompactionSentinelPayload {
  if (!result.ok) {
    return buildGenericFailureSentinel(toolName, note, result);
  }

  const data = toRecord(result.data);

  switch (toolName) {
    case "workspace_readFile": {
      const content = stringOrUndefined(data.content) ?? "";
      return buildSentinel(
        toolName,
        "output",
        {
          ...(stringOrUndefined(data.path) ? { path: data.path } : {}),
          ...(isRecord(data.range) ? { range: data.range } : {}),
          ...(numberOrUndefined(data.fileSizeBytes) !== undefined
            ? { fileSizeBytes: data.fileSizeBytes }
            : {}),
          ...(numberOrUndefined(data.lineCount) !== undefined
            ? { lineCount: data.lineCount }
            : {}),
          truncated: data.truncated === true,
        },
        withFields(["content"], {
          bytesOmitted: byteSize(content),
        }),
        note,
      );
    }
    case "workspace_search": {
      const matches = Array.isArray(data.matches) ? data.matches : [];
      return buildSentinel(
        toolName,
        "output",
        {
          ...(numberOrUndefined(data.matchCount) !== undefined
            ? { matchCount: data.matchCount }
            : {}),
          ...(numberOrUndefined(data.searchedFiles) !== undefined
            ? { searchedFiles: data.searchedFiles }
            : {}),
          truncated: data.truncated === true,
        },
        withFields(["matches"], {
          bytesOmitted: byteSize(matches),
        }),
        note,
      );
    }
    case "workspace_glob": {
      const matches = Array.isArray(data.matches) ? data.matches : [];
      return buildSentinel(
        toolName,
        "output",
        {
          matchCount: matches.length,
          truncated: data.truncated === true,
        },
        withFields(["matches"], {
          bytesOmitted: byteSize(matches),
        }),
        note,
      );
    }
    case "workspace_listDir": {
      const entries = Array.isArray(data.entries) ? data.entries : [];
      return buildSentinel(
        toolName,
        "output",
        {
          ...(stringOrUndefined(data.path) ? { path: data.path } : {}),
          entryCount: entries.length,
          truncated: data.truncated === true,
        },
        withFields(["entries"], {
          bytesOmitted: byteSize(entries),
        }),
        note,
      );
    }
    case "exec_run": {
      const stdout = stringOrUndefined(data.stdout) ?? "";
      const stderr = stringOrUndefined(data.stderr) ?? "";
      const stdoutBytesOmitted = byteSize(stdout);
      const stderrBytesOmitted = byteSize(stderr);
      const fields: string[] = [];
      if (stdout) fields.push("stdout");
      if (stderr) fields.push("stderr");
      return buildSentinel(
        toolName,
        "output",
        {
          ...(stringOrUndefined(data.command) ? { command: data.command } : {}),
          ...(Array.isArray(data.args) ? { args: data.args } : {}),
          ...(stringOrUndefined(data.cwd) ? { cwd: data.cwd } : {}),
          ...(numberOrUndefined(data.exitCode) !== undefined
            ? { exitCode: data.exitCode }
            : {}),
          ...(numberOrUndefined(data.durationMs) !== undefined
            ? { durationMs: data.durationMs }
            : {}),
          truncatedStdout: data.truncatedStdout === true,
          truncatedStderr: data.truncatedStderr === true,
          ...(booleanOrUndefined(data.terminatedByUser) !== undefined
            ? { terminatedByUser: data.terminatedByUser }
            : {}),
        },
        withFields(fields, {
          bytesOmitted: stdoutBytesOmitted + stderrBytesOmitted,
          ...(stdout ? { stdoutBytesOmitted } : {}),
          ...(stderr ? { stderrBytesOmitted } : {}),
        }),
        note,
      );
    }
    case "git_worktree_init": {
      const setup = toRecord(data.setup);
      const stdout = stringOrUndefined(setup.stdout);
      const stderr = stringOrUndefined(setup.stderr);
      const stdoutBytesOmitted = stdout !== undefined ? byteSize(stdout) : 0;
      const stderrBytesOmitted = stderr !== undefined ? byteSize(stderr) : 0;
      const setupSummary = Object.fromEntries(
        Object.entries({
          ...(stringOrUndefined(setup.status) ? { status: setup.status } : {}),
          ...(stringOrUndefined(setup.command) ? { command: setup.command } : {}),
          ...(stringOrUndefined(setup.cwd) ? { cwd: setup.cwd } : {}),
          ...(numberOrUndefined(setup.attemptCount) !== undefined
            ? { attemptCount: setup.attemptCount }
            : {}),
          ...(numberOrUndefined(setup.exitCode) !== undefined
            ? { exitCode: setup.exitCode }
            : {}),
          ...(numberOrUndefined(setup.durationMs) !== undefined
            ? { durationMs: setup.durationMs }
            : {}),
          ...(booleanOrUndefined(setup.truncatedStdout) !== undefined
            ? { truncatedStdout: setup.truncatedStdout }
            : {}),
          ...(booleanOrUndefined(setup.truncatedStderr) !== undefined
            ? { truncatedStderr: setup.truncatedStderr }
            : {}),
          ...(booleanOrUndefined(setup.terminatedByUser) !== undefined
            ? { terminatedByUser: setup.terminatedByUser }
            : {}),
          ...(stringOrUndefined(setup.errorMessage)
            ? { errorMessage: setup.errorMessage }
            : {}),
        }).filter(([, value]) => value !== undefined),
      );
      const omittedFields: string[] = [];
      if (stdout !== undefined) omittedFields.push("setup.stdout");
      if (stderr !== undefined) omittedFields.push("setup.stderr");
      return buildSentinel(
        toolName,
        "output",
        {
          ...(booleanOrUndefined(data.alreadyExists) !== undefined
            ? { alreadyExists: data.alreadyExists }
            : {}),
          ...(booleanOrUndefined(data.declined) !== undefined
            ? { declined: data.declined }
            : {}),
          ...(stringOrUndefined(data.path) ? { path: data.path } : {}),
          ...(stringOrUndefined(data.branch) ? { branch: data.branch } : {}),
          ...(Object.keys(setupSummary).length > 0 ? { setup: setupSummary } : {}),
        },
        withFields(omittedFields, {
          bytesOmitted: stdoutBytesOmitted + stderrBytesOmitted,
          ...(stdout !== undefined ? { stdoutBytesOmitted } : {}),
          ...(stderr !== undefined ? { stderrBytesOmitted } : {}),
        }),
        note,
      );
    }
    case "agent_artifact_get": {
      const artifact = toRecord(data.artifact);
      const content = stringOrUndefined(artifact.content);
      return buildSentinel(
        toolName,
        "output",
        {
          ...(stringOrUndefined(artifact.artifactId)
            ? { artifactId: artifact.artifactId }
            : {}),
          ...(numberOrUndefined(artifact.version) !== undefined
            ? { version: artifact.version }
            : {}),
          ...(stringOrUndefined(artifact.kind) ? { kind: artifact.kind } : {}),
          ...(stringOrUndefined(artifact.summary)
            ? { summary: artifact.summary }
            : {}),
          ...(stringOrUndefined(artifact.contentFormat)
            ? { contentFormat: artifact.contentFormat }
            : {}),
          ...(numberOrUndefined(artifact.sizeBytes) !== undefined
            ? { sizeBytes: artifact.sizeBytes }
            : {}),
          ...(artifact.validation !== undefined
            ? { validation: artifact.validation }
            : {}),
        },
        withFields(
          content !== undefined ? ["content"] : [],
          content !== undefined ? { bytesOmitted: byteSize(content) } : {},
        ),
        note,
      );
    }
    case "agent_subagent_call": {
      const cards = Array.isArray(data.cards) ? data.cards : [];
      const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
      const artifactValidations = Array.isArray(data.artifactValidations)
        ? data.artifactValidations
        : [];
      const rawText = stringOrUndefined(data.rawText);
      const omittedFields: string[] = [];
      let bytesOmitted = 0;
      if (rawText !== undefined) {
        omittedFields.push("rawText");
        bytesOmitted += byteSize(rawText);
      }
      if (cards.length > 0) {
        omittedFields.push("cards");
        bytesOmitted += byteSize(cards);
      }
      if (artifacts.length > 0) {
        omittedFields.push("artifacts");
        bytesOmitted += byteSize(artifacts);
      }
      if (artifactValidations.length > 0) {
        omittedFields.push("artifactValidations");
        bytesOmitted += byteSize(artifactValidations);
      }
      return buildSentinel(
        toolName,
        "output",
        {
          ...(stringOrUndefined(data.subagentId)
            ? { subagentId: data.subagentId }
            : {}),
          ...(stringOrUndefined(data.name) ? { name: data.name } : {}),
          ...(stringOrUndefined(data.modelId) ? { modelId: data.modelId } : {}),
          ...(numberOrUndefined(data.turns) !== undefined ? { turns: data.turns } : {}),
          ...(stringOrUndefined(data.note) ? { note: data.note } : {}),
          cardCount: cards.length,
          artifactCount: artifacts.length,
          artifactValidationCount: artifactValidations.length,
        },
        withFields(omittedFields, {
          ...(bytesOmitted > 0 ? { bytesOmitted } : {}),
        }),
        note,
      );
    }
    case "user_input": {
      const answer = stringOrUndefined(data.answer) ?? "";
      return buildSentinel(
        toolName,
        "output",
        {
          answerLength: answer.length,
        },
        withFields(answer ? ["answer"] : [], {
          ...(answer ? { bytesOmitted: byteSize(answer) } : {}),
        }),
        note,
      );
    }
    default:
      return buildSentinel(
        toolName,
        "output",
        { ok: true },
        withFields(["data"], {
          bytesOmitted: byteSize(result.data),
        }),
        note,
      );
  }
}

export function mergeToolContextCompactionDisplay(
  previous: ToolContextCompactionDisplay | undefined,
  next: ToolContextCompactionDisplay | undefined,
): ToolContextCompactionDisplay | undefined {
  if (!previous) return next;
  if (!next) return previous;

  return {
    request: {
      ...previous.request,
      ...next.request,
    },
    ...(previous.input || next.input
      ? { input: next.input ?? previous.input }
      : {}),
    ...(previous.output || next.output
      ? { output: next.output ?? previous.output }
      : {}),
    ...(mergeWarnings(previous.warnings, next.warnings)
      ? { warnings: mergeWarnings(previous.warnings, next.warnings) }
      : {}),
  };
}

export function isDelayedToolIoReplacementEnabled(
  options?: { enabled?: boolean },
): boolean {
  return DELAYED_TOOL_IO_REPLACEMENT_ENABLED && options?.enabled !== false;
}

export function toolContextCompactionThresholdKbToBytes(
  thresholdKb: unknown,
): number {
  return sanitizeToolContextCompactionThresholdKb(thresholdKb) * 1024;
}

export function createPendingToolIoReplacement(
  toolCallId: string,
  toolName: string,
  rawArgs: Record<string, unknown>,
  result: ToolResult<unknown>,
  options?: {
    enabled?: boolean;
    thresholdBytes?: number;
  },
): PendingToolIoReplacement | null {
  if (!isDelayedToolIoReplacementEnabled(options)) {
    return null;
  }

  const inputBytes = byteSize(rawArgs);
  const outputBytes = byteSize(result);
  const totalBytes = inputBytes + outputBytes;
  const thresholdBytes =
    options?.thresholdBytes ?? DELAYED_TOOL_IO_REPLACEMENT_THRESHOLD_BYTES;
  if (totalBytes <= thresholdBytes) {
    return null;
  }

  return {
    toolCallId,
    toolName,
    rawArgs,
    result,
    inputBytes,
    outputBytes,
    totalBytes,
  };
}

export function buildToolIoReplacementPrompt(
  pending: readonly PendingToolIoReplacement[],
): string {
  return [
    "INTERNAL RUNNER MAINTENANCE",
    "The previous tool turn included oversized raw tool IO.",
    `Call ${TOOL_IO_REPLACEMENT_TOOL_NAME} exactly once before continuing.`,
    "Provide one concise factual inputNote and one concise factual outputNote for each pending tool call.",
    "Do not quote or restate large payloads. Capture only the details future turns need.",
    `Each note must be at most ${MAX_TOOL_CONTEXT_NOTE_CHARS} characters.`,
    "",
    "Pending tool calls:",
    ...pending.map(
      (entry) =>
        `- ${entry.toolCallId}: ${entry.toolName} (inputBytes=${entry.inputBytes}, outputBytes=${entry.outputBytes}, totalBytes=${entry.totalBytes})`,
    ),
  ].join("\n");
}

export function validateToolIoReplacementPayload(
  rawArgs: Record<string, unknown>,
  pendingByToolCallId: ReadonlyMap<string, PendingToolIoReplacement>,
): { ok: true; replacements: ToolIoReplacementNotes[] } | {
  ok: false;
  message: string;
} {
  const rawReplacements = rawArgs.replacements;
  if (!Array.isArray(rawReplacements) || rawReplacements.length === 0) {
    return {
      ok: false,
      message: "agent_replace_tool_io requires a non-empty replacements array.",
    };
  }

  const seen = new Set<string>();
  const replacements: ToolIoReplacementNotes[] = [];

  for (const entry of rawReplacements) {
    if (!isRecord(entry)) {
      return {
        ok: false,
        message: "Each replacement entry must be an object.",
      };
    }

    const toolCallId =
      typeof entry.toolCallId === "string" ? entry.toolCallId : undefined;
    if (!toolCallId) {
      return {
        ok: false,
        message: "Each replacement entry must include toolCallId.",
      };
    }
    if (seen.has(toolCallId)) {
      return {
        ok: false,
        message: `Duplicate replacement entry for tool call "${toolCallId}".`,
      };
    }
    if (!pendingByToolCallId.has(toolCallId)) {
      return {
        ok: false,
        message: `Tool call "${toolCallId}" is not pending replacement.`,
      };
    }

    const inputNote = sanitizeNote(entry.inputNote);
    if (!inputNote) {
      return {
        ok: false,
        message: `Replacement "${toolCallId}" must include a valid inputNote.`,
      };
    }

    const outputNote = sanitizeNote(entry.outputNote);
    if (!outputNote) {
      return {
        ok: false,
        message: `Replacement "${toolCallId}" must include a valid outputNote.`,
      };
    }

    seen.add(toolCallId);
    replacements.push({
      toolCallId,
      inputNote,
      outputNote,
    });
  }

  const missing = [...pendingByToolCallId.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Missing replacements for: ${missing.join(", ")}.`,
    };
  }

  return { ok: true, replacements };
}

export function buildToolIoReplacementDisplay(
  pending: PendingToolIoReplacement,
  notes: ToolIoReplacementNotes,
): ToolContextCompactionDisplay {
  const inputModelValue = buildInputSentinel(
    pending.toolName,
    pending.rawArgs,
    notes.inputNote,
  );
  const outputModelValue = buildOutputSentinel(
    pending.toolName,
    notes.outputNote,
    pending.result,
  );

  return {
    request: {
      inputNote: notes.inputNote,
      outputNote: notes.outputNote,
      outputMode: "always",
    },
    input: {
      status: "compacted",
      note: notes.inputNote,
      modelValue: inputModelValue,
    },
    output: {
      status: "compacted",
      note: notes.outputNote,
      mode: "always",
      modelValue: outputModelValue,
    },
  };
}

export function applyToolIoReplacements(
  apiMessages: ApiMessage[],
  replacements: readonly ToolIoReplacementNotes[],
  pendingByToolCallId: ReadonlyMap<string, PendingToolIoReplacement>,
): ApiMessage[] {
  const replacementById = new Map(
    replacements.map((replacement) => [replacement.toolCallId, replacement] as const),
  );

  return apiMessages.map((message) => {
    if (message.role === "assistant" && message.tool_calls) {
      return {
        ...message,
        tool_calls: message.tool_calls.map((toolCall) => {
          const replacement = replacementById.get(toolCall.id);
          const pending = replacement
            ? pendingByToolCallId.get(toolCall.id)
            : undefined;
          if (!replacement || !pending) return toolCall;
          return {
            ...toolCall,
            function: {
              ...toolCall.function,
              arguments: safeJsonStringify(
                buildInputSentinel(
                  pending.toolName,
                  pending.rawArgs,
                  replacement.inputNote,
                ),
                toolCall.function.arguments,
              ),
            },
          };
        }),
      };
    }

    if (message.role === "tool") {
      const replacement = replacementById.get(message.tool_call_id);
      const pending = replacement
        ? pendingByToolCallId.get(message.tool_call_id)
        : undefined;
      if (!replacement || !pending) return message;
      return {
        ...message,
        content: safeJsonStringify(
          buildOutputSentinel(
            pending.toolName,
            replacement.outputNote,
            pending.result,
          ),
          message.content,
        ),
      };
    }

    return message;
  });
}
