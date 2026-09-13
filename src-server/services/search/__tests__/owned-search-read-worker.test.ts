/**
 * station#1707 — WHAT "READY" MEANS, AND WHEN THE READ BUDGET STARTS.
 *
 * Both properties belong to the owner module, so both are asserted against a
 * REAL `worker_threads` worker rather than a stub: a fake that resolves
 * readiness on request cannot tell you which event the owner subscribed to,
 * and that is the whole question here.
 *
 * The fixture holds its readiness sentinel — and its message handler — back
 * from its own start. Node emits `'online'` when the thread begins executing
 * JS, before a real entry module is transformed, evaluated and its database
 * opened; measured on a dev host at load ~20, `online` at 16-20ms against the
 * entry module's first signal at 56-78ms. An owner settling readiness on
 * `'online'` returns almost immediately and hands its caller a worker that
 * cannot yet answer, putting the rest of the boot back inside whatever budget
 * the caller then starts.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createOwnedSearchReadWorker } from '../owned-search-read-worker.js';

const FIXTURE = new URL(
  './fixtures/readiness-worker.fixture.mjs',
  import.meta.url,
);

const directories: string[] = [];
const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * The owner passes `owner.path` to the worker as `workerData.databasePath`,
 * which is the only channel into a fixture whose source it also chooses — so
 * the fixture's timings live in a JSON file at that path. Every case gets its
 * own, rather than sharing one mutable file.
 */
function readinessWorker(input: {
  readyDelayMs?: number;
  mode?: 'delayed' | 'throw' | 'never';
  deadlineMs?: number;
}) {
  const home = mkdtempSync(join(tmpdir(), 'station-readiness-worker-'));
  directories.push(home);
  const inputs = join(home, 'readiness-inputs.json');
  writeFileSync(
    inputs,
    JSON.stringify({
      mode: input.mode ?? 'delayed',
      readyDelayMs: input.readyDelayMs ?? 0,
    }),
  );
  const worker = createOwnedSearchReadWorker(
    { kind: 'transcript', path: inputs },
    {
      workerSourceUrl: FIXTURE,
      ...(input.deadlineMs === undefined
        ? {}
        : { deadlineMs: input.deadlineMs }),
    },
  );
  closers.push(() => worker.close());
  return worker;
}

describe('owned search read worker readiness (station#1707)', () => {
  test('readiness waits for the worker’s own sentinel, not the thread coming online', async () => {
    const readyDelayMs = 400;
    const worker = readinessWorker({ readyDelayMs });

    const started = performance.now();
    await worker.whenReady();
    const waited = performance.now() - started;

    // `online` fires within a few milliseconds of the spawn on any host, so
    // requiring most of the fixture's own delay is what separates "waited for
    // the sentinel" from "waited for the thread to exist". The margin is
    // deliberately generous: this asserts WHICH event was awaited, not how
    // fast the host is.
    expect(waited).toBeGreaterThan(readyDelayMs * 0.5);
  });

  test('a read after readiness is not charged for the start that preceded it', async () => {
    // The composed contract, and the reachable one: `runtime-search`'s
    // `run()` awaits `whenReady()` ahead of every budget, so by the time a
    // read is issued the boot is already paid. Here the start alone outlasts
    // the read deadline several times over, and the read still succeeds.
    //
    // `execute()` deliberately does NOT await readiness itself: it cannot
    // know whether its worker posts the sentinel, and the fault fixtures in
    // `./fixtures` do not. That is stated in the module and is why this case
    // drives the pair, not `execute()` alone.
    const worker = readinessWorker({ readyDelayMs: 500, deadlineMs: 300 });

    await worker.whenReady();
    const result = await worker.execute(
      (id) => JSON.stringify({ id, type: 'session-owner', threadId: 't' }),
      (value) => value as { state: string },
    );

    expect(result).toEqual({ state: 'available' });
  });

  test('an entry module that fails to load settles readiness at once, not at the bound', async () => {
    // NOT a discriminating case for the sentinel-vs-'online' choice: it
    // passes either way, because Node emits 'online' for this worker too —
    // the thread did start executing JS before the module threw. What it
    // pins is the pre-existing error/exit settle, which worker-posted
    // readiness makes load-bearing: every broken entry module now reaches
    // this path, and it must not cost a caller the full bound.
    const deadlineMs = 3_000;
    const worker = readinessWorker({ mode: 'throw', deadlineMs });

    const started = performance.now();
    await worker.whenReady();
    const waited = performance.now() - started;

    expect(waited).toBeLessThan(deadlineMs / 2);
  });

  test('a worker that never announces readiness is bounded by the deadline', async () => {
    const deadlineMs = 300;
    const worker = readinessWorker({ mode: 'never', deadlineMs });

    const started = performance.now();
    await worker.whenReady();
    const waited = performance.now() - started;

    // The bound is what ends this wait — nothing else can — so it is both
    // floor and ceiling here. Without it a caller would wait forever.
    expect(waited).toBeGreaterThanOrEqual(deadlineMs * 0.8);
    expect(waited).toBeLessThan(deadlineMs * 6);
  });
});
