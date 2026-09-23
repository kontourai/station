import {
  existsSync,
  watch as fsWatch,
  lstatSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Native file watching with a bounded mtime-scan fallback.
 *
 * Moved here from the CLI's `station plugin dev` server (#970) so the in-app
 * plugin draft preview (epic #2323 S3) watches a Project folder with the same
 * mechanism rather than a second copy of it. The rationale for every constant
 * below is the CLI's, unchanged.
 */

/** How long changes are collected before one rebuild/reload fires. */
const DEBOUNCE_MS = 200;

/**
 * Gap between mtime scans of the watched tree.
 *
 * The OS notification layer can arm successfully and then deliver nothing:
 * observed on macOS with `fs.watch` recursive, `fs.watch` non-recursive, and
 * the native `fsevents` binding all silent at once on the same host (#970), and
 * the same shape appears on network filesystems and container bind mounts. The
 * dev server cannot tell that apart from "nobody has edited anything", so a
 * cheap scan runs alongside the native watcher and carries changes when native
 * events stop arriving.
 *
 * Two seconds is deliberately unhurried. This is the fallback, not the primary
 * path, and a plugin `src/` tree is a handful of files; when native events are
 * flowing the scan never triggers a rebuild at all (see `NATIVE_QUIET_MS`).
 */
export const POLL_INTERVAL_MS = 2000;

/**
 * How long native events must have been absent before a scan may trigger: two
 * poll intervals, so a healthy native watcher — which reports a change within
 * milliseconds — always wins, and the scan never doubles up on a rebuild the
 * native path already caused.
 */
const NATIVE_QUIET_FACTOR = 2;

/**
 * Upper bound on entries (files AND directories) one scan will visit. Past
 * this the fallback switches itself off and the status line says so, rather
 * than walking a large tree twice a second. A bounded fallback that admits its
 * limit beats an unbounded one.
 *
 * Directories count because a tree can be expensive without holding many
 * files: the scan is synchronous, and in a server it runs on the event loop
 * every poll interval for a folder a Project member controls.
 */
export const POLL_ENTRY_BUDGET = 2000;

/**
 * Wall-clock bound on one synchronous scan. An entry count cannot see a slow
 * filesystem (a network mount, a stalled disk), so the scan also gives up —
 * and switches the fallback off — once it has run this long.
 */
export const POLL_SCAN_TIME_BUDGET_MS = 250;

/** Bounds of the backoff before a budget-exceeded scan is retried. */
export const POLL_REARM_MIN_MS = 30_000;
export const POLL_REARM_MAX_MS = 10 * 60_000;

const POLL_BUDGET_EXCEEDED = `more than ${POLL_ENTRY_BUDGET} entries or ${POLL_SCAN_TIME_BUDGET_MS}ms per scan`;

/** Directory names never worth scanning inside a plugin source tree. */
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

export interface WatchStatus {
  /** Native `fs.watch` armed on every target without throwing. */
  nativeArmed: boolean;
  /** Native has delivered at least one usable event since startup. */
  nativeDelivered: boolean;
  /** Why native watching is unavailable, when it is. */
  nativeError: string | null;
  /** The mtime-scan fallback is running. */
  pollingActive: boolean;
  /** Why the fallback is not running, when it is not. */
  pollingError: string | null;
  /** A change has been carried by the fallback rather than by native events. */
  pollingDelivered: boolean;
}

export interface WatchHandle {
  /** Display labels for what this handle covers, e.g. `['src/']`. */
  readonly targets: string[];
  /** The scan interval this handle is actually running, in milliseconds. */
  readonly pollIntervalMs: number;
  status(): WatchStatus;
  close(): void;
}

export interface FallbackWatchOptions {
  cwd: string;
  /** Absolute paths to watch. Directories are walked; files are stat'd. */
  paths: string[];
  /** Labels for the status line. */
  targets: string[];
  /** Only relative paths this accepts count as a change. */
  accepts?: (relativePath: string) => boolean;
  onChange: (label: string) => void;
  pollIntervalMs?: number;
  /** Quiet period before a burst of changes fires once; defaults to 200ms. */
  debounceMs?: number;
  /** First retry delay after a scan exceeds its budget (tests shorten it). */
  rearmMinMs?: number;
}

/** One scan pass: relative path → last-modified time. */
type Snapshot = Map<string, number>;

/**
 * Walk `paths` recording mtimes, or return `null` when the entry or time
 * budget is exhausted. Unreadable entries are skipped: a scan is a best-effort
 * second opinion, not an authority on the tree.
 *
 * Symbolic links are never descended. A symlinked FILE is recorded by its
 * target's mtime (one stat, no recursion); a symlinked DIRECTORY is skipped.
 * Following directory links let `sub/a -> .` plus `sub/b -> .` branch the walk
 * 2^depth until ELOOP, blocking the process for as long as that took on every
 * poll. The roots in `paths` themselves are followed: the caller chose them.
 */
function scanPaths(
  cwd: string,
  paths: string[],
  accepts: (relativePath: string) => boolean,
  now: () => number = Date.now,
): Snapshot | null {
  const snapshot: Snapshot = new Map();
  let budget = POLL_ENTRY_BUDGET;
  const deadline = now() + POLL_SCAN_TIME_BUDGET_MS;

  const visit = (absolute: string, isRoot: boolean): boolean => {
    budget -= 1;
    if (budget < 0 || now() > deadline) return false;
    let stats: ReturnType<typeof statSync>;
    try {
      stats = isRoot ? statSync(absolute) : lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        const target = statSync(absolute);
        if (!target.isFile()) return true;
        stats = target;
      }
    } catch {
      return true;
    }
    if (stats.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(absolute);
      } catch {
        return true;
      }
      for (const entry of entries) {
        if (entry.startsWith('.') || SCAN_SKIP_DIRS.has(entry)) continue;
        if (!visit(join(absolute, entry), false)) return false;
      }
      return true;
    }
    if (!stats.isFile()) return true;
    const relativePath = relative(cwd, absolute);
    if (accepts(relativePath)) {
      snapshot.set(relativePath, stats.mtimeMs);
    }
    return true;
  };

  for (const path of paths) {
    if (!visit(path, true)) return null;
  }
  return snapshot;
}

