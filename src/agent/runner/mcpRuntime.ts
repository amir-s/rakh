import { jotaiStore } from "../atoms";
import { TOOL_DEFINITIONS } from "../tools";
import {
  buildMcpRuntimeToolRegistry,
  mcpServersAtom,
  prepareMcpRun,
  type McpToolDefinition,
  type McpToolRegistration,
} from "../mcp";
import type { LogContext } from "@/logging/types";

import { appendChatMessage, msgId } from "./chatState";

export interface MainAgentMcpRuntime {
  toolDefinitions: Record<string, McpToolDefinition>;
  toolsByName: Record<string, McpToolRegistration>;
}

function buildMcpWarningMessage(
  failures: Array<{ serverName: string; error: string }>,
): string {
  const prefix =
    failures.length === 1
      ? "One MCP server could not be loaded for this run:"
      : `${failures.length} MCP servers could not be loaded for this run:`;
  const details = failures
    .map((failure) => `- ${failure.serverName}: ${failure.error}`)
    .join("\n");
  return `${prefix}\n${details}`;
}

export async function prepareMainAgentMcpRuntime(
  tabId: string,
  runId: string,
  cwd: string,
  logContext?: LogContext,
): Promise<MainAgentMcpRuntime> {
  const configuredServers = jotaiStore.get(mcpServersAtom);
  if (!configuredServers.some((server) => server.enabled)) {
    return { toolDefinitions: {}, toolsByName: {} };
  }

  try {
    const prepared = await prepareMcpRun(runId, cwd, configuredServers, logContext);
    if (prepared.failures.length > 0) {
      appendChatMessage(tabId, {
        id: msgId(),
        role: "assistant",
        content: buildMcpWarningMessage(prepared.failures),
        timestamp: Date.now(),
        badge: "MCP WARNING",
      });
    }

    const registry = buildMcpRuntimeToolRegistry(
      prepared.tools,
      Object.keys(TOOL_DEFINITIONS),
    );
    return {
      toolDefinitions: registry.definitions,
      toolsByName: registry.toolsByName,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendChatMessage(tabId, {
      id: msgId(),
      role: "assistant",
      content: `MCP discovery failed for this run.\n- ${message}`,
      timestamp: Date.now(),
      badge: "MCP WARNING",
    });
    return { toolDefinitions: {}, toolsByName: {} };
  }
}
