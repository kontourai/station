import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fsyncDirectorySync } from './fs-windows-compat.js';
import { acquireFileMutationLock } from './lifecycle-events.js';
import { admitStationRuntimeHome } from './runtime-path-resolver.js';

export const STATION_HOME_SCHEMA_VERSION = 1;
export const STATION_HOME_SCHEMA_FILE = '.station-home-schema.json';

/**
 * A single forward home-schema migration. Future migrations belong in
 * `STATION_HOME_SCHEMA_MIGRATIONS`; the gate derives the whole path rather
 * than making a schema-version bump silently select reset.
 */
export interface StationHomeSchemaMigration {
  fromVersion: number;
  migrate(homeDir: string): void;
}

/** Intentionally empty until Station has a v1 -> v2 migration to declare. */
export const STATION_HOME_SCHEMA_MIGRATIONS: readonly StationHomeSchemaMigration[] =
  [];

interface PathIdentity {
  dev: bigint;
  ino: bigint;
}

export interface StationHomeSchemaGateHooks {
  /** Test-only deterministic interleaving point, after the initial check. */
  beforeMarkerRevalidate?: () => void;
  /** Test-only fallback simulation immediately before opening the marker. */
  beforeMarkerOpen?: () => void;
  markerOpenFlags?: number;
  /** Test-only migration registry injection. Production uses the empty registry above. */
  migrations?: readonly StationHomeSchemaMigration[];
  /** Test-only lock replacement; production always uses the sibling lock. */
  acquireMutationLock?: (lockPath: string) => () => void;
}

/**
 * The exact command the reset-required error names (station#1913). Asserted
 * on directly in tests so the error text and the actual CLI verb cannot
 * drift apart the way the old "reset this home manually" text did -- it
 * named no command at all, which is why an incident recovery took two
 * attempts of improvised `mv` over SSH.
 */
export const STATION_HOME_RESET_COMMAND = 'station home reset --confirm';

export class StationHomeResetRequiredError extends Error {
  readonly code = 'STATION_HOME_RESET_REQUIRED';

  constructor(readonly homeDir: string) {
    super(
      `STATION_HOME_RESET_REQUIRED: Station home '${homeDir}' uses an incompatible schema. Run '${STATION_HOME_RESET_COMMAND}' to archive it and start fresh.`,
    );
  }
}

export class StationHomeMigrationRequiredError extends Error {
  readonly code = 'STATION_HOME_MIGRATION_REQUIRED';

  constructor(
    readonly fromVersion: number,
    readonly toVersion: number,
  ) {
    super(
      `STATION_HOME_MIGRATION_REQUIRED: no migration registered from home schema ${fromVersion} to ${toVersion}`,
    );
  }
}

export class StationHomeSchemaDowngradeError extends Error {
  readonly code = 'STATION_HOME_SCHEMA_DOWNGRADE_REFUSED';

  constructor(
    readonly homeVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `STATION_HOME_SCHEMA_DOWNGRADE_REFUSED: home schema ${homeVersion} is newer than this Station schema ${currentVersion}; refusing to migrate or reset it.`,
    );
  }
}

/**
 * A failed directory replacement can leave the old home at this sibling path.
 * Do not make an unverified backup authoritative automatically: failing closed
 * keeps Station from bootstrapping an empty home beside the user's data.
 */
export class StationHomeMigrationRecoveryRequiredError extends Error {
  readonly code = 'STATION_HOME_MIGRATION_RECOVERY_REQUIRED';

  constructor(
    readonly homeDir: string,
    readonly artifactPath: string,
    readonly homeExists: boolean,
  ) {
    const restore = `mv -- '${artifactPath}' '${homeDir}'`;
    super(
      homeExists
        ? `STATION_HOME_MIGRATION_RECOVERY_REQUIRED: found orphaned Station home migration backup '${artifactPath}' while '${homeDir}' contains only bootstrap scaffolding. Refusing to start an empty home beside stranded data. Move aside the bootstrap scaffolding, then run '${restore}'.`
        : `STATION_HOME_MIGRATION_RECOVERY_REQUIRED: found orphaned Station home migration backup '${artifactPath}' while '${homeDir}' is missing. Refusing to start an empty home beside stranded data. Recover it with '${restore}'.`,
    );
  }
}

export class StationHomeMigrationRegistryError extends Error {
  readonly code = 'STATION_HOME_MIGRATION_REGISTRY_INVALID';

  constructor(readonly detail: string) {
    super(`STATION_HOME_MIGRATION_REGISTRY_INVALID: ${detail}`);
  }
}

