import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import Markdown from "@/components/Markdown";
import { Button, ModalShell, TextField } from "@/components/ui";
import {
  getGitHubIssueDetailsSnapshot,
  getGitHubIssuesSnapshot,
  loadGitHubIssueDetails,
  refreshGitHubIssues,
  searchGitHubIssues,
  type GitHubIssueDetailsSnapshot,
  type GitHubIssueSummary,
} from "@/githubIssues";

const ISSUE_BATCH_SIZE = 20;
const LOAD_MORE_THRESHOLD_PX = 64;
const SEARCH_DEBOUNCE_MS = 300;

interface GitHubIssuesControlProps {
  cwd: string;
  repoSlug: string;
}

interface PopoverPosition {
  top: number;
  left: number;
  width: number;
}

interface GitHubIssueSearchState {
  issues: GitHubIssueSummary[] | null;
  error: string | null;
  isSearching: boolean;
}

function createEmptyDetailsSnapshot(): GitHubIssueDetailsSnapshot {
  return {
    issue: null,
    error: null,
    isLoading: false,
  };
}

function createEmptySearchState(): GitHubIssueSearchState {
  return {
    issues: null,
    error: null,
    isSearching: false,
  };
}

function createLoadingDetailsSnapshot(
  repoSlug: string,
  issueNumber: number,
): GitHubIssueDetailsSnapshot {
  const snapshot = getGitHubIssueDetailsSnapshot(repoSlug, issueNumber);
  if (snapshot.issue || snapshot.error || snapshot.isLoading) {
    return snapshot;
  }
  return {
    ...snapshot,
    isLoading: true,
  };
}

