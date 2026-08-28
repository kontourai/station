/**
 * OS notifications from the native shell.
 *
 * Station's notification delivery is web push, which needs `PushManager` —
 * and Android WebView does not implement it, so the native app silently never
 * subscribes and cannot be told anything. On a live Station the same phone
 * shows `push=yes` in a browser and `push=no` in the app.
 *
 * **This is a local notification, not background push.** It posts from the
 * running app, so it reaches you while Station is open or backgrounded with
 * the process alive. It cannot wake a closed app — that needs FCM on Android
 * and APNs on iOS, which is a separate piece of work.
 *
 * Delivery is driven by the **host**, not from here. The webview's SSE stream
 * is suspended along with the webview when the app is backgrounded and its
 * events are not replayed on reconnect, so notifications raised while the user
 * was elsewhere were lost rather than late — confirmed on device. `watch`
 * hands the host a URL to poll; the host posts from its own thread, which
 * keeps running while the webview is paused.
 */
export interface NativeNotifier {
  /** Whether the OS will actually show anything. */
  isAvailable(): Promise<boolean>;
  /** Ask once. Returns whether notifications may now be posted. */
  ensurePermission(): Promise<boolean>;
  notify(input: { title: string; body?: string }): Promise<void>;
  /**
   * Ask the host to poll `url` and post whatever is new. Calling again
   * replaces the running watch, so a changed connection never leaves two
   * pollers double-notifying.
   */
  watch(input: { url: string; credential: string }): Promise<void>;
  unwatch(): Promise<void>;
}

export function createNativeNotifier(): NativeNotifier {
  let permission: boolean | null = null;

  async function api() {
    return import('@tauri-apps/plugin-notification');
  }

  async function command(name: string, args?: Record<string, unknown>) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke(name, args);
    } catch (error) {
      // A web build, a shell older than the command, or a watch that could not
      // reach the Station. The in-app toast still lands; only the OS
      // notification is lost — so this is not fatal, but it is not silent
      // either. A watch failing every poll used to be indistinguishable from a
      // working one.
      console.error(`station: ${name} failed`, error);
    }
  }

  return {
    async isAvailable() {
      try {
        const { isPermissionGranted } = await api();
        await isPermissionGranted();
        return true;
      } catch {
        // No plugin on this host (web build, or an older shell).
        return false;
      }
    },

    async ensurePermission() {
      if (permission !== null) return permission;
      try {
        const { isPermissionGranted, requestPermission } = await api();
        permission = await isPermissionGranted();
        if (!permission) {
          permission = (await requestPermission()) === 'granted';
        }
      } catch {
        permission = false;
      }
      return permission;
    },

    async notify({ title, body }) {
      // Never prompt as a side effect of an incoming notification — a
      // permission dialog that appears because a stranger's device asked to
      // pair is both confusing and a nudge to tap through.
      if (permission !== true) return;
      try {
        const { sendNotification } = await api();
        sendNotification({ title, body });
      } catch {
        // A failed OS notification must not disturb the in-app delivery that
        // already happened.
      }
    },

    async watch({ url, credential }) {
      // Polling that can never post anything is battery spend for nothing.
      if (permission !== true) return;
      await command('notification_watch_start', { url, credential });
    },

    async unwatch() {
      await command('notification_watch_stop');
    },
  };
}