function identity(path: string): PathIdentity {
  const stats = lstatSync(path, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function reset(homeDir: string): never {
  throw new StationHomeResetRequiredError(homeDir);
}

/** Rejects a root symlink and returns a canonical child path beneath its parent. */
export function canonicalStationHome(homeDir: string): string {
  const requested = admitStationRuntimeHome(resolve(homeDir));
  const parent = dirname(requested);
  let canonicalParent: string;
  let parentStats: Stats;
  try {
    canonicalParent = realpathSync(parent);
    parentStats = lstatSync(canonicalParent);
  } catch {
    reset(requested);
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink())
    reset(requested);
  const canonicalHome = join(canonicalParent, basename(requested));
  if (!existsSync(canonicalHome)) return canonicalHome;
  let homeStats: Stats;
  try {
    homeStats = lstatSync(canonicalHome);
  } catch {
    reset(canonicalHome);
  }
  if (!homeStats.isDirectory() || homeStats.isSymbolicLink())
    reset(canonicalHome);
  if (realpathSync(canonicalHome) !== canonicalHome) reset(canonicalHome);
  return canonicalHome;
}

function assertHomeIdentity(homeDir: string, expected: PathIdentity): void {
  try {
    if (!sameIdentity(identity(homeDir), expected)) reset(homeDir);
  } catch {
    reset(homeDir);
  }
}

function sameRegularFile(
  left: ReturnType<typeof lstatSync>,
  right: ReturnType<typeof lstatSync>,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export interface SafeFileReadHooks {
  beforeOpen?: () => void;
  openFlags?: number;
  /**
   * When supplied, reject files exceeding this many bytes without allocating
   * an unbounded descriptor read. Existing callers retain `readFileSync`'s
   * historic behaviour by omitting this option.
   */
  maxBytes?: number;
}

function readDescriptorBounded(descriptor: number, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  const maximumRead = maxBytes + 1;
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumRead));
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  while (bytesRead < maximumRead) {
    const count = readSync(
      descriptor,
      chunk,
      0,
      Math.min(chunk.length, maximumRead - bytesRead),
      null,
    );
    if (count === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, count)));
    bytesRead += count;
  }
  if (bytesRead > maxBytes) {
    throw new RangeError('file exceeds maximum byte length');
  }
  return Buffer.concat(chunks, bytesRead).toString('utf8');
}

/**
 * O_NOFOLLOW is defense in depth only: descriptor identity must match the
 * pre-open regular file, so platforms without that flag still fail closed.
 */
export function readRegularFileNoFollow(
  homeDir: string,
  path: string,
  hooks: SafeFileReadHooks = {},
): string {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) reset(homeDir);
  } catch (error) {
    if (error instanceof StationHomeResetRequiredError) throw error;
    reset(homeDir);
  }
  hooks.beforeOpen?.();
  const descriptor = openSync(
    path,
    hooks.openFlags ?? constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const descriptorStats = fstatSync(descriptor);
    if (!sameRegularFile(before, descriptorStats)) reset(homeDir);
    if (hooks.maxBytes !== undefined && descriptorStats.size > hooks.maxBytes) {
      reset(homeDir);
    }
    let source: string;
    try {
      source =
        hooks.maxBytes === undefined
          ? readFileSync(descriptor, 'utf8')
          : readDescriptorBounded(descriptor, hooks.maxBytes);
    } catch (error) {
      if (error instanceof RangeError) reset(homeDir);
      throw error;
    }
    if (!sameRegularFile(before, fstatSync(descriptor))) reset(homeDir);
    if (!sameRegularFile(before, lstatSync(path))) reset(homeDir);
    return source;
  } finally {
    closeSync(descriptor);
  }
}

function markerVersion(
  homeDir: string,
  markerPath: string,
  hooks: StationHomeSchemaGateHooks,
): number | null {
  try {
    const stats = lstatSync(markerPath);
    if (!stats.isFile() || stats.isSymbolicLink()) reset(homeDir);
    const version = (
      JSON.parse(
        readRegularFileNoFollow(homeDir, markerPath, {
          beforeOpen: hooks.beforeMarkerOpen,
          openFlags: hooks.markerOpenFlags,
        }),
      ) as { version?: unknown }
    ).version;
    return typeof version === 'number' &&
      Number.isSafeInteger(version) &&
      version >= 0
      ? version
      : null;
  } catch (error) {
    if (error instanceof StationHomeResetRequiredError) throw error;
    return null;
  }
}

