import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveHomeDir } from '../../utils/paths.js';

/**
 * A per-session `TMPDIR` for engines, so the files an agent saves "to a temp
 * file" land in a directory Station can attribute to exactly one session.
 *
 * Without it every engine shares `<home>/tmp/engine-spawn`
 * (`engine-spawn-tmpdir.ts`), which holds every session's files and so can
 * never be a place Station reads one session's images from. With the
 * `chat-host-images` Feature Preview on, a session gets
 * `<home>/tmp/session-tmp/session-<station pid>-<thread digest>`: the
 * digest keeps the thread id out of the path and the name derivable, so the
 * capture side recomputes it from the thread instead of trusting a stored
 * path. Capture reads the root recorded when the engine launched
 * ({@link sessionTempRoot}). The directory is removed when the session exits; one a crash left
 * behind is removed once its owning Station process is gone
 * ({@link reapStaleSessionTmpDirs}).
 *
 * The decision is taken when an engine starts. Turning the preview on does
 * not move a running engine, and turning it off does not remove a running
 * session's directory before the session ends.
 */
export function sessionTmpRoot(homeDir: string = resolveHomeDir()): string {
  return join(homeDir, 'tmp', 'session-tmp');
}

const SESSION_DIR = /^session-(\d+)-[0-9a-f]{24}$/;

/** The directory a thread's engine uses, whether or not it exists yet. */
export function sessionTmpDirPath(
  threadId: string,
  homeDir: string = resolveHomeDir(),
  pid: number = process.pid,
): string {
  const digest = createHash('sha256')
    .update(threadId)
    .digest('hex')
    .slice(0, 24);
  return join(sessionTmpRoot(homeDir), `session-${pid}-${digest}`);
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
const launchedRoots = new Map<string, string>();

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
function ownedPrivateDir(dir: string): boolean {
  try {
    const stats = lstatSync(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) return false;
    if ((stats.mode & 0o777) !== 0o700) {
      chmodSync(dir, 0o700);
      if ((lstatSync(dir).mode & 0o777) !== 0o700) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The `TMPDIR` an engine starting for `threadId` gets: its own directory
 * (created owner-only, or an existing one re-tightened to 0700 and checked to
 * be this user's) when the policy admits it, otherwise `undefined`, and the
 * caller keeps the shared engine-spawn directory. A directory that cannot be
 * created or trusted also leaves the shared one: a temp folder must never
 * block an engine start.
 */
export function engineSessionTmpDir(threadId: string): string | undefined {
  if (!admitted(threadId)) return undefined;
  const dir = sessionTmpDirPath(threadId);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }
  if (!ownedPrivateDir(dir)) return undefined;
  launchedRoots.set(threadId, dir);
  return dir;
}

/**
 * Record a temp directory an engine's confinement created for this session
 * (and set as its `TMPDIR`), when the policy admits the session. Only that
 * exact directory becomes a root; its owner keeps removing it.
 */
export function noteEngineTmpDir(threadId: string, dir: string): void {
  if (admitted(threadId) && ownedPrivateDir(dir))
    launchedRoots.set(threadId, dir);
}

/** Whether a policy is installed and admits `threadId` now. */
export function sessionTmpDirAdmitted(threadId: string): boolean {
  return admitted(threadId);
}

/**
 * The session's temp root as its engine was launched with it, while it still
 * exists as a private directory this user owns; otherwise undefined.
 */
export function sessionTempRoot(threadId: string): string | undefined {
  const dir = launchedRoots.get(threadId);
  return dir && ownedPrivateDir(dir) ? dir : undefined;
}

/**
 * The session ended: forget its root, and remove it when it is this module's
 * own directory (a confinement's directory is removed by its owner).
 */
export function removeSessionTmpDir(threadId: string): void {
  launchedRoots.delete(threadId);
  const dir = sessionTmpDirPath(threadId);
  try {
    const stats = lstatSync(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort; the stale-owner sweep retries after this process exits.
  }
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
 * directly in the root, named for a pid, owned by this user, and no such
 * process alive. This process's own directories are left to session exit.
 */
export function reapStaleSessionTmpDirs(
  homeDir: string = resolveHomeDir(),
  deps: { isAlive?: (pid: number) => boolean; uid?: number | undefined } = {},
): number {
  let root: string;
  let entries: string[];
  try {
    root = sessionTmpRoot(realpathSync(homeDir));
    if (realpathSync(root) !== root) return 0;
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  const isAlive = deps.isAlive ?? processAlive;
  const uid = 'uid' in deps ? deps.uid : process.getuid?.();
  let reaped = 0;
  for (const entry of entries) {
    const owner = SESSION_DIR.exec(entry);
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
