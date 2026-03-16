import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PROJECT_LEARNED_FACTS,
  applyProjectScriptsConfig,
  getSavedProjects,
  mergeProjectLearnedFacts,
  normalizeSavedProject,
  saveSavedProjects,
  upsertSavedProject,
  upsertSavedProjectPreservingLearnedFacts,
} from "./projects";

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
          setupCommand: "local setup",
          commands: [
            {
              id: "local-run",
              label: "Local Run",
              command: "npm run local",
            },
          ],
          learnedFacts: ["Use pnpm in this repo."],
        },
        {
          exists: true,
          config: {
            setupCommand: "repo setup",
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
      setupCommand: "repo setup",
      commands: [
        {
          id: "repo-run",
          label: "Repo Run",
          command: "npm run repo",
        },
      ],
      learnedFacts: ["Use pnpm in this repo."],
    });
  });

  it("normalizes learned facts by trimming, deduping, and capping to the newest 50", () => {
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
    expect(normalized?.learnedFacts?.[0]).toBe("Fact 2");
    expect(normalized?.learnedFacts?.at(-1)).toBe(
      `Fact ${MAX_PROJECT_LEARNED_FACTS + 1}`,
    );
  });

  it("merges new learned facts without duplicates and keeps the newest 50", () => {
    const existing = Array.from(
      { length: MAX_PROJECT_LEARNED_FACTS },
      (_, index) => `Fact ${index}`,
    );

    expect(
      mergeProjectLearnedFacts(existing, [" Fact 49 ", "Fact 50", "", "Fact 51"]),
    ).toEqual({
      learnedFacts: Array.from(
        { length: MAX_PROJECT_LEARNED_FACTS },
        (_, index) => `Fact ${index + 2}`,
      ),
      addedFacts: ["Fact 50", "Fact 51"],
      updated: true,
    });
  });

  it("preserves learned facts through save and update flows", async () => {
    await saveSavedProjects([
      {
        path: "/repo",
        name: "Repo",
        icon: "folder_code",
        learnedFacts: ["Use pnpm in this repo."],
      },
    ]);

    await upsertSavedProject({
      path: "/repo",
      name: "Repo Renamed",
      icon: "folder_open",
      learnedFacts: ["Use pnpm in this repo."],
      setupCommand: "pnpm install",
    });

    expect(getSavedProjects()).toEqual([
      {
        path: "/repo",
        name: "Repo Renamed",
        icon: "folder_open",
        learnedFacts: ["Use pnpm in this repo."],
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
        learnedFacts: ["Use pnpm in this repo."],
      },
    ]);

    await upsertSavedProjectPreservingLearnedFacts({
      path: "/repo",
      name: "Repo Renamed",
      icon: "folder_open",
      setupCommand: "pnpm install",
    });

    expect(getSavedProjects()).toEqual([
      {
        path: "/repo",
        name: "Repo Renamed",
        icon: "folder_open",
        learnedFacts: ["Use pnpm in this repo."],
        setupCommand: "pnpm install",
      },
    ]);
  });
});
