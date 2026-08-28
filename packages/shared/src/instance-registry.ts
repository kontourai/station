/**
 * Cross-process-safe registry of Station instances running on this host.
 *
 * `<STATION_HOME>/instances.json` is a home-scoped, multi-instance directory
 * — distinct from the existing CWD-anchored `.station/instances/<id>.json`
 * per-checkout liveness record (`packages/cli/src/commands/lifecycle.ts`'s
 * `writeInstanceState`). Same word, two different scopes; see
 * `docs/design/instance-registry.md`.
 *
 * The cross-process lock reuses `acquireFileMutationLock` (already vendored
 * in this package, already Windows-safe via `process-identity.mjs`) rather
 * than inventing a new lock primitive. The atomic-write-with-verify shape
 * follows `packages/cli/src/commands/lifecycle.ts`'s `writeInstanceState`,
 * minus its per-record backup/restore ceremony: that ceremony exists to
 * protect a concurrent reader from ever observing a half-written file, and
 * here the entire read-modify-write happens inside the single lock
 * acquisition, so there is no window in which a reader could observe a
 * torn intermediate state that a backup would need to roll back from.
 *
 * Producers as of station#2904 slice 2: `station service install`
 * (type 'service'), the Desktop bridge (type 'sidecar'), and `station start`
 * (types 'inline'/'worktree', with pid + birth fingerprint; removed on stop,
 * including the already-absent stop path). The station#1985 "unwired
 * foundation" framing is historical. Still out of scope: any migration of
 * `.station/instances/*` or `<home>/service/*.json`.
 *
 * Liveness contract: `findRunning` filters on pid aliveness AND, where a
 * producer recorded a `birth` fingerprint, rejects pid reuse on mismatch
 * (fail-open on lookup failure, mirroring `claimDesktopSidecar`).
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fsyncDirectorySync } from './fs-windows-compat.js';
import {
  acquireFileMutationLock,
  type FileMutationLockOptions,
} from './lifecycle-events.js';
import { birthProvesReuse } from './process-identity.mjs';
import {
  admitStationRuntimeHome,
  resolveRuntimeHome,
} from './runtime-path-resolver.js';

export type InstanceType = 'service' | 'sidecar' | 'worktree' | 'inline';

export interface InstanceConfig {
  port: number;
  uiPort?: number;
  /** Consent-listener port (station#3677); producers default it to port + 3. */
  consentPort?: number;
  checkout?: string;
  channel?: string;
  buildSha?: string;
  builtAt?: string;
  type: InstanceType;
  status?: string;
  pid?: number;
  /** Process-birth fingerprint paired with pid to reject PID reuse. */
  birth?: string;
  startedAt?: string;
  env?: Record<string, string>;
}

export interface InstanceRegistry {
  version: 1;
  instances: Record<string, InstanceConfig>;
}

const INSTANCE_TYPES: ReadonlySet<InstanceType> = new Set<InstanceType>([
  'service',
  'sidecar',
  'worktree',
  'inline',
]);

