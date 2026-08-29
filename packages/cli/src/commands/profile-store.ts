import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  emptyStationProfileStore,
  isStationProfileStore,
  type StationProfile,
  type StationProfileConfigurationState,
  type StationProfileCredentialRef,
  type StationProfileLocalService,
  type StationProfileSetupSource,
  type StationProfileStore,
} from '@kontourai/station-contracts';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import { assertCredentialTransportAllowed } from './profile-credentials.js';
import {
  assertWindowsPathsTrusted,
  ensureWindowsDirectoriesTrusted,
  hardenWindowsPathsTrusted,
} from './windows-path-trust.js';

function windowsTrustRun(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    error: result.error,
    status: result.status,
    stderr: typeof result.stderr === 'string' ? result.stderr : undefined,
    stdout: typeof result.stdout === 'string' ? result.stdout : undefined,
  };
}

function ensureWindowsProfileDirectories(home: string): void {
  ensureWindowsDirectoriesTrusted(windowsTrustRun, [
    home,
    join(home, 'config'),
  ]);
}

/** User client configuration home, independent of any selected Station server. */
export function resolveStationHome(): string {
  return resolveStationRoot();
}

export const MAX_PROFILE_NAME_LENGTH = 64;
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PROFILE_STORE_LOCK_STALE_MS = 5 * 60 * 1_000;
// This root-scoped record survives a missing/moved config directory. Both the
// CLI and the native desktop check the same bytes before ever recreating the
// shared profile document.
const PROFILE_STORE_GENESIS_MARKER = '.station-profile-store-v1';
const PROFILE_STORE_GENESIS_SIGNATURE = 'station-profile-store-v1\n';

interface LegacyProfileStoreLock {
  schemaVersion: 1;
  pid: number;
  createdAt: number;
}

/** v2 binds a lock to the exact process incarnation, not only its PID. */
interface ProfileStoreLock {
  schemaVersion: 2;
  pid: number;
  birth: string;
  createdAt: number;
}

type ParsedProfileStoreLock = LegacyProfileStoreLock | ProfileStoreLock;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasValidLockCommonFields(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { pid: number; createdAt: number } {
  return (
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.createdAt === 'number' &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0
  );
}

export interface ProfileStoreRepository {
  read(): StationProfileStore;
  write(
    store: StationProfileStore,
    expectedRevision?: number,
  ): StationProfileStore;
  path: string;
}

/** Shared native/CLI metadata location. It deliberately contains no secret. */
export function profilesPath(home: string = resolveStationHome()): string {
  return join(home, 'config', 'profiles.json');
}

function profileStoreGenesisMarkerPath(home: string): string {
  return join(home, PROFILE_STORE_GENESIS_MARKER);
}

/** The root carries the durable missing-store fence, so it is a trust boundary too. */
function ensureTrustedProfileStoreRoot(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  assertWindowsPathsTrusted(windowsTrustRun, [
    { kind: 'directory', path: home },
  ]);
  const info = lstatSync(home);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())
  ) {
    throw new Error('saved Station root is not an owner-controlled directory');
  }
  if (typeof process.getuid === 'function') {
    chmodSync(home, 0o700);
    const hardened = lstatSync(home);
    if (
      !hardened.isDirectory() ||
      hardened.isSymbolicLink() ||
      hardened.uid !== process.getuid() ||
      (hardened.mode & 0o077) !== 0
    ) {
      throw new Error('saved Station root could not be secured owner-only');
    }
  }
}

