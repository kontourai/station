import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
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
import { fsyncDirectorySync } from './fs-windows-compat.js';
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

export const STATION_HOME_BACKUP_SCHEMA = 'station.home-backup/v1' as const;
export const STATION_HOME_BACKUP_MANIFEST = 'station-home-backup.json';
export const DEFAULT_STATION_HOME_BACKUP_MAX_FILES = 100_000;
export const DEFAULT_STATION_HOME_BACKUP_MAX_BYTES = 20 * 1024 * 1024 * 1024;
export const DEFAULT_STATION_HOME_BACKUP_MAX_FILE_BYTES =
  2 * 1024 * 1024 * 1024;

const TRANSIENT_ROOTS = new Set([
  'instances.json',
  'logs',
  'monitoring',
  // station#3217: a store quarantined for corruption is preserved for
  // recovery, not carried into every future backup. `isTransient` only
  // inspects `segments[0]`, which is why the quarantine is a top-level root
  // rather than `data/quarantine/`.
  'quarantine',
  'service',
  'tmp',
]);
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

export interface StationHomeBackupManifest {
  schemaVersion: typeof STATION_HOME_BACKUP_SCHEMA;
  homeSchemaVersion: number;
  createdAt: string;
  files: StationHomeBackupFile[];
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
}): StationHomeRecoveryCandidatePlan {
  const prepared = prepareDetachedRecoveryCandidate(
    options.records,
    options.declaredSourceSchemaVersion,
  );
  const outputDir = resolve(options.outputDir);
  const parent = dirname(outputDir);
  let staging: string | undefined;
  try {
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

function canonicalLimits(options: {
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
}) {
  const maxFiles = options.maxFiles ?? DEFAULT_STATION_HOME_BACKUP_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_STATION_HOME_BACKUP_MAX_BYTES;
  const maxFileBytes =
    options.maxFileBytes ?? DEFAULT_STATION_HOME_BACKUP_MAX_FILE_BYTES;
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
  if (TRANSIENT_ROOTS.has(segments[0])) return true;
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

function syncDirectoryTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) fail('archive staging contains a symlink');
    syncDirectoryTree(join(root, entry.name));
  }
  fsyncDirectorySync(root);
}

function syncFile(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
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

function collectFiles(
  homeDir: string,
  limits: ReturnType<typeof canonicalLimits>,
  checkpointSqlite = false,
): StationHomeBackupFile[] {
  const files: StationHomeBackupFile[] = [];
  let totalBytes = 0;
  const visit = (directory: string, parentSegments: string[]): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const segments = [...parentSegments, entry.name];
      if (isTransient(segments)) continue;
      assertSegment(entry.name);
      const path = join(directory, entry.name);
      let stats = lstatSync(path);
      if (stats.isSymbolicLink())
        fail(`Station home contains a symbolic link at ${segments.join('/')}`);
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
      if (entry.name.endsWith('.sqlite')) {
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
      if (files.length >= limits.maxFiles)
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
  return files;
}

function strictManifest(
  value: unknown,
  limits: ReturnType<typeof canonicalLimits>,
): StationHomeBackupManifest {
  if (!isPlainRecord(value)) fail('backup manifest must be an object');
  if (
    Object.keys(value).sort().join(',') !==
    ['createdAt', 'files', 'homeSchemaVersion', 'schemaVersion', 'totalBytes']
      .sort()
      .join(',')
  )
    fail('backup manifest contains unknown or missing fields');
  if (
    value.schemaVersion !== STATION_HOME_BACKUP_SCHEMA ||
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
  return {
    schemaVersion: STATION_HOME_BACKUP_SCHEMA,
    homeSchemaVersion: value.homeSchemaVersion as number,
    createdAt: value.createdAt,
    files,
    totalBytes,
  };
}

function validateBackupDirectory(
  backupDir: string,
  limits: ReturnType<typeof canonicalLimits>,
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
    manifestStats.size > MAX_BACKUP_MANIFEST_BYTES
  )
    fail('backup manifest must be a regular file');
  let manifest: StationHomeBackupManifest;
  try {
    manifest = strictManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
      limits,
    );
  } catch (error) {
    if (error instanceof StationHomeArchiveError) throw error;
    fail('backup manifest is not valid JSON', error);
  }
  const contentRoot = join(root, 'home');
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
  const limits = canonicalLimits(options);
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
    const files = collectFiles(homeDir, limits, true);
    assertInactive('backup', options.assertInactive);
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
      copyFileSync(source, target, constants.COPYFILE_EXCL);
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
    const manifest: StationHomeBackupManifest = {
      schemaVersion: STATION_HOME_BACKUP_SCHEMA,
      homeSchemaVersion,
      createdAt,
      files,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
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
