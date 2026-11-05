/**
 * Preloaded (`--import`) into a Windows portable floor Vitest invocation
 * (#4626): records how each forked Vitest worker ended, its exit code or
 * signal, one JSON line per worker in `STATION_FLOOR_WORKER_EXIT_LOG`. A
 * worker that dies under a terminal suite leaves no assertion and no log of
 * its own; the parent is the only process that sees its exit status. The
 * floor keeps the file only when the invocation failed.
 *
 * Only the Vitest main process records: a worker or a test's child that
 * inherits the preload changes nothing.
 */
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const log = process.env.STATION_FLOOR_WORKER_EXIT_LOG;
if (log && basename(process.argv[1] ?? '') === 'vitest.mjs') {
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const fork = childProcess.fork;
  childProcess.fork = function recordedFork(...args) {
    const child = fork.apply(this, args);
    const startedAt = new Date().toISOString();
    child.once('exit', (code, signal) => {
      try {
        appendFileSync(
          log,
          `${JSON.stringify({
            pid: child.pid ?? null,
            module: typeof args[0] === 'string' ? basename(args[0]) : null,
            code,
            signal,
            startedAt,
            exitedAt: new Date().toISOString(),
          })}\n`,
        );
      } catch {
        // Evidence only: a failed write never changes the run.
      }
    });
    return child;
  };
  // ESM importers of `node:child_process` (Vitest's pool) see the wrapper.
  syncBuiltinESMExports();
}
