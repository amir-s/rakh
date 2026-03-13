export type AgentAbortReason = "user_stop" | "steer" | "superseded";

export interface ActiveRun {
  runId: string;
  controller: AbortController;
  abortReason: AgentAbortReason | null;
}

const activeRuns = new Map<string, ActiveRun>();
const runCounters = new Map<string, number>();

export function nextRunId(tabId: string): string {
  const next = (runCounters.get(tabId) ?? 0) + 1;
  runCounters.set(tabId, next);
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `run_${iso}_${String(next).padStart(4, "0")}`;
}

export function hasActiveRun(tabId: string): boolean {
  return activeRuns.has(tabId);
}

export function isActiveRunOwner(tabId: string, activeRun: ActiveRun): boolean {
  return activeRuns.get(tabId) === activeRun;
}

export function clearActiveRun(tabId: string, activeRun: ActiveRun): void {
  if (isActiveRunOwner(tabId, activeRun)) {
    activeRuns.delete(tabId);
  }
}

export function isCurrentRunId(tabId: string, runId: string): boolean {
  return activeRuns.get(tabId)?.runId === runId;
}

export function setActiveRun(tabId: string, activeRun: ActiveRun): void {
  activeRuns.set(tabId, activeRun);
}

export function getActiveRun(tabId: string): ActiveRun | undefined {
  return activeRuns.get(tabId);
}
