/**
 * The server's side of the Station home update restore marker (#3851; the
 * marker and its decision live in
 * `@kontourai/station-shared/station-home-restore-marker`).
 *
 * `consumeHomeRestoreMarkerAtBoot` runs in src-server/index.ts immediately
 * before the home schema gate, in every mode: a release the supervisor
 * parked and then promoted runs the same boot, so nothing here is
 * supervisor-specific. `clearRestoreMarkerOnCommit` is what the supervisor
 * link registers for a committed handoff (`onHandoffOutcome`, owned by the
 * supervisor lane). `runningReleaseIdentity` is the one definition of
 * "which release is this", for the marker's writer and its reader alike.
 */
import { realpathSync } from 'node:fs';
import {
  clearStationHomeRestoreMarker,
  consumeStationHomeRestoreMarker,
  type StationReleaseIdentity,
} from '@kontourai/station-shared/station-home-restore-marker';
import type { InstallProvenance } from '../routes/system/install-provenance.js';
import { resolveThisServerProvenance } from '../routes/system/system-update-routes.js';
import { resolveHomeDir } from '../utils/paths.js';

/**
 * This server's release: an archive's version and version directory, or a
 * checkout's commit and root. Null for an install that cannot state one (a
 * desktop bundle updates through the desktop app, never through a handoff;
 * an install of unknown provenance), which a present marker refuses.
 */
export function runningReleaseIdentity(
  provenance: InstallProvenance = resolveThisServerProvenance(),
): StationReleaseIdentity | null {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  if (provenance.installKind === 'archive') {
    const root = real(provenance.archiveRoot);
    return root ? { version: provenance.version, root } : null;
  }
  if (provenance.installKind === 'source-checkout') {
    const root = real(provenance.gitRoot);
    return root ? { version: provenance.sha, root } : null;
  }
  return null;
}

/** Restores a rolled-back handoff's home before the schema gate; see above. */
export function consumeHomeRestoreMarkerAtBoot(
  homeDir: string,
  running: () => StationReleaseIdentity | null = runningReleaseIdentity,
): 'none' | 'restore' | 'await-commit' {
  // `running` is resolved only when a marker exists: an ordinary boot reads
  // one missing file and nothing else. A refusal throws.
  return consumeStationHomeRestoreMarker({ homeDir, running }) as
    | 'none'
    | 'restore'
    | 'await-commit';
}

/** The handoff committed: the home is the target's, nothing to restore. */
export function clearRestoreMarkerOnCommit(
  homeDir: string = resolveHomeDir(),
): void {
  clearStationHomeRestoreMarker(homeDir);
}
