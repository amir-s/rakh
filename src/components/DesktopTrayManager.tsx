import { useCallback, useEffect, useRef } from "react";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { TrayIcon, type TrayIconEvent } from "@tauri-apps/api/tray";
import { exit } from "@tauri-apps/plugin-process";
import { agentAtomFamily, jotaiStore } from "@/agent/atoms";
import {
  summarizeDesktopAgentState,
  type WorkspaceAggregateStatus,
} from "@/agent/desktopStatus";
import { useTabs } from "@/contexts/TabsContext";
import { focusAppWindow } from "@/notifications";
import trayDarkIconUrl from "../../src-tauri/icons/tray-dark.png";
import trayLightIconUrl from "../../src-tauri/icons/tray-light.png";

type DesktopPlatform = "mac" | "linux" | "other";
type TrayIconAssetState = "idle" | "working" | "attention";
type TrayIconTheme = "dark" | "light";

interface TrayIconThemeAssets {
  dark: ArrayBuffer;
  light: ArrayBuffer;
}

interface TrayIconAssets {
  idle: TrayIconThemeAssets;
  working: TrayIconThemeAssets;
  attention: TrayIconThemeAssets;
}

interface TrayMenuResources {
  menu: Menu;
  statusItem: MenuItem;
  countsItem: MenuItem;
  separator: PredefinedMenuItem;
  openItem: MenuItem;
  quitItem: MenuItem;
}

interface AppliedTrayState {
  icon: TrayIconAssetState;
  theme: TrayIconTheme;
  menuStatusText: string;
  menuCountsText: string;
  tooltip: string;
}

const TRAY_ID = "desktop-agent-status";

let trayIconAssetsPromise: Promise<TrayIconAssets> | null = null;

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

function detectPlatform(): DesktopPlatform {
  const platform = (navigator.platform ?? "").toLowerCase();
  const userAgent = (navigator.userAgent ?? "").toLowerCase();
  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "mac";
  }
  if (platform.includes("linux") || userAgent.includes("linux")) {
    return "linux";
  }
  return "other";
}

function resolveTrayIconState(
  status: WorkspaceAggregateStatus,
): TrayIconAssetState {
  if (status === "attention") return "attention";
  if (status === "working") return "working";
  return "idle";
}

function getSystemTrayTheme(): TrayIconTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

