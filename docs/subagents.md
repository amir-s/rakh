# Subagents

## Overview

Subagents are specialized agents that the main agent can delegate work to with
`agent_subagent_call`.

They run their own reasoning/tool loop, but their chat output is displayed in
the parent tab with the subagent's name and styling.

Each `agent_subagent_call` invocation owns its own chat bubble/thread in the
parent tab. Later turns from that same invocation stay attached to the original
bubble even when multiple calls to the same subagent are running in parallel.

Subagent registration lives in
[`src/agent/subagents/index.ts`](../src/agent/subagents/index.ts).

Current built-in subagents:

- Planner
- Copywriter
- Code Reviewer
- Security Auditor
- GitHub Operator

## Definition Shape

The subagent contract is defined in
[`src/agent/subagents/types.ts`](../src/agent/subagents/types.ts).

Important fields on `SubagentDefinition`:

- `id`
- `name`
- `icon`
- `color`
- `description`
- `systemPrompt`
- `recommendedModels`
- `tools`
- `requiresApproval`
- `triggerCommand`
- `whenToUse`
- `output`

## Output Contract

Subagents no longer return structured JSON by embedding raw payloads in their
final chat message.

When a subagent needs durable structured output, it declares an artifact-centric
output contract:

```ts
output: {
  finalMessageInstructions: "...",
  parentNote: "...",
  artifacts: [
    {
      artifactType: "review-report",
      kind: "review-report",
      contentFormat: "json",
      required: true,
      cardinality: "one",
      validator: {
        id: "reviewer.review-report",
        schema: z.object(...),
        validationMode: "reject",
      },
    },
  ],
}
```

This allows the framework and the subagent to share one contract definition.

Command-oriented subagents can also use:

```ts
output: {
  finalMessageInstructions: "...",
  parentNote: "...",
  artifacts: [],
}
```

In that mode, the subagent returns a concise summary only and does not persist a
durable artifact.

Conversation cards are intentionally not part of the formal subagent DNA.
Subagents get `agent_card_add` in their tool allowlist and are instructed via
prompt text to use it for user-facing summaries.

## How the Subagent Gets the Schema

The schema is not fetched dynamically and it is not passed as a tool argument.

It is injected into the subagent system prompt by the runner.

Flow:

1. The subagent declares `output.artifacts[].validator.schema` as a Zod schema.
2. The runner converts that schema to JSON Schema with `z.toJSONSchema(...)`.
3. The runner appends the artifact contract to the subagent system prompt under
   `ARTIFACT CONTRACTS`.
4. The subagent reads that prompt and uses it when creating JSON artifacts.
5. The framework validates the resulting artifact with the same original Zod
   schema.

Prompt construction happens in
[`buildSubagentSystemPrompt()`](../src/agent/runner/systemPrompt.ts).

## Subagent Execution Flow

Subagent execution lives in
[`runSubagentLoop()`](../src/agent/runner/subagentLoop.ts).

High-level flow:

1. Parent agent calls `agent_subagent_call`
2. Runner resolves the subagent definition
3. Runner builds a subagent-specific system prompt
4. Subagent runs a private multi-turn tool loop
5. Subagent optionally writes durable outputs as artifacts
6. Subagent may also post user-visible conversation cards with `agent_card_add`
7. Runner validates produced artifacts against the declared contract
8. Runner keeps that invocation's streamed assistant turns attached to one
   stable bubble/thread in the parent chat UI
9. Runner returns the result to the parent as:
   - `rawText`
   - `cards`
   - `artifacts`
   - `artifactValidations`
   - optional `note`

The subagent final message should be status-only text. User-facing summaries
belong in summary cards. When artifacts exist, the durable payload lives there.
When `artifacts: []`, summary cards are the primary user-facing output.

## Artifact Contract Enforcement

Inside the subagent loop, the runner intercepts:

- `agent_artifact_create`
- `agent_artifact_version`

It checks:

- `artifactType` exists and is declared
- `kind` matches the declared artifact contract
- `contentFormat` matches the declared artifact contract
- JSON content passes the validator when one exists

At the end of the subagent run, the runner also enforces:

- required artifacts were produced
- `cardinality: "one"` did not produce multiple artifact ids

If the contract is not satisfied, the subagent call fails.

## Validation Modes

Each artifact validator can choose its own enforcement mode:

- `reject`
- `warn`

### Reject

The artifact tool call fails before persistence.

Use this when the artifact shape must be correct for the parent agent to rely on
it, for example:

- code review findings
- security audit reports

### Warn

The artifact is persisted, but the framework records validation warnings.

Use this when the output is still useful even if some optional structure is
missing or malformed, for example:

- copy suggestions
- softer recommendation artifacts

## Parent-Agent Contract

When present, subagent artifacts are the durable machine-readable source of
truth.

Recommended pattern:

1. Call `agent_subagent_call`
2. Read `cards` and `artifacts` from the returned result
3. Returned cards are already visible to the user; do not recreate the same
   cards with `agent_card_add`
4. If artifacts are present, use `artifactId` to fetch the artifact body with `agent_artifact_get`
5. Treat artifact cards as references only; they intentionally do not include
   the artifact body
6. Use `artifactValidations` and `artifact.validation` to inspect validation
   status when relevant
7. Treat `rawText` as status-only text, not the canonical summary body

This mirrors the older planner behavior, but now applies uniformly to
structured subagent outputs too.

## Trigger Commands

Some subagents can be invoked directly from the user message:

- `/plan`
- `/review`
- `/security`
- `/copywrite`
- `/github`

Trigger resolution happens in
[`findSubagentByTrigger()`](../src/agent/subagents/index.ts).

Direct trigger routing still uses the same artifact contract enforcement as
parent-initiated delegation and still renders as a single threaded subagent
bubble in the parent tab.

## Adding a New Subagent

1. Create a new file under
   [`src/agent/subagents/`](../src/agent/subagents/).
2. Export a `SubagentDefinition`.
3. Add it to the registry in
   [`src/agent/subagents/index.ts`](../src/agent/subagents/index.ts).
4. Define `tools` conservatively.
5. Define `output.finalMessageInstructions`.
6. Define `output.artifacts` or explicitly set `artifacts: []` for summary-only subagents.
7. Add validators where durable JSON structure matters.
8. If you expose a direct user command, set `triggerCommand`.
9. Add tests for:
   - registry presence
   - tool safety
   - artifact contract behavior if needed
   - card serialization / prompt behavior if needed

## Current Artifact Contracts

### Planner

- Produces one required markdown artifact
- `artifactType: "plan"`
- No schema validator

### Reviewer

- Produces one required JSON artifact
- `artifactType: "review-report"`
- Strict validator with `validationMode: "reject"`

### GitHub Operator

- Produces no artifacts
- Uses summary cards for user-facing output

### Security

- Produces one required JSON artifact
- `artifactType: "security-report"`
- Strict validator with `validationMode: "reject"`

### Copywriter

- Produces one required JSON artifact
- `artifactType: "copy-review"`
- Warning-mode validator with `validationMode: "warn"`

## Practical Design Rules

- Keep the final message short and status-only. Do not duplicate summary-card
  or artifact content in chat.
- Put structured payloads in artifacts, not assistant text.
- Use summary cards for user-facing Markdown summaries.
- Use artifact cards only to point at artifacts; the parent should read the
  artifact directly for real content.
- Keep validator ids stable once artifacts may exist in the wild.
- Prefer one artifact per logical output unless you intentionally need
  `cardinality: "many"`.
- Use `reject` for outputs that drive downstream automation.
- Use `warn` for outputs that are still useful as partial data.
