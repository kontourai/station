#!/usr/bin/env node
/**
 * Run a Vitest selection against a watch layer that arms and never delivers.
 *
 * This reproduces the condition recorded in issue #970: for several hours,
 * FSEvents delivered zero directory events to any process on the host, while
 * arming a watch still *succeeded* — `fs.watch` returned a live handle,
 * chokidar's own directory scan completed, `ready` fired, and then nothing ever
 * arrived. That is not a watcher that throws, and no error surfaces anywhere;
 * a suite that waits for an event simply waits until Vitest kills it.
 *
 * The simulation is applied at the layer that actually broke. chokidar funnels
 * every native watch through one function, `createFsWatchInstance` in
 * `node_modules/chokidar/handler.js`, and that function's `fs_watch(...)` call
 * is the single point where a delivered OS notification enters the library.
 * Replacing its return value with an inert handle leaves everything else —
 * the readdir walk, the listing cache, `ready`, `getWatched()`, `close()` —
 * exactly as shipped, and removes precisely the delivery that #970 removed.
 *
 * Mocking chokidar from inside a test file cannot demonstrate this: the whole
 * question is what the *unmocked* suites do when the real library goes quiet.
 *
 * The patch is temporary and self-restoring. The original file is captured
 * before the edit and rewritten byte-for-byte in a `finally`, with a SHA-256
 * comparison printed either way, so a crashed or interrupted run still leaves
 * `node_modules` as it found it.
 *
 * Usage:
 *   node scripts/probe-dead-watch-layer.mjs <vitest args...>
 *   node scripts/probe-dead-watch-layer.mjs src-server/domain/__tests__ --maxWorkers=1
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
// chokidar's `exports` map hides `package.json`, so resolve the entry point and
// take its directory rather than asking for the manifest.
const handlerPath = join(
  dirname(require.resolve('chokidar', { paths: [repoRoot] })),
  'handler.js',
);

/** The exact `fs_watch` call chokidar 5 funnels every native watch through. */
const ARMED_CALL = `        return fs_watch(path, {
            persistent: options.persistent,
        }, handleEvent);`;

/**
 * An armed-but-silent handle. chokidar only ever calls `on('error', …)` and
 * `close()` on this object, so the inert shape is complete rather than partial:
 * the library believes the watch succeeded, because on a #970 host it had.
 */
const DEAD_CALL = `        void handleEvent;
        return {
            on() { return this; },
            close() {},
            removeAllListeners() { return this; },
            unref() { return this; },
            ref() { return this; },
        };`;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const original = readFileSync(handlerPath, 'utf8');
const originalHash = sha256(original);

if (!original.includes(ARMED_CALL)) {
  console.error(
    `[dead-watch-layer] ${handlerPath} does not contain the expected fs_watch call.\n` +
      'chokidar changed shape; update ARMED_CALL in this script before trusting the probe.',
  );
  process.exit(2);
}

const patched = original.replace(ARMED_CALL, DEAD_CALL);
let status = 1;

try {
  writeFileSync(handlerPath, patched, 'utf8');
  console.log(
    `[dead-watch-layer] patched ${handlerPath}\n` +
      `[dead-watch-layer]   before sha256 ${originalHash}\n` +
      `[dead-watch-layer]   after  sha256 ${sha256(patched)}`,
  );

  const result = spawnSync('npx', ['vitest', 'run', ...process.argv.slice(2)], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  status = result.status ?? 1;
} finally {
  writeFileSync(handlerPath, original, 'utf8');
  const restoredHash = sha256(readFileSync(handlerPath, 'utf8'));
  console.log(
    `[dead-watch-layer] restored ${handlerPath}\n` +
      `[dead-watch-layer]   restored sha256 ${restoredHash}\n` +
      `[dead-watch-layer]   byte-identical: ${restoredHash === originalHash}`,
  );
  if (restoredHash !== originalHash) {
    console.error('[dead-watch-layer] RESTORE FAILED — reinstall chokidar.');
    status = 2;
  }
}

process.exit(status);