function profileStoreGenesisMarkerExists(home: string): boolean {
  ensureTrustedProfileStoreRoot(home);
  const marker = profileStoreGenesisMarkerPath(home);
  try {
    const initial = lstatSync(marker);
    if (!initial.isFile() || initial.isSymbolicLink()) {
      throw new Error(
        'saved Station genesis marker is invalid or not owner-controlled',
      );
    }
    assertWindowsPathsTrusted(windowsTrustRun, [
      { kind: 'file', path: marker },
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      marker,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(
      `saved Station genesis marker could not be read safely: ${(error as Error).message}`,
    );
  }
  try {
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      (typeof process.getuid === 'function' &&
        (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) ||
      readFileSync(descriptor, 'utf8') !== PROFILE_STORE_GENESIS_SIGNATURE
    ) {
      throw new Error(
        'saved Station genesis marker is invalid or not owner-controlled',
      );
    }
  } finally {
    closeSync(descriptor);
  }
  return true;
}

/** A markerless root may be born only before any runtime/cutover state exists. */
function profileStoreGenesisAdmissible(home: string): boolean {
  if (!existsSync(home)) return true;
  const root = lstatSync(home);
  if (!root.isDirectory() || root.isSymbolicLink()) return false;
  return readdirSync(home).every((entry) => {
    const candidate = lstatSync(join(home, entry));
    if (!candidate.isDirectory() || candidate.isSymbolicLink()) return false;
    // CLI setup creates an empty config parent before first metadata
    // publication. It is not history by itself; any content is.
    if (entry === 'config') return readdirSync(join(home, entry)).length === 0;
    // An explicit first `station setup` may already have selected its empty
    // runtime leaf. Any file beneath it is durable runtime history and fences
    // genesis; only empty direct channel scaffolding is admissible.
    if (entry === 'instances') {
      return readdirSync(join(home, entry)).every((channel) => {
        const runtime = join(home, entry, channel);
        const runtimeInfo = lstatSync(runtime);
        return (
          runtimeInfo.isDirectory() &&
          !runtimeInfo.isSymbolicLink() &&
          readdirSync(runtime).length === 0
        );
      });
    }
    return entry === 'installs';
  });
}

function writeProfileStoreGenesisMarker(home: string): void {
  ensureTrustedProfileStoreRoot(home);
  const marker = profileStoreGenesisMarkerPath(home);
  if (existsSync(marker)) {
    profileStoreGenesisMarkerExists(home);
    return;
  }
  const descriptor = openSync(
    marker,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    hardenWindowsPathsTrusted(windowsTrustRun, [
      { kind: 'file', path: marker },
    ]);
    writeFileSync(descriptor, PROFILE_STORE_GENESIS_SIGNATURE, 'utf8');
    fsyncSync(descriptor);
    // A file fsync does not make its newly-created directory entry durable on
    // POSIX. Persist both the root entry and (when the root was just born) its
    // parent before an empty profile document can follow.
    fsyncDirectorySync(home);
    fsyncDirectorySync(dirname(home));
  } finally {
    closeSync(descriptor);
  }
}

function withProfileStoreGenesisLock<T>(home: string, callback: () => T): T {
  const root = resolve(home);
  const parent = dirname(root);
  const path = join(
    parent,
    `.${basename(root)}.station-profile-store-genesis.json.lock`,
  );
  // The parent is the existing user-owned directory that contains the root;
  // never create config/ merely to coordinate genesis.
  let reclaimed = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const descriptor = createExclusiveProfileStoreLock(path);
    if (descriptor !== undefined) {
      try {
        return callback();
      } finally {
        closeSync(descriptor);
        try {
          unlinkSync(path);
        } catch {
          // A retained lock is a safe retryable fence.
        }
      }
    }
    if (!reclaimed && reclaimStaleProfileStoreLockAt(path)) {
      reclaimed = true;
      continue;
    }
    // A live sibling Desktop or CLI initializer has not yet published its
    // marker/document. Wait boundedly for that winner rather than turning a
    // healthy three-channel cold start into a spurious failure.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error(
    'saved Station genesis is busy; retry after the other client finishes.',
  );
}

/**
 * Publish the empty shared document once, before a CLI/Desktop mutation can
 * author a channel-local row. A crash after marker creation is intentionally a
 * recovery condition, not permission to replace a potentially moved store.
 */
function ensureProfileStoreGenesis(home: string): void {
  // Establish the same no-reparse/current-user directory boundary before the
  // first marker or empty store exists. `writeProfileStore` already does this
  // for later publications through `acquireProfileStoreLock`; genesis cannot
  // wait until then because it is the code that creates those files.
  ensureWindowsProfileDirectories(home);
  ensureTrustedProfileStoreRoot(home);
  withProfileStoreGenesisLock(home, () => {
    const path = profilesPath(home);
    if (existsSync(path)) {
      profileStoreGenesisMarkerExists(home) ||
        writeProfileStoreGenesisMarker(home);
      return;
    }
    const markerExists = profileStoreGenesisMarkerExists(home);
    if (markerExists || !profileStoreGenesisAdmissible(home)) {
      throw new Error(
        'saved Station metadata is missing from an initialized or in-progress shared root; restore profiles.json before changing saved Stations.',
      );
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeProfileStoreGenesisMarker(home);
    const descriptor = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      fchmodSync(descriptor, 0o600);
      hardenWindowsPathsTrusted(windowsTrustRun, [{ kind: 'file', path }]);
      writeFileSync(
        descriptor,
        `${JSON.stringify(emptyStationProfileStore())}\n`,
        'utf8',
      );
      fsyncSync(descriptor);
      fsyncDirectorySync(dirname(path));
    } finally {
      closeSync(descriptor);
    }
  });
}

function assertTrustedProfileStoreParent(path: string): void {
  const parent = dirname(path);
  assertWindowsPathsTrusted(windowsTrustRun, [
    { kind: 'directory', path: parent },
  ]);
  const parentInfo = lstatSync(parent);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (typeof process.getuid === 'function' &&
      (parentInfo.uid !== process.getuid() || (parentInfo.mode & 0o077) !== 0))
  ) {
    throw new Error(
      `saved Station metadata directory is not owner-controlled: ${parent}`,
    );
  }
}

