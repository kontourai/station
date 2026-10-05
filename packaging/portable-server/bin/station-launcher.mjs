// Station's fixed service launcher (#2675 slice D, launcher protocol 1).
//
// `station service install` copies this file from an installed archive to
// `<install root>/runtime/station-launcher.mjs`, and the service unit runs it
// with the active version's Node.js. It stays there across updates: it is the
// one process of a service that outlives every version, so it depends on
// nothing but Node.js built-ins and on no Station version being loadable.
//
// It runs one versioned child, `versions/<v>/bin/station.mjs service run`,
// and owns the update transaction that swaps it, recorded in
// `runtime/service-state.json`, the single authority for which version the
// service runs:
//
//   persist pending -> stop the old child (>= 65 s, then its own `stop`)
//     -> back up the home once (the old version's own code)
//     -> start the new version as a trial (>= 240 s to report prepared)
//     -> commit, or restore the backup and restart the old version
//
// Every step is idempotent, so a launcher that is killed after any durable
// write finishes the transaction when it starts again; a trial gets at most
// two attempts before the update is rolled back. Downloading and verifying a
// release happen in the versioned child (its install.sh), so no verifier or
// signing key is frozen here: the launcher only checks that a version's
// completion sentinel is present.
//
// Station's topology shapes it: the child is a supervisor whose server runs
// detached, the home snapshot is Station's store registry (run with the
// version's own code), and update requests arrive from the server as a file
// the child picks up, since the server has no channel to this process.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER_PROTOCOL = 1;
const LAUNCHER_ENV = 'STATION_SERVICE_LAUNCHER';
const SERVICE_STATE_FILE = 'service-state.json';
const SERVICE_STATE_LOCK = 'service-state.lock';
const VERSION_SENTINEL = '.station-install-complete';

/**
 * Production timings. `service run` gives its detached server and UI 60 s to
 * stop, so the launcher waits longer before it kills the child; startup
 * readiness legitimately extends to 180 s, so a trial gets 240 s to report
 * that it is ready. A service manager's stop timeout must cover
 * STOP_GRACE_MS + OWN_STOP_TIMEOUT_MS (service-command.ts).
 */
// Exported for service-launcher.test.ts, which pins the production values.
// fallow-ignore-next-line unused-export
export const DEFAULT_TIMINGS = Object.freeze({
  stopGraceMs: 65_000,
  ownStopTimeoutMs: 60_000,
  handoffAckMs: 15_000,
  preparedTimeoutMs: 240_000,
  homeSnapshotTimeoutMs: 30 * 60_000,
  // Self-supervision (see selfSupervised): the first relaunch waits what
  // systemd's RestartSec=5 does, each further one twice as long up to a
  // minute, and a run that lasted ten minutes starts the backoff over.
  relaunchDelayMs: 5_000,
  relaunchMaxDelayMs: 60_000,
  relaunchResetMs: 10 * 60_000,
  parentPollMs: 1_000,
});
// Exported for service-launcher.test.ts, which pins the production values.
// fallow-ignore-next-line unused-export
export const MAX_TRIAL_ATTEMPTS = 2;
/**
 * Restores of one rollback before the launcher stops retrying on its own
 * (#2675 D review F4). Each failed restore exits the launcher and its service
 * manager starts it again; after this many the update is `needs-operator`
 * and the launcher waits, serving nothing, until someone restarts it.
 */
// Exported for service-launcher.test.ts, which pins the production values.
// fallow-ignore-next-line unused-export
export const MAX_RESTORE_ATTEMPTS = 3;

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

function log(message) {
  process.stderr.write(`[station-launcher] ${message}\n`);
}

/** Test seam: kill this process right after the named durable write. */
function crashPoint(name) {
  if (process.env.STATION_LAUNCHER_TEST_CRASH_AFTER === name) {
    process.kill(process.pid, 'SIGKILL');
  }
}

function timings() {
  const raw = process.env.STATION_LAUNCHER_TEST_TIMINGS;
  if (!raw) return DEFAULT_TIMINGS;
  return Object.freeze({ ...DEFAULT_TIMINGS, ...JSON.parse(raw) });
}

/**
 * Whether this launcher supervises itself (#2675 slice W3). systemd and
 * launchd restart a launcher that exits and stop it with a signal. Task
 * Scheduler does neither: it does not rerun a task whose program exits (with
 * its restart settings applied, a wrapper that exited 3 ran once in 100 s),
 * `schtasks /End` ends only the cmd.exe wrapper and leaves this process
 * running, and Windows has no SIGTERM (a child's `kill` is TerminateProcess).
 * So on Windows the launcher itself:
 *
 * - relaunches: where it would exit for its service manager to restart it
 *   (the active version exited, or a transition failed), it waits and starts
 *   over from service-state.json, exactly as a restarted launcher would;
 * - stops when its parent, the task's cmd.exe wrapper, is gone, which is
 *   how `schtasks /End` (and so `station service stop`) reaches it;
 * - stops its child by closing their IPC channel, which `service run`
 *   answers with its own orderly shutdown, instead of TerminateProcess.
 *
 * STATION_LAUNCHER_TEST_SELF_SUPERVISED=1 turns the same mode on elsewhere,
 * for tests that cannot run on Windows.
 */
function selfSupervised() {
  return (
    process.platform === 'win32' ||
    process.env.STATION_LAUNCHER_TEST_SELF_SUPERVISED === '1'
  );
}

// --- versions ---------------------------------------------------------------

/**
 * Station's release order, the one install.sh's downgrade check applies:
 * X.Y.Z, or X.Y.Z-<ring>.N within one ring, and a release outranks every
 * prerelease of its X.Y.Z. Null when the two cannot be ordered (another
 * ring's prerelease, or not a Station version at all).
 */
