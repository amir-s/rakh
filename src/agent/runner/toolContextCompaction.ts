import type {
  ToolContextCompactionDisplay,
  ToolContextCompactionOutputMode,
  ToolContextCompactionRequest,
  ToolResult,
} from "../types";

export type ToolContextCompactionSourceKind = "local" | "mcp" | "synthetic";

type ToolContextCompactionSide = "input" | "output";

interface SanitizedToolContextCompactionRequest {
  inputNote?: string;
  outputNote?: string;
  outputMode?: ToolContextCompactionOutputMode;
}

export interface PreparedToolContextCompaction {
  strippedArgs: Record<string, unknown>;
  display?: ToolContextCompactionDisplay;
  warnings: string[];
  inputPlan?: { note: string };
  outputPlan?: {
    note: string;
    mode: ToolContextCompactionOutputMode;
  };
  inputReason?: string;
  outputReason?: string;
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

const TOOL_CONTEXT_COMPACTION_FEATURE_AVAILABLE = true;
const MAX_NOTE_CHARS = 280;

const INPUT_ALLOWLIST = new Set([
  "workspace_writeFile",
  "workspace_editFile",
  "agent_artifact_create",
  "agent_artifact_version",
  "exec_run",
]);

const OUTPUT_ALLOWLIST = new Set([
  "workspace_readFile",
  "workspace_search",
  "workspace_glob",
  "workspace_listDir",
  "exec_run",
  "git_worktree_init",
  "agent_artifact_get",
]);

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

function sanitizeNote(
  label: "inputNote" | "outputNote",
  value: unknown,
  warnings: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    warnings.push(`Ignored ${label}: expected a string.`);
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_NOTE_CHARS) {
    warnings.push(
      `Ignored ${label}: notes longer than ${MAX_NOTE_CHARS} characters are not supported.`,
    );
    return undefined;
  }
  return trimmed;
}

function sanitizeRequest(
  toolName: string,
  rawRequest: unknown,
): {
  request?: SanitizedToolContextCompactionRequest;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (rawRequest === undefined) {
    return { warnings };
  }
  if (!isRecord(rawRequest)) {
    warnings.push(
      `Ignored __contextCompaction on ${toolName}: expected an object.`,
    );
    return { warnings };
  }

  const inputNote = sanitizeNote("inputNote", rawRequest.inputNote, warnings);
  const outputNote = sanitizeNote("outputNote", rawRequest.outputNote, warnings);

  let outputMode: ToolContextCompactionOutputMode | undefined;
  if (outputNote) {
    if (rawRequest.outputMode === undefined) {
      outputMode = "always";
    } else if (
      rawRequest.outputMode === "always" ||
      rawRequest.outputMode === "on_success"
    ) {
      outputMode = rawRequest.outputMode;
    } else {
      warnings.push(
        "Ignored outputNote: outputMode must be 'always' or 'on_success'.",
      );
    }
  }

  const request: SanitizedToolContextCompactionRequest = {
    ...(inputNote ? { inputNote } : {}),
    ...(outputNote && outputMode
      ? { outputNote, outputMode }
      : {}),
  };

  return Object.keys(request).length > 0
    ? { request, warnings }
    : { warnings };
}

function buildBaseDisplay(
  request: SanitizedToolContextCompactionRequest,
  warnings: string[],
): ToolContextCompactionDisplay {
  return {
    request,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
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
    default:
      return buildSentinel(
        toolName,
        "input",
        {},
        withFields([], {}),
        note,
      );
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
    default:
      return buildSentinel(toolName, "output", {}, withFields([], {}), note);
  }
}