export function createFileProfileStore(
  home: string = resolveStationHome(),
): ProfileStoreRepository {
  const path = profilesPath(home);
  return {
    path,
    read: () => readProfileStore(home),
    write: (store, expectedRevision) =>
      writeProfileStore(store, home, expectedRevision),
  };
}

/** A bad or unknown profile file fails closed instead of being silently replaced. */
export function readProfileStore(
  home: string = resolveStationHome(),
): StationProfileStore {
  const path = profilesPath(home);
  if (!existsSync(path)) return emptyStationProfileStore();
  assertTrustedProfileStoreParent(path);
  let fd: number | undefined;
  let parsed: unknown;
  try {
    const pathInfo = lstatSync(path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
      throw new Error('saved Station store must be a regular non-symlink file');
    }
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      (typeof process.getuid === 'function' &&
        (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    ) {
      throw new Error('untrusted ownership or permissions');
    }
    parsed = JSON.parse(readFileSync(fd, 'utf-8'));
  } catch (error) {
    throw new Error(
      `saved Station metadata is corrupt or not owner-controlled: ${path}. Repair its contents, ownership, or permissions before continuing. (${(error as Error).message})`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!isStationProfileStore(parsed)) {
    throw new Error(
      `saved Station metadata has an unsupported or invalid shape: ${path}. Refusing to overwrite it.`,
    );
  }
  return parsed;
}

/** Atomic, owner-only metadata write: temp + fsync + rename. */
function lockPath(home: string): string {
  return `${profilesPath(home)}.lock`;
}

function reclaimGuardPathForLock(path: string): string {
  return `${path}.reclaim`;
}

function lockIsOwnedRegularFile(path: string): boolean {
  try {
    assertWindowsPathsTrusted(windowsTrustRun, [{ kind: 'file', path }]);
  } catch {
    return false;
  }
  const info = lstatSync(path);
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    (typeof process.getuid !== 'function' ||
      (info.uid === process.getuid() && (info.mode & 0o777) === 0o600))
  );
}

function isStaleLockMtime(path: string): boolean {
  return Date.now() - lstatSync(path).mtimeMs >= PROFILE_STORE_LOCK_STALE_MS;
}

function parseProfileStoreLock(
  raw: string,
): ParsedProfileStoreLock | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isUnknownRecord(candidate)) return undefined;
  const record = candidate;
  if (
    record.schemaVersion === 1 &&
    hasValidLockCommonFields(record) &&
    Object.keys(record).length === 3 &&
    ['schemaVersion', 'pid', 'createdAt'].every((key) => key in record)
  ) {
    return {
      schemaVersion: 1,
      pid: record.pid,
      createdAt: record.createdAt,
    };
  }
  if (
    record.schemaVersion === 2 &&
    hasValidLockCommonFields(record) &&
    typeof record.birth === 'string' &&
    record.birth.length > 0 &&
    record.birth.length <= 512 &&
    Object.keys(record).length === 4 &&
    ['schemaVersion', 'pid', 'birth', 'createdAt'].every((key) => key in record)
  ) {
    return {
      schemaVersion: 2,
      pid: record.pid,
      birth: record.birth,
      createdAt: record.createdAt,
    };
  }
  return undefined;
}

function ownerIsGoneOrReused(record: ProfileStoreLock): boolean {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  // The shared authority returns null on an unavailable probe. That is not
  // proof of reuse, so the v2 lock remains fenced rather than reclaimed.
  const observed = lookupProcessBirthFingerprint(record.pid);
  return observed !== null && observed !== record.birth;
}

