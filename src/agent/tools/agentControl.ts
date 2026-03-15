/**
 * Agent control tools (§3 of tools.md)
 * These are pure in-memory operations that read/write the Jotai agent state.
 * They do not touch the filesystem or shell.
 */
import { getAgentState, patchAgentState } from "../atoms";
import { applyEditChanges } from "./workspace";
import type { EditFileChange } from "./workspace";
import type {
  AgentPlan,
  ConversationCard,
  ToolResult,
} from "../types";

/* ── helpers ────────────────────────────────────────────────────────────────── */

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ── 3.1 agent.plan.set ─────────────────────────────────────────────────────── */

export interface PlanSetInput {
  markdown: string;
}

export interface PlanSetOutput {
  plan: AgentPlan;
}

export function planSet(
  tabId: string,
  input: PlanSetInput,
): ToolResult<PlanSetOutput> {
  const prev = getAgentState(tabId).plan;
  const plan: AgentPlan = {
    markdown: input.markdown,
    updatedAtMs: Date.now(),
    version: prev.version + 1,
  };
  patchAgentState(tabId, { plan });
  return { ok: true, data: { plan } };
}

/* ── 3.2 agent.plan.edit ────────────────────────────────────────────────────── */

export interface PlanEditInput {
  changes: EditFileChange[];
}

export interface PlanEditOutput {
  plan: AgentPlan;
}

export function planEdit(
  tabId: string,
  input: PlanEditInput,
): ToolResult<PlanEditOutput> {
  const prev = getAgentState(tabId).plan;
  let markdown: string;
  try {
    markdown = applyEditChanges(prev.markdown, input.changes);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "CONFLICT",
        message: String(e),
      },
    };
  }
  const plan: AgentPlan = {
    markdown,
    updatedAtMs: Date.now(),
    version: prev.version + 1,
  };
  patchAgentState(tabId, { plan });
  return { ok: true, data: { plan } };
}

/* ── 3.3 agent.plan.get ─────────────────────────────────────────────────────── */

export interface PlanGetOutput {
  plan: AgentPlan;
}

export function planGet(tabId: string): ToolResult<PlanGetOutput> {
  const { plan } = getAgentState(tabId);
  return { ok: true, data: { plan } };
}

/* ── agent.title.set ───────────────────────────────────────────────────────── */

export interface TitleSetInput {
  title: string;
}

export interface TitleSetOutput {
  title: string;
}

export function titleSet(
  tabId: string,
  input: TitleSetInput,
): ToolResult<TitleSetOutput> {
  const title = (input.title ?? "").trim();
  patchAgentState(tabId, { tabTitle: title });
  return { ok: true, data: { title } };
}

/* ── agent.title.get ──────────────────────────────────────────────────────────────── */

export interface TitleGetOutput {
  title: string;
}

export function titleGet(tabId: string): ToolResult<TitleGetOutput> {
  const { tabTitle } = getAgentState(tabId);
  return { ok: true, data: { title: tabTitle } };
}

/* ── agent.card.add ───────────────────────────────────────────────────────── */

export type CardAddInput =
  | {
      kind: "summary";
      title?: string;
      markdown: string;
    }
  | {
      kind: "artifact";
      title?: string;
      artifactId: string;
      version?: number;
    };

export interface CardAddOutput {
  cardId: string;
  kind: ConversationCard["kind"];
}

export interface CardAddBuildOutput extends CardAddOutput {
  card: ConversationCard;
}

function normalizeOptionalTitle(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildConversationCard(
  input: CardAddInput,
): ToolResult<CardAddBuildOutput> {
  if (input.kind !== "summary" && input.kind !== "artifact") {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "kind must be 'summary' or 'artifact'",
      },
    };
  }

  const title = normalizeOptionalTitle(input.title);
  const cardId = uid();

  if (input.kind === "summary") {
    const markdown = typeof input.markdown === "string" ? input.markdown.trim() : "";
    if (!markdown) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "summary markdown must not be empty",
        },
      };
    }

    const card: ConversationCard = {
      id: cardId,
      kind: "summary",
      ...(title ? { title } : {}),
      markdown,
    };
    return {
      ok: true,
      data: {
        cardId,
        kind: "summary",
        card,
      },
    };
  }

  const artifactId =
    typeof input.artifactId === "string" ? input.artifactId.trim() : "";
  if (!artifactId) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "artifactId must not be empty",
      },
    };
  }

  if (
    input.version !== undefined &&
    (!Number.isInteger(input.version) || input.version <= 0)
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "version must be a positive integer when provided",
      },
    };
  }

  const card: ConversationCard = {
    id: cardId,
    kind: "artifact",
    ...(title ? { title } : {}),
    artifactId,
    ...(input.version !== undefined ? { version: input.version } : {}),
  };
  return {
    ok: true,
    data: {
      cardId,
      kind: "artifact",
      card,
    },
  };
}

export function cardAdd(
  _tabId: string,
  input: CardAddInput,
): ToolResult<CardAddOutput> {
  const built = buildConversationCard(input);
  if (!built.ok) return built;
  return {
    ok: true,
    data: {
      cardId: built.data.cardId,
      kind: built.data.kind,
    },
  };
}