function isValidInstanceType(value: unknown): value is InstanceType {
  return typeof value === 'string' && INSTANCE_TYPES.has(value as InstanceType);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidInstanceConfig(value: unknown): value is InstanceConfig {
  if (!isPlainObject(value)) return false;
  if (typeof value.port !== 'number' || !Number.isFinite(value.port)) {
    return false;
  }
  return isValidInstanceType(value.type);
}

function isValidInstanceRegistry(value: unknown): value is InstanceRegistry {
  if (!isPlainObject(value)) return false;
  if (value.version !== 1) return false;
  if (!isPlainObject(value.instances)) return false;
  return Object.values(value.instances).every(isValidInstanceConfig);
}

function emptyInstanceRegistry(): InstanceRegistry {
  return { version: 1, instances: {} };
}

/** Same one-line resolution already duplicated locally in
 * `profile-store.ts`/`active-local-station.ts`/`paths.ts` — deliberately
 * re-duplicated here rather than factored into a new shared resolver,
 * matching the existing repo convention.
 *
 * `resolve()` makes the path deterministic WITHIN a process, but a relative
 * `STATION_HOME` still resolves against each caller's own cwd — two processes
 * with different cwds derive two disjoint registries with no error. The
 * cross-process guarantee therefore requires an absolute `STATION_HOME`,
 * which every supervisor in this repo already provides
 * (`resolveLifecycleHomeTarget` resolves it before injecting into spawned
 * env); a hand-set relative value is out of contract. */
function defaultStationHome(): string {
  const home = resolve(resolveRuntimeHome());
  admitStationRuntimeHome(home);
  return home;
}

export function resolveInstanceRegistryPath(home?: string): string {
  const selectedHome = home ?? defaultStationHome();
  admitStationRuntimeHome(selectedHome);
  return join(selectedHome, 'instances.json');
}

/**
 * Fails closed if `dirname(path)` EXISTS but is not a trustworthy,
 * owner-controlled directory: a symlink there could redirect I/O aimed at
 * `<STATION_HOME>/instances.json` at an attacker-controlled location.
 * Mirrors `packages/cli/src/commands/profile-store.ts`'s
 * `assertTrustedProfileStoreParent`. An absent parent is NOT an error here —
 * that is normal for a fresh home, and the write path creates it (with
 * `0o700`, see `ensureRegistryDirectory`) rather than assuming absence is
 * hostile.
 *
 * `lstatSync` (not `statSync`) is deliberate: it inspects `dirname(path)`
 * itself without following it, which is exactly what defends against an
 * ancestor symlink AT THAT COMPONENT — a symlinked `STATION_HOME` is caught.
 * Deeper ancestors above it stay trusted, the same scope `readProfileStore`'s
 * `assertTrustedProfileStoreParent` checks (immediate parent only, never the
 * whole ancestor chain; `readActiveLocalStation` checks only the file itself).
 */
function assertTrustedInstanceRegistryParent(path: string): void {
  const parent = dirname(path);
  let parentInfo: ReturnType<typeof lstatSync>;
  try {
    parentInfo = lstatSync(parent);
  } catch {
    return;
  }
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      (parentInfo.uid !== process.getuid() || (parentInfo.mode & 0o077) !== 0))
  ) {
    throw new Error(
      `Station instance registry directory is not owner-controlled: ${parent}`,
    );
  }
}

