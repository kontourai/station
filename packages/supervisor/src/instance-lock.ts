/**
 * One supervisor per (home, instance), by lock epochs and process identity.
 *
 * Why this is correct. Three earlier designs decided liveness by *reaching*
 * the holder (a probe, a socket connect); a holder that is alive but stopped,
 * backlogged, or missing its socket file looked dead to all of them. This one
 * never asks whether the holder can be reached, only whether it still exists:
 *
 * - Epochs. Lock files are `<run>/instance-<instance>.lock.<n>` with n written
 *   without leading zeros (`[1-9]\d*`; anything else is ignored). They are
 *   created only with `wx`, so each epoch has exactly one winner. The current
 *   lock is the highest n. The top epoch is never deleted: a clean exit marks
 *   it released (temp file + rename in the same directory, only while it still
 *   holds our nonce and pid), so epochs only ever go up. Only the holder of
 *   the top epoch collects epochs below it.
 * - Content: `{pid, nonce, startFingerprint, createdAt, control, releasedAt?}`.
 *   The fingerprint is the deterministic process start time from
 *   generation-registry.ts (Linux: /proc starttime plus boot id; macOS: `ps`
 *   pinned to TZ=UTC, LC_ALL=C; Windows: creation time ticks).
 * - Liveness of the top epoch's holder:
 *   LIVE if its pid exists and its current fingerprint equals the recorded one.
 *   DEAD only if the epoch is released, the pid is gone, or the pid exists with
 *   a known, different fingerprint (the pid was reused).
 *   Unknown fingerprint (tool missing, timeout, unparseable), or a holder that
 *   recorded none while its pid exists: LIVE. Fail closed.
 *   An empty or half-written file: LIVE-PENDING while younger than the pending
 *   grace (a winner between `wx` and its write), DEAD after it.
 *   A stopped, flooded, or unreachable holder is still LIVE: that is the point.
 * - Acquire: read the top; none means create 1; LIVE or LIVE-PENDING means
 *   refuse; DEAD means create top+1, and on EEXIST start over (the winner of
 *   that epoch is now LIVE).
 * - Socket: an existing socket file is replaced only by the holder of the top
 *   epoch, and only when connecting to it is refused or finds nothing. A
 *   successful connect, or any other error, refuses. With the lock proving the
 *   previous holder dead, a refused connect there is a leftover file.
 * - After binding, and every self-check interval while serving, the holder
 *   confirms the top epoch is still its own; if not it drains and exits. It
 *   also re-binds its socket path if the file was deleted or replaced.
 *
 * Accepted limits: a SIGSTOPped holder keeps the instance until it is
 * continued or killed. Correctness rests on the fingerprint being stable for
 * a process's lifetime and different for a new process with the same pid.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type Fingerprint,
  processCommandLine,
  processFingerprint,
} from './generation-registry.ts';

export class SupervisorStartError extends Error {}

const LOCK_PENDING_GRACE_MS = 30_000;
const MAX_EPOCH = 1_000_000_000;

interface LockContent {
  pid: number;
  nonce: string;
  /** Empty when the holder could not fingerprint itself. */
  startFingerprint: string;
  createdAt: number;
  control: string;
  releasedAt?: number;
}

export interface InstanceLock {
  epoch: number;
  nonce: string;
  path: string;
}

type HolderState = 'live' | 'live-pending' | 'dead';

