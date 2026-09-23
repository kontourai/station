/**
 * The polling fallback's scan runs synchronously, and in the server it runs
 * on the event loop for a folder a Project member controls (epic #2323 S3
 * security review, HIGH-1). A tree with two directory symlinks pointing at
 * their own parent used to branch the walk 2^depth until ELOOP and block the
 * process indefinitely.
 *
 * The real module runs in a worker thread, because a scan that blocks cannot
 * be interrupted from its own thread: vitest's timeout would never fire, and a
 * regression would hang the suite instead of failing it. The worker is
 * terminated at the deadline and the test fails with that reason. Node 24
 * strips the module's types natively; it imports only node builtins.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, test } from 'vitest';

const MODULE_URL = pathToFileURL(
  resolve(import.meta.dirname, '..', 'source-watch.ts'),
).href;
const DEADLINE_MS = 5_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function cycleTree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'station-watch-loop-')));
  roots.push(root);
  writeFileSync(join(root, 'index.ts'), 'export {};\n');
  mkdirSync(join(root, 'sub'));
  symlinkSync('.', join(root, 'sub', 'a'));
  symlinkSync('.', join(root, 'sub', 'b'));
  const outside = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-watch-out-')),
  );
  roots.push(outside);
  writeFileSync(join(outside, 'linked.ts'), 'export {};\n');
  symlinkSync(join(outside, 'linked.ts'), join(root, 'linked.ts'));
  return root;
}

async function scanInWorker(root: string) {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.url).then((m) => {
      const started = Date.now();
      const handle = m.watchWithFallback({
        cwd: workerData.root,
        paths: [workerData.root],
        targets: ['.'],
        onChange() {},
        pollIntervalMs: 60_000,
      });
      const elapsed = Date.now() - started;
      const status = handle.status();
      handle.close();
      parentPort.postMessage({ elapsed, status });
    }, (error) => parentPort.postMessage({ error: String(error) }));
    `,
    { eval: true, workerData: { url: MODULE_URL, root } },
  );
  try {
    return await new Promise<{
      elapsed?: number;
      status?: { pollingActive: boolean; pollingError: string | null };
      error?: string;
    }>((resolvePromise, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `the scan did not return within ${DEADLINE_MS}ms (event loop blocked)`,
            ),
          ),
        DEADLINE_MS,
      );
      worker.once('message', (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    await worker.terminate();
  }
}

describe('source-watch polling scan', () => {
  test(
    'a directory-symlink cycle does not block: the real scan returns promptly and keeps polling',
    async () => {
      const result = await scanInWorker(cycleTree());
      expect(result.error).toBeUndefined();
      expect(result.elapsed).toBeLessThan(1_000);
      // Skipping the links (rather than tripping the budget) keeps the
      // fallback on for an ordinary tree that happens to contain them.
      expect(result.status).toMatchObject({
        pollingActive: true,
        pollingError: null,
      });
    },
    DEADLINE_MS + 5_000,
  );
});