function shouldCompactToolOutputOnSuccess(
  toolName: string,
  result: ToolResult<unknown>,
): boolean {
  if (!result.ok) return false;

  if (toolName === "exec_run") {
    const data = toRecord(result.data);
    return data.exitCode === 0 && data.terminatedByUser !== true;
  }

  if (toolName === "git_worktree_init") {
    const data = toRecord(result.data);
    if (data.declined === true || data.alreadyExists === true) {
      return true;
    }

    const setup = toRecord(data.setup);
    const status = stringOrUndefined(setup.status);
    if (!status || status === "not_configured") return true;
    if (status !== "success") return false;
    const attempts = numberOrUndefined(setup.attemptCount);
    return attempts === undefined || attempts <= 1;
  }

  return true;
}

function getOnSuccessFailureReason(
  toolName: string,
  result: ToolResult<unknown>,
): string {
  if (!result.ok) {
    return "Kept full because the tool returned an error.";
  }

  if (toolName === "exec_run") {
    const data = toRecord(result.data);
    if (data.terminatedByUser === true) {
      return "Kept full because the command was terminated by the user.";
    }
    const exitCode = numberOrUndefined(data.exitCode);
    if (exitCode !== undefined && exitCode !== 0) {
      return `Kept full because exec_run exited with code ${exitCode}.`;
    }
  }

  if (toolName === "git_worktree_init") {
    const data = toRecord(result.data);
    const setup = toRecord(data.setup);
    const status = stringOrUndefined(setup.status);
    const attemptCount = numberOrUndefined(setup.attemptCount);
    if (status && status !== "success" && status !== "not_configured") {
      return `Kept full because git_worktree_init setup status was "${status}".`;
    }
    if (status === "success" && attemptCount !== undefined && attemptCount > 1) {
      return "Kept full because git_worktree_init required multiple setup attempts.";
    }
  }

  return "Kept full because the tool result did not meet the output compaction success criteria.";
}