// Exported for service-launcher.test.ts, which pins the production values.
// fallow-ignore-next-line unused-export
export function compareVersions(left, right) {
  const shape =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([a-z]+)\.([1-9][0-9]*))?$/;
  const read = (version) => {
    const match = shape.exec(version);
    if (!match) return null;
    return {
      release: match.slice(1, 4).map(BigInt),
      ring: match[4] ?? null,
      build: match[5] === undefined ? null : BigInt(match[5]),
    };
  };
  const a = read(left);
  const b = read(right);
  if (!a || !b) return null;
  const order = (x, y) => (x === y ? 0 : x < y ? -1 : 1);
  for (let part = 0; part < 3; part += 1) {
    const result = order(a.release[part], b.release[part]);
    if (result !== 0) return result;
  }
  if (a.ring === b.ring) return a.ring === null ? 0 : order(a.build, b.build);
  if (a.ring === null) return 1;
  if (b.ring === null) return -1;
  return null;
}

function versionPaths(installRoot, version) {
  if (!VERSION_PATTERN.test(version))
    throw new Error(`invalid version: ${version}`);
  const dir = join(installRoot, 'versions', version);
  const windows = process.platform === 'win32';
  return {
    dir,
    node: join(dir, 'runtime', windows ? 'node.exe' : join('bin', 'node')),
    entry: join(dir, 'bin', 'station.mjs'),
    sentinel: join(dir, VERSION_SENTINEL),
  };
}

/** A version install.sh finished: its sentinel is the last thing it writes. */
function versionIsComplete(installRoot, version) {
  try {
    const paths = versionPaths(installRoot, version);
    return (
      readFileSync(paths.sentinel, 'utf8').trim() !== '' &&
      statSync(paths.entry).isFile() &&
      statSync(paths.node).isFile()
    );
  } catch {
    return false;
  }
}

// --- durable state ----------------------------------------------------------

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch (error) {
    // Windows cannot fsync a directory; NTFS journals the rename.
    if (error?.code !== 'EPERM' && error?.code !== 'EISDIR') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Renames a file or directory, retrying a refusal Windows gives while
 * another process (an antivirus scanner, the search indexer) briefly holds a
 * handle inside it: EPERM, EACCES or EBUSY, up to 10 tries 500 ms apart,
 * then the first error is thrown; any other error, and every error off
 * Windows, at once (#3363). packages/shared/src/fs-windows-compat.ts
 * `renamePathSyncRetrying`, ported (nothing of any version sits beside this
 * file); service-launcher.test.ts runs both over the same refusals.
 */
// Exported for service-launcher.test.ts (the parity pin).
// fallow-ignore-next-line unused-export
export function renamePathRetrying(source, destination, options = {}) {
  const platform = options.platform ?? process.platform;
  const attempts = options.attempts ?? 10;
  const rename = options.rename ?? renameSync;
  const wait =
    options.wait ??
    ((milliseconds) =>
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        milliseconds,
      ));
  let first;
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const transient =
        platform === 'win32' &&
        ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code ?? '');
      if (!transient) throw first ?? error;
      first ??= error;
      if (attempt >= attempts) throw first;
      wait(options.delayMs ?? 500);
    }
  }
}

function statePaths(installRoot) {
  const runtime = join(installRoot, 'runtime');
  return {
    runtime,
    state: join(runtime, SERVICE_STATE_FILE),
    lock: join(runtime, SERVICE_STATE_LOCK),
    backups: join(runtime, 'update-backups'),
  };
}

function validUpdate(update, activeVersion) {
  if (update === undefined) return true;
  if (!update || typeof update !== 'object') return false;
  const { id, fromVersion, targetVersion, status, attempts } = update;
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(id) ||
    typeof fromVersion !== 'string' ||
    !VERSION_PATTERN.test(fromVersion) ||
    typeof targetVersion !== 'string' ||
    !VERSION_PATTERN.test(targetVersion) ||
    !Number.isInteger(attempts) ||
    attempts < 0
  )
    return false;
  if (status === 'pending')
    return (
      fromVersion === activeVersion &&
      ['stopping', 'backing-up', 'trial', 'restoring'].includes(update.phase)
    );
  if (status === 'committed') return targetVersion === activeVersion;
  if (
    status === 'rolled-back' ||
    status === 'failed' ||
    status === 'needs-operator'
  )
    return fromVersion === activeVersion;
  return false;
}

function parseServiceState(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    value.protocol !== LAUNCHER_PROTOCOL ||
    typeof value.activeVersion !== 'string' ||
    !VERSION_PATTERN.test(value.activeVersion) ||
    !validUpdate(value.update, value.activeVersion)
  )
    return undefined;
  return value;
}

/** Same-directory write, fsync, rename, fsync: every transition's commit. */
function writeServiceState(installRoot, state) {
  const paths = statePaths(installRoot);
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  const temp = join(
    paths.runtime,
    `.${SERVICE_STATE_FILE}.${process.pid}.${randomUUID()}`,
  );
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renamePathRetrying(temp, paths.state);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  fsyncDirectory(paths.runtime);
}

