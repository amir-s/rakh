import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSavedProjects, saveSavedProjects } from "@/projects";

const { getAgentStateMock } = vi.hoisted(() => ({
  getAgentStateMock: vi.fn(),
}));

vi.mock("../atoms", () => ({
  getAgentState: (...args: unknown[]) => getAgentStateMock(...args),
}));

import { projectMemoryAdd } from "./projectMemory";

describe("projectMemoryAdd", () => {
  beforeEach(async () => {
    getAgentStateMock.mockReset();
    getAgentStateMock.mockReturnValue({
      config: {
        cwd: "/repo",
        projectPath: "/repo",
      },
    });
    await saveSavedProjects([]);
  });

  it("allows the main agent to append learned facts", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder",
      },
    ]);

    const result = await projectMemoryAdd(
      "tab",
      { agentId: "agent_main" },
      { facts: ["Use pnpm."] },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        projectPath: "/repo",
        learnedFacts: ["Use pnpm."],
        addedFacts: ["Use pnpm."],
        updated: true,
      },
    });
    expect(getSavedProjects()[0]?.learnedFacts).toEqual(["Use pnpm."]);
  });

  it("rejects unrelated subagent callers", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder",
      },
    ]);

    const result = await projectMemoryAdd(
      "tab",
      { agentId: "agent_reviewer" },
      { facts: ["Use pnpm."] },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(getSavedProjects()[0]?.learnedFacts).toBeUndefined();
  });

  it("appends unique learned facts and caps the stored list to 50 items", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder",
        learnedFacts: Array.from({ length: 50 }, (_, index) => `Fact ${index}`),
      },
    ]);

    const result = await projectMemoryAdd(
      "tab",
      { agentId: "agent_compact" },
      { facts: [" Fact 49 ", "Fact 50", "", "Fact 51"] },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        projectPath: "/repo",
        learnedFacts: Array.from({ length: 50 }, (_, index) => `Fact ${index + 2}`),
        addedFacts: ["Fact 50", "Fact 51"],
        updated: true,
      },
    });
  });

  it("reports a no-op when there are no new learned facts", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder",
        learnedFacts: ["Use pnpm in this repo."],
      },
    ]);

    const result = await projectMemoryAdd(
      "tab",
      { agentId: "agent_compact" },
      { facts: [" Use pnpm in this repo. ", ""] },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        projectPath: "/repo",
        learnedFacts: ["Use pnpm in this repo."],
        addedFacts: [],
        updated: false,
      },
    });
  });

  it("returns NOT_FOUND when the session is not associated with a saved project", async () => {
    getAgentStateMock.mockReturnValue({
      config: {
        cwd: "/missing",
        projectPath: "/missing",
      },
    });

    const result = await projectMemoryAdd(
      "tab",
      { agentId: "agent_compact" },
      { facts: ["Use pnpm."] },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });
});
