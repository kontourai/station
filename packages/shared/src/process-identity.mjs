import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Keep this small and plain-JS so the verification scripts can use the exact
// same probe when they are launched by node rather than tsx.
export const PROCESS_BIRTH_FINGERPRINT_TIMEOUT_MS = 1_500;
export const WINDOWS_OWN_PROCESS_BIRTH_FIRST_TIMEOUT_MS = 10_000;
/** @deprecated Use WINDOWS_OWN_PROCESS_BIRTH_FIRST_TIMEOUT_MS. */
export const WINDOWS_OWN_PROCESS_BIRTH_TIMEOUT_MS =
  WINDOWS_OWN_PROCESS_BIRTH_FIRST_TIMEOUT_MS;
export const WINDOWS_OWN_PROCESS_BIRTH_RETRY_TIMEOUT_MS = 20_000;
export const WINDOWS_OWN_PROCESS_BIRTH_ATTEMPTS = 2;
export const WINDOWS_OWN_PROCESS_BIRTH_RETRY_DELAY_MS = 250;
export const WINDOWS_OWN_PROCESS_BIRTH_DEADLINE_MS =
  WINDOWS_OWN_PROCESS_BIRTH_FIRST_TIMEOUT_MS +
  WINDOWS_OWN_PROCESS_BIRTH_RETRY_DELAY_MS +
  WINDOWS_OWN_PROCESS_BIRTH_RETRY_TIMEOUT_MS;

// The Windows Job guard derives this exact representation from GetProcessTimes.
// Keep the process-identity authority equally strict and normalize the same
// 100ns FILETIME ticks to microsecond precision before comparison.
const WINDOWS_ROUND_TRIP_UTC_ISO =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{7}Z$/;

function isWindowsRoundTripUtcIso(value) {
  const match = WINDOWS_ROUND_TRIP_UTC_ISO.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

function windowsCreationDateCommand(pid) {
  // System.Diagnostics.Process.StartTime reads the process handle directly;
  // unlike Win32_Process through CIM, it does not depend on an eventually
  // visible management projection for the coordinator's newly started PID.
  // The guard truncates GetProcessTimes FILETIME to microseconds, so do the
  // identical tick normalization here before emitting its canonical format.
  return [
    `$process = [System.Diagnostics.Process]::GetProcessById(${pid})`,
    'try { $created = $process.StartTime.ToUniversalTime() } finally { $process.Dispose() }',
    '$ticks = $created.Ticks - ($created.Ticks % 10)',
    '$normalized = [datetime]::new([long]$ticks, [System.DateTimeKind]::Utc)',
    "$normalized.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ', [System.Globalization.CultureInfo]::InvariantCulture)",
  ].join('; ');
}

function windowsCreationDateProbe(
  pid,
  timeoutMs = PROCESS_BIRTH_FINGERPRINT_TIMEOUT_MS,
  command = 'powershell.exe',
) {
  return {
    command,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsCreationDateCommand(pid),
    ],
    options: {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    },
  };
}

function canonicalWindowsCreationDate(output) {
  const value = typeof output === 'string' ? output.trim() : '';
  return isWindowsRoundTripUtcIso(value) ? value : null;
}

function windowsCreationDateFingerprint(pid, exec, timeoutMs, shell) {
  const { command, args, options } = windowsCreationDateProbe(
    pid,
    timeoutMs,
    shell,
  );
  const output = exec(command, args, options);
  return canonicalWindowsCreationDate(output);
}

async function windowsCreationDateFingerprintAsync(pid, exec, timeoutMs) {
  const { command, args, options } = windowsCreationDateProbe(pid, timeoutMs);
  const output = await exec(command, args, options);
  return canonicalWindowsCreationDate(output);
}

/**
 * Does a recorded birth fingerprint PROVE this pid was reused?
 *
 * The single comparison seam for every birth-aware liveness check. Fail-open
 * by construction: `lookupProcessBirthFingerprint` returns NULL on any
 * failure (probe error, timeout, empty output) — it never returns undefined —
 * so callers comparing against `undefined` were fail-CLOSED: a transient `ps`
 * timeout under load read a LIVE instance as pid-reused. Absence of proof of
 * reuse is not proof of reuse.
 */