function readServiceState(installRoot) {
  const paths = statePaths(installRoot);
  let text;
  try {
    text = readFileSync(paths.state, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const state = parseServiceState(text);
  if (!state) throw new Error(`${paths.state} is invalid or unsupported`);
  return state;
}

/** The version `current` names, for a service installed before a state existed. */
function versionFromCurrent(installRoot) {
  const current = join(installRoot, 'current');
  const target = realpathSync(current);
  if (dirname(target) !== realpathSync(join(installRoot, 'versions')))
    throw new Error(`${current} does not name an installed archive version`);
  return basename(target);
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const CURRENT_NEXT = 'current.next';

/**
 * Points `current` at a version. On POSIX a link renamed over `current`
 * replaces it atomically. Windows cannot rename over a directory junction,
 * so there `current` is removed and `current.next` renamed into its place,
 * and a launcher killed between the two leaves only `current.next`, which
 * `recoverCurrent` finishes. The Windows rule is install.ps1's
 * (packages/shared/src/installer/full-install.ts `pointCurrentAt`), ported
 * rather than imported, since nothing of any version sits beside this file;
 * service-launcher.test.ts runs both over the same cases.
 */
// Exported for service-launcher.test.ts (the parity pin with install.ps1).
// fallow-ignore-next-line unused-export
export function pointCurrentAt(
  installRoot,
  version,
  platform = process.platform,
) {
  const current = join(installRoot, 'current');
  const target = versionPaths(installRoot, version).dir;
  try {
    if (readlinkSync(current) === target) return;
  } catch {
    // Missing or not a link: replaced below.
  }
  if (platform === 'win32') {
    const next = join(installRoot, CURRENT_NEXT);
    if (isLink(next)) unlinkSync(next);
    // A junction needs no privilege, unlike a directory symlink.
    symlinkSync(target, next, 'junction');
    if (isLink(current)) unlinkSync(current);
    renamePathRetrying(next, current, { platform });
    fsyncDirectory(installRoot);
    return;
  }
  const pending = join(installRoot, `.current.${process.pid}.${randomUUID()}`);
  symlinkSync(target, pending);
  try {
    renameSync(pending, current);
  } catch (error) {
    rmSync(pending, { force: true });
    throw error;
  }
  fsyncDirectory(installRoot);
}

/**
 * Finishes a Windows switch a kill interrupted (see pointCurrentAt): with no
 * `current`, a `current.next` becomes it; with both, `current` stands and
 * the stale `current.next` goes. install.ps1's `recoverCurrent`, ported.
 */
// Exported for service-launcher.test.ts (the parity pin with install.ps1).
// fallow-ignore-next-line unused-export
export function recoverCurrent(installRoot, platform = process.platform) {
  const current = join(installRoot, 'current');
  const next = join(installRoot, CURRENT_NEXT);
  if (!isLink(next)) return;
  if (isLink(current) || existsSync(current)) unlinkSync(next);
  else renamePathRetrying(next, current, { platform });
}

// --- process identity -------------------------------------------------------

const BIRTH_PROBE_TIMEOUT_MS = 1_500;

function localAbsoluteDirectory(value) {
  return typeof value === 'string' &&
    win32.isAbsolute(value) &&
    !value.startsWith('\\\\')
    ? win32.normalize(value)
    : null;
}

/**
 * The PowerShell a birth probe runs, as packages/shared's
 * windows-system-utility.mjs resolves it: Windows PowerShell at its fixed
 * System32 path (a service manager's PATH may not carry it), or PowerShell 7
 * at %ProgramFiles%\PowerShell\7 when it is installed there, else by name.
 */
function windowsShell(kind) {
  const systemRoot = localAbsoluteDirectory(
    process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
  );
  if (kind === 'powershell') {
    return systemRoot
      ? win32.join(
          systemRoot,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        )
      : null;
  }
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles]
    .map(localAbsoluteDirectory)
    .filter(Boolean);
  roots.push(
    win32.join(win32.parse(systemRoot ?? 'C:\\Windows').root, 'Program Files'),
  );
  for (const root of new Set(roots)) {
    const candidate = win32.join(root, 'PowerShell', '7', 'pwsh.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'pwsh.exe';
}

/**
 * Own-birth attempts, the schedule packages/shared's process-identity.mjs
 * `ownProcessBirthProbeSchedule` and `resolveOwnProcessIdentity` give a cold
 * Windows start (#2746, #2830): Windows PowerShell for 10 s, 250 ms apart
 * from PowerShell 7 for 20 s. Off Windows, three short probes 100 ms apart.
 * All of it inside one overall deadline, the shared one.
 * service-launcher.test.ts pins the two schedules together.
 */
// Exported for service-launcher.test.ts (the parity pin).
// fallow-ignore-next-line unused-export
export function ownBirthSchedule(platform = process.platform) {
  const windows = platform === 'win32';
  return {
    retryDelayMs: windows ? 250 : 100,
    deadlineMs: 10_000 + 250 + 20_000,
    attempts: windows
      ? [
          { timeoutMs: 10_000, shell: 'powershell' },
          { timeoutMs: 20_000, shell: 'pwsh7' },
        ]
      : Array.from({ length: 3 }, () => ({
          timeoutMs: BIRTH_PROBE_TIMEOUT_MS,
          shell: 'powershell',
        })),
  };
}

/**
 * A process's start time, as packages/shared/src/process-identity.mjs's
 * `lookupProcessBirthFingerprint` spells it (same probes, same output, so a
 * birth either one records reads the same; service-launcher.test.ts pins the
 * two against each other). Ported, not imported: this file runs from
 * `<install root>/runtime/` with nothing of any Station version beside it.
 * Null when it cannot be read, which proves nothing.
 */
// Exported for service-launcher.test.ts (the parity pin) and install.sh.
// fallow-ignore-next-line unused-export
export function processBirth(
  pid,
  timeoutMs = BIRTH_PROBE_TIMEOUT_MS,
  shell = 'powershell',
) {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 2) return null;
      const startTime = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/)[19];
      const bootId = readFileSync(
        '/proc/sys/kernel/random/boot_id',
        'utf8',
      ).trim();
      if (!/^\d+$/.test(startTime ?? '') || !bootId) return null;
      return `linux:${bootId}:${startTime}`;
    }
    if (process.platform === 'win32') {
      const command = windowsShell(shell);
      if (!command) return null;
      const output = execFileSync(
        command,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          [
            `$process = [System.Diagnostics.Process]::GetProcessById(${Number(pid)})`,
            'try { $created = $process.StartTime.ToUniversalTime() } finally { $process.Dispose() }',
            '$ticks = $created.Ticks - ($created.Ticks % 10)',
            '$normalized = [datetime]::new([long]$ticks, [System.DateTimeKind]::Utc)',
            "$normalized.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ', [System.Globalization.CultureInfo]::InvariantCulture)",
          ].join('; '),
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
        },
      ).trim();
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(output)
        ? output
        : null;
    }
    return (
      execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        // The start time must not depend on who asks (locale, zone).
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** This process's own start time; it is certainly alive, so retried. */
function ownBirth() {
  const { attempts, retryDelayMs, deadlineMs } = ownBirthSchedule();
  const startedAt = Date.now();
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const remainingMs = deadlineMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    const { timeoutMs, shell } = attempts[attempt];
    const birth = processBirth(
      process.pid,
      Math.min(timeoutMs, remainingMs),
      shell,
    );
    if (birth) return birth;
    if (attempt === attempts.length - 1) break;
    const pause = Math.min(retryDelayMs, deadlineMs - (Date.now() - startedAt));
    if (pause <= 0) break;
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      0,
      0,
      pause,
    );
  }
  return null;
}

