import {
  useEffect,
  useState,
  useRef,
  useCallback,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTabs, type Tab } from "@/contexts/TabsContext";
import { useAtomValue } from "jotai";
import { motion, AnimatePresence } from "framer-motion";
import {
  appUpdaterStateAtom,
  agentChatMessagesAtomFamily,
  agentConfigAtomFamily,
  agentStatusAtomFamily,
  agentTabTitleAtomFamily,
  debugModeEnabledAtom,
  jotaiStore,
} from "@/agent/atoms";
import {
  resolveWorkspaceDisplayStatus,
  type WorkspaceDisplayStatus,
} from "@/agent/desktopStatus";
import { restoreMostRecentArchivedTab } from "@/agent/sessionRestore";
import CloseTabModal from "@/components/CloseTabModal";
import ArchivedTabsMenu from "@/components/ArchivedTabsMenu";
import { cn } from "@/utils/cn";
import { shouldShowAppUpdateBadge } from "@/updater";
import {
  DEFAULT_LOG_LIMIT,
  DEFAULT_LOG_VIEWER_LEVELS,
  openLogViewerWindow,
} from "@/logging/window";

/* ── Types ──────────────────────────────────────────────────────────────── */
type Platform = "mac" | "windows" | "other";

function detectPlatform(): Platform {
  const p = (navigator.platform ?? "").toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (p.startsWith("mac") || ua.includes("mac os")) return "mac";
  if (p.startsWith("win") || ua.includes("windows")) return "windows";
  return "other";
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

function getWorkspaceName(cwd: string, branch?: string): string {
  const trimmedCwd = cwd.trim();
  if (!trimmedCwd) return "Workspace";
  const folder = trimmedCwd.split("/").filter(Boolean).pop() ?? trimmedCwd;
  return branch ? `${folder} [${branch}]` : folder;
}

function WorkspaceTabPopoverContent({
  tabId,
  mode,
}: {
  tabId: string;
  mode: Extract<Tab["mode"], "new" | "workspace">;
}) {
  const config = useAtomValue(agentConfigAtomFamily(tabId));
  const tabTitle = useAtomValue(agentTabTitleAtomFamily(tabId));
  const status = useAtomValue(agentStatusAtomFamily(tabId));
  const chatMessages = useAtomValue(agentChatMessagesAtomFamily(tabId));

  const workspaceName =
    mode === "new"
      ? "New session"
      : getWorkspaceName(config.cwd, config.worktreeBranch);
  const trimmedTitle = tabTitle.trim();
  const tooltipStatus: WorkspaceDisplayStatus | null = resolveWorkspaceDisplayStatus(
    status,
    chatMessages,
    trimmedTitle,
  );

  return (
    <>
      <div className="tab-popover__header">
        <div className="tab-popover__workspace">{workspaceName}</div>
        {tooltipStatus ? (
          <div className="tab-popover__status">
            <span
              className="tab-popover__status-pill"
              data-tone={tooltipStatus.tone}
            >
              {tooltipStatus.label}
            </span>
          </div>
        ) : null}
      </div>
      {trimmedTitle ? (
        <div className="tab-popover__title">{trimmedTitle}</div>
      ) : null}
    </>
  );
}

function SettingsTabPopoverContent() {
  return (
    <>
      <div className="tab-popover__header">
        <div className="tab-popover__workspace">Application</div>
      </div>
      <div className="tab-popover__title">Settings</div>
    </>
  );
}

function TabPopoverContent({
  tabId,
  mode,
}: {
  tabId: string;
  mode: Tab["mode"];
}) {
  if (mode === "settings") {
    return <SettingsTabPopoverContent />;
  }

  return <WorkspaceTabPopoverContent tabId={tabId} mode={mode} />;
}

/* ── Windows SVG icons ──────────────────────────────────────────────────── */
const IconMinimize = () => (
  <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor" aria-hidden>
    <rect width="10" height="1" />
  </svg>
);
const IconMaximize = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1"
    aria-hidden
  >
    <rect x="0.5" y="0.5" width="9" height="9" />
  </svg>
);
const IconRestore = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1"
    aria-hidden
  >
    <path d="M2.5 0.5h7v7" />
    <rect x="0.5" y="2.5" width="7" height="7" />
  </svg>
);
const IconClose = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    aria-hidden
  >
    <line x1="0" y1="0" x2="10" y2="10" />
    <line x1="10" y1="0" x2="0" y2="10" />
  </svg>
);

