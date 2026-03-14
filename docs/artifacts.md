# Artifacts

## Overview

Artifacts are the durable output channel for agents and subagents.

They are used for:

- Plans
- Reports
- Review results
- Security audits
- Copy review suggestions
- MCP-returned file/image payloads when MCP artifactization is enabled in Settings
- Other handoff outputs that should survive beyond a single chat turn

Artifacts are stored per session. The manifest lives in SQLite and the content
blob is stored separately by content hash.

Current storage layout:

- Release builds:
  - Session/manifests DB: `~/.rakh/sessions/sessions.db`
  - Blob storage: `~/.rakh/artifacts/blobs/sha256`
- Debug/dev builds:
  - Session/manifests DB: `~/.rakh-dev/sessions/sessions.db`
  - Blob storage: `~/.rakh-dev/artifacts/blobs/sha256`

## Temporary tool artifacts

ToolGateway also uses a separate temporary artifact store for oversized tool
results. These are not durable session artifacts and they are not shown in the
normal artifact pane.

Current storage layout:

- Release builds:
  - Tool-artifact root: `~/.rakh/artifacts/tools`
- Debug/dev builds:
  - Tool-artifact root: `~/.rakh-dev/artifacts/tools`

Each temporary tool artifact lives in its own directory named
`<timestamp>_<random>`. The directory contains:

- `meta.json`
- `payload.txt`

The metadata currently records:

- `artifactId`
- `createdAtMs`
- `runId`
- `tabId`
- `agentId`
- `toolCallId`
- `toolName`
- `sourceKind`
- `policyId`
- `originalFormat`
- `sizeBytes`
- `lineCount`
- optional `intention`

Temporary tool artifacts are always canonical UTF-8 text:

- plain string tool results are stored directly
- structured results are pretty-printed as JSON text

The agent never receives raw filesystem paths. It only sees logical
`artifactId`s through ToolGateway envelopes.

### Tool-artifact helpers

The model-visible helpers for temporary tool artifacts are:

- `agent_tool_artifact_get`
- `agent_tool_artifact_search`

The backend also exposes create/delete operations, but those are engine-owned
helpers rather than normal model-facing tools.

`agent_tool_artifact_get` returns a bounded slice of the stored payload and can
optionally read by line range.

`agent_tool_artifact_search` performs regex search over the stored payload and
returns bounded contextual matches.

These tools intentionally enforce conservative caps so reading a large artifact
does not immediately recreate the same context-size problem.

### ToolGateway envelopes

When ToolGateway replaces a large tool result, the model receives an artifact
reference envelope instead of the original payload:

```json
{
  "ok": true,
  "data": {
    "__rakhToolGateway": {
      "kind": "artifact-ref",
      "artifactId": "toolart_deadbeef",
      "originalTool": "exec_run",
      "sizeBytes": 81920,
      "lineCount": 1427,
      "originalFormat": "json",
      "appliedPolicies": ["huge-output", "summary"],
      "note": "Raw tool output stored as a temporary tool artifact.",
      "summary": "Short optional summary."
    }
  }
}
```

This is distinct from durable `agent_artifact_*` references. ToolGateway
artifact refs are only for temporary tool output management.

### Design choices

- Keep durable and temporary artifacts separate: session artifacts are part of
  the product model, while tool artifacts are engine-owned scratch storage.
- Store one canonical text payload: this keeps `get` and `search` simple and
  avoids format-specific readers in the gateway.
- Preserve the full raw output first: summarization is an additional view over
  the same stored payload, not a destructive rewrite.
- Prefer bounded follow-up tools over reinlining content: once a result is
  artifactized, the parent agent should inspect only the parts it needs.

## Core Model

The frontend artifact shape is defined in
[`src/agent/tools/artifacts.ts`](../src/agent/tools/artifacts.ts).

Important fields:

- `artifactId`: stable logical artifact ID
- `version`: append-only version number
- `kind`: persisted artifact kind such as `plan`, `review-report`, or `security-report`
- `contentFormat`: one of `text`, `markdown`, `unified-diff`, or `json`
- `metadata`: free-form JSON metadata
- `content`: optional payload body

Current non-subagent artifact kinds created by the runtime include:

- `mcp-attachment`: JSON-wrapped MCP file/image/resource payloads captured from
  tool results when the global MCP artifactization toggle is enabled

The supported content formats are centralized in
[`src/agent/tools/artifactTypes.ts`](../src/agent/tools/artifactTypes.ts).

## Artifact Tools

Artifact operations are exposed through four tools:

- `agent_artifact_create`
- `agent_artifact_version`
- `agent_artifact_get`
- `agent_artifact_list`

Tool schemas live in
[`src/agent/tools/definitions.ts`](../src/agent/tools/definitions.ts), and the
wrappers live in
[`src/agent/tools/artifacts.ts`](../src/agent/tools/artifacts.ts).

In the desktop app, artifact pane updates are not poll-based anymore. The UI
does one initial `agent_artifact_list` read per session view, then listens for
backend `artifact_changed` Tauri events and refetches manifests when matching
session artifacts change.

### Create

`agent_artifact_create` creates a new artifact with version `1`.

Important inputs:

- `kind`
- `contentFormat`
- `content`
- `summary`
- `metadata`
- `artifactType` for framework-linked subagent artifacts

### Version

`agent_artifact_version` creates a new version of an existing artifact.

If `content` is omitted, the previous blob is reused.

For framework-linked artifacts, `artifactType` can be omitted during versioning
if the existing artifact already carries framework metadata. The wrapper
inherits that metadata automatically.

### Get

`agent_artifact_get` fetches a specific artifact version or the latest version.

For validator-backed JSON artifacts, `artifactGet()` also returns:

- `artifact.validation.status`
- `artifact.validation.validatorId`
- `artifact.validation.issues`

The content is returned unchanged. Validation is supplemental metadata, not a
transformation step.

### MCP attachment artifacts

When `Settings -> MCP Servers -> Save returned files as artifacts` is enabled,
the main runner will try to move MCP-returned binary/resource payloads into
artifacts instead of feeding those raw payloads back into model context.

Current behavior:

- the artifact is stored with `kind: "mcp-attachment"` and `contentFormat: "json"`
- the saved JSON preserves the original MCP payload shape
- the runner replaces the model-facing tool result with an artifact reference
  and a note telling the model to use `agent_artifact_get`
- the artifact pane renders image attachments as real previews when the saved
  JSON contains an image MIME type plus base64/text image data
- if artifact creation fails or the toggle is off, the MCP result is left
  untouched

## Artifact Change Events

Artifact writes also produce a lightweight UI notification event.

The Rust backend emits `artifact_changed` after successful
`db_artifact_create` and `db_artifact_version` calls. The frontend subscribes
through `listenForArtifactChanges()` in
[`src/agent/tools/artifacts.ts`](../src/agent/tools/artifacts.ts).

Current payload shape:

```json
{
  "sessionId": "tab-1",
  "artifactId": "plan_deadbeef",
  "version": 2,
  "kind": "plan",
  "runId": "run_1",
  "agentId": "agent_main",
  "change": "versioned",
  "createdAt": 1741540000000
}
```

Notes:

- `change` is `created` or `versioned`
- the event is advisory; the UI still treats `agent_artifact_list` as the
  source of truth
- listeners filter by `sessionId` so tabs only react to their own artifact
  changes

## Framework Metadata

Artifacts do not have a dedicated DB column for validator linkage.
Instead, framework metadata is stored inside `metadata.__rakh`.

Current shape:

```json
{
  "__rakh": {
    "artifactType": "review-report",
    "validatorId": "reviewer.review-report"
  }
}
```

This metadata is written by the frontend artifact wrapper and runner, not by
the Rust DB layer.

Helper functions:

- `withArtifactFrameworkMetadata(...)`
- `getArtifactFrameworkMetadata(...)`

Both live in
[`src/agent/tools/artifacts.ts`](../src/agent/tools/artifacts.ts).

## How Validation Works

Only `contentFormat: "json"` artifacts participate in schema validation.

Validation sources come from subagent artifact contracts, defined in
[`src/agent/subagents/types.ts`](../src/agent/subagents/types.ts) and concrete
subagent files under
[`src/agent/subagents/`](../src/agent/subagents/).

The lifecycle is:

1. A subagent declares an artifact contract with `artifactType`, `kind`,
   `contentFormat`, and an optional validator.
2. The runner intercepts `agent_artifact_create` and `agent_artifact_version`
   inside the subagent loop.
3. The runner checks that the requested artifact matches the declared contract.
4. If the contract has a validator, the runner validates the JSON content before
   the artifact is persisted.
5. The runner stamps `metadata.__rakh.artifactType` and
   `metadata.__rakh.validatorId` onto the artifact.
6. Later, `artifactGet()` uses `validatorId` to find the same validator again
   and returns validation status with the artifact.

## Validation Modes

Validators support two modes:

- `reject`: invalid payloads fail the tool call before persistence
- `warn`: invalid payloads are still persisted, but warnings are recorded

In `reject` mode, the subagent sees the failed tool call and can repair the
payload in the same subagent run.

In `warn` mode, the artifact is written, and the subagent call result includes a
warning entry in `artifactValidations`.

## How Validators Are Linked

Validator linkage is metadata-based.

The artifact itself stores only:

- `artifactType`
- `validatorId`

The actual validator implementation is resolved at runtime from the registered
subagent contracts.

Resolver:

- [`getSubagentArtifactValidatorById()`](../src/agent/subagents/index.ts)

This means:

- No DB migration is required to add validator-backed artifacts
- Versioned artifacts keep the linkage by preserving framework metadata
- Artifact reads can re-run validation without embedding schemas in storage

## Parent-Agent Consumption

Subagent results are artifact-first.

The parent agent should:

1. Look at the returned `artifacts` manifests from `agent_subagent_call`
2. Use the `artifactId` to read the artifact body with `agent_artifact_get`
3. Treat the artifact body as the source of truth
4. Use `artifactValidations` and `artifact.validation` to understand whether the
   payload passed validation, warned, or failed

This is the same pattern Planner already used before the validator refactor,
extended to structured JSON outputs.

## Current Artifact-Backed Subagents

- `planner` -> `artifactType: "plan"` -> markdown -> no validator
- `reviewer` -> `artifactType: "review-report"` -> json -> `reject`
- `security` -> `artifactType: "security-report"` -> json -> `reject`
- `copywriter` -> `artifactType: "copy-review"` -> json -> `warn`

## Adding a New Validator-Backed Artifact

1. Define the artifact contract in the subagent's `output.artifacts`.
2. Give it a stable `artifactType`.
3. Set the persisted `kind`.
4. Set `contentFormat: "json"` if you want schema validation.
5. Add `validator.id`, `validator.schema`, and `validator.validationMode`.
6. In the subagent prompt, instruct the subagent to write the artifact with
   `agent_artifact_create` or `agent_artifact_version`.
7. Keep the final assistant message short and human-readable.

## Notes

- Artifact validation is a framework concern layered on top of the generic
  artifact store.
- The Rust backend does not know about validator ids or artifact types beyond
  storing metadata JSON.
- The same Zod schema is used both to explain the contract to the subagent and
  to validate the saved JSON payload.