function ensureRegistryDirectory(path: string): void {
  assertTrustedInstanceRegistryParent(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

/**
 * Reads `<home>/instances.json`. Absence returns an empty registry rather
 * than throwing — the file is created lazily on first write. A corrupt,
 * non-owner, wrong-mode, symlinked, or invalid-shape file THROWS naming the
 * path (mirrors `readProfileStore`'s "corrupt or not owner-controlled...
 * repair before continuing" framing) — a bad registry is never silently
 * replaced.
 */
export function readInstanceRegistry(home?: string): InstanceRegistry {
  const path = resolveInstanceRegistryPath(home);
  assertTrustedInstanceRegistryParent(path);
  if (!existsSync(path)) return emptyInstanceRegistry();
  let fd: number | undefined;
  let parsed: unknown;
  try {
    const pathInfo = lstatSync(path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
      throw new Error('instance registry must be a regular non-symlink file');
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      // POSIX-only: mode bits are synthetic on Windows.
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    ) {
      throw new Error('untrusted ownership or permissions');
    }
    parsed = JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    throw new Error(
      `Station instance registry is corrupt or not owner-controlled: ${path}. Repair its contents, ownership, or permissions before continuing. (${(error as Error).message})`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!isValidInstanceRegistry(parsed)) {
    throw new Error(
      `Station instance registry has an unsupported or invalid shape: ${path}. Refusing to overwrite it.`,
    );
  }
  return parsed;
}

/**
 * Temp-write + fsync + rename + directory-fsync + re-open-and-verify publish
 * of the registry payload. Does NOT acquire the mutation lock itself — every
 * caller below acquires it exactly once around its own read-modify-write, so
 * this stays a pure "publish this exact payload" primitive.
 *
 * The directory fsync wires `fsyncDirectorySync`'s `checkIdentity` callback
 * with a dev/ino snapshot of the STATION_HOME directory taken before the
 * rename: if the directory itself was replaced (unmounted/relinked) during
 * publish, the durability guarantee the fsync is supposed to provide would
 * be void, so this fails closed instead of silently fsyncing the wrong
 * directory.
 */
function publishInstanceRegistry(
  registry: InstanceRegistry,
  path: string,
): void {
  if (!isValidInstanceRegistry(registry)) {
    throw new Error(
      `Refusing to publish an invalid Station instance registry shape: ${path}`,
    );
  }
  ensureRegistryDirectory(path);
  const directory = dirname(path);
  const directoryIdentityBefore = lstatSync(directory);
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  const temporary = join(
    directory,
    `.instances-${process.pid}-${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  let publishedFd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, serialized, 'utf8');
    fsyncSync(fd);
    const temporaryInfo = fstatSync(fd);
    const temporaryIdentity = {
      dev: temporaryInfo.dev,
      ino: temporaryInfo.ino,
    };
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    fsyncDirectorySync(directory, (stat) => {
      if (
        stat.dev !== directoryIdentityBefore.dev ||
        stat.ino !== directoryIdentityBefore.ino
      ) {
        throw new Error(
          `Station instance registry directory changed identity during publish: ${directory}`,
        );
      }
    });
    publishedFd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const publishedInfo = fstatSync(publishedFd);
    if (
      !publishedInfo.isFile() ||
      (typeof process.getuid === 'function' &&
        publishedInfo.uid !== process.getuid()) ||
      // POSIX-only: fchmod/mode bits are synthetic on Windows.
      (process.platform !== 'win32' &&
        (publishedInfo.mode & 0o777) !== 0o600) ||
      publishedInfo.dev !== temporaryIdentity.dev ||
      publishedInfo.ino !== temporaryIdentity.ino ||
      readFileSync(publishedFd, 'utf8') !== serialized
    ) {
      throw new Error(`Failed to publish Station instance registry: ${path}`);
    }
  } finally {
    if (publishedFd !== undefined) closeSync(publishedFd);
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

/**
 * Locked write of a full registry payload. Exported as the primitive other
 * modules can use directly; `upsertInstance`/`updateStatus`/`removeInstance`
 * below do their own single-lock read-modify-write instead of calling this
 * (calling it from inside their own lock would re-enter the same lock file
 * and deadlock/throw against the lock they already hold).
 */
export function writeInstanceRegistry(
  registry: InstanceRegistry,
  home?: string,
): void {
  const path = resolveInstanceRegistryPath(home);
  ensureRegistryDirectory(path);
  const release = acquireFileMutationLock(`${path}.mutation`);
  try {
    publishInstanceRegistry(registry, path);
  } finally {
    release();
  }
}

/**
 * Runs a synchronous classification/publish callback under the registry's
 * established mutation lock. Coordinators must acquire broader authorities
 * first and must not recreate this file-lock protocol.
 */
export function withInstanceRegistryMutationLock<T>(
  home: string | undefined,
  callback: () => T,
  options: FileMutationLockOptions = {},
): T {
  const path = resolveInstanceRegistryPath(home);
  ensureRegistryDirectory(path);
  const release = acquireFileMutationLock(`${path}.mutation`, options);
  try {
    return callback();
  } finally {
    release();
  }
}

function lockedReadModifyWrite(
  home: string | undefined,
  modify: (current: InstanceRegistry) => InstanceRegistry,
  lockOptions: FileMutationLockOptions = {},
): InstanceRegistry {
  return withInstanceRegistryMutationLock(
    home,
    () => {
      const path = resolveInstanceRegistryPath(home);
      const current = readInstanceRegistry(home);
      const next = modify(current);
      // A modifier that declines (claim refusal, remove no-op) returns
      // `current` by reference — skip the publish entirely so a refusal
      // touches neither content nor inode/mtime. Without this, a bare
      // `station stop` no-op could CREATE instances.json in a home that
      // never had one, and any file-level watcher would see phantom writes
      // (the station#1588 class; #3047 review MED-1).
      if (next !== current) publishInstanceRegistry(next, path);
      return next;
    },
    lockOptions,
  );
}

/**
 * Creates or merge-updates `instances[id]`. Read-modify-write happens
 * INSIDE the single lock acquisition, closing the TOCTOU/CAS gap named in
 * the repo's "serialized-updater" learning (station#1588/#1600/#1606). A
 * first insert (no existing entry) requires `port` and a valid `type` on
 * the merged result; an update may omit either since they already exist on
 * the current record.
 */
export function upsertInstance(
  id: string,
  partial: Partial<InstanceConfig>,
  home?: string,
): InstanceRegistry {
  return lockedReadModifyWrite(home, (current) => {
    const existing = current.instances[id];
    const merged = { ...existing, ...partial } as InstanceConfig;
    if (
      typeof merged.port !== 'number' ||
      !Number.isFinite(merged.port) ||
      !isValidInstanceType(merged.type)
    ) {
      throw new Error(
        `instance "${id}" requires a numeric port and a valid type on first insert`,
      );
    }
    return {
      version: 1,
      instances: { ...current.instances, [id]: merged },
    };
  });
}

/** Thin wrapper over the same locked read-modify-write as `upsertInstance`. */
export function updateStatus(
  id: string,
  status: string,
  pid?: number,
  home?: string,
): InstanceRegistry {
  return lockedReadModifyWrite(home, (current) => {
    const existing = current.instances[id];
    if (!existing) {
      throw new Error(`cannot update status for unknown instance "${id}"`);
    }
    const merged: InstanceConfig = {
      ...existing,
      status,
      ...(pid !== undefined ? { pid } : {}),
    };
    return {
      version: 1,
      instances: { ...current.instances, [id]: merged },
    };
  });
}

/** Same locked pattern; no-op (not an error) if `id` is absent. */
export function removeInstance(id: string, home?: string): InstanceRegistry {
  return lockedReadModifyWrite(home, (current) => {
    if (!(id in current.instances)) return current;
    const next = { ...current.instances };
    delete next[id];
    return { version: 1, instances: next };
  });
}

export type InstanceRegistryProcessProbe = (pid: number) => void;

type ProcessLiveness = 'alive' | 'dead' | 'unavailable';

export interface InstanceRegistryLivenessOptions {
  /** Test seam; production probes with signal 0. Non-ESRCH failures fence. */
  processProbe?: InstanceRegistryProcessProbe;
}

/** A reconciliation may inherit a caller's already-bounded lock budget. */
export interface InstanceRegistryReconcileOptions
  extends InstanceRegistryLivenessOptions {
  mutationLockOptions?: FileMutationLockOptions;
}

function processLiveness(
  pid: number,
  processProbe: InstanceRegistryProcessProbe = (candidate) =>
    process.kill(candidate, 0),
): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    processProbe(pid);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? 'dead'
      : 'unavailable';
  }
}

/**
 * True when `entry` records a pid that is alive OR unavailable and whose
 * recorded `birth` does not prove PID reuse after a successful probe.
 * `selfPid` exempts the caller's own process so a holder can refresh itself.
 */
export function entryOwnedByLiveProcess(
  entry: InstanceConfig,
  selfPid?: number,
  options: InstanceRegistryLivenessOptions = {},
): boolean {
  if (typeof entry.pid !== 'number' || entry.pid === selfPid) return false;
  const liveness = processLiveness(entry.pid, options.processProbe);
  return (
    liveness !== 'dead' &&
    (liveness !== 'alive' || !birthProvesReuse(entry.birth, entry.pid))
  );
}

/**
 * Whether an ephemeral registry record is demonstrably left by a process that
 * is no longer its owner.  This deliberately does not infer liveness from a
 * port, command line, or an unpaired PID: those probes could target an
 * unrelated process.  A recorded PID is stale only when it is gone or its
 * recorded birth fingerprint proves the PID has been reused.  A stopped
 * ephemeral entry is also stale by its producer's own terminal state.
 *
 * Durable service entries are intentionally excluded by callers: a service
 * record owns configuration such as ALLOWED_ORIGINS after its supervisor
 * exits, so removing it as "stale" would destroy policy rather than merely
 * reap liveness bookkeeping.
 */
function isProvablyStaleEphemeralInstance(
  entry: InstanceConfig,
  options: InstanceRegistryLivenessOptions = {},
): boolean {
  if (entry.status === 'stopped') return true;
  if (typeof entry.pid !== 'number') return false;
  return !entryOwnedByLiveProcess(entry, undefined, options);
}

/**
 * Reconciles one exact ephemeral instance id when its recorded process is
 * provably no longer its owner.  This is a registry-only cleanup: it never
 * sends a signal, so a reused PID can only lose a stale record and can never
 * be killed by a stop intended for its predecessor.
 *
 * A service entry is durable configuration authority and is never removed by
 * reconciliation, even if its prior supervisor is gone.  Likewise, an entry
 * without a PID and without a terminal status is retained because it cannot
 * be proven stale.
 */
export type ReconcileStaleInstanceResult =
  | { kind: 'removed' }
  | { kind: 'absent' }
  | { kind: 'live-owner'; entry: InstanceConfig }
  | { kind: 'durable-service'; entry: InstanceConfig }
  | { kind: 'not-provably-stale'; entry: InstanceConfig };

export function reconcileStaleInstance(
  id: string,
  home?: string,
  options: InstanceRegistryLivenessOptions = {},
): ReconcileStaleInstanceResult {
  let result: ReconcileStaleInstanceResult = { kind: 'absent' };
  lockedReadModifyWrite(home, (current) => {
    const existing = current.instances[id];
    if (!existing) return current;
    if (existing.type === 'service') {
      result = { kind: 'durable-service', entry: existing };
      return current;
    }
    if (!isProvablyStaleEphemeralInstance(existing, options)) {
      result = entryOwnedByLiveProcess(existing, undefined, options)
        ? { kind: 'live-owner', entry: existing }
        : { kind: 'not-provably-stale', entry: existing };
      return current;
    }
    const next = { ...current.instances };
    delete next[id];
    result = { kind: 'removed' };
    return { version: 1, instances: next };
  });
  return result;
}

/**
 * Reaps every provably stale ephemeral record in a home-scoped registry.
 * Desktop invokes this before deriving local ownership, which makes a forced
 * parent loss converge on the next startup without weakening the live PID +
 * birth-fingerprint guard.  The returned registry is the exact post-reconcile
 * snapshot read under the same mutation lock.
 */
export function reconcileStaleInstances(
  home?: string,
  options: InstanceRegistryReconcileOptions = {},
): InstanceRegistry {
  return lockedReadModifyWrite(
    home,
    (current) => {
      let next: Record<string, InstanceConfig> | undefined;
      for (const [id, entry] of Object.entries(current.instances)) {
        if (
          entry.type !== 'service' &&
          isProvablyStaleEphemeralInstance(entry, options)
        ) {
          next ??= { ...current.instances };
          delete next[id];
        }
      }
      return next === undefined ? current : { version: 1, instances: next };
    },
    options.mutationLockOptions,
  );
}

/**
 * Reaps only desktop-sidecar records whose recorded owner is provably gone.
 *
 * This is deliberately narrower than `reconcileStaleInstances`: desktop
 * startup needs to converge a prior sidecar generation before it can repeat
 * its one-way runtime preparation, but that admission must not opportunistically
 * change an inline or worktree producer's bookkeeping.  A live owner, a PID
 * whose birth cannot be checked, and every durable service record remain an
 * ownership fence.
 */
export function reconcileStaleDesktopSidecars(
  home?: string,
  options: InstanceRegistryReconcileOptions = {},
): InstanceRegistry {
  return lockedReadModifyWrite(
    home,
    (current) => {
      let next: Record<string, InstanceConfig> | undefined;
      for (const [id, entry] of Object.entries(current.instances)) {
        // Runtime preparation has no authority to interpret a partial or
        // producer-terminal record. It may reap only the exact PID + birth
        // pair Desktop wrote for its prior sidecar generation.
        if (
          entry.type === 'sidecar' &&
          entry.status !== 'stopped' &&
          typeof entry.pid === 'number' &&
          Number.isInteger(entry.pid) &&
          entry.pid > 0 &&
          typeof entry.birth === 'string' &&
          entry.birth.length > 0 &&
          !entryOwnedByLiveProcess(entry, undefined, options)
        ) {
          next ??= { ...current.instances };
          delete next[id];
        }
      }
      return next === undefined ? current : { version: 1, instances: next };
    },
    options.mutationLockOptions,
  );
}

export interface ClaimInstanceEntryOptions {
  home?: string;
  /**
   * Existing-entry types that may never be displaced, even when dead. A
   * caller lists the types whose registry entries are durable authority
   * beyond process lifetime (the CLI lists 'service' — a service entry is
   * the durable origin-policy record, #1983 — and 'sidecar'). Types NOT
   * listed are displaceable once their process is provably not running.
   */
  protectedTypes?: readonly InstanceType[];
  /**
   * Existing-entry types the caller owns: liveness does not block a claim
   * over them. `service install` reconfiguring its own live unit is the
   * motivating case (station#3064) — the backend install protocol stops and
   * replaces that generation itself, so the live supervisor pid the unit
   * now publishes must not read as a foreign writer. Foreign-typed live
   * owners still refuse. Checked AFTER `protectedTypes`, which wins.
   */
  adoptTypes?: readonly InstanceType[];
}

export type ClaimInstanceEntryResult =
  | { written: true }
  | {
      written: false;
      reason: 'protected-type' | 'live-owner';
      existing: InstanceConfig;
    };

/**
 * Ownership-checked REPLACEMENT of `instances[id]` — the write primitive for
 * producers that publish a complete entry (station#3047). Two deliberate
 * differences from `upsertInstance`:
 *
 * - **Replace, not merge.** `upsertInstance` keeps every field the partial
 *   omits, which is how a service install over a CLI entry inherited the CLI
 *   process's `pid`/`birth` and flipped Desktop's home-ownership decision
 *   (the #3047 chimera). Here the entry written is exactly `entry`.
 * - **The guard runs inside the mutation lock.** The CLI producer's previous
 *   read-then-upsert guards left a gap where a foreign write landing between
 *   the read and the write was clobbered (the TOCTOU accepted in #2904's
 *   review). Refusal leaves the registry file untouched — no rewrite, no
 *   inode/mtime change, and no file creation in a home that had none.
 *
 * Refuses when the existing entry's type is in `protectedTypes` (dead or
 * alive), or when the existing entry is owned by a LIVE process other than
 * `entry.pid` — pid alive and `birth` not proving reuse (fail-open on probe
 * failure, mirroring `claimDesktopSidecar`). A matching `entry.pid` may
 * always refresh its own entry.
 */
export function claimInstanceEntry(
  id: string,
  entry: InstanceConfig,
  options: ClaimInstanceEntryOptions = {},
): ClaimInstanceEntryResult {
  if (
    typeof entry.port !== 'number' ||
    !Number.isFinite(entry.port) ||
    !isValidInstanceType(entry.type)
  ) {
    throw new Error(
      `instance "${id}" requires a numeric port and a valid type`,
    );
  }
  let result: ClaimInstanceEntryResult = { written: true };
  lockedReadModifyWrite(options.home, (current) => {
    const existing = current.instances[id];
    if (existing && (options.protectedTypes ?? []).includes(existing.type)) {
      result = { written: false, reason: 'protected-type', existing };
      return current;
    }
    if (
      existing &&
      !(options.adoptTypes ?? []).includes(existing.type) &&
      entryOwnedByLiveProcess(existing, entry.pid)
    ) {
      result = { written: false, reason: 'live-owner', existing };
      return current;
    }
    return {
      version: 1,
      instances: { ...current.instances, [id]: entry },
    };
  });
  return result;
}

/**
 * Unconditional exact write of `instances[id]` — no merge, no ownership
 * guard. For compensation paths restoring a captured prior entry, where the
 * restorer already holds the decision authority. New producers should use
 * `claimInstanceEntry` instead.
 */
export function replaceInstance(
  id: string,
  entry: InstanceConfig,
  home?: string,
): InstanceRegistry {
  return lockedReadModifyWrite(home, (current) => ({
    version: 1,
    instances: { ...current.instances, [id]: entry },
  }));
}

export interface UpdateOwnedInstanceOptions {
  home?: string;
  /** Apply only when the existing entry's type is one the caller owns. */
  ownTypes: readonly InstanceType[];
}

/**
 * Ownership-checked read-modify-write of an EXISTING entry (station#3064).
 * The updater receives a DEEP defensive copy — a shallow spread would share
 * `env` by reference, so a nested mutation would still reach the object the
 * caller reads back (the station#1606 lesson) — and returns the next entry, or
 * null to leave the registry untouched. No-op (returns false) when the entry
 * is absent or its type is not owned, so a caller cannot mint an entry a
 * different surface is responsible for creating.
 *
 * Distinct from `claimInstanceEntry` (replace, may create) because the
 * supervised service publishing its liveness must PRESERVE the fields
 * `service install` owns — `env.ALLOWED_ORIGINS` is durable origin-policy
 * authority (#1983) and must survive every liveness write.
 */
export function updateOwnedInstance(
  id: string,
  options: UpdateOwnedInstanceOptions,
  updater: (existing: InstanceConfig) => InstanceConfig | null,
): boolean {
  let updated = false;
  lockedReadModifyWrite(options.home, (current) => {
    const existing = current.instances[id];
    if (!existing) return current;
    if (!options.ownTypes.includes(existing.type)) return current;
    const next = updater(structuredClone(existing));
    if (next === null) return current;
    if (
      typeof next.port !== 'number' ||
      !Number.isFinite(next.port) ||
      !isValidInstanceType(next.type)
    ) {
      throw new Error(
        `instance "${id}" requires a numeric port and a valid type`,
      );
    }
    updated = true;
    return { version: 1, instances: { ...current.instances, [id]: next } };
  });
  return updated;
}

export interface RemoveOwnedInstanceOptions {
  home?: string;
  /**
   * Remove only when the entry's recorded pid matches (a stop must not
   * remove a newer start's entry). An entry with NO recorded pid is
   * removable by any owner-typed caller regardless of this value.
   */
  pid: number | null;
  /** Remove only when the entry's type is one the caller owns. */
  ownTypes: readonly InstanceType[];
}

/**
 * Ownership-checked removal counterpart to `claimInstanceEntry`: the
 * identity and type checks run inside the same lock as the delete, so a
 * foreign or newer entry landing between a caller's read and the removal
 * cannot be deleted (the stop-path half of the #2904 TOCTOU). No-op when
 * the entry is absent or the checks do not hold.
 */
export function removeOwnedInstance(
  id: string,
  options: RemoveOwnedInstanceOptions,
): boolean {
  let removed = false;
  lockedReadModifyWrite(options.home, (current) => {
    const existing = current.instances[id];
    if (!existing) return current;
    if (!options.ownTypes.includes(existing.type)) return current;
    if (typeof existing.pid === 'number' && existing.pid !== options.pid) {
      return current;
    }
    const next = { ...current.instances };
    delete next[id];
    removed = true;
    return { version: 1, instances: next };
  });
  return removed;
}

/** Atomically reserves the one desktop-sidecar slot for a home. */
export function claimDesktopSidecar(
  id: string,
  instance: InstanceConfig,
  home?: string,
): boolean {
  return (
    lockedReadModifyWrite(home, (current) => {
      // A desktop startup is a natural convergence point after its previous
      // supervisor was killed: clear only entries whose PID/birth identity
      // proves they are stale.  Keep services because their record is durable
      // origin-policy authority, not merely a liveness lease.
      let reconciledInstances: Record<string, InstanceConfig> | undefined;
      for (const [existingId, entry] of Object.entries(current.instances)) {
        if (
          existingId !== id &&
          entry.type !== 'service' &&
          isProvablyStaleEphemeralInstance(entry)
        ) {
          reconciledInstances ??= { ...current.instances };
          delete reconciledInstances[existingId];
        }
      }
      const reconciled =
        reconciledInstances === undefined
          ? current
          : { version: 1 as const, instances: reconciledInstances };
      const live = Object.entries(reconciled.instances).some(
        ([existingId, entry]) => {
          if (
            existingId === id ||
            entry.type !== 'sidecar' ||
            entry.status === 'stopped'
          ) {
            return false;
          }
          // A current claimant is live only when PID and birth both match. An
          // incomplete active record cannot prove staleness, so fail closed
          // instead of admitting a second sidecar beside an interrupted writer.
          if (
            typeof entry.pid !== 'number' ||
            typeof entry.birth !== 'string'
          ) {
            return true;
          }
          const liveness = processLiveness(entry.pid);
          if (liveness === 'dead') return false;
          // A process-birth lookup failure cannot prove that a claimant is
          // stale, so retain the claim rather than licensing a second sidecar.
          // NB: the previous check compared against `undefined`, but the
          // lookup returns NULL on failure — so the documented fail-open was
          // actually fail-closed (a `ps` timeout stole a live claim). The
          // shared predicate encodes the documented intent.
          return (
            liveness !== 'alive' || !birthProvesReuse(entry.birth, entry.pid)
          );
        },
      );
      if (live) return reconciled;
      return {
        version: 1,
        instances: { ...reconciled.instances, [id]: instance },
      };
    }).instances[id] === instance
  );
}

/**
 * Reads the registry (fail-closed per `readInstanceRegistry`) and returns
 * the subset of instances whose `pid` is set and alive (mirrors
 * `active-local-station.ts`'s `processIsAlive`). Read-only: does not mutate
 * stale entries — that is a future slice's job.
 */
export function findRunning(home?: string): InstanceConfig[] {
  const registry = readInstanceRegistry(home);
  return Object.values(registry.instances).filter((instance) => {
    if (typeof instance.pid !== 'number') return false;
    const liveness = processLiveness(instance.pid);
    if (liveness === 'dead') return false;
    // Reject pid reuse where a producer recorded a birth fingerprint: the
    // entry's process died, the pid was reissued, and a bare kill(pid, 0)
    // reads the impostor as alive. Without this, an entry orphaned by a
    // crash or reboot can permanently block fail-closed consumers
    // (`station home backup|restore` refuses while "something" is running,
    // with no id in the message and no stop that can clear it). Mirrors
    // `claimDesktopSidecar`: a lookup FAILURE stays fail-open — absence of
    // proof of reuse is not proof of reuse.
    if (liveness === 'alive' && birthProvesReuse(instance.birth, instance.pid))
      return false;
    return true;
  });
}
