import { useMemo, useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { agentAtomFamily } from "@/agent/atoms";
import { getModelCatalogEntry } from "@/agent/modelCatalog";
import { getAllSubagents } from "@/agent/subagents";
import CycleOptionSwitch from "@/components/CycleOptionSwitch";
import { Button } from "@/components/ui";
import { useTabs } from "@/contexts/TabsContext";
import type { ApiMessage, AttachedImage, ChatMessage } from "@/agent/types";
import { cn } from "@/utils/cn";
import pkg from "../../../package.json";

const IMAGE_DATA_URL_RE =
  /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)/g;

const INLINE_IMAGE_DATA_MAX_CHARS = 256;
const LONG_MESSAGE_MAX_CHARS = 6000;
const LONG_MESSAGE_HEAD_CHARS = 2500;
const LONG_MESSAGE_TAIL_CHARS = 1200;

function estimateContextWindowPct(
  apiMessages: ApiMessage[],
  contextLength?: number,
): number | null {
  if (!apiMessages.length || !contextLength) return null;

  const totalChars = apiMessages.reduce((sum, message) => {
    if (
      message.role === "system" ||
      message.role === "user" ||
      message.role === "tool"
    ) {
      return sum + (message.content?.length ?? 0);
    }
    if (message.role === "assistant") {
      const textLength = message.content?.length ?? 0;
      const toolCallLength = message.tool_calls
        ? message.tool_calls.reduce(
            (acc, toolCall) =>
              acc +
              toolCall.function.name.length +
              (typeof toolCall.function.arguments === "string"
                ? toolCall.function.arguments.length
                : 0),
            0,
          )
        : 0;
      return sum + textLength + toolCallLength;
    }
    return sum;
  }, 0);

  const estimatedTokens = Math.ceil(totalChars / 4);
  return Math.min(100, (estimatedTokens / contextLength) * 100);
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const replacer = (_key: string, current: unknown) => {
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "function") {
      return `[Function${current.name ? `: ${current.name}` : ""}]`;
    }
    if (current instanceof Error) {
      const anyError = current as Error & Record<string, unknown>;
      return {
        name: current.name,
        message: current.message,
        stack: current.stack,
        ...Object.fromEntries(Object.entries(anyError)),
      };
    }
    if (current && typeof current === "object") {
      if (seen.has(current as object)) return "[Circular]";
      seen.add(current as object);

      if (current instanceof Map) {
        return {
          __type: "Map",
          entries: Array.from(current.entries()),
        };
      }
      if (current instanceof Set) {
        return {
          __type: "Set",
          values: Array.from(current.values()),
        };
      }
    }
    return current;
  };

  try {
    return JSON.stringify(value, replacer, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function shrinkDebugMessageText(value: string): string {
  const withShrunkImages = value.replace(
    IMAGE_DATA_URL_RE,
    (match, mimeType: string, base64Data: string) => {
      const normalizedData = base64Data.replace(/\s+/g, "");
      if (normalizedData.length <= INLINE_IMAGE_DATA_MAX_CHARS) {
        return match;
      }
      return `data:${mimeType};base64,[truncated ${normalizedData.length} chars for debug copy]`;
    },
  );

  if (withShrunkImages.length <= LONG_MESSAGE_MAX_CHARS) {
    return withShrunkImages;
  }

  const omittedChars =
    withShrunkImages.length - LONG_MESSAGE_HEAD_CHARS - LONG_MESSAGE_TAIL_CHARS;
  if (omittedChars <= 0) return withShrunkImages;

  return [
    withShrunkImages.slice(0, LONG_MESSAGE_HEAD_CHARS),
    `\n\n[... truncated ${omittedChars} chars for debug copy; original length ${withShrunkImages.length} chars ...]\n\n`,
    withShrunkImages.slice(-LONG_MESSAGE_TAIL_CHARS),
  ].join("");
}

function redactAttachedImages(attachments: AttachedImage[]): AttachedImage[] {
  return attachments.map((img) => ({
    ...img,
    previewUrl: `[redacted ${img.mimeType}, ${img.previewUrl.length} chars]`,
  }));
}

function shrinkApiMessages(messages: ApiMessage[]): ApiMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return {
          ...message,
          content: shrinkDebugMessageText(message.content),
        };
      case "user":
        return {
          ...message,
          content: shrinkDebugMessageText(message.content),
          ...(message.attachments
            ? { attachments: redactAttachedImages(message.attachments) }
            : {}),
        };
      case "assistant":
        return {
          ...message,
          content:
            typeof message.content === "string"
              ? shrinkDebugMessageText(message.content)
              : message.content,
        };
      case "tool":
        return message;
    }
  });
}

function shrinkChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: shrinkDebugMessageText(message.content),
    reasoning:
      typeof message.reasoning === "string"
        ? shrinkDebugMessageText(message.reasoning)
        : message.reasoning,
    ...(message.attachments
      ? { attachments: redactAttachedImages(message.attachments) }
      : {}),
  }));
}