export function validateStationHomeMigrationRegistry(
  migrations: readonly StationHomeSchemaMigration[],
  targetVersion = STATION_HOME_SCHEMA_VERSION,
): void {
  const seen = new Map<number, number>();
  migrations.forEach((migration, index) => {
    const { fromVersion } = migration;
    if (!Number.isSafeInteger(fromVersion) || fromVersion <= 0) {
      throw new StationHomeMigrationRegistryError(
        `migration[${index}] has invalid fromVersion ${String(fromVersion)}; fromVersion must be a positive integer.`,
      );
    }
    if (fromVersion >= targetVersion) {
      throw new StationHomeMigrationRegistryError(
        `migration[${index}] has non-forward fromVersion ${fromVersion}; it must be less than target schema ${targetVersion}.`,
      );
    }
    const firstIndex = seen.get(fromVersion);
    if (firstIndex !== undefined) {
      throw new StationHomeMigrationRegistryError(
        `migration[${index}] duplicates fromVersion ${fromVersion} already declared by migration[${firstIndex}].`,
      );
    }
    seen.set(fromVersion, index);
  });
}

export function migrationPath(
  fromVersion: number,
  migrations: readonly StationHomeSchemaMigration[],
  targetVersion = STATION_HOME_SCHEMA_VERSION,
): readonly StationHomeSchemaMigration[] {
  validateStationHomeMigrationRegistry(migrations, targetVersion);
  const path: StationHomeSchemaMigration[] = [];
  for (let version = fromVersion; version < targetVersion; version += 1) {
    const migration = migrations.find(
      (candidate) => candidate.fromVersion === version,
    );
    if (!migration)
      throw new StationHomeMigrationRequiredError(version, version + 1);
    path.push(migration);
  }
  return path;
}

function migrateStationHome(
  homeDir: string,
  fromVersion: number,
  migrations: readonly StationHomeSchemaMigration[],
): void {
  const path = migrationPath(fromVersion, migrations);
  const stagingDir = join(
    dirname(homeDir),
    `.${basename(homeDir)}.station-home-migration.${process.pid}.${randomUUID()}`,
  );
  const backupDir = `${stagingDir}.previous`;
  try {
    // Migrations only mutate this sibling copy. If one throws, deleting it
    // leaves the live home byte-for-byte untouched, including its old marker.
    cpSync(homeDir, stagingDir, { recursive: true, verbatimSymlinks: true });
    for (const migration of path) migration.migrate(stagingDir);
    const stagedMarker = join(stagingDir, STATION_HOME_SCHEMA_FILE);
    writeFileSync(
      stagedMarker,
      JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }, null, 2),
      'utf8',
    );
    // The marker is written after every migration. The caller still owns the
    // existing sibling mutation lock, so another Station process cannot
    // publish a competing version during this replacement. Keep the old home
    // until the staged copy has taken its place; this makes an ordinary rename
    // failure recoverable in-process instead of deleting the only old copy.
    renameSync(homeDir, backupDir);
    try {
      renameSync(stagingDir, homeDir);
    } catch (error) {
      renameSync(backupDir, homeDir);
      throw error;
    }
    rmSync(backupDir, { recursive: true, force: true });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function isBootstrapScaffolding(homeDir: string): boolean {
  if (!existsSync(homeDir)) return true;
  for (const entry of readdirSync(homeDir)) {
    if (
      entry.startsWith(`${STATION_HOME_SCHEMA_FILE}.`) &&
      entry.endsWith('.tmp')
    ) {
      continue;
    }
    if (entry !== 'config') return false;
    const path = join(homeDir, entry);
    const stats = lstatSync(path);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      readdirSync(path).length > 0
    ) {
      return false;
    }
  }
  return true;
}

function orphanedMigrationBackup(homeDir: string): string | undefined {
  const parentDir = dirname(homeDir);
  const prefix = `.${basename(homeDir)}.station-home-migration.`;
  try {
    for (const entry of readdirSync(parentDir)) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.previous')) continue;
      try {
        const stats = lstatSync(join(parentDir, entry));
        if (stats.isDirectory() && !stats.isSymbolicLink())
          return join(parentDir, entry);
      } catch {
        // A concurrently removed candidate cannot strand the home.
      }
    }
    return undefined;
  } catch {
    reset(homeDir);
  }
}

function refuseOrphanedMigrationBootstrap(homeDir: string): void {
  const artifactPath = orphanedMigrationBackup(homeDir);
  if (artifactPath)
    throw new StationHomeMigrationRecoveryRequiredError(
      homeDir,
      artifactPath,
      existsSync(homeDir),
    );
}

/**
 * Read-only prediction of whether {@link ensureStationHomeSchemaSync} would
 * require the explicit reset bridge, without acquiring the mutation lock or
 * writing a marker. A parseable version mismatch now routes to migration or
 * an explicit refusal instead, so `station home reset --if-incompatible`
 * cannot silently archive it. A best-effort predicate: it can race a
 * concurrent writer the same way any other unlocked read can, but the real
 * gate (which does hold the lock) always runs immediately afterward and
 * remains the sole authority for whether Station actually starts.
 */
