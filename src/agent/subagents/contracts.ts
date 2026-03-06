import { ZodError } from "zod";
import type {
  SubagentArtifactSpec,
  SubagentArtifactValidationIssue,
  SubagentArtifactValidationStatus,
  SubagentArtifactValidator,
} from "./types";

function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) return "$";
  return path
    .map((segment) =>
      typeof segment === "number" ? `[${segment}]` : String(segment),
    )
    .join(".")
    .replace(/\.\[/g, "[");
}

export function formatArtifactValidationIssues(
  error: ZodError,
): SubagentArtifactValidationIssue[] {
  return error.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

export function getArtifactSpecValidationMode(
  spec: SubagentArtifactSpec,
): "reject" | "warn" | null {
  return spec.validator?.validationMode ?? null;
}

export function getArtifactSpecValidatorId(
  spec: SubagentArtifactSpec,
): string | undefined {
  return spec.validator?.id;
}

export function getArtifactSpecValidator(
  spec: SubagentArtifactSpec,
): SubagentArtifactValidator | undefined {
  return spec.validator;
}

export function validateArtifactContentWithValidator(
  validator: SubagentArtifactValidator,
  content: string,
): {
  status: SubagentArtifactValidationStatus;
  validatorId: string;
  issues?: SubagentArtifactValidationIssue[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const issues = [
      {
        path: "$",
        message:
          error instanceof Error ? error.message : "Invalid JSON artifact payload",
      },
    ];
    return {
      status:
        validator.validationMode === "warn" ? "warning" : "failed",
      validatorId: validator.id,
      issues,
    };
  }

  const result = validator.schema.safeParse(parsed);
  if (result.success) {
    return {
      status: "passed",
      validatorId: validator.id,
    };
  }

  const issues = formatArtifactValidationIssues(result.error);
  return {
    status: validator.validationMode === "warn" ? "warning" : "failed",
    validatorId: validator.id,
    ...(issues.length > 0 ? { issues } : {}),
  };
}
