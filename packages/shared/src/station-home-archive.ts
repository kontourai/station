import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fsyncDirectorySync, fsyncFileSync } from './fs-windows-compat.js';
import { SQLITE_CORRUPTION_MARKER_FILE } from './sqlite-corruption-marker.js';
import { openAndCheckSqliteIntegrity } from './sqlite-store-integrity.js';
import {
  acquireStationHomeMaintenanceLease,
  type StationHomeLifecycleHooks,
} from './station-home-lifecycle.js';
import {
  type DetachedRecoveryRecord,
  prepareDetachedRecoveryCandidate,
  type StationHomeRecoveryCandidatePlan,
} from './station-home-recovery-candidate.js';
import {
  canonicalStationHome,
  ensureStationHomeSchemaSync,
  readStationHomeSchemaVersion,
  STATION_HOME_SCHEMA_FILE,
  STATION_HOME_SCHEMA_VERSION,
} from './station-home-schema.js';
import {
  containsExternalStationHomePath,
  isExternalStationHomePath,
  isLiveStationHomeRoot,
  STATION_HOME_SQLITE_STORES,
} from './station-home-store-registry.js';

export const STATION_HOME_BACKUP_SCHEMA = 'station.home-backup/v1' as const;
/**
 * A supervised update's snapshot (#2675 D): `station.home-backup/v1` minus
 * the registry's `external` paths, plus the symbolic links under the state
 * it covers, recorded (never followed) so a restore puts them back as links.
 * A distinct schema, so neither restore accepts the other's backup.
 */
export const STATION_HOME_UPDATE_BACKUP_SCHEMA =
  'station.home-update-backup/v1' as const;
export const STATION_HOME_BACKUP_MANIFEST = 'station-home-backup.json';
export const STATION_HOME_RECOVERY_RECORD = 'station-home-recovery.json';

/** Recovery provenance is disclosure, never execution ownership. */
export interface StationHomeRecoveryRecord {
  schemaVersion: 'station.home-recovery/v1';
  kind: 'recovered-from-copy';
  recoveryId: string;
  recoveredAt: string;
  snapshotCreatedAt: string;
  backupManifestSha256: string;
  authorityTransferred: false;
}

