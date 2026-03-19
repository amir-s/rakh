import { execRun } from "@/agent/tools/exec";

export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: string;
  updatedAt: string;
  url: string;
  authorLogin: string;
  labels: string[];
  assignees: string[];
}

export interface GitHubIssueDetails extends GitHubIssueSummary {
  body: string;
}

export interface GitHubIssuesSnapshot {
  issues: GitHubIssueSummary[] | null;
  lastUpdatedAt: number | null;
  lastFetchError: string | null;
  isRefreshing: boolean;
}

export interface GitHubIssueDetailsSnapshot {
  issue: GitHubIssueDetails | null;
  error: string | null;
  isLoading: boolean;
}

interface IssueDetailsCacheEntry {
  issue: GitHubIssueDetails | null;
  error: string | null;
  promise: Promise<GitHubIssueDetails> | null;
}

interface RepoCacheEntry {
  issues: GitHubIssueSummary[] | null;
  lastUpdatedAt: number | null;
  lastFetchError: string | null;
  refreshPromise: Promise<GitHubIssueSummary[]> | null;
  details: Map<number, IssueDetailsCacheEntry>;
}

type RawIssueUser = {
  login?: unknown;
};

type RawIssueLabel = {
  name?: unknown;
};

type RawIssue = {
  assignees?: unknown;
  author?: unknown;
  body?: unknown;
  labels?: unknown;
  number?: unknown;
  state?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  url?: unknown;
};

const repoCache = new Map<string, RepoCacheEntry>();

function ensureRepoEntry(repoSlug: string): RepoCacheEntry {
  const existing = repoCache.get(repoSlug);
  if (existing) return existing;

  const created: RepoCacheEntry = {
    issues: null,
    lastUpdatedAt: null,
    lastFetchError: null,
    refreshPromise: null,
    details: new Map<number, IssueDetailsCacheEntry>(),
  };
  repoCache.set(repoSlug, created);
  return created;
}

function ensureDetailsEntry(
  repoSlug: string,
  issueNumber: number,
): IssueDetailsCacheEntry {
  const repoEntry = ensureRepoEntry(repoSlug);
  const existing = repoEntry.details.get(issueNumber);
  if (existing) return existing;

  const created: IssueDetailsCacheEntry = {
    issue: null,
    error: null,
    promise: null,
  };
  repoEntry.details.set(issueNumber, created);
  return created;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeUsers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asString((entry as RawIssueUser | null)?.login).trim())
    .filter((entry) => entry.length > 0);
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asString((entry as RawIssueLabel | null)?.name).trim())
    .filter((entry) => entry.length > 0);
}

function normalizeIssueSummary(value: unknown): GitHubIssueSummary | null {
  const issue = value as RawIssue | null;
  if (!issue || typeof issue !== "object") return null;

  const number = asNumber(issue.number);
  const title = asString(issue.title).trim();
  const url = asString(issue.url).trim();
  const updatedAt = asString(issue.updatedAt).trim();
  const state = asString(issue.state).trim();
  if (number == null || !title || !url || !updatedAt || !state) return null;

  return {
    number,
    title,
    state,
    updatedAt,
    url,
    authorLogin: asString((issue.author as RawIssueUser | null)?.login).trim(),
    labels: normalizeLabels(issue.labels),
    assignees: normalizeUsers(issue.assignees),
  };
}

function normalizeIssueDetails(value: unknown): GitHubIssueDetails | null {
  const summary = normalizeIssueSummary(value);
  if (!summary) return null;

  const issue = value as RawIssue;
  return {
    ...summary,
    body: asString(issue.body),
  };
}

function parseIssueList(stdout: string): GitHubIssueSummary[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid GitHub issues payload.");
  }

  return parsed
    .map((entry) => normalizeIssueSummary(entry))
    .filter((entry): entry is GitHubIssueSummary => entry !== null);
}

function parseIssueDetails(stdout: string): GitHubIssueDetails {
  const parsed = JSON.parse(stdout) as unknown;
  const issue = normalizeIssueDetails(parsed);
  if (!issue) {
    throw new Error("Invalid GitHub issue details payload.");
  }
  return issue;
}

