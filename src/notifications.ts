export interface NotificationPayload {
  title: string;
  options?: NotificationOptions;
  onClick?: () => void;
}

interface FocusTabOptions {
  focusWindow?: boolean;
}

interface TauriNotificationActionEvent {
  id?: number;
  notification?: {
    id?: number;
  };
}

const MAX_TAURI_CLICK_CALLBACKS = 200;
const TAURI_NOTIFICATION_ICON = "icons/icon.png";
const tauriClickCallbacks = new Map<number, () => void>();
let nextTauriNotificationId = 1;
let tauriActionListenerPromise: Promise<void> | null = null;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createTauriNotificationId(): number {
  const id = nextTauriNotificationId;
  nextTauriNotificationId += 1;
  if (nextTauriNotificationId > 2_147_483_647) {
    nextTauriNotificationId = 1;
  }
  return id;
}

function pruneTauriClickCallbacks(): void {
  const overflow = tauriClickCallbacks.size - MAX_TAURI_CLICK_CALLBACKS;
  if (overflow <= 0) return;

  for (const id of tauriClickCallbacks.keys()) {
    tauriClickCallbacks.delete(id);
    if (tauriClickCallbacks.size <= MAX_TAURI_CLICK_CALLBACKS) {
      return;
    }
  }
}

function getTauriNotificationId(event: unknown): number | null {
  if (!event || typeof event !== "object") return null;
  const actionEvent = event as TauriNotificationActionEvent;
  return actionEvent.notification?.id ?? actionEvent.id ?? null;
}

async function ensureTauriActionListener(): Promise<void> {
  if (!isTauri()) return;
  if (tauriActionListenerPromise) {
    await tauriActionListenerPromise;
    return;
  }

  tauriActionListenerPromise = (async () => {
    try {
      const { onAction } = await import("@tauri-apps/plugin-notification");
      await onAction((event: unknown) => {
        const notificationId = getTauriNotificationId(event);
        if (notificationId == null) return;

        const onClick = tauriClickCallbacks.get(notificationId);
        if (!onClick) return;

        tauriClickCallbacks.delete(notificationId);
        onClick();
      });
    } catch (err) {
      console.error("Failed to register Tauri notification listener:", err);
    }
  })();

  await tauriActionListenerPromise;
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
      console.error("Tauri notification permission error:", err);
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

  // Use Tauri notification plugin
  if (isTauri()) {
    const notificationId = createTauriNotificationId();

    if (payload.onClick) {
      tauriClickCallbacks.set(notificationId, payload.onClick);
      pruneTauriClickCallbacks();
      await ensureTauriActionListener();
    }

    try {
      const { sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      sendNotification({
        id: notificationId,
        title: payload.title,
        body: payload.options?.body ?? "",
        icon: TAURI_NOTIFICATION_ICON,
        autoCancel: true,
      });
    } catch (err) {
      tauriClickCallbacks.delete(notificationId);
      console.error("Failed to send Tauri notification:", err);
      return false;
    }
    playNotificationSound();
    return true;
  }

  // Browser fallback
  if (!("Notification" in window)) return false;
  const notification = new Notification(payload.title, payload.options);
  if (payload.onClick) {
    notification.onclick = () => {
      payload.onClick?.();
      notification.close();
    };
  }

  playNotificationSound();
  return true;
}

export async function focusAppWindow(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if ("__TAURI__" in window) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
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
