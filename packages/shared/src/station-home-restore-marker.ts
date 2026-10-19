/**
 * The Station home's update restore marker (#3851, agreed with the process
 * supervisor lane, packages/supervisor).
 *
 * A supervised apply backs up the home (`createStationHomeUpdateBackup`)
 * and writes this marker BEFORE it hands off to the next release. The
 * supervisor alone then promotes or rolls back. Whichever release boots
 * next reads the marker before the home schema gate
 * (`consumeStationHomeRestoreMarker`, called from src-server/index.ts) and
 * DERIVES what happened from which release it is:
 *
 * - it is the marker's from-release: the handoff was rolled back, and the
 *   target may have migrated the home, so the home is restored from the
 *   backup and the marker cleared;
 * - it is the target release: nothing yet; the commit outcome clears the
 *   marker (`clearStationHomeRestoreMarker`, which the supervisor link calls
 *   on a committed handoff);
 * - anything else (an unreadable marker, a marker naming neither release):
 *   boot is refused. Starting on a home that may have been migrated by a
 *   release that is not running is the failure this exists to prevent.
 *
 * Nothing writes the marker in production yet: the supervised apply path
 * that will is the supervisor lane's. The fixed service launcher's own
 * rollback (station-launcher.mjs) does not use it.
 *
 * The marker is `update-restore.json` at the home's top level, a `live` root
 * in the store registry: a backup leaves it out and a restore leaves it
 * alone, so restoring the home cannot erase the record of why it was
 * restored.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { restoreStationHomeUpdateBackup } from './station-home-archive.js';

export const STATION_HOME_RESTORE_MARKER = 'update-restore.json';
const MARKER_SCHEMA = 1;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/**
 * Which release a process is: its version and the real path of the release
 * root it runs from (an archive's version directory, a checkout's root).
 * Both must match for two identities to be one release.
 */
export interface StationReleaseIdentity {
  version: string;
  root: string;
}

export interface StationHomeRestoreMarker {
  schemaVersion: typeof MARKER_SCHEMA;
  /** The release the apply left; a boot of it means a rollback. */
  fromRelease: StationReleaseIdentity;
  /** The release the apply handed off to. */
  targetRelease: StationReleaseIdentity;
  /** The home backup taken before the handoff (absolute, outside the home). */
  backupDir: string;
  createdAt: string;
  /**
   * A boot's restore from `backupDir` failed (round 2 item 3): later boots
   * refuse rather than try again, so a service manager restarting a failed
   * boot never runs a restore beside the operator's.
   */
  restoreFailed?: { at: string; error: string };
}

export type StationHomeRestoreMarkerRead =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'present'; marker: StationHomeRestoreMarker };

export type StationHomeRestoreDecision =
  | { action: 'none' }
  | { action: 'restore'; marker: StationHomeRestoreMarker }
  | { action: 'await-commit'; marker: StationHomeRestoreMarker }
  | {
      action: 'refuse';
      reason: string;
      /** The marker, when it could be read: its backup is the way back. */
      marker?: StationHomeRestoreMarker;
    };

export function stationHomeRestoreMarkerPath(homeDir: string): string {
  return join(homeDir, STATION_HOME_RESTORE_MARKER);
}

function isIdentity(value: unknown): value is StationReleaseIdentity {
  if (!value || typeof value !== 'object') return false;
  const { version, root } = value as Record<string, unknown>;
  return (
    typeof version === 'string' &&
    VERSION.test(version) &&
    typeof root === 'string' &&
    isAbsolute(root)
  );
}

export function parseStationHomeRestoreMarker(
  text: string,
): StationHomeRestoreMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const marker = value as Record<string, unknown>;
  if (
    marker.schemaVersion !== MARKER_SCHEMA ||
    !isIdentity(marker.fromRelease) ||
    !isIdentity(marker.targetRelease) ||
    typeof marker.backupDir !== 'string' ||
    !isAbsolute(marker.backupDir) ||
    typeof marker.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(marker.createdAt))
  )
    return null;
  const failed = marker.restoreFailed as Record<string, unknown> | undefined;
  if (
    failed !== undefined &&
    (!failed ||
      typeof failed !== 'object' ||
      typeof failed.at !== 'string' ||
      typeof failed.error !== 'string')
  )
    return null;
  return {
    schemaVersion: MARKER_SCHEMA,
    fromRelease: {
      version: marker.fromRelease.version,
      root: marker.fromRelease.root,
    },
    targetRelease: {
      version: marker.targetRelease.version,
      root: marker.targetRelease.root,
    },
    backupDir: marker.backupDir,
    createdAt: marker.createdAt,
    ...(failed
      ? {
          restoreFailed: {
            at: failed.at as string,
            error: failed.error as string,
          },
        }
      : {}),
  };
}