/** Only ESRCH proves a process is gone; EPERM is a live process. */
function processState(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    return error?.code === 'EPERM' ? 'alive' : 'unknown';
  }
}

// --- the state lock ----------------------------------------------------------

/** How long an unreadable lock is left alone before it counts as stale. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

/**
 * Whether a lock's text names a holder that may still hold it. A holder is
 * its pid AND that process's start time (#2675 D review F2): the lock sits
 * in the install root, so it outlives a reboot, and a pid alone is reused
 * (in a container the launcher is often pid 1 on every boot). A lock is
 * stale when its pid is gone or now belongs to a process born at another
 * time; a live pid whose start time cannot be read keeps the lock (nothing
 * proves it stale). A lock that is not one this launcher writes was left by
 * something else and is stale once it is old enough not to be mid-write.
 */
function lockHolder(text, modifiedMs) {
  let holder;
  try {
    holder = JSON.parse(text);
  } catch {
    holder = null;
  }
  if (
    !holder ||
    !Number.isInteger(holder.pid) ||
    holder.pid < 1 ||
    typeof holder.birth !== 'string' ||
    holder.birth === '' ||
    typeof holder.token !== 'string'
  )
    return {
      held: Date.now() - modifiedMs < UNREADABLE_LOCK_GRACE_MS,
      pid: null,
    };
  const state = processState(holder.pid);
  if (state === 'dead') return { held: false, pid: holder.pid };
  if (state === 'unknown') return { held: true, pid: holder.pid };
  const birth = processBirth(holder.pid);
  return { held: birth === null || birth === holder.birth, pid: holder.pid };
}

/**
 * Removes a lock judged stale ONLY if it is still the lock that was judged:
 * it is moved aside, and put back if its text changed meanwhile (another
 * launcher reclaimed it and took it first). Without this, two launchers
 * that both judged one stale lock would each delete it, the second deleting
 * the first's fresh lock, and both would run. Residual: a third launcher
 * that takes the lock while it is moved aside wins, and the one moved aside
 * is lost; that takes three launchers racing on one install root.
 */
// Exported for service-launcher.test.ts, which proves the guard.
// fallow-ignore-next-line unused-export
export function reclaimStaleLock(lock, judged) {
  const aside = `${lock}.stale.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lock, aside);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  try {
    let moved = null;
    try {
      moved = readFileSync(aside, 'utf8');
    } catch {
      // Unreadable once moved: treated as changed, so it goes back.
    }
    if (moved === judged) return;
    try {
      linkSync(aside, lock);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } finally {
    rmSync(aside, { force: true });
  }
}

/** Publishes the full lock record at once where hard links exist. */
function createLock(lock, record) {
  const staged = `${lock}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(staged, 'wx', 0o600);
  try {
    writeFileSync(fd, record);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(staged, lock);
    return;
  } catch (error) {
    if (error?.code === 'EEXIST') throw error;
    // No hard links on this volume: an exclusive create, briefly empty,
    // which the unreadable-lock grace covers.
  } finally {
    rmSync(staged, { force: true });
  }
  const fd2 = openSync(lock, 'wx', 0o600);
  try {
    writeFileSync(fd2, record);
    fsyncSync(fd2);
  } finally {
    closeSync(fd2);
  }
}

/**
 * One launcher per install root; install.sh takes the same lock to record
 * a version (recordServiceActiveVersion). Throws when a live holder has it.
 */
