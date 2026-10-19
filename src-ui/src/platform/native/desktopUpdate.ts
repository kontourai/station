import {
  DESKTOP_UPDATE_STATE_EVENT,
  type DesktopUpdateDownloadPolicy,
  type DesktopUpdateState,
} from '@kontourai/station-contracts/desktop-update';
import { invokeTauri, listenTauri } from './tauriInvoke';

/**
 * Desktop shell self-update (#3851). The native shell owns the whole
 * lifecycle (`src-desktop/src/desktop_update.rs`): it checks periodically,
 * downloads per the download policy or on request, and installs and restarts
 * only when asked. This module is the webview's narrow command and event
 * boundary to it; the webview holds no updater or process plugin authority.
 *
 * State changes arrive only on {@link subscribeToDesktopUpdateState}.
 * Commands resolve once the native side accepted them; their outcome
 * (including failures, which return to the prior phase with `error` set)
 * arrives as state. A rejected command means the request itself failed.
 */

export function readDesktopUpdateState(): Promise<DesktopUpdateState> {
  return invokeTauri<DesktopUpdateState>('desktop_update_state');
}

export function subscribeToDesktopUpdateState(
  handler: (state: DesktopUpdateState) => void,
): Promise<() => void> {
  return listenTauri<DesktopUpdateState>(DESKTOP_UPDATE_STATE_EVENT, handler);
}

export async function checkForDesktopUpdate(): Promise<void> {
  await invokeTauri<DesktopUpdateState>('desktop_update_check');
}

export async function downloadDesktopUpdate(): Promise<void> {
  await invokeTauri<DesktopUpdateState>('desktop_update_download');
}

/**
 * Installs the downloaded update and restarts the app. Call only after the
 * user confirmed the restart. On success the process exits; a failed install
 * returns to `ready` with an `install` error.
 */
export async function installDesktopUpdateAndRestart(): Promise<void> {
  await invokeTauri<DesktopUpdateState>('desktop_update_install');
}

/** Rejects when the native side could not persist the policy. */
export async function setDesktopUpdatePolicy(
  policy: DesktopUpdateDownloadPolicy,
): Promise<void> {
  await invokeTauri<DesktopUpdateState>('desktop_update_set_policy', {
    policy,
  });
}
