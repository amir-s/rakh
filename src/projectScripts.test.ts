import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceMocks = vi.hoisted(() => ({
  statFileMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock("@/agent/tools/workspace", () => ({
  statFile: (...args: unknown[]) => workspaceMocks.statFileMock(...args),
  readFile: (...args: unknown[]) => workspaceMocks.readFileMock(...args),
  writeFile: (...args: unknown[]) => workspaceMocks.writeFileMock(...args),
}));

import {
  loadProjectScriptsConfig,
  writeProjectScriptsConfig,
} from "./projectScripts";

describe("projectScripts", () => {
  beforeEach(() => {
    workspaceMocks.statFileMock.mockReset();
    workspaceMocks.readFileMock.mockReset();
    workspaceMocks.writeFileMock.mockReset();
  });

  it("loads .rakh/scripts.json when present", async () => {
    workspaceMocks.statFileMock.mockResolvedValue({
      ok: true,
      data: { exists: true, path: "/repo/.rakh/scripts.json", kind: "file" },
    });
    workspaceMocks.readFileMock.mockResolvedValue({
      ok: true,
      data: {
        content: JSON.stringify({
          setupCommand: "npm install",
          commands: [
            {
              id: "run",
              label: "Run app",
              command: "npm run dev",
              icon: "play_arrow",
              showLabel: false,
            },
          ],
        }),
      },
    });

    await expect(loadProjectScriptsConfig("/repo")).resolves.toEqual({
      exists: true,
      config: {
        setupCommand: "npm install",
        commands: [
          {
            id: "run",
            label: "Run app",
            command: "npm run dev",
            icon: "play_arrow",
            showLabel: false,
          },
        ],
      },
    });
  });

  it("writes normalized config to .rakh/scripts.json", async () => {
    workspaceMocks.writeFileMock.mockResolvedValue({
      ok: true,
      data: {
        path: "/repo/.rakh/scripts.json",
        bytesWritten: 128,
        created: true,
        overwritten: true,
      },
    });

    await writeProjectScriptsConfig("/repo", {
      setupCommand: "  npm install  ",
      commands: [
        {
          id: "run",
          label: "  Run app  ",
          command: "  npm run dev  ",
          icon: "  play_arrow  ",
          showLabel: false,
        },
      ],
    });

    expect(workspaceMocks.writeFileMock).toHaveBeenCalledWith("/repo", {
      path: ".rakh/scripts.json",
      content: `${JSON.stringify(
        {
          setupCommand: "npm install",
          commands: [
            {
              id: "run",
              label: "Run app",
              command: "npm run dev",
              icon: "play_arrow",
              showLabel: false,
            },
          ],
        },
        null,
        2,
      )}\n`,
      mode: "create_or_overwrite",
      createDirs: true,
    });
  });
});
