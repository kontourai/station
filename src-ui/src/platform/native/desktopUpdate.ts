/**
 * Desktop shell self-update (station#575), following `notifier.ts`'s shape:
 * a narrow module that owns the plugin import directly rather than routing
 * through the full `NativePlatformAdapter`, because every outcome — no
 * plugin registered, no network, nothing new — is legitimate here and none
 * of them is an error this module raises.
 *
 * The Rust side registers `tauri-plugin-updater` only when the build carries
 * a usable `plugins.updater` config (see `desktop_updater_plugin_configured`
 * in `src-desktop/src/lib.rs`); every other build — dev, and any channel
 * before its endpoint ships — has no plugin at all, so `check()` rejects.
 * That rejection and a genuine offline/signature failure are
 * indistinguishable from here, and both must stay quiet: an absent update
 * channel has not failed a check.
 *
 * A check failure is currently unobservable to anything but this console
 * line — there is no durable record a live channel's check kept failing.
 * Tracked as a follow-up (a `desktop-updater` entry in the native capability
 * report) rather than built in this round.
 *
 * On Windows, the plugin's install path spawns the platform installer and
 * then calls `std::process::exit(0)` unconditionally — the running app never
 * returns from `downloadAndInstall()`. `relaunch()` below and any failure
 * surfaced AFTER the installer has been spawned are therefore macOS/Linux
 * behavior only; a failure during download/extraction, before the installer
 * spawns, still rejects normally on every platform including Windows.
 */

type DesktopUpdateOutcome =
  | {
      status: 'update-available';
      version: string;
      install: () => Promise<void>;
      dispose: () => Promise<void>;
    }
  | { status: 'no-update' }
  | { status: 'check-failed' };

export async function checkForDesktopUpdate(): Promise<DesktopUpdateOutcome> {
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ timeout: 15_000 });
    if (!update) return { status: 'no-update' };
    let installing: Promise<void> | undefined;
    let disposed = false;
    return {
      status: 'update-available',
      version: update.version,
      install() {
        if (disposed)
          return Promise.reject(
            new Error('Check for updates again before installing.'),
          );
        installing ??= (async () => {
          await update.downloadAndInstall();
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        })().finally(() => {
          installing = undefined;
        });
        return installing;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        // Navigation or another check may discard the result during download.
        // Keep the native handle alive until that installation has settled.
        await installing?.catch(() => undefined);
        await update.close();
      },
    };
  } catch (error) {
    // No updater plugin on this host (dev build, or a channel whose
    // endpoint has not shipped), or a real check failure (offline, a bad
    // signature). Neither belongs on screen at launch.
    console.debug('station: desktop update check unavailable', error);
    return { status: 'check-failed' };
  }
}
