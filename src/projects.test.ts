import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PROJECT_LEARNED_FACTS,
  applyProjectScriptsConfig,
  getSavedProjects,
  mergeProjectLearnedFacts,
  normalizeSavedProject,
  removeProjectLearnedFacts,
  saveSavedProjects,
  upsertSavedProject,
  upsertSavedProjectPreservingLearnedFacts,
} from "./projects";

function fact(id: string, text: string) {
  return { id, text };
}

describe("projects", () => {
  beforeEach(async () => {
    await saveSavedProjects([]);
  });

  it("prefers repo config values when .rakh/scripts.json exists and preserves learned facts", () => {
    expect(
      applyProjectScriptsConfig(
        {
          path: "/repo",
          name: "Repo",
          icon: "folder_code",
          githubIntegrationEnabled: true,
          setupCommand: "local setup",
          commands: [
            {
              id: "local-run",
              label: "Local Run",
              command: "npm run local",
            },
          ],
          learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
        },
        {
          exists: true,
          config: {
            setupCommand: "repo setup",
            githubIntegrationEnabled: true,
            commands: [
              {
                id: "repo-run",
                label: "Repo Run",
                command: "npm run repo",
              },
            ],
          },
        },
      ),
    ).toEqual({
      path: "/repo",
      name: "Repo",
      icon: "folder_code",
      hasProjectConfigFile: true,
      githubIntegrationEnabled: true,
      setupCommand: "repo setup",
      commands: [
        {
          id: "repo-run",
          label: "Repo Run",
          command: "npm run repo",
        },
      ],
      learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
    });
  });

  it("migrates legacy learned facts by trimming, assigning IDs, deduping, and capping to the newest 50", () => {
    const normalized = normalizeSavedProject({
      path: "/repo",
      name: "Repo",
      learnedFacts: [
        "  Keep me  ",
        "",
        "Keep me",
        ...Array.from(
          { length: MAX_PROJECT_LEARNED_FACTS + 2 },
          (_, index) => `Fact ${index}`,
        ),
      ],
    });

    expect(normalized?.learnedFacts).toHaveLength(MAX_PROJECT_LEARNED_FACTS);
    expect(normalized?.learnedFacts?.[0]).toMatchObject({ text: "Fact 2" });
    expect(normalized?.learnedFacts?.[0]?.id).toMatch(/^fact_/);
    expect(normalized?.learnedFacts?.at(-1)).toMatchObject({
      text: `Fact ${MAX_PROJECT_LEARNED_FACTS + 1}`,
    });
  });

  it("merges new learned facts without duplicates and keeps the newest 50", () => {
    const existing = Array.from(
      { length: MAX_PROJECT_LEARNED_FACTS },
      (_, index) => fact(`fact_${index}`, `Fact ${index}`),
    );

    const result = mergeProjectLearnedFacts(existing, [
      " Fact 49 ",
      "Fact 50",
      "",
      "Fact 51",
    ]);

    expect(result.updated).toBe(true);
    expect(result.addedFacts).toHaveLength(2);
    expect(result.addedFacts.map((entry) => entry.text)).toEqual([
      "Fact 50",
      "Fact 51",
    ]);
    expect(result.learnedFacts).toHaveLength(MAX_PROJECT_LEARNED_FACTS);
    expect(result.learnedFacts?.[0]).toMatchObject({ text: "Fact 2" });
    expect(result.learnedFacts?.at(-1)).toMatchObject({ text: "Fact 51" });
  });

  it("removes learned facts by stable ID", () => {
    expect(
      removeProjectLearnedFacts(
        [
          fact("fact_pnpm", "Use pnpm in this repo."),
          fact("fact_tauri", "The backend uses Tauri."),
        ],
        [" fact_pnpm ", "fact_missing"],
      ),
    ).toEqual({
      learnedFacts: [fact("fact_tauri", "The backend uses Tauri.")],
      removedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
      updated: true,
    });
  });

  it("preserves learned facts through save and update flows", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder_code",
        githubIntegrationEnabled: true,
        learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
      },
    ]);

    await upsertSavedProject({
      path: "/repo",
      name: "Repo Renamed",
      icon: "folder_open",
      githubIntegrationEnabled: true,
      learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
      setupCommand: "pnpm install",
    });

    expect(getSavedProjects()).toEqual([
      {
        path: "/repo",
        name: "Repo Renamed",
        icon: "folder_open",
        githubIntegrationEnabled: true,
        learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
        setupCommand: "pnpm install",
      },
    ]);
  });

  it("preserves the latest learned facts when other project fields are saved", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder_code",
        githubIntegrationEnabled: true,
        learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
      },
    ]);

    await upsertSavedProjectPreservingLearnedFacts({
      path: "/repo",
      name: "Repo Renamed",
      icon: "folder_open",
      githubIntegrationEnabled: true,
      setupCommand: "pnpm install",
    });

    expect(getSavedProjects()).toEqual([
      {
        path: "/repo",
        name: "Repo Renamed",
        icon: "folder_open",
        githubIntegrationEnabled: true,
        learnedFacts: [fact("fact_pnpm", "Use pnpm in this repo.")],
        setupCommand: "pnpm install",
      },
    ]);
  });
});