/** Thrown when a marker is already present: an earlier handoff is unresolved. */
export class StationHomeRestoreMarkerExistsError extends Error {
  constructor(path: string) {
    super(
      `${path} already records an unfinished update handoff; resolve it before applying another`,
    );
    this.name = 'StationHomeRestoreMarkerExistsError';
  }
}

/**
 * Records a handoff, durably and exclusively: the marker appears complete or
 * not at all, and an existing marker (an unresolved earlier handoff) is
 * never replaced. Call it after the backup is complete, before the handoff.
 */
export function writeStationHomeRestoreMarker(
  homeDir: string,
  input: Omit<StationHomeRestoreMarker, 'schemaVersion' | 'createdAt'> & {
    createdAt?: string;
  },
): StationHomeRestoreMarker {
  const marker: StationHomeRestoreMarker = {
    schemaVersion: MARKER_SCHEMA,
    fromRelease: input.fromRelease,
    targetRelease: input.targetRelease,
    backupDir: input.backupDir,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const text = `${JSON.stringify(marker, null, 2)}\n`;
  if (!parseStationHomeRestoreMarker(text))
    throw new Error('Not a valid Station home restore marker');
  mkdirSync(homeDir, { recursive: true });
  const path = stationHomeRestoreMarkerPath(homeDir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new StationHomeRestoreMarkerExistsError(path);
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
  return marker;
}

export function readStationHomeRestoreMarker(
  homeDir: string,
): StationHomeRestoreMarkerRead {
  let text: string;
  try {
    text = readFileSync(stationHomeRestoreMarkerPath(homeDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind: 'absent' };
    return {
      kind: 'invalid',
      reason: `cannot be read (${(error as Error).message})`,
    };
  }
  const marker = parseStationHomeRestoreMarker(text);
  return marker
    ? { kind: 'present', marker }
    : { kind: 'invalid', reason: 'is not a restore marker this Station reads' };
}

/**
 * Records on the marker that a boot's restore failed, replacing it in place
 * (the marker exists: this is no new handoff).
 */
export function markStationHomeRestoreFailed(
  homeDir: string,
  marker: StationHomeRestoreMarker,
  error: string,
): void {
  const path = stationHomeRestoreMarkerPath(homeDir);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temp,
    `${JSON.stringify(
      { ...marker, restoreFailed: { at: new Date().toISOString(), error } },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  try {
    renameSync(temp, path);
  } catch (caught) {
    rmSync(temp, { force: true });
    throw caught;
  }
}

/** Removes the marker: the handoff it records is resolved. */
export function clearStationHomeRestoreMarker(homeDir: string): void {
  rmSync(stationHomeRestoreMarkerPath(homeDir), { force: true });
}

function sameRelease(
  left: StationReleaseIdentity,
  right: StationReleaseIdentity,
): boolean {
  if (left.version !== right.version) return false;
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(left.root) === real(right.root);
}

/** What a booting release must do about the marker; see the header. */
export function decideStationHomeRestore(
  read: StationHomeRestoreMarkerRead,
  running: StationReleaseIdentity | null,
): StationHomeRestoreDecision {
  if (read.kind === 'absent') return { action: 'none' };
  if (read.kind === 'invalid')
    return {
      action: 'refuse',
      reason: `the update restore marker ${read.reason}`,
    };
  const { marker } = read;
  if (
    running &&
    sameRelease(running, marker.fromRelease) &&
    marker.restoreFailed
  )
    return {
      action: 'refuse',
      reason: `an earlier boot could not restore the home from ${marker.backupDir} (${marker.restoreFailed.error}); it is not tried again automatically`,
      marker,
    };
  if (running && sameRelease(running, marker.fromRelease))
    return existsSync(marker.backupDir)
      ? { action: 'restore', marker }
      : {
          action: 'refuse',
          reason: `the update was rolled back, but the home backup ${marker.backupDir} the marker names is missing`,
          marker,
        };
  if (running && sameRelease(running, marker.targetRelease))
    return { action: 'await-commit', marker };
  return {
    action: 'refuse',
    reason: `the update restore marker names ${marker.fromRelease.version} (${marker.fromRelease.root}) and ${marker.targetRelease.version} (${marker.targetRelease.root}), and this is ${
      running
        ? `${running.version} (${running.root})`
        : 'a release that cannot state its identity'
    }`,
    marker,
  };
}

/**
 * How an operator restores the home by hand (round 2 item 3), in order:
 * stop the service, so its manager does not start this release (and its
 * boot) again meanwhile; restore with the from-release's own CLI (its store
 * registry decides what the backup holds), the one command that reads this
 * backup format; remove the marker; start the service. The CLI entry is
 * the release's own: `bin/station` (`bin\station.cmd` on Windows) in an
 * archive version, `station` at a source checkout's root.
 */
export function stationHomeRestoreRecovery(
  homeDir: string,
  marker: StationHomeRestoreMarker | undefined,
  options: { platform?: NodeJS.Platform; instance?: string } = {},
): string {
  const windows = (options.platform ?? process.platform) === 'win32';
  const markerPath = stationHomeRestoreMarkerPath(homeDir);
  const instance = options.instance ?? '<instance>';
  const remove = windows ? `del "${markerPath}"` : `rm "${markerPath}"`;
  const stop = `  1. Stop the service so it does not start Station again meanwhile: station service stop --instance=${instance}`;
  const start = `Start it again: station service start --instance=${instance}`;
  if (!marker)
    return [
      stop,
      `  2. Read ${markerPath} for the backup it names, and restore the home from it; or, if the home is right for the release you are starting, skip this.`,
      `  3. Remove the marker: ${remove}`,
      `  4. ${start}`,
    ].join('\n');
  const archiveEntry = existsSync(
    join(marker.fromRelease.root, 'bin', 'station.mjs'),
  );
  const entry = archiveEntry
    ? windows
      ? `${marker.fromRelease.root}\\bin\\station.cmd`
      : join(marker.fromRelease.root, 'bin', 'station')
    : windows
      ? `${marker.fromRelease.root}\\station.cmd`
      : join(marker.fromRelease.root, 'station');
  return [
    stop,
    `  2. Restore the home from ${marker.backupDir} with ${marker.fromRelease.version}'s own CLI:`,
    `     "${entry}" service update-home restore --backup-dir="${marker.backupDir}" --base="${homeDir}"`,
    `     (If the home is right for the release you are starting, ${marker.targetRelease.version}, skip this.)`,
    `  3. Remove the marker: ${remove}`,
    `  4. ${start}`,
  ].join('\n');
}

/** Thrown at boot when the marker forbids starting on this home. */
export class StationHomeRestoreRefusedError extends Error {
  constructor(
    homeDir: string,
    reason: string,
    marker?: StationHomeRestoreMarker,
    options: { platform?: NodeJS.Platform; instance?: string } = {},
  ) {
    super(
      `Station will not start on ${homeDir}: ${reason}. The home may hold changes from a release that is not running. To recover:\n${stationHomeRestoreRecovery(homeDir, marker, options)}`,
    );
    this.name = 'StationHomeRestoreRefusedError';
  }
}

/**
 * The boot-time consumer: runs before the home schema gate. Restores and
 * clears on a rollback boot, does nothing otherwise, and throws
 * `StationHomeRestoreRefusedError` when it must refuse. A failed restore
 * throws too and leaves the marker, so the next boot tries again.
 */
export function consumeStationHomeRestoreMarker(input: {
  homeDir: string;
  /** Resolved only when a marker is present. */
  running: () => StationReleaseIdentity | null;
  restore?: typeof restoreStationHomeUpdateBackup;
  /** For the recovery text: the service instance and the host platform. */
  instance?: string;
  platform?: NodeJS.Platform;
}): StationHomeRestoreDecision['action'] {
  const recovery = { instance: input.instance, platform: input.platform };
  const read = readStationHomeRestoreMarker(input.homeDir);
  if (read.kind === 'absent') return 'none';
  const decision = decideStationHomeRestore(read, input.running());
  if (decision.action === 'refuse')
    throw new StationHomeRestoreRefusedError(
      input.homeDir,
      decision.reason,
      decision.marker,
      recovery,
    );
  if (decision.action === 'restore') {
    try {
      (input.restore ?? restoreStationHomeUpdateBackup)({
        homeDir: input.homeDir,
        backupDir: decision.marker.backupDir,
      });
    } catch (error) {
      // Recorded on the marker, so the next boot refuses instead of trying
      // again beside the operator (round 2 item 3); the operator gets the
      // same way back as for any other refusal.
      const message = (error as Error).message;
      try {
        markStationHomeRestoreFailed(input.homeDir, decision.marker, message);
      } catch {
        // The refusal below still stops this boot.
      }
      throw new StationHomeRestoreRefusedError(
        input.homeDir,
        `restoring the home from ${decision.marker.backupDir} failed (${message})`,
        decision.marker,
        recovery,
      );
    }
    clearStationHomeRestoreMarker(input.homeDir);
  }
  return decision.action;
}
