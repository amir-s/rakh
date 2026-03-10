import { useEffect, useRef, useCallback, useReducer } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebglAddon } from "@xterm/addon-webgl";

import "@xterm/xterm/css/xterm.css";

/* ─────────────────────────────────────────────────────────────────────────────
   Constants
───────────────────────────────────────────────────────────────────────────── */

/** Height when collapsed: 4px resize-handle + 32px header bar */
const HEADER_HEIGHT = 36;
const DEFAULT_OPEN_HEIGHT = 180;

type Disposable = { dispose: () => void };

type PtyExitPayload = {
  exitCode: number;
  signal?: string | null;
  error?: string;
};

type TermSession = {
  tabId: string;
  term: XTerm;
  fitAddon: FitAddon;
  sessionId: string;
  container: HTMLDivElement;
  outputUnlisten?: UnlistenFn;
  exitUnlisten?: UnlistenFn;
  onDataSubscription?: Disposable;
  onResizeSubscription?: Disposable;
  exited: boolean;
  exitCode: number | null;
  spawning: boolean;
};

/* ─────────────────────────────────────────────────────────────────────────────
   Terminal
───────────────────────────────────────────────────────────────────────────── */

interface TerminalProps {
  isOpen: boolean;
  onToggle: () => void;
  onToggleArtifacts: () => void;
  activeTabId: string;
  cwd?: string;
  agentTitle?: string;
  commandRequest?: {
    id: number;
    command: string;
  } | null;
}

