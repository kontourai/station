import { createHash } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  STATION_SESSION_TMP_DIR_NAME,
  stationSessionTmpRootName,
} from '@kontourai/station-shared/temp-dir';
import { resolveHomeDir } from '../../utils/paths.js';
import { tightenToOwnerOnly } from './engine-spawn-tmpdir.js';

/**
 * A per-session `TMPDIR` for engines, so the files an agent saves "to a temp
 * file" land in a directory Station can attribute to exactly one session.
 *
 * Without it every engine shares `<home>/tmp/engine-spawn`
 * (`engine-spawn-tmpdir.ts`), which holds every session's files and so can
 * never be a place Station reads one session's images from. With the
 * `chat-host-images` Feature Preview on, a session gets a directory named
 * `<station pid>-<thread digest>`: the digest keeps the thread id out of the
 * path. Capture reads the root recorded when the engine launched
 * ({@link sessionTempRoot}). The directory is removed when the session exits; one a crash left
 * behind is removed once its owning Station process is gone
 * ({@link reapStaleSessionTmpDirs}).
 *
 * The directory is the engine's whole `TMPDIR`, and the tools an agent runs
 * create Unix sockets in it (tsx's IPC pipe `$TMPDIR/tsx-<uid>/<pid>.pipe`,
 * ssh `ControlPath`, gpg-agent, tmux, language servers). A socket path is
 * capped by `sun_path`: 104 bytes with its NUL on macOS, 108 on Linux. Under
 * the default home, `<home>/tmp/session-tmp/session-<pid>-<24 hex>` was 95
 * bytes, so tsx's pipe came to 117 and its `listen` failed with EINVAL for
 * every agent working inside a Station session. So the directory is held to
 * {@link SESSION_TMPDIR_MAX_BYTES}, which leaves 40 bytes under the macOS
 * limit for `/`, the tool's own suffix, and the NUL. It lives under
 * `<home>/tmp/session-tmp` when that fits (a short `STATION_HOME`);
 * otherwise in a short per-user root, `stn-<uid>` directly under the system
 * temp directory (Station's own `os.tmpdir()`, else `/tmp`), created 0700
 * and checked to be this user's real directory before anything goes in it.
 * When no candidate is usable, the home path is used even though it is over
 * budget, and Windows (no POSIX socket paths in a temp directory) always
 * uses the home path.
 *
 * The decision is taken when an engine starts. Turning the preview on does
 * not move a running engine, and turning it off does not remove a running
 * session's directory before the session ends.
 */
export function sessionTmpRoot(homeDir: string = resolveHomeDir()): string {
  return join(homeDir, 'tmp', 'session-tmp');
}

/**
 * The longest per-session `TMPDIR`, in bytes: the 104-byte macOS `sun_path`
 * (the smaller of the two limits) less 40 bytes left for `/`, a tool's
 * socket name, and the terminating NUL.
 */
export const SESSION_TMPDIR_MAX_BYTES = 104 - 40;

/** Test seam: the system temp bases a short root may sit under. */
export const sessionTmpDirTestHooks: { shortBases?: () => string[] } = {};

/** Names an older Station gave its in-home session directories. */
const LEGACY_SESSION_DIR = /^session-(\d+)-[0-9a-f]{24}$/;

/**
 * The short per-user roots, in preference order, canonical (macOS `/tmp` is
 * `/private/tmp`, and the reaper refuses a root that resolves elsewhere).
 */