export function birthProvesReuse(recordedBirth, pid, dependencies = {}) {
  if (typeof recordedBirth !== 'string' || recordedBirth.length === 0)
    return false;
  const observed = lookupProcessBirthFingerprint(pid, dependencies);
  if (observed == null) return false;
  return observed !== recordedBirth;
}

/**
 * TTL for the pid → birth-fingerprint cache (#2646). Deliberately short: the
 * only way a cached fingerprint can be WRONG is a pid being recycled within
 * the TTL — which is the exact race the fingerprint exists to close, already
 * bounded on macOS by `ps -o lstart=`'s 1-second resolution (see the #1863
 * note above `lookupProcessBirthFingerprint`). The lock code additionally
 * re-probes with `fresh: true` before acting on any cached MISMATCH, so a
 * stale cache entry can only ever bias toward "owner still alive" (fail-safe:
 * no reclaim), never toward reclaiming a live owner's lock.
 */
export const PROCESS_BIRTH_FINGERPRINT_CACHE_TTL_MS = 2_000;

function aliveState(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return 'alive';
  } catch (error) {
    // Only ESRCH proves absence. EPERM and every other probe failure are
    // live-or-ambiguous, never authorization to reclaim an owner.
    return error?.code === 'ESRCH' ? 'dead' : 'unavailable';
  }
}

/**
 * Resolve a process birth fingerprint for reuse detection.
 *
 * station#1863 M5 disclosure (macOS): `ps -o lstart=` reports a start time
 * at 1-SECOND resolution. Two processes born in the same calendar second that
 * share a recycled pid produce an IDENTICAL fingerprint, so the reuse detector
 * cannot distinguish them. This is narrow (requires a pid recycle within the
 * same second) and not closable without a pidfd-equivalent on macOS, but it
 * means the fingerprint is a strong signal, not a cryptographic guarantee.
 * Linux (`/proc/<pid>/stat` field 22 + boot_id) does not have this limit.
 */
export function lookupProcessBirthFingerprint(pid, dependencies = {}) {
  const {
    platform = process.platform,
    exec = execFileSync,
    readFile = readFileSync,
    timeoutMs,
  } = dependencies;
  try {
    if (platform === 'win32') {
      return windowsCreationDateFingerprint(
        pid,
        exec,
        timeoutMs,
        dependencies.windowsShell,
      );
    }
    if (platform === 'linux') {
      const stat = readFile(`/proc/${pid}/stat`, 'utf8').trim();
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 2) return null;
      const fieldsAfterCommand = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/);
      const startTime = fieldsAfterCommand[19];
      const bootId = readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (!/^\d+$/.test(startTime ?? '') || !bootId) return null;
      return `linux:${bootId}:${startTime}`;
    }
    return (
      exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: PROCESS_BIRTH_FINGERPRINT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        // LC_ALL=C + TZ=UTC: `lstart` output is locale-shaped AND
        // timezone-shaped ("Mon Aug 17 07:25" under TZ=local vs "13:25" under
        // TZ=UTC — both probed live on the same process). A writer and reader
        // under different env (terminal vs launchd vs container, routinely)
        // would mismatch the SAME live process and read it as pid reuse.
        // Both pinned; only with both is the fingerprint a property of the
        // process rather than of who asked. (Review caught that the first
        // version pinned locale, claimed the property, and left TZ — the
        // claim-without-derivation defect, inside the comment written to
        // close it.)
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function defaultExecFileAsync(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(stdout);
    });
  });
}

/**
 * Async twin of `lookupProcessBirthFingerprint` (#2646): identical platform
 * probes and identical null semantics, but the child-process probe uses the
 * callback `execFile` so a caller on the server's event loop is not blocked
 * for up to `PROCESS_BIRTH_FINGERPRINT_TIMEOUT_MS` per lookup. The Linux path
 * stays a synchronous procfs read — no child process is involved and the read
 * is microseconds.
 */
