import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeChildWorkload,
  spawnChildWorkload,
} from '@kontourai/station-shared/child-workload';
import {
  type ExactProcessIdentityProbe,
  lookupProcessBirthFingerprint,
  lookupProcessBirthFingerprintCached,
  PROCESS_BIRTH_FINGERPRINT_TIMEOUT_MS,
  probeExactProcessIdentity,
  processBirthPredatesCurrentBoot,
} from '@kontourai/station-shared/process-identity';
import { scrubBootInternalSecrets } from '../../utils/child-process-environment.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'process-utils' });

interface TerminableProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface ProcessTreeTerminationOptions {
  graceMs?: number;
  killConfirmMs?: number;
  taskkillTimeoutMs?: number;
  processGroup?: boolean;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
}

function directProcessExited(proc: TerminableProcess): boolean {
  return proc.exitCode !== null || proc.signalCode != null;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function processTreeExists(
  proc: TerminableProcess,
  processGroup: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (
    platform !== 'win32' &&
    processGroup &&
    proc.pid !== undefined &&
    processGroupExists(proc.pid)
  ) {
    return true;
  }
  return !directProcessExited(proc);
}

async function runWindowsTaskkill(
  pid: number,
  force: boolean,
  spawnProcess: typeof spawn,
  timeoutMs: number,
): Promise<void> {
  const taskkill = spawnProcess(
    'taskkill',
    ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])],
    { stdio: 'ignore', windowsHide: true },
  );
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try {
        taskkill.kill('SIGKILL');
      } catch {
        // The helper may have exited while its deadline fired.
      }
      finish(new Error(`taskkill did not settle within ${timeoutMs}ms.`));
    }, timeoutMs);
    taskkill.once('error', (error) => finish(error));
    taskkill.once('exit', (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`taskkill exited with code ${code ?? 'unknown'}.`));
    });
  });
}

