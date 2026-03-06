import { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { patchAgentState } from "@/agent/atoms";
import {
  loadArchivedSessions,
  restoreSession,
  deleteSession,
  type PersistedSession,
} from "@/agent/persistence";
import { useTabs } from "@/contexts/TabsContext";
import { cn } from "@/utils/cn";

/* ── Relative time helper ───────────────────────────────────────────────── */
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

/* ── Component ──────────────────────────────────────────────────────────── */
export default function ArchivedTabsMenu() {
  const { addTabWithId } = useTabs();

  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<PersistedSession[]>([]);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const loadArchived = useCallback(async () => {
    const list = await loadArchivedSessions();
    setSessions(list);
  }, []);

  const handleToggle = useCallback(async () => {
    if (open) {
      setOpen(false);
    } else {
      await loadArchived();
      setOpen(true);
    }
  }, [open, loadArchived]);

  // Close when clicking outside
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
      await restoreSession(session);
      try {
        patchAgentState(session.id, {
          status: "idle",
          tabTitle: session.tabTitle,
          config: { cwd: session.cwd, model: session.model },
          plan: {
            markdown: session.planMarkdown,
            version: session.planVersion,
            updatedAtMs: session.planUpdatedAt,
          },
          chatMessages: JSON.parse(session.chatMessages),
          apiMessages: JSON.parse(session.apiMessages),
          todos: JSON.parse(session.todos),
          reviewEdits: JSON.parse(session.reviewEdits ?? "[]"),
          streamingContent: null,
          error: null,
          showDebug: session.showDebug ?? false,
        });
      } catch (e) {
        console.error("rakh: failed to hydrate restored session", e);
      }
      addTabWithId({
        id: session.id,
        label: session.label,
        icon: session.icon,
        status: "idle",
        mode: session.mode as "new" | "workspace",
      });
      setOpen(false);
      setSessions((prev) => prev.filter((s) => s.id !== session.id));
    },
    [addTabWithId],
  );

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

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
          >
            <div className="archived-panel-header">
              <span className="material-symbols-outlined text-md">
                inventory_2
              </span>
              Archived Tabs
            </div>

            {sessions.length === 0 ? (
              <div className="archived-empty">No archived tabs</div>
            ) : (
              <div className="archived-list">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    className="archived-item"
                    onClick={() => handleRestore(session)}
                    title={`Restore: ${session.label}`}
                  >
                    <span
                      className="material-symbols-outlined archived-item-icon"
                      aria-hidden
                    >
                      {session.icon || "chat_bubble_outline"}
                    </span>
                    <span className="archived-item-body">
                      <span className="archived-item-label">
                        {session.label || "Untitled"}
                      </span>
                      {session.tabTitle && (
                        <span className="archived-item-subtitle">
                          {session.tabTitle}
                        </span>
                      )}
                    </span>
                    <span className="archived-item-time">
                      {relativeTime(session.updatedAt)}
                    </span>
                    <span
                      className="archived-item-trash"
                      role="button"
                      tabIndex={0}
                      aria-label={`Delete ${session.label}`}
                      title="Delete permanently"
                      onClick={(e) => handleDelete(session.id, e)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          handleDelete(
                            session.id,
                            e as unknown as React.MouseEvent,
                          );
                        }
                      }}
                    >
                      <span className="material-symbols-outlined text-lg">
                        delete
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
