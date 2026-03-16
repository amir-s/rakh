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

import { buildSystemPrompt } from "./systemPrompt";

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
      ["Use pnpm in this repo.", "The backend is a Tauri app."],
      undefined,
    );

    expect(systemPrompt).toContain("PROJECT MEMORY");
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
});
