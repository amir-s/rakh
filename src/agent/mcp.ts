import { invoke } from "@tauri-apps/api/core";
import { jsonSchema, tool as aiTool } from "ai";
import { atom } from "jotai";
import type { LogContext } from "@/logging/types";
import { TOOL_GATEWAY_INTENTION_DESCRIPTION } from "./toolGateway";

type JsonObject = Record<string, unknown>;

interface McpServerBase {
  id: string;
  name: string;
  enabled: boolean;
  timeoutMs?: number;
}

export interface McpStdioServerConfig extends McpServerBase {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpStreamableHttpServerConfig extends McpServerBase {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpStreamableHttpServerConfig;

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpDiscoveredTool {
  serverId: string;
  serverName: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  annotations?: McpToolAnnotations;
}

export interface McpServerFailure {
  serverId: string;
  serverName: string;
  error: string;
}

export interface McpPrepareRunResult {
  tools: McpDiscoveredTool[];
  failures: McpServerFailure[];
}

export interface McpToolCallResponse {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  meta?: JsonObject;
}

export interface McpSettings {
  artifactizeReturnedFiles: boolean;
}

export interface McpServerProbeResult {
  serverId: string;
  serverName: string;
  tools: McpDiscoveredTool[];
  toolCount: number;
}

export interface McpToolDisplayMetadata {
  serverId: string;
  serverName: string;
  toolName: string;
  toolTitle?: string;
}

export interface McpToolRegistration {
  syntheticName: string;
  serverId: string;
  serverName: string;
  toolName: string;
  toolTitle?: string;
  description?: string;
  inputSchema: JsonObject;
  annotations?: McpToolAnnotations;
}

export interface McpRuntimeToolRegistry {
  definitions: Record<string, McpToolDefinition>;
  toolsByName: Record<string, McpToolRegistration>;
}

export type McpToolDefinition = ReturnType<typeof aiTool>;

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  artifactizeReturnedFiles: false,
};

export const mcpServersAtom = atom<McpServerConfig[]>([]);
export const mcpSettingsAtom = atom<McpSettings>(DEFAULT_MCP_SETTINGS);

function normalizeMcpSettings(
  value: Partial<McpSettings> | null | undefined,
): McpSettings {
  return {
    artifactizeReturnedFiles: value?.artifactizeReturnedFiles === true,
  };
}

export async function loadMcpServers(): Promise<McpServerConfig[]> {
  return invoke<McpServerConfig[]>("mcp_servers_load");
}

export async function saveMcpServers(servers: McpServerConfig[]): Promise<void> {
  await invoke("mcp_servers_save", { servers });
}

export async function loadMcpSettings(): Promise<McpSettings> {
  const settings = await invoke<Partial<McpSettings>>("mcp_settings_load");
  return normalizeMcpSettings(settings);
}

export async function saveMcpSettings(settings: McpSettings): Promise<void> {
  await invoke("mcp_settings_save", {
    settings: normalizeMcpSettings(settings),
  });
}

export async function testMcpServer(
  server: McpServerConfig,
): Promise<McpServerProbeResult> {
  return invoke<McpServerProbeResult>("mcp_test_server", { server });
}

export async function prepareMcpRun(
  runId: string,
  cwd: string,
  servers: McpServerConfig[],
  logContext?: LogContext,
): Promise<McpPrepareRunResult> {
  return invoke<McpPrepareRunResult>("mcp_prepare_run", {
    runId,
    cwd,
    servers,
    ...(logContext ? { logContext } : {}),
  });
}

export async function callMcpTool(
  runId: string,
  serverId: string,
  toolName: string,
  input: Record<string, unknown>,
  logContext?: LogContext,
): Promise<McpToolCallResponse> {
  return invoke<McpToolCallResponse>("mcp_call_tool", {
    runId,
    serverId,
    toolName,
    input,
    ...(logContext ? { logContext } : {}),
  });
}

export async function shutdownMcpRun(
  runId: string,
  logContext?: LogContext,
): Promise<void> {
  await invoke("mcp_shutdown_run", {
    runId,
    ...(logContext ? { logContext } : {}),
  });
}

function slugify(value: string): string {
  const out = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return out || "tool";
}

function normalizeInputSchema(schema: unknown): JsonObject {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const normalized = schema as JsonObject;
    const properties =
      normalized.properties &&
      typeof normalized.properties === "object" &&
      !Array.isArray(normalized.properties)
        ? { ...(normalized.properties as JsonObject) }
        : {};
    if (!("intention" in properties)) {
      properties.intention = {
        type: "string",
        description: TOOL_GATEWAY_INTENTION_DESCRIPTION,
      };
    }
    return {
      ...normalized,
      type: "object",
      properties,
    };
  }
  return {
    type: "object",
    properties: {
      intention: {
        type: "string",
        description: TOOL_GATEWAY_INTENTION_DESCRIPTION,
      },
    },
    additionalProperties: true,
  };
}

export function getMcpToolDisplayLabel(
  meta: McpToolDisplayMetadata,
): string {
  return `MCP / ${meta.serverName} / ${meta.toolTitle ?? meta.toolName}`;
}

export function buildMcpRuntimeToolRegistry(
  tools: McpDiscoveredTool[],
  reservedNames: Iterable<string> = [],
): McpRuntimeToolRegistry {
  const usedNames = new Set(reservedNames);
  const definitions: Record<string, McpToolDefinition> = {};
  const toolsByName: Record<string, McpToolRegistration> = {};

  for (const tool of tools) {
    const serverKey = slugify(tool.serverName || tool.serverId);
    const toolKey = slugify(tool.name);
    const baseName = `mcp_${serverKey}_${toolKey}`;
    let syntheticName = baseName;
    let counter = 2;

    while (usedNames.has(syntheticName)) {
      syntheticName = `${baseName}_${counter}`;
      counter += 1;
    }

    usedNames.add(syntheticName);

    definitions[syntheticName] = aiTool({
      description:
        tool.description ??
        tool.title ??
        `Call the MCP tool "${tool.name}" from "${tool.serverName}".`,
      inputSchema: jsonSchema(normalizeInputSchema(tool.inputSchema)),
    });
    toolsByName[syntheticName] = {
      syntheticName,
      serverId: tool.serverId,
      serverName: tool.serverName,
      toolName: tool.name,
      toolTitle: tool.title,
      description: tool.description,
      inputSchema: normalizeInputSchema(tool.inputSchema),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    };
  }

  return { definitions, toolsByName };
}

export function extractMcpToolErrorMessage(
  result: McpToolCallResponse,
): string {
  if (typeof result.structuredContent === "string" && result.structuredContent) {
    return result.structuredContent;
  }

  for (const item of result.content) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { type?: unknown; text?: unknown };
    if (raw.type === "text" && typeof raw.text === "string" && raw.text.trim()) {
      return raw.text.trim();
    }
  }

  return "MCP tool reported an error.";
}