export function readStationHomeRecovery(
  homeDir: string,
):
  | { kind: 'recovered'; recovery: StationHomeRecoveryRecord }
  | { kind: 'not-restored' | 'unavailable' } {
  let fd: number | undefined;
  try {
    const path = join(homeDir, STATION_HOME_RECOVERY_RECORD);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink())
      return { kind: 'unavailable' };
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size < 1 ||
      stat.size > 4096
    )
      return { kind: 'unavailable' };
    const bytes = Buffer.alloc(4097);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size) return { kind: 'unavailable' };
    const value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        [
          'schemaVersion',
          'kind',
          'recoveryId',
          'recoveredAt',
          'snapshotCreatedAt',
          'backupManifestSha256',
          'authorityTransferred',
        ]
          .sort()
          .join(',') ||
      value.schemaVersion !== 'station.home-recovery/v1' ||
      value.kind !== 'recovered-from-copy' ||
      value.authorityTransferred !== false ||
      typeof value.recoveryId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        value.recoveryId,
      ) ||
      typeof value.backupManifestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.backupManifestSha256) ||
      ![value.recoveredAt, value.snapshotCreatedAt].every(
        (v) =>
          typeof v === 'string' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
          new Date(v).toISOString() === v,
      )
    )
      return { kind: 'unavailable' };
    return { kind: 'recovered', recovery: value };
  } catch (error) {
    return {
      kind:
        fd === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'not-restored'
          : 'unavailable',
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const DEFAULT_STATION_HOME_BACKUP_MAX_FILES = 100_000;
export const DEFAULT_STATION_HOME_BACKUP_MAX_BYTES = 20 * 1024 * 1024 * 1024;
export const DEFAULT_STATION_HOME_BACKUP_MAX_FILE_BYTES =
  2 * 1024 * 1024 * 1024;

/**
 * An update backup's bounds. It covers only Station's own state (the user's
 * code and the browser's bytes are `external`), and a refused backup blocks
 * every update, so they bound resources rather than police size: the real
 * limit is the free space the backup is checked against before it copies
 * anything. No per-file cap below the total: one large SQLite store is
 * ordinary. The file count keeps the manifest a size one process can parse.
 */
export const DEFAULT_STATION_HOME_UPDATE_BACKUP_MAX_FILES = 250_000;
export const DEFAULT_STATION_HOME_UPDATE_BACKUP_MAX_BYTES =
  1024 * 1024 * 1024 * 1024;
const MAX_UPDATE_BACKUP_MANIFEST_BYTES = 256 * 1024 * 1024;
/** Free space an update backup leaves beyond its own bytes. */
const UPDATE_BACKUP_FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;
const MAX_SYMLINK_TARGET_LENGTH = 4096;

// The top-level entries a backup leaves out are the store registry's `live`
// roots (instances.json, logs, monitoring, quarantine, service, tmp). The
// quarantine (station#3217) is top level because `isTransient` only inspects
// `segments[0]`.
const SQLITE_TRANSIENT_SUFFIXES = ['-journal', '-shm', '-wal'];
// A corruption marker describes a database AT A MOMENT, and collectFiles
// already refuses to archive an unhealthy *.sqlite — so every archived home
// contains a database that passed quick_check. Carrying a marker alongside it
// would restore a home whose own backup proved the database healthy while
// asserting it is corrupt, and the quarantine step (station#3217) would then
// raze it (station#3215 adversarial review).

const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_BACKUP_MANIFEST_BYTES = 64 * 1024 * 1024;

export interface StationHomeBackupFile {
  path: string[];
  size: number;
  sha256: string;
  mode: number;
}

/**
 * A symbolic link under an update backup's state, as its text: never
 * followed by the backup or the restore. `directory` records whether it
 * resolved to a directory when recorded, which Windows needs to recreate it
 * (a junction or a directory link); elsewhere it is informational.
 */
export interface StationHomeBackupSymlink {
  path: string[];
  target: string;
  directory: boolean;
}

type BackupKind = 'home' | 'update';

export interface StationHomeBackupManifest {
  schemaVersion:
    | typeof STATION_HOME_BACKUP_SCHEMA
    | typeof STATION_HOME_UPDATE_BACKUP_SCHEMA;
  homeSchemaVersion: number;
  createdAt: string;
  files: StationHomeBackupFile[];
  /** Update backups only. */
  symlinks?: StationHomeBackupSymlink[];
  totalBytes: number;
}

export interface StationHomeBackupOptions {
  homeDir: string;
  outputDir: string;
  assertInactive?: () => void;
  now?: () => string;
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
  /** Private fault seam proving post-rename rollback. */
  afterPublish?: () => void;
  /** Private synchronization seam for lifecycle fault proofs. */
  lifecycleHooks?: StationHomeLifecycleHooks;
  /** Private fault seam: copies one file into the staging tree. */
  copyFile?: (source: string, target: string) => void;
  /** Private seam: the backup volume's free space (defaults to statfs). */
  statfs?: (directory: string) => { bavail: number; bsize: number };
}

export interface StationHomeRestoreOptions {
  backupDir: string;
  homeDir: string;
  confirm: boolean;
  assertInactive?: () => void;
  beforePublish?: () => void;
  /** Private fault seam proving post-rename rollback. */
  afterPublish?: () => void;
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
  /** Private synchronization seam for lifecycle fault proofs. */
  lifecycleHooks?: StationHomeLifecycleHooks;
}

export interface StationHomeBackupResult {
  backupDir: string;
  manifest: StationHomeBackupManifest;
}

export interface StationHomeRestoreResult {
  recovery: StationHomeRecoveryRecord;
  homeDir: string;
  previousHome?: string;
  manifest: StationHomeBackupManifest;
}

export class StationHomeArchiveError extends Error {
  readonly code = 'STATION_HOME_ARCHIVE_UNAVAILABLE';

  constructor(message: string, options?: { cause?: unknown }) {
    super(`STATION_HOME_ARCHIVE_UNAVAILABLE: ${message}`, options);
    this.name = 'StationHomeArchiveError';
  }
}

/**
 * Fixture-first, inert staging under the archive owner. This is not a backup,
 * migration, restore, forensic capture, or proof against hostile path swaps.
 * It accepts detached bytes, never a source home, and emits no active stores.
 */
export function stageStationHomeRecoveryCandidate(options: {
  declaredSourceSchemaVersion: 1;
  records: readonly DetachedRecoveryRecord[];
  outputDir: string;
  /** Private fault seam, not an import/publish authorization callback. */
  beforeStageCommit?: () => void;
  /** Private post-rename fault seam; the old staging name is no longer owned. */
  afterStageCommit?: () => void;
}): StationHomeRecoveryCandidatePlan {
  let staging: string | undefined;
  try {
    const prepared = prepareDetachedRecoveryCandidate(
      options.records,
      options.declaredSourceSchemaVersion,
    );
    const outputDir = resolve(options.outputDir);
    const parent = dirname(outputDir);
    if (existsSync(outputDir)) fail('detached recovery output already exists');
    const parentInfo = lstatSync(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
      fail('detached recovery output parent is unsafe');
    staging = join(parent, `.station-recovery-candidate-${randomUUID()}.tmp`);
    mkdirSync(staging, { mode: 0o700 });
    const evidence = join(staging, 'inert-evidence');
    mkdirSync(evidence, { mode: 0o700 });
    for (const payload of prepared.payloads) {
      const target = join(evidence, `${payload.reference}.payload`);
      writeFileSync(target, payload.bytes, { flag: 'wx', mode: 0o600 });
      syncFile(target);
    }
    const manifest = join(staging, 'recovery-candidate.json');
    const planBytes = Buffer.from(
      `${JSON.stringify(prepared.plan, null, 2)}\n`,
    );
    writeFileSync(manifest, planBytes, { flag: 'wx', mode: 0o600 });
    syncFile(manifest);
    syncDirectoryTree(staging);
    options.beforeStageCommit?.();
    // A candidate is an exact inert tree, never a partial ordinary home.
    // These observed checks are not an atomic hostile-filesystem boundary.
    const entries = readdirSync(staging).sort();
    const evidenceInfo = lstatSync(evidence);
    if (
      entries.length !== 2 ||
      entries[0] !== 'inert-evidence' ||
      entries[1] !== 'recovery-candidate.json' ||
      !evidenceInfo.isDirectory() ||
      evidenceInfo.isSymbolicLink()
    )
      fail('detached recovery staging changed');
    if (readdirSync(evidence).length !== prepared.payloads.length)
      fail('detached recovery evidence changed');
    for (const item of [
      { target: manifest, bytes: planBytes },
      ...prepared.payloads.map((payload) => ({
        target: join(evidence, `${payload.reference}.payload`),
        bytes: payload.bytes,
      })),
    ]) {
      const info = lstatSync(item.target);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size !== item.bytes.length ||
        (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) ||
        hashFile(item.target) !==
          createHash('sha256').update(item.bytes).digest('hex')
      )
        fail('detached recovery evidence changed');
    }
    if (existsSync(outputDir))
      fail('detached recovery output changed during staging');
    renameSync(staging, outputDir);
    staging = undefined;
    options.afterStageCommit?.();
    fsyncDirectorySync(parent);
    return prepared.plan;
  } catch {
    // Public errors contain no parser excerpts, input bytes, or nested cause.
    return fail(
      'detached recovery staging is unavailable; inert output may remain',
    );
  } finally {
    if (staging) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        /* Failed staging stays inert, never a bootable home. */
      }
    }
  }
}