function relativeTime(value: number): string {
  const diff = Date.now() - value;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function issueRelativeTime(updatedAt: string): string {
  const ms = Date.parse(updatedAt);
  return Number.isFinite(ms) ? relativeTime(ms) : "";
}

function formatIssueSupplementalInfo(issue: GitHubIssueSummary): string[] {
  const items: string[] = [];
  if (issue.authorLogin) {
    items.push(`@${issue.authorLogin}`);
  }
  const updated = issueRelativeTime(issue.updatedAt);
  if (updated) {
    items.push(updated);
  }
  if (issue.assignees.length === 1) {
    items.push(`assigned to @${issue.assignees[0]}`);
  } else if (issue.assignees.length > 1) {
    items.push(
      `assigned to @${issue.assignees[0]} +${issue.assignees.length - 1}`,
    );
  }
  return items;
}

function getIssueStatePresentation(state: string): {
  icon: string;
  className: string;
} {
  const normalized = state.trim().toUpperCase();
  if (normalized === "OPEN") {
    return {
      icon: "radio_button_checked",
      className: "github-issues-popover__issue-state-icon--open",
    };
  }
  if (normalized === "CLOSED") {
    return {
      icon: "check_circle",
      className: "github-issues-popover__issue-state-icon--closed",
    };
  }
  return {
    icon: "adjust",
    className: "github-issues-popover__issue-state-icon--other",
  };
}

function IssueTitle({
  issue,
  className,
}: {
  issue: GitHubIssueSummary;
  className?: string;
}) {
  const state = getIssueStatePresentation(issue.state);
  return (
    <span className={className}>
      <span
        className={`material-symbols-outlined github-issues-popover__issue-state-icon ${state.className}`}
        aria-hidden="true"
      >
        {state.icon}
      </span>
      <span className="github-issues-popover__item-title-text">{issue.title}</span>
    </span>
  );
}

function GitHubIssueModal({
  issue,
  detailsSnapshot,
  onClose,
}: {
  issue: GitHubIssueSummary;
  detailsSnapshot: GitHubIssueDetailsSnapshot;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const issueDetails = detailsSnapshot.issue;
  const body = issueDetails?.body?.trim() || "_No description provided._";

  return createPortal(
    <div
      className="error-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label={`GitHub issue #${issue.number}`}
    >
      <ModalShell
        className="error-modal tool-modal github-issue-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="error-modal-header">
          <span className="error-modal-title tool-modal-title">
            <span className="material-symbols-outlined text-muted shrink-0 text-md">
              bug_report
            </span>
            Issue #{issue.number}
          </span>
          <Button
            className="error-modal-close"
            onClick={onClose}
            title="Close (Esc)"
            variant="ghost"
            size="xxs"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </Button>
        </div>

        <div className="error-modal-body github-issue-modal__body">
          <div className="tool-modal-section">
            <div className="tool-modal-section-label github-issue-modal__title">
              <IssueTitle
                issue={issue}
                className="github-issues-popover__item-title github-issue-modal__title-inline"
              />
            </div>
            <div className="github-issue-modal__meta">
              {formatIssueSupplementalInfo(issue).map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            {issue.labels.length > 0 ? (
              <div className="github-issues-popover__labels">
                {issue.labels.map((label) => (
                  <span
                    key={label}
                    className="github-issues-popover__label-pill"
                  >
                    {label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="tool-modal-section github-issue-modal__markdown">
            {detailsSnapshot.isLoading ? (
              <div className="github-issues-popover__status">
                <span className="github-issues-popover__spinner" aria-hidden="true" />
                Loading issue…
              </div>
            ) : detailsSnapshot.error && !issueDetails ? (
              <div className="github-issues-popover__status github-issues-popover__status--error">
                Failed to load issues
              </div>
            ) : (
              <Markdown>{body}</Markdown>
            )}
          </div>
        </div>

        <div className="error-modal-footer">
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="github-issue-modal__link"
          >
            Open in GitHub
          </a>
          <Button onClick={onClose} variant="primary" size="xxs">
            CLOSE
          </Button>
        </div>
      </ModalShell>
    </div>,
    document.body,
  );
}

export default function GitHubIssuesControl({
  cwd,
  repoSlug,
}: GitHubIssuesControlProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(
    null,
  );
  const [snapshot, setSnapshot] = useState(() => getGitHubIssuesSnapshot(repoSlug));
  const [visibleCount, setVisibleCount] = useState(ISSUE_BATCH_SIZE);
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssueSummary | null>(
    null,
  );
  const [detailsSnapshot, setDetailsSnapshot] = useState<GitHubIssueDetailsSnapshot>(
    createEmptyDetailsSnapshot,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<GitHubIssueSearchState>(
    createEmptySearchState,
  );
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchRequestIdRef = useRef(0);

  const issues = snapshot.issues ?? [];
  const trimmedSearchQuery = searchQuery.trim();
  const isSearchingIssues = searchOpen && trimmedSearchQuery.length > 0;
  const displayedIssues = isSearchingIssues ? (searchState.issues ?? []) : issues;
  const visibleIssues = displayedIssues.slice(0, visibleCount);

  const refreshIssues = useCallback(() => {
    setSnapshot(getGitHubIssuesSnapshot(repoSlug));
    void refreshGitHubIssues(cwd, repoSlug)
      .then(() => {
        setSnapshot(getGitHubIssuesSnapshot(repoSlug));
      })
      .catch(() => {
        setSnapshot(getGitHubIssuesSnapshot(repoSlug));
      });
    setSnapshot(getGitHubIssuesSnapshot(repoSlug));
  }, [cwd, repoSlug]);

  const resetSearch = useCallback(() => {
    searchRequestIdRef.current += 1;
    setSearchOpen(false);
    setSearchQuery("");
    setSearchState(createEmptySearchState());
    setVisibleCount(ISSUE_BATCH_SIZE);
  }, []);

  const closePopover = useCallback(() => {
    setPopoverOpen(false);
    resetSearch();
  }, [resetSearch]);

  const handleSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextQuery = event.target.value;
      setSearchQuery(nextQuery);
      setVisibleCount(ISSUE_BATCH_SIZE);

      if (!nextQuery.trim()) {
        searchRequestIdRef.current += 1;
        setSearchState(createEmptySearchState());
        return;
      }

      searchRequestIdRef.current += 1;
      setSearchState({
        issues: null,
        error: null,
        isSearching: true,
      });
    },
    [],
  );

  useEffect(() => {
    if (!popoverOpen) return;

    const updatePopoverPosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width + 220, 360), 420);
      setPopoverPosition({
        top: rect.bottom + 8,
        left: Math.max(12, rect.right - width),
        width,
      });
    };

    const handlePointerDown = (event: MouseEvent) => {
      if (
        buttonRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      closePopover();
    };

    updatePopoverPosition();
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [closePopover, popoverOpen]);

  useEffect(() => {
    if (!selectedIssue) return;
    void loadGitHubIssueDetails(cwd, repoSlug, selectedIssue.number)
      .then(() => {
        setDetailsSnapshot(
          getGitHubIssueDetailsSnapshot(repoSlug, selectedIssue.number),
        );
      })
      .catch(() => {
        setDetailsSnapshot(
          getGitHubIssueDetailsSnapshot(repoSlug, selectedIssue.number),
        );
      });
  }, [cwd, repoSlug, selectedIssue]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!popoverOpen || !searchOpen) return;
    if (!trimmedSearchQuery) return;

    const requestId = searchRequestIdRef.current;

    const timeoutId = window.setTimeout(() => {
      void searchGitHubIssues(cwd, repoSlug, trimmedSearchQuery)
        .then((nextIssues) => {
          if (searchRequestIdRef.current !== requestId) return;
          setSearchState({
            issues: nextIssues,
            error: null,
            isSearching: false,
          });
        })
        .catch((error) => {
          if (searchRequestIdRef.current !== requestId) return;
          setSearchState({
            issues: null,
            error:
              error instanceof Error && error.message.trim()
                ? error.message
                : "Failed to load issues",
            isSearching: false,
          });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [cwd, popoverOpen, repoSlug, searchOpen, trimmedSearchQuery]);

  const searchError =
    isSearchingIssues && displayedIssues.length > 0 ? searchState.error : null;
  const baseError =
    !isSearchingIssues && issues.length > 0 ? snapshot.lastFetchError : null;
  const listError = searchError ?? baseError;

  let emptyMessage = "No issues found";
  if (isSearchingIssues) {
    if (searchState.isSearching) {
      emptyMessage = "Searching issues…";
    } else if (searchState.error) {
      emptyMessage = "Failed to load issues";
    }
  } else if (snapshot.isRefreshing) {
    emptyMessage = "Loading latest issues…";
  } else if (snapshot.lastFetchError) {
    emptyMessage = "Failed to load issues";
  }

  const popover =
    popoverOpen && popoverPosition
      ? createPortal(
          <div
            ref={popoverRef}
            className="github-issues-popover"
            role="dialog"
            aria-modal="false"
            aria-label="Recent GitHub issues"
            style={{
              top: `${popoverPosition.top}px`,
              left: `${popoverPosition.left}px`,
              width: `${popoverPosition.width}px`,
            }}
          >
            <div className="github-issues-popover__header">
              {searchOpen ? (
                <>
                  <TextField
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={handleSearchChange}
                    placeholder="Search GitHub issues"
                    aria-label="Search GitHub issues"
                    autoComplete="off"
                    spellCheck={false}
                    wrapClassName="github-issues-popover__search-field github-issues-popover__search-field--inline"
                    startAdornment={
                      <span
                        className="material-symbols-outlined github-issues-popover__search-field-icon"
                        aria-hidden
                      >
                        search
                      </span>
                    }
                    endAdornment={
                      searchState.isSearching ? (
                        <span
                          className="github-issues-popover__spinner github-issues-popover__search-spinner"
                          aria-hidden="true"
                        />
                      ) : null
                    }
                  />
                  <button
                    type="button"
                    className="github-issues-popover__icon-button github-issues-popover__icon-button--active"
                    aria-label="Close issue search"
                    title="Close search"
                    onClick={resetSearch}
                  >
                    <span
                      className="material-symbols-outlined text-base"
                      aria-hidden="true"
                    >
                      close
                    </span>
                  </button>
                </>
              ) : (
                <>
                  <div className="github-issues-popover__header-main">
                    <div className="github-issues-popover__title">Recent issues</div>
                    <div className="github-issues-popover__meta">
                      <span>{repoSlug}</span>
                      {snapshot.lastUpdatedAt ? (
                        <span className="github-issues-popover__meta-status">
                          <span>
                            Last updated {relativeTime(snapshot.lastUpdatedAt)}
                          </span>
                          {snapshot.isRefreshing ? (
                            <span
                              className="github-issues-popover__spinner"
                              aria-hidden="true"
                            />
                          ) : null}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="github-issues-popover__header-actions">
                    <button
                      type="button"
                      className="github-issues-popover__icon-button"
                      aria-label="Search GitHub issues"
                      title="Search issues"
                      onClick={() => {
                        setSearchOpen(true);
                      }}
                    >
                      <span
                        className="material-symbols-outlined text-base"
                        aria-hidden="true"
                      >
                        search
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {listError ? (
              <div className="github-issues-popover__status github-issues-popover__status--error">
                Failed to load issues
              </div>
            ) : null}

            {displayedIssues.length === 0 ? (
              <div className="github-issues-popover__empty">{emptyMessage}</div>
            ) : (
              <div
                className="github-issues-popover__list"
                aria-label="GitHub issues list"
                onScroll={(event) => {
                  const container = event.currentTarget;
                  if (
                    displayedIssues.length <= visibleCount ||
                    container.scrollHeight -
                      container.scrollTop -
                      container.clientHeight >
                      LOAD_MORE_THRESHOLD_PX
                  ) {
                    return;
                  }
                  setVisibleCount((current) =>
                    Math.min(current + ISSUE_BATCH_SIZE, displayedIssues.length),
                  );
                }}
              >
                {visibleIssues.map((issue) => (
                  <button
                    key={issue.number}
                    type="button"
                    className="github-issues-popover__item"
                    onClick={() => {
                      closePopover();
                      setDetailsSnapshot(
                        createLoadingDetailsSnapshot(repoSlug, issue.number),
                      );
                      setSelectedIssue(issue);
                    }}
                  >
                    <div className="github-issues-popover__item-header">
                      <IssueTitle
                        issue={issue}
                        className="github-issues-popover__item-title"
                      />
                      <span className="github-issues-popover__item-number">
                        #{issue.number}
                      </span>
                    </div>
                    <div className="github-issues-popover__item-meta">
                      {formatIssueSupplementalInfo(issue).map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                    {issue.labels.length > 0 ? (
                      <div className="github-issues-popover__labels">
                        {issue.labels.slice(0, 3).map((label) => (
                          <span
                            key={label}
                            className="github-issues-popover__label-pill"
                          >
                            {label}
                          </span>
                        ))}
                        {issue.labels.length > 3 ? (
                          <span className="github-issues-popover__label-pill">
                            +{issue.labels.length - 3}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="project-command-button"
        title="Browse recent GitHub issues"
        aria-label="Open recent GitHub issues"
        onClick={() => {
          const nextOpen = !popoverOpen;
          if (nextOpen) {
            setVisibleCount(ISSUE_BATCH_SIZE);
            refreshIssues();
          } else {
            resetSearch();
          }
          setPopoverOpen(nextOpen);
        }}
      >
        <span className="material-symbols-outlined text-base" aria-hidden="true">
          bug_report
        </span>
        <span className="project-command-button__label">Issues</span>
      </button>
      {popover}
      {selectedIssue ? (
        <GitHubIssueModal
          issue={selectedIssue}
          detailsSnapshot={detailsSnapshot}
          onClose={() => {
            setSelectedIssue(null);
            setDetailsSnapshot(createEmptyDetailsSnapshot());
          }}
        />
      ) : null}
    </>
  );
}
