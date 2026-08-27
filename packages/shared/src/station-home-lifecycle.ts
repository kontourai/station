import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { writeJsonDurably } from './durable-json-file.js';
import { fsyncDirectorySync } from './fs-windows-compat.js';
import { acquireFileMutationLock } from './lifecycle-events.js';
import {
  exactProcessIdentity,
  type ProcessIdentityDependencies,
  probeExactProcessIdentity,
} from './process-identity.mjs';

const LEASE_VERSION = 1 as const;

interface RuntimeLeaseRecord {
  version: typeof LEASE_VERSION;
  ownerId: string;
  pid: number;
  birth: string;
}

export interface StationHomeLifecycleHooks {
  processIdentity?: ProcessIdentityDependencies;
  /** Bounded caller-owned acquisition policy for maintenance admission. */
  acquireMutationLock?: (path: string) => () => void;
  afterMaintenanceAcquired?: () => void;
}

export interface StationHomeRuntimeLease {
  readonly ownerId: string;
  release(): void;
}

export interface StationHomeMaintenanceLease {
  release(): void;
}

export class StationHomeLifecycleUnavailableError extends Error {
  readonly code = 'STATION_HOME_LIFECYCLE_UNAVAILABLE';

  constructor(message: string, options?: { cause?: unknown }) {
    super(`STATION_HOME_LIFECYCLE_UNAVAILABLE: ${message}`, options);
    this.name = 'StationHomeLifecycleUnavailableError';
  }
}

export class StationHomeActiveError extends Error {
  readonly code = 'STATION_HOME_ACTIVE';

  constructor() {
    super('STATION_HOME_ACTIVE: Station home has a live runtime');
    this.name = 'StationHomeActiveError';
  }
}

function coordinationPaths(homeDir: string) {
  let ancestor = resolve(homeDir);
  const missingSegments: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new StationHomeLifecycleUnavailableError(
        'Station home has no canonical existing ancestor',
      );
    }
    missingSegments.unshift(basename(ancestor));
    ancestor = parent;
  }
  const home = resolve(realpathSync(ancestor), ...missingSegments);
  const identity = process.platform === 'win32' ? home.toLowerCase() : home;
  const base = join(tmpdir(), 'kontourai-station-home-lifecycle');
  const root = join(base, createHash('sha256').update(identity).digest('hex'));
  return {
    base,
    root,
    leases: join(root, 'runtime-leases'),
    lock: join(root, 'mutation.lock'),
  };
}

function ensureCoordinationDirectory(path: string): void {
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) {
        throw error;
      }
    }
  }
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new StationHomeLifecycleUnavailableError(
      'Station home lifecycle coordination path is unsafe',
    );
  }
}

function prepareCoordination(
  paths: ReturnType<typeof coordinationPaths>,
): void {
  ensureCoordinationDirectory(paths.base);
  ensureCoordinationDirectory(paths.root);
  ensureCoordinationDirectory(paths.leases);
}

function isRuntimeLeaseRecord(value: unknown): value is RuntimeLeaseRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<RuntimeLeaseRecord>;
  return (
    record.version === LEASE_VERSION &&
    typeof record.ownerId === 'string' &&
    /^[0-9a-f-]{36}$/i.test(record.ownerId) &&
    Number.isInteger(record.pid) &&
    (record.pid ?? 0) > 0 &&
    typeof record.birth === 'string' &&
    record.birth.length > 0
  );
}

function readLease(path: string): RuntimeLeaseRecord {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new StationHomeLifecycleUnavailableError(
      'Station home runtime lease is unsafe',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StationHomeLifecycleUnavailableError(
      'Station home runtime lease is unreadable',
      { cause: error },
    );
  }
  if (!isRuntimeLeaseRecord(parsed)) {
    throw new StationHomeLifecycleUnavailableError(
      'Station home runtime lease is malformed',
    );
  }
  return parsed;
}

function removeLease(path: string): void {
  rmSync(path, { force: true });
  fsyncDirectorySync(dirname(path));
}

function listLiveLeases(
  leasesDir: string,
  dependencies?: ProcessIdentityDependencies,
): RuntimeLeaseRecord[] {
  const live: RuntimeLeaseRecord[] = [];
  for (const entry of readdirSync(leasesDir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !entry.name.endsWith('.json')
    ) {
      throw new StationHomeLifecycleUnavailableError(
        'Station home runtime lease directory contains an unsafe entry',
      );
    }
    const path = join(leasesDir, entry.name);
    const lease = readLease(path);
    const probe = probeExactProcessIdentity(lease.pid, dependencies);
    if (
      probe.state === 'dead' ||
      (probe.state === 'exact' && probe.identity.start !== lease.birth)
    ) {
      removeLease(path);
      continue;
    }
    live.push(lease);
  }
  return live;
}

function publishLease(path: string, lease: RuntimeLeaseRecord): void {
  writeJsonDurably(path, lease);
}

/**
 * Admit one runtime before it performs any STATION_HOME read or mutation.
 * Multiple runtimes may coexist; backup/restore holds the same mutation lock
 * while proving the runtime lease set empty.
 */
export function acquireStationHomeRuntimeLease(
  homeDir: string,
  hooks: StationHomeLifecycleHooks = {},
): StationHomeRuntimeLease {
  const paths = coordinationPaths(homeDir);
  prepareCoordination(paths);
  const releaseMutation = acquireFileMutationLock(paths.lock);
  try {
    listLiveLeases(paths.leases, hooks.processIdentity);
    const identity = exactProcessIdentity(process.pid, hooks.processIdentity);
    if (!identity) {
      throw new StationHomeLifecycleUnavailableError(
        'Current runtime process identity is unavailable',
      );
    }
    const ownerId = randomUUID();
    const path = join(paths.leases, `${ownerId}.json`);
    publishLease(path, {
      version: LEASE_VERSION,
      ownerId,
      pid: identity.pid,
      birth: identity.start,
    });
    let released = false;
    return {
      ownerId,
      release: () => {
        if (released) return;
        const release = acquireFileMutationLock(paths.lock);
        try {
          if (existsSync(path)) {
            const current = readLease(path);
            if (current.ownerId !== ownerId) {
              throw new StationHomeLifecycleUnavailableError(
                'Runtime lease ownership changed before release',
              );
            }
            removeLease(path);
          }
          released = true;
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    if (
      error instanceof StationHomeLifecycleUnavailableError ||
      error instanceof StationHomeActiveError
    ) {
      throw error;
    }
    throw new StationHomeLifecycleUnavailableError(
      'Runtime admission could not be established',
      { cause: error },
    );
  } finally {
    releaseMutation();
  }
}

/** Hold exclusive home maintenance ownership until the returned release. */
export function acquireStationHomeMaintenanceLease(
  homeDir: string,
  hooks: StationHomeLifecycleHooks = {},
): StationHomeMaintenanceLease {
  const paths = coordinationPaths(homeDir);
  prepareCoordination(paths);
  const release = (hooks.acquireMutationLock ?? acquireFileMutationLock)(
    paths.lock,
  );
  try {
    if (listLiveLeases(paths.leases, hooks.processIdentity).length > 0) {
      throw new StationHomeActiveError();
    }
    hooks.afterMaintenanceAcquired?.();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        release();
      },
    };
  } catch (error) {
    release();
    if (
      error instanceof StationHomeLifecycleUnavailableError ||
      error instanceof StationHomeActiveError
    ) {
      throw error;
    }
    throw new StationHomeLifecycleUnavailableError(
      'Maintenance ownership could not be established',
      { cause: error },
    );
  }
}