async function runGhJsonCommand(
  cwd: string,
  args: string[],
  maxStdoutBytes: number,
): Promise<string> {
  const result = await execRun(cwd, {
    command: "gh",
    args,
    timeoutMs: 20_000,
    maxStdoutBytes,
    maxStderrBytes: 200_000,
  });

  if (!result.ok || result.data.exitCode !== 0) {
    throw new Error("Failed to load issues");
  }

  return result.data.stdout;
}

function buildIssueListArgs(repoSlug: string, searchQuery: string): string[] {
  return [
    "issue",
    "list",
    "--repo",
    repoSlug,
    "--state",
    "open",
    "--limit",
    "1000",
    "--search",
    searchQuery,
    "--json",
    "number,title,state,updatedAt,url,author,labels,assignees",
  ];
}

function buildSnapshot(repoSlug: string): GitHubIssuesSnapshot {
  const entry = ensureRepoEntry(repoSlug);
  return {
    issues: entry.issues,
    lastUpdatedAt: entry.lastUpdatedAt,
    lastFetchError: entry.lastFetchError,
    isRefreshing: entry.refreshPromise !== null,
  };
}

function buildDetailsSnapshot(
  repoSlug: string,
  issueNumber: number,
): GitHubIssueDetailsSnapshot {
  const entry = ensureDetailsEntry(repoSlug, issueNumber);
  return {
    issue: entry.issue,
    error: entry.error,
    isLoading: entry.promise !== null,
  };
}

export function resetGitHubIssuesCache(): void {
  repoCache.clear();
}

export function getGitHubIssuesSnapshot(repoSlug: string): GitHubIssuesSnapshot {
  return buildSnapshot(repoSlug);
}

export function getGitHubIssueDetailsSnapshot(
  repoSlug: string,
  issueNumber: number,
): GitHubIssueDetailsSnapshot {
  return buildDetailsSnapshot(repoSlug, issueNumber);
}

export async function refreshGitHubIssues(
  cwd: string,
  repoSlug: string,
): Promise<GitHubIssuesSnapshot> {
  const entry = ensureRepoEntry(repoSlug);
  if (!entry.refreshPromise) {
    entry.refreshPromise = runGhJsonCommand(
      cwd,
      buildIssueListArgs(repoSlug, "sort:updated-desc"),
      1_500_000,
    )
      .then((stdout) => {
        const issues = parseIssueList(stdout);
        entry.issues = issues;
        entry.lastUpdatedAt = Date.now();
        entry.lastFetchError = null;
        return issues;
      })
      .catch((error) => {
        entry.lastFetchError =
          error instanceof Error && error.message.trim()
            ? error.message
            : "Failed to load issues";
        throw error;
      })
      .finally(() => {
        entry.refreshPromise = null;
      });
  }

  try {
    await entry.refreshPromise;
  } catch {
    // Callers inspect the snapshot for cached data and error state.
  }

  return buildSnapshot(repoSlug);
}

export async function searchGitHubIssues(
  cwd: string,
  repoSlug: string,
  query: string,
): Promise<GitHubIssueSummary[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const stdout = await runGhJsonCommand(
    cwd,
    buildIssueListArgs(repoSlug, `${trimmedQuery} sort:updated-desc`),
    1_500_000,
  );
  return parseIssueList(stdout);
}

export async function loadGitHubIssueDetails(
  cwd: string,
  repoSlug: string,
  issueNumber: number,
): Promise<GitHubIssueDetailsSnapshot> {
  const entry = ensureDetailsEntry(repoSlug, issueNumber);
  if (!entry.issue && !entry.promise) {
    entry.promise = runGhJsonCommand(
      cwd,
      [
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repoSlug,
        "--json",
        "number,title,body,state,updatedAt,url,author,labels,assignees",
      ],
      500_000,
    )
      .then((stdout) => {
        const issue = parseIssueDetails(stdout);
        entry.issue = issue;
        entry.error = null;
        return issue;
      })
      .catch((error) => {
        entry.error =
          error instanceof Error && error.message.trim()
            ? error.message
            : "Failed to load issues";
        throw error;
      })
      .finally(() => {
        entry.promise = null;
      });
  }

  try {
    await entry.promise;
  } catch {
    // Callers inspect the snapshot for cached data and error state.
  }

  return buildDetailsSnapshot(repoSlug, issueNumber);
}