function reclaimableProfileStoreLock(
  path: string,
): { dev: number; ino: number } | undefined {
  try {
    if (!lockIsOwnedRegularFile(path)) return undefined;
    const before = lstatSync(path);
    const raw = readFileSync(path, 'utf-8');
    let reclaimable = false;
    if (raw.length === 0) {
      // A crash can leave a partially initialized owner-only lock before its
      // JSON identity is fsynced. Its age is the only safe recovery signal.
      reclaimable = isStaleLockMtime(path);
    } else {
      const record = parseProfileStoreLock(raw);
      if (!record) {
        // Only a torn, not a valid-but-unknown, record preserves the legacy
        // mtime recovery path. A complete closed-schema violation stays
        // fenced indefinitely rather than being silently reinterpreted.
        try {
          JSON.parse(raw);
          return undefined;
        } catch {
          reclaimable = isStaleLockMtime(path);
        }
      } else {
        reclaimable =
          record.schemaVersion === 2
            ? ownerIsGoneOrReused(record)
            : Date.now() - record.createdAt >= PROFILE_STORE_LOCK_STALE_MS &&
              (() => {
                try {
                  process.kill(record.pid, 0);
                  return false;
                } catch (error) {
                  return (error as NodeJS.ErrnoException).code === 'ESRCH';
                }
              })();
      }
    }
    if (!reclaimable) return undefined;
    const after = lstatSync(path);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      !lockIsOwnedRegularFile(path)
    )
      return undefined;
    return { dev: before.dev, ino: before.ino };
  } catch {
    // A malformed, foreign, or unreadable lock fails closed rather than being
    // removed by a different process.
    return undefined;
  }
}

function createExclusiveProfileStoreLock(path: string): number | undefined {
  try {
    const fd = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
      hardenWindowsPathsTrusted(windowsTrustRun, [{ kind: 'file', path }]);
      writeFileSync(
        fd,
        `${JSON.stringify({
          schemaVersion: 2,
          pid: process.pid,
          birth: (() => {
            const birth = lookupProcessBirthFingerprint(process.pid);
            if (!birth)
              throw new Error(
                'saved Station lock process identity is unavailable',
              );
            return birth;
          })(),
          createdAt: Date.now(),
        } satisfies ProfileStoreLock)}\n`,
        'utf-8',
      );
      fsyncSync(fd);
      return fd;
    } catch (error) {
      closeSync(fd);
      unlinkSync(path);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
}

/**
 * A stale lock is never unlinked by competing inspectors. The exclusive
 * sibling guard makes validation + removal a one-reclaimer critical section;
 * a normal writer may still win the normal lock immediately afterwards.
 */
function reclaimStaleProfileStoreLockAt(path: string): boolean {
  const guardPath = reclaimGuardPathForLock(path);
  let guardFd = createExclusiveProfileStoreLock(guardPath);
  const staleGuard =
    guardFd === undefined ? reclaimableProfileStoreLock(guardPath) : undefined;
  if (guardFd === undefined && staleGuard) {
    try {
      const current = lstatSync(guardPath);
      if (current.dev !== staleGuard.dev || current.ino !== staleGuard.ino)
        return false;
      unlinkSync(guardPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    guardFd = createExclusiveProfileStoreLock(guardPath);
  }
  if (guardFd === undefined) return false;
  try {
    const staleLock = reclaimableProfileStoreLock(path);
    if (!staleLock) return false;
    const current = lstatSync(path);
    if (current.dev !== staleLock.dev || current.ino !== staleLock.ino)
      return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    closeSync(guardFd);
    try {
      unlinkSync(guardPath);
    } catch {
      // A retained reclaim guard is safer than allowing competing reclaimers.
    }
  }
}

function reclaimStaleProfileStoreLock(home: string): boolean {
  return reclaimStaleProfileStoreLockAt(lockPath(home));
}

function acquireProfileStoreLock(home: string): { fd: number; path: string } {
  const path = lockPath(home);
  ensureWindowsProfileDirectories(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertTrustedProfileStoreParent(profilesPath(home));
  for (let attempt = 0; attempt < 2; attempt++) {
    const fd = createExclusiveProfileStoreLock(path);
    if (fd !== undefined) {
      try {
        assertWindowsPathsTrusted(windowsTrustRun, [{ kind: 'file', path }]);
        return { fd, path };
      } catch (error) {
        closeSync(fd);
        try {
          unlinkSync(path);
        } catch {
          // Retaining an untrusted lock is safer than deleting an object that changed.
        }
        throw error;
      }
    }
    if (attempt === 0 && reclaimStaleProfileStoreLock(home)) {
      continue;
    }
    if (attempt === 1) {
      throw new Error(
        `saved Station store is busy: ${path}. Retry after the other client finishes.`,
      );
    }
  }
  throw new Error(`saved Station store is busy: ${path}.`);
}

/**
 * Runs one synchronous decision/publish callback under the established
 * profiles.json sibling lock. Recovery coordinators that also need runtime
 * authority acquire maintenance -> registry -> profile, so a bounded registry
 * acquisition can never leave a profile lock stranded. They must not copy the
 * lock-file protocol.
 */
export function withProfileStoreLock<T>(
  callback: () => T,
  home: string = resolveStationHome(),
): T {
  const lock = acquireProfileStoreLock(home);
  try {
    return callback();
  } finally {
    closeSync(lock.fd);
    try {
      unlinkSync(lock.path);
    } catch {
      // A retained lock is safer than silently proceeding through a concurrent write.
    }
  }
}

/**
 * Atomic owner-only compare-and-swap write. Both CLI and native Desktop use
 * the sibling `.lock` protocol and the monotonic `revision`; a stale writer
 * fails instead of replacing a profile update it did not observe.
 */
export function writeProfileStore(
  store: StationProfileStore,
  home: string = resolveStationHome(),
  expectedRevision: number = store.revision,
): StationProfileStore {
  if (!isStationProfileStore(store)) {
    throw new Error('Refusing to write invalid saved Station metadata.');
  }
  ensureProfileStoreGenesis(home);
  const path = profilesPath(home);
  const temporary = `${path}.${process.pid}.tmp`;
  let fd: number | undefined;
  return withProfileStoreLock(() => {
    try {
      const actual = readProfileStore(home);
      if (actual.revision !== expectedRevision) {
        throw new Error(
          `saved Station store changed concurrently (expected revision ${expectedRevision}, found ${actual.revision}). Re-read and retry.`,
        );
      }
      const next: StationProfileStore = {
        ...store,
        revision: actual.revision + 1,
      };
      if (existsSync(temporary)) unlinkSync(temporary);
      fd = openSync(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      fchmodSync(fd, 0o600);
      hardenWindowsPathsTrusted(windowsTrustRun, [
        { kind: 'file', path: temporary },
      ]);
      writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
      return next;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) {
        try {
          unlinkSync(temporary);
        } catch {
          // best-effort cleanup only; never hide the primary write error
        }
      }
    }
  }, home);
}

export function normalizeProfileEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `"${value}" is not a valid Station endpoint. Use a full http(s) URL.`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`"${value}" is not an http(s) Station endpoint.`);
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'A Station endpoint must be a bare origin without credentials, path, query, or fragment.',
    );
  }
  return url.origin;
}