function epochPattern(instance: string): RegExp {
  const escaped = instance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^instance-${escaped}\\.lock\\.([1-9]\\d*)$`);
}

function epochPath(runDir: string, instance: string, epoch: number): string {
  return join(runDir, `instance-${instance}.lock.${epoch}`);
}

function listEpochs(runDir: string, instance: string): number[] {
  const pattern = epochPattern(instance);
  return readdirSync(runDir)
    .map((name) => pattern.exec(name)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n <= MAX_EPOCH);
}

function highestEpoch(runDir: string, instance: string): number | null {
  const epochs = listEpochs(runDir, instance);
  return epochs.length === 0 ? null : Math.max(...epochs);
}

function readContent(path: string): LockContent | null {
  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as Partial<LockContent>;
    if (
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.nonce === 'string' &&
      parsed.nonce.length > 0 &&
      typeof parsed.startFingerprint === 'string' &&
      typeof parsed.createdAt === 'number' &&
      typeof parsed.control === 'string' &&
      (parsed.releasedAt === undefined || typeof parsed.releasedAt === 'number')
    ) {
      return parsed as LockContent;
    }
  } catch {
    // Empty, half-written, or garbage.
  }
  return null;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Verdict {
  state: HolderState;
  pid: number | null;
  why: string;
  /** True only when the holder is live by a known, matching fingerprint. */
  verified: boolean;
}

function readReleased(path: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      releasedAt?: unknown;
    };
    return typeof raw.releasedAt === 'number';
  } catch {
    return false;
  }
}

async function judge(
  path: string,
  graceMs: number,
  fingerprint: (pid: number) => Promise<Fingerprint>,
): Promise<Verdict> {
  // A released marker wins, even on a lock that was broken while half-written.
  if (readReleased(path)) {
    return {
      state: 'dead',
      pid: readContent(path)?.pid ?? null,
      why: 'released',
      verified: false,
    };
  }
  const content = readContent(path);
  if (!content) {
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Date.now() - statSync(path).mtimeMs;
    } catch {
      return {
        state: 'dead',
        pid: null,
        why: 'lock file vanished',
        verified: false,
      };
    }
    return ageMs < graceMs
      ? {
          state: 'live-pending',
          pid: null,
          why: 'lock is being written',
          verified: false,
        }
      : {
          state: 'dead',
          pid: null,
          why: 'lock was never completed',
          verified: false,
        };
  }
  const pid = content.pid;
  if (!pidExists(pid))
    return { state: 'dead', pid, why: 'pid is gone', verified: false };
  if (pid === process.pid) {
    return { state: 'live', pid, why: 'held by this process', verified: true };
  }
  if (content.startFingerprint === '') {
    return {
      state: 'live',
      pid,
      why: 'pid exists; holder recorded no fingerprint',
      verified: false,
    };
  }
  const current = await fingerprint(pid);
  if (current.status === 'gone')
    return { state: 'dead', pid, why: 'pid is gone', verified: false };
  if (current.status === 'unknown') {
    return {
      state: 'live',
      pid,
      why: `fingerprint unknown (${current.reason})`,
      verified: false,
    };
  }
  return current.value === content.startFingerprint
    ? { state: 'live', pid, why: 'same process', verified: true }
    : {
        state: 'dead',
        pid,
        why: 'pid was reused by another process',
        verified: false,
      };
}

/** What to tell an operator about a holder that blocks a start. */
function remedy(verdict: Verdict, breakLockCommand: string): string {
  const pid = verdict.pid ?? 'unknown';
  if (verdict.verified) {
    return `pid ${pid} is running as this instance's supervisor: stop it with SIGTERM to pid ${pid} or the control channel's stop request, then start again`;
  }
  if (verdict.state === 'live-pending') {
    return `the lock is still being written; if it stays this way, run: ${breakLockCommand} --force`;
  }
  return `pid ${pid} exists but its identity could not be verified (${verdict.why}). If it is not this instance's supervisor, run: ${breakLockCommand} --force`;
}

function create(path: string, content: LockContent): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(content));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

export async function acquireInstanceLock(options: {
  runDir: string;
  instance: string;
  /** This supervisor's control endpoint, recorded for diagnosis. */
  control: string;
  description: string;
  log: (message: string) => void;
  pendingGraceMs?: number;
  fingerprint?: (pid: number) => Promise<Fingerprint>;
  /** Test-only: delay between judging the holder and creating the next epoch. */
  testDelayMs?: number;
  /** The exact `--break-lock` command for this instance, for refusal messages. */
  breakLockCommand?: string;
}): Promise<InstanceLock> {
  const graceMs = options.pendingGraceMs ?? LOCK_PENDING_GRACE_MS;
  const fingerprint =
    options.fingerprint ?? ((pid: number) => processFingerprint(pid));
  const self = await fingerprint(process.pid);
  if (self.status !== 'ok') {
    options.log(
      'could not fingerprint this process; the lock will count as live while the pid exists',
    );
  }
  const nonce = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const highest = highestEpoch(options.runDir, options.instance);
    let next = 1;
    if (highest !== null) {
      if (highest >= MAX_EPOCH) {
        throw new SupervisorStartError(
          `instance lock epoch ${highest} is at its limit; clean ${options.runDir}`,
        );
      }
      const holder = epochPath(options.runDir, options.instance, highest);
      const verdict = await judge(holder, graceMs, fingerprint);
      const { state, pid, why } = verdict;
      if (state !== 'dead') {
        throw new SupervisorStartError(
          [
            `another supervisor (pid ${pid ?? 'unknown'}) holds ${options.description} (epoch ${highest}, ${state}: ${why}); refusing to start`,
            `  lock file: ${holder}`,
            `  ${remedy(verdict, options.breakLockCommand ?? 'station-supervisor --break-lock')}`,
          ]
            .map(printable)
            .join('\n'),
        );
      }
      options.log(
        `instance lock epoch ${highest} (pid ${pid ?? 'unknown'}) is dead (${why}); taking the next epoch`,
      );
      next = highest + 1;
    }
    if (options.testDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * (options.testDelayMs as number)),
      );
    }
    const path = epochPath(options.runDir, options.instance, next);
    const content: LockContent = {
      pid: process.pid,
      nonce,
      startFingerprint: self.status === 'ok' ? self.value : '',
      createdAt: Date.now(),
      control: options.control,
    };
    if (create(path, content)) return { epoch: next, nonce, path };
    // Another starter won epoch `next`; judge it on the next pass.
  }
  throw new SupervisorStartError(
    `could not take ${options.description} after repeated attempts`,
  );
}

