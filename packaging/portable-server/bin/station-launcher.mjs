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
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
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
import { basename, dirname, join } from 'node:path';
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
});
// Exported for service-launcher.test.ts, which pins the production values.
// fallow-ignore-next-line unused-export
export const MAX_TRIAL_ATTEMPTS = 2;

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
  if (status === 'rolled-back' || status === 'failed')
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
    renameSync(temp, paths.state);
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

function pointCurrentAt(installRoot, version) {
  const current = join(installRoot, 'current');
  const target = versionPaths(installRoot, version).dir;
  try {
    if (readlinkSync(current) === target) return;
  } catch {
    // Missing or not a link: replaced below.
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

// --- the O_EXCL state lock --------------------------------------------------

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * One launcher per install root. The lock names its holder; a lock whose
 * holder is gone (a killed launcher) is taken over, anything else refuses.
 */
function acquireStateLock(installRoot) {
  const { runtime, lock } = statePaths(installRoot);
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token })}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
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
      let holder;
      try {
        holder = JSON.parse(readFileSync(lock, 'utf8'));
      } catch {
        holder = null;
      }
      if (
        holder &&
        Number.isInteger(holder.pid) &&
        holder.pid !== process.pid &&
        processAlive(holder.pid)
      )
        throw new Error(
          `another Station launcher (pid ${holder.pid}) owns ${installRoot}`,
        );
      rmSync(lock, { force: true });
    }
  }
  throw new Error(`could not take the Station launcher lock ${lock}`);
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
    this.state = null;
    this.child = null;
    this.timer = undefined;
    this.queue = Promise.resolve();
    this.stopping = false;
    this.done = false;
    this.completion = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  run() {
    const onSignal = (signal) => void this.stop(signal);
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
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
    const child = this.child;
    this.child = null;
    if (child) await this.terminate(child);
    this.reject(error);
  }

  async stop(signal) {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.timer);
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
      child.kill(signal);
      if (!(await waitForExit(child, this.timings.stopGraceMs))) {
        log(
          `${version} did not stop within ${this.timings.stopGraceMs} ms; killing it`,
        );
        child.kill('SIGKILL');
        await waitForExit(child, 10_000);
        this.ownStop(version);
      }
    }
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
      const onAck = (reply) => {
        if (reply?.type === 'handoff-ready' && reply.updateId === update.id)
          resolve(true);
      };
      managed.process.on('message', onAck);
      setTimeout(() => {
        managed.process.off('message', onAck);
        resolve(false);
      }, this.timings.handoffAckMs);
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
    // manager restarts the unit, as it did before the launcher existed.
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
   */
  async rollBack(update, reason, trial) {
    clearTimeout(this.timer);
    if (trial) {
      this.child = null;
      await this.terminate(trial);
    }
    if (this.stopping) return;
    const backupDir = this.backupDir(update);
    const restoring = { ...update, phase: 'restoring', reason };
    this.persist({ ...this.state, update: restoring }, 'restoring');
    if (existsSync(backupDir)) {
      // A failed restore leaves the update pending in `restoring` and the
      // launcher exits: the old version never starts on a home the trial may
      // have changed, and the next start retries.
      this.runVersionCommand(update.fromVersion, [
        'service',
        'update-home',
        'restore',
        `--backup-dir=${backupDir}`,
        `--base=${this.home}`,
      ]);
    }
    const finished = {
      id: update.id,
      fromVersion: update.fromVersion,
      targetVersion: update.targetVersion,
      ...(update.requestId ? { requestId: update.requestId } : {}),
      status:
        reason === 'backup-failed' || reason === 'target-runtime-missing'
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

async function main(argv = process.argv.slice(2)) {
  const launcherPath = fileURLToPath(import.meta.url);
  const installRoot = dirname(dirname(launcherPath));
  const release = acquireStateLock(installRoot);
  try {
    const code = await new Launcher({ installRoot, childArgs: argv }).run();
    return code;
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
