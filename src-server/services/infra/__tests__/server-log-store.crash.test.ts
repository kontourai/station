// @vitest-environment node

/**
 * station#1895: proves the durable NDJSON sink survives a real uncaught
 * exception, not just a mocked one. Spawns a minimal node script (loaded
 * through `tsx` so it can import the real `.ts` seam/store modules
 * directly) that installs the sink, throws asynchronously, and — mirroring
 * `src-server/index.ts`'s own `uncaughtException` handler — logs a `fatal`
 * line and force-flushes before exiting. The parent process then reads the
 * store file on disk and asserts the structured line actually landed.
 *
 * This spawns a real child process, so it is classified as process-heavy in
 * `scripts/vitest-resource-manifest.mjs` (see that file's entry for this
 * path) rather than left in the ordinary four-worker group.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-log-crash-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function runCrashScriptInChild(
  directory: string,
): Promise<{ code: number | null }> {
  // Imports the REAL seam/store/crash-handlers modules through `tsx` —
  // not a hand-written replica of index.ts's wiring — so this proves the
  // actual `installCrashHandlers` + `logFatalAndFlush` code path survives
  // a real uncaught exception, matching station#1895 review round 2.
  const loggerUrl = new URL('../../../utils/logger.ts', import.meta.url).href;
  const storeUrl = new URL('../server-log-store.ts', import.meta.url).href;
  const crashHandlersUrl = new URL(
    '../../../runtime/bootstrap/crash-handlers.ts',
    import.meta.url,
  ).href;
  const script = [
    `import { createLogger } from ${JSON.stringify(loggerUrl)};`,
    `import { installServerLogSink, getInstalledServerLogSink } from ${JSON.stringify(storeUrl)};`,
    `import { installCrashHandlers } from ${JSON.stringify(crashHandlersUrl)};`,
    'const directory = process.argv[1];',
    'installServerLogSink({ directory });',
    "const logger = createLogger({ name: 'crash-test', level: 'info' });",
    'installCrashHandlers(logger, {',
    '  flushSync: () => { try { getInstalledServerLogSink()?.flushSync(); } catch {} },',
    '  onUncaughtException: () => { process.exit(1); },',
    '});',
    'setImmediate(() => { throw new Error("boom-from-crash-test"); });',
  ].join('\n');

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script, directory],
    { cwd: process.cwd(), stdio: 'ignore' },
  );

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code }));
  });
}

describe('durable sink survives a real uncaught exception', () => {
  it('lands a structured fatal line in the store file before the crashed process exits', async () => {
    const directory = createTempDir();

    const { code } = await runCrashScriptInChild(directory);
    expect(code).toBe(1);

    const files = readdirSync(directory).filter((name) =>
      /^server-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name),
    );
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(directory, files[0]), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const fatalLine = lines.find((line) => line.level === 'fatal');
    expect(fatalLine).toBeDefined();
    expect(fatalLine.msg).toBe('Uncaught exception');
    expect(fatalLine.err?.message).toBe('boom-from-crash-test');
  });
});