export async function lookupProcessBirthFingerprintAsync(
  pid,
  dependencies = {},
) {
  const {
    platform = process.platform,
    exec = defaultExecFileAsync,
    readFile = readFileSync,
    timeoutMs,
  } = dependencies;
  try {
    if (platform === 'win32') {
      return await windowsCreationDateFingerprintAsync(pid, exec, timeoutMs);
    }
    if (platform === 'linux') {
      return lookupProcessBirthFingerprint(pid, { platform, readFile });
    }
    const stdout = await exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: PROCESS_BIRTH_FINGERPRINT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      // LC_ALL=C + TZ=UTC — same pinning as the sync path; see there.
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// pid → { birth, expiresAt }. Shared by the sync and async cached lookups so
// a fingerprint resolved on either path serves both. Only NON-NULL results
// are cached: a null is ambiguous (dead pid vs. a `ps` deadline miss under
// load, #1057) and callers deliberately retry it.
const birthFingerprintCache = new Map();
// pid → in-flight Promise, so N concurrent async probes for one pid spawn one
// child process instead of N.
const birthFingerprintInFlight = new Map();

/** Test seam: drop every cached fingerprint and in-flight probe. */
export function clearProcessBirthFingerprintCache() {
  birthFingerprintCache.clear();
  birthFingerprintInFlight.clear();
}

function readBirthCache(pid, now) {
  const hit = birthFingerprintCache.get(pid);
  if (hit && hit.expiresAt > now) return hit.birth;
  return undefined;
}

function storeBirthCache(pid, birth, now, ttlMs) {
  if (birth) birthFingerprintCache.set(pid, { birth, expiresAt: now + ttlMs });
  else birthFingerprintCache.delete(pid);
}

/**
 * TTL-cached `lookupProcessBirthFingerprint` (#2646): a contested lock
 * acquisition performs several liveness checks per retry iteration per claim,
 * and each one used to spawn `ps`/PowerShell synchronously on the server's
 * event loop. Pass `fresh: true` to bypass (and refresh) the cache — the lock
 * code does this before treating a cached MISMATCH as a dead owner, so cache
 * staleness can never cause a live owner's lock to be reclaimed.
 *
 * Injection caveat: results land in the ONE module-global cache regardless of
 * which `dependencies` produced them — an injected `exec`/`platform` result
 * for a pid is served back to later callers using the real probes (and vice
 * versa) within the TTL. Test seams must use disjoint pids or clear the cache.
 */
export function lookupProcessBirthFingerprintCached(pid, dependencies = {}) {
  const now = (dependencies.now ?? Date.now)();
  const ttlMs = dependencies.ttlMs ?? PROCESS_BIRTH_FINGERPRINT_CACHE_TTL_MS;
  if (!dependencies.fresh) {
    const cached = readBirthCache(pid, now);
    if (cached !== undefined) return cached;
  }
  const birth = lookupProcessBirthFingerprint(pid, dependencies);
  storeBirthCache(pid, birth, now, ttlMs);
  return birth;
}

/** Async twin of `lookupProcessBirthFingerprintCached`; same cache, same TTL. */
export function lookupProcessBirthFingerprintCachedAsync(
  pid,
  dependencies = {},
) {
  const now = (dependencies.now ?? Date.now)();
  const ttlMs = dependencies.ttlMs ?? PROCESS_BIRTH_FINGERPRINT_CACHE_TTL_MS;
  if (!dependencies.fresh) {
    const cached = readBirthCache(pid, now);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = birthFingerprintInFlight.get(pid);
    if (pending) return pending;
  }
  const probe = lookupProcessBirthFingerprintAsync(pid, dependencies)
    .then((birth) => {
      storeBirthCache(pid, birth, (dependencies.now ?? Date.now)(), ttlMs);
      return birth;
    })
    .finally(() => {
      if (birthFingerprintInFlight.get(pid) === probe) {
        birthFingerprintInFlight.delete(pid);
      }
    });
  if (!dependencies.fresh) birthFingerprintInFlight.set(pid, probe);
  return probe;
}

/**
 * A three-way exact process probe. In particular, a live Windows PID whose
 * round-trip UTC process creation time cannot be read is unavailable, never dead:
 * callers must retain the fence rather than reclaiming a possibly-live owner.
 */
function probeExactProcessIdentityOnce(pid, dependencies) {
  if (!Number.isInteger(pid) || pid < 1) return { state: 'dead' };
  const alive =
    dependencies.alive ??
    ((candidate) => aliveState(candidate, dependencies.kill));
  const liveness = alive(pid);
  if (liveness === 'dead') return { state: 'dead' };
  if (liveness !== 'alive') return { state: 'unavailable' };
  const lookup = dependencies.lookup ?? lookupProcessBirthFingerprint;
  const birth = dependencies.lookup ? lookup(pid) : lookup(pid, dependencies);
  if (!birth) return { state: 'unavailable' };
  return { state: 'exact', identity: { pid, start: birth } };
}

/**
 * Observe an arbitrary process once. Claimant/reclaim decisions deliberately
 * do not retry: an unavailable birth must retain the existing fence rather
 * than spend more synchronous probe time while deciding whether to take it.
 */
export function probeExactProcessIdentity(pid, dependencies = {}) {
  return probeExactProcessIdentityOnce(pid, dependencies);
}

/**
 * Resolve this coordinator's own process identity before it publishes a new
 * lease. The same direct handle authority is used for owner publication and
 * later claimant/reclaim comparison; no PID-only or timing fallback exists.
 */
export function resolveOwnProcessIdentity(pid, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const attempts =
    platform === 'win32' ? WINDOWS_OWN_PROCESS_BIRTH_ATTEMPTS : 1;
  const deadlineMs =
    dependencies.deadlineMs ?? WINDOWS_OWN_PROCESS_BIRTH_DEADLINE_MS;
  const retryDelayMs =
    dependencies.retryDelayMs ?? WINDOWS_OWN_PROCESS_BIRTH_RETRY_DELAY_MS;
  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    ((milliseconds) =>
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
        0,
        0,
        milliseconds,
      ));
  const startedAt = now();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remainingMs =
      attempt === 0 ? deadlineMs : deadlineMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    const scheduledTimeoutMs =
      dependencies.timeoutMs ??
      (attempt === 0
        ? WINDOWS_OWN_PROCESS_BIRTH_FIRST_TIMEOUT_MS
        : WINDOWS_OWN_PROCESS_BIRTH_RETRY_TIMEOUT_MS);
    const probe = probeExactProcessIdentityOnce(pid, {
      ...dependencies,
      // A legacy PowerShell startup failure should not consume both attempts
      // on the same host. PowerShell 7 reads the identical direct handle and
      // emits the same normalized timestamp within the existing deadline.
      windowsShell: attempt === 0 ? 'powershell.exe' : 'pwsh.exe',
      timeoutMs: Math.min(scheduledTimeoutMs, remainingMs),
    });
    if (probe.state !== 'unavailable' || attempt === attempts - 1) {
      return probe;
    }
    // This path observes only the coordinator's own still-running process.
    // Retrying the same direct process-handle authority survives a transient
    // PowerShell startup timeout without ever publishing PID-only ownership.
    const remainingAfterProbeMs = deadlineMs - (now() - startedAt);
    if (remainingAfterProbeMs <= 0) break;
    wait(Math.min(retryDelayMs, remainingAfterProbeMs));
  }

  return { state: 'unavailable' };
}

