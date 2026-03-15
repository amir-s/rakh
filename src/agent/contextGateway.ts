import type { ApiMessage, ChatMessage } from "./types";

export interface ContextGatewayStateSnapshot {
  tabId: string;
  runId: string;
  agentId: string;
  modelId: string;
  currentTurn: number;
  messageCount: number;
  contextLength?: number;
  contextUsagePct?: number;
  estimatedTokens?: number;
  estimatedBytes?: number;
  activeTodoId?: string;
}

export interface ContextGatewayInput {
  messages: ApiMessage[];
}

export interface ContextGatewayOutput {
  messages: ApiMessage[];
  replacementApiMessages?: ApiMessage[];
  debugChatMessage?: ChatMessage;
}

export interface TodoNormalizationPolicyConfig {
  enabled: boolean;
  triggerMinContextUsagePct: number;
  replaceApiMessagesAfterCompaction: boolean;
  modelStrategy: "parent" | "override";
  overrideModelId?: string;
}

export interface ContextGatewayConfig {
  enabled: boolean;
  todoNormalization: TodoNormalizationPolicyConfig;
}

export interface ContextGatewayConfigProvider {
  getConfig(input: ContextGatewayStateSnapshot): ContextGatewayConfig;
}

export const defaultContextGatewayConfigProvider: ContextGatewayConfigProvider = {
  getConfig: () => ({
    enabled: true,
    todoNormalization: {
      enabled: true,
      triggerMinContextUsagePct: 75,
      replaceApiMessagesAfterCompaction: true,
      modelStrategy: "override",
      overrideModelId: "openai/gpt-5.2-codex",
    },
  }),
};
