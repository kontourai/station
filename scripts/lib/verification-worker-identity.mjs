import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROBE_TIMEOUT_MS = 250;
const LAUNCH_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

function bootIdentity({ platform, readFile, spawn }) {
  try {
    if (platform === 'linux') {
      return readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    }
    if (platform === 'darwin') {
      const result = spawn('sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      return result.status === 0 ? result.stdout.trim() || null : null;
    }
  } catch {
    // Identity is unavailable; recovery must fail closed.
  }
  // Windows process-birth identity has not received runtime proof. Do not
  // infer it from PID liveness or attempt recovery there.
  return null;
}

function linuxProcessBirth(pid, readFile) {
  try {
    const stat = readFile(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return null;
    // Field 3 begins after the command's closing paren; starttime is field 22.
    // Using the final paren accepts process names that contain parentheses.
    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/);
    const starttime = fields[19];
    return /^\d+$/.test(starttime)
      ? { pid, token: `linux:${starttime}` }
      : null;
  } catch {
    return null;
  }
}

function darwinProcessBirth(pid, launchToken, spawn) {
  if (!LAUNCH_TOKEN_PATTERN.test(launchToken ?? '')) return null;
  try {
    const result = spawn('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const expected = `--verification-launch-token=${launchToken}`;
    const matches = result.stdout.match(
      new RegExp(`(?:^|\\s)${expected}(?=\\s|$)`, 'g'),
    );
    return matches?.length === 1
      ? { pid, token: `launch:${launchToken}` }
      : false;
  } catch {
    return null;
  }
}

function processBirth({ pid, platform, readFile, spawn, kill, launchToken }) {
  if (!Number.isInteger(pid) || pid < 1) return { status: 'unavailable' };
  try {
    kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return { status: 'dead' };
    return { status: 'unavailable' };
  }
  if (platform === 'darwin') {
    const process = darwinProcessBirth(pid, launchToken, spawn);
    return process === null
      ? { status: 'unavailable' }
      : process
        ? { status: 'live', process }
        : { status: 'live', process: { pid, token: 'launch:mismatch' } };
  }
  // #1658 keeps Windows fail-closed. It may not use formatted `ps` output.
  if (platform !== 'linux') return { status: 'unavailable' };
  const process = linuxProcessBirth(pid, readFile);
  return process ? { status: 'live', process } : { status: 'unavailable' };
}

/**
 * Produces an identity probe with one cached host boot lookup. The returned
 * probe distinguishes an observed dead PID (`process: null`) from unavailable
 * process inspection (`process: undefined`), so callers never steal on
 * uncertainty while still retaining a boot mismatch recovery signal.
 */
export function createWorkerIdentityProbe({
  platform = process.platform,
  readFile = readFileSync,
  spawn = spawnSync,
  kill = process.kill,
} = {}) {
  let cachedBootId;
  let bootIdentityRead = false;
  return (pid = process.pid, launchToken) => {
    if (!bootIdentityRead) {
      cachedBootId = bootIdentity({ platform, readFile, spawn });
      bootIdentityRead = true;
    }
    if (!cachedBootId) return null;
    const observed = processBirth({
      pid,
      platform,
      readFile,
      spawn,
      kill,
      launchToken,
    });
    return {
      bootId: cachedBootId,
      process:
        observed.status === 'dead'
          ? null
          : observed.status === 'live'
            ? observed.process
            : undefined,
    };
  };
}

export const currentWorkerIdentity = createWorkerIdentityProbe();

export function classifyCoordinatingWorker(
  worker,
  probe = currentWorkerIdentity,
) {
  if (!worker?.identity?.bootId) return 'ambiguous';
  let observed;
  try {
    observed = probe(worker.pid, worker.launchToken);
  } catch {
    return 'ambiguous';
  }
  if (!observed?.bootId) return 'ambiguous';
  if (observed.bootId !== worker.identity.bootId) return 'recoverable';
  if (observed.process === null) return 'recoverable';
  if (!worker.identity.process?.token || !observed.process?.token)
    return 'ambiguous';
  if (observed.process.token !== worker.identity.process.token)
    return 'recoverable';
  return 'live';
}