function fail(message: string, cause?: unknown): never {
  throw new StationHomeArchiveError(message, { cause });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalLimits(
  options: {
    maxFiles?: number;
    maxBytes?: number;
    maxFileBytes?: number;
  },
  kind: BackupKind = 'home',
) {
  const update = kind === 'update';
  const maxFiles =
    options.maxFiles ??
    (update
      ? DEFAULT_STATION_HOME_UPDATE_BACKUP_MAX_FILES
      : DEFAULT_STATION_HOME_BACKUP_MAX_FILES);
  const maxBytes =
    options.maxBytes ??
    (update
      ? DEFAULT_STATION_HOME_UPDATE_BACKUP_MAX_BYTES
      : DEFAULT_STATION_HOME_BACKUP_MAX_BYTES);
  const maxFileBytes =
    options.maxFileBytes ??
    (update ? maxBytes : DEFAULT_STATION_HOME_BACKUP_MAX_FILE_BYTES);
  if (
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 1 ||
    maxFileBytes > maxBytes
  )
    fail('archive limits are invalid');
  return { maxFiles, maxBytes, maxFileBytes };
}

function isTransient(segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  if (isLiveStationHomeRoot(segments[0])) return true;
  const name = segments.at(-1) ?? '';
  return (
    name === SQLITE_CORRUPTION_MARKER_FILE ||
    name.endsWith('.lock') ||
    name.endsWith('.tmp') ||
    SQLITE_TRANSIENT_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

function assertSegment(segment: unknown): asserts segment is string {
  if (
    typeof segment !== 'string' ||
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\0')
  )
    fail('backup manifest contains an unsafe path segment');
  if (process.platform === 'win32' && segment.includes('\\'))
    fail('backup manifest contains an unsafe Windows path segment');
}

function pathFor(root: string, segments: readonly string[]): string {
  for (const segment of segments) assertSegment(segment);
  const path = resolve(root, ...segments);
  const relation = relative(root, path);
  if (relation === '' || relation.startsWith('..') || isAbsolute(relation))
    fail('backup manifest path escapes its root');
  return path;
}

function hashFile(path: string): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink())
    fail('archive file changed before hashing');
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      fail('archive file changed while opening');
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const digest = hash.digest('hex');
    const after = lstatSync(path);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      fail('archive file changed while hashing');
    return digest;
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectoryTree(
  root: string,
  skip?: (segments: readonly string[]) => boolean,
  parentSegments: readonly string[] = [],
): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) fail('archive staging contains a symlink');
    const segments = [...parentSegments, entry.name];
    if (skip?.(segments)) continue;
    syncDirectoryTree(join(root, entry.name), skip, segments);
  }
  fsyncDirectorySync(root);
}

function syncFile(path: string): void {
  fsyncFileSync(path);
}

/**
 * Fails closed on purpose: an archive must not carry a store whose integrity
 * is unproven, so "I could not look" is as disqualifying here as "the bytes
 * are bad". The scheduled probe (station#3218) needs those apart, and reaches
 * the same connection through `openAndCheckSqliteIntegrity` rather than a
 * second copy of this open.
 */
function sqliteIsHealthy(path: string, checkpoint: boolean): boolean {
  return openAndCheckSqliteIntegrity(path, { checkpoint }).kind === 'ok';
}

const REGISTERED_SQLITE_STORES = new Set(
  STATION_HOME_SQLITE_STORES.map((segments) => JSON.stringify(segments)),
);

/**
 * Whether a home file is a SQLite database to checkpoint and verify before
 * its bytes are recorded. A backup never copies `-wal`/`-shm` sidecars, so a
 * WAL-mode database whose newest commits are still in its WAL would be
 * archived without them: every `*.sqlite`, every store the registry names
 * (the knowledge index is a `.db`), and any database that has a WAL beside it
 * right now is checkpointed first.
 */
function isSqliteStoreEntry(
  path: string,
  segments: readonly string[],
): boolean {
  const name = segments.at(-1) ?? '';
  return (
    name.endsWith('.sqlite') ||
    REGISTERED_SQLITE_STORES.has(JSON.stringify(segments)) ||
    existsSync(`${path}-wal`)
  );
}

function assertSymlinkTarget(target: unknown): asserts target is string {
  if (
    typeof target !== 'string' ||
    target.length === 0 ||
    target.length > MAX_SYMLINK_TARGET_LENGTH ||
    target.includes('\0')
  )
    fail('backup contains an unusable symbolic link target');
}

