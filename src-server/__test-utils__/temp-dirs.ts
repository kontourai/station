import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';

/**
 * Temp directories that remove themselves (#2421).
 *
 * A bare `mkdtempSync(join(tmpdir(), 'x-'))` in a test is a leak unless every
 * path through the test reaches a matching `rm` — and cleanup written in the
 * test body is skipped whenever an assertion fails first. Across dozens of
 * agent worktrees that added up to ~160k stale entries (~39 GB) in the
 * per-user temp dir. This registers the cleanup when the tracker is created,
 * in a vitest hook, so it runs whether the test passed or not.
 *
 * Call it at collection time (module top level or a `describe` body), then
 * create directories from tests or `beforeEach`/`beforeAll`:
 *
 *     const makeTempDir = trackTempDirs();
 *     beforeEach(() => { home = makeTempDir('station-x-'); });
 *
 * `lifetime: 'file'` removes at `afterAll` of the enclosing scope (the
 * `describe`, or the file at top level) instead, for directories a
 * `beforeAll` shares across the tests in that scope. The directory stays in
 * `os.tmpdir()` with the caller's prefix, exactly where the raw call put it.
 *
 * Two things this does not handle:
 * - `test.concurrent`: one tracker's list is shared, so a test's afterEach
 *   would remove a sibling's directory while it still runs.
 * - Hook order: vitest runs after-hooks in reverse registration order, so a
 *   tracker created BEFORE a "close the server" hook removes its directories
 *   AFTER that hook runs. Create the tracker first when a directory must
 *   outlive something that uses it.
 *
 * `scripts/test-temp-dir-ratchet.mjs` holds raw `mkdtemp` calls in test files
 * under the scanned roots at or below a per-file baseline, so new temp dirs
 * route through here.
 */
export function trackTempDirs(
  options: { lifetime?: 'test' | 'file' } = {},
): (prefix: string) => string {
  const created: string[] = [];
  const cleanup = () => removeTempDirs(created.splice(0));
  if (options.lifetime === 'file') afterAll(cleanup);
  else afterEach(cleanup);
  return (prefix) => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    created.push(directory);
    return directory;
  };
}

/**
 * Every directory is attempted even when one fails to go, so one stuck tree
 * cannot leak its siblings; the failures are thrown together at the end.
 */
export function removeTempDirs(
  directories: readonly string[],
  remove: (directory: string) => void = removeTempDir,
): void {
  const errors: unknown[] = [];
  for (const directory of directories) {
    try {
      remove(directory);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      `${errors.length} temp dirs were not removed`,
    );
}

/**
 * `force` only suppresses ENOENT. A test that made part of its tree
 * read-only (to exercise a write failure) makes the first attempt fail —
 * reported as ENOTEMPTY rather than EACCES once retries are on — and would
 * leak the directory it was meant to remove. So restore write permission and
 * try once more; a second failure is real and is thrown.
 */
function removeTempDir(directory: string): void {
  try {
    // Retries cover Windows, where a handle a test has not yet released
    // (SQLite, a watcher) briefly holds the tree with EBUSY/EPERM.
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    restoreWritable(directory);
    rmSync(directory, { recursive: true, force: true });
  }
}

function restoreWritable(directory: string): void {
  try {
    chmodSync(directory, 0o700);
  } catch {
    return;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) restoreWritable(join(directory, entry.name));
  }
}
