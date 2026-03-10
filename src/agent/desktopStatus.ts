import type { Tab } from "@/contexts/TabsContext";
import { agentAtomFamily, jotaiStore } from "./atoms";
import type { AgentStatus, ChatMessage, ToolCallDisplay } from "./types";

export type WorkspaceDisplayTone = "attention" | "working" | "done";
export type WorkspaceAggregateStatus = "idle" | "working" | "done" | "attention";

export interface WorkspaceDisplayStatus {
  label: string;
  tone: WorkspaceDisplayTone;
}

export interface WorkspaceTabSummary {
  tabId: string;
  tabLabel: string;
  status: AgentStatus;
  attentionToolCalls: ToolCallDisplay[];
  hasCompletedActivity: boolean;
  requiresAttention: boolean;
  bucket: WorkspaceAggregateStatus;
  displayStatus: WorkspaceDisplayStatus | null;
}

export interface DesktopAgentSummary {
  tabs: WorkspaceTabSummary[];
  attentionCount: number;
  workingCount: number;
  doneCount: number;
  trayStatus: WorkspaceAggregateStatus;
  trayStatusLabel: string;
  menuStatusText: string;
  menuCountsText: string;
  tooltip: string;
}

function isBusyStatus(status: AgentStatus): boolean {
  return status === "thinking" || status === "working";
}

export function getAttentionToolCalls(
  chatMessages: ChatMessage[],
): ToolCallDisplay[] {
  return chatMessages
    .flatMap((message) => message.toolCalls ?? [])
    .filter(
      (toolCall) =>
        toolCall.status === "awaiting_approval" ||
        toolCall.status === "awaiting_worktree" ||
        toolCall.status === "awaiting_branch_release" ||
        toolCall.status === "awaiting_setup_action",
    );
}

export function resolveWorkspaceDisplayStatus(
  status: AgentStatus,
  chatMessages: ChatMessage[],
  tabTitle: string,
): WorkspaceDisplayStatus | null {
  const attentionToolCalls = getAttentionToolCalls(chatMessages);
  const hasCompletedActivity =
    chatMessages.length > 0 || tabTitle.trim().length > 0 || status === "done";

  if (status === "error" || attentionToolCalls.length > 0) {
    return { label: "Requires attention", tone: "attention" };
  }

  if (isBusyStatus(status)) {
    return { label: "Working", tone: "working" };
  }

  if (hasCompletedActivity) {
    return { label: "Done", tone: "done" };
  }

  return null;
}

export function summarizeWorkspaceTab(
  tabId: string,
  tabLabel: string,
): WorkspaceTabSummary {
  const state = jotaiStore.get(agentAtomFamily(tabId));
  const attentionToolCalls = getAttentionToolCalls(state.chatMessages);
  const hasCompletedActivity =
    state.chatMessages.length > 0 ||
    state.tabTitle.trim().length > 0 ||
    state.status === "done";
  const requiresAttention =
    state.status === "error" || attentionToolCalls.length > 0;

  let bucket: WorkspaceAggregateStatus = "idle";
  if (requiresAttention) {
    bucket = "attention";
  } else if (isBusyStatus(state.status)) {
    bucket = "working";
  } else if (hasCompletedActivity) {
    bucket = "done";
  }

  return {
    tabId,
    tabLabel,
    status: state.status,
    attentionToolCalls,
    hasCompletedActivity,
    requiresAttention,
    bucket,
    displayStatus: resolveWorkspaceDisplayStatus(
      state.status,
      state.chatMessages,
      state.tabTitle,
    ),
  };
}

function getTrayStatusLabel(status: WorkspaceAggregateStatus): string {
  switch (status) {
    case "attention":
      return "Requires attention";
    case "working":
      return "Working";
    case "done":
      return "Done";
    default:
      return "Idle";
  }
}

export function summarizeDesktopAgentState(tabs: Tab[]): DesktopAgentSummary {
  const workspaceTabs = tabs
    .filter((tab): tab is Tab & { mode: "workspace" } => tab.mode === "workspace")
    .map((tab) => summarizeWorkspaceTab(tab.id, tab.label));

  const attentionCount = workspaceTabs.filter(
    (tab) => tab.bucket === "attention",
  ).length;
  const workingCount = workspaceTabs.filter(
    (tab) => tab.bucket === "working",
  ).length;
  const doneCount = workspaceTabs.filter((tab) => tab.bucket === "done").length;

  let trayStatus: WorkspaceAggregateStatus = "idle";
  if (attentionCount > 0) {
    trayStatus = "attention";
  } else if (workingCount > 0) {
    trayStatus = "working";
  } else if (doneCount > 0) {
    trayStatus = "done";
  }

  const trayStatusLabel = getTrayStatusLabel(trayStatus);
  const menuStatusText = `Status: ${trayStatusLabel}`;
  const menuCountsText = `Attention ${attentionCount} • Working ${workingCount} • Done ${doneCount}`;

  return {
    tabs: workspaceTabs,
    attentionCount,
    workingCount,
    doneCount,
    trayStatus,
    trayStatusLabel,
    menuStatusText,
    menuCountsText,
    tooltip: `Rakh: ${trayStatusLabel} • ${menuCountsText}`,
  };
}
