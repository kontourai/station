/**
 * The managed policy's `limits.updates` (#4522) at the server's update
 * seams: the `/api/system/core-update` routes, the archive check and apply
 * in `archive-update.ts`, and the `ServerUpdateCoordinator` that checks and
 * downloads on its own.
 *
 * `off` and a disallowed nightly channel refuse every check, download and
 * install. A mirror (`feedUrl`) replaces the release download location, so
 * only an archive install can follow it: a desktop bundle and a source
 * checkout compare against a git remote the mirror does not serve, and are
 * refused rather than sent to the default.
 */
import {
  MANAGED_POLICY_UPDATES_REFUSED_CODE,
  type ManagedPolicyUpdatesLimit,
  managedUpdatesRefusal,
} from '@kontourai/station-contracts/managed-policy';
import type { InstallProvenance } from './install-provenance.js';

export interface ManagedUpdateRefusal {
  code: typeof MANAGED_POLICY_UPDATES_REFUSED_CODE;
  /** One sentence for the person asking; it never names the feed URL. */
  message: string;
}

/** The release channel an install updates from, when it has one. */
function updateChannel(provenance: InstallProvenance): string | null {
  if (provenance.installKind === 'archive')
    return provenance.release.releaseChannel;
  if (provenance.installKind === 'desktop-bundle') return provenance.channel;
  return null;
}

/**
 * Why the managed policy forbids this server's update checks and installs,
 * or null when it allows them. A mirror alone refuses only the install
 * kinds that cannot update from it.
 */
export function managedUpdateRefusalFor(
  provenance: InstallProvenance,
  updates: ManagedPolicyUpdatesLimit | null | undefined,
): ManagedUpdateRefusal | null {
  const refusal = managedUpdatesRefusal(updates, updateChannel(provenance));
  if (refusal)
    return { code: MANAGED_POLICY_UPDATES_REFUSED_CODE, message: refusal };
  if (
    updates?.feedUrl !== undefined &&
    (provenance.installKind === 'desktop-bundle' ||
      provenance.installKind === 'source-checkout')
  )
    return {
      code: MANAGED_POLICY_UPDATES_REFUSED_CODE,
      message:
        provenance.installKind === 'desktop-bundle'
          ? "This machine's managed policy takes updates only from the organization's mirror; the desktop app updates this Station from it"
          : "This machine's managed policy takes updates only from the organization's mirror, which a source checkout cannot update from",
    };
  return null;
}
