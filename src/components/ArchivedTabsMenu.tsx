import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { restoreArchivedTab } from "@/agent/sessionRestore";
import {
  loadArchivedSessions,
  deleteSession,
  type PersistedSession,
} from "@/agent/persistence";
import { useTabs } from "@/contexts/TabsContext";
import { Badge, TextField } from "@/components/ui";
import {
  buildArchivedSessionItems,
  groupArchivedSessionItems,
  searchArchivedSessionItems,
  type ArchivedSessionItem,
} from "@/components/archivedTabsMenuModel";
import { cn } from "@/utils/cn";

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getGroupedSubtitle(item: ArchivedSessionItem): string | null {
  const subtitle = item.session.tabTitle.trim();
  return subtitle || null;
}

function getSearchSubtitle(item: ArchivedSessionItem): string {
  const parts = [item.projectLabel];
  const tabTitle = item.session.tabTitle.trim();
  if (tabTitle) {
    parts.push(tabTitle);
  }
  return parts.join(" · ");
}

function ArchivedSessionRow({
  item,
  subtitle,
  onDelete,
  onRestore,
}: {
  item: ArchivedSessionItem;
  subtitle: string | null;
  onDelete: (id: string) => Promise<void>;
  onRestore: (session: PersistedSession) => Promise<void>;
}) {
  const label = item.session.label || "Untitled";

  return (
    <div className="archived-item">
      <button
        className="archived-item-main"
        onClick={() => void onRestore(item.session)}
        title={`Restore: ${label}`}
      >
        <span
          className="material-symbols-outlined archived-item-icon"
          aria-hidden
        >
          {item.session.icon || "chat_bubble_outline"}
        </span>
        <span className="archived-item-body">
          <span className="archived-item-label">{label}</span>
          {subtitle ? (
            <span className="archived-item-subtitle">{subtitle}</span>
          ) : null}
        </span>
        <span className="archived-item-time">
          {relativeTime(item.session.updatedAt)}
        </span>
      </button>

      <button
        className="archived-item-trash"
        aria-label={`Delete ${label}`}
        title="Delete permanently"
        onClick={() => void onDelete(item.session.id)}
      >
        <span className="material-symbols-outlined text-lg">delete</span>
      </button>
    </div>
  );
}

export default function ArchivedTabsMenu() {
  const { addTabWithId } = useTabs();

  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<PersistedSession[]>([]);
  const [query, setQuery] = useState("");
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const archivedItems = useMemo(
    () => buildArchivedSessionItems(sessions),
    [sessions],
  );
  const archivedGroups = useMemo(
    () => groupArchivedSessionItems(archivedItems),
    [archivedItems],
  );
  const trimmedQuery = query.trim();
  const searchResults = useMemo(
    () =>
      trimmedQuery ? searchArchivedSessionItems(archivedItems, trimmedQuery) : [],
    [archivedItems, trimmedQuery],
  );

  const resetMenuState = useCallback(() => {
    setQuery("");
    setCollapsedProjectKeys(new Set());
  }, []);

  const loadArchived = useCallback(async () => {
    const list = await loadArchivedSessions();
    setSessions(list);
  }, []);

  const handleToggle = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }

    resetMenuState();
    await loadArchived();
    setOpen(true);
  }, [loadArchived, open, resetMenuState]);

  useEffect(() => {
    if (!open) return;

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const handleRestore = useCallback(
    async (session: PersistedSession) => {
      await restoreArchivedTab(session, addTabWithId);
      setOpen(false);
      setSessions((prev) => prev.filter((s) => s.id !== session.id));
    },
    [addTabWithId],
  );

  const handleDelete = useCallback(async (id: string) => {
    await deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleProjectToggle = useCallback((key: string) => {
    setCollapsedProjectKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handlePanelKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();

      if (query.trim()) {
        setQuery("");
        return;
      }

      setOpen(false);
    },
    [query],
  );

  return (
    <div className="archived-menu-wrap">
      <button
        ref={btnRef}
        className={cn(
          "win-btn w-9 archived-menu-btn",
          open && "archived-menu-btn--active",
        )}
        onClick={handleToggle}
        title="Archived tabs"
        aria-label="Archived tabs"
        aria-expanded={open}
      >
        <span className="material-symbols-outlined text-lg">more_horiz</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            className="archived-panel"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            onKeyDown={handlePanelKeyDown}
          >
            <div className="archived-panel-header">
              <span className="material-symbols-outlined text-md">
                inventory_2
              </span>
              Archived Tabs
            </div>

            <div className="archived-panel-search">
              <TextField
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search archived tabs"
                aria-label="Search archived tabs"
                autoComplete="off"
                spellCheck={false}
                wrapClassName="archived-search-field"
                startAdornment={
                  <span
                    className="material-symbols-outlined archived-search-icon"
                    aria-hidden
                  >
                    search
                  </span>
                }
              />
            </div>

            {sessions.length === 0 ? (
              <div className="archived-empty">No archived tabs</div>
            ) : trimmedQuery ? (
              searchResults.length === 0 ? (
                <div className="archived-empty">No archived tabs match</div>
              ) : (
                <div className="archived-list archived-list--search">
                  {searchResults.map((item) => (
                    <ArchivedSessionRow
                      key={item.session.id}
                      item={item}
                      subtitle={getSearchSubtitle(item)}
                      onDelete={handleDelete}
                      onRestore={handleRestore}
                    />
                  ))}
                </div>
              )
            ) : (
              <div className="archived-list archived-list--grouped">
                {archivedGroups.map((group) => {
                  const collapsed = collapsedProjectKeys.has(group.key);

                  return (
                    <section key={group.key} className="archived-group">
                      <button
                        className="archived-group-toggle"
                        onClick={() => handleProjectToggle(group.key)}
                        aria-expanded={!collapsed}
                        title={group.label}
                      >
                        <span
                          className={cn(
                            "material-symbols-outlined archived-group-chevron",
                            collapsed && "archived-group-chevron--collapsed",
                          )}
                          aria-hidden
                        >
                          expand_more
                        </span>
                        <span className="archived-group-body">
                          <span className="archived-group-title-row">
                            <span className="archived-group-label">
                              {group.label}
                            </span>
                            <Badge variant="muted">{group.count}</Badge>
                          </span>
                          {group.path ? (
                            <span className="archived-group-path">
                              {group.path}
                            </span>
                          ) : null}
                        </span>
                      </button>

                      {!collapsed ? (
                        <div className="archived-group-list">
                          {group.sessions.map((item) => (
                            <ArchivedSessionRow
                              key={item.session.id}
                              item={item}
                              subtitle={getGroupedSubtitle(item)}
                              onDelete={handleDelete}
                              onRestore={handleRestore}
                            />
                          ))}
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
