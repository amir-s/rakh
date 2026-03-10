import { useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import {
  agentAtomFamily,
  jotaiStore,
  notifyOnAttentionAtom,
} from "@/agent/atoms";
import type { AgentStatus, ToolCallDisplay } from "@/agent/types";
import { useTabs } from "@/contexts/TabsContext";
import {
  focusTab,
  setAppBadgeCount,
  showNotification,
} from "@/notifications";

function getAttentionToolCalls(tabId: string): ToolCallDisplay[] {
  const state = jotaiStore.get(agentAtomFamily(tabId));
  return state.chatMessages
    .flatMap((message) => message.toolCalls ?? [])
    .filter(
      (toolCall) =>
        toolCall.status === "awaiting_approval" ||
        toolCall.status === "awaiting_worktree" ||
        toolCall.status === "awaiting_setup_action",
    );
}

function documentHasFocus(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

function isBusyStatus(status: AgentStatus): boolean {
  return status === "thinking" || status === "working";
}

function isSettledStatus(status: AgentStatus): boolean {
  return status === "idle" || status === "done" || status === "error";
}

export default function AgentNotificationManager() {
  const { tabs, activeTabId, setActiveTab } = useTabs();
  const [notifyOnAttention] = useAtom(notifyOnAttentionAtom);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const notifiedToolCallsRef = useRef<Set<string>>(new Set());
  const pendingToolCallsRef = useRef<Set<string>>(new Set());
  const lastStatusByTabRef = useRef<Map<string, AgentStatus>>(new Map());
  const unseenCompletionTabsRef = useRef<Set<string>>(new Set());
  const appliedBadgeCountRef = useRef<number | null>(null);

  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  const sendAttentionNotification = useCallback(
    async (tabId: string, tabLabel: string, toolCall: ToolCallDisplay) => {
      if (
        pendingToolCallsRef.current.has(toolCall.id) ||
        notifiedToolCallsRef.current.has(toolCall.id)
      ) {
        return;
      }

      pendingToolCallsRef.current.add(toolCall.id);

      try {
        const sent = await showNotification({
          title: "Agent needs your input",
          options: {
            body: `${tabLabel || "Untitled"} • ${toolCall.tool}`,
            tag: toolCall.id,
            data: { tabId },
          },
          onClick: () => {
            void focusTab(tabId, setActiveTab, {
              focusWindow: !documentHasFocus(),
            });
          },
        });

        if (sent) {
          notifiedToolCallsRef.current.add(toolCall.id);
        }
      } finally {
        pendingToolCallsRef.current.delete(toolCall.id);
      }
    },
    [setActiveTab],
  );

  const syncAppBadge = useCallback(() => {
    const isFocused = documentHasFocus();

    if (isFocused) {
      unseenCompletionTabsRef.current.clear();
    }

    const workspaceTabIds = new Set<string>();
    const attentionTabIds = new Set<string>();

    for (const tab of tabsRef.current) {
      if (tab.mode !== "workspace") continue;
      workspaceTabIds.add(tab.id);
      if (getAttentionToolCalls(tab.id).length > 0) {
        attentionTabIds.add(tab.id);
      }
    }

    for (const tabId of Array.from(unseenCompletionTabsRef.current)) {
      if (!workspaceTabIds.has(tabId)) {
        unseenCompletionTabsRef.current.delete(tabId);
      }
    }

    const nextBadgeCount =
      !isFocused
        ? new Set([
            ...attentionTabIds,
            ...unseenCompletionTabsRef.current,
          ]).size || null
        : null;

    if (appliedBadgeCountRef.current === nextBadgeCount) {
      return;
    }

    appliedBadgeCountRef.current = nextBadgeCount;
    void setAppBadgeCount(nextBadgeCount);
  }, []);

  const scanAttentionStates = useCallback(() => {
    const activeAttentionIds = new Set<string>();
    const isFocused = documentHasFocus();

    for (const tab of tabsRef.current) {
      if (tab.mode !== "workspace") continue;

      for (const toolCall of getAttentionToolCalls(tab.id)) {
        activeAttentionIds.add(toolCall.id);

        if (
          notifiedToolCallsRef.current.has(toolCall.id) ||
          pendingToolCallsRef.current.has(toolCall.id)
        ) {
          continue;
        }

        if (!notifyOnAttention) {
          continue;
        }

        const shouldNotify = !isFocused || tab.id !== activeTabIdRef.current;
        if (!shouldNotify) continue;

        void sendAttentionNotification(tab.id, tab.label, toolCall);
      }
    }

    for (const toolCallId of Array.from(notifiedToolCallsRef.current)) {
      if (!activeAttentionIds.has(toolCallId)) {
        notifiedToolCallsRef.current.delete(toolCallId);
      }
    }

    for (const toolCallId of Array.from(pendingToolCallsRef.current)) {
      if (!activeAttentionIds.has(toolCallId)) {
        pendingToolCallsRef.current.delete(toolCallId);
      }
    }

    syncAppBadge();
  }, [notifyOnAttention, sendAttentionNotification, syncAppBadge]);

  useEffect(() => {
    if (!notifyOnAttention) {
      notifiedToolCallsRef.current.clear();
      pendingToolCallsRef.current.clear();
    }

    scanAttentionStates();

    const unsubs: Array<() => void> = [];
    const workspaceTabIds = new Set<string>();

    for (const tab of tabs) {
      if (tab.mode !== "workspace") continue;
      workspaceTabIds.add(tab.id);

      const tabAtom = agentAtomFamily(tab.id);
      if (!lastStatusByTabRef.current.has(tab.id)) {
        lastStatusByTabRef.current.set(tab.id, jotaiStore.get(tabAtom).status);
      }

      unsubs.push(
        jotaiStore.sub(tabAtom, () => {
          const nextStatus = jotaiStore.get(tabAtom).status;
          const previousStatus =
            lastStatusByTabRef.current.get(tab.id) ?? nextStatus;

          if (
            previousStatus !== nextStatus &&
            isBusyStatus(previousStatus) &&
            isSettledStatus(nextStatus) &&
            !documentHasFocus()
          ) {
            unseenCompletionTabsRef.current.add(tab.id);
          }

          lastStatusByTabRef.current.set(tab.id, nextStatus);
          scanAttentionStates();
        }),
      );
    }

    for (const tabId of Array.from(lastStatusByTabRef.current.keys())) {
      if (!workspaceTabIds.has(tabId)) {
        lastStatusByTabRef.current.delete(tabId);
      }
    }

    for (const tabId of Array.from(unseenCompletionTabsRef.current)) {
      if (!workspaceTabIds.has(tabId)) {
        unseenCompletionTabsRef.current.delete(tabId);
      }
    }

    return () => unsubs.forEach((fn) => fn());
  }, [tabs, notifyOnAttention, scanAttentionStates]);

  useEffect(() => {
    scanAttentionStates();
  }, [activeTabId, scanAttentionStates]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleFocusChange = () => {
      scanAttentionStates();
    };

    window.addEventListener("focus", handleFocusChange);
    window.addEventListener("blur", handleFocusChange);
    document.addEventListener("visibilitychange", handleFocusChange);

    return () => {
      window.removeEventListener("focus", handleFocusChange);
      window.removeEventListener("blur", handleFocusChange);
      document.removeEventListener("visibilitychange", handleFocusChange);
    };
  }, [scanAttentionStates]);

  return null;
}
