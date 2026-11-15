import { readdir, rm, stat } from 'node:fs/promises';
import { flushCompileCache, getCompileCacheDir } from 'node:module';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

/**
 * Node's compile cache for Station's own bundles.
 *
 * Node reads `NODE_COMPILE_CACHE` once, at process startup, before it parses
 * the entry point; enabling it later (`module.enableCompileCache`) cannot
 * cache a single-file bundle's own compilation. So a launcher sets it on the
 * Station process it starts (the desktop sidecar and `station start` use
 * `<STATION_HOME>/cache/node-compile`), and the started process removes it
 * from its own environment at once, so generic child launchers never pass it
 * to third-party or user Node programs. The server remembers the directory
 * Node is actually using and hands it, by name, only to Station's own
 * bundled children (see {@link withStationCompileCache}).
 */
const COMPILE_CACHE_ENV = 'NODE_COMPILE_CACHE';

let ownCacheRoot: string | undefined;

/**
 * Removes the launch-time cache setting from `env` and remembers it when
 * Node is using it. Node's active cache survives the removal.
 *
 * `activeDir` is what Node reports (`module.getCompileCacheDir()`): a
 * version-keyed subdirectory of the requested root, or undefined when the
 * cache is off (`NODE_DISABLE_COMPILE_CACHE=1`, an unusable directory, or no
 * setting at startup). A value that Node is not using, such as one a `.env`
 * file supplied after startup, is dropped and not forwarded.
 */
export function consumeStationCompileCacheEnv(
  env: NodeJS.ProcessEnv = process.env,
  activeDir: string | undefined = getCompileCacheDir(),
): void {
  const requested = env[COMPILE_CACHE_ENV];
  delete env[COMPILE_CACHE_ENV];
  ownCacheRoot =
    requested && activeDir && isInside(resolve(requested), resolve(activeDir))
      ? resolve(requested)
      : undefined;
}

/**
 * `env` with this process's compile cache, for a child that runs one of
 * Station's own bundles and removes the setting again at its own start.
 * Unchanged when this process has no active cache. Never use it for a
 * third-party or user program: it would write its compiled code into
 * Station's cache.
 */
export function withStationCompileCache<T extends Record<string, string>>(
  env: T,
): T {
  return ownCacheRoot ? { ...env, [COMPILE_CACHE_ENV]: ownCacheRoot } : env;
}

/**
 * For a Station child that an engine or pool may end with a signal: Node
 * otherwise writes new cache entries only on a normal exit. The entries are
 * produced when each module compiles, so writing once after startup stores
 * the same cache as writing at exit. A no-op without an active cache.
 */
export function flushStationCompileCacheAfterStartup(): void {
  if (!getCompileCacheDir()) return;
  setImmediate(() => {
    try {
      flushCompileCache();
    } catch {
      // The cache is an optimization; a failed write must not end the child.
    }
  });
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A version directory that no process has written to in this long is removed. */
const STALE_VERSION_DIR_MS = 30 * 24 * 60 * 60_000;
/** Above this total, the whole cache is removed and rebuilt by later starts. */
const MAX_COMPILE_CACHE_BYTES = 256 * 1024 * 1024;

interface PruneOptions {
  now?: number;
  maxBytes?: number;
  staleMs?: number;
}

interface PruneResult {
  removedVersionDirs: string[];
  totalBytes: number;
  clearedForSize: boolean;
}

async function treeBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await treeBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

/**
 * Bounds the cache Node never prunes itself. Node keeps one subdirectory per
 * Node version and V8 configuration, and one entry per compiled file path,
 * rewritten in place when that file changes. Old versions' subdirectories and
 * entries for bundle paths that no longer exist accumulate across updates.
 *
 * A home may be shared by processes on different Node versions (the desktop
 * app and a service), so another version's subdirectory is removed only once
 * nothing has written to it for {@link STALE_VERSION_DIR_MS}. If the cache is
 * still over {@link MAX_COMPILE_CACHE_BYTES}, it is removed whole. Removing
 * an entry costs one cold compile; Node validates each entry by checksum and
 * treats a missing one as a miss.
 */
async function pruneStationCompileCache(
  root: string,
  activeDir: string,
  options: PruneOptions = {},
): Promise<PruneResult> {
  const now = options.now ?? Date.now();
  const maxBytes = options.maxBytes ?? MAX_COMPILE_CACHE_BYTES;
  const staleMs = options.staleMs ?? STALE_VERSION_DIR_MS;
  const active = basename(activeDir);
  const removedVersionDirs: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === active) continue;
    const path = join(root, entry.name);
    if (now - (await stat(path)).mtimeMs < staleMs) continue;
    await rm(path, { recursive: true, force: true });
    removedVersionDirs.push(entry.name);
  }
  const totalBytes = await treeBytes(root);
  const clearedForSize = totalBytes > maxBytes;
  if (clearedForSize) {
    for (const entry of await readdir(root))
      await rm(join(root, entry), { recursive: true, force: true });
  }
  return { removedVersionDirs, totalBytes, clearedForSize };
}

/** The cache directory Station's launchers set for a home. */
function stationHomeCompileCacheRoot(homeDir: string): string {
  return resolve(homeDir, 'cache', 'node-compile');
}

/** Delay before the boot-time prune, to stay out of startup's way. */
const PRUNE_DELAY_MS = 60_000;

/**
 * Prunes this process's cache once, after startup has settled, and only when
 * it is the home's own Station cache: an operator who pointed
 * `NODE_COMPILE_CACHE` at a cache of their own keeps it untouched.
 * Best-effort: the cache is an optimization, so a failure is ignored.
 * Resolves with what was pruned; undefined when there is nothing of this
 * home's to prune.
 */
export function scheduleStationCompileCachePrune(
  homeDir: string,
  options: PruneOptions & { activeDir?: string; delayMs?: number } = {},
): Promise<PruneResult | undefined> | undefined {
  const root = ownCacheRoot;
  const activeDir = options.activeDir ?? getCompileCacheDir();
  if (
    !root ||
    !activeDir ||
    root !== stationHomeCompileCacheRoot(homeDir) ||
    dirname(resolve(activeDir)) !== root
  )
    return undefined;
  return new Promise((done) => {
    setTimeout(() => {
      pruneStationCompileCache(root, activeDir, options).then(done, () =>
        done(undefined),
      );
    }, options.delayMs ?? PRUNE_DELAY_MS).unref();
  });
}
