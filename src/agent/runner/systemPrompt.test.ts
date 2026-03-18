import { describe, expect, it, vi } from "vitest";

const {
  globalCommunicationProfileAtomMock,
  profilesAtomMock,
  jotaiStoreMock,
} = vi.hoisted(() => {
  const globalCommunicationProfileAtomMock = { kind: "global-profile" };
  const profilesAtomMock = { kind: "profiles" };
  const jotaiStoreMock = {
    get: vi.fn((atom: unknown) => {
      if (atom === globalCommunicationProfileAtomMock) return null;
      if (atom === profilesAtomMock) return [];
      return null;
    }),
  };
  return {
    globalCommunicationProfileAtomMock,
    profilesAtomMock,
    jotaiStoreMock,
  };
});

vi.mock("../atoms", () => ({
  jotaiStore: jotaiStoreMock,
  globalCommunicationProfileAtom: globalCommunicationProfileAtomMock,
}));

vi.mock("../db", () => ({
  profilesAtom: profilesAtomMock,
}));

import { buildSubagentSystemPrompt, buildSystemPrompt } from "./systemPrompt";
import { plannerSubagent } from "../subagents/planner";

const runtimeContext = {
  hostOs: "mac",
  locale: "en-CA",
  timeZone: "America/Toronto",
  localDate: "2026-03-12",
  localTime: "10:00:00",
  utcIso: "2026-03-12T15:00:00.000Z",
};

describe("buildSystemPrompt", () => {
  it("includes reviewer scope guidance from the subagent description", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      false,
      false,
      false,
      runtimeContext,
      undefined,
      undefined,
    );

    expect(systemPrompt).toContain(
      "Always include a concrete scope (file(s), directory, or commit range) in the message.",
    );
    expect(systemPrompt).not.toContain(
      "if the reviewer subagent returns findings and you plan to apply those suggestions",
    );
  });

  it("includes security auditor guidance from the subagent description", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      false,
      false,
      false,
      runtimeContext,
      undefined,
      undefined,
    );

    expect(systemPrompt).toContain(
      "Audits code and security-relevant configuration in a requested scope and returns actionable findings.",
    );
    expect(systemPrompt).toContain(
      "Always include a concrete scope (file(s), directory, or commit range) in the message.",
    );
  });

  it("tells the parent agent not to recreate cards returned by subagents", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      false,
      false,
      false,
      runtimeContext,
      undefined,
      undefined,
    );

    expect(systemPrompt).toContain(
      "When a subagent returns cards, those cards are already visible to the user.",
    );
    expect(systemPrompt).toContain(
      "Read them, but do not recreate the same cards with agent_card_add.",
    );
  });

  it("keeps todo ownership with the main agent when using planner", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      false,
      false,
      false,
      runtimeContext,
      undefined,
      undefined,
    );

    expect(systemPrompt).toContain(
      "If you use the planner subagent, it should only return plan artifacts/cards.",
    );
    expect(systemPrompt).toContain(
      "You must create and manage todos yourself after reviewing the planner output.",
    );
  });

  it("omits manual-only compaction subagents from the parent prompt", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      false,
      false,
      false,
      runtimeContext,
      undefined,
      undefined,
    );

    expect(systemPrompt).not.toContain("/compact");
    expect(systemPrompt).not.toContain("Compacts the main agent's internal context");
  });

  it("renders learned project facts when provided", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      false,
      false,
      false,
      runtimeContext,
      [
        { id: "fact_pnpm", text: "Use pnpm in this repo." },
        { id: "fact_tauri", text: "The backend is a Tauri app." },
      ],
      undefined,
    );

    expect(systemPrompt).toContain("PROJECT MEMORY");
    expect(systemPrompt).toContain("fact_pnpm");
    expect(systemPrompt).toContain("Use pnpm in this repo.");
    expect(systemPrompt).toContain("The backend is a Tauri app.");
  });

  it("omits the project memory section when no learned facts exist", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      false,
      false,
      false,
      runtimeContext,
      [],
      undefined,
    );

    expect(systemPrompt).not.toContain("PROJECT MEMORY");
  });

  it("tells the main agent when project memory writes are appropriate", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      false,
      false,
      false,
      runtimeContext,
      undefined,
      undefined,
    );

    expect(systemPrompt).toContain("agent_project_memory_add");
    expect(systemPrompt).toContain("agent_project_memory_remove");
    expect(systemPrompt).toContain("agent_project_memory_edit");
    expect(systemPrompt).toContain(
      "remember stable repo facts or standing requirements across future sessions",
    );
    expect(systemPrompt).toContain(
      "forget stale or incorrect project memory across future sessions",
    );
    expect(systemPrompt).toContain(
      "Never store temporary task state, one-off debugging notes, transient plans, or next steps in project memory.",
    );
    expect(systemPrompt).toContain(
      "remove the stored fact ID itself rather than paraphrasing the fact text",
    );
  });

  it("documents hidden tool-context compaction metadata in the main prompt", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      false,
      false,
      false,
      runtimeContext,
      undefined,
      undefined,
    );

    expect(systemPrompt).toContain("TOOL IO CONTEXT COMPACTION");
    expect(systemPrompt).toContain("__contextCompaction");
    expect(systemPrompt).toContain("outputMode?: \"always\" | \"on_success\"");
    expect(systemPrompt).toContain("Supported local-tool input compaction");
    expect(systemPrompt).toContain("Supported local-tool output compaction");
  });

  it("omits tool-context compaction guidance from the main prompt when disabled", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      false,
      false,
      false,
      runtimeContext,
      undefined,
      undefined,
      false,
    );

    expect(systemPrompt).not.toContain("TOOL IO CONTEXT COMPACTION");
    expect(systemPrompt).not.toContain("__contextCompaction");
    expect(systemPrompt).not.toContain("Supported local-tool input compaction");
  });
});

describe("buildSubagentSystemPrompt", () => {
  it("documents hidden tool-context compaction metadata for subagents", () => {
    const systemPrompt = buildSubagentSystemPrompt(plannerSubagent);

    expect(systemPrompt).toContain("TOOL IO CONTEXT COMPACTION");
    expect(systemPrompt).toContain("__contextCompaction");
    expect(systemPrompt).toContain("workspace_readFile");
    expect(systemPrompt).toContain("agent_artifact_get");
  });

  it("omits tool-context compaction guidance for subagents when disabled", () => {
    const systemPrompt = buildSubagentSystemPrompt(
      plannerSubagent,
      undefined,
      false,
    );

    expect(systemPrompt).not.toContain("TOOL IO CONTEXT COMPACTION");
    expect(systemPrompt).not.toContain("__contextCompaction");
    expect(systemPrompt).not.toContain("workspace_readFile");
  });
});
