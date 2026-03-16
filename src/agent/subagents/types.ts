import type { z } from "zod";
import type { ArtifactContentFormat } from "../tools/artifactTypes";

/**
 * Artifact validation issue returned to the runner or parent agent.
 */
export interface SubagentArtifactValidationIssue {
  path: string;
  message: string;
}

export type SubagentArtifactValidationStatus = "passed" | "warning" | "failed";

export interface SubagentArtifactValidation {
  artifactId: string;
  artifactType: string;
  validatorId: string;
  status: SubagentArtifactValidationStatus;
  issues?: SubagentArtifactValidationIssue[];
}

export interface SubagentArtifactValidator {
  id: string;
  schema: z.ZodTypeAny;
  validationMode: "reject" | "warn";
}

export interface SubagentArtifactSpec {
  /**
   * Stable framework-facing artifact key used by the runner and parent agent.
   */
  artifactType: string;
  /**
   * Persisted artifact kind stored in the shared artifact store.
   */
  kind: string;
  contentFormat: ArtifactContentFormat;
  required?: boolean;
  cardinality?: "one" | "many";
  validator?: SubagentArtifactValidator;
}

/**
 * How a subagent communicates its result back to the parent.
 *
 * Subagents may write durable artifacts to the shared artifact store; the
 * runner validates those artifacts and returns their manifests to the parent
 * agent. Some command-oriented subagents may instead rely on summary-only
 * output and declare an empty artifact list.
 */
export interface SubagentOutput {
  /**
   * Appended to the system prompt to describe what the final conversational
   * response should contain. This is the human summary, not the artifact body.
   */
  finalMessageInstructions: string;
  /**
   * Injected as a `note` field in the tool result returned to the parent agent.
   * Use this to tell the parent how to read and act on the resulting artifacts.
   */
  parentNote?: string;
  /**
   * Declared artifact contracts produced by this subagent, if any.
   */
  artifacts: SubagentArtifactSpec[];
}

/**
 * The DNA of a subagent — everything the runner needs to execute it.
 */
export interface SubagentDefinition {
  /** Unique key used in agent_subagent_call and the registry. */
  id: string;

  /** Human-readable display name shown in the chat header. */
  name: string;

  /** Material Symbols icon name shown next to this agent's name in chat. */
  icon: string;

  /** Accent color used for this subagent's chat bubble and name, by theme mode. */
  color: {
    dark: string;
    light: string;
  };

  /** One-line description for the debug pane and the main agent's system prompt. */
  description: string;

  /** The system prompt injected at the start of every subagent conversation. */
  systemPrompt: string;

  /**
   * Ordered list of model IDs from models.catalog.json to try when selecting
   * a model for this subagent. The runner picks the first one that is available
   * in the runtime registry; falls back to the parent tab's model.
   */
  recommendedModels: string[];

  /**
   * Allowlist of tool names the subagent may call.
   * Must be a subset of the tool names defined in tools/definitions.ts.
   */
  tools: string[];

  /**
   * When true, the main agent must obtain explicit user approval before this
   * subagent is allowed to start. Does NOT affect per-tool approvals inside
   * the subagent (those follow the same inline/auto-approve rules as the main
   * agent).
   */
  requiresApproval: boolean;

  /**
   * Whether the main agent may invoke this subagent through agent_subagent_call.
   * Defaults to true. Trigger-command-only subagents can set this to false.
   */
  callableByMainAgent?: boolean;

  /**
   * Usage ledger actor kind for this subagent's model calls.
   * Defaults to "subagent". Internal maintenance flows can use "internal".
   */
  usageActorKind?: "subagent" | "internal";

  /**
   * Optional slash-command prefix (e.g. "/plan") that routes a user message
   * directly to this subagent, bypassing the main agent.
   * The remainder of the message after the command is passed as the input.
   */
  triggerCommand?: string;

  /**
   * Optional display label for slash-command discoverability surfaces.
   * Example: triggerCommand "/plan" with triggerCommandDisplay "/plan <task>".
   */
  triggerCommandDisplay?: string;

  /**
   * Whether the slash command normally expects trailing input after selection.
   * Defaults to true when a trigger command is defined.
   */
  triggerCommandTakesArguments?: boolean;

  /**
   * Concrete situations when the main agent should invoke this subagent.
   * Rendered as bullet points under the subagent entry in the main system prompt.
   */
  whenToUse?: string[];

  /** Defines the artifact contracts and final summary behavior for this subagent. */
  output?: SubagentOutput;
}
