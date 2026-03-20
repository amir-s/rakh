import { patchAgentState } from "../atoms";
import type { ChatMessage, ToolCallDisplay } from "../types";
import { msgId } from "./chatState";
import type { LogContext } from "@/logging/types";
import {
  codexSessionClose,
  codexSessionInterrupt,
  codexSessionSendTurn,
  codexSessionStart,
  listenForCodexSessionEvents,
  type CodexSessionEventEnvelope,
} from "@/codex";

const runtimeIdByTab = new Map<string, string>();
type AssistantChatMessage = ChatMessage & { role: "assistant" };

function getRuntimeId(tabId: string): string | null {
  return runtimeIdByTab.get(tabId) ?? null;
}

async function ensureRuntimeId(tabId: string): Promise<string> {
  const existing = getRuntimeId(tabId);
  if (existing) return existing;
  const started = await codexSessionStart();
  runtimeIdByTab.set(tabId, started.runtimeId);
  return started.runtimeId;
}

function clearRuntimeId(tabId: string, runtimeId?: string | null): void {
  const current = getRuntimeId(tabId);
  if (!current) return;
  if (runtimeId && current !== runtimeId) return;
  runtimeIdByTab.delete(tabId);
}

function updateAssistantMessage(
  tabId: string,
  assistantMessageId: string,
  updater: (message: AssistantChatMessage) => AssistantChatMessage,
  patchExtras?: { streamingContent?: string | null },
): void {
  patchAgentState(tabId, (prev) => {
    const chatMessages = prev.chatMessages.map((message) => {
      if (message.id !== assistantMessageId || message.role !== "assistant") {
        return message;
      }
      return updater(message as AssistantChatMessage);
    });
    return {
      ...prev,
      chatMessages,
      ...(patchExtras ? patchExtras : {}),
    };
  });
}

function upsertToolCall(
  tabId: string,
  assistantMessageId: string,
  toolCallId: string,
  buildDefault: () => ToolCallDisplay,
  updater: (toolCall: ToolCallDisplay) => ToolCallDisplay,
): void {
  updateAssistantMessage(tabId, assistantMessageId, (message) => {
    const toolCalls = message.toolCalls ?? [];
    const index = toolCalls.findIndex((toolCall) => toolCall.id === toolCallId);
    if (index >= 0) {
      const nextToolCalls = toolCalls.slice();
      nextToolCalls[index] = updater(nextToolCalls[index]);
      return { ...message, toolCalls: nextToolCalls };
    }
    return {
      ...message,
      toolCalls: [...toolCalls, updater(buildDefault())],
    };
  });
}

function buildAssistantMessage(traceId?: string): AssistantChatMessage {
  return {
    id: msgId(),
    role: "assistant" as const,
    content: "",
    timestamp: Date.now(),
    streaming: true,
    ...(traceId ? { traceId } : {}),
  };
}

function mapCommandStatus(status: unknown): ToolCallDisplay["status"] {
  if (status === "completed") return "done";
  if (status === "declined") return "denied";
  if (status === "failed") return "error";
  return "running";
}

function mapPatchStatus(status: unknown): ToolCallDisplay["status"] {
  if (status === "completed") return "done";
  if (status === "failed") return "error";
  if (status === "declined") return "denied";
  return "running";
}

function runtimeExitErrorMessage(event: Record<string, unknown>): string {
  const error =
    typeof event.error === "string" && event.error.trim().length > 0
      ? event.error
      : null;
  const exitCode =
    typeof event.exitCode === "number" ? String(event.exitCode) : null;
  if (error) return `Codex runtime exited: ${error}`;
  if (exitCode) return `Codex runtime exited with code ${exitCode}.`;
  return "Codex runtime exited unexpectedly.";
}

export async function disposeCodexRuntimeForTab(tabId: string): Promise<void> {
  const runtimeId = getRuntimeId(tabId);
  if (!runtimeId) return;
  clearRuntimeId(tabId, runtimeId);
  try {
    await codexSessionClose(runtimeId);
  } catch {
    // ignore cleanup errors
  }
}

export async function interruptCodexRuntimeForTab(tabId: string): Promise<void> {
  const runtimeId = getRuntimeId(tabId);
  if (!runtimeId) return;
  try {
    await codexSessionInterrupt(runtimeId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("runtime not found")
    ) {
      clearRuntimeId(tabId, runtimeId);
      return;
    }
    throw error;
  }
}

