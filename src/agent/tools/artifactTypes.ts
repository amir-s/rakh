// Keep in sync with ARTIFACT_CONTENT_FORMAT_VALUES in src-tauri/src/db.rs.
export const ARTIFACT_CONTENT_FORMAT = [
  "text",
  "markdown",
  "unified-diff",
  "json",
] as const;

export type ArtifactContentFormat = (typeof ARTIFACT_CONTENT_FORMAT)[number];
