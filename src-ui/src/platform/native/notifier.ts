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
 */
interface NativeNotifier {
  /** Whether the OS will actually show anything. */
  isAvailable(): Promise<boolean>;
  /** Ask once. Returns whether notifications may now be posted. */
  ensurePermission(): Promise<boolean>;
  notify(input: { title: string; body?: string }): Promise<void>;
}

export function createNativeNotifier(): NativeNotifier {
  let permission: boolean | null = null;

  async function api() {
    return import('@tauri-apps/plugin-notification');
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
  };
}