export function shortSessionTmpRoots(): string[] {
  if (process.platform === 'win32') return [];
  const bases = sessionTmpDirTestHooks.shortBases?.() ?? [tmpdir(), '/tmp'];
  const roots: string[] = [];
  for (const base of bases) {
    let real: string;
    try {
      real = realpathSync(base);
    } catch {
      continue;
    }
    const root = join(real, stationSessionTmpRootName());
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

function fitsSocketBudget(dir: string): boolean {
  return Buffer.byteLength(dir) <= SESSION_TMPDIR_MAX_BYTES;
}

interface Candidate {
  readonly root: string;
  readonly dir: string;
  readonly short: boolean;
}

/** Where a thread's directory may go, best first. */
function sessionTmpDirCandidates(
  threadId: string,
  homeDir: string,
  pid: number,
): Candidate[] {
  const digest = createHash('sha256')
    .update(threadId)
    .digest('hex')
    .slice(0, 16);
  const name = `${pid}-${digest}`;
  const homeRoot = sessionTmpRoot(homeDir);
  const inHome = { root: homeRoot, dir: join(homeRoot, name), short: false };
  const fitting = [
    inHome,
    ...shortSessionTmpRoots().map((root) => ({
      root,
      dir: join(root, name),
      short: true,
    })),
  ].filter((candidate) => fitsSocketBudget(candidate.dir));
  return fitting.includes(inHome) ? fitting : [...fitting, inHome];
}

/**
 * The directory a thread's engine gets when its preferred root is usable,
 * whether or not it exists yet.
 */
export function sessionTmpDirPath(
  threadId: string,
  homeDir: string = resolveHomeDir(),
  pid: number = process.pid,
): string {
  return sessionTmpDirCandidates(threadId, homeDir, pid)[0]!.dir;
}

let policy: ((threadId: string) => boolean) | undefined;

/**
 * The temp root each live session's engine was actually launched with, by
 * thread: this module's own per-session directory, or one an engine's
 * confinement created for it (Claude under Seatbelt uses its own
 * `<home>/tmp/confined-sessions/session-…`). Capture and the agent
 * instruction read this rather than recomputing a path, so a session whose
 * engine never got a per-session root (preview off when it started, an
 * in-process engine, a confinement Station did not record) has none.
 */
export interface LaunchedRoot {
  readonly dir: string;
  /** This module created it (a confinement's directory is its owner's). */
  readonly own: boolean;
}

/**
 * One record per launch. Its identity is the launch's generation: a removal
 * queued for one launch must not touch the record (or the same-named folder)
 * of a later launch of the same thread.
 */
const launchedRoots = new Map<string, LaunchedRoot>();

/**
 * Install the start-time decision (runtime composition binds it to the
 * preview's selector). Returns the uninstall used by tests and shutdown.
 */
export function installSessionTmpDirPolicy(
  enabled: (threadId: string) => boolean,
): () => void {
  policy = enabled;
  return () => {
    if (policy === enabled) policy = undefined;
  };
}

function admitted(threadId: string): boolean {
  try {
    return policy?.(threadId) === true;
  } catch {
    return false;
  }
}

/**
 * A directory this process owns outright: a real directory (not a link),
 * owned by this user, and private (mode tightened to 0700 when it is not).
 * Anything else is refused rather than used as a session's temp root.
 */
/** Test seam: runs after the directory is opened, before it is re-confirmed. */
export const ownedDirTestHooks: { afterOpen?: (dir: string) => void } = {};

function ownedPrivateDir(dir: string): boolean {
  if (process.platform === 'win32') {
    // No no-follow directory descriptors or POSIX modes: a real directory,
    // not a link, is the check available.
    try {
      const stats = lstatSync(dir);
      return stats.isDirectory() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }
  let fd: number | undefined;
  try {
    // Opened without following a link, so the mode is checked and tightened
    // on the directory itself (fchmod), never on whatever a link points at.
    fd = openSync(
      dir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const stats = fstatSync(fd);
    ownedDirTestHooks.afterOpen?.(dir);
    if (!stats.isDirectory()) return false;
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) return false;
    if ((stats.mode & 0o777) !== 0o700) {
      fchmodSync(fd, 0o700);
      if ((fstatSync(fd).mode & 0o777) !== 0o700) return false;
    }
    // The path must still name the directory that was checked.
    const current = lstatSync(dir);
    return current.dev === stats.dev && current.ino === stats.ino;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The `TMPDIR` an engine starting for `threadId` gets: its own directory
 * (created owner-only, or an existing one re-tightened to 0700 and checked to
 * be this user's) when the policy admits it, otherwise `undefined`, and the
 * caller keeps the shared engine-spawn directory. A directory that cannot be
 * created or trusted also leaves the shared one: a temp folder must never
 * block an engine start.
 *
 * This only prepares the folder. The launch is recorded by
 * {@link commitEngineLaunch} once the adapter has committed the new session,
 * so a start that fails leaves the previous launch's record in place.
 */
export function engineSessionTmpDir(threadId: string): string | undefined {
  return admitted(threadId) ? createOwnDir(threadId) : undefined;
}

/**
 * The adapter committed a new launch for `threadId`, whose engine got `own`
 * (this module's folder from {@link engineSessionTmpDir}) or `confined` (a
 * confinement's own folder) as its TMPDIR, or neither. Every committed launch
 * replaces the last one's record, including one with no root, so the thread
 * never keeps serving a previous folder. The previous launch's own folder is
 * NOT removed here: its engine may still be draining. It goes when that
 * launch ends ({@link removeLaunchedRoot}), or with the restart sweep.
 */
export function commitEngineLaunch(
  threadId: string,
  tmpDir: { own: string } | { confined: string } | undefined,
): void {
  const next =
    tmpDir &&
    'own' in tmpDir &&
    admitted(threadId) &&
    ownedPrivateDir(tmpDir.own)
      ? { dir: tmpDir.own, own: true }
      : tmpDir &&
          'confined' in tmpDir &&
          admitted(threadId) &&
          ownedPrivateDir(tmpDir.confined)
        ? { dir: tmpDir.confined, own: false }
        : undefined;
  if (next) launchedRoots.set(threadId, next);
  else launchedRoots.delete(threadId);
}

/** The root cannot hold the directory; the next candidate is tried. */
const UNUSABLE = Symbol('unusable root');

function createOwnDir(threadId: string): string | undefined {
  for (const candidate of sessionTmpDirCandidates(
    threadId,
    resolveHomeDir(),
    process.pid,
  )) {
    const dir = candidate.short
      ? createInShortRoot(candidate)
      : createInHome(candidate);
    // A directory that exists but cannot be trusted is refused outright,
    // not moved to another root.
    if (dir !== UNUSABLE) return dir;
  }
  return undefined;
}

function createInHome({
  root,
  dir,
}: Candidate): string | undefined | typeof UNUSABLE {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return UNUSABLE;
  }
  // The parents mkdir created are masked by the umask too.
  tightenToOwnerOnly(dirname(root));
  tightenToOwnerOnly(root);
  return ownedPrivateDir(dir) ? dir : undefined;
}

/**
 * The shared system temp directory is writable by every user, so the root is
 * made without `recursive` (which would follow a link planted in its place)
 * and must then be this user's own private, real directory before a session
 * directory is made in it. A root another user holds is passed over.
 */
function createInShortRoot({
  root,
  dir,
}: Candidate): string | undefined | typeof UNUSABLE {
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return UNUSABLE;
  }
  if (!ownedPrivateDir(root)) return UNUSABLE;
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return UNUSABLE;
  }
  return ownedPrivateDir(dir) ? dir : undefined;
}

function removeOwnDir(dir: string): void {
  try {
    const stats = lstatSync(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort; the stale-owner sweep retries after this process exits.
  }
}

/**
 * The launch each adapter-published `session.exited` belongs to, taken by
 * the adapter when it publishes the event (before any queue or orchestration
 * await, during which a restart could record a newer launch). Keyed by event
 * id and bounded; `null` records that the exiting session had no root.
 */
const exitLaunches = new Map<string, LaunchedRoot | null>();
const EXIT_LAUNCH_MEMORY = 1024;

/** Adapters call this with every event they publish. */
export function stampLaunchExit(event: {
  method: string;
  eventId: string;
  threadId: string;
}): void {
  if (event.method !== 'session.exited') return;
  exitLaunches.set(event.eventId, launchedRoots.get(event.threadId) ?? null);
  while (exitLaunches.size > EXIT_LAUNCH_MEMORY) {
    const oldest = exitLaunches.keys().next().value;
    if (oldest === undefined) break;
    exitLaunches.delete(oldest);
  }
}

/**
 * The launch stamped on this exit, once. `undefined` when no adapter stamped
 * it (an event Station itself emitted): the caller then removes nothing, and
 * the restart sweep reclaims the folder.
 */
export function takeLaunchAtExit(eventId: string): LaunchedRoot | undefined {
  const launched = exitLaunches.get(eventId);
  exitLaunches.delete(eventId);
  return launched ?? undefined;
}

/**
 * The session's temp root as its engine was launched with it, while it still
 * exists as a private directory this user owns; otherwise undefined.
 */
export function sessionTempRoot(threadId: string): string | undefined {
  const dir = launchedRoots.get(threadId)?.dir;
  return dir && ownedPrivateDir(dir) ? dir : undefined;
}

/** The launch record a session holds now (taken when it exits). */
export function launchedRootOf(threadId: string): LaunchedRoot | undefined {
  return launchedRoots.get(threadId);
}

/**
 * A launch ended: forget its record if it is still the thread's current one,
 * and remove its folder when this module created it (a confinement's folder
 * is removed by its owner) unless the thread's current launch uses that same
 * folder: a thread that restarted first may own a folder at the very same
 * path, and a late removal must leave it and its record alone.
 */
export function removeLaunchedRoot(
  threadId: string,
  launched: LaunchedRoot | undefined,
): void {
  if (!launched) return;
  const current = launchedRoots.get(threadId);
  if (current === launched) launchedRoots.delete(threadId);
  // A replaced launch's own folder goes when that launch ends, unless the
  // thread's current launch uses the same folder (a restart at the same path).
  if (launched.own && (current === launched || current?.dir !== launched.dir))
    removeOwnDir(launched.dir);
}

/** The session ended now: remove its current launch's root. */
export function removeSessionTmpDir(threadId: string): void {
  removeLaunchedRoot(threadId, launchedRootOf(threadId));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Remove session temp directories whose owning Station process is gone. The
 * same ownership proof as `reapStaleSeatbeltSessionDirs`: a real directory
 * directly in a session root, named for a pid, owned by this user, and no
 * such process alive. Both the home root (including names an older Station
 * used) and the short per-user roots are swept; a short root is shared by
 * every Station instance this user runs, which is safe because a directory
 * is only removed once its owner process is gone. This process's own
 * directories are left to session exit.
 */
export function reapStaleSessionTmpDirs(
  homeDir: string = resolveHomeDir(),
  deps: { isAlive?: (pid: number) => boolean; uid?: number | undefined } = {},
): number {
  const isAlive = deps.isAlive ?? processAlive;
  const uid = 'uid' in deps ? deps.uid : process.getuid?.();
  let reaped = 0;
  try {
    reaped += reapRoot(sessionTmpRoot(realpathSync(homeDir)), isAlive, uid, [
      STATION_SESSION_TMP_DIR_NAME,
      LEGACY_SESSION_DIR,
    ]);
  } catch {
    // No home: nothing of it to sweep.
  }
  for (const root of shortSessionTmpRoots()) {
    reaped += reapRoot(root, isAlive, uid, [STATION_SESSION_TMP_DIR_NAME]);
  }
  return reaped;
}

function reapRoot(
  root: string,
  isAlive: (pid: number) => boolean,
  uid: number | undefined,
  names: readonly RegExp[],
): number {
  let entries: string[];
  try {
    if (realpathSync(root) !== root) return 0;
    if (uid !== undefined && lstatSync(root).uid !== uid) return 0;
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  let reaped = 0;
  for (const entry of entries) {
    const owner = names
      .map((pattern) => pattern.exec(entry))
      .find((match) => match !== null);
    if (!owner) continue;
    const pid = Number(owner[1]);
    const path = join(root, entry);
    try {
      const stats = lstatSync(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      if (uid !== undefined && stats.uid !== uid) continue;
      if (pid === process.pid || isAlive(pid)) continue;
      rmSync(path, { recursive: true, force: true });
      reaped += 1;
    } catch {
      // Best-effort.
    }
  }
  return reaped;
}