function acquireStateLock(installRoot) {
  const { runtime, lock } = statePaths(installRoot);
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const birth = ownBirth();
  if (!birth)
    throw new Error(
      `cannot read this process's start time, which the launcher lock ${lock} records`,
    );
  const token = randomUUID();
  const record = `${JSON.stringify({ pid: process.pid, birth, token })}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      createLock(lock, record);
      fsyncDirectory(runtime);
      return () => {
        try {
          if (JSON.parse(readFileSync(lock, 'utf8')).token === token)
            unlinkSync(lock);
        } catch {
          // Already gone, or someone else's: leave it.
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    let text;
    let modifiedMs;
    try {
      text = readFileSync(lock, 'utf8');
      modifiedMs = statSync(lock).mtimeMs;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const holder = lockHolder(text, modifiedMs);
    if (holder.held)
      throw new Error(
        holder.pid === null
          ? `the Station launcher lock ${lock} is being written; retry`
          : `another Station launcher (pid ${holder.pid}) owns ${installRoot}`,
      );
    reclaimStaleLock(lock, text);
  }
  throw new Error(`could not take the Station launcher lock ${lock}`);
}

/**
 * install.sh's switch of a stopped launcher service (#2675 D review F9):
 * records `version` as the one the service runs, under the launcher's own
 * lock, and only when no update is unfinished. Throws otherwise, and a
 * running launcher (which holds the lock) refuses it.
 */
// fallow-ignore-next-line unused-export
export function recordServiceActiveVersion(installRoot, version) {
  if (!VERSION_PATTERN.test(version))
    throw new Error(`invalid version: ${version}`);
  const release = acquireStateLock(installRoot);
  try {
    const status = readServiceState(installRoot)?.update?.status;
    if (status === 'pending' || status === 'needs-operator')
      throw Object.assign(
        new Error(
          `a supervised Station update is unfinished in ${installRoot}`,
        ),
        { code: 'STATION_UPDATE_UNFINISHED' },
      );
    writeServiceState(installRoot, {
      protocol: LAUNCHER_PROTOCOL,
      activeVersion: version,
    });
  } finally {
    release();
  }
}

// --- the launcher -----------------------------------------------------------

function flagValue(args, name) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

class Launcher {
  constructor({ installRoot, childArgs }) {
    this.installRoot = installRoot;
    this.childArgs = childArgs;
    this.home = flagValue(childArgs, 'base');
    this.instance = flagValue(childArgs, 'instance') ?? 'default';
    if (!this.home)
      throw new Error('the launcher needs the service home (--base=)');
    this.timings = timings();
    this.selfSupervised = selfSupervised();
    // A stop someone asked for, as opposed to an exit a relaunch follows.
    this.stopRequested = false;
    this.state = null;
    this.child = null;
    this.timer = undefined;
    this.queue = Promise.resolve();
    this.stopWaiters = new Set();
    this.stopping = false;
    this.done = false;
    this.completion = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  /** Signals reach `stop` through `main`, which outlives each run. */
  run() {
    this.enqueue(() => this.recover());
    return this.completion;
  }

  enqueue(transition) {
    this.queue = this.queue
      .then(transition, transition)
      .catch((error) =>
        this.fatal(error instanceof Error ? error : new Error(String(error))),
      );
  }

  async fatal(error) {
    if (this.done) return;
    this.done = true;
    this.stopping = true;
    clearTimeout(this.timer);
    clearInterval(this.idle);
    const child = this.child;
    this.child = null;
    if (child) await this.terminate(child);
    this.reject(error);
  }

  async stop(signal) {
    this.stopRequested = true;
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.timer);
    clearInterval(this.idle);
    // A transition waiting on something (the liveness handoff) stops waiting,
    // so a stop always fits the service manager's stop timeout.
    for (const wake of this.stopWaiters) wake();
    this.stopWaiters.clear();
    this.enqueue(async () => {
      const child = this.child;
      this.child = null;
      if (child) await this.terminate(child, signal);
      this.done = true;
      this.resolve(0);
    });
  }

  persist(next, point) {
    writeServiceState(this.installRoot, next);
    this.state = next;
    if (point) crashPoint(point);
  }

  // --- children -------------------------------------------------------------

  /** The version's own `station stop`: reaches the detached server and UI. */
  ownStop(version) {
    if (!versionIsComplete(this.installRoot, version)) return;
    const paths = versionPaths(this.installRoot, version);
    const result = spawnSync(
      paths.node,
      [
        paths.entry,
        'stop',
        `--instance=${this.instance}`,
        `--base=${this.home}`,
      ],
      {
        cwd: paths.dir,
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: this.timings.ownStopTimeoutMs,
        windowsHide: true,
      },
    );
    if (result.status !== 0)
      log(
        `station stop of ${version} exited ${result.status ?? result.signal ?? result.error?.message}`,
      );
  }

  /**
   * Stops a child the way a service manager would, then makes sure nothing
   * it started survives: a child that outlives the grace is killed, and its
   * version's own `stop` then stops the detached server and UI by record.
   */
  async terminate(managed, signal = 'SIGTERM') {
    const { process: child, version } = managed;
    if (child.exitCode === null && child.signalCode === null) {
      // Windows has no SIGTERM: closing the channel is the orderly stop
      // `service run` answers (see selfSupervised).
      if (this.selfSupervised) {
        if (child.connected) child.disconnect();
      } else child.kill(signal);
      if (!(await waitForExit(child, this.timings.stopGraceMs))) {
        log(
          `${version} did not stop within ${this.timings.stopGraceMs} ms; killing it`,
        );
        child.kill('SIGKILL');
        await waitForExit(child, 10_000);
        this.ownStop(version);
        return;
      }
    }
    // Self-supervised (Windows), the version's own `stop` also follows an
    // orderly exit: measured on a Windows runner, `service run`'s shutdown
    // could refuse to signal its UI ("identity could not be verified") and
    // exit with it still running, which left the home active and failed the
    // update's backup; `station stop` by record stopped it. With nothing
    // left running it does nothing.
    if (this.selfSupervised) this.ownStop(version);
  }

  runVersionCommand(version, args) {
    const paths = versionPaths(this.installRoot, version);
    const result = spawnSync(paths.node, [paths.entry, ...args], {
      cwd: paths.dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: this.timings.homeSnapshotTimeoutMs,
      windowsHide: true,
    });
    if (result.status !== 0) {
      const detail = (
        result.stderr ||
        result.stdout ||
        result.error?.message ||
        ''
      ).trim();
      throw new Error(
        `${version} ${args.slice(0, 2).join(' ')} failed: ${detail.split('\n').at(-1) ?? ''}`,
      );
    }
  }

  startChild(version, role, update) {
    if (this.stopping) return;
    if (!versionIsComplete(this.installRoot, version))
      throw new Error(
        `Station ${version} is missing or incomplete in ${this.installRoot}`,
      );
    const paths = versionPaths(this.installRoot, version);
    const context = {
      protocol: LAUNCHER_PROTOCOL,
      installRoot: this.installRoot,
      version,
      role,
      ...(update ? { updateId: update.id } : {}),
    };
    const child = spawn(paths.node, [paths.entry, ...this.childArgs], {
      cwd: paths.dir,
      env: { ...process.env, [LAUNCHER_ENV]: JSON.stringify(context) },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    const managed = { process: child, version, role };
    this.child = managed;
    child.on('error', (error) =>
      this.enqueue(() => this.onExit(managed, null, String(error))),
    );
    child.on('message', (message) =>
      this.enqueue(() => this.onMessage(managed, message)),
    );
    child.once('exit', (code, signal) =>
      this.enqueue(() => this.onExit(managed, code, signal)),
    );
    if (role === 'trial') {
      this.timer = setTimeout(
        () => this.enqueue(() => this.onPreparedTimeout(managed)),
        this.timings.preparedTimeoutMs,
      );
    }
    log(`started Station ${version} (${role})`);
  }

  send(managed, message) {
    try {
      managed.process.send?.(message);
    } catch {
      // A child that went away is handled by its exit.
    }
  }

  // --- the transaction ------------------------------------------------------

  async recover() {
    recoverCurrent(this.installRoot);
    let state = readServiceState(this.installRoot);
    if (!state) {
      state = {
        protocol: LAUNCHER_PROTOCOL,
        activeVersion: versionFromCurrent(this.installRoot),
      };
      this.persist(state);
    }
    this.state = state;
    const update = state.update;
    this.sweepBackups(
      update?.status === 'pending' || update?.status === 'needs-operator'
        ? update.id
        : null,
    );
    if (update?.status === 'needs-operator') {
      // Each start is one more try: the operator's way to retry once the
      // cause is fixed, and also any restart the operator did not ask for (a
      // reboot, a service manager restart). Within one launcher run no
      // restore is retried after the last attempt.
      this.ownStop(update.fromVersion);
      this.ownStop(update.targetVersion);
      const { finishedAt: _finishedAt, ...unfinished } = update;
      await this.rollBack(
        {
          ...unfinished,
          status: 'pending',
          phase: 'restoring',
          restoreAttempts: MAX_RESTORE_ATTEMPTS - 1,
        },
        update.reason ?? 'rollback-interrupted',
      );
      return;
    }
    if (update?.status === 'pending') {
      // A launcher that died mid-update may have left the old or the trial
      // version's detached server behind (launchd does not kill it); stop
      // both by record before anything touches the home.
      this.ownStop(update.fromVersion);
      if (update.phase === 'trial' || update.phase === 'restoring')
        this.ownStop(update.targetVersion);
      await this.continueUpdate(update);
      return;
    }
    // A launcher killed after it recorded the outcome may not have removed
    // the backup or moved `current` yet.
    if (update)
      rmSync(this.backupDir(update), { recursive: true, force: true });
    pointCurrentAt(this.installRoot, state.activeVersion);
    this.startChild(state.activeVersion, 'active');
  }

  backupDir(update) {
    return join(statePaths(this.installRoot).backups, update.id);
  }

  /**
   * Removes everything in update-backups but the unfinished update's backup
   * (#2675 D review F6): a backup's staging copy
   * (`.<id>.<pid>.<uuid>.tmp`) that a killed launcher or a service manager's
   * SIGKILL left mid-copy, and backups no update names any more. Only the
   * launcher, which holds the lock, and its update-home child write there,
   * and neither runs yet.
   */
  sweepBackups(keep) {
    const { backups } = statePaths(this.installRoot);
    let names;
    try {
      names = readdirSync(backups);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === keep) continue;
      try {
        rmSync(join(backups, name), { recursive: true, force: true });
      } catch (error) {
        log(`could not remove ${join(backups, name)}: ${error.message}`);
      }
    }
  }

  async continueUpdate(update) {
    if (update.phase === 'restoring') {
      await this.rollBack(update, update.reason ?? 'rollback-interrupted');
      return;
    }
    if (!versionIsComplete(this.installRoot, update.targetVersion)) {
      await this.rollBack(update, 'target-runtime-missing');
      return;
    }
    if (update.attempts >= MAX_TRIAL_ATTEMPTS) {
      await this.rollBack(update, 'trial-attempts-exhausted');
      return;
    }
    // A trial ran, so the home may hold its writes, and the backup that
    // would undo them is gone: never snapshot that home as the old state.
    if (update.attempts > 0 && !existsSync(this.backupDir(update))) {
      await this.rollBack(update, 'backup-missing');
      return;
    }
    if (update.phase === 'stopping') {
      update = { ...update, phase: 'backing-up' };
      this.persist({ ...this.state, update });
    }
    try {
      mkdirSync(statePaths(this.installRoot).backups, {
        recursive: true,
        mode: 0o700,
      });
      // The old version's own code, and so its own store registry.
      this.runVersionCommand(update.fromVersion, [
        'service',
        'update-home',
        'backup',
        `--backup-dir=${this.backupDir(update)}`,
        `--base=${this.home}`,
      ]);
    } catch (error) {
      log(String(error.message));
      // Before any trial, nothing has run on this home since the old version
      // stopped, so there is nothing to restore and a backup that could not
      // be completed or validated is discarded. After one, the backup is the
      // only way back: it is kept, and the restore decides.
      if (update.attempts === 0)
        rmSync(this.backupDir(update), { recursive: true, force: true });
      await this.rollBack(update, 'backup-failed');
      return;
    }
    crashPoint('backup');
    update = { ...update, phase: 'trial', attempts: update.attempts + 1 };
    this.persist({ ...this.state, update }, 'attempt');
    try {
      this.startChild(update.targetVersion, 'trial', update);
    } catch (error) {
      log(String(error.message));
      await this.rollBack(update, 'candidate-start-failed');
    }
  }

  async onMessage(managed, message) {
    if (
      this.child !== managed ||
      this.stopping ||
      !message ||
      typeof message !== 'object'
    )
      return;
    if (message.type === 'request-update') {
      await this.onUpdateRequest(managed, message);
      return;
    }
    if (message.type === 'prepared')
      await this.onPrepared(managed, message.updateId);
  }

  async onUpdateRequest(managed, message) {
    const reject = (reason) =>
      this.send(managed, {
        type: 'update-rejected',
        reason,
        requestId: message.requestId,
      });
    const target = message.targetVersion;
    if (
      managed.role !== 'active' ||
      managed.version !== this.state.activeVersion
    )
      return reject('Only the active version can request an update.');
    if (this.state.update?.status === 'pending')
      return reject('Another update is already in progress.');
    if (typeof target !== 'string' || !VERSION_PATTERN.test(target))
      return reject('The requested target is not an exact version.');
    const order = compareVersions(target, managed.version);
    if (order === null || order <= 0)
      return reject(
        `Station ${target} is not newer than the running ${managed.version}.`,
      );
    if (!versionIsComplete(this.installRoot, target))
      return reject(`Station ${target} is not completely installed.`);
    const update = {
      id: randomUUID(),
      fromVersion: managed.version,
      targetVersion: target,
      ...(typeof message.requestId === 'string'
        ? { requestId: message.requestId }
        : {}),
      status: 'pending',
      phase: 'stopping',
      attempts: 0,
      startedAt: new Date().toISOString(),
    };
    this.persist({ ...this.state, update }, 'pending');
    // The child re-points the service's liveness entry at this launcher
    // before it stops, so for the whole window a desktop app sees a live
    // service that owns the home and does not start a second writer.
    const acknowledged = new Promise((resolve) => {
      let timer;
      const finish = (value) => {
        clearTimeout(timer);
        managed.process.off('message', onAck);
        this.stopWaiters.delete(wake);
        resolve(value);
      };
      const onAck = (reply) => {
        if (reply?.type === 'handoff-ready' && reply.updateId === update.id)
          finish(true);
      };
      const wake = () => finish(false);
      managed.process.on('message', onAck);
      this.stopWaiters.add(wake);
      timer = setTimeout(wake, this.timings.handoffAckMs);
    });
    this.send(managed, {
      type: 'update-accepted',
      updateId: update.id,
      launcherPid: process.pid,
    });
    if (!(await acknowledged))
      log(
        `${managed.version} did not confirm the liveness handoff; stopping it anyway`,
      );
    this.child = null;
    await this.terminate(managed);
    if (this.stopping) return;
    await this.continueUpdate(update);
  }

  async onPrepared(managed, updateId) {
    const update = this.state.update;
    if (
      managed.role !== 'trial' ||
      update?.status !== 'pending' ||
      update.id !== updateId ||
      update.targetVersion !== managed.version
    ) {
      if (managed.role === 'trial' && update?.status === 'pending') {
        await this.rollBack(update, 'invalid-prepared', managed);
      }
      return;
    }
    clearTimeout(this.timer);
    const committed = {
      id: update.id,
      fromVersion: update.fromVersion,
      targetVersion: update.targetVersion,
      ...(update.requestId ? { requestId: update.requestId } : {}),
      status: 'committed',
      attempts: update.attempts,
      finishedAt: new Date().toISOString(),
    };
    this.persist(
      { ...this.state, activeVersion: update.targetVersion, update: committed },
      'committed',
    );
    pointCurrentAt(this.installRoot, update.targetVersion);
    crashPoint('current');
    managed.role = 'active';
    rmSync(this.backupDir(update), { recursive: true, force: true });
    this.pruneVersions([update.targetVersion, update.fromVersion]);
    this.send(managed, { type: 'committed', updateId: update.id });
    log(`committed Station ${update.targetVersion}`);
  }

  async onPreparedTimeout(managed) {
    const update = this.state.update;
    if (
      this.child !== managed ||
      managed.role !== 'trial' ||
      update?.status !== 'pending'
    )
      return;
    await this.rollBack(update, 'prepared-timeout', managed);
  }

  async onExit(managed, code, signal) {
    if (this.child !== managed || this.stopping) return;
    this.child = null;
    clearTimeout(this.timer);
    const update = this.state.update;
    if (managed.role === 'trial' && update?.status === 'pending') {
      await this.rollBack(
        update,
        `candidate-exited:${code ?? signal ?? 'unknown'}`,
      );
      return;
    }
    // The active version exited on its own: exit too, and the service
    // manager restarts the unit, as it did before the launcher existed (or,
    // self-supervised, `main` starts this launcher over).
    this.ownStop(managed.version);
    this.done = true;
    this.stopping = true;
    this.resolve(typeof code === 'number' && code !== 0 ? code : 1);
  }

  /**
   * Returns to the version the update left: the trial is stopped, the home
   * is restored from the backup with that version's own code, and it starts
   * again. The `restoring` phase is durable before the home is touched, so a
   * launcher killed mid-restore restores again rather than booting a half
   * restored home.
   *
   * A restore that fails exits the launcher (its service manager starts it
   * again, and the next start retries); each try is counted, and after
   * MAX_RESTORE_ATTEMPTS the update is `needs-operator` (#2675 D review F4).
   */
  async rollBack(update, reason, trial) {
    clearTimeout(this.timer);
    if (trial) {
      this.child = null;
      await this.terminate(trial);
    }
    if (this.stopping) return;
    const backupDir = this.backupDir(update);
    if (!existsSync(backupDir)) {
      // Before any trial, nothing ran on this home since the old version
      // stopped: there is nothing to restore. After one, there is, and
      // nothing to restore it from (#2675 D review F7): the old version
      // starts on the home as it is, and the update is recorded as failed.
      this.finishRollback(
        update,
        update.attempts > 0 ? 'backup-missing' : reason,
      );
      return;
    }
    const restoreAttempts = update.restoreAttempts ?? 0;
    if (restoreAttempts >= MAX_RESTORE_ATTEMPTS) {
      this.needsOperator(update, reason, restoreAttempts);
      return;
    }
    const restoring = {
      ...update,
      phase: 'restoring',
      reason,
      restoreAttempts: restoreAttempts + 1,
    };
    this.persist({ ...this.state, update: restoring }, 'restoring');
    // A failure throws: the old version never starts on a home the trial
    // may have changed, and the launcher exits for the next start to retry.
    this.runVersionCommand(update.fromVersion, [
      'service',
      'update-home',
      'restore',
      `--backup-dir=${backupDir}`,
      `--base=${this.home}`,
    ]);
    this.finishRollback(update, reason);
  }

  finishRollback(update, reason) {
    const backupDir = this.backupDir(update);
    const finished = {
      id: update.id,
      fromVersion: update.fromVersion,
      targetVersion: update.targetVersion,
      ...(update.requestId ? { requestId: update.requestId } : {}),
      status: [
        'backup-failed',
        'target-runtime-missing',
        'backup-missing',
      ].includes(reason)
        ? 'failed'
        : 'rolled-back',
      reason,
      attempts: update.attempts,
      finishedAt: new Date().toISOString(),
    };
    this.persist(
      { ...this.state, activeVersion: update.fromVersion, update: finished },
      'rolled-back',
    );
    rmSync(backupDir, { recursive: true, force: true });
    pointCurrentAt(this.installRoot, update.fromVersion);
    log(`update to ${update.targetVersion} ${finished.status}: ${reason}`);
    this.startChild(update.fromVersion, 'active');
  }

  /**
   * Restores keep failing: the launcher stops retrying and waits, running no
   * version, so its service manager does not restart it in a loop and no
   * Station starts on a half-restored home. The backup is kept. Recovery:
   * fix the cause, then stop and start the service, and it tries once more.
   */
  needsOperator(update, reason, restoreAttempts) {
    const next = {
      id: update.id,
      fromVersion: update.fromVersion,
      targetVersion: update.targetVersion,
      ...(update.requestId ? { requestId: update.requestId } : {}),
      status: 'needs-operator',
      reason,
      attempts: update.attempts,
      restoreAttempts,
      finishedAt: new Date().toISOString(),
    };
    this.persist({ ...this.state, update: next }, 'needs-operator');
    // Nothing else keeps this process alive; it waits for its stop.
    this.idle = setInterval(() => undefined, 60 * 60_000);
    log(
      `could not restore ${this.home} after ${restoreAttempts} attempts to roll back the update to ${update.targetVersion} (${reason}); ` +
        `its backup is kept at ${this.backupDir(update)}. Station stays stopped. ` +
        `Fix the cause shown above, then retry the restore with: station service stop --instance=${this.instance} && station service start --instance=${this.instance}`,
    );
  }

  /** Keeps the active version and its rollback target; best effort. */
  pruneVersions(keep) {
    const versions = join(this.installRoot, 'versions');
    let names;
    try {
      names = readdirSync(versions);
    } catch {
      return;
    }
    for (const name of names) {
      // Dot entries are install.sh's stages; never ours to remove.
      if (name.startsWith('.') || keep.includes(name)) continue;
      const dir = join(versions, name);
      try {
        if (!lstatSync(dir).isDirectory()) continue;
        makeWritable(dir);
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        log(`could not prune ${dir}: ${error.message}`);
      }
    }
  }
}

/** Installed versions are sealed read-only; a removal needs write bits back. */
function makeWritable(dir) {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink())
      makeWritable(join(dir, entry.name));
  }
}

/**
 * Runs launchers one after another while self-supervised (see
 * selfSupervised): each run that ends without a requested stop (the active
 * version exited, a transition failed) is followed, after a backoff, by a
 * fresh one, which recovers from service-state.json as a restarted launcher
 * does. Durable state bounds every retry the same way it does under systemd:
 * a failing restore counts its attempts there and ends in needs-operator,
 * where a run waits instead of ending.
 */
async function superviseRuns(installRoot, childArgs) {
  const { relaunchDelayMs, relaunchMaxDelayMs, relaunchResetMs, parentPollMs } =
    timings();
  let current = null;
  let stopRequested = false;
  let wakeBackoff;
  const requestStop = (signal) => {
    stopRequested = true;
    wakeBackoff?.();
    if (current) void current.stop(signal);
  };
  process.once('SIGTERM', () => requestStop('SIGTERM'));
  process.once('SIGINT', () => requestStop('SIGINT'));
  // The task's cmd.exe wrapper is this process's parent; `schtasks /End`
  // ends it and nothing else. Its pid stays in process.ppid after it exits.
  const parent = process.ppid;
  const parentWatch = setInterval(() => {
    if (processState(parent) === 'dead') {
      clearInterval(parentWatch);
      log(`the service wrapper (pid ${parent}) is gone; stopping`);
      requestStop('SIGTERM');
    }
  }, parentPollMs);
  let delay = relaunchDelayMs;
  try {
    for (;;) {
      if (stopRequested) return 0;
      current = new Launcher({ installRoot, childArgs });
      const startedAt = Date.now();
      let code;
      try {
        code = await current.run();
      } catch (error) {
        log(error instanceof Error ? error.message : String(error));
        code = 1;
      }
      if (stopRequested || current.stopRequested) return code;
      if (Date.now() - startedAt >= relaunchResetMs) delay = relaunchDelayMs;
      log(`relaunching in ${delay} ms (the last run ended with ${code})`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        wakeBackoff = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeBackoff = undefined;
      delay = Math.min(delay * 2, relaunchMaxDelayMs);
    }
  } finally {
    clearInterval(parentWatch);
  }
}

async function main(argv = process.argv.slice(2)) {
  const launcherPath = fileURLToPath(import.meta.url);
  const installRoot = dirname(dirname(launcherPath));
  const release = acquireStateLock(installRoot);
  try {
    if (selfSupervised()) return await superviseRuns(installRoot, argv);
    const launcher = new Launcher({ installRoot, childArgs: argv });
    const onSignal = (signal) => void launcher.stop(signal);
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    return await launcher.run();
  } finally {
    release();
  }
}

// Run as a program, not when a test imports the module. The unit may name
// this file through a symbolic link, while import.meta.url is its real path.
function isEntryPoint() {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => process.exit(code ?? 0),
    (error) => {
      log(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
