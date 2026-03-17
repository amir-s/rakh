import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSavedProjects, saveSavedProjects } from "@/projects";

const { getAgentStateMock } = vi.hoisted(() => ({
  getAgentStateMock: vi.fn(),
}));

vi.mock("../atoms", () => ({
  getAgentState: (...args: unknown[]) => getAgentStateMock(...args),
}));

import {
  projectMemoryAdd,
  projectMemoryEdit,
  projectMemoryRemove,
} from "./projectMemory";

function fact(id: string, text: string) {
  return { id, text };
}

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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.projectPath).toBe("/repo");
    expect(result.data.updated).toBe(true);
    expect(result.data.learnedFacts).toHaveLength(1);
    expect(result.data.addedFacts).toHaveLength(1);
    expect(result.data.learnedFacts[0]).toMatchObject({ text: "Use pnpm." });
    expect(result.data.learnedFacts[0]?.id).toMatch(/^fact_/);
    expect(result.data.addedFacts[0]).toEqual(result.data.learnedFacts[0]);
    expect(getSavedProjects()[0]?.learnedFacts).toHaveLength(1);
    expect(getSavedProjects()[0]?.learnedFacts?.[0]).toMatchObject({
      text: "Use pnpm.",
    });
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
        learnedFacts: Array.from(
          { length: 50 },
          (_, index) => fact(`fact_${index}`, `Fact ${index}`),
        ),
      },
    ]);

    const result = await projectMemoryAdd(
      "tab",
      { agentId: "agent_compact" },
      { facts: [" Fact 49 ", "Fact 50", "", "Fact 51"] },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.projectPath).toBe("/repo");
    expect(result.data.updated).toBe(true);
    expect(result.data.learnedFacts).toHaveLength(50);
    expect(result.data.learnedFacts[0]).toMatchObject({ text: "Fact 2" });
    expect(result.data.learnedFacts.at(-1)).toMatchObject({ text: "Fact 51" });
    expect(result.data.addedFacts.map((entry) => entry.text)).toEqual([
      "Fact 50",
      "Fact 51",
    ]);
  });

  it("reports a no-op when there are no new learned facts", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder",
        learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
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
        learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
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

  it("removes exact learned facts for the main agent", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder",
        learnedFacts: [
          fact("fact_pnpm", "Use pnpm in this repo."),
          fact("fact_tauri", "The backend uses Tauri."),
        ],
      },
    ]);

    const result = await projectMemoryRemove(
      "tab",
      { agentId: "agent_main" },
      { factIds: [" fact_pnpm ", "fact_unknown"] },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        projectPath: "/repo",
        learnedFacts: [fact("fact_tauri", "The backend uses Tauri.")],
        removedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
        updated: true,
      },
    });
    expect(getSavedProjects()[0]?.learnedFacts).toEqual([
      fact("fact_tauri", "The backend uses Tauri."),
    ]);
  });

  it("reports a no-op when project memory removal matches nothing", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder",
        learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
      },
    ]);

    const result = await projectMemoryRemove(
      "tab",
      { agentId: "agent_compact" },
      { factIds: ["fact_unknown"] },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        projectPath: "/repo",
        learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
        removedFacts: [],
        updated: false,
      },
    });
  });

  it("edits a learned fact by stable ID", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder",
        learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
      },
    ]);

    const result = await projectMemoryEdit(
      "tab",
      { agentId: "agent_main" },
      { factId: "fact_pnpm", text: "Use bun in this repo." },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        projectPath: "/repo",
        learnedFacts: [fact("fact_pnpm", "Use bun in this repo.")],
        updatedFact: fact("fact_pnpm", "Use bun in this repo."),
        updated: true,
      },
    });
  });

  it("rejects edits that would duplicate another learned fact", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder",
        learnedFacts: [
          fact("fact_a", "Use pnpm in this repo."),
          fact("fact_b", "The backend uses Tauri."),
        ],
      },
    ]);

    const result = await projectMemoryEdit(
      "tab",
      { agentId: "agent_compact" },
      { factId: "fact_b", text: "Use pnpm in this repo." },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
  });
});