async function sendTreeSignal(
  proc: TerminableProcess,
  signal: 'SIGTERM' | 'SIGKILL',
  processGroup: boolean,
  platform: NodeJS.Platform,
  spawnProcess: typeof spawn,
  taskkillTimeoutMs: number,
): Promise<boolean> {
  const pid = proc.pid;
  if (platform === 'win32' && pid !== undefined && processGroup) {
    await runWindowsTaskkill(
      pid,
      signal === 'SIGKILL',
      spawnProcess,
      taskkillTimeoutMs,
    );
    return signal === 'SIGKILL';
  }
  if (pid !== undefined && processGroup) {
    try {
      process.kill(-pid, signal);
      return false;
    } catch {
      // Custom process factories may not create a dedicated process group.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // The process exited between the liveness check and signal delivery.
  }
  return false;
}

async function waitForProcessTreeExit(
  proc: TerminableProcess,
  processGroup: boolean,
  timeoutMs: number,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processTreeExists(proc, processGroup, platform)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return !processTreeExists(proc, processGroup, platform);
}

/** Terminate a process and, when it owns a process group, all descendants. */
export async function terminateProcessTree(
  proc: TerminableProcess,
  options: ProcessTreeTerminationOptions = {},
): Promise<void> {
  try {
    await terminateNativeProcessTree(proc, options);
  } finally {
    await closeChildWorkload(proc.pid);
  }
}

async function terminateNativeProcessTree(
  proc: TerminableProcess,
  options: ProcessTreeTerminationOptions,
): Promise<void> {
  const processGroup = options.processGroup ?? true;
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const taskkillTimeoutMs = Math.max(
    1,
    options.taskkillTimeoutMs ?? options.killConfirmMs ?? 1_000,
  );
  if (!processTreeExists(proc, processGroup, platform)) return;

  let gracefulSignalSettled = true;
  try {
    await sendTreeSignal(
      proc,
      'SIGTERM',
      processGroup,
      platform,
      spawnProcess,
      taskkillTimeoutMs,
    );
  } catch (error) {
    if (platform !== 'win32') throw error;
    gracefulSignalSettled = false;
  }
  if (
    gracefulSignalSettled &&
    (await waitForProcessTreeExit(
      proc,
      processGroup,
      options.graceMs ?? 1_000,
      platform,
    ))
  ) {
    return;
  }

  const processTreeExitConfirmed = await sendTreeSignal(
    proc,
    'SIGKILL',
    processGroup,
    platform,
    spawnProcess,
    taskkillTimeoutMs,
  );
  if (processTreeExitConfirmed) return;
  if (
    !(await waitForProcessTreeExit(
      proc,
      processGroup,
      options.killConfirmMs ?? 1_000,
      platform,
    ))
  ) {
    throw new Error('Process tree did not confirm exit after SIGKILL.');
  }
}

/** Backward-compatible ACP call site over the shared process-tree primitive. */
export function forceKillProcess(proc: ChildProcess): Promise<void> {
  return terminateProcessTree(proc, { processGroup: true });
}

// ---------------------------------------------------------------------------
// archive#1863: owned-process reaping.
//
// A child spawned with `detached: true` survives the parent that created it —
// that is deliberate (a group kill reaps the grandchild through it). But it is
// also WHY an engine process outlives a Station that was SIGKILLed, crashed,
// or died on ENOSPC: none of the in-process cleanup paths run, so nothing at
// the OS level ever ends the orphaned engine. A `finally`, a `dispose()`, an
// `exit` handler, or a `SIGTERM` listener is insufficient BY CONSTRUCTION,
// because every observed orphan came from a case where none of those ran.
//
// The mechanism below is the only shape that survives the parent dying without
// running code: a host-wide registry of spawned children, tagged with the
// owning Station's pid + birth fingerprint, that a subsequent startup sweep
// reads back. The sweep reaps a child ONLY when its recorded owner is
// demonstrably gone (dead pid, or a live pid whose birth fingerprint no longer
// matches — i.e. PID reuse by an unrelated process). A live sibling Station's
// owner pid is alive with a matching birth, so its engines are never touched.
// ---------------------------------------------------------------------------

/** Environment variable stamped onto every owned child, for diagnostics. */
const STATION_SPAWN_OWNER_PID_ENV = 'STATION_SPAWN_OWNER_PID';
const STATION_SPAWN_OWNER_INSTANCE_ENV = 'STATION_SPAWN_OWNER_INSTANCE';
const STATION_SPAWN_OWNER_BOOT_ENV = 'STATION_SPAWN_OWNER_BOOT';

/**
 * Overrides the host-wide registry directory (tests). Production resolves it
 * under the OS temp dir so it survives the deletion of a `--temp-home` (the
 * observed orphans accumulated across temp-home probe lanes that were killed).
 */
const STATION_OWNED_PROCESS_REGISTRY_ENV = 'STATION_OWNED_PROCESS_REGISTRY';

/** The identity of the Station process that owns a spawned child. */
interface OwnedProcessOwner {
  pid: number;
  instanceId: string;
  bootId: string;
  /** Process birth fingerprint at the time of ownership, for reuse detection. */
  birth: string | null;
}

/** A registry record: one spawned child and the owner that is responsible. */
interface OwnedProcessRecord {
  /** Schema version so a future shape change can be detected, not guessed. */
  schemaVersion: 1;
  /** The spawned child pid. For a detached child this is also its group id. */
  enginePid: number;
  /** Birth fingerprint of the child, to refuse killing a recycled pid. */
  engineBirth: string | null;
  owner: OwnedProcessOwner;
  command: string;
  spawnedAt: string;
}

/** Directory holding one JSON record per spawned owned child. */
function ownedProcessRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STATION_OWNED_PROCESS_REGISTRY_ENV];
  if (override && override.length > 0) return override;
  return join(tmpdir(), 'station-owned-processes');
}

/**
 * Resolve the owner identity from the CURRENT process env. The spawning
 * Station already carries STATION_INSTANCE_ID / STATION_BOOT_ID; its own pid
 * is the owner pid. When those env vars are absent (a bare `node` run with no
 * lifecycle identity), the owner is recorded with placeholders — the sweep
 * still works because pid liveness + birth fingerprint is the gate, not the
 * textual identity.
 */
export function resolveOwnedProcessOwner(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): OwnedProcessOwner {
  return {
    pid,
    instanceId: env.STATION_INSTANCE_ID ?? 'unknown',
    bootId: env.STATION_BOOT_ID ?? 'unknown',
    // This process's own birth cannot change, so after one successful probe
    // the shared cache answers without blocking (#561); every registration
    // records it. Any other pid is probed fresh.
    birth:
      pid === process.pid
        ? lookupProcessBirthFingerprintCached(pid)
        : lookupProcessBirthFingerprint(pid),
  };
}