export default function Terminal({
  isOpen,
  onToggle,
  onToggleArtifacts,
  activeTabId,
  cwd,
  agentTitle,
  commandRequest = null,
}: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const outputWrapRef = useRef<HTMLDivElement>(null);
  /** Persists the last open height across toggles */
  const heightRef = useRef(DEFAULT_OPEN_HEIGHT);
  const [, bumpTerminalUiVersion] = useReducer((n: number) => n + 1, 0);

  const sessionsRef = useRef<Map<string, TermSession>>(new Map());
  const queuedCommandsRef = useRef<Map<string, string[]>>(new Map());
  const lastCommandRequestIdRef = useRef<number | null>(null);
  /** Track previous cwd to detect mid-session changes (e.g. worktree switch) */
  const prevCwdRef = useRef<string | undefined>(undefined);

  const queueCommand = useCallback((tabId: string, command: string) => {
    const normalized = command.trim();
    if (!normalized) return;

    const existing = queuedCommandsRef.current.get(tabId) ?? [];
    existing.push(normalized);
    queuedCommandsRef.current.set(tabId, existing);
  }, []);

  const flushQueuedCommands = useCallback(
    async (tabId: string, session: TermSession) => {
      const queued = queuedCommandsRef.current.get(tabId);
      if (!queued?.length || !session.sessionId || session.exited) return;

      queuedCommandsRef.current.delete(tabId);
      for (const command of queued) {
        try {
          await invoke("write_pty", {
            sessionId: session.sessionId,
            data: `${command}\r`,
          });
        } catch (error) {
          console.error("Failed to run queued PTY command", error);
          queueCommand(tabId, command);
          break;
        }
      }
    },
    [queueCommand],
  );

  const disposePtyBindings = useCallback((session: TermSession) => {
    if (session.outputUnlisten) {
      session.outputUnlisten();
      session.outputUnlisten = undefined;
    }
    if (session.exitUnlisten) {
      session.exitUnlisten();
      session.exitUnlisten = undefined;
    }
    if (session.onDataSubscription) {
      session.onDataSubscription.dispose();
      session.onDataSubscription = undefined;
    }
    if (session.onResizeSubscription) {
      session.onResizeSubscription.dispose();
      session.onResizeSubscription = undefined;
    }
  }, []);

  const spawnShellForSession = useCallback(
    async (session: TermSession, spawnCwd?: string) => {
      if (session.spawning) return;

      session.spawning = true;
      session.exited = false;
      session.exitCode = null;
      session.sessionId = "";
      disposePtyBindings(session);
      bumpTerminalUiVersion();

      try {
        const sid = await invoke<string>("spawn_pty", {
          cwd: spawnCwd ?? cwd ?? "",
          rows: session.term.rows || 24,
          cols: session.term.cols || 80,
        });

        session.sessionId = sid;

        session.outputUnlisten = await listen<number[]>(
          `pty-output-${sid}`,
          (event) => {
            session.term.write(new Uint8Array(event.payload));
          },
        );

        session.exitUnlisten = await listen<PtyExitPayload>(
          `pty-exit-${sid}`,
          (event) => {
            const payload = event.payload;
            const code = Number(payload?.exitCode ?? -1);

            session.exited = true;
            session.exitCode = Number.isFinite(code) ? code : -1;
            session.sessionId = "";
            session.spawning = false;
            disposePtyBindings(session);

            if (payload?.error) {
              session.term.write(
                `\r\n\x1b[31mShell exited unexpectedly: ${payload.error}\x1b[0m\r\n`,
              );
            } else if (payload?.signal) {
              session.term.write(
                `\r\n\x1b[33mShell exited (${payload.signal}). Click Restart to launch a new shell.\x1b[0m\r\n`,
              );
            } else {
              session.term.write(
                `\r\n\x1b[33mShell exited (code ${session.exitCode}). Click Restart to launch a new shell.\x1b[0m\r\n`,
              );
            }

            bumpTerminalUiVersion();
          },
        );

        session.onDataSubscription = session.term.onData((data) => {
          if (!session.sessionId || session.exited) return;
          invoke("write_pty", { sessionId: session.sessionId, data }).catch(
            (err) => {
              if (!session.exited) {
                console.error("Failed to write to PTY", err);
              }
            },
          );
        });

        session.onResizeSubscription = session.term.onResize((size) => {
          if (!session.sessionId || session.exited) return;
          invoke("resize_pty", {
            sessionId: session.sessionId,
            rows: size.rows,
            cols: size.cols,
          }).catch((err) => {
            if (!session.exited) {
              console.error("Failed to resize PTY", err);
            }
          });
        });

        await flushQueuedCommands(session.tabId, session);

        if (isOpen) {
          setTimeout(() => session.fitAddon.fit(), 0);
        }
      } catch (e) {
        console.error("Failed to spawn PTY", e);
        session.exited = true;
        session.exitCode = -1;
        session.sessionId = "";
        session.term.write(`\r\n\x1b[31mFailed to spawn PTY: ${e}\x1b[0m\r\n`);
      } finally {
        session.spawning = false;
        bumpTerminalUiVersion();
      }
    },
    [cwd, disposePtyBindings, flushQueuedCommands, isOpen],
  );

  const ensureSession = useCallback(() => {
    if (!outputWrapRef.current) return null;

    let session = sessionsRef.current.get(activeTabId);
    if (session) return session;

    const wrap = outputWrapRef.current;
    const container = document.createElement("div");
    container.style.width = "100%";
    container.style.height = "100%";
    wrap.appendChild(container);

    const term = new XTerm({
      allowTransparency: true,

      theme: {
        background: "var(--color-term-bg)",
        foreground: "var(--color-text, #ffffff)",
      },
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebglAddon());

    term.open(container);

    session = {
      tabId: activeTabId,
      term,
      fitAddon,
      sessionId: "",
      container,
      exited: false,
      exitCode: null,
      spawning: false,
    };
    sessionsRef.current.set(activeTabId, session);
    bumpTerminalUiVersion();
    void spawnShellForSession(session, cwd);

    return session;
  }, [activeTabId, cwd, spawnShellForSession]);

  const restartActiveSession = useCallback(() => {
    const session = sessionsRef.current.get(activeTabId);
    if (!session || session.spawning) return;

    session.term.write("\r\n\x1b[36mRestarting shell...\x1b[0m\r\n");
    void spawnShellForSession(session, cwd);
  }, [activeTabId, cwd, spawnShellForSession]);

  /* ── Sync height when isOpen changes (CSS transition applies) ─── */
  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;
    el.style.height = isOpen ? `${heightRef.current}px` : `${HEADER_HEIGHT}px`;

    if (isOpen) {
      setTimeout(() => {
        const session = sessionsRef.current.get(activeTabId);
        if (session && session.term) {
          session.term.focus();
        }
      }, 50);
    }
  }, [isOpen, activeTabId]);

  /* ── Resize observer for xterm.js to fit the component ───────── */
  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (isOpen) {
        const session = sessionsRef.current.get(activeTabId);
        if (session) {
          session.fitAddon.fit();
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeTabId, isOpen]);

  /* ── Initialize or switch sessions ───────────────────────────── */
  useEffect(() => {
    if (!outputWrapRef.current) return;

    let session: TermSession | null = sessionsRef.current.get(activeTabId) ?? null;

    // Hide all containers
    for (const [id, s] of sessionsRef.current.entries()) {
      if (id === activeTabId) {
        s.container.style.display = "block";
        if (isOpen) {
          setTimeout(() => s.fitAddon.fit(), 0);
        }
      } else {
        s.container.style.display = "none";
      }
    }

    if (!session) {
      session = ensureSession();
    }

    if (session) {
      session.container.style.display = "block";
    }
  }, [activeTabId, ensureSession, isOpen]);

  /* ── Sync terminal cwd when the agent switches to a worktree mid-session ─── */
  useEffect(() => {
    // Skip the initial mount (prevCwdRef is still undefined)
    if (prevCwdRef.current === undefined) {
      prevCwdRef.current = cwd;
      return;
    }
    if (!cwd || cwd === prevCwdRef.current) return;
    prevCwdRef.current = cwd;

    const session = sessionsRef.current.get(activeTabId);
    if (!session || !session.sessionId) return;

    // Send a cd command to the running shell
    invoke("write_pty", {
      sessionId: session.sessionId,
      data: `cd ${JSON.stringify(cwd)}\r`,
    }).catch(console.error);
  }, [cwd, activeTabId]);

  useEffect(() => {
    if (!commandRequest) return;
    if (commandRequest.id === lastCommandRequestIdRef.current) return;
    lastCommandRequestIdRef.current = commandRequest.id;

    const session = ensureSession();
    if (!session) return;

    if (session.sessionId && !session.exited && !session.spawning) {
      invoke("write_pty", {
        sessionId: session.sessionId,
        data: `${commandRequest.command}\r`,
      }).catch((error) => {
        console.error("Failed to run PTY command", error);
      });
      return;
    }

    queueCommand(activeTabId, commandRequest.command);
    if (session.exited && !session.spawning) {
      session.term.write("\r\n\x1b[36mRestarting shell...\x1b[0m\r\n");
      void spawnShellForSession(session, cwd);
    }
  }, [
    activeTabId,
    commandRequest,
    cwd,
    ensureSession,
    queueCommand,
    spawnShellForSession,
  ]);

  // Clean up sessions when component unmounts (app close/reload)
  useEffect(() => {
    // Capture the ref value at effect setup time so the cleanup closure is stable
    const sessions = sessionsRef.current;
    return () => {
      for (const s of sessions.values()) {
        disposePtyBindings(s);
        s.term.dispose();
        if (s.container && s.container.parentNode) {
          s.container.parentNode.removeChild(s.container);
        }
      }
      sessions.clear();
    };
  }, [disposePtyBindings]);

  /* ── Resize handle – drag up to grow, drag down to shrink ─────── */
  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!isOpen) return;
      e.preventDefault();
      const el = terminalRef.current!;
      const handle = handleRef.current!;
      const startY = e.clientY;
      const startH = el.offsetHeight;

      el.classList.add("no-transition");
      handle.classList.add("is-dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";

      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY; // positive = dragging up = taller
        const newH = Math.max(
          80,
          Math.min(window.innerHeight * 0.75, startH + delta),
        );
        el.style.height = `${newH}px`;
        heightRef.current = newH;
      };

      const onUp = () => {
        el.classList.remove("no-transition");
        handle.classList.remove("is-dragging");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        // Fire one final fit when drag is over
        const session = sessionsRef.current.get(activeTabId);
        if (session) session.fitAddon.fit();
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [isOpen, activeTabId],
  );

  const activeSession = sessionsRef.current.get(activeTabId);
  const activeSessionExited = Boolean(activeSession?.exited);
  const activeSessionSpawning = Boolean(activeSession?.spawning);
  const statusLabel = activeSessionSpawning
    ? "STARTING SHELL..."
    : activeSessionExited
      ? `SHELL EXITED${activeSession?.exitCode != null ? ` (${activeSession.exitCode})` : ""}`
      : agentTitle || "SYSTEM READY";

  return (
    <div
      ref={terminalRef}
      className="terminal-full"
      style={{ height: isOpen ? DEFAULT_OPEN_HEIGHT : HEADER_HEIGHT }}
    >
      {/* ── Resize handle (drag this edge upward) ─────────────────── */}
      <div
        ref={handleRef}
        className="terminal-resize-handle"
        onMouseDown={onResizeMouseDown}
      />

      {/* ── Header bar ────────────────────────────────────────────── */}
      <div
        className="terminal-bar"
        onClick={onToggle}
      >
        <div className="terminal-bar-title">
          <span className="material-symbols-outlined text-base">terminal</span>
          TERMINAL
          <span className="terminal-bar-sep">•</span>
          <span className="terminal-bar-path">
            {cwd ? cwd : "No specific dir"}
          </span>
        </div>

        <div className="terminal-bar-right">
          <span
            className="terminal-status-dot"
            style={{
              background: activeSessionExited
                ? "var(--color-error)"
                : activeSessionSpawning
                  ? "var(--color-warning)"
                  : "var(--color-success)",
            }}
          />
          <span className="terminal-bar-status">
            {statusLabel}
          </span>

          {activeSessionExited ? (
            <button
              className="terminal-restart-btn"
              onClick={(e) => {
                e.stopPropagation();
                restartActiveSession();
              }}
              title="Restart terminal shell"
            >
              Restart
            </button>
          ) : null}

          <button
            className="terminal-caret-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            title={isOpen ? "Collapse terminal" : "Expand terminal"}
          >
            <svg
              className="terminal-caret-icon"
              style={{ transform: isOpen ? "rotate(0deg)" : "rotate(180deg)" }}
              width={12}
              height={12}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Output ── */}
      <div
        className="terminal-output"
        ref={outputWrapRef}
        style={{
          height: `calc(100% - ${HEADER_HEIGHT}px)`,
        }}
      />
    </div>
  );
}
