import { beforeEach, describe, expect, it, vi } from "vitest";

const execMocks = vi.hoisted(() => ({
  execRunMock: vi.fn(),
}));

vi.mock("@/agent/tools/exec", () => ({
  execRun: (...args: unknown[]) => execMocks.execRunMock(...args),
}));

import {
  parseGitHubRepoSlug,
  probeGitHubRepository,
} from "./githubIntegration";

function okExec(stdout: string, exitCode = 0) {
  return {
    ok: true as const,
    data: {
      command: "git",
      args: [],
      cwd: "/repo",
      exitCode,
      durationMs: 1,
      stdout,
      stderr: "",
      truncatedStdout: false,
      truncatedStderr: false,
    },
  };
}

describe("githubIntegration", () => {
  beforeEach(() => {
    execMocks.execRunMock.mockReset();
  });

  it("parses https and ssh GitHub remotes", () => {
    expect(parseGitHubRepoSlug("https://github.com/acme/repo.git")).toBe(
      "acme/repo",
    );
    expect(parseGitHubRepoSlug("git@github.com:acme/repo.git")).toBe(
      "acme/repo",
    );
    expect(parseGitHubRepoSlug("git@gitlab.com:acme/repo.git")).toBeNull();
  });

  it("reports eligible GitHub repositories", async () => {
    execMocks.execRunMock
      .mockResolvedValueOnce(okExec("/repo\n"))
      .mockResolvedValueOnce(okExec("git@github.com:acme/repo.git\n"));

    await expect(probeGitHubRepository("/repo/src")).resolves.toEqual({
      eligible: true,
      reason: "eligible",
      repoRoot: "/repo",
      repoSlug: "acme/repo",
      remoteUrl: "git@github.com:acme/repo.git",
    });
  });

  it("reports non-git directories as ineligible", async () => {
    execMocks.execRunMock.mockResolvedValueOnce(okExec("", 128));

    await expect(probeGitHubRepository("/tmp")).resolves.toEqual({
      eligible: false,
      reason: "not_git",
      repoRoot: null,
      repoSlug: null,
      remoteUrl: null,
    });
  });
});