/** Entries added, removed, or rewritten between two scans. */
function diffSnapshots(previous: Snapshot, next: Snapshot): string[] {
  const changed: string[] = [];
  for (const [path, mtime] of next) {
    const before = previous.get(path);
    if (before === undefined || before !== mtime) changed.push(path);
  }
  for (const path of previous.keys()) {
    if (!next.has(path)) changed.push(path);
  }
  return changed;
}

/**
 * Watch `paths` with the OS notification layer *and* a low-frequency mtime
 * scan, so a watch layer that arms and then delivers nothing still produces
 * rebuilds. The returned handle reports which mechanism is actually carrying
 * changes, so callers never have to claim more than they know.
 */
export function watchWithFallback({
  cwd,
  paths,
  targets,
  accepts = () => true,
  onChange,
  pollIntervalMs = POLL_INTERVAL_MS,
  debounceMs = DEBOUNCE_MS,
  rearmMinMs = POLL_REARM_MIN_MS,
}: FallbackWatchOptions): WatchHandle {
  const watchers: { close: () => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const status: WatchStatus = {
    nativeArmed: false,
    nativeDelivered: false,
    nativeError: null,
    pollingActive: false,
    pollingError: null,
    pollingDelivered: false,
  };

  if (paths.length === 0) {
    return {
      targets,
      pollIntervalMs,
      status: () => ({ ...status }),
      close: () => {},
    };
  }

  let lastNativeEventAt = 0;

  const trigger = (label: string) => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange(label);
    }, debounceMs);
  };

  // ── Native notifications ──
  try {
    for (const path of paths) {
      const isDir = existsSync(path) && statSync(path).isDirectory();
      const watcher = fsWatch(
        path,
        isDir ? { recursive: true } : {},
        (_event, filename) => {
          // Any callback at all proves the notification layer is live, even
          // when the filename is filtered out below.
          lastNativeEventAt = Date.now();
          const label = filename || relative(cwd, path);
          if (!label || label.startsWith('.')) return;
          if (!accepts(label)) return;
          status.nativeDelivered = true;
          trigger(label);
        },
      );
      watchers.push(watcher);
    }
    status.nativeArmed = true;
  } catch (err: any) {
    status.nativeError = err?.message || String(err);
    for (const watcher of watchers.splice(0)) {
      try {
        watcher.close();
      } catch {
        // A watcher that will not close is not worth failing startup over.
      }
    }
  }

  // ── mtime fallback ──
  // A scan that exceeds its budget turns polling off, but not forever: the
  // tree may shrink, or the slow disk recover. It is retried after a backoff
  // that doubles up to POLL_REARM_MAX_MS, and polling resumes when a scan
  // fits again. `status.pollingError` says why it is off meanwhile.
  let snapshot: Snapshot | null = null;
  let rearm: ReturnType<typeof setTimeout> | null = null;
  let rearmDelay = Math.max(rearmMinMs, pollIntervalMs * 15);

  const stopPolling = () => {
    status.pollingActive = false;
    status.pollingError = POLL_BUDGET_EXCEEDED;
    if (poller) clearInterval(poller);
    poller = null;
    rearm = setTimeout(() => {
      rearm = null;
      if (!closed) startPolling();
    }, rearmDelay);
    rearm.unref?.();
    rearmDelay = Math.min(rearmDelay * 2, POLL_REARM_MAX_MS);
  };

  const startPolling = () => {
    const first = scanPaths(cwd, paths, accepts);
    if (first === null) {
      stopPolling();
      return;
    }
    // Anything that changed while polling was off is a change now.
    const changedWhileOff = snapshot ? diffSnapshots(snapshot, first) : [];
    snapshot = first;
    status.pollingActive = true;
    status.pollingError = null;
    if (changedWhileOff.length > 0) trigger(changedWhileOff[0]);
    poller = setInterval(() => {
      if (closed) return;
      const next = scanPaths(cwd, paths, accepts);
      if (next === null) {
        stopPolling();
        return;
      }
      const previous = snapshot ?? next;
      const changed = diffSnapshots(previous, next);
      snapshot = next;
      if (changed.length === 0) return;
      // Native is live and has already reported this; don't rebuild twice.
      if (Date.now() - lastNativeEventAt < pollIntervalMs * NATIVE_QUIET_FACTOR)
        return;
      status.pollingDelivered = true;
      trigger(changed[0]);
    }, pollIntervalMs);
    // A dev-mode convenience is never a reason to hold the process open.
    poller.unref();
  };
  startPolling();

  return {
    targets,
    pollIntervalMs,
    status: () => ({ ...status }),
    close: () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (poller) {
        clearInterval(poller);
        poller = null;
      }
      if (rearm) {
        clearTimeout(rearm);
        rearm = null;
      }
      for (const watcher of watchers.splice(0)) {
        try {
          watcher.close();
        } catch {
          // Already gone; nothing to recover.
        }
      }
    },
  };
}
