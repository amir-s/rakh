import { plannerSubagent } from "./planner";
import { copywriterSubagent } from "./copywriter";
import { reviewerSubagent } from "./reviewer";
import { securitySubagent } from "./security";
import { githubSubagent } from "./github";
import type {
  SubagentArtifactSpec,
  SubagentDefinition,
  SubagentArtifactValidator,
} from "./types";

export type { SubagentDefinition };
export type ThemeMode = "dark" | "light";

/* ─────────────────────────────────────────────────────────────────────────────
   Registry — add new subagents here
───────────────────────────────────────────────────────────────────────────── */

const SUBAGENT_REGISTRY: SubagentDefinition[] = [
  plannerSubagent,
  copywriterSubagent,
  reviewerSubagent,
  securitySubagent,
  githubSubagent,
];

/** Look up a subagent by its unique ID. Returns undefined if not found. */
export function getSubagent(id: string): SubagentDefinition | undefined {
  return SUBAGENT_REGISTRY.find((s) => s.id === id);
}

/** Return all registered subagents (shallow copy). */
export function getAllSubagents(): SubagentDefinition[] {
  return [...SUBAGENT_REGISTRY];
}

export function getSubagentArtifactSpecs(
  subagent: SubagentDefinition,
): SubagentArtifactSpec[] {
  return subagent.output?.artifacts ?? [];
}

export function getSubagentArtifactSpec(
  subagent: SubagentDefinition,
  artifactType: string,
): SubagentArtifactSpec | undefined {
  return getSubagentArtifactSpecs(subagent).find(
    (artifact) => artifact.artifactType === artifactType,
  );
}

export function getSubagentArtifactValidatorById(
  validatorId: string,
): { subagent: SubagentDefinition; artifact: SubagentArtifactSpec; validator: SubagentArtifactValidator } | undefined {
  for (const subagent of SUBAGENT_REGISTRY) {
    for (const artifact of getSubagentArtifactSpecs(subagent)) {
      if (artifact.validator?.id === validatorId) {
        return {
          subagent,
          artifact,
          validator: artifact.validator,
        };
      }
    }
  }
  return undefined;
}

/** CSS variable name used for a subagent's accent color. */
export function getSubagentThemeColorVariable(subagentId: string): string {
  return `--color-subagent-${subagentId}`;
}

/** CSS var() token for consuming a subagent accent color in styles/inline styles. */
export function getSubagentThemeColorToken(subagentId: string): string {
  return `var(${getSubagentThemeColorVariable(subagentId)}, var(--color-primary))`;
}

/** Resolve the concrete accent color for a subagent in the given theme mode. */
export function resolveSubagentThemeColor(
  subagent: SubagentDefinition,
  mode: ThemeMode,
): string {
  return subagent.color[mode];
}

/**
 * Build the CSS custom property map for all registered subagents in a mode.
 * The theme layer applies this map to :root / documentElement.
 */
export function getSubagentThemeColorMap(mode: ThemeMode): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const subagent of SUBAGENT_REGISTRY) {
    vars[getSubagentThemeColorVariable(subagent.id)] =
      resolveSubagentThemeColor(subagent, mode);
  }
  return vars;
}

/**
 * Check whether a user message starts with a registered trigger command.
 * Returns the matching subagent and the remainder of the message (the part
 * after the trigger command), or null if no trigger matches.
 *
 * Example: "/plan refactor the auth module"
 *   → { subagent: plannerSubagent, subMessage: "refactor the auth module" }
 */
export function findSubagentByTrigger(
  message: string,
): { subagent: SubagentDefinition; subMessage: string } | null {
  const trimmed = message.trim();
  for (const subagent of SUBAGENT_REGISTRY) {
    if (!subagent.triggerCommand) continue;
    const trigger = subagent.triggerCommand.trim();
    if (trimmed === trigger || trimmed.startsWith(trigger + " ")) {
      const subMessage = trimmed.slice(trigger.length).trim();
      return { subagent, subMessage };
    }
  }
  return null;
}
