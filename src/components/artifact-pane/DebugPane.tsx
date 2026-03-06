import { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { agentAtomFamily } from "@/agent/atoms";
import { getModelCatalogEntry } from "@/agent/modelCatalog";
import { getAllSubagents } from "@/agent/subagents";
import { useTabs } from "@/contexts/TabsContext";
import type { ApiMessage } from "@/agent/types";
import { cn } from "@/utils/cn";
import pkg from "../../../package.json";

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
    () => estimateContextWindowPct(state.apiMessages, state.config.contextLength),
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

    const debugBundle = {
      kind: "rakh_debug_bundle",
      version: 1,
      generatedAt: new Date().toISOString(),
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
        streamingContent: state.streamingContent,
        error: state.error,
        errorDetails: state.errorDetails,
        modelCatalogEntry: modelEntry,
        estimatedContextWindowPct: contextUsagePct,
        plan: state.plan,
        todos: state.todos,
        reviewEdits: state.reviewEdits,
        chatMessages: state.chatMessages,
        apiMessages: state.apiMessages,
      },
    };

    const copied = await copyToClipboard(safeJsonStringify(debugBundle));
    setCopyStatus(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyStatus("idle"), 1400);
  };

  return (
    <div className="artifact-tab-content">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="plan-section-label m-0">DEBUG</div>
        <div className="flex items-center gap-2">
          {copyStatus !== "idle" && (
            <span
              className={cn(
                "text-xxs",
                copyStatus === "copied"
                  ? "text-success"
                  : copyStatus === "failed"
                    ? "text-error"
                    : "text-muted",
              )}
            >
              {copyStatus === "copying"
                ? "Copying…"
                : copyStatus === "copied"
                  ? "Copied"
                  : "Copy failed"}
            </span>
          )}
          <button
            className="msg-btn msg-btn--deny"
            onClick={handleCopy}
            disabled={copyStatus === "copying"}
            title="Copy full debug bundle (agent context + runtime info)"
          >
            COPY CONTEXT
          </button>
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
              {contextUsagePct != null ? ` · ~${contextUsagePct.toFixed(1)}%` : ""}
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
                  <span className="ml-2 text-muted font-normal">{agent.id}</span>
                </div>
                <div className="space-y-0.5 pl-2">
                  <div>
                    <span className="text-muted">tools</span>: {agent.tools.length} (
                    {agent.tools.join(", ")})
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
          The copied bundle includes: agent state (including apiMessages/tool
          results), model catalog entry, tab metadata, and runtime info. API
          keys are not included.
        </p>
      </div>
    </div>
  );
}
