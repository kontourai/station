// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { STATION_SERVER_EXTERNALS } from '../../../../scripts/lib/server-build-config.mjs';
import { spawnStoreIntegrityProbe } from '../store-integrity-verification.js';

/**
 * station#3218's central claim, measured rather than asserted in prose: the
 * runtime's event loop keeps running while the store is verified.
 *
 * It is an A/B, because an absolute millisecond bound would only relocate the
 * cliff to a contention level nobody measured (`vitest-resource-manifest.mjs`,
 * station#1804). The control arm runs the SAME check in-process, so both arms
 * absorb the same host conditions and the bound the child arm is held to is
 * derived from what this run observed the synchronous version cost.
 *
 * Medians of interleaved repetitions, not single samples: a timer gap cannot
 * distinguish "the loop was blocked" from "the OS descheduled this process",
 * and on a busy host the second happens to either arm. Measured across load
 * averages from 3 to 25 on the development host, the median ratio stayed
 * between 4.6 and 19; the assertion sits at 4.
 */

const REPETITIONS = 5;
/**
 * Enough rows that the synchronous check is unambiguously longer than
 * scheduler noise (~70-120 ms on the development host). The control arm has
 * to actually stall, or the comparison has no power.
 */
const SEED_ROWS = 400_000;
/** How much less the child arm must block the loop than the in-process one. */
const MINIMUM_RESPONSIVENESS_FACTOR = 4;

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, '..', '..', '..', '..');

let workspace: string;
let bundleDir: string;
let databasePath: string;

function checkInProcess(): unknown[] {
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 5_000,
  });
  try {
    return database.prepare('PRAGMA quick_check').all();
  } finally {
    database.close();
  }
}

/** Runs `work` while sampling how late a 2 ms timer wakes. */
async function measure<T>(
  work: () => Promise<T>,
): Promise<{ maxGapMs: number; workMs: number; result: T }> {
  let last = performance.now();
  let maxGapMs = 0;
  const sampler = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 2);
  try {
    // Let the sampler settle, then discard everything it saw before the work
    // started — otherwise the first gap is this test's own scheduling.
    await new Promise((resolve) => setTimeout(resolve, 20));
    last = performance.now();
    maxGapMs = 0;
    const startedAt = performance.now();
    const result = await work();
    const workMs = performance.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { maxGapMs, workMs, result };
  } finally {
    clearInterval(sampler);
  }
}

function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[
    Math.floor(values.length / 2)
  ] as number;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'store-integrity-lag-'));
  bundleDir = join(workspace, 'dist-server');
  mkdirSync(bundleDir, { recursive: true });
  await esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    entryPoints: [
      join(repoRoot, 'src-server', 'tools', 'store-integrity-probe.ts'),
    ],
    outfile: join(bundleDir, 'store-integrity-probe.js'),
    external: STATION_SERVER_EXTERNALS,
    banner: {
      js: "import { createRequire as __stationCreateRequire } from 'node:module'; const require = __stationCreateRequire(import.meta.url);",
    },
  });

  databasePath = join(workspace, 'data', 'orchestration.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  // WAL, because that is what the runtime's writer sets (`event-store.ts`).
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT)');
  database.exec('CREATE INDEX ia ON t(a)');
  const insert = database.prepare('INSERT INTO t(a, b) VALUES (?, ?)');
  database.exec('BEGIN');
  for (let index = 0; index < SEED_ROWS; index += 1)
    insert.run(`a${index}${'x'.repeat(60)}`, `b${index}${'y'.repeat(60)}`);
  database.exec('COMMIT');
  database.close();
  // Warm the page cache once, so whichever arm runs first is not the only one
  // paying cold I/O — that alone was worth a 2x swing while shaping this.
  checkInProcess();
}, 180_000);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('the scheduled verification does not stall the runtime', () => {
  test('the probe blocks this event loop far less than the same check in-process', async () => {
    const childGaps: number[] = [];
    const inProcessGaps: number[] = [];
    const inProcessWork: number[] = [];

    for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
      const child = await measure(() =>
        spawnStoreIntegrityProbe({ moduleDir: bundleDir, databasePath }),
      );
      // The child must have actually verified the store. A probe that
      // silently did nothing — which is exactly what a mis-detected entry
      // point produced while this was being written — would look perfectly
      // responsive and prove nothing at all.
      expect(child.result.unreadable).toBeUndefined();
      expect(child.result.results[0]?.verdict).toBe('ok');
      childGaps.push(child.maxGapMs);

      const inProcess = await measure(async () => checkInProcess());
      expect(inProcess.result).toHaveLength(1);
      inProcessGaps.push(inProcess.maxGapMs);
      inProcessWork.push(inProcess.workMs);
    }

    const inProcessGap = median(inProcessGaps);
    const childGap = median(childGaps);

    // Power: the control arm has to genuinely block, or the comparison
    // below is between two numbers that are both noise.
    expect(inProcessGap).toBeGreaterThanOrEqual(median(inProcessWork) * 0.5);

    expect(childGap * MINIMUM_RESPONSIVENESS_FACTOR).toBeLessThan(inProcessGap);
  }, 120_000);
});
