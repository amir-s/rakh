import { logFrontendSoon } from "@/logging/client";

export interface NotificationPayload {
  title: string;
  options?: NotificationOptions;
  onClick?: () => void;
}

interface FocusTabOptions {
  focusWindow?: boolean;
}

const TAURI_NOTIFICATION_ICON = "icons/icon.png";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  // In Tauri, use the plugin's permission system
  if (isTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import(
        "@tauri-apps/plugin-notification"
      );
      let granted = await isPermissionGranted();
      if (!granted) {
        const permission = await requestPermission();
        granted = permission === "granted";
      }
      return granted;
    } catch (err) {
      logFrontendSoon({
        level: "error",
        tags: ["frontend", "system"],
        event: "notifications.permission.error",
        message: "Failed to query Tauri notification permission.",
        data: { error: err },
      });
      return false;
    }
  }

  // Browser fallback
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;

  try {
    const permission = await Notification.requestPermission();
    return permission === "granted";
  } catch {
    return false;
  }
}

export function playNotificationSound(): void {
  if (typeof window === "undefined") return;
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) return;

  try {
    const ctx = new AudioContextCtor();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.value = 0.04;

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(0.05, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    oscillator.start(now);
    oscillator.stop(now + 0.25);
    oscillator.onended = () => {
      ctx.close().catch(() => undefined);
    };
  } catch {
    // Ignore sound errors (autoplay policies, etc.)
  }
}

export async function showNotification(
  payload: NotificationPayload,
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const hasPermission = await ensureNotificationPermission();
  if (!hasPermission) return false;

  if (!("Notification" in window)) return false;
  const notification = new Notification(payload.title, {
    ...payload.options,
    ...(isTauri() ? { icon: TAURI_NOTIFICATION_ICON } : {}),
  });
  if (payload.onClick) {
    notification.onclick = () => {
      payload.onClick?.();
      notification.close();
    };
  }

  playNotificationSound();
  return true;
}

export async function setAppBadgeCount(count: number | null): Promise<void> {
  if (typeof window === "undefined" || !isTauri()) return;

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (count === null || count <= 0) {
      await win.setBadgeCount();
      return;
    }
    await win.setBadgeCount(Math.max(1, Math.trunc(count)));
  } catch (err) {
    logFrontendSoon({
      level: "error",
      tags: ["frontend", "system"],
      event: "notifications.badge.error",
      message: "Failed to update the app badge count.",
      data: { error: err, count },
    });
  }
}

export async function focusAppWindow(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (isTauri()) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (await win.isMinimized()) {
        await win.unminimize();
      }
      await win.show();
      await win.setFocus();
    } else {
      window.focus();
    }
  } catch {
    // ignore focus errors
  }
}

export async function focusTab(
  tabId: string,
  setActiveTab: (id: string) => void,
  options?: FocusTabOptions,
): Promise<void> {
  setActiveTab(tabId);
  if (options?.focusWindow ?? true) {
    await focusAppWindow();
  }
}
