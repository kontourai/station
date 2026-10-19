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
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
}

export type StationHomeRestoreMarkerRead =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'present'; marker: StationHomeRestoreMarker };

export type StationHomeRestoreDecision =
  | { action: 'none' }
  | { action: 'restore'; marker: StationHomeRestoreMarker }
  | { action: 'await-commit'; marker: StationHomeRestoreMarker }
  | { action: 'refuse'; reason: string };

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
  if (running && sameRelease(running, marker.fromRelease))
    return { action: 'restore', marker };
  if (running && sameRelease(running, marker.targetRelease))
    return { action: 'await-commit', marker };
  return {
    action: 'refuse',
    reason: `the update restore marker names ${marker.fromRelease.version} (${marker.fromRelease.root}) and ${marker.targetRelease.version} (${marker.targetRelease.root}), and this is ${
      running
        ? `${running.version} (${running.root})`
        : 'a release that cannot state its identity'
    }`,
  };
}

/** Thrown at boot when the marker forbids starting on this home. */
export class StationHomeRestoreRefusedError extends Error {
  constructor(homeDir: string, reason: string) {
    super(
      `Station will not start on ${homeDir}: ${reason}. The home may hold changes from a release that is not running. Restore it from the backup the marker names, or remove ${stationHomeRestoreMarkerPath(homeDir)} once you know the home is right for this release.`,
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
}): StationHomeRestoreDecision['action'] {
  const read = readStationHomeRestoreMarker(input.homeDir);
  if (read.kind === 'absent') return 'none';
  const decision = decideStationHomeRestore(read, input.running());
  if (decision.action === 'refuse')
    throw new StationHomeRestoreRefusedError(input.homeDir, decision.reason);
  if (decision.action === 'restore') {
    (input.restore ?? restoreStationHomeUpdateBackup)({
      homeDir: input.homeDir,
      backupDir: decision.marker.backupDir,
    });
    clearStationHomeRestoreMarker(input.homeDir);
  }
  return decision.action;
}