/**
 * archive#1863 BLOCKING 2: the registry directory is a host-wide, predictable
 * path. Anything that can drop a file into it before the next boot gets an
 * arbitrary group-SIGKILL executed by Station at sweep time (see BLOCKING 1:
 * an unvalidated enginePid negated into a group kill). So the directory MUST
 * be owned by us and have no group/other permission bits — otherwise we refuse
 * to read or write it entirely. A missed sweep is an acceptable failure; a
 * wrong kill is not.
 *
 * `recursive: true` with `mode` only applies the mode to NEWLY created
 * directories; a pre-existing directory keeps its own mode, so we stat it
 * afterward and fail closed if it is foreign-owned or too permissive.
 */
const REGISTRY_DIR_REQUIRED_MODE = 0o700;

type RegistryTrustReason =
  | { kind: 'not-directory' }
  | { kind: 'foreign-owner'; ownerUid: number; ourUid: number }
  | { kind: 'too-permissive'; mode: number };

/**
 * Pure trust evaluation over a stat-like object, extracted (archive#1863 fix
 * round 3) so the foreign-owner refusal branch — which cannot be exercised
 * against a real foreign-owned directory without root, yet gates an arbitrary
 * group-SIGKILL — is unit-testable. The directory is trustworthy only when it
 * is a directory, owned by `ourUid`, and has no group/other permission bits.
 * Returns null when it is trustworthy, or the first failing reason otherwise.
 */
export function evaluateRegistryDirTrust(
  stat: { isDirectory(): boolean; uid: number; mode: number },
  ourUid: number | undefined,
): RegistryTrustReason | null {
  if (!stat.isDirectory()) return { kind: 'not-directory' };
  if (ourUid !== undefined && stat.uid !== ourUid) {
    return { kind: 'foreign-owner', ownerUid: stat.uid, ourUid };
  }
  if ((stat.mode & 0o077) !== 0) {
    return { kind: 'too-permissive', mode: stat.mode & 0o777 };
  }
  return null;
}

function registryDirIsTrustworthy(
  registryDir: string,
  log: (message: string, data?: unknown) => void,
): boolean {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(registryDir);
  } catch {
    // Just vanished or unreadable — cannot trust, fail closed.
    return false;
  }
  const ourUid =
    typeof process.getuid === 'function' ? process.getuid() : undefined;
  const reason = evaluateRegistryDirTrust(stat, ourUid);
  if (reason === null) return true;
  if (reason.kind === 'not-directory') {
    log('owned-process registry: registry path is not a directory; refusing', {
      registryDir,
    });
  } else if (reason.kind === 'foreign-owner') {
    log(
      'owned-process registry: directory is not owned by us; refusing to read or write it',
      {
        registryDir,
        ownerUid: reason.ownerUid,
        ourUid: reason.ourUid,
      },
    );
  } else {
    log(
      'owned-process registry: directory mode is broader than 0700; refusing to read or write it',
      {
        registryDir,
        mode: `0o${reason.mode.toString(8).padStart(3, '0')}`,
      },
    );
  }
  return false;
}

/**
 * Create the registry directory if absent and verify a pre-existing one is
 * trustworthy. Returns true if the caller may use it; false to fail closed
 * (skip the write or skip the sweep).
 */
function ensureRegistryDir(
  registryDir: string,
  log: (message: string, data?: unknown) => void,
): boolean {
  try {
    mkdirSync(registryDir, {
      recursive: true,
      mode: REGISTRY_DIR_REQUIRED_MODE,
    });
  } catch (error) {
    log('owned-process registry: could not create directory', {
      registryDir,
      error: String(error),
    });
    return false;
  }
  return registryDirIsTrustworthy(registryDir, log);
}

function recordFilePath(registryDir: string, enginePid: number): string {
  return join(registryDir, `engine-${enginePid}.json`);
}

/**
 * Persist a registry record for a spawned child. Called by `spawnOwnedChild`
 * immediately after the child is created, so the record exists BEFORE the
 * owner can die — the whole property depends on the record outliving the
 * owner, including an owner that is SIGKILLed mid-run.
 */