/* ── Component ──────────────────────────────────────────────────────────── */
export default function TopChrome() {
  const {
    tabs,
    activeTabId,
    setActiveTab,
    addTab,
    addTabWithId,
    openSettingsTab,
    closeTab,
    updateTab,
    reorderTabs,
  } = useTabs();
  const appUpdater = useAtomValue(appUpdaterStateAtom);
  const debugModeEnabled = useAtomValue(debugModeEnabledAtom);
  const showUpdateBadge = shouldShowAppUpdateBadge(appUpdater);

  // ── Close-confirmation modal ──────────────────────────────────────────
  const [closeConfirmTabId, setCloseConfirmTabId] = useState<string | null>(
    null,
  );

  const isTabAgentRunning = useCallback((tabId: string) => {
    const status = jotaiStore.get(agentStatusAtomFamily(tabId));
    return status === "thinking" || status === "working";
  }, []);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.mode === "workspace" && isTabAgentRunning(tabId)) {
        setCloseConfirmTabId(tabId);
      } else {
        closeTab(tabId);
      }
    },
    [tabs, isTabAgentRunning, closeTab],
  );

  // ── Drag-and-drop tab reordering (pointer-based, live reorder) ───────
  // Ref holds the dragged tab ID synchronously; state drives the CSS class.
  const dragTabIdRef = useRef<string | null>(null);
  const [dragTabId, setDragTabId] = useState<string | null>(null);

  // End drag on pointer up anywhere (including outside the window)
  useEffect(() => {
    const endDrag = () => {
      if (dragTabIdRef.current !== null) {
        dragTabIdRef.current = null;
        setDragTabId(null);
      }
    };
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  // Grabbing cursor + block text selection while dragging
  useEffect(() => {
    if (!dragTabId) return;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragTabId]);

  // ── Tab-list hover popover ────────────────────────────────────────────
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const [popoverActive, setPopoverActive] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const tabRefs = useRef<Map<string, HTMLElement>>(new Map());

  const handleTabMouseEnter = (tabId: string) => {
    if (dragTabIdRef.current) return; // don't show popover while dragging
    setHoveredTabId(tabId);
    if (popoverActive) return;
    hoverTimeoutRef.current = setTimeout(() => setPopoverActive(true), 500);
  };

  const handleTabMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  };

  const handleTabListMouseLeave = () => {
    setHoveredTabId(null);
    setPopoverActive(false);
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  // ── Window state ─────────────────────────────────────────────────────
  const [platform, setPlatform] = useState<Platform>("other");
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFocused, setIsFocused] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const isMac = platform === "mac";

      if (e.ctrlKey && key === "tab" && !e.shiftKey) {
        e.preventDefault();
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        setActiveTab(tabs[(idx + 1) % tabs.length].id);
        return;
      }
      if (e.ctrlKey && key === "tab" && e.shiftKey) {
        e.preventDefault();
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && key === "t") {
        e.preventDefault();
        addTab();
        return;
      }
      if (
        ((isMac && e.metaKey && !e.ctrlKey) ||
          (!isMac && e.ctrlKey && !e.metaKey)) &&
        !e.altKey &&
        !e.shiftKey &&
        key === ","
      ) {
        e.preventDefault();
        openSettingsTab();
        return;
      }
      if (
        ((isMac && e.metaKey && !e.ctrlKey) ||
          (!isMac && e.ctrlKey && !e.metaKey)) &&
        !e.altKey &&
        e.shiftKey &&
        key === "t"
      ) {
        e.preventDefault();
        void restoreMostRecentArchivedTab(addTabWithId);
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && key === "w") {
        e.preventDefault();
        const activeTab = tabs.find((t) => t.id === activeTabId);
        if (tabs.length === 1 && activeTab?.mode === "new") {
          if (isTauriRuntime()) {
            import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
              getCurrentWindow().close(),
            );
          }
        } else {
          handleCloseTab(activeTabId);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    tabs,
    activeTabId,
    setActiveTab,
    addTab,
    addTabWithId,
    openSettingsTab,
    handleCloseTab,
    platform,
  ]);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      setIsMaximized(await win.isMaximized());
      setIsFocused(await win.isFocused());
      setIsFullscreen(await win.isFullscreen());
      unlisteners.push(
        await win.listen("tauri://focus", () => setIsFocused(true)),
      );
      unlisteners.push(
        await win.listen("tauri://blur", () => setIsFocused(false)),
      );
      unlisteners.push(
        await win.listen("tauri://resize", async () => {
          const [max, fs] = await Promise.all([
            win.isMaximized(),
            win.isFullscreen(),
          ]);
          setIsMaximized(max);
          setIsFullscreen(fs);
        }),
      );
    })();
    return () => unlisteners.forEach((fn) => fn());
  }, []);

  const callWindow = useCallback(
    async (action: "minimize" | "toggleMaximize" | "close") => {
      if (!isTauriRuntime()) return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow()[action]();
    },
    [],
  );

  const handleHeaderDoubleClick = useCallback(
    (_event: ReactMouseEvent<HTMLElement>) => {
      if (platform === "mac") return;
      void callWindow("toggleMaximize");
    },
    [callWindow, platform],
  );

  const isMac = platform === "mac";
  const isWin = platform === "windows";
  const closeConfirmTab = closeConfirmTabId
    ? tabs.find((t) => t.id === closeConfirmTabId)
    : null;

  return (
    <>
      <header
        data-tauri-drag-region
        className="top-chrome"
        data-focused={isFocused ? "true" : "false"}
        data-fullscreen={isFullscreen ? "true" : "false"}
        data-platform={platform}
        onDoubleClick={handleHeaderDoubleClick}
      >
        {/* macOS traffic-light spacer */}
        {isMac && !isFullscreen && (
          <div
            className="traffic-light-spacer"
            data-tauri-drag-region
            aria-hidden
          />
        )}

        {/* ── Tab list ──────────────────────────────────────────────── */}
        <div
          className="tab-list"
          role="tablist"
          data-tauri-drag-region
          onMouseLeave={handleTabListMouseLeave}
        >
          <AnimatePresence initial={false}>
            {tabs.map((tab) => (
              <motion.div
                layout="position"
                initial={{ maxWidth: 0, overflow: "hidden" }}
                animate={{ maxWidth: 200, overflow: "hidden" }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                key={tab.id}
                role="tab"
                aria-selected={tab.id === activeTabId}
                className={cn(
                  "tab",
                  tab.id === activeTabId && "tab--active",
                  dragTabId === tab.id && "tab--dragging",
                )}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  if (e.button === 1) {
                    e.preventDefault();
                  }
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (e.button !== 0) return;
                  dragTabIdRef.current = tab.id;
                  setDragTabId(tab.id);
                }}
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  e.stopPropagation();
                  handleCloseTab(tab.id);
                }}
                onPointerEnter={() => {
                  if (!dragTabIdRef.current || dragTabIdRef.current === tab.id)
                    return;
                  const fromIndex = tabs.findIndex(
                    (t) => t.id === dragTabIdRef.current,
                  );
                  const targetIndex = tabs.findIndex((t) => t.id === tab.id);
                  if (fromIndex === -1 || targetIndex === -1) return;
                  const toIndex =
                    targetIndex > fromIndex ? targetIndex + 1 : targetIndex;
                  reorderTabs(fromIndex, toIndex);
                }}
                onClick={() => {
                  if (dragTabIdRef.current) return; // swallow clicks from drag
                  setActiveTab(tab.id);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (tab.mode !== "workspace") return;
                  updateTab(tab.id, { pinned: !tab.pinned });
                }}
                onMouseEnter={() => handleTabMouseEnter(tab.id)}
                onMouseLeave={handleTabMouseLeave}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                data-pinned={tab.pinned ? "true" : "false"}
              >
                <span
                  className={cn("tab-dot", `tab-dot--${tab.status}`)}
                  aria-label={tab.status}
                />
                <span
                  className="material-symbols-outlined tab-icon"
                  aria-hidden
                >
                  {tab.icon}
                </span>
                <span className="tab-label" suppressHydrationWarning>
                  {tab.label || "\u00a0"}
                </span>
                <span
                  className={cn(
                    "material-symbols-outlined tab-pin-indicator",
                    tab.pinned && "tab-pin-indicator--active",
                  )}
                  aria-hidden
                  title={tab.pinned ? "Pinned" : undefined}
                >
                  keep
                </span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  aria-label={tab.label ? `Close ${tab.label}` : "Close tab"}
                  title={tab.label ? `Close ${tab.label}` : "Close tab"}
                >
                  ×
                </button>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* ── Tab title popover ──────────────────────────────────── */}
          <AnimatePresence>
            {popoverActive &&
              hoveredTabId &&
              (() => {
                const tab = tabs.find((t) => t.id === hoveredTabId);
                const tabEl = tabRefs.current.get(hoveredTabId);
                if (!tab || !tabEl) return null;
                const rect = tabEl.getBoundingClientRect();
                return (
                  <motion.div
                    key="tab-popover"
                    className="tab-popover"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
                    style={{
                      position: "fixed",
                      left: `${rect.left}px`,
                      top: `${rect.bottom + 6}px`,
                      transform: "translateX(-50%)",
                      pointerEvents: "none",
                      zIndex: 10000,
                    }}
                  >
                    <TabPopoverContent tabId={tab.id} mode={tab.mode} />
                  </motion.div>
                );
              })()}
          </AnimatePresence>

          {/* ── New-tab button ─────────────────────────────────────── */}
          <button
            className="tab-new-btn"
            onClick={() => addTab()}
            aria-label="New session"
            title="New session"
          >
            +
          </button>
        </div>

        {/* ── Settings Controls ──────────────────────────────────────── */}
        <div
          className="win-controls"
          aria-label="App controls"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ArchivedTabsMenu />
          {debugModeEnabled ? (
            <button
              className="win-btn w-9"
              onClick={() =>
                void openLogViewerWindow({
                  origin: "manual",
                  filter: {
                    limit: DEFAULT_LOG_LIMIT,
                    levels: DEFAULT_LOG_VIEWER_LEVELS,
                  },
                  tailEnabled: true,
                })
              }
              aria-label="Open log viewer"
              title="Open log viewer"
            >
              <span className="material-symbols-outlined text-lg">receipt_long</span>
            </button>
          ) : null}
          <button
            className="win-btn w-9 relative"
            onClick={() => openSettingsTab()}
            title="Settings"
          >
            <span className="material-symbols-outlined text-lg">settings</span>
            {showUpdateBadge && (
              <span
                className="absolute right-[10px] top-[10px] h-2 w-2 rounded-full bg-primary"
                data-testid="settings-update-badge"
                aria-hidden="true"
              />
            )}
          </button>
        </div>

        {/* ── Windows controls ───────────────────────────────────────── */}
        {isWin && (
          <div
            className="win-controls"
            aria-label="Window controls"
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <button
              className="win-btn win-btn--minimize"
              onClick={() => void callWindow("minimize")}
              title="Minimise"
            >
              <IconMinimize />
            </button>
            <button
              className={cn(
                "win-btn win-btn--maximize",
                isMaximized && "win-btn--restore",
              )}
              onClick={() => void callWindow("toggleMaximize")}
              title={isMaximized ? "Restore" : "Maximise"}
            >
              {isMaximized ? <IconRestore /> : <IconMaximize />}
            </button>
            <button
              className="win-btn win-btn--close"
              onClick={() => void callWindow("close")}
              title="Close"
            >
              <IconClose />
            </button>
          </div>
        )}
      </header>

      {/* ── Close-confirmation modal ─────────────────────────────────── */}
      {closeConfirmTabId && closeConfirmTab && (
        <CloseTabModal
          tabLabel={closeConfirmTab.label}
          onCancel={() => setCloseConfirmTabId(null)}
          onConfirm={() => {
            const id = closeConfirmTabId;
            setCloseConfirmTabId(null);
            closeTab(id);
          }}
        />
      )}
    </>
  );
}
