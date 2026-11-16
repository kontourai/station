import { lstatSync, realpathSync, statSync } from 'node:fs';
import { lstat, readdir, rm, stat } from 'node:fs/promises';
import { getCompileCacheDir } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { createLogger } from '../../utils/logger.js';

/**
 * Node's compile cache for the built-in station-control and
 * station-knowledge MCP children.
 *
 * Node reads `NODE_COMPILE_CACHE` once, at process startup, before it parses
 * the entry point; enabling it later (`module.enableCompileCache`) cannot
 * cache a single-file bundle's own compilation. So the server sets it on the
 * exact built-in child it spawns, and the child removes it from its own
 * environment at once (`adopt-compile-cache.ts`). Measured on those bundles,
 * a warm cache starts them faster and leaves them smaller.
 *
 * The server itself gets no cache from `station start` or the desktop
 * sidecar: measured on both launches, a warm cache left it larger at rest.
 * The server still removes any inherited setting at boot
 * (`server-compile-cache.ts`), so generic child launchers never pass it to
 * third-party or user programs.
 */
const COMPILE_CACHE_ENV = 'NODE_COMPILE_CACHE';

const CACHE_PATH = ['cache', 'node-compile'] as const;

type Warn = (message: string, context: Record<string, string>) => void;

const logger = createLogger({ name: 'compile-cache' });
const warnedHomes = new Set<string>();

function warnOnce(warn: Warn | undefined, home: string, reason: string) {
  if (warnedHomes.has(home)) return;
  warnedHomes.add(home);
  (warn ?? ((message, context) => logger.warn(message, context)))(
    'Compile cache disabled: its directory under the Station home is not a plain directory',
    { home, reason },
  );
}

/**
 * The home's cache directory, `<home>/cache/node-compile`, when it is safe to
 * use; undefined (with one warning per home) when not.
 *
 * Each component below the home must be a real directory or not exist yet
 * (Node creates missing ones as directories). A symbolic link, or anything
 * else, refuses: Node and the prune would otherwise write into, or delete
 * from, the link's target, such as an operator's shared directory. The home
 * itself may be a link (it is the operator's choice of location); the cache
 * must then resolve inside the home's real path. A refused root disables
 * both the children's cache and the prune.
 */
function safeCompileCacheRoot(
  homeDir: string,
  warn?: Warn,
): string | undefined {
  const home = resolve(homeDir);
  const refuse = (reason: string) => {
    warnOnce(warn, home, reason);
    return undefined;
  };
  let realHome: string;
  try {
    if (!statSync(home).isDirectory()) return refuse('home is not a directory');
    realHome = realpathSync(home);
  } catch {
    return undefined;
  }
  let path = home;
  let realExpected = realHome;
  for (const component of CACHE_PATH) {
    path = join(path, component);
    realExpected = join(realExpected, component);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      return refuse(`${component}: ${(error as Error).message}`);
    }
    if (stats.isSymbolicLink())
      return refuse(`${component} is a symbolic link`);
    if (!stats.isDirectory()) return refuse(`${component} is not a directory`);
    try {
      if (realpathSync(path) !== realExpected)
        return refuse(`${component} resolves outside the home`);
    } catch (error) {
      return refuse(`${component}: ${(error as Error).message}`);
    }
  }
  return join(home, ...CACHE_PATH);
}

/**
 * `env` with the home's compile cache, for a child that runs one of
 * Station's own bundles and removes the setting again at its own start.
 * Unchanged when the operator disabled Node's cache
 * (`NODE_DISABLE_COMPILE_CACHE`), the home cannot be resolved, or its cache
 * directory is not a plain directory inside it: the cache is an
 * optimization. Never use it for a third-party or user program: it would
 * write its compiled code into Station's cache.
 */
export function withStationCompileCache<T extends Record<string, string>>(
  env: T,
  options: {
    resolveHome: () => string;
    parent?: NodeJS.ProcessEnv;
    warn?: Warn;
  },
): T {
  if ((options.parent ?? process.env).NODE_DISABLE_COMPILE_CACHE) return env;
  let home: string;
  try {
    home = options.resolveHome();
  } catch {
    return env;
  }
  const root = safeCompileCacheRoot(home, options.warn);
  return root ? { ...env, [COMPILE_CACHE_ENV]: root } : env;
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

/** Bytes of regular files under `path`, never following a link. */
async function treeBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    // A Dirent describes the entry itself: a link is neither, so skipped.
    if (entry.isDirectory()) total += await treeBytes(child);
    else if (entry.isFile()) total += (await lstat(child)).size;
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
 *
 * `root` has passed {@link safeCompileCacheRoot}. No link inside it is
 * followed: only real directories age out, sizes count regular files, and
 * removing a link entry (`rm`) removes the link, not its target.
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
 * cache yet, or a root that is not a plain directory in the home) is ignored
 * and resolves undefined. The root is checked when the prune runs, not when
 * it is scheduled.
 */
export function scheduleStationCompileCachePrune(
  homeDir: string,
  options: PruneOptions & {
    activeDir?: string;
    delayMs?: number;
    warn?: Warn;
  } = {},
): Promise<PruneResult | undefined> {
  const activeDir = options.activeDir ?? getCompileCacheDir();
  return new Promise((done) => {
    setTimeout(() => {
      const root = safeCompileCacheRoot(homeDir, options.warn);
      if (!root) {
        done(undefined);
        return;
      }
      // A server started with NODE_COMPILE_CACHE set by hand may be using
      // this home's cache; its own Node-version directory is spared.
      const keep =
        activeDir && dirname(resolve(activeDir)) === root
          ? basename(activeDir)
          : undefined;
      pruneStationCompileCache(root, keep, options).then(done, () =>
        done(undefined),
      );
    }, options.delayMs ?? PRUNE_DELAY_MS).unref();
  });
}