export function recordOwnedProcess(
  enginePid: number,
  owner: OwnedProcessOwner,
  command: string,
  options: {
    registryDir?: string;
    env?: NodeJS.ProcessEnv;
    log?: (message: string, data?: unknown) => void;
  } = {},
): OwnedProcessRecord {
  const registryDir =
    options.registryDir ?? ownedProcessRegistryDir(options.env);
  const log = options.log ?? (() => {});
  if (!ensureRegistryDir(registryDir, log)) {
    // Fail closed: do not write into an untrusted directory. The spawn still
    // succeeds; the child is simply not sweep-protected. spawnOwnedChild
    // already swallows write failures for the same reason.
    return {
      schemaVersion: 1,
      enginePid,
      engineBirth: lookupProcessBirthFingerprint(enginePid),
      owner,
      command,
      spawnedAt: new Date().toISOString(),
    };
  }
  const record: OwnedProcessRecord = {
    schemaVersion: 1,
    enginePid,
    engineBirth: lookupProcessBirthFingerprint(enginePid),
    owner,
    command,
    spawnedAt: new Date().toISOString(),
  };
  // 'w' = O_WRONLY | O_CREAT | O_TRUNC: replace any stale record for a
  // recycled pid rather than appending a second entry.
  writeFileSync(
    recordFilePath(registryDir, enginePid),
    `${JSON.stringify(record)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  return record;
}

/** Remove a child's registry record. Called after a graceful destroy. */
export function forgetOwnedProcess(
  enginePid: number,
  options: { registryDir?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const registryDir =
    options.registryDir ?? ownedProcessRegistryDir(options.env);
  rmSync(recordFilePath(registryDir, enginePid), { force: true });
}

/**
 * A `probeExactProcessIdentity`-shaped function. Extracted as a type alias so
 * the sweep can accept a test seam (archive#1863 fix round 3) without changing
 * its production behavior.
 */
export type ProcessIdentityProbe = (pid: number) => ExactProcessIdentityProbe;

/**
 * True when the recorded owner is demonstrably gone. Uses the shared
 * three-state {@link probeExactProcessIdentity} so the discipline is uniform
 * with the engine check below: a live PID whose fingerprint cannot be read is
 * UNAVAILABLE, never dead — the caller retains the fence rather than
 * reclaiming a possibly-live owner. That makes the fail-open defect class
 * (null birth → skip check → kill) unwritable.
 */
function ownerIsGone(
  owner: OwnedProcessOwner,
  probeIdentity: ProcessIdentityProbe = probeExactProcessIdentity,
): boolean {
  const probe = probeIdentity(owner.pid);
  if (probe.state === 'dead') return true;
  // 'unavailable' (alive but fingerprint unreadable) or 'exact' without a
  // recorded birth to compare against: cannot confirm the owner is gone, so
  // retain (a missed reclaim is acceptable; a wrong reap is not).
  if (probe.state === 'unavailable' || !owner.birth) return false;
  // 'exact' with a recorded birth: a mismatch means the pid was recycled by
  // an unrelated process — the original owner is demonstrably gone.
  return probe.identity.start !== owner.birth;
}

interface OwnedProcessSweepResult {
  /** Orphaned groups whose live recorded leader was group-SIGKILLed. */
  reaped: number[];
  /** Records whose child and its whole process group had already exited. */
  alreadyDead: number;
  /**
   * Records removed because their pid no longer names the recorded child: a
   * birth mismatch, or a dead leader whose record is from an earlier boot.
   */
  recycled: number;
  /**
   * Records left in place: the owner is alive, an identity is unavailable,
   * or a dead leader's group still has members (see `survivingGroups`).
   */
  retained: number;
  /** Records that could not be parsed; left for a human rather than guessed. */
  corrupt: number;
  /**
   * #561: records dropped, never signaled, because the owner is gone and no
   * engine birth was recorded. Nothing could ever prove the pid is still the
   * recorded child, so the record could never be acted on.
   */
  unverifiable: number;
  /**
   * #561: retained records whose leader is dead while its process group still
   * has members. Nothing is signaled; `members` is null when unreadable.
   */
  survivingGroups: Array<{ pgid: number; members: number | null }>;
}

/**
 * archive#1863 BLOCKING 1: validate an engine pid BEFORE negating it into a
 * negative-group `process.kill(-pid, …)`. Without this guard, `enginePid: 0`
 * SIGKILLs Station's own process group (`-0 === 0`), `enginePid: 1` SIGKILLs
 * every process the user may signal, and a negative pid signals an arbitrary
 * positive pid. Only a positive integer greater than 1 that is not our own pid
 * is ever negated. Everything else is classified corrupt and never reaches the
 * kill.
 */
function isKillableEnginePid(pid: unknown): pid is number {
  return (
    typeof pid === 'number' &&
    Number.isInteger(pid) &&
    pid > 1 &&
    pid !== process.pid
  );
}

/** A live process in a process group, as the process table reports it. */
export interface ProcessGroupMember {
  pid: number;
  ppid: number;
}

/** Lists the members of process group `pgid`, or null when unreadable. */
export type ProcessGroupLister = (
  pgid: number,
) => Promise<ProcessGroupMember[] | null>;

const PS_PID_PPID_PGID_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/;

/**
 * Parse `ps -A -o pid=,ppid=,pgid=` output into the members of group `pgid`.
 * Null when any non-blank line is not exactly three integers: a partial or
 * garbled table is never read as a complete one.
 */
export function parseProcessGroupListing(
  stdout: string,
  pgid: number,
): ProcessGroupMember[] | null {
  const members: ProcessGroupMember[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const match = PS_PID_PPID_PGID_LINE.exec(line);
    if (!match) return null;
    if (Number(match[3]) === pgid) {
      members.push({ pid: Number(match[1]), ppid: Number(match[2]) });
    }
  }
  return members;
}

/**
 * Read the members of process group `pgid` (macOS and procps `ps`). Null when
 * `ps` fails, times out, or prints a line {@link parseProcessGroupListing}
 * rejects.
 */
const listProcessGroupMembers: ProcessGroupLister = (pgid) =>
  new Promise((resolve) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid=,pgid='],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: PROCESS_BIRTH_FINGERPRINT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout) => {
        resolve(error ? null : parseProcessGroupListing(stdout, pgid));
      },
    );
  });

type DeadLeaderGroupOutcome =
  | { kind: 'empty' }
  | { kind: 'previous-boot' }
  | { kind: 'surviving'; members: number | null };

/**
 * #561: the recorded leader is dead. Its process group may still have live
 * members, and dropping the record would forget them for good.
 *
 * The sweep NEVER signals such a group. No per-member proof available here
 * ties a group with a dead leader to the recorded engine: pids wrap within
 * minutes, and a normal host carries many unrelated groups with a dead leader
 * and init-parented members (crash handlers, servers, shell jobs). A review
 * probe showed a birth-and-parentage check SIGKILLing exactly such a group.
 * A missed reclaim is acceptable; a wrong kill is not.
 *
 * - Group empty: the record can go.
 * - Record from an earlier boot: nothing it names can still run, so the
 *   record goes without a signal.
 * - Otherwise (current boot, or a boot that cannot be read): the record is
 *   retained and reported as a surviving group. A later sweep re-checks it
 *   and drops it once the group is empty.
 */
async function settleDeadLeaderGroup(
  record: OwnedProcessRecord,
  listGroup: ProcessGroupLister,
): Promise<DeadLeaderGroupOutcome> {
  if (process.platform === 'win32' || !processGroupExists(record.enginePid)) {
    return { kind: 'empty' };
  }
  if (
    record.engineBirth &&
    processBirthPredatesCurrentBoot(record.engineBirth) === true
  ) {
    return { kind: 'previous-boot' };
  }
  const members = await listGroup(record.enginePid);
  return { kind: 'surviving', members: members?.length ?? null };
}

/**
 * Sweep the host-wide registry and group-SIGKILL every child whose owner is
 * demonstrably gone. This is the ONLY path that reclaims orphans left by a
 * Station that was SIGKILLed, crashed, or died on ENOSPC — those owners never
 * ran their own cleanup, so their registry records persist until a later
 * startup reads them back here.
 *
 * Scoping safety: a child is reaped ONLY when `ownerIsGone` is true AND the
 * engine's identity is confirmed via the shared three-state
 * `probeExactProcessIdentity`. A live sibling Station's owner pid is alive
 * with a matching birth fingerprint, so its engines are always retained. The
 * engine pid is validated by {@link isKillableEnginePid} before any negation,
 * so a record carrying `0`, `1`, a negative pid, or our own pid is corrupt
 * and never reaches the kill. An engine pid that is alive but whose
 * fingerprint cannot be read is UNAVAILABLE — it is RETAINED, never killed,
 * because a missed reclaim is acceptable and a wrong kill is not. Both
 * directions of pid reuse (owner and engine) are covered by birth comparison.
 * A dead leader whose process group still has members is retained and
 * reported in `survivingGroups`, never signaled (#561): the group id alone
 * cannot prove those members are the recorded engine's. A record with no
 * engine birth is never signaled either; once its owner is gone it is
 * dropped and counted in `unverifiable` (#561).
 *
 * Registry trust (archive#1863 BLOCKING 2): the sweep refuses to read a
 * directory that is not owned by us or whose mode is broader than 0700, so a
 * foreign-planted record cannot weaponize the kill.
 *
 * POSIX-only in effect: the negative-group `kill(-pid, 'SIGKILL')` reaps the
 * whole process group, including a re-execed grandchild (`kiro-cli` →
 * `kiro-cli-chat`). Windows process groups do not work this way; see
 * `terminateProcessTree` for the Windows `taskkill /t` path, which the sweep
 * does not currently invoke.
 */
export async function sweepOrphanedOwnedProcesses(
  options: {
    registryDir?: string;
    env?: NodeJS.ProcessEnv;
    log?: (message: string, data?: unknown) => void;
    /**
     * Test seam (archive#1863 fix round 3): override the identity probe so the
     * fail-closed 'unavailable' branch — unreachable against a real process
     * whose fingerprint is always readable on the test host, yet is exactly the
     * branch that matters under the ENOSPC/high-load conditions archive#1863 targets —
     * can be exercised behaviourally. Defaults to the real
     * {@link probeExactProcessIdentity}; production callers never pass it.
     */
    probeIdentity?: ProcessIdentityProbe;
    /** Test seam over {@link listProcessGroupMembers}. */
    listProcessGroup?: ProcessGroupLister;
  } = {},
): Promise<OwnedProcessSweepResult> {
  const registryDir =
    options.registryDir ?? ownedProcessRegistryDir(options.env);
  const log = options.log ?? (() => {});
  const probeIdentity = options.probeIdentity ?? probeExactProcessIdentity;
  const listGroup = options.listProcessGroup ?? listProcessGroupMembers;
  const result: OwnedProcessSweepResult = {
    reaped: [],
    alreadyDead: 0,
    recycled: 0,
    retained: 0,
    corrupt: 0,
    unverifiable: 0,
    survivingGroups: [],
  };
  // BLOCKING 2: never read a registry we do not own.
  if (!registryDirIsTrustworthy(registryDir, log)) {
    return result;
  }
  let entries: string[];
  try {
    entries = readdirSync(registryDir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.startsWith('engine-') || !entry.endsWith('.json')) continue;
    const file = join(registryDir, entry);
    let record: OwnedProcessRecord;
    try {
      record = JSON.parse(readFileSync(file, 'utf8')) as OwnedProcessRecord;
      if (record.schemaVersion !== 1 || typeof record.enginePid !== 'number') {
        throw new Error('bad schema');
      }
    } catch (error) {
      result.corrupt += 1;
      log('owned-process sweep: skipping unparseable record', {
        file,
        error: String(error),
      });
      continue;
    }
    // BLOCKING 1: validate the engine pid BEFORE any negation. A record
    // carrying 0, 1, a negative pid, or our own pid is corrupt and must never
    // reach `process.kill(-pid, …)`.
    if (!isKillableEnginePid(record.enginePid)) {
      result.corrupt += 1;
      log(
        'owned-process sweep: rejecting record with invalid engine pid; not killing',
        {
          file,
          enginePid: record.enginePid,
        },
      );
      continue;
    }
    if (!ownerIsGone(record.owner, probeIdentity)) {
      result.retained += 1;
      continue;
    }
    // #561: the owner is gone, so nothing will ever release this record, and
    // with no recorded engine birth nothing can prove its pid (or group) is
    // still the recorded child. Retaining it kept it forever. Drop it without
    // probing or signaling the engine: a missed reclaim, never a wrong kill.
    if (!record.engineBirth) {
      result.unverifiable += 1;
      logger.warn(
        'owned-process sweep: owner gone and no engine birth recorded; dropping the record, not signaling',
        {
          enginePid: record.enginePid,
          ownerPid: record.owner.pid,
          command: record.command,
        },
      );
      rmSync(file, { force: true });
      continue;
    }
    // The owner is gone. Confirm the engine pid is the same process that was
    // recorded before killing it — using the shared three-state probe so the
    // discipline is identical to the owner check and the fail-open class
    // (null birth → skip check → kill) is structurally unwritable.
    const engineProbe = probeIdentity(record.enginePid);
    if (engineProbe.state === 'dead') {
      // #561: a dead leader does not mean a dead group, but nothing here can
      // prove a surviving group is ours, so it is retained, never signaled.
      const group = await settleDeadLeaderGroup(record, listGroup);
      if (group.kind === 'empty') {
        result.alreadyDead += 1;
        rmSync(file, { force: true });
        continue;
      }
      if (group.kind === 'previous-boot') {
        result.recycled += 1;
        log('owned-process sweep: record is from an earlier boot; removing', {
          enginePid: record.enginePid,
        });
        rmSync(file, { force: true });
        continue;
      }
      result.retained += 1;
      result.survivingGroups.push({
        pgid: record.enginePid,
        members: group.members,
      });
      logger.warn(
        'owned-process sweep: leader dead but its process group is alive; retaining the record, not signaling',
        {
          pgid: record.enginePid,
          members: group.members,
          command: record.command,
        },
      );
      continue;
    } else if (engineProbe.state === 'unavailable') {
      // Alive but the fingerprint cannot be read right now (ENOSPC, high
      // load, transient failure). FAIL CLOSED: retain rather than risk
      // killing a recycled pid we cannot identify.
      result.retained += 1;
      log(
        'owned-process sweep: engine pid alive but identity unavailable; retaining',
        { enginePid: record.enginePid },
      );
      continue;
    } else {
      // 'exact': we have a current fingerprint. Compare it against the
      // recorded birth (non-null: a null birth was dropped above, unsignaled).
      // Mismatch ⇒ the pid was recycled ⇒ drop the record.
      if (engineProbe.identity.start !== record.engineBirth) {
        result.recycled += 1;
        log('owned-process sweep: engine pid recycled; removing stale record', {
          enginePid: record.enginePid,
        });
        rmSync(file, { force: true });
        continue;
      }
    }
    // Identity confirmed: same pid, same birth fingerprint. The owner is gone.
    // Reap the whole process group.
    try {
      // Negative pid => signal the whole process group. A detached child's
      // group id equals its pid, so this reaps the grandchild too. The pid
      // is already validated > 1 and !== process.pid by isKillableEnginePid.
      process.kill(-record.enginePid, 'SIGKILL');
      result.reaped.push(record.enginePid);
      log('owned-process sweep: reaped orphaned engine group', {
        enginePid: record.enginePid,
        ownerPid: record.owner.pid,
        command: record.command,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        // The group exited between the liveness check and the signal.
        result.alreadyDead += 1;
      } else {
        log('owned-process sweep: group SIGKILL failed', {
          enginePid: record.enginePid,
          error: String(error),
        });
        result.retained += 1;
        continue;
      }
    }
    rmSync(file, { force: true });
  }
  return result;
}

interface OwnedChildHandle {
  proc: ChildProcess;
  /** Remove this child's registry record. Call after a graceful destroy. */
  release: () => void;
}

interface SpawnOwnedChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'ignore' | 'pipe' | 'inherit' | Array<'ignore' | 'pipe' | 'inherit'>;
  /** Owner identity; defaults to the current process. */
  owner?: OwnedProcessOwner;
  /** Registry directory; defaults to the host-wide resolved dir. */
  registryDir?: string;
}

/**
 * Spawn a detached child, stamp it with the owner's identity, and register it
 * so a future startup sweep can reap it if THIS process dies without running
 * cleanup. The child is its own process-group leader (POSIX), so a negative-pid
 * signal reaps the whole tree including any re-execed grandchild.
 *
 * This is the shared primitive archive#1865's other spawning sites are waiting on:
 * the registration + sweep are engine-agnostic, so a Codex process, a terminal
 * subprocess, or any other long-lived child can adopt it without a per-site
 * copy.
 */
export function spawnOwnedChild(
  command: string,
  args: string[],
  options: SpawnOwnedChildOptions = {},
): OwnedChildHandle {
  const owner = options.owner ?? resolveOwnedProcessOwner();
  const childEnv: NodeJS.ProcessEnv = {
    ...scrubBootInternalSecrets(options.env ?? process.env),
    [STATION_SPAWN_OWNER_PID_ENV]: String(owner.pid),
    [STATION_SPAWN_OWNER_INSTANCE_ENV]: owner.instanceId,
    [STATION_SPAWN_OWNER_BOOT_ENV]: owner.bootId,
  };
  const proc = spawnChildWorkload(command, args, {
    cwd: options.cwd,
    env: childEnv,
    stdio: options.stdio ?? 'pipe',
    windowsHide: true,
    detached: true,
  });
  // Register as soon as a pid exists. If the spawn itself is about to fail
  // (ENOENT), the pid may be undefined — nothing to register, and the caller's
  // own 'error' handling applies. A successfully spawned child gets a record
  // before this function returns, so no in-process failure can separate the
  // two. A SIGKILL of the owner between `spawn` and the write (which includes
  // a synchronous birth probe) still leaves an unregistered group (#561).
  const release = registerOwnedChild(proc, command, {
    owner,
    registryDir: options.registryDir,
  });
  return { proc, release };
}

/**
 * Write the registry record for a just-spawned child and return its release.
 * A registry write failure never prevents the spawn from succeeding; it is
 * logged, and the child is simply not sweep-protected.
 */
function registerOwnedChild(
  proc: Pick<ChildProcess, 'pid'>,
  command: string,
  options: { owner?: OwnedProcessOwner; registryDir?: string } = {},
): () => void {
  const pid = proc.pid;
  if (typeof pid !== 'number') return () => {};
  const registryDir = options.registryDir ?? ownedProcessRegistryDir();
  const warn = (message: string, data?: unknown) =>
    logger.warn(message, { command, pid, detail: data });
  try {
    recordOwnedProcess(
      pid,
      options.owner ?? resolveOwnedProcessOwner(),
      command,
      { registryDir, log: warn },
    );
  } catch (error) {
    // The graceful destroy path still works without a record. The child is
    // simply not sweep-protected if the host disk is unwritable, and says so.
    warn(
      'owned-process registry: record write failed; child is not sweep-protected',
      {
        registryDir,
        error: String(error),
      },
    );
  }
  // Callers release from 'exit' listeners, timers and shutdown paths, where
  // a throw (a record that cannot be removed) would be uncaught. A record
  // left behind is re-checked by the next startup sweep.
  return () => {
    try {
      forgetOwnedProcess(pid, { registryDir });
    } catch (error) {
      warn('owned-process registry: record removal failed', {
        registryDir,
        error: String(error),
      });
    }
  };
}

/**
 * Register a child its caller already spawned DETACHED, for call sites whose
 * spawn options `spawnOwnedChild` does not carry (a shell command line, an
 * IPC channel, an allow-listed environment). The record lets the startup
 * sweep reap the group if this owner dies without cleanup, and it is
 * released only once the whole process group has exited (#561).
 *
 * The child MUST lead its own process group: the sweep signals `-pid`, so a
 * child spawned without `detached: true` (these call sites on Windows) must
 * not be registered. Like `spawnOwnedChild`, registration happens after
 * `spawn` returns; a SIGKILL of the owner in between leaves no record.
 */
export function registerDetachedOwnedChild(
  proc: Pick<ChildProcess, 'pid' | 'once'>,
  command: string,
): void {
  releaseOwnedChildAfterGroupExit(proc, registerOwnedChild(proc, command));
}

/**
 * Release an owned child's registry record once its whole process group has
 * exited, not just the leader (#561). A leader that exits while descendants
 * keep its group alive keeps its record, so the startup sweeps after this
 * owner is gone retain and report that group (never signal it) until it is
 * empty. On Windows there is no group to wait for.
 *
 * `release` runs from an 'exit' listener or a timer, so it must not throw;
 * the releases `spawnOwnedChild` and `registerDetachedOwnedChild` build log
 * a failed removal instead.
 */
export function releaseOwnedChildAfterGroupExit(
  proc: Pick<ChildProcess, 'pid' | 'once'>,
  release: () => void,
  options: { pollMs?: number; maxWaitMs?: number } = {},
): void {
  const pollMs = options.pollMs ?? 50;
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  proc.once('exit', () => {
    const pid = proc.pid;
    if (typeof pid !== 'number' || process.platform === 'win32') {
      release();
      return;
    }
    const deadline = Date.now() + maxWaitMs;
    const check = () => {
      if (!processGroupExists(pid)) {
        release();
        return;
      }
      if (Date.now() >= deadline) return;
      setTimeout(check, pollMs).unref();
    };
    check();
  });
}