/** True while `lock` is the highest epoch, still ours, and not released. */
export function stillHolds(
  lock: InstanceLock,
  runDir: string,
  instance: string,
): boolean {
  const content = readContent(lock.path);
  return (
    highestEpoch(runDir, instance) === lock.epoch &&
    content?.nonce === lock.nonce &&
    content.releasedAt === undefined
  );
}

/** Removes epoch files below ours; call only while holding the top epoch. */
export function collectOlderEpochs(
  lock: InstanceLock,
  runDir: string,
  instance: string,
): void {
  if (highestEpoch(runDir, instance) !== lock.epoch) return;
  for (const epoch of listEpochs(runDir, instance)) {
    if (epoch >= lock.epoch) continue;
    try {
      unlinkSync(epochPath(runDir, instance, epoch));
    } catch {
      // Gone already.
    }
  }
}

/**
 * Marks our epoch released (never deletes it, so epochs never go backwards),
 * and only while the file still holds our nonce and pid.
 */
export function releaseInstanceLock(lock: InstanceLock): void {
  const content = readContent(lock.path);
  if (!content || content.nonce !== lock.nonce || content.pid !== process.pid)
    return;
  if (content.releasedAt !== undefined) return;
  const temp = `${lock.path}.${process.pid}.release`;
  try {
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify({ ...content, releasedAt: Date.now() }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, lock.path);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Never created.
    }
  }
}

/**
 * The guarded way out of a fail-closed lock. Re-checks the holder: refuses a
 * holder that is live by a known fingerprint; requires `force` for one whose
 * identity cannot be verified (or a lock still being written); otherwise
 * marks the top epoch released with a reason. Never deletes an epoch.
 */
export async function breakInstanceLock(options: {
  runDir: string;
  instance: string;
  force: boolean;
  reason: string;
  breakLockCommand: string;
  fingerprint?: (pid: number) => Promise<Fingerprint>;
  commandLine?: (pid: number) => Promise<string>;
}): Promise<{ code: number; message: string }> {
  let highest: number | null;
  try {
    highest = highestEpoch(options.runDir, options.instance);
  } catch {
    highest = null;
  }
  if (highest === null)
    return { code: 0, message: 'no instance lock to break' };
  const path = epochPath(options.runDir, options.instance, highest);
  const verdict = await judge(
    path,
    LOCK_PENDING_GRACE_MS,
    options.fingerprint ?? ((pid: number) => processFingerprint(pid)),
  );
  if (verdict.why === 'released') {
    return {
      code: 0,
      message: `instance lock epoch ${highest} is already released`,
    };
  }
  if (verdict.verified) {
    return {
      code: 1,
      message: printable(
        `refusing to break the lock: ${remedy(verdict, options.breakLockCommand)} (lock file: ${path})`,
      ),
    };
  }
  if (verdict.state !== 'dead' && !options.force) {
    const command =
      verdict.pid !== null
        ? await (options.commandLine ?? processCommandLine)(verdict.pid)
        : 'unknown';
    return {
      code: 1,
      message: [
        `refusing to break the lock without --force: ${remedy(verdict, options.breakLockCommand)}`,
        `  lock file: ${path}`,
        `  holder command line: ${redactCommandLine(command)}`,
      ]
        .map(printable)
        .join('\n'),
    };
  }
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    content = {};
  }
  const temp = `${path}.${process.pid}.break`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(
      fd,
      JSON.stringify({
        ...content,
        releasedAt: Date.now(),
        releasedBy: 'break-lock',
        releaseReason: options.reason,
      }),
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } finally {
    // On success the temp name is gone already; on failure, never leave it behind.
    try {
      unlinkSync(temp);
    } catch {
      // Renamed, or never there.
    }
  }
  return {
    code: 0,
    message: `marked instance lock epoch ${highest} released (${verdict.state === 'dead' ? verdict.why : `forced: ${verdict.why}`})`,
  };
}

/** Quotes `value` as one shell word: POSIX single quotes, or Windows double quotes. */
function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The exact break-lock command for an instance, safe to paste into a shell. */
export function breakLockCommandFor(home: string, instance: string): string {
  return `station-supervisor --break-lock --home ${shellQuote(home)} --instance ${instance}`;
}

/** Removes control characters (keeping the newlines that separate message lines). */
function printable(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!control || char === '\n') out += char;
  }
  return out;
}

/**
 * Only the executable's basename and its first argument: later arguments may
 * carry secrets (tokens, keys) that must not reach logs or terminals.
 */
function redactCommandLine(commandLine: string): string {
  const trimmed = printable(commandLine).trim();
  if (trimmed === '' || trimmed === 'unknown') return 'unknown';
  const words: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (
    let match = pattern.exec(trimmed);
    match && words.length < 2;
    match = pattern.exec(trimmed)
  ) {
    words.push(match[1] ?? match[2] ?? '');
  }
  const executable = (words[0] ?? '').split(/[\\/]/).at(-1) ?? '';
  return [executable, words[1]].filter(Boolean).join(' ');
}