export function stationHomeSchemaNeedsReset(requestedHomeDir: string): boolean {
  try {
    const homeDir = canonicalStationHome(requestedHomeDir);
    const markerPath = join(homeDir, STATION_HOME_SCHEMA_FILE);
    if (existsSync(markerPath)) {
      // A parseable version is now routed by the authoritative gate to a
      // migration or an explicit refusal, never to automatic reset.
      return markerVersion(homeDir, markerPath, {}) === null;
    }
    return !isBootstrapScaffolding(homeDir);
  } catch (error) {
    if (error instanceof StationHomeResetRequiredError) return true;
    throw error;
  }
}

/** Read-only exact schema observation for backup/export admission. */
export function readStationHomeSchemaVersion(requestedHomeDir: string): number {
  const homeDir = canonicalStationHome(requestedHomeDir);
  const markerPath = join(homeDir, STATION_HOME_SCHEMA_FILE);
  if (!existsSync(markerPath)) reset(homeDir);
  const version = markerVersion(homeDir, markerPath, {});
  if (version === null) reset(homeDir);
  return version;
}

function writeSchemaMarker(
  homeDir: string,
  expectedHomeIdentity: PathIdentity | undefined,
): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const homeIdentity = identity(homeDir);
  if (
    expectedHomeIdentity &&
    !sameIdentity(homeIdentity, expectedHomeIdentity)
  ) {
    reset(homeDir);
  }
  const markerPath = join(homeDir, STATION_HOME_SCHEMA_FILE);
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(
        descriptor,
        JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }, null, 2),
        'utf8',
      );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    assertHomeIdentity(homeDir, homeIdentity);
    if (existsSync(markerPath) || !isBootstrapScaffolding(homeDir))
      reset(homeDir);
    renameSync(temporaryPath, markerPath);
    // A rename is not durable until the DIRECTORY entry is. Without this a
    // power loss can lose the marker while keeping the home it describes, and
    // the next boot fails closed with STATION_HOME_RESET_REQUIRED against a
    // home that was never actually wrong (station#3215 adversarial review).
    try {
      fsyncDirectorySync(homeDir);
    } catch {
      // Best-effort, matching this codebase's posture for durability-only
      // steps. The marker is already renamed into place, so the home is
      // CORRECT — refusing to boot over a failed fsync (EIO, or a filesystem
      // without a working fsyncdir) would reject a home that is fine.
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/**
 * Checks only directory/marker metadata before any application-data read. The
 * sibling lock is outside the home so lock acquisition cannot make a dirty
 * markerless home appear bootstrap-safe.
 */
export function ensureStationHomeSchemaSync(
  requestedHomeDir: string,
  hooks: StationHomeSchemaGateHooks = {},
): void {
  const homeDir = canonicalStationHome(requestedHomeDir);
  const migrations = hooks.migrations ?? STATION_HOME_SCHEMA_MIGRATIONS;
  validateStationHomeMigrationRegistry(migrations);
  const parentDir = dirname(homeDir);
  const parentIdentity = identity(parentDir);
  const lockPath = join(
    parentDir,
    `.${basename(homeDir)}.station-home-schema.lock`,
  );
  const release = (hooks.acquireMutationLock ?? acquireFileMutationLock)(
    lockPath,
  );
  try {
    if (!sameIdentity(identity(parentDir), parentIdentity)) reset(homeDir);
    const markerPath = join(homeDir, STATION_HOME_SCHEMA_FILE);
    if (existsSync(markerPath)) {
      const version = markerVersion(homeDir, markerPath, hooks);
      if (version === STATION_HOME_SCHEMA_VERSION) return;
      if (version === null) reset(homeDir);
      if (version > STATION_HOME_SCHEMA_VERSION)
        throw new StationHomeSchemaDowngradeError(
          version,
          STATION_HOME_SCHEMA_VERSION,
        );
      migrateStationHome(homeDir, version, migrations);
      return;
    }
    refuseOrphanedMigrationBootstrap(homeDir);
    if (!isBootstrapScaffolding(homeDir)) reset(homeDir);
    const homeIdentity = existsSync(homeDir) ? identity(homeDir) : undefined;
    hooks.beforeMarkerRevalidate?.();
    if (!sameIdentity(identity(parentDir), parentIdentity)) reset(homeDir);
    if (existsSync(markerPath) || !isBootstrapScaffolding(homeDir))
      reset(homeDir);
    if (homeIdentity) assertHomeIdentity(homeDir, homeIdentity);
    writeSchemaMarker(homeDir, homeIdentity);
  } finally {
    release();
  }
}

export async function ensureStationHomeSchema(
  requestedHomeDir: string,
  hooks: StationHomeSchemaGateHooks = {},
): Promise<void> {
  ensureStationHomeSchemaSync(requestedHomeDir, hooks);
}
