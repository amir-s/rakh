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

  it("documents distinct input and output file reference syntax", () => {
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
      "The user may reference files with the @filename syntax",
    );
    expect(systemPrompt).toContain(
      "use plain workspace-relative references like src/App.tsx:42 or src/App.tsx:42:7",
    );
    expect(systemPrompt).toContain(
      "Do not add a leading @ when you are writing a file reference yourself.",
    );
    expect(systemPrompt).toContain(
      "Prefer plain text path:line[:column] references over custom markdown links",
    );
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

  it("uses stable git isolation guidance without volatile clock metadata", () => {
    const systemPrompt = buildSystemPrompt(
      "/workspace",
      true,
      false,
      false,
      runtimeContext,
      undefined,
      undefined,
    );

    expect(systemPrompt).toContain("Call git_worktree_init in isolation.");
    expect(systemPrompt).toContain(
      "treat the returned worktree path as the active workspace root",
    );
    expect(systemPrompt).not.toContain("Locale:");
    expect(systemPrompt).not.toContain("Timezone:");
    expect(systemPrompt).not.toContain("Today's local date");
    expect(systemPrompt).not.toContain("Current local time");
    expect(systemPrompt).not.toContain("Current UTC timestamp");
  });
});

describe("buildSubagentSystemPrompt", () => {
  it("includes artifact contract guidance for planner", () => {
    const systemPrompt = buildSubagentSystemPrompt(plannerSubagent);

    expect(systemPrompt).toContain("ARTIFACT CONTRACTS");
    expect(systemPrompt).toContain("artifactType: \"plan\"");
    expect(systemPrompt).toContain("FINAL MESSAGE");
  });

  it("does not mention legacy tool-context compaction metadata for subagents", () => {
    const systemPrompt = buildSubagentSystemPrompt(plannerSubagent);

    expect(systemPrompt).not.toContain("TOOL IO CONTEXT COMPACTION");
    expect(systemPrompt).not.toContain("__contextCompaction");
  });
});
