import type { ApiMessage } from "./types";

export interface ContextGatewayStateSnapshot {
  tabId: string;
  runId: string;
  agentId: string;
  modelId: string;
  currentTurn: number;
  messageCount: number;
  activeTodoId?: string;
}

export interface ContextGatewayInput {
  messages: ApiMessage[];
}

export interface ContextGatewayOutput {
  messages: ApiMessage[];
}

export interface ContextGatewayConfig {
  enabled: boolean;
}

export interface ContextGatewayConfigProvider {
  getConfig(input: ContextGatewayStateSnapshot): ContextGatewayConfig;
}

export const defaultContextGatewayConfigProvider: ContextGatewayConfigProvider = {
  getConfig: () => ({ enabled: true }),
};
