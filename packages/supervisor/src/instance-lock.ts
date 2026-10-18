/**
 * One supervisor per (home, instance), by lock epochs.
 *
 * Why this is correct, without parsing `ps` or racing renames:
 *
 * - Epochs. Lock files are `<run>/instance-<instance>.lock.<n>`, only ever
 *   created with `wx`, never renamed or rewritten. The OS lets exactly one
 *   process create a given n, so every epoch has exactly one winner. The
 *   current lock is the highest n present.
 * - Acquire. Read the highest n. With none, create n=1. If its holder is LIVE
 *   or LIVE-PENDING, refuse. If DEAD, create n+1; on EEXIST another starter
 *   won that epoch, so start over (and find its fresh lock LIVE-PENDING).
 * - Liveness. LIVE: the holder's control endpoint (recorded in the lock, so
 *   `--control` cannot hide it) answers `lock.probe{challenge}` with
 *   HMAC(nonce, challenge); the nonce never crosses the wire. A connection
 *   that is accepted but not answered in time, or fails for a reason other
 *   than "nothing listening", also counts as LIVE: fail closed. LIVE-PENDING:
 *   not proved, but the pid exists and the lock is younger than the pending
 *   grace, which covers a winner that has not bound its socket yet. DEAD:
 *   everything else, including a reused pid on a lock older than the grace.
 * - Ordering. The epoch winner binds its control socket next (only an epoch
 *   winner may unlink a stale socket, and the bind still refuses a live
 *   listener), then re-reads the highest epoch and refuses unless it is still
 *   its own. Only then does it publish the token, reap, and serve. If a slow
 *   winner was judged DEAD after the grace and a later epoch was created, the
 *   older winner sees the later epoch here and steps down; the later winner's
 *   bind refuses while the older one still listens. The worst case is that
 *   both refuse, never that both serve.
 * - Release. Delete only your own epoch file, and only if it still holds
 *   your nonce. The winner collects older epoch files.
 *
 * On Windows the named pipe is also exclusive at the OS level; the epochs keep
 * the scheme and the nonce probe uniform across platforms.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { encodeLine, isRecord, NdjsonDecoder } from './ndjson.ts';

export class SupervisorStartError extends Error {}

const LOCK_PENDING_GRACE_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_EPOCH = 1_000_000_000;

interface LockContent {
  pid: number;
  nonce: string;
  createdAt: number;
  control: string;
}

export interface InstanceLock {
  epoch: number;
  nonce: string;
  path: string;
}

type ProbeResult = 'proved' | 'not-proved' | 'no-listener' | 'unanswered';
type HolderState = 'live' | 'live-pending' | 'dead';

export function lockProof(nonce: string, challenge: string): string {
  return createHmac('sha256', Buffer.from(nonce, 'hex'))
    .update(challenge)
    .digest('hex');
}

function epochPattern(instance: string): RegExp {
  const escaped = instance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^instance-${escaped}\\.lock\\.(\\d+)$`);
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
    .filter((n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_EPOCH);
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
      /^[0-9a-f]{32}$/.test(parsed.nonce) &&
      typeof parsed.createdAt === 'number' &&
      typeof parsed.control === 'string'
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

/** Asks the endpoint to prove it knows `nonce`, without sending the nonce. */
function probe(
  control: string,
  nonce: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const challenge = randomBytes(32).toString('hex');
    const expected = Buffer.from(lockProof(nonce, challenge), 'hex');
    const socket = createConnection(control);
    const decoder = new NdjsonDecoder(64 * 1024);
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('unanswered'), timeoutMs);
    socket.on('connect', () =>
      socket.write(encodeLine({ type: 'lock.probe', challenge })),
    );
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // Only "nothing is listening there" is evidence of death; anything else fails closed.
      finish(
        error.code === 'ECONNREFUSED' || error.code === 'ENOENT'
          ? 'no-listener'
          : 'unanswered',
      );
    });
    socket.on('close', () => finish('not-proved'));
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const line of decoder.push(chunk)) {
          const message = JSON.parse(line) as unknown;
          if (
            isRecord(message) &&
            message.type === 'lock.proof' &&
            typeof message.proof === 'string' &&
            /^[0-9a-f]{64}$/.test(message.proof) &&
            timingSafeEqual(Buffer.from(message.proof, 'hex'), expected)
          ) {
            finish('proved');
          } else {
            finish('not-proved');
          }
          return;
        }
      } catch {
        finish('not-proved');
      }
    });
  });
}

async function judge(
  path: string,
  graceMs: number,
  probeTimeoutMs: number,
): Promise<{ state: HolderState; pid: number | null }> {
  const content = readContent(path);
  if (!content) {
    // A winner between `wx` and its write, or a crash in between: judge by age.
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Date.now() - statSync(path).mtimeMs;
    } catch {
      return { state: 'dead', pid: null };
    }
    return { state: ageMs < graceMs ? 'live-pending' : 'dead', pid: null };
  }
  const result = await probe(content.control, content.nonce, probeTimeoutMs);
  if (result === 'proved' || result === 'unanswered')
    return { state: 'live', pid: content.pid };
  const young = Date.now() - content.createdAt < graceMs;
  if (young && pidExists(content.pid))
    return { state: 'live-pending', pid: content.pid };
  return { state: 'dead', pid: content.pid };
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
  /** This supervisor's control endpoint, where it will answer probes. */
  control: string;
  description: string;
  log: (message: string) => void;
  pendingGraceMs?: number;
  probeTimeoutMs?: number;
  /** Test-only: delay between judging the holder and creating the next epoch. */
  testDelayMs?: number;
}): Promise<InstanceLock> {
  const graceMs = options.pendingGraceMs ?? LOCK_PENDING_GRACE_MS;
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
      const { state, pid } = await judge(
        holder,
        graceMs,
        options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      );
      if (state !== 'dead') {
        throw new SupervisorStartError(
          `another supervisor (pid ${pid ?? 'unknown'}) holds ${options.description} (epoch ${highest}, ${state}); refusing to start`,
        );
      }
      options.log(
        `instance lock epoch ${highest} (pid ${pid ?? 'unknown'}) is dead; taking the next epoch`,
      );
      next = highest + 1;
    }
    if (options.testDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * (options.testDelayMs as number)),
      );
    }
    const path = epochPath(options.runDir, options.instance, next);
    if (
      create(path, {
        pid: process.pid,
        nonce,
        createdAt: Date.now(),
        control: options.control,
      })
    ) {
      return { epoch: next, nonce, path };
    }
    // Another starter won epoch `next`; judge it on the next pass.
  }
  throw new SupervisorStartError(
    `could not take ${options.description} after repeated attempts`,
  );
}

/** True while `lock` is still the highest epoch and still holds our nonce. */
export function stillHolds(
  lock: InstanceLock,
  runDir: string,
  instance: string,
): boolean {
  return (
    highestEpoch(runDir, instance) === lock.epoch &&
    readContent(lock.path)?.nonce === lock.nonce
  );
}

/** Removes epoch files older than ours. */
export function collectOlderEpochs(
  lock: InstanceLock,
  runDir: string,
  instance: string,
): void {
  for (const epoch of listEpochs(runDir, instance)) {
    if (epoch >= lock.epoch) continue;
    try {
      unlinkSync(epochPath(runDir, instance, epoch));
    } catch {
      // Gone already.
    }
  }
}

/** Deletes our own epoch file, and only while it still holds our nonce. */
export function releaseInstanceLock(lock: InstanceLock): void {
  if (readContent(lock.path)?.nonce !== lock.nonce) return;
  try {
    unlinkSync(lock.path);
  } catch {
    // Gone already.
  }
}