function collectFiles(
  homeDir: string,
  limits: ReturnType<typeof canonicalLimits>,
  checkpointSqlite = false,
): StationHomeBackupFile[] {
  return collectEntries(homeDir, limits, { checkpointSqlite, kind: 'home' })
    .files;
}

/**
 * Walks a home in manifest order. `home` (station home backup): refuses a
 * symbolic link anywhere it looks. `update`: also leaves the `external`
 * paths out, and records each symbolic link as its text without following
 * it (#2675 D review: plugin aliases, Chromium's profile locks and
 * `node_modules/.bin` are ordinary, so refusing one blocked every update).
 */
function collectEntries(
  homeDir: string,
  limits: ReturnType<typeof canonicalLimits>,
  options: { checkpointSqlite?: boolean; kind: BackupKind },
): { files: StationHomeBackupFile[]; symlinks: StationHomeBackupSymlink[] } {
  const checkpointSqlite = options.checkpointSqlite ?? false;
  const update = options.kind === 'update';
  const files: StationHomeBackupFile[] = [];
  const symlinks: StationHomeBackupSymlink[] = [];
  let totalBytes = 0;
  const visit = (directory: string, parentSegments: string[]): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const segments = [...parentSegments, entry.name];
      if (isTransient(segments)) continue;
      if (update && isExternalStationHomePath(segments)) continue;
      assertSegment(entry.name);
      const path = join(directory, entry.name);
      let stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        if (!update)
          fail(
            `Station home contains a symbolic link at ${segments.join('/')}`,
          );
        const target = readlinkSync(path);
        assertSymlinkTarget(target);
        if (files.length + symlinks.length >= limits.maxFiles)
          fail('Station home exceeds the archive file-count limit');
        let directoryTarget = false;
        try {
          directoryTarget = statSync(path).isDirectory();
        } catch {
          // Dangling (Chromium's Singleton* links are): recorded as a link.
        }
        symlinks.push({ path: segments, target, directory: directoryTarget });
        continue;
      }
      if (stats.isDirectory()) {
        visit(path, segments);
        continue;
      }
      if (!stats.isFile())
        fail(
          `Station home contains a non-regular entry at ${segments.join('/')}`,
        );
      // The integrity adapter may checkpoint a WAL-bearing SQLite store. Its
      // checkpoint is deliberately before the authoritative lstat/size/hash
      // snapshot: otherwise the manifest can bind pre-checkpoint metadata to
      // post-checkpoint bytes and a healthy backup becomes self-inconsistent.
      if (isSqliteStoreEntry(path, segments)) {
        if (!sqliteIsHealthy(path, checkpointSqlite))
          fail(`SQLite integrity check failed at ${segments.join('/')}`);
        stats = lstatSync(path);
        if (!stats.isFile() || stats.isSymbolicLink())
          fail(
            `SQLite store changed type during check at ${segments.join('/')}`,
          );
      }
      if (stats.size > limits.maxFileBytes)
        fail(
          `Station home file exceeds the archive limit at ${segments.join('/')}`,
        );
      totalBytes += stats.size;
      if (totalBytes > limits.maxBytes)
        fail('Station home exceeds the archive byte limit');
      if (files.length + symlinks.length >= limits.maxFiles)
        fail('Station home exceeds the archive file-count limit');
      files.push({
        path: segments,
        size: stats.size,
        sha256: hashFile(path),
        mode: stats.mode & 0o777,
      });
    }
  };
  visit(homeDir, []);
  return { files, symlinks };
}

