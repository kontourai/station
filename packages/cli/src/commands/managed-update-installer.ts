/**
 * The managed policy's `limits.updates` (#4522) for the CLI's two installer
 * callers: `station upgrade` and the service launcher's staging child. Both
 * read the machine's policy themselves, because neither runs inside the
 * server that loaded it, and an invalid policy refuses the update (fail
 * closed) the same way it refuses server startup.
 */
import {
  type ManagedPolicyUpdatesLimit,
  managedUpdateServerManifestUrl,
  managedUpdatesRefusal,
} from '@kontourai/station-contracts/managed-policy';
import { loadInstalledManagedPolicy } from '@kontourai/station-shared/managed-policy';

/** The installer variable that sends every download to the mirror. */
export const INSTALLER_MIRROR_ENV = 'STATION_INSTALL_MIRROR_URL';

/**
 * The machine's update limit, or null when no policy limits updates.
 * Throws `ManagedPolicyInvalidError` when the installed policy cannot be
 * used: an update must not run on a policy Station cannot read.
 */
export function installedManagedUpdates(
  env: NodeJS.ProcessEnv = process.env,
): ManagedPolicyUpdatesLimit | null {
  return loadInstalledManagedPolicy({ env })?.document.limits?.updates ?? null;
}

export class ManagedUpdateRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedUpdateRefusedError';
  }
}

/**
 * Why the policy refuses any update on `ring`, as a full sentence, or null.
 * An unknown ring (null) could be nightly, so it cannot pass a nightly
 * refusal.
 */
export function managedRingRefusal(
  updates: ManagedPolicyUpdatesLimit | null,
  ring: string | null,
): string | null {
  const refusal = managedUpdatesRefusal(updates, ring);
  if (refusal) return `${refusal}.`;
  if (ring === null && updates?.allowNightly === false)
    return "This machine's managed policy makes the nightly channel unavailable, and Station cannot tell which release channel this install updates from.";
  return null;
}

/**
 * The installer environment the policy requires for an install on `ring`
 * (a release ring: stable, preview or nightly), or a refusal. Without a
 * mirror it adds nothing. With one, the installer reads the mirror's copy of
 * the ring's signed manifest and downloads every archive from the mirror; a
 * manifest named some other way is refused rather than used.
 */
export function managedInstallerEnv(input: {
  updates: ManagedPolicyUpdatesLimit | null;
  /** Null when the install's ring cannot be determined (#4522 finding 7). */
  ring: string | null;
  platform: NodeJS.Platform;
  /** An explicit `STATION_INSTALL_PUBLIC_MANIFEST_URL`, if any. */
  requestedManifestUrl: string | undefined;
}): Record<string, string> {
  const refusal = managedRingRefusal(input.updates, input.ring);
  if (refusal) throw new ManagedUpdateRefusedError(refusal);
  const feedUrl = input.updates?.feedUrl;
  if (feedUrl === undefined) return {};
  if (input.platform === 'win32')
    throw new ManagedUpdateRefusedError(
      "This machine's managed policy takes updates only from the organization's mirror, and the Windows installer cannot update from a mirror yet.",
    );
  const manifestUrl =
    input.ring === null
      ? null
      : managedUpdateServerManifestUrl(feedUrl, input.ring);
  if (!manifestUrl)
    throw new ManagedUpdateRefusedError(
      input.ring === null
        ? "This machine's managed policy takes updates only from the organization's mirror, and Station cannot tell which release channel's manifest this install updates from."
        : `This machine's managed policy takes updates only from the organization's mirror, which has no manifest for the ${input.ring} ring.`,
    );
  if (input.requestedManifestUrl && input.requestedManifestUrl !== manifestUrl)
    throw new ManagedUpdateRefusedError(
      "This machine's managed policy takes updates only from the organization's mirror; unset STATION_INSTALL_PUBLIC_MANIFEST_URL.",
    );
  return {
    STATION_INSTALL_PUBLIC_MANIFEST_URL: manifestUrl,
    [INSTALLER_MIRROR_ENV]: feedUrl,
  };
}

/**
 * The release ring a launcher-run update stays on (#4522). install.sh
 * records `releaseChannel` in the install state; an install state without
 * it, or a nightly-numbered version on either side, is read as nightly when
 * any signal says so, because a nightly refusal must not pass on a missing
 * field. Null when nothing names the ring.
 */
export function launcherUpdateRing(input: {
  releaseChannel: unknown;
  runtimeChannel: unknown;
  installedVersion: string;
  targetVersion?: string;
}): string | null {
  const nightlyVersion = (version: string | undefined) =>
    version !== undefined && /-nightly\./.test(version);
  if (
    input.releaseChannel === 'nightly' ||
    input.runtimeChannel === 'nightly' ||
    nightlyVersion(input.installedVersion) ||
    nightlyVersion(input.targetVersion)
  )
    return 'nightly';
  if (typeof input.releaseChannel === 'string' && input.releaseChannel !== '')
    return input.releaseChannel;
  return null;
}
