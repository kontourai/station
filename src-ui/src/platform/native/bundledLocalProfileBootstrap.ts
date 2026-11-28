import { attemptLocalSelfProvisionOnceWithOutcome } from '@kontourai/station-connect/local-self-provision';
import { readNativeCommandError } from './nativeCommandError';
import type { NativeStationProfileRepository } from './stationProfileStorage';
import type { NativePlatformAdapter } from './types';

// Large migrated homes, or a slow host, can spend tens of seconds (sometimes
// more than a minute) loading agents, plugins, and event indexes before the
// native-owned sidecar publishes its handshake. Progressing phases are
// `starting`, `restarting` (the supervisor bounds it with its own attempt cap
// before reporting `failed`) and `stopping` (only a manual restart sets it,
// and it always respawns).
//
// While the main window is still covered by native startup readiness there is
// no wall-clock limit, even for a terminal owned sidecar (`failed`,
// `stopped`): the cover offers Restart/Quit once its deadline passes, and an
// explicit Restart lets this same bootstrap author and authorize in place.
// Giving up there would leave a fresh home without the profile its native
// identity proof requires.
//
// A window already shown to the user (a reload of the revealed main window,
// the dev bypass, or a workspace pop-out) has only the in-app recovery UI, so
// it releases the loader at once for a terminal sidecar and after the
// fast-poll budget (about a minute) for a progressing one, with no background
// polling afterwards.
const STATUS_RETRY_MS = 100;
const STATUS_RETRY_SLOW_MS = 1_000;
const STATUS_FAST_ATTEMPTS = 600;
const PROGRESSING_PHASES: ReadonlySet<string> = new Set([
  'starting',
  'restarting',
  'stopping',
]);

interface BootstrapDependencies {
  adapter: NativePlatformAdapter;
  repository: NativeStationProfileRepository & { refresh(): Promise<boolean> };
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface BundledLocalProfileBootstrapResult {
  /** Actionable notice for a saved Station that needs recovery after startup. */
  recoveryError?: string;
}

const REPLACEMENT_WRITE_FAILURE =
  'Station recovered access but could not save the replacement credential. Unlock your keychain or credential store, then relaunch Station.';

function defaultWait(milliseconds: number) {
  return new Promise<void>((resolve) =>
    window.setTimeout(resolve, milliseconds),
  );
}

/**
 * Whether this WebView is already shown to the user. Without an answer (an
 * adapter with no native readiness, or a failed read) it releases rather than
 * risk hanging a visible window on the loader.
 */
async function windowAlreadyShown(adapter: NativePlatformAdapter) {
  const admitted = await adapter.isStartupWindowAdmitted();
  return admitted.status !== 'ok' || admitted.value;
}

/** Bootstrap the desktop's selected Station before first paint. */
export async function bootstrapBundledLocalProfile(
  dependencies: BootstrapDependencies,
): Promise<BundledLocalProfileBootstrapResult> {
  const { adapter, repository, invoke } = dependencies;
  const wait = dependencies.wait ?? defaultWait;
  for (let attempt = 0; ; attempt += 1) {
    const status = await adapter.getBundledServerStatus();
    if (status.status !== 'ok') return {};
    const ownsSidecar = status.value.ownership === 'sidecar';
    if (ownsSidecar && status.value.phase !== 'running') {
      const terminal = !PROGRESSING_PHASES.has(status.value.phase);
      const pastShownWindowBudget = attempt >= STATUS_FAST_ATTEMPTS;
      if (
        (terminal || pastShownWindowBudget) &&
        (await windowAlreadyShown(adapter))
      ) {
        return {};
      }
      await wait(
        attempt < STATUS_FAST_ATTEMPTS ? STATUS_RETRY_MS : STATUS_RETRY_SLOW_MS,
      );
      continue;
    }
    // An attached service can be running without its installed manifest.
    // Only this client's explicit selection may supply authority if local
    // ownership cannot be resolved; the CLI default may belong to another app.
    const profileName = await invoke(
      'station_ensure_bundled_local_profile',
    ).catch(() => null);
    if (typeof profileName !== 'string' || profileName.length === 0) {
      try {
        await repository.authorizeRememberedProfile({
          fallbackToDefault: false,
        });
      } catch {
        return {
          recoveryError:
            'Station couldn’t reconnect to your saved Station. Open the Station menu to reconnect.',
        };
      }
      return {};
    }
    await repository.refresh();
    const selected = repository.selectProfileForProcess(profileName);
    if (!selected) return {};
    if (!ownsSidecar) {
      await repository.authorizeActiveConnection(selected);
      return {};
    }
    const pendingName = repository.pendingLocalSelfProvisionProfileName();
    if (pendingName) {
      const provision = await attemptLocalSelfProvisionOnceWithOutcome({
        invoke,
        profileName: pendingName,
      });
      if (provision.provisioned) await repository.refresh();
      else if (
        readNativeCommandError(provision.error).code ===
        'credential_replacement_write_failed'
      ) {
        return {
          recoveryError: REPLACEMENT_WRITE_FAILURE,
        };
      }
    }
    await repository.authorizeActiveConnection(selected);
    return {};
  }
}