function InfoPopover({ children }: { children: ReactNode }) {
  return (
    <span className="chat-ctrl-info">
      <span className="material-symbols-outlined chat-ctrl-info-icon text-sm">
        info
      </span>
      <span className="chat-ctrl-popover">{children}</span>
    </span>
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const element = document.createElement("textarea");
    element.value = text;
    element.setAttribute("readonly", "");
    element.style.position = "fixed";
    element.style.left = "-9999px";
    element.style.top = "0";
    document.body.appendChild(element);
    element.focus();
    element.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(element);
    return ok;
  } catch {
    return false;
  }
}

export default function DebugPane({ tabId }: { tabId: string }) {
  const { tabs, activeTabId } = useTabs();
  const state = useAtomValue(agentAtomFamily(tabId));
  const [shrinkLongMessages, setShrinkLongMessages] = useState(true);
  const [copyStatus, setCopyStatus] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");

  const tabMeta = useMemo(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    return {
      activeTabId,
      activeTab: activeTab ?? null,
      tabs,
    };
  }, [activeTabId, tabs]);

  const modelEntry = useMemo(
    () => getModelCatalogEntry(state.config.model),
    [state.config.model],
  );

  const contextUsagePct = useMemo(
    () =>
      estimateContextWindowPct(state.apiMessages, state.config.contextLength),
    [state.apiMessages, state.config.contextLength],
  );

  const handleCopy = async () => {
    setCopyStatus("copying");

    const isTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

    const openAiKeyLength = (() => {
      try {
        return (localStorage.getItem("rakh.openai-api-key") ?? "").length;
      } catch {
        return 0;
      }
    })();

    const anthropicKeyLength = (() => {
      try {
        return (localStorage.getItem("rakh.anthropic-api-key") ?? "").length;
      } catch {
        return 0;
      }
    })();

    const copiedChatMessages = shrinkLongMessages
      ? shrinkChatMessages(state.chatMessages)
      : state.chatMessages;
    const copiedApiMessages = shrinkLongMessages
      ? shrinkApiMessages(state.apiMessages)
      : state.apiMessages;
    const copiedStreamingContent =
      shrinkLongMessages && typeof state.streamingContent === "string"
        ? shrinkDebugMessageText(state.streamingContent)
        : state.streamingContent;

    const debugBundle = {
      kind: "rakh_debug_bundle",
      version: 2,
      generatedAt: new Date().toISOString(),
      copyOptions: {
        shrinkLongMessages,
      },
      app: {
        name: pkg.name,
        version: pkg.version,
        mode: import.meta.env.MODE,
        dev: import.meta.env.DEV,
      },
      runtime: {
        isTauri,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        language: typeof navigator !== "undefined" ? navigator.language : "",
        location:
          typeof window !== "undefined" ? window.location.href : "unknown",
      },
      secrets: {
        openaiApiKeyPresent: openAiKeyLength > 0,
        openaiApiKeyLength: openAiKeyLength,
        anthropicApiKeyPresent: anthropicKeyLength > 0,
        anthropicApiKeyLength: anthropicKeyLength,
      },
      tabs: tabMeta,
      agent: {
        tabId,
        status: state.status,
        tabTitle: state.tabTitle,
        config: state.config,
        autoApproveEdits: state.autoApproveEdits,
        autoApproveCommands: state.autoApproveCommands,
        streamingContent: copiedStreamingContent,
        error: state.error,
        errorDetails: state.errorDetails,
        modelCatalogEntry: modelEntry,
        estimatedContextWindowPct: contextUsagePct,
        plan: state.plan,
        todos: state.todos,
        reviewEdits: state.reviewEdits,
        chatMessages: copiedChatMessages,
        apiMessages: copiedApiMessages,
      },
    };

    const copied = await copyToClipboard(safeJsonStringify(debugBundle));
    setCopyStatus(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyStatus("idle"), 1400);
  };

  return (
    <div className="artifact-tab-content">
      <div className="debug-pane-header">
        <div className="plan-section-label debug-pane-label">DEBUG</div>

        <div className="debug-pane-controls">
          <div className="debug-pane-switch-row">
            <CycleOptionSwitch
              label="Shrink long messages"
              value={shrinkLongMessages}
              options={[
                { value: false, label: "No" },
                { value: true, label: "Yes" },
              ]}
              onChange={setShrinkLongMessages}
            />
            <InfoPopover>
              Shortens long chat text and inline image data in copied debug
              bundles.
            </InfoPopover>
          </div>

          {copyStatus !== "idle" ? (
            <span
              className={cn(
                "debug-pane-copy-feedback",
                copyStatus === "copied"
                  ? "debug-pane-copy-feedback--success"
                  : copyStatus === "failed"
                    ? "debug-pane-copy-feedback--error"
                    : "debug-pane-copy-feedback--active",
              )}
            >
              {copyStatus === "copying"
                ? "Copying…"
                : copyStatus === "copied"
                  ? "Copied"
                  : "Copy failed"}
            </span>
          ) : null}

          <Button
            variant="ghost"
            size="xs"
            onClick={() => void handleCopy()}
            disabled={copyStatus === "copying"}
            title={
              shrinkLongMessages
                ? "Copy debug bundle with long message text shrunk"
                : "Copy full debug bundle (agent context + runtime info)"
            }
            leftIcon={
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[14px] leading-none"
              >
                content_copy
              </span>
            }
          >
            COPY CONTEXT
          </Button>
        </div>
      </div>

      <div className="text-xs leading-[1.7] text-[color-mix(in_srgb,var(--color-text)_82%,transparent)] space-y-4">
        <div className="rounded-lg border border-border-subtle bg-surface p-3">
          <div className="text-xxs font-bold tracking-[0.06em] uppercase text-muted mb-2">
            Agent
          </div>
          <div className="space-y-1 font-mono text-[11px] break-all">
            <div>
              <span className="text-muted">status</span>: {state.status}
            </div>
            <div>
              <span className="text-muted">model</span>: {state.config.model}
            </div>
            <div>
              <span className="text-muted">sdk_id</span>:{" "}
              {modelEntry?.sdk_id || "(missing)"}
            </div>
            <div>
              <span className="text-muted">cwd</span>:{" "}
              {state.config.cwd || "(empty)"}
            </div>
            <div>
              <span className="text-muted">worktree</span>:{" "}
              {state.config.worktreePath ?? "(none)"}
              {state.config.worktreeBranch
                ? ` @ ${state.config.worktreeBranch}`
                : ""}
            </div>
            <div>
              <span className="text-muted">auto-approve</span>: edits=
              {String(state.autoApproveEdits)} commandsMode=
              {state.autoApproveCommands}
            </div>
            <div>
              <span className="text-muted">advanced</span>:{" "}
              {state.config.advancedOptions
                ? `vis=${state.config.advancedOptions.reasoningVisibility} effort=${state.config.advancedOptions.reasoningEffort} profile=${state.config.advancedOptions.latencyCostProfile}`
                : "(default)"}
            </div>
            <div>
              <span className="text-muted">messages</span>: chat=
              {state.chatMessages.length} api={state.apiMessages.length}
            </div>
            <div>
              <span className="text-muted">context</span>: config=
              {state.config.contextLength ?? "(unknown)"}
              {contextUsagePct != null
                ? ` · ~${contextUsagePct.toFixed(1)}%`
                : ""}
            </div>
            {state.error && (
              <div>
                <span className="text-muted">error</span>:{" "}
                <span className="text-error">{state.error}</span>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-surface p-3">
          <div className="text-xxs font-bold tracking-[0.06em] uppercase text-muted mb-2">
            Artifacts
          </div>
          <div className="space-y-1 font-mono text-[11px] break-all">
            <div>
              <span className="text-muted">plan</span>: v{state.plan.version} ·{" "}
              {state.plan.markdown ? "has markdown" : "(empty)"}
            </div>
            <div>
              <span className="text-muted">todos</span>: {state.todos.length}
            </div>
            <div>
              <span className="text-muted">reviewEdits</span>:{" "}
              {state.reviewEdits.length}
              {state.reviewEdits.length > 0
                ? ` · ${state.reviewEdits.map((edit) => edit.filePath).join(", ")}`
                : ""}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-surface p-3">
          <div className="text-xxs font-bold tracking-[0.06em] uppercase text-muted mb-2">
            Loaded Agents
          </div>
          <div className="space-y-2 font-mono text-[11px] break-all">
            {getAllSubagents().map((agent) => (
              <div key={agent.id} className="space-y-0.5">
                <div className="font-semibold text-[color-mix(in_srgb,var(--color-text)_90%,transparent)] inline-flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[13px] leading-none">
                    {agent.icon}
                  </span>
                  {agent.name}
                  <span className="ml-2 text-muted font-normal">
                    {agent.id}
                  </span>
                </div>
                <div className="space-y-0.5 pl-2">
                  <div>
                    <span className="text-muted">tools</span>:{" "}
                    {agent.tools.length} ({agent.tools.join(", ")})
                  </div>
                  <div>
                    <span className="text-muted">approval</span>:{" "}
                    {String(agent.requiresApproval)}
                  </div>
                  {agent.triggerCommand && (
                    <div>
                      <span className="text-muted">trigger</span>:{" "}
                      {agent.triggerCommand}
                    </div>
                  )}
                  <div className="text-muted italic">{agent.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-surface p-3">
          <div className="text-xxs font-bold tracking-[0.06em] uppercase text-muted mb-2">
            Runtime
          </div>
          <div className="space-y-1 font-mono text-[11px] break-all">
            <div>
              <span className="text-muted">app</span>: {pkg.name}@{pkg.version}
            </div>
            <div>
              <span className="text-muted">mode</span>: {import.meta.env.MODE}
            </div>
            <div>
              <span className="text-muted">tauri</span>:{" "}
              {typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
                ? "yes"
                : "no"}
            </div>
          </div>
        </div>

        <p className="text-muted text-xxs">
          The copied bundle includes agent state, apiMessages, tool results,
          model catalog data, tab metadata, and runtime info. When enabled, long
          chat/api message text and embedded base64 image data are abbreviated,
          but tool call payloads and results are always copied in full. API keys
          are not included.
        </p>
      </div>
    </div>
  );
}
