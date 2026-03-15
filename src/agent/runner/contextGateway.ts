import type { ApiMessage } from "../types";
import {
  defaultContextGatewayConfigProvider,
  type ContextGatewayConfigProvider,
  type ContextGatewayOutput,
  type ContextGatewayStateSnapshot,
} from "../contextGateway";

export interface ExecuteThroughContextGatewayOptions {
  messages: ApiMessage[];
  stateSnapshot: ContextGatewayStateSnapshot;
  configProvider?: ContextGatewayConfigProvider;
}

export async function executeThroughContextGateway(
  options: ExecuteThroughContextGatewayOptions,
): Promise<ContextGatewayOutput> {
  const configProvider =
    options.configProvider ?? defaultContextGatewayConfigProvider;
  const config = configProvider.getConfig(options.stateSnapshot);
  if (!config.enabled) {
    return { messages: options.messages };
  }
  return { messages: options.messages };
}
