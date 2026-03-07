import {
  createContext,
  useCallback,
  useContext,
  useReducer,
  type ReactNode,
} from "react";
import type { PersistedSession } from "@/agent/persistence";

/* ─────────────────────────────────────────────────────────────────────────────
   Types
───────────────────────────────────────────────────────────────────────────── */

export type TabStatus = "idle" | "thinking" | "working" | "done" | "error";

export interface Tab {
  id: string;
  label: string;
  /** Material Symbols icon name */
  icon: string;
  status: TabStatus;
  hasChanges?: boolean;
  /** Whether this tab is showing the new-session landing or the workspace */
  mode: "new" | "workspace";
}

/* ─────────────────────────────────────────────────────────────────────────────
   Reducer
───────────────────────────────────────────────────────────────────────────── */

interface State {
  tabs: Tab[];
  activeTabId: string;
}

function createTabId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `tab-${uuid}`;
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createNewTab(partial?: Partial<Omit<Tab, "id">>): Tab {
  return {
    id: createTabId(),
    label: "New Tab",
    icon: "chat_bubble_outline",
    status: "idle",
    mode: "new",
    ...partial,
  };
}

type Action =
  | { type: "SET_ACTIVE"; id: string }
  | { type: "ADD_TAB"; tab: Tab }
  | { type: "ADD_TAB_WITH_ID"; tab: Tab }
  | { type: "CLOSE_TAB"; id: string }
  | { type: "UPDATE_TAB"; id: string; changes: Partial<Tab> }
  | { type: "REORDER_TABS"; fromIndex: number; toIndex: number };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_ACTIVE":
      return { ...state, activeTabId: action.id };

    case "ADD_TAB":
      return { tabs: [...state.tabs, action.tab], activeTabId: action.tab.id };

    case "ADD_TAB_WITH_ID":
      // Don't add if a tab with this ID already exists (idempotent restore)
      if (state.tabs.some((t) => t.id === action.tab.id)) {
        return { ...state, activeTabId: action.tab.id };
      }
      return { tabs: [...state.tabs, action.tab], activeTabId: action.tab.id };

    case "CLOSE_TAB": {
      const idx = state.tabs.findIndex((t) => t.id === action.id);
      if (idx === -1) return state;
      const next = state.tabs.filter((t) => t.id !== action.id);
      const newActive =
        state.activeTabId === action.id
          ? next[Math.max(0, idx - 1)].id
          : state.activeTabId;
      return { tabs: next, activeTabId: newActive };
    }

    case "UPDATE_TAB":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id ? { ...t, ...action.changes } : t,
        ),
      };

    case "REORDER_TABS": {
      const { fromIndex, toIndex } = action;
      if (fromIndex === toIndex || fromIndex === toIndex - 1) return state;
      const tabs = [...state.tabs];
      const moved = tabs[fromIndex];
      tabs.splice(fromIndex, 1);
      const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;
      tabs.splice(insertAt, 0, moved);
      return { ...state, tabs };
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Initial state — one tab labelled "New Tab" (fallback when no sessions)
───────────────────────────────────────────────────────────────────────────── */

function createEmptyInitialState(): State {
  const tab = createNewTab();
  return {
    tabs: [tab],
    activeTabId: tab.id,
  };
}

function buildInitialState(sessions: PersistedSession[]): State {
  if (sessions.length === 0) return createEmptyInitialState();
  const tabs: Tab[] = sessions.map((s) => ({
    id: s.id,
    label: s.label,
    icon: s.icon,
    status: "idle" as const,
    mode: s.mode as Tab["mode"],
  }));
  return { tabs, activeTabId: tabs[0].id };
}

/* ─────────────────────────────────────────────────────────────────────────────
   Context
───────────────────────────────────────────────────────────────────────────── */

interface TabsContextValue {
  tabs: Tab[];
  activeTabId: string;
  setActiveTab: (id: string) => void;
  /** Returns the new tab's id */
  addTab: (partial?: Partial<Omit<Tab, "id">>) => string;
  /** Add a tab with a specific id (used when restoring archived sessions) */
  addTabWithId: (tab: Tab) => void;
  closeTab: (id: string) => void;
  updateTab: (id: string, changes: Partial<Tab>) => void;
  /** Move a tab from fromIndex to insert-before-toIndex (both in original array) */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

/* ─────────────────────────────────────────────────────────────────────────────
   Provider
───────────────────────────────────────────────────────────────────────────── */

export function TabsProvider({
  children,
  initialSessions = [],
}: {
  children: ReactNode;
  initialSessions?: PersistedSession[];
}) {
  const [state, dispatch] = useReducer(
    reducer,
    initialSessions,
    buildInitialState,
  );

  const setActiveTab = useCallback(
    (id: string) => dispatch({ type: "SET_ACTIVE", id }),
    [],
  );

  const addTab = useCallback((partial?: Partial<Omit<Tab, "id">>) => {
    const tab = createNewTab(partial);
    dispatch({ type: "ADD_TAB", tab });
    return tab.id;
  }, []);

  const addTabWithId = useCallback((tab: Tab) => {
    dispatch({ type: "ADD_TAB_WITH_ID", tab });
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      if (state.tabs.length === 1) {
        const tab = state.tabs.find((t) => t.id === id);
        if (!tab || tab.mode === "new") return; // don't close the last new-session tab
        // Last workspace tab → replace with a fresh new-session tab
        const newTab = createNewTab();
        dispatch({ type: "ADD_TAB", tab: newTab });
        dispatch({ type: "CLOSE_TAB", id });
        return;
      }
      dispatch({ type: "CLOSE_TAB", id });
    },
    [state.tabs],
  );

  const updateTab = useCallback(
    (id: string, changes: Partial<Tab>) =>
      dispatch({ type: "UPDATE_TAB", id, changes }),
    [],
  );

  const reorderTabs = useCallback(
    (fromIndex: number, toIndex: number) =>
      dispatch({ type: "REORDER_TABS", fromIndex, toIndex }),
    [],
  );

  return (
    <TabsContext.Provider
      value={{
        ...state,
        setActiveTab,
        addTab,
        addTabWithId,
        closeTab,
        updateTab,
        reorderTabs,
      }}
    >
      {children}
    </TabsContext.Provider>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Hook
───────────────────────────────────────────────────────────────────────────── */

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("useTabs must be used inside <TabsProvider>");
  return ctx;
}