function strictManifest(
  value: unknown,
  limits: ReturnType<typeof canonicalLimits>,
  kind: BackupKind = 'home',
): StationHomeBackupManifest {
  if (!isPlainRecord(value)) fail('backup manifest must be an object');
  const update = kind === 'update';
  if (
    Object.keys(value).sort().join(',') !==
    [
      'createdAt',
      'files',
      'homeSchemaVersion',
      'schemaVersion',
      'totalBytes',
      ...(update ? ['symlinks'] : []),
    ]
      .sort()
      .join(',')
  )
    fail('backup manifest contains unknown or missing fields');
  if (
    value.schemaVersion !==
      (update
        ? STATION_HOME_UPDATE_BACKUP_SCHEMA
        : STATION_HOME_BACKUP_SCHEMA) ||
    (update && !Array.isArray(value.symlinks)) ||
    !Number.isSafeInteger(value.homeSchemaVersion) ||
    (value.homeSchemaVersion as number) < 1 ||
    (value.homeSchemaVersion as number) > STATION_HOME_SCHEMA_VERSION ||
    typeof value.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    !Array.isArray(value.files) ||
    !Number.isSafeInteger(value.totalBytes) ||
    (value.totalBytes as number) < 0
  )
    fail('backup manifest has an unsupported shape');
  if (value.files.length > limits.maxFiles)
    fail('backup manifest exceeds the file-count limit');
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = value.files.map((entry): StationHomeBackupFile => {
    if (
      !isPlainRecord(entry) ||
      Object.keys(entry).sort().join(',') !==
        ['mode', 'path', 'sha256', 'size'].sort().join(',') ||
      !Array.isArray(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.size as number) > limits.maxFileBytes ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.mode) ||
      (entry.mode as number) < 0 ||
      (entry.mode as number) > 0o777
    )
      fail('backup manifest contains an invalid file entry');
    const segments = entry.path.map((segment) => {
      assertSegment(segment);
      return segment;
    });
    const key = JSON.stringify(segments);
    if (seen.has(key)) fail('backup manifest contains a duplicate path');
    seen.add(key);
    totalBytes += entry.size as number;
    if (totalBytes > limits.maxBytes)
      fail('backup manifest exceeds the byte limit');
    return {
      path: segments,
      size: entry.size as number,
      sha256: entry.sha256,
      mode: entry.mode as number,
    };
  });
  if (totalBytes !== value.totalBytes)
    fail('backup manifest total does not match its files');
  if (!update)
    return {
      schemaVersion: STATION_HOME_BACKUP_SCHEMA,
      homeSchemaVersion: value.homeSchemaVersion as number,
      createdAt: value.createdAt,
      files,
      totalBytes,
    };
  const rawSymlinks = value.symlinks as unknown[];
  if (files.length + rawSymlinks.length > limits.maxFiles)
    fail('backup manifest exceeds the file-count limit');
  const symlinks = rawSymlinks.map((entry): StationHomeBackupSymlink => {
    if (
      !isPlainRecord(entry) ||
      Object.keys(entry).sort().join(',') !== 'directory,path,target' ||
      !Array.isArray(entry.path) ||
      typeof entry.directory !== 'boolean'
    )
      fail('backup manifest contains an invalid symbolic link entry');
    assertSymlinkTarget(entry.target);
    const segments = entry.path.map((segment) => {
      assertSegment(segment);
      return segment;
    });
    const key = JSON.stringify(segments);
    if (seen.has(key)) fail('backup manifest contains a duplicate path');
    seen.add(key);
    return { path: segments, target: entry.target, directory: entry.directory };
  });
  // A restore recreates links before or after the files; either way nothing
  // may be written THROUGH a recorded link. A tampered manifest that put a
  // file or another link below one would have the restore place it wherever
  // that link points, outside the home.
  // Compared case-folded and NFC-normalized on every platform: on a
  // case-insensitive or normalizing volume (APFS, NTFS) `STATION-SHARED`
  // names the same directory entry as a recorded `station-shared` link.
  const fold = (segment: string) => segment.normalize('NFC').toLowerCase();
  const linkKeys = symlinks.map((link) => link.path.map(fold));
  const below = (path: string[], link: string[]) =>
    path.length > link.length &&
    link.every((segment, index) => fold(path[index] ?? '') === segment);
  for (const entry of [...files, ...symlinks]) {
    if (linkKeys.some((link) => below(entry.path, link)))
      fail('backup manifest places a path below a symbolic link');
  }
  return {
    schemaVersion: STATION_HOME_UPDATE_BACKUP_SCHEMA,
    homeSchemaVersion: value.homeSchemaVersion as number,
    createdAt: value.createdAt,
    files,
    symlinks,
    totalBytes,
  };
}

function validateBackupDirectory(
  backupDir: string,
  limits: ReturnType<typeof canonicalLimits>,
  kind: BackupKind = 'home',
): StationHomeBackupManifest {
  const root = resolve(backupDir);
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
    fail('backup root must be a regular directory');
  const manifestPath = join(root, STATION_HOME_BACKUP_MANIFEST);
  const manifestStats = lstatSync(manifestPath);
  if (
    !manifestStats.isFile() ||
    manifestStats.isSymbolicLink() ||
    manifestStats.size >
      (kind === 'update'
        ? MAX_UPDATE_BACKUP_MANIFEST_BYTES
        : MAX_BACKUP_MANIFEST_BYTES)
  )
    fail('backup manifest must be a regular file');
  let manifest: StationHomeBackupManifest;
  try {
    manifest = strictManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
      limits,
      kind,
    );
  } catch (error) {
    if (error instanceof StationHomeArchiveError) throw error;
    fail('backup manifest is not valid JSON', error);
  }
  const contentRoot = join(root, 'home');
  // A backup's copy holds regular files only (links live in its manifest).
  const actual = collectFiles(contentRoot, limits, false);
  if (actual.length !== manifest.files.length)
    fail('backup contents do not match the manifest');
  for (let index = 0; index < actual.length; index += 1) {
    const expected = manifest.files[index];
    const observed = actual[index];
    if (
      JSON.stringify(expected.path) !== JSON.stringify(observed.path) ||
      expected.size !== observed.size ||
      expected.sha256 !== observed.sha256
    )
      fail('backup content hash does not match the manifest');
  }
  const marker = manifest.files.find(
    (entry) =>
      entry.path.length === 1 && entry.path[0] === STATION_HOME_SCHEMA_FILE,
  );
  if (!marker) fail('backup does not contain a Station home schema marker');
  const markerValue = JSON.parse(
    readFileSync(pathFor(contentRoot, marker.path), 'utf8'),
  ) as { version?: unknown };
  if (markerValue.version !== manifest.homeSchemaVersion)
    fail('backup schema marker does not match the manifest');
  return manifest;
}

function assertExternalPath(homeDir: string, otherPath: string): void {
  const relation = relative(homeDir, otherPath);
  if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation)))
    fail('backup and staging paths must remain outside STATION_HOME');
}

function assertInactive(
  operation: 'backup' | 'restore',
  check: (() => void) | undefined,
): void {
  try {
    check?.();
  } catch (error) {
    fail(
      `Station home must be inactive before ${operation}; stop every instance and retry`,
      error,
    );
  }
}

export function createStationHomeBackup(
  options: StationHomeBackupOptions,
): StationHomeBackupResult {
  return createBackup(options, 'home');
}

