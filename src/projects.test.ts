import { describe, expect, it } from "vitest";
import { applyProjectScriptsConfig } from "./projects";

describe("projects", () => {
  it("prefers repo config values when .rakh/scripts.json exists", () => {
    expect(
      applyProjectScriptsConfig(
        {
          path: "/repo",
          name: "Repo",
          setupCommand: "local setup",
          commands: [
            {
              id: "local-run",
              label: "Local Run",
              command: "npm run local",
            },
          ],
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
      hasProjectConfigFile: true,
      setupCommand: "repo setup",
      commands: [
        {
          id: "repo-run",
          label: "Repo Run",
          command: "npm run repo",
        },
      ],
    });
  });
});