export function exactProcessIdentity(pid, dependencies = {}) {
  const probe = probeExactProcessIdentity(pid, dependencies);
  return probe.state === 'exact' ? probe.identity : null;
}

/**
 * Async twin of `probeExactProcessIdentity` (station#3441 MEDIUM-2): identical
 * three-state result and identical `alive`-then-`birth` composition, but the
 * birth-fingerprint half runs through `lookupProcessBirthFingerprintAsync` so
 * a caller on the server's event loop is not blocked by the child-process
 * probe. The `alive` half stays a synchronous `kill(pid, 0)` either way — it
 * is a signal check, not a child process, and is not the blocking cost this
 * exists to remove.
 */
export async function probeExactProcessIdentityAsync(pid, dependencies = {}) {
  if (!Number.isInteger(pid) || pid < 1) return { state: 'dead' };
  const alive =
    dependencies.alive ??
    ((candidate) => aliveState(candidate, dependencies.kill));
  const liveness = alive(pid);
  if (liveness === 'dead') return { state: 'dead' };
  if (liveness !== 'alive') return { state: 'unavailable' };
  const birth = await (
    dependencies.lookup ?? lookupProcessBirthFingerprintAsync
  )(pid);
  if (!birth) return { state: 'unavailable' };
  return { state: 'exact', identity: { pid, start: birth } };
}