/**
 * Fails before any copy when the backup's volume cannot hold it. Each file
 * occupies whole blocks, so its size is rounded up to the block size: a home
 * of many small files needs far more than the sum of their bytes.
 */
function assertFreeSpace(
  directory: string,
  sizes: readonly number[],
  statfs: (directory: string) => { bavail: number; bsize: number } = (path) =>
    statfsSync(path),
): void {
  let available: number;
  let block: number;
  try {
    const stats = statfs(directory);
    available = stats.bavail * stats.bsize;
    block = stats.bsize > 0 ? stats.bsize : 1;
  } catch {
    // No statfs here: the copy's own ENOSPC is the check.
    return;
  }
  const bytes = sizes.reduce(
    (total, size) => total + Math.ceil(size / block) * block,
    0,
  );
  const needed = bytes + UPDATE_BACKUP_FREE_SPACE_MARGIN_BYTES;
  if (available < needed)
    fail(
      `not enough free space for the update backup: it needs ${needed} bytes and ${available} are free`,
    );
}

function createBackup(
  options: StationHomeBackupOptions,
  kind: BackupKind,
): StationHomeBackupResult {
  const limits = canonicalLimits(options, kind);
  const homeDir = canonicalStationHome(options.homeDir);
  if (!existsSync(homeDir)) fail('Station home does not exist');
  const outputDir = resolve(options.outputDir);
  assertExternalPath(homeDir, outputDir);
  if (existsSync(outputDir)) fail('backup output already exists');
  const outputParent = dirname(outputDir);
  const parentStats = lstatSync(outputParent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink())
    fail('backup output parent must be a regular directory');
  const staging = join(
    outputParent,
    `.${basename(outputDir)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let release: () => void;
  try {
    release = acquireStationHomeMaintenanceLease(
      homeDir,
      options.lifecycleHooks,
    ).release;
  } catch (error) {
    fail(
      'Station home must be inactive before backup; stop every instance and retry',
      error,
    );
  }
  try {
    assertInactive('backup', options.assertInactive);
    const homeSchemaVersion = readStationHomeSchemaVersion(homeDir);
    if (homeSchemaVersion > STATION_HOME_SCHEMA_VERSION)
      fail('Station home schema is newer than this Station');
    const { files, symlinks } = collectEntries(homeDir, limits, {
      checkpointSqlite: true,
      kind,
    });
    assertInactive('backup', options.assertInactive);
    if (kind === 'update')
      assertFreeSpace(
        outputParent,
        files.map((file) => file.size),
        options.statfs,
      );
    mkdirSync(staging, { mode: 0o700 });
    const stagingStats = lstatSync(staging);
    if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink())
      fail('backup staging root is unsafe');
    const contentRoot = join(staging, 'home');
    mkdirSync(contentRoot, { mode: 0o700 });
    for (const file of files) {
      const source = pathFor(homeDir, file.path);
      const target = pathFor(contentRoot, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      (
        options.copyFile ??
        ((from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL))
      )(source, target);
      if (process.platform !== 'win32') chmodSync(target, file.mode);
      const copied = lstatSync(target);
      if (
        !copied.isFile() ||
        copied.isSymbolicLink() ||
        copied.size !== file.size ||
        hashFile(target) !== file.sha256
      )
        fail(`Station home changed during backup at ${file.path.join('/')}`);
      syncFile(target);
    }
    const createdAt = (options.now ?? (() => new Date().toISOString()))();
    if (Number.isNaN(Date.parse(createdAt))) fail('backup clock is invalid');
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    const manifest: StationHomeBackupManifest =
      kind === 'update'
        ? {
            schemaVersion: STATION_HOME_UPDATE_BACKUP_SCHEMA,
            homeSchemaVersion,
            createdAt,
            files,
            symlinks,
            totalBytes,
          }
        : {
            schemaVersion: STATION_HOME_BACKUP_SCHEMA,
            homeSchemaVersion,
            createdAt,
            files,
            totalBytes,
          };
    const manifestPath = join(staging, STATION_HOME_BACKUP_MANIFEST);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    syncFile(manifestPath);
    syncDirectoryTree(staging);
    assertInactive('backup', options.assertInactive);
    renameSync(staging, outputDir);
    try {
      options.afterPublish?.();
      fsyncDirectorySync(outputParent);
    } catch (error) {
      try {
        rmSync(outputDir, { recursive: true, force: true });
        fsyncDirectorySync(outputParent);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Backup publication and rollback both failed.',
        );
      }
      throw error;
    }
    return { backupDir: outputDir, manifest };
  } catch (error) {
    if (error instanceof StationHomeArchiveError) throw error;
    fail('backup could not be created', error);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    release();
  }
}

export function restoreStationHomeBackup(
  options: StationHomeRestoreOptions,
): StationHomeRestoreResult {
  if (!options.confirm) fail('restore requires explicit confirmation');
  const limits = canonicalLimits(options);
  const homeDir = canonicalStationHome(options.homeDir);
  const backupDir = realpathSync(resolve(options.backupDir));
  assertExternalPath(homeDir, backupDir);
  const manifest = validateBackupDirectory(backupDir, limits);
  const parent = dirname(homeDir);
  const staging = join(
    parent,
    `.${basename(homeDir)}.${process.pid}.${randomUUID()}.restore.tmp`,
  );
  const previous = join(
    parent,
    `.${basename(homeDir)}.pre-restore.${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  let release: () => void;
  try {
    release = acquireStationHomeMaintenanceLease(
      homeDir,
      options.lifecycleHooks,
    ).release;
  } catch (error) {
    fail(
      'Station home must be inactive before restore; stop every instance and retry',
      error,
    );
  }
  const recovery: StationHomeRecoveryRecord = {
    schemaVersion: 'station.home-recovery/v1',
    kind: 'recovered-from-copy',
    recoveryId: randomUUID(),
    recoveredAt: new Date().toISOString(),
    snapshotCreatedAt: manifest.createdAt,
    backupManifestSha256: createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex'),
    authorityTransferred: false,
  };
  let movedPrevious = false;
  try {
    assertInactive('restore', options.assertInactive);
    const contentRoot = join(backupDir, 'home');
    mkdirSync(staging, { mode: 0o700 });
    const stagingStats = lstatSync(staging);
    if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink())
      fail('restore staging root is unsafe');
    for (const file of manifest.files) {
      const source = pathFor(contentRoot, file.path);
      const target = pathFor(staging, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') chmodSync(target, file.mode);
      syncFile(target);
    }
    const stagedFiles = collectFiles(staging, limits, false);
    if (
      stagedFiles.length !== manifest.files.length ||
      stagedFiles.some((file, index) => {
        const expected = manifest.files[index];
        return (
          !expected ||
          JSON.stringify(file.path) !== JSON.stringify(expected.path) ||
          file.sha256 !== expected.sha256
        );
      })
    )
      fail('staged restore does not match the validated backup');
    // Publish disclosure with the restored home, after verifying copied bytes.
    // Repeated restores replace only this reserved metadata file; no nested
    // history or credentials are exposed in the record.
    const recoveryPath = join(staging, STATION_HOME_RECOVERY_RECORD);
    const recoveryTemp = `${recoveryPath}.${randomUUID()}.tmp`;
    writeFileSync(recoveryTemp, `${JSON.stringify(recovery)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    syncFile(recoveryTemp);
    renameSync(recoveryTemp, recoveryPath);
    syncDirectoryTree(staging);
    options.beforePublish?.();
    assertInactive('restore', options.assertInactive);
    if (existsSync(homeDir)) {
      if (existsSync(previous)) fail('restore recovery path already exists');
      renameSync(homeDir, previous);
      movedPrevious = true;
    }
    try {
      renameSync(staging, homeDir);
    } catch (error) {
      if (movedPrevious) renameSync(previous, homeDir);
      movedPrevious = false;
      throw error;
    }
    try {
      options.afterPublish?.();
      ensureStationHomeSchemaSync(homeDir);
      fsyncDirectorySync(parent);
    } catch (error) {
      try {
        rmSync(homeDir, { recursive: true, force: true });
        if (movedPrevious) renameSync(previous, homeDir);
        fsyncDirectorySync(parent);
        movedPrevious = false;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Home restore and rollback both failed.',
        );
      }
      throw error;
    }
    return {
      recovery,
      homeDir,
      ...(movedPrevious ? { previousHome: previous } : {}),
      manifest,
    };
  } catch (error) {
    if (error instanceof StationHomeArchiveError) throw error;
    fail('backup could not be restored', error);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    release();
  }
}

export function readStationHomeBackupManifest(
  backupDir: string,
  options: Pick<
    StationHomeRestoreOptions,
    'maxFiles' | 'maxBytes' | 'maxFileBytes'
  > = {},
): StationHomeBackupManifest {
  try {
    return validateBackupDirectory(
      resolve(backupDir),
      canonicalLimits(options),
    );
  } catch (error) {
    if (error instanceof StationHomeArchiveError) throw error;
    fail('backup manifest could not be validated', error);
  }
}

export interface StationHomeUpdateBackupOptions
  extends Pick<
    StationHomeBackupOptions,
    | 'maxFiles'
    | 'maxBytes'
    | 'maxFileBytes'
    | 'lifecycleHooks'
    | 'copyFile'
    | 'statfs'
  > {
  homeDir: string;
  /** Outside the home; one per update (install root's runtime/update-backups/<id>). */
  backupDir: string;
}

/**
 * The snapshot a supervised update takes of a stopped home before its trial
 * (#2675 slice D): every `state` entry of the store registry, which includes
 * `.station-home-schema.json`, and none of the `live` or `external` ones.
 * Symbolic links under that state are recorded as links (see
 * `StationHomeBackupSymlink`). Published by one rename.
 *
 * Taken ONCE per update. An existing backup is validated and kept, never
 * replaced: a launcher that restarts after a trial began is looking at a home
 * the trial may already have written, and a second snapshot would make that
 * the state a rollback restores. Reusing it still takes the home's
 * maintenance lease, so a Station that started on the home while the
 * launcher was down (a desktop sidecar) stops the update here, exactly as it
 * would stop a first backup.
 */
export function createStationHomeUpdateBackup(
  options: StationHomeUpdateBackupOptions,
): StationHomeBackupResult & { reused: boolean } {
  const backupDir = resolve(options.backupDir);
  if (existsSync(backupDir)) {
    const homeDir = canonicalStationHome(options.homeDir);
    let release: () => void;
    try {
      release = acquireStationHomeMaintenanceLease(
        homeDir,
        options.lifecycleHooks,
      ).release;
    } catch (error) {
      fail(
        'Station home must be inactive before backup; stop every instance and retry',
        error,
      );
    }
    try {
      return {
        backupDir,
        manifest: validateBackupDirectory(
          backupDir,
          canonicalLimits(options, 'update'),
          'update',
        ),
        reused: true,
      };
    } catch (error) {
      if (error instanceof StationHomeArchiveError) throw error;
      fail('update backup could not be validated', error);
    } finally {
      release();
    }
  }
  return {
    ...createBackup({ ...options, outputDir: backupDir }, 'update'),
    reused: false,
  };
}

export interface StationHomeUpdateRestoreOptions
  extends Pick<
    StationHomeRestoreOptions,
    'maxFiles' | 'maxBytes' | 'maxFileBytes' | 'lifecycleHooks'
  > {
  homeDir: string;
  backupDir: string;
  /** Private fault seam: runs after the state entries are removed. */
  afterRemove?: () => void;
}

/** Whether an update leaves this home path to its owner (live or external). */
function outsideUpdate(segments: readonly string[]): boolean {
  return isTransient(segments) || isExternalStationHomePath(segments);
}

/**
 * Removes every `state` entry below `directory`, descending only into a
 * real directory that holds an `external` path (so `browser/` loses its
 * Station files but keeps `browser/profiles`). rmSync never follows a link.
 */
function removeUpdateState(directory: string, parentSegments: string[]): void {
  for (const name of readdirSync(directory)) {
    const segments = [...parentSegments, name];
    if (parentSegments.length === 0 && isLiveStationHomeRoot(name)) continue;
    if (isExternalStationHomePath(segments)) continue;
    const path = join(directory, name);
    if (containsExternalStationHomePath(segments)) {
      const stats = lstatSync(path);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        removeUpdateState(path, segments);
        continue;
      }
    }
    rmSync(path, { recursive: true, force: true });
  }
}

function symlinkType(link: StationHomeBackupSymlink) {
  if (process.platform !== 'win32') return undefined;
  if (!link.directory) return 'file' as const;
  // A junction needs an absolute target; a relative one is a directory link.
  return isAbsolute(link.target) ? ('junction' as const) : ('dir' as const);
}

/**
 * Puts a home back to an update backup IN PLACE (#2675 slice D): every
 * `state` entry is removed, then every file the backup holds is copied back
 * and verified against its hash, and every symbolic link it recorded is
 * created again with its recorded text. `live` entries (the service
 * manifests, the process registry, logs) and `external` ones (users'
 * repositories, the browser's bytes) are never touched, which is why this is
 * not `restoreStationHomeBackup`: that one swaps the whole home directory for
 * the backup and would drop them.
 *
 * Links are created last, after every file and directory: no copy can ever
 * write through one, whatever its target. Their targets are restored as
 * recorded, not checked for containment: they are the home's own links from
 * before the trial (a plugin draft's `node_modules` links into the version
 * that built it, outside the home, by design), and nothing here follows them.
 *
 * Idempotent, so a rollback interrupted at any point is finished by running
 * it again: the backup is only read, and each run starts by removing whatever
 * a previous run (or the trial) left in the state entries.
 */
export function restoreStationHomeUpdateBackup(
  options: StationHomeUpdateRestoreOptions,
): { manifest: StationHomeBackupManifest } {
  const limits = canonicalLimits(options, 'update');
  const homeDir = canonicalStationHome(options.homeDir);
  const backupDir = realpathSync(resolve(options.backupDir));
  assertExternalPath(homeDir, backupDir);
  const manifest = validateBackupDirectory(backupDir, limits, 'update');
  // A backup written under another registry may hold an entry that is live
  // or external now; those are this home's, so they are left as they are.
  const restorable = manifest.files.filter((file) => !outsideUpdate(file.path));
  const links = (manifest.symlinks ?? []).filter(
    (link) => !outsideUpdate(link.path),
  );
  let release: () => void;
  try {
    release = acquireStationHomeMaintenanceLease(
      homeDir,
      options.lifecycleHooks,
    ).release;
  } catch (error) {
    fail(
      'Station home must be inactive before restore; stop every instance and retry',
      error,
    );
  }
  try {
    const homeStats = lstatSync(homeDir);
    if (!homeStats.isDirectory() || homeStats.isSymbolicLink())
      fail('Station home must be a regular directory');
    removeUpdateState(homeDir, []);
    fsyncDirectorySync(homeDir);
    options.afterRemove?.();
    const contentRoot = join(backupDir, 'home');
    for (const file of restorable) {
      const source = pathFor(contentRoot, file.path);
      const target = pathFor(homeDir, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') chmodSync(target, file.mode);
      syncFile(target);
    }
    for (const link of links) {
      const path = pathFor(homeDir, link.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      symlinkSync(link.target, path, symlinkType(link));
    }
    const restored = collectEntries(homeDir, limits, { kind: 'update' });
    if (
      restored.files.length !== restorable.length ||
      restored.files.some((file, index) => {
        const expected = restorable[index];
        return (
          !expected ||
          JSON.stringify(file.path) !== JSON.stringify(expected.path) ||
          file.sha256 !== expected.sha256
        );
      }) ||
      JSON.stringify(
        restored.symlinks.map((link) => [link.path, link.target]),
      ) !== JSON.stringify(links.map((link) => [link.path, link.target]))
    )
      fail('restored home does not match the validated backup');
    // Only what this restore wrote: never the user's repositories.
    syncDirectoryTree(homeDir, outsideUpdate);
    return { manifest };
  } catch (error) {
    if (error instanceof StationHomeArchiveError) throw error;
    fail('update backup could not be restored', error);
  } finally {
    release();
  }
}