export async function runCodexTurn(options: {
  tabId: string;
  cwd: string;
  prompt: string;
  profilePrompt: string;
  signal: AbortSignal;
  logContext: LogContext;
  sessionId: string | null;
}): Promise<string | null> {
  const { tabId, cwd, prompt, profilePrompt, signal, logContext, sessionId } =
    options;
  const runtimeId = await ensureRuntimeId(tabId);
  const assistantMessage = buildAssistantMessage(logContext.traceId);
  let completedSessionId: string | null = sessionId;

  patchAgentState(tabId, (prev) => ({
    ...prev,
    chatMessages: [...prev.chatMessages, assistantMessage],
    streamingContent: "",
  }));

  let unlisten: (() => void) | null = null;
  let cleanedUp = false;
  let handleEvent: ((payload: CodexSessionEventEnvelope) => void) | null = null;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    unlisten?.();
    signal.removeEventListener("abort", onAbort);
  };

  const onAbort = () => {
    void interruptCodexRuntimeForTab(tabId).catch(() => {
      // ignore secondary interrupt failures; the outer run will settle on runtime exit or completion
    });
  };

  signal.addEventListener("abort", onAbort, { once: true });

  const completion = new Promise<string | null>((resolve, reject) => {
    const onEvent = (payload: CodexSessionEventEnvelope) => {
      if (payload.runtimeId !== runtimeId) return;
      const event = payload.event;
      const method = typeof event.method === "string" ? event.method : null;
      const params =
        event.params && typeof event.params === "object"
          ? (event.params as Record<string, unknown>)
          : null;

      if (typeof event.type === "string" && event.type === "runtime_exit") {
        cleanup();
        clearRuntimeId(tabId, runtimeId);
        reject(new Error(runtimeExitErrorMessage(event)));
        return;
      }

      if (typeof event.type === "string" && event.type === "runtime_parse_error") {
        cleanup();
        clearRuntimeId(tabId, runtimeId);
        reject(
          new Error(
            typeof event.message === "string" && event.message.trim().length > 0
              ? `Codex protocol error: ${event.message}`
              : "Codex protocol error.",
          ),
        );
        return;
      }

      if (!method || !params) return;

      if (method === "thread/started") {
        const nextSessionId =
          params.thread &&
          typeof params.thread === "object" &&
          typeof (params.thread as Record<string, unknown>).id === "string"
            ? ((params.thread as Record<string, unknown>).id as string)
            : null;
        if (nextSessionId) {
          completedSessionId = nextSessionId;
        }
        return;
      }

      if (method === "item/agentMessage/delta") {
        const delta = typeof params.delta === "string" ? params.delta : "";
        updateAssistantMessage(
          tabId,
          assistantMessage.id,
          (message) => ({ ...message, content: `${message.content}${delta}` }),
        );
        patchAgentState(tabId, (prev) => ({
          ...prev,
          streamingContent: `${prev.streamingContent ?? ""}${delta}`,
        }));
        return;
      }

      if (method === "item/reasoning/summaryTextDelta") {
        const delta = typeof params.delta === "string" ? params.delta : "";
        updateAssistantMessage(tabId, assistantMessage.id, (message) => ({
          ...message,
          reasoning: `${message.reasoning ?? ""}${delta}`,
          reasoningStreaming: true,
          reasoningStartedAtMs:
            message.reasoningStartedAtMs ?? Date.now(),
        }));
        return;
      }

      if (method === "item/reasoning/textDelta") {
        const delta = typeof params.delta === "string" ? params.delta : "";
        updateAssistantMessage(tabId, assistantMessage.id, (message) => ({
          ...message,
          reasoning: `${message.reasoning ?? ""}${delta}`,
          reasoningStreaming: true,
          reasoningStartedAtMs:
            message.reasoningStartedAtMs ?? Date.now(),
        }));
        return;
      }

      if (method === "item/commandExecution/outputDelta") {
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        if (!itemId) return;
        const delta = typeof params.delta === "string" ? params.delta : "";
        upsertToolCall(
          tabId,
          assistantMessage.id,
          itemId,
          () => ({
            id: itemId,
            tool: "codex_commandExecution",
            args: {},
            status: "running",
            streamingOutput: "",
          }),
          (toolCall) => ({
            ...toolCall,
            streamingOutput: `${toolCall.streamingOutput ?? ""}${delta}`,
            status: "running",
          }),
        );
        return;
      }

      if (method === "item/fileChange/outputDelta") {
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        if (!itemId) return;
        const delta = typeof params.delta === "string" ? params.delta : "";
        upsertToolCall(
          tabId,
          assistantMessage.id,
          itemId,
          () => ({
            id: itemId,
            tool: "codex_fileChange",
            args: {},
            status: "running",
            streamingOutput: "",
          }),
          (toolCall) => ({
            ...toolCall,
            streamingOutput: `${toolCall.streamingOutput ?? ""}${delta}`,
            status: "running",
          }),
        );
        return;
      }

      if (method === "item/started") {
        const item =
          params.item && typeof params.item === "object"
            ? (params.item as Record<string, unknown>)
            : null;
        if (!item) return;
        const itemType = typeof item.type === "string" ? item.type : null;
        const itemId = typeof item.id === "string" ? item.id : null;
        if (!itemType || !itemId) return;

        if (itemType === "commandExecution") {
          upsertToolCall(
            tabId,
            assistantMessage.id,
            itemId,
            () => ({
              id: itemId,
              tool: "codex_commandExecution",
              args: {
                command: item.command,
                cwd: item.cwd,
                commandActions: item.commandActions,
              },
              status: "running",
              streamingOutput: "",
            }),
            (toolCall) => ({
              ...toolCall,
              args: {
                command: item.command,
                cwd: item.cwd,
                commandActions: item.commandActions,
              },
              status: "running",
            }),
          );
          return;
        }

        if (itemType === "fileChange") {
          upsertToolCall(
            tabId,
            assistantMessage.id,
            itemId,
            () => ({
              id: itemId,
              tool: "codex_fileChange",
              args: {
                changes: item.changes,
              },
              status: "running",
            }),
            (toolCall) => ({
              ...toolCall,
              args: {
                changes: item.changes,
              },
              status: "running",
            }),
          );
          return;
        }

        if (itemType === "mcpToolCall") {
          upsertToolCall(
            tabId,
            assistantMessage.id,
            itemId,
            () => ({
              id: itemId,
              tool: "codex_mcpToolCall",
              args:
                item.arguments && typeof item.arguments === "object"
                  ? (item.arguments as Record<string, unknown>)
                  : {},
              status: "running",
              mcp: {
                serverId:
                  typeof item.server === "string" ? item.server : "codex",
                serverName:
                  typeof item.server === "string" ? item.server : "Codex MCP",
                toolName: typeof item.tool === "string" ? item.tool : "tool",
              },
            }),
            (toolCall) => ({
              ...toolCall,
              args:
                item.arguments && typeof item.arguments === "object"
                  ? (item.arguments as Record<string, unknown>)
                  : toolCall.args,
              status: "running",
            }),
          );
        }
        return;
      }

      if (method === "item/completed") {
        const item =
          params.item && typeof params.item === "object"
            ? (params.item as Record<string, unknown>)
            : null;
        if (!item) return;
        const itemType = typeof item.type === "string" ? item.type : null;
        const itemId = typeof item.id === "string" ? item.id : null;
        if (!itemType || !itemId) return;

        if (itemType === "agentMessage") {
          const text = typeof item.text === "string" ? item.text : "";
          updateAssistantMessage(
            tabId,
            assistantMessage.id,
            (message) => ({
              ...message,
              content: text,
              streaming: false,
            }),
            { streamingContent: text },
          );
          return;
        }

        if (itemType === "reasoning") {
          updateAssistantMessage(tabId, assistantMessage.id, (message) => ({
            ...message,
            reasoningStreaming: false,
            reasoningDurationMs:
              typeof message.reasoningStartedAtMs === "number"
                ? Math.max(0, Date.now() - message.reasoningStartedAtMs)
                : message.reasoningDurationMs,
          }));
          return;
        }

        if (itemType === "commandExecution") {
          upsertToolCall(
            tabId,
            assistantMessage.id,
            itemId,
            () => ({
              id: itemId,
              tool: "codex_commandExecution",
              args: {
                command: item.command,
                cwd: item.cwd,
                commandActions: item.commandActions,
              },
              status: mapCommandStatus(item.status),
            }),
            (toolCall) => ({
              ...toolCall,
              args: {
                command: item.command,
                cwd: item.cwd,
                commandActions: item.commandActions,
              },
              status: mapCommandStatus(item.status),
              streamingOutput:
                typeof item.aggregatedOutput === "string"
                  ? item.aggregatedOutput
                  : toolCall.streamingOutput,
              result: {
                aggregatedOutput: item.aggregatedOutput,
                exitCode: item.exitCode,
                durationMs: item.durationMs,
                status: item.status,
              },
            }),
          );
          return;
        }

        if (itemType === "fileChange") {
          upsertToolCall(
            tabId,
            assistantMessage.id,
            itemId,
            () => ({
              id: itemId,
              tool: "codex_fileChange",
              args: {
                changes: item.changes,
              },
              status: mapPatchStatus(item.status),
            }),
            (toolCall) => ({
              ...toolCall,
              args: {
                changes: item.changes,
              },
              status: mapPatchStatus(item.status),
              result: {
                changes: item.changes,
                status: item.status,
              },
            }),
          );
          return;
        }

        if (itemType === "mcpToolCall") {
          upsertToolCall(
            tabId,
            assistantMessage.id,
            itemId,
            () => ({
              id: itemId,
              tool: "codex_mcpToolCall",
              args:
                item.arguments && typeof item.arguments === "object"
                  ? (item.arguments as Record<string, unknown>)
                  : {},
              status:
                item.status === "completed"
                  ? "done"
                  : item.status === "failed"
                    ? "error"
                    : "running",
              mcp: {
                serverId:
                  typeof item.server === "string" ? item.server : "codex",
                serverName:
                  typeof item.server === "string" ? item.server : "Codex MCP",
                toolName: typeof item.tool === "string" ? item.tool : "tool",
              },
            }),
            (toolCall) => ({
              ...toolCall,
              status:
                item.status === "completed"
                  ? "done"
                  : item.status === "failed"
                    ? "error"
                    : "running",
              result: {
                result: item.result,
                error: item.error,
                durationMs: item.durationMs,
                status: item.status,
              },
            }),
          );
        }
        return;
      }

      if (method === "turn/completed") {
        cleanup();
        updateAssistantMessage(tabId, assistantMessage.id, (message) => ({
          ...message,
          streaming: false,
          reasoningStreaming: false,
          reasoningDurationMs:
            typeof message.reasoningStartedAtMs === "number"
              ? Math.max(0, Date.now() - message.reasoningStartedAtMs)
              : message.reasoningDurationMs,
        }));
        patchAgentState(tabId, { streamingContent: null });
        const turn =
          params.turn && typeof params.turn === "object"
            ? (params.turn as Record<string, unknown>)
            : null;
        if (turn?.status === "errored" || turn?.status === "failed") {
          const error =
            turn.error && typeof turn.error === "object"
              ? (turn.error as Record<string, unknown>)
              : null;
          const message =
            (error && typeof error.message === "string" && error.message) ||
            "Codex turn failed.";
          reject(new Error(message));
          return;
        }
        if (turn?.status === "interrupted") {
          reject(
            signal.aborted
              ? new DOMException("Aborted", "AbortError")
              : new Error("Codex turn was interrupted."),
          );
          return;
        }
        resolve(completedSessionId);
      }
    };
    handleEvent = onEvent;
  });

  if (signal.aborted) {
    cleanup();
    throw new DOMException("Aborted", "AbortError");
  }

  unlisten = await listenForCodexSessionEvents((payload) => {
    handleEvent?.(payload);
  });

  try {
    const result = await codexSessionSendTurn({
      runtimeId,
      cwd,
      prompt,
      profilePrompt,
      threadId: sessionId,
    });
    if (result.threadId) {
      completedSessionId = result.threadId;
      patchAgentState(tabId, {
        backendSessionState: {
          kind: "codex",
          sessionId: result.threadId,
          sessionDisplayId: result.threadId,
        },
      });
    }
  } catch (error) {
    cleanup();
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("runtime not found")
    ) {
      clearRuntimeId(tabId, runtimeId);
    }
    throw error;
  }

  return completion.finally(() => {
    cleanup();
  });
}