export function assertValidProfileName(name: string): string {
  if (!name || name.trim().length === 0)
    throw new Error('A Station name cannot be empty.');
  if (name.length > MAX_PROFILE_NAME_LENGTH) {
    throw new Error(
      `Invalid Station name "${name}": it must be ${MAX_PROFILE_NAME_LENGTH} characters or fewer.`,
    );
  }
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid Station name "${name}": use letters, digits, ".", "_", or "-", starting with a letter or digit.`,
    );
  }
  return name;
}

export function findProfile(
  name: string,
  home: string = resolveStationHome(),
): StationProfile | undefined {
  const wanted = name.toLowerCase();
  return readProfileStore(home).profiles.find(
    (profile) => profile.name.toLowerCase() === wanted,
  );
}

export function resolveDefaultProfile(
  home: string = resolveStationHome(),
): StationProfile | undefined {
  const store = readProfileStore(home);
  if (!store.defaultProfile) return undefined;
  return store.profiles.find(
    (profile) =>
      profile.name.toLowerCase() === store.defaultProfile!.toLowerCase(),
  );
}

/**
 * A canonical directory identity, stored only in the owner-controlled shared
 * saved Station store. No repository file participates in target selection.
 */
export function canonicalProjectDirectory(
  cwd: string = process.env.STATION_INVOKED_CWD || process.cwd(),
): string {
  const canonical = realpathSync(resolve(cwd));
  if (!statSync(canonical).isDirectory()) {
    throw new Error(
      `Project saved Station selection requires a directory: ${cwd}`,
    );
  }
  return canonical;
}

export function readProjectProfileSelection(
  cwd: string = process.env.STATION_INVOKED_CWD || process.cwd(),
  home: string = resolveStationHome(),
): string | undefined {
  return readProfileStore(home).projectProfiles[canonicalProjectDirectory(cwd)];
}

export function resolveProjectProfile(
  cwd: string = process.env.STATION_INVOKED_CWD || process.cwd(),
  home: string = resolveStationHome(),
): StationProfile | undefined {
  const selected = readProjectProfileSelection(cwd, home);
  if (!selected) return undefined;
  const profile = findProfile(selected, home);
  if (!profile) {
    throw new Error(
      `Project Station selection names no Station "${selected}". ${describeKnownProfiles(home)}`,
    );
  }
  return profile;
}

export function setProjectProfile(
  name: string,
  cwd: string = process.env.STATION_INVOKED_CWD || process.cwd(),
  home: string = resolveStationHome(),
): StationProfile {
  const store = readProfileStore(home);
  const profile = store.profiles.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (!profile) {
    throw new Error(
      `No Station named "${name}". ${describeKnownProfiles(home)}`,
    );
  }
  store.projectProfiles[canonicalProjectDirectory(cwd)] = profile.name;
  writeProfileStore(store, home);
  return profile;
}

export function clearProjectProfile(
  cwd: string = process.env.STATION_INVOKED_CWD || process.cwd(),
  home: string = resolveStationHome(),
): void {
  const store = readProfileStore(home);
  const identity = canonicalProjectDirectory(cwd);
  if (!(identity in store.projectProfiles)) return;
  delete store.projectProfiles[identity];
  writeProfileStore(store, home);
}

export function describeKnownProfiles(
  home: string = resolveStationHome(),
): string {
  const { profiles } = readProfileStore(home);
  if (profiles.length === 0)
    return 'No Stations are saved yet. Add one with: station stations add <name> <endpoint>';
  return `Known Stations: ${profiles
    .map((profile) => profile.name)
    .sort()
    .join(', ')}`;
}

export interface UpsertProfileInput {
  name: string;
  endpoint: string;
  credentialRef?: StationProfileCredentialRef;
  environmentId?: string;
  localService?: StationProfileLocalService;
  setupSource?: StationProfileSetupSource;
  configurationState?: StationProfileConfigurationState;
  makeDefault?: boolean;
  force?: boolean;
  /** Internal callers only: pairing/service setup proved the replacement binding. */
  verifiedBinding?: boolean;
  now?: number;
}

export interface UpsertProfileResult {
  profile: StationProfile;
  isDefault: boolean;
  replaced: boolean;
  /** The binding displaced by this exact metadata commit, if any. */
  previousProfile?: StationProfile;
}

function applyProfileUpsert(
  store: StationProfileStore,
  input: UpsertProfileInput,
  name: string,
  endpoint: string,
): UpsertProfileResult {
  const existingIndex = store.profiles.findIndex(
    (profile) => profile.name.toLowerCase() === name.toLowerCase(),
  );
  const existing =
    existingIndex >= 0 ? store.profiles[existingIndex] : undefined;
  if (existing && !input.force) {
    throw new Error(
      `A Station named "${existing.name}" already points at ${existing.endpoint}. Re-point it with --force or forget it first: station stations forget ${existing.name}`,
    );
  }
  const now = input.now ?? Date.now();
  const endpointChanged =
    existing !== undefined && existing.endpoint !== endpoint;
  const retainCredentialBinding =
    !endpointChanged ||
    (input.verifiedBinding === true &&
      input.credentialRef !== undefined &&
      input.environmentId !== undefined);
  // Local service identity is bound to the old loopback origin as tightly as
  // a bearer is. A verified pairing proves credentials, not that an old local
  // service instance now owns a different endpoint.
  const retainServiceBinding =
    !endpointChanged || input.localService !== undefined;
  const profile: StationProfile = {
    schemaVersion: 1,
    name,
    endpoint,
    ...(retainCredentialBinding && input.credentialRef
      ? { credentialRef: input.credentialRef }
      : retainCredentialBinding && existing?.credentialRef
        ? { credentialRef: existing.credentialRef }
        : {}),
    ...(retainCredentialBinding && input.environmentId
      ? { environmentId: input.environmentId }
      : retainCredentialBinding && existing?.environmentId
        ? { environmentId: existing.environmentId }
        : {}),
    ...(retainServiceBinding && input.localService
      ? { localService: input.localService }
      : retainServiceBinding && existing?.localService
        ? { localService: existing.localService }
        : {}),
    setupSource: input.setupSource ?? existing?.setupSource ?? 'manual',
    configurationState:
      endpointChanged && !input.verifiedBinding
        ? 'unconfigured'
        : (input.configurationState ??
          existing?.configurationState ??
          'unconfigured'),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existingIndex >= 0) store.profiles[existingIndex] = profile;
  else store.profiles.push(profile);
  if (input.makeDefault) store.defaultProfile = name;
  return {
    profile,
    isDefault: store.defaultProfile === name,
    replaced: Boolean(existing),
    ...(existing ? { previousProfile: existing } : {}),
  };
}

export function upsertProfile(
  input: UpsertProfileInput,
  home: string = resolveStationHome(),
): UpsertProfileResult {
  const name = assertValidProfileName(input.name);
  const endpoint = normalizeProfileEndpoint(input.endpoint);
  if (input.credentialRef) assertCredentialTransportAllowed(endpoint);
  const store = readProfileStore(home);
  const result = applyProfileUpsert(store, input, name, endpoint);
  writeProfileStore(store, home);
  return result;
}

export function setDefaultProfile(
  name: string,
  home: string = resolveStationHome(),
): StationProfile {
  const store = readProfileStore(home);
  const profile = store.profiles.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (!profile)
    throw new Error(
      `No Station named "${name}". ${describeKnownProfiles(home)}`,
    );
  store.defaultProfile = profile.name;
  writeProfileStore(store, home);
  return profile;
}

/**
 * Selects an already-paired Station without minting/replacing a credential.
 * The exact pairing snapshot must still be current at commit time so an
 * already-paired shortcut cannot select a name that changed while it ran.
 */
export function selectPairedProfileAsDefault(
  expectedProfile: StationProfile,
  expectedDefaultProfile: string | null,
  home: string = resolveStationHome(),
): StationProfile {
  const store = readProfileStore(home);
  const current = store.profiles.find(
    (profile) =>
      profile.name.toLowerCase() === expectedProfile.name.toLowerCase(),
  );
  if (!current || JSON.stringify(current) !== JSON.stringify(expectedProfile)) {
    throw new Error(
      `Station "${expectedProfile.name}" changed while pairing was in progress. Its newer binding was preserved.`,
    );
  }
  if (store.defaultProfile !== expectedDefaultProfile) {
    throw new Error(
      'The default Station changed while pairing was in progress. The newer selection was preserved.',
    );
  }
  if (store.defaultProfile?.toLowerCase() === current.name.toLowerCase()) {
    return current;
  }
  store.defaultProfile = current.name;
  writeProfileStore(store, home);
  return current;
}

/** Pairing deliberately clears an existing default until its new binding verifies. */
export function clearDefaultProfile(
  name: string,
  home: string = resolveStationHome(),
): boolean {
  const store = readProfileStore(home);
  if (store.defaultProfile?.toLowerCase() !== name.toLowerCase()) return false;
  store.defaultProfile = null;
  writeProfileStore(store, home);
  return true;
}

export function removeProfile(
  name: string,
  home: string = resolveStationHome(),
): { profile: StationProfile; wasDefault: boolean } {
  const store = readProfileStore(home);
  const index = store.profiles.findIndex(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (index < 0)
    throw new Error(
      `No Station named "${name}". ${describeKnownProfiles(home)}`,
    );
  const [profile] = store.profiles.splice(index, 1);
  const wasDefault =
    store.defaultProfile?.toLowerCase() === profile.name.toLowerCase();
  if (wasDefault) store.defaultProfile = null;
  for (const [project, selected] of Object.entries(store.projectProfiles)) {
    if (selected.toLowerCase() === profile.name.toLowerCase()) {
      delete store.projectProfiles[project];
    }
  }
  writeProfileStore(store, home);
  return { profile, wasDefault };
}

export function updateProfileEnvironment(
  name: string,
  environmentId: string,
  home: string = resolveStationHome(),
): StationProfile {
  const store = readProfileStore(home);
  const profile = store.profiles.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (!profile)
    throw new Error(
      `No Station named "${name}". ${describeKnownProfiles(home)}`,
    );
  profile.environmentId = environmentId;
  profile.updatedAt = Date.now();
  writeProfileStore(store, home);
  return profile;
}

export function suggestProfileName(
  endpoint: string,
  home: string = resolveStationHome(),
): string {
  const hostname = new URL(endpoint).hostname
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  const isIp =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  const base =
    (isIp
      ? hostname.replace(/:/g, '-')
      : hostname.replace(/^www\./, '').split('.')[0]
    )
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9]+$/, '')
      .slice(0, MAX_PROFILE_NAME_LENGTH) || 'station';
  const names = new Set(
    readProfileStore(home).profiles.map((profile) =>
      profile.name.toLowerCase(),
    ),
  );
  if (!names.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base.slice(0, MAX_PROFILE_NAME_LENGTH - String(suffix).length - 1)}-${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error(
    'Could not derive an unused Station name. Choose one with --station=<name>.',
  );
}

export function findProfileByEndpoint(
  endpoint: string,
  environmentId?: string,
  home: string = resolveStationHome(),
): StationProfile | undefined {
  const normalized = normalizeProfileEndpoint(endpoint);
  const candidates = readProfileStore(home).profiles.filter(
    (profile) => profile.endpoint === normalized,
  );
  return (
    (environmentId
      ? candidates.find((profile) => profile.environmentId === environmentId)
      : undefined) ?? candidates[0]
  );
}

/** True only while a saved Station still owns this immutable keyring ref. */
export function isCredentialRefReferenced(
  ref: StationProfileCredentialRef,
  home: string = resolveStationHome(),
): boolean {
  return readProfileStore(home).profiles.some(
    (profile) =>
      profile.credentialRef?.kind === ref.kind &&
      profile.credentialRef.id === ref.id,
  );
}

export function registerPairedProfile(
  endpoint: string,
  input: {
    name?: string;
    environmentId: string;
    credentialRef: StationProfileCredentialRef;
    /** Binding observed before the approval wait; stale approvals never win. */
    expectedProfile?: StationProfile;
    /** Default selection observed before a pairing that intends to replace it. */
    expectedDefaultProfile?: string | null;
    /** Setup is the only pairing caller that deliberately changes default. */
    makeDefault?: boolean;
    /** A pairing caller may re-point a named Station only after explicit consent. */
    allowEndpointReplacement?: boolean;
    setupSource?: StationProfileSetupSource;
    now?: number;
  },
  home: string = resolveStationHome(),
): UpsertProfileResult {
  const normalizedEndpoint = normalizeProfileEndpoint(endpoint);
  assertCredentialTransportAllowed(normalizedEndpoint);
  const store = readProfileStore(home);
  const matched =
    store.profiles.find(
      (profile) =>
        profile.endpoint === normalizedEndpoint &&
        profile.environmentId === input.environmentId,
    ) ??
    store.profiles.find((profile) => profile.endpoint === normalizedEndpoint);
  const name =
    input.name ?? matched?.name ?? suggestProfileName(normalizedEndpoint, home);
  const existing = store.profiles.find(
    (profile) => profile.name.toLowerCase() === name.toLowerCase(),
  );
  if (
    input.expectedProfile &&
    JSON.stringify(existing) !== JSON.stringify(input.expectedProfile)
  ) {
    throw new Error(
      `Station "${name}" changed while pairing approval was pending. Its newer binding was preserved; rerun pairing if that is still intended.`,
    );
  }
  if (input.expectedProfile === undefined && input.name && existing) {
    throw new Error(
      `Station "${name}" was created while pairing approval was pending. Its binding was preserved; rerun pairing with --force if replacement is intended.`,
    );
  }
  if (
    input.makeDefault &&
    input.expectedDefaultProfile !== undefined &&
    store.defaultProfile !== input.expectedDefaultProfile
  ) {
    throw new Error(
      'The default Station changed while pairing approval was pending. The newer selection was preserved.',
    );
  }
  if (
    existing &&
    existing.endpoint !== normalizedEndpoint &&
    !input.allowEndpointReplacement
  ) {
    throw new Error(
      `Station "${existing.name}" points at ${existing.endpoint}; refusing to replace its credential binding with ${normalizedEndpoint}. Use station stations edit ${existing.name} ${normalizedEndpoint} --pair, or rerun with --force.`,
    );
  }
  const result = applyProfileUpsert(
    store,
    {
      name,
      endpoint: normalizedEndpoint,
      credentialRef: input.credentialRef,
      environmentId: input.environmentId,
      setupSource: input.setupSource ?? 'paired',
      configurationState: 'configured',
      verifiedBinding: true,
      makeDefault: input.makeDefault,
      force: Boolean(existing),
      now: input.now,
    },
    assertValidProfileName(name),
    normalizedEndpoint,
  );
  writeProfileStore(store, home);
  return result;
}
