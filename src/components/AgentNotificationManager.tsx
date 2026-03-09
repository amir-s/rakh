import { useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import {
  agentAtomFamily,
  jotaiStore,
  notifyOnAttentionAtom,
} from "@/agent/atoms";
import type { ToolCallDisplay } from "@/agent/types";
import { useTabs } from "@/contexts/TabsContext";
import { focusTab, showNotification } from "@/notifications";

function getAttentionToolCalls(tabId: string): ToolCallDisplay[] {
  const state = jotaiStore.get(agentAtomFamily(tabId));
  return state.chatMessages
    .flatMap((message) => message.toolCalls ?? [])
    .filter(
      (toolCall) =>
        toolCall.status === "awaiting_approval" ||
        toolCall.status === "awaiting_worktree",
    );
}

function documentHasFocus(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

export default function AgentNotificationManager() {
  const { tabs, activeTabId, setActiveTab } = useTabs();
  const [notifyOnAttention] = useAtom(notifyOnAttentionAtom);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const notifiedToolCallsRef = useRef<Set<string>>(new Set());
  const pendingToolCallsRef = useRef<Set<string>>(new Set());

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

  const scanAttentionStates = useCallback(() => {
    if (!notifyOnAttention) return;

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
  }, [notifyOnAttention, sendAttentionNotification]);

  useEffect(() => {
    if (!notifyOnAttention) {
      notifiedToolCallsRef.current.clear();
      pendingToolCallsRef.current.clear();
      return;
    }

    scanAttentionStates();

    const unsubs: Array<() => void> = [];
    for (const tab of tabs) {
      if (tab.mode !== "workspace") continue;
      unsubs.push(jotaiStore.sub(agentAtomFamily(tab.id), scanAttentionStates));
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
