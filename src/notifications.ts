export interface NotificationPayload {
  title: string;
  options?: NotificationOptions;
  onClick?: () => void;
}

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
): Promise<void> {
  if (typeof window === "undefined") return;
  const hasPermission = await ensureNotificationPermission();
  if (!hasPermission) return;

  // Use Tauri notification plugin
  if (isTauri()) {
    try {
      const { sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      await sendNotification({
        title: payload.title,
        body: payload.options?.body ?? "",
        icon: "icons/icon.png", // Use app icon
      });
      if (payload.onClick) {
        // Note: Tauri v2 doesn't support click handlers in the same way
        // You'd need to listen to the notification click event globally
        payload.onClick();
      }
    } catch (err) {
      console.error("Failed to send Tauri notification:", err);
    }
    playNotificationSound();
    return;
  }

  // Browser fallback
  if (!("Notification" in window)) return;
  const notification = new Notification(payload.title, payload.options);
  if (payload.onClick) {
    notification.onclick = () => {
      payload.onClick?.();
      notification.close();
    };
  }

  playNotificationSound();
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
): Promise<void> {
  setActiveTab(tabId);
  await focusAppWindow();
}