async function fetchIconBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load tray icon asset: ${url}`);
  }
  return response.arrayBuffer();
}

function loadTrayIconAssets(): Promise<TrayIconAssets> {
  if (!trayIconAssetsPromise) {
    trayIconAssetsPromise = Promise.all([
      fetchIconBytes(trayDarkIconUrl),
      fetchIconBytes(trayLightIconUrl),
    ])
      .then(([dark, light]) => ({
        idle: { dark, light },
        working: { dark, light },
        attention: { dark, light },
      }))
      .catch((error) => {
        trayIconAssetsPromise = null;
        throw error;
      });
  }

  return trayIconAssetsPromise;
}

async function closeResource(resource: { close(): Promise<void> } | null): Promise<void> {
  if (!resource) return;
  try {
    await resource.close();
  } catch {
    // Ignore teardown errors.
  }
}

async function closeTrayResources(
  tray: TrayIcon | null,
  menuResources: TrayMenuResources | null,
): Promise<void> {
  await closeResource(tray);
  await closeResource(menuResources?.quitItem ?? null);
  await closeResource(menuResources?.openItem ?? null);
  await closeResource(menuResources?.separator ?? null);
  await closeResource(menuResources?.countsItem ?? null);
  await closeResource(menuResources?.statusItem ?? null);
  await closeResource(menuResources?.menu ?? null);
}

async function createTrayMenu(): Promise<TrayMenuResources> {
  const statusItem = await MenuItem.new({
    id: "tray-status",
    text: "Status: Idle",
    enabled: false,
  });
  const countsItem = await MenuItem.new({
    id: "tray-counts",
    text: "Attention 0 • Working 0 • Done 0",
    enabled: false,
  });
  const separator = await PredefinedMenuItem.new({ item: "Separator" });
  const openItem = await MenuItem.new({
    id: "tray-open",
    text: "Open Rakh",
    action: () => {
      void focusAppWindow();
    },
  });
  const quitItem = await MenuItem.new({
    id: "tray-quit",
    text: "Quit",
    action: () => {
      void exit(0);
    },
  });

  const menu = await Menu.new({
    id: "tray-menu",
    items: [statusItem, countsItem, separator, openItem, quitItem],
  });

  return {
    menu,
    statusItem,
    countsItem,
    separator,
    openItem,
    quitItem,
  };
}

export default function DesktopTrayManager() {
  const { tabs } = useTabs();
  const tabsRef = useRef(tabs);
  const platformRef = useRef<DesktopPlatform>(detectPlatform());
  const trayRef = useRef<TrayIcon | null>(null);
  const trayMenuRef = useRef<TrayMenuResources | null>(null);
  const trayInitPromiseRef = useRef<Promise<TrayIcon | null> | null>(null);
  const trayIconAssetsRef = useRef<TrayIconAssets | null>(null);
  const appliedStateRef = useRef<AppliedTrayState | null>(null);
  const disposedRef = useRef(false);

  const handleTrayAction = useCallback((event: TrayIconEvent) => {
    if (platformRef.current === "linux") return;
    if (
      event.type === "Click" &&
      event.button === "Left" &&
      event.buttonState === "Up"
    ) {
      void focusAppWindow();
    }
  }, []);

  const ensureTrayReady = useCallback(async (): Promise<TrayIcon | null> => {
    if (!isTauriRuntime() || disposedRef.current) {
      return null;
    }

    if (trayRef.current) {
      return trayRef.current;
    }

    if (trayInitPromiseRef.current) {
      return trayInitPromiseRef.current;
    }

    trayInitPromiseRef.current = (async () => {
      const iconAssets = await loadTrayIconAssets();
      const menuResources = await createTrayMenu();
      const summary = summarizeDesktopAgentState(tabsRef.current);
      const trayTheme = getSystemTrayTheme();
      const tray = await TrayIcon.new({
        id: TRAY_ID,
        icon: iconAssets[resolveTrayIconState(summary.trayStatus)][trayTheme],
        menu: menuResources.menu,
        tooltip: summary.tooltip,
        action: handleTrayAction,
      });

      if (disposedRef.current) {
        await closeTrayResources(tray, menuResources);
        return null;
      }

      trayIconAssetsRef.current = iconAssets;
      trayMenuRef.current = menuResources;
      trayRef.current = tray;

      await tray.setMenu(menuResources.menu);
      if (platformRef.current !== "linux") {
        await tray.setShowMenuOnLeftClick(false);
      }

      return tray;
    })().catch((error) => {
      trayInitPromiseRef.current = null;
      console.error("Failed to initialize desktop tray:", error);
      return null;
    });

    return trayInitPromiseRef.current;
  }, [handleTrayAction]);

  const syncTray = useCallback(async () => {
    if (!isTauriRuntime() || disposedRef.current) {
      return;
    }

    try {
      const tray = await ensureTrayReady();
      const menuResources = trayMenuRef.current;
      const iconAssets = trayIconAssetsRef.current;
      if (!tray || !menuResources || !iconAssets) {
        return;
      }

      const summary = summarizeDesktopAgentState(tabsRef.current);
      const trayTheme = getSystemTrayTheme();
      const nextState: AppliedTrayState = {
        icon: resolveTrayIconState(summary.trayStatus),
        theme: trayTheme,
        menuStatusText: summary.menuStatusText,
        menuCountsText: summary.menuCountsText,
        tooltip: summary.tooltip,
      };
      const previousState = appliedStateRef.current;

      if (
        !previousState ||
        previousState.menuStatusText !== nextState.menuStatusText
      ) {
        await menuResources.statusItem.setText(nextState.menuStatusText);
      }

      if (
        !previousState ||
        previousState.menuCountsText !== nextState.menuCountsText
      ) {
        await menuResources.countsItem.setText(nextState.menuCountsText);
      }

      if (!previousState || previousState.tooltip !== nextState.tooltip) {
        await tray.setTooltip(nextState.tooltip);
      }

      if (
        !previousState ||
        previousState.icon !== nextState.icon ||
        previousState.theme !== nextState.theme
      ) {
        await tray.setIcon(iconAssets[nextState.icon][nextState.theme]);
      }

      appliedStateRef.current = nextState;
    } catch (error) {
      console.error("Failed to sync desktop tray state:", error);
    }
  }, [ensureTrayReady]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    disposedRef.current = false;
    void syncTray();

    return () => {
      disposedRef.current = true;
      const tray = trayRef.current;
      const menuResources = trayMenuRef.current;
      trayRef.current = null;
      trayMenuRef.current = null;
      trayInitPromiseRef.current = null;
      trayIconAssetsRef.current = null;
      appliedStateRef.current = null;
      void closeTrayResources(tray, menuResources);
    };
  }, [syncTray]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    tabsRef.current = tabs;
    void syncTray();

    const unsubs: Array<() => void> = [];
    for (const tab of tabs) {
      if (tab.mode !== "workspace") continue;
      unsubs.push(
        jotaiStore.sub(agentAtomFamily(tab.id), () => {
          void syncTray();
        }),
      );
    }

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
    };
  }, [tabs, syncTray]);

  useEffect(() => {
    if (!isTauriRuntime() || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      void syncTray();
    };

    if ("addEventListener" in mediaQuery) {
      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }

    const legacyMediaQuery = mediaQuery as MediaQueryList & {
      addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    };
    legacyMediaQuery.addListener?.(handleChange);
    return () => {
      legacyMediaQuery.removeListener?.(handleChange);
    };
  }, [syncTray]);

  return null;
}
