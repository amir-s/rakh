# Artifacts

## Overview

Artifacts are the durable output channel for agents and subagents.

They are used for:

- Plans
- Reports
- Review results
- Security audits
- Copy review suggestions
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
