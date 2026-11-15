import { readdir, rm, stat } from 'node:fs/promises';
import { flushCompileCache, getCompileCacheDir } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Node's compile cache for the built-in station-control and
 * station-knowledge MCP children.
 *
 * Node reads `NODE_COMPILE_CACHE` once, at process startup, before it parses
 * the entry point; enabling it later (`module.enableCompileCache`) cannot
 * cache a single-file bundle's own compilation. So the server sets it on the
 * exact built-in child it spawns, and the child removes it from its own
 * environment at once. Measured on those bundles, a warm cache starts them
 * faster and leaves them smaller.
 *
 * The server itself gets no cache from `station start`: measured on the
 * supervised server, a warm cache left it larger at rest and did not start
 * it measurably faster. The server still removes any inherited setting at
 * boot (`server-compile-cache.ts`), so generic child launchers never pass it
 * to third-party or user programs.
 */
const COMPILE_CACHE_ENV = 'NODE_COMPILE_CACHE';

/** The cache directory for a home's Station processes. */
function stationHomeCompileCacheRoot(homeDir: string): string {
  return resolve(homeDir, 'cache', 'node-compile');
}

/**
 * `env` with the home's compile cache, for a child that runs one of
 * Station's own bundles and removes the setting again at its own start.
 * Unchanged when the operator disabled Node's cache
 * (`NODE_DISABLE_COMPILE_CACHE`) or the home cannot be resolved: the cache is
 * an optimization. Never use it for a third-party or user program: it would
 * write its compiled code into Station's cache.
 */
export function withStationCompileCache<T extends Record<string, string>>(
  env: T,
  resolveHome: () => string,
  parent: NodeJS.ProcessEnv = process.env,
): T {
  if (parent.NODE_DISABLE_COMPILE_CACHE) return env;
  let root: string;
  try {
    root = stationHomeCompileCacheRoot(resolveHome());
  } catch {
    return env;
  }
  return { ...env, [COMPILE_CACHE_ENV]: root };
}

/**
 * For a Station child given the cache: removes the setting from its own
 * environment, so nothing it starts inherits it (Node's active cache
 * survives), and writes the cache once after startup. An engine or pool may
 * end the child with a signal, after which Node writes nothing; the entries
 * are produced as each module compiles, so writing after startup stores the
 * same cache as writing at exit.
 */
export function adoptStationCompileCache(
  env: NodeJS.ProcessEnv = process.env,
): void {
  delete env[COMPILE_CACHE_ENV];
  if (!getCompileCacheDir()) return;
  setImmediate(() => {
    try {
      flushCompileCache();
    } catch {
      // The cache is an optimization; a failed write must not end the child.
    }
  });
}

/** A version directory that nothing has written to in this long is removed. */
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
 * Node version, V8 configuration and user, and one entry per compiled file
 * path, rewritten in place when that file changes. Old versions'
 * subdirectories and entries for bundle paths that no longer exist
 * accumulate across updates.
 *
 * A home may be shared by processes on different Node versions (the desktop
 * app and a service), so a subdirectory is removed only once nothing has
 * written to it for {@link STALE_VERSION_DIR_MS}; `keep` (the subdirectory
 * this process itself uses, if any) is never removed by age. A subdirectory
 * that is only read ages too, and costs one cold start once removed. If the
 * cache is still over {@link MAX_COMPILE_CACHE_BYTES}, it is removed whole.
 * Node validates each entry by checksum and treats a missing one as a miss.
 */
async function pruneStationCompileCache(
  root: string,
  keep: string | undefined,
  options: PruneOptions,
): Promise<PruneResult> {
  const now = options.now ?? Date.now();
  const maxBytes = options.maxBytes ?? MAX_COMPILE_CACHE_BYTES;
  const staleMs = options.staleMs ?? STALE_VERSION_DIR_MS;
  const removedVersionDirs: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === keep) continue;
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

/** Delay before the boot-time prune, to stay out of startup's way. */
const PRUNE_DELAY_MS = 60_000;

/**
 * Prunes the home's compile cache once, after startup has settled.
 * Best-effort: the cache is an optimization, so a failure (including no
 * cache yet) is ignored and resolves undefined.
 */
export function scheduleStationCompileCachePrune(
  homeDir: string,
  options: PruneOptions & { activeDir?: string; delayMs?: number } = {},
): Promise<PruneResult | undefined> {
  const root = stationHomeCompileCacheRoot(homeDir);
  const activeDir = options.activeDir ?? getCompileCacheDir();
  // The desktop sidecar's server runs with this home's cache.
  const keep =
    activeDir && dirname(resolve(activeDir)) === root
      ? basename(activeDir)
      : undefined;
  return new Promise((done) => {
    setTimeout(() => {
      pruneStationCompileCache(root, keep, options).then(done, () =>
        done(undefined),
      );
    }, options.delayMs ?? PRUNE_DELAY_MS).unref();
  });
}