export function stripToolContextCompactionFields(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const strippedArgs = { ...args };
  delete strippedArgs.__contextCompaction;
  return strippedArgs;
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

export function prepareToolContextCompaction(
  toolName: string,
  rawArgs: Record<string, unknown>,
  sourceKind: ToolContextCompactionSourceKind,
  options?: {
    enabled?: boolean;
  },
): PreparedToolContextCompaction {
  const strippedArgs = stripToolContextCompactionFields(rawArgs);
  const { request, warnings } = sanitizeRequest(
    toolName,
    rawArgs.__contextCompaction,
  );
  const compactionEnabled =
    TOOL_CONTEXT_COMPACTION_FEATURE_AVAILABLE && options?.enabled !== false;

  if (!request) {
    return { strippedArgs, warnings };
  }

  const display = buildBaseDisplay(request, warnings);
  const prepared: PreparedToolContextCompaction = {
    strippedArgs,
    display,
    warnings,
  };

  const sourceUnsupportedReason =
    sourceKind === "local"
      ? undefined
      : `Ignored because ${sourceKind} tools do not support context compaction.`;

  if (request.inputNote) {
    if (!compactionEnabled) {
      prepared.inputReason =
        "Input kept full because tool IO context compaction is disabled.";
    } else if (sourceUnsupportedReason) {
      prepared.inputReason = sourceUnsupportedReason;
    } else if (!INPUT_ALLOWLIST.has(toolName)) {
      prepared.inputReason =
        "Input kept full because this tool is not allowlisted for input compaction.";
    } else {
      prepared.inputPlan = { note: request.inputNote };
    }
  }

  if (request.outputNote) {
    if (!compactionEnabled) {
      prepared.outputReason =
        "Output kept full because tool IO context compaction is disabled.";
    } else if (sourceUnsupportedReason) {
      prepared.outputReason = sourceUnsupportedReason;
    } else if (!OUTPUT_ALLOWLIST.has(toolName)) {
      prepared.outputReason =
        "Output kept full because this tool is not allowlisted for output compaction.";
    } else {
      prepared.outputPlan = {
        note: request.outputNote,
        mode: request.outputMode ?? "always",
      };
    }
  }

  if (sourceUnsupportedReason) {
    prepared.warnings.push(
      `Ignored __contextCompaction on ${toolName}: only local tools are supported.`,
    );
    if (prepared.display) {
      prepared.display.warnings = mergeWarnings(prepared.display.warnings, [
        `Only local tools support context compaction.`,
      ]);
    }
  } else {
    const ignoredSideWarnings: string[] = [];
    if (request.inputNote && !prepared.inputPlan && prepared.inputReason) {
      ignoredSideWarnings.push(prepared.inputReason);
    }
    if (request.outputNote && !prepared.outputPlan && prepared.outputReason) {
      ignoredSideWarnings.push(prepared.outputReason);
    }
    if (ignoredSideWarnings.length > 0 && prepared.display) {
      prepared.warnings.push(...ignoredSideWarnings);
      prepared.display.warnings = mergeWarnings(
        prepared.display.warnings,
        ignoredSideWarnings,
      );
    }
  }

  return prepared;
}

export function buildToolContextCompactedInput(
  toolName: string,
  prepared: PreparedToolContextCompaction,
): {
  argumentsJson: string;
  display?: ToolContextCompactionDisplay;
} {
  const fullJson = safeJsonStringify(prepared.strippedArgs, "{}");
  if (!prepared.display || !prepared.display.request.inputNote) {
    return { argumentsJson: fullJson };
  }

  if (!prepared.inputPlan) {
    return {
      argumentsJson: fullJson,
      display: {
        request: prepared.display.request,
        input: {
          status: "full",
          note: prepared.display.request.inputNote,
          reason: prepared.inputReason ?? "Input kept full.",
        },
        ...(prepared.display.warnings
          ? { warnings: prepared.display.warnings }
          : {}),
      },
    };
  }

  const modelValue = buildInputSentinel(
    toolName,
    prepared.strippedArgs,
    prepared.inputPlan.note,
  );
  return {
    argumentsJson: safeJsonStringify(modelValue, fullJson),
    display: {
      request: prepared.display.request,
      input: {
        status: "compacted",
        note: prepared.inputPlan.note,
        modelValue,
      },
      ...(prepared.display.warnings
        ? { warnings: prepared.display.warnings }
        : {}),
    },
  };
}

export function buildToolContextCompactedOutput(
  toolName: string,
  result: ToolResult<unknown>,
  prepared: PreparedToolContextCompaction,
  fallbackContent: string,
): {
  content: string;
  display?: ToolContextCompactionDisplay;
} {
  if (!prepared.display || !prepared.display.request.outputNote) {
    return { content: fallbackContent };
  }

  const note = prepared.display.request.outputNote;
  const mode = prepared.outputPlan?.mode ?? prepared.display.request.outputMode;

  if (!prepared.outputPlan) {
    return {
      content: fallbackContent,
      display: {
        request: prepared.display.request,
        output: {
          status: "full",
          note,
          ...(mode ? { mode } : {}),
          reason: prepared.outputReason ?? "Output kept full.",
        },
        ...(prepared.display.warnings
          ? { warnings: prepared.display.warnings }
          : {}),
      },
    };
  }

  if (
    prepared.outputPlan.mode === "on_success" &&
    !shouldCompactToolOutputOnSuccess(toolName, result)
  ) {
    return {
      content: fallbackContent,
      display: {
        request: prepared.display.request,
        output: {
          status: "full",
          note,
          mode: prepared.outputPlan.mode,
          reason: getOnSuccessFailureReason(toolName, result),
        },
        ...(prepared.display.warnings
          ? { warnings: prepared.display.warnings }
          : {}),
      },
    };
  }

  const modelValue = buildOutputSentinel(
    toolName,
    prepared.outputPlan.note,
    result,
  );
  return {
    content: safeJsonStringify(modelValue, fallbackContent),
    display: {
      request: prepared.display.request,
      output: {
        status: "compacted",
        note: prepared.outputPlan.note,
        mode: prepared.outputPlan.mode,
        modelValue,
      },
      ...(prepared.display.warnings
        ? { warnings: prepared.display.warnings }
        : {}),
    },
  };
}
