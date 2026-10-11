import { attemptLocalSelfProvisionOnceWithOutcome } from '@kontourai/station-connect/local-self-provision';
import { readNativeCommandError } from './nativeCommandError';
import type { NativeStationProfileRepository } from './stationProfileStorage';
import type { NativePlatformAdapter } from './types';

// Large migrated homes, or a slow host, can spend tens of seconds (sometimes
// more than a minute) loading agents, plugins, and event indexes before the
// native-owned sidecar publishes its handshake. While that owned sidecar is
// still progressing (`starting`, or `restarting`, which the supervisor bounds
// with its own attempt cap before reporting `failed`), there is no wall-clock
// limit: giving up would leave a fresh home without the profile its native
// identity proof requires. A terminal phase (`failed`, `stopping`, `stopped`)
// releases the loader at once so the shell can render its recovery UI rather
// than hang a visible (reloaded or dev) window; for an owned sidecar at first
// launch that UI stays behind the native cover until readiness admits it.
//
// Only an explicit Restart brings a terminal owned sidecar back to `running`.
// When that happens the page reloads, so first paint re-runs this bootstrap:
// authoring, authorization and their errors keep their single first-paint
// path instead of a second, out-of-band one.
const STATUS_RETRY_MS = 100;
const STATUS_RETRY_SLOW_MS = 1_000;
const STATUS_FAST_ATTEMPTS = 600;
const PROGRESSING_PHASES: ReadonlySet<string> = new Set([
  'starting',
  'restarting',
]);

interface BootstrapDependencies {
  adapter: NativePlatformAdapter;
  repository: NativeStationProfileRepository & { refresh(): Promise<boolean> };
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  wait?: (milliseconds: number) => Promise<void>;
  /** Re-runs first paint; injectable because jsdom cannot stub reload. */
  reload?: () => void;
}

export interface BundledLocalProfileBootstrapResult {
  /** Safe, actionable copy for the one replacement write failure we own. */
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
 * After the loader was released for a terminal owned sidecar, wait gently for
 * an explicit Restart to bring it to `running`, then reload once so first
 * paint re-runs the bootstrap. It never authors, authorizes or refreshes.
 */
async function reloadWhenOwnedSidecarRuns(
  dependencies: BootstrapDependencies,
): Promise<void> {
  const wait = dependencies.wait ?? defaultWait;
  const reload = dependencies.reload ?? (() => window.location.reload());
  for (;;) {
    await wait(STATUS_RETRY_SLOW_MS);
    const status = await dependencies.adapter
      .getBundledServerStatus()
      .catch(() => undefined);
    if (status?.status !== 'ok') continue;
    if (
      status.value.ownership === 'sidecar' &&
      status.value.phase !== 'running'
    ) {
      continue;
    }
    reload();
    return;
  }
}

/** Bootstrap and authorize a fresh desktop-owned sidecar before first paint. */
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
      if (!PROGRESSING_PHASES.has(status.value.phase)) {
        void reloadWhenOwnedSidecarRuns(dependencies);
        return {};
      }
      await wait(
        attempt < STATUS_FAST_ATTEMPTS ? STATUS_RETRY_MS : STATUS_RETRY_SLOW_MS,
      );
      continue;
    }
    // The native command is also the read-only owner resolver for an attached
    // (including stopped) service. `null` is a confirmed unowned home; an
    // error is ambiguity or invalid metadata and must never select the shared
    // default as a fallback.
    let profileName: unknown;
    try {
      profileName = await invoke('station_ensure_bundled_local_profile');
    } catch {
      return {};
    }
    // `null` is a confirmed absence of this channel's local owner. A shared
    // default may name another packaged channel, so authorizing it here would
    // read that channel's keyring entry merely because this one is missing.
    // Leave the process without a native authorization and let ordinary
    // onboarding make the next explicit choice instead.
    if (profileName === null && status.value.ownership === 'none') return {};
    if (typeof profileName !== 'string' || profileName.length === 0) {
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
