import { readFile, statFile, writeFile } from "@/agent/tools/workspace";

export const PROJECT_SCRIPTS_CONFIG_PATH = ".rakh/scripts.json";

export interface ProjectCommandConfig {
  id?: string;
  label: string;
  command: string;
  icon?: string;
  showLabel?: boolean;
}

export interface ProjectScriptsConfig {
  setupCommand?: string;
  commands?: ProjectCommandConfig[];
  githubIntegrationEnabled?: boolean;
}

export interface ProjectScriptsConfigState {
  exists: boolean;
  config: ProjectScriptsConfig | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function normalizeProjectCommandConfig(
  value: unknown,
): ProjectCommandConfig | null {
  if (!isRecord(value)) return null;

  const label = normalizeOptionalString(value.label);
  const command = normalizeOptionalString(value.command);
  if (!label || !command) return null;

  return {
    ...(normalizeOptionalString(value.id) ? { id: normalizeOptionalString(value.id) } : {}),
    label,
    command,
    ...(normalizeOptionalString(value.icon)
      ? { icon: normalizeOptionalString(value.icon) }
      : {}),
    ...(normalizeOptionalBoolean(value.showLabel) !== undefined
      ? { showLabel: normalizeOptionalBoolean(value.showLabel) }
      : {}),
  };
}

export function normalizeProjectScriptsConfig(
  value: unknown,
): ProjectScriptsConfig | null {
  if (!isRecord(value)) return null;

  const setupCommand = normalizeOptionalString(value.setupCommand);
  const githubIntegrationEnabled = normalizeOptionalBoolean(
    value.githubIntegrationEnabled,
  );
  const commands = Array.isArray(value.commands)
    ? value.commands
        .map((command) => normalizeProjectCommandConfig(command))
        .filter((command): command is ProjectCommandConfig => command !== null)
    : [];

  return {
    ...(setupCommand ? { setupCommand } : {}),
    ...(commands.length > 0 ? { commands } : {}),
    ...(githubIntegrationEnabled === true
      ? { githubIntegrationEnabled: true }
      : {}),
  };
}

export async function loadProjectScriptsConfig(
  projectPath: string,
): Promise<ProjectScriptsConfigState> {
  const stat = await statFile(projectPath, { path: PROJECT_SCRIPTS_CONFIG_PATH });
  if (!stat.ok || !stat.data.exists) {
    return { exists: false, config: null };
  }

  const result = await readFile(projectPath, {
    path: PROJECT_SCRIPTS_CONFIG_PATH,
    maxBytes: 200_000,
  });
  if (!result.ok) {
    return { exists: true, config: null };
  }

  try {
    const parsed = JSON.parse(result.data.content) as unknown;
    return {
      exists: true,
      config: normalizeProjectScriptsConfig(parsed),
    };
  } catch {
    return { exists: true, config: null };
  }
}

export async function writeProjectScriptsConfig(
  projectPath: string,
  config: ProjectScriptsConfig,
): Promise<void> {
  const normalized = normalizeProjectScriptsConfig(config) ?? {};
  const result = await writeFile(projectPath, {
    path: PROJECT_SCRIPTS_CONFIG_PATH,
    content: `${JSON.stringify(normalized, null, 2)}\n`,
    mode: "create_or_overwrite",
    createDirs: true,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }
}
