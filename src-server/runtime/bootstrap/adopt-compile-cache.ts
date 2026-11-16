import { flushCompileCache, getCompileCacheDir } from 'node:module';

/**
 * For a built-in Station child given the home's compile cache
 * (`station-compile-cache.ts`): removes the setting from its own environment,
 * so nothing it starts inherits it (Node's active cache survives), and writes
 * the cache once after startup. An engine or pool may end the child with a
 * signal, after which Node writes nothing; the entries are produced as each
 * module compiles, so writing after startup stores the same cache as writing
 * at exit.
 *
 * Kept apart from the server-side module: a stdio MCP child must not load
 * the logger, whose output would share the protocol's stdout.
 */
export function adoptStationCompileCache(
  env: NodeJS.ProcessEnv = process.env,
): void {
  delete env.NODE_COMPILE_CACHE;
  if (!getCompileCacheDir()) return;
  setImmediate(() => {
    try {
      flushCompileCache();
    } catch {
      // The cache is an optimization; a failed write must not end the child.
    }
  });
}
