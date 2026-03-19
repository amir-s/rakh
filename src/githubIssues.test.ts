import { beforeEach, describe, expect, it, vi } from "vitest";

const execMocks = vi.hoisted(() => ({
  execRunMock: vi.fn(),
}));

vi.mock("@/agent/tools/exec", () => ({
  execRun: (...args: unknown[]) => execMocks.execRunMock(...args),
}));

import {
  getGitHubIssueDetailsSnapshot,
  getGitHubIssuesSnapshot,
  loadGitHubIssueDetails,
  refreshGitHubIssues,
  resetGitHubIssuesCache,
  searchGitHubIssues,
} from "./githubIssues";

function okExec(stdout: string) {
  return {
    ok: true as const,
    data: {
      command: "gh",
      args: [],
      cwd: "/repo",
      exitCode: 0,
      durationMs: 1,
      stdout,
      stderr: "",
      truncatedStdout: false,
      truncatedStderr: false,
    },
  };
}

function deferredResult<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("githubIssues", () => {
  beforeEach(() => {
    execMocks.execRunMock.mockReset();
    resetGitHubIssuesCache();
  });

  it("caches refreshed issues by repository", async () => {
    execMocks.execRunMock.mockResolvedValueOnce(
      okExec(
        JSON.stringify([
          {
            number: 42,
            title: "Fix auth timeout",
            state: "OPEN",
            updatedAt: "2026-03-17T00:26:04Z",
            url: "https://github.com/acme/repo/issues/42",
            author: { login: "amir-s" },
            labels: [{ name: "bug" }],
            assignees: [{ login: "owner" }],
          },
        ]),
      ),
    );

    const snapshot = await refreshGitHubIssues("/repo", "acme/repo");

    expect(snapshot.issues).toEqual([
      {
        number: 42,
        title: "Fix auth timeout",
        state: "OPEN",
        updatedAt: "2026-03-17T00:26:04Z",
        url: "https://github.com/acme/repo/issues/42",
        authorLogin: "amir-s",
        labels: ["bug"],
        assignees: ["owner"],
      },
    ]);
    expect(snapshot.lastFetchError).toBeNull();
    expect(getGitHubIssuesSnapshot("acme/repo").issues).toHaveLength(1);
  });

  it("dedupes in-flight refreshes", async () => {
    const deferred = deferredResult<ReturnType<typeof okExec>>();
    execMocks.execRunMock.mockReturnValueOnce(deferred.promise);

    const first = refreshGitHubIssues("/repo", "acme/repo");
    const second = refreshGitHubIssues("/repo", "acme/repo");

    expect(execMocks.execRunMock).toHaveBeenCalledTimes(1);

    deferred.resolve(
      okExec(
        JSON.stringify([
          {
            number: 1,
            title: "One",
            state: "OPEN",
            updatedAt: "2026-03-17T00:26:04Z",
            url: "https://github.com/acme/repo/issues/1",
            author: { login: "amir-s" },
            labels: [],
            assignees: [],
          },
        ]),
      ),
    );

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    expect(firstSnapshot.issues).toHaveLength(1);
    expect(secondSnapshot.issues).toHaveLength(1);
  });

  it("caches issue details after the first view fetch", async () => {
    execMocks.execRunMock.mockResolvedValueOnce(
      okExec(
        JSON.stringify({
          number: 42,
          title: "Fix auth timeout",
          body: "## Summary\n\nIssue body",
          state: "OPEN",
          updatedAt: "2026-03-17T00:26:04Z",
          url: "https://github.com/acme/repo/issues/42",
          author: { login: "amir-s" },
          labels: [{ name: "bug" }],
          assignees: [],
        }),
      ),
    );

    const firstSnapshot = await loadGitHubIssueDetails("/repo", "acme/repo", 42);
    const secondSnapshot = await loadGitHubIssueDetails("/repo", "acme/repo", 42);

    expect(execMocks.execRunMock).toHaveBeenCalledTimes(1);
    expect(firstSnapshot.issue?.body).toContain("Issue body");
    expect(secondSnapshot.issue?.body).toContain("Issue body");
    expect(getGitHubIssueDetailsSnapshot("acme/repo", 42).issue?.body).toContain(
      "Issue body",
    );
  });

  it("searches issues through gh with the debounced query", async () => {
    execMocks.execRunMock.mockResolvedValueOnce(
      okExec(
        JSON.stringify([
          {
            number: 7,
            title: "Search result",
            state: "OPEN",
            updatedAt: "2026-03-17T00:26:04Z",
            url: "https://github.com/acme/repo/issues/7",
            author: { login: "amir-s" },
            labels: [],
            assignees: [],
          },
        ]),
      ),
    );

    const issues = await searchGitHubIssues("/repo", "acme/repo", "timeout bug");

    expect(execMocks.execRunMock).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        command: "gh",
        args: [
          "issue",
          "list",
          "--repo",
          "acme/repo",
          "--state",
          "open",
          "--limit",
          "1000",
          "--search",
          "timeout bug sort:updated-desc",
          "--json",
          "number,title,state,updatedAt,url,author,labels,assignees",
        ],
      }),
    );
    expect(issues).toEqual([
      {
        number: 7,
        title: "Search result",
        state: "OPEN",
        updatedAt: "2026-03-17T00:26:04Z",
        url: "https://github.com/acme/repo/issues/7",
        authorLogin: "amir-s",
        labels: [],
        assignees: [],
      },
    ]);
  });
});
