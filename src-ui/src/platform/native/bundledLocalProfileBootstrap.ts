import { attemptLocalSelfProvisionOnceWithOutcome } from '../../../../packages/connect/src/core/localSelfProvision';
import { readNativeCommandError } from './nativeCommandError';
import type { NativeStationProfileRepository } from './stationProfileStorage';
import type { NativePlatformAdapter } from './types';

// Large migrated homes can spend tens of seconds loading agents, plugins, and
// event indexes before the native-owned sidecar publishes its handshake.
const MAX_STATUS_ATTEMPTS = 600;
const STATUS_RETRY_MS = 100;

interface BootstrapDependencies {
  adapter: NativePlatformAdapter;
  repository: NativeStationProfileRepository & { refresh(): Promise<boolean> };
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface BundledLocalProfileBootstrapResult {
  /** Safe, actionable copy for the one replacement write failure we own. */
  recoveryError?: string;
}

const REPLACEMENT_WRITE_FAILURE =
  'Station recovered access but could not save the replacement credential. Unlock your keychain or credential store, then relaunch Station.';

/** Bootstrap and authorize a fresh desktop-owned sidecar before first paint. */
export async function bootstrapBundledLocalProfile({
  adapter,
  repository,
  invoke,
  wait = (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
}: BootstrapDependencies): Promise<BundledLocalProfileBootstrapResult> {
  for (let attempt = 0; attempt < MAX_STATUS_ATTEMPTS; attempt += 1) {
    const status = await adapter.getBundledServerStatus();
    if (status.status !== 'ok') return {};
    const ownsSidecar = status.value.ownership === 'sidecar';
    if (ownsSidecar && status.value.phase !== 'running') {
      await wait(STATUS_RETRY_MS);
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
    if (profileName === null && status.value.ownership === 'none') {
      await repository.authorizeDefaultProfile();
      return {};
    }
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
  return {};
}
