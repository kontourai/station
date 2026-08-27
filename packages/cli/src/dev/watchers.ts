import { existsSync, watch as fsWatch, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';

interface WatchSourceChangesContext {
  cwd: string;
  onRebuild: (filename: string) => Promise<void>;
  /** Scan interval override; the seam tests use to avoid real-time waits. */
  pollIntervalMs?: number;
}

interface WatchConfigChangesContext {
  cwd: string;
  manifest: PluginManifest;
  layoutPath: string | null;
  onReload: (label: string) => void;
  /** Scan interval override; the seam tests use to avoid real-time waits. */
  pollIntervalMs?: number;
}

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
 * Upper bound on files one scan will stat. Past this the fallback switches
 * itself off and the status line says so, rather than walking a large tree
 * twice a second. A bounded fallback that admits its limit beats an unbounded
 * one.
 */
export const POLL_ENTRY_BUDGET = 2000;

/** Directory names never worth scanning inside a plugin source tree. */
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css'];

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

interface FallbackWatchOptions {
  cwd: string;
  /** Absolute paths to watch. Directories are walked; files are stat'd. */
  paths: string[];
  /** Labels for the status line. */
  targets: string[];
  /** Only relative paths this accepts count as a change. */
  accepts?: (relativePath: string) => boolean;
  onChange: (label: string) => void;
  pollIntervalMs?: number;
}

/** One scan pass: relative path → last-modified time. */
type Snapshot = Map<string, number>;

/**
 * Walk `paths` recording mtimes, or return `null` when the entry budget is
 * exhausted. Unreadable entries are skipped: a scan is a best-effort second
 * opinion, not an authority on the tree.
 */
function scanPaths(
  cwd: string,
  paths: string[],
  accepts: (relativePath: string) => boolean,
): Snapshot | null {
  const snapshot: Snapshot = new Map();
  let budget = POLL_ENTRY_BUDGET;

  const visit = (absolute: string): boolean => {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absolute);
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
        if (!visit(join(absolute, entry))) return false;
      }
      return true;
    }
    budget -= 1;
    if (budget < 0) return false;
    const relativePath = relative(cwd, absolute);
    if (accepts(relativePath)) {
      snapshot.set(relativePath, stats.mtimeMs);
    }
    return true;
  };

  for (const path of paths) {
    if (!visit(path)) return null;
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
function watchWithFallback({
  cwd,
  paths,
  targets,
  accepts = () => true,
  onChange,
  pollIntervalMs = POLL_INTERVAL_MS,
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
    }, DEBOUNCE_MS);
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
  let snapshot = scanPaths(cwd, paths, accepts);
  if (snapshot === null) {
    status.pollingError = `more than ${POLL_ENTRY_BUDGET} files`;
  } else {
    status.pollingActive = true;
    poller = setInterval(() => {
      if (closed) return;
      const next = scanPaths(cwd, paths, accepts);
      if (next === null) {
        status.pollingActive = false;
        status.pollingError = `more than ${POLL_ENTRY_BUDGET} files`;
        if (poller) clearInterval(poller);
        poller = null;
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
  }

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

export function watchSourceChanges({
  cwd,
  onRebuild,
  pollIntervalMs,
}: WatchSourceChangesContext): WatchHandle {
  const srcDir = join(cwd, 'src');
  const paths = existsSync(srcDir) ? [srcDir] : [];
  return watchWithFallback({
    cwd,
    paths,
    targets: paths.length > 0 ? ['src/'] : [],
    accepts: (relativePath) =>
      SOURCE_EXTENSIONS.includes(extname(relativePath)),
    onChange: (label) => {
      void onRebuild(label);
    },
    pollIntervalMs,
  });
}

export function getConfigWatchTargets(
  cwd: string,
  manifest: PluginManifest,
  layoutPath: string | null,
) {
  const configDirs: string[] = [];
  if (layoutPath) {
    configDirs.push(layoutPath);
  }
  if (manifest.prompts?.source) {
    const promptsDir = join(cwd, manifest.prompts.source);
    if (existsSync(promptsDir)) {
      configDirs.push(promptsDir);
    }
  }
  for (const agent of manifest.agents || []) {
    const agentPath = join(cwd, agent.source);
    if (existsSync(agentPath)) {
      configDirs.push(agentPath);
    }
  }
  return configDirs;
}

export function watchConfigChanges({
  cwd,
  manifest,
  layoutPath,
  onReload,
  pollIntervalMs,
}: WatchConfigChangesContext): WatchHandle {
  const configDirs = getConfigWatchTargets(cwd, manifest, layoutPath);
  return watchWithFallback({
    cwd,
    paths: configDirs,
    targets: configDirs.map((dir) => relative(cwd, dir)),
    onChange: onReload,
    pollIntervalMs,
  });
}

/**
 * The watch lines the dev server prints, or `[]` when there is nothing to say.
 *
 * These state the mechanism actually in use rather than asserting that watching
 * works. A status line claiming a capability nobody verified is the defect this
 * exists to avoid (#970).
 */
export function describeWatchStatus(handles: WatchHandle[]): string[] {
  const covered = handles.filter((handle) => handle.targets.length > 0);
  const targets = covered.flatMap((handle) => handle.targets);
  if (targets.length === 0) return [];

  const statuses = covered.map((handle) => handle.status());
  const nativeArmed = statuses.every((status) => status.nativeArmed);
  const pollingActive = statuses.every((status) => status.pollingActive);
  const list = targets.join(', ');
  const seconds = Math.max(...covered.map((h) => h.pollIntervalMs)) / 1000;
  const nativeReason =
    statuses.find((status) => status.nativeError)?.nativeError ||
    'reason unavailable';
  const pollingReason =
    statuses.find((status) => status.pollingError)?.pollingError ||
    'reason unavailable';

  if (!nativeArmed && !pollingActive) {
    return [
      `   Not watching ${list} — file watching is unavailable (${nativeReason}).`,
      '   Edits will not rebuild; restart the dev server to pick them up.',
    ];
  }
  if (!nativeArmed) {
    return [
      `   Watching: ${list} (polling every ${seconds}s — native file watching is unavailable: ${nativeReason})`,
    ];
  }
  // Armed is not the same as delivering. Once the scan is demonstrably the only
  // thing carrying changes, stop crediting the native path.
  const nativeDelivered = statuses.some((status) => status.nativeDelivered);
  const pollingDelivered = statuses.some((status) => status.pollingDelivered);
  if (pollingDelivered && !nativeDelivered) {
    return [
      `   Watching: ${list} (polling every ${seconds}s — no native file events have arrived)`,
    ];
  }
  if (!pollingActive) {
    return [
      `   Watching: ${list} (native file events; polling fallback off — ${pollingReason})`,
    ];
  }
  return [
    `   Watching: ${list} (native file events, ${seconds}s polling fallback)`,
  ];
}

/**
 * Said once, the first time a change arrives via the fallback instead of via
 * native events. Without it the operator sees only that rebuilds feel slow, and
 * never learns their OS watch layer went quiet.
 */
export function fallbackNotice(handles: WatchHandle[]): string | null {
  const fallbackHandles = handles.filter((handle) => {
    const status = handle.status();
    return status.pollingDelivered && !status.nativeDelivered;
  });
  if (fallbackHandles.length === 0) return null;
  const seconds =
    Math.max(...fallbackHandles.map((handle) => handle.pollIntervalMs)) / 1000;
  return `   ⚠ No native file events have arrived — changes are being picked up by the ${seconds}s polling fallback.`;
}
