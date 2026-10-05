import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  TRANSFER_CAPTURE_TIMEOUT_ENV as BARRIER_TIMEOUT_ENV,
  parseCaptureTimeoutMs,
} from '../lib/transfer-capture-barrier.js';
import {
  runTransferCapture,
  TRANSFER_CAPTURE_TIMEOUT_ENV,
} from '../orchestration-transfer-gate.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();

// Runs the real barrier in its own process, as the capture does, against a
// predicate that only becomes true after `slowMs`.
function runBarrier(captureTimeoutMs: number, slowMs: number) {
  const script = join(makeTempDir('transfer-barrier-'), 'barrier.mts');
  writeFileSync(
    script,
    `import { createCaptureBarrier } from ${JSON.stringify(
      join(repoRoot, 'scripts/lib/transfer-capture-barrier.ts'),
    )};
const started = performance.now();
const wait = createCaptureBarrier(${captureTimeoutMs});
try {
  await wait(() => performance.now() - started >= ${slowMs}, 'slow barrier');
  console.log('RESOLVED');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
`,
  );
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ...result, elapsedMs: Date.now() - startedAt };
}

describe('capture barrier deadline follows the configured bound', () => {
  test('the gate and the capture library name the same setting', () => {
    expect(BARRIER_TIMEOUT_ENV).toBe('STATION_TRANSFER_CAPTURE_TIMEOUT_MS');
    expect(TRANSFER_CAPTURE_TIMEOUT_ENV).toBe(BARRIER_TIMEOUT_ENV);
  });

  test('requires an explicit finite positive bound', () => {
    expect(parseCaptureTimeoutMs(' 90000 ')).toBe(90_000);
    for (const bad of [undefined, '', '0', '-1', '1.5', 'abc', 'Infinity'])
      expect(() => parseCaptureTimeoutMs(bad)).toThrow(
        'capture timeout must be a positive integer',
      );
  });

  test('a raised bound lets a barrier outlast the former fixed five seconds', () => {
    const result = runBarrier(20_000, 5_500);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('RESOLVED');
    expect(result.status).toBe(0);
  }, 60_000);

  test('a barrier that is not raised fails inside the bound and names the remedy', () => {
    const result = runBarrier(600, 60_000);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /capture barrier timed out after 300ms: slow barrier \(half of /,
    );
    expect(result.stderr).toContain(`${TRANSFER_CAPTURE_TIMEOUT_ENV}=600`);
    expect(result.stderr).toContain(
      `${TRANSFER_CAPTURE_TIMEOUT_ENV}=<milliseconds>`,
    );
    // Finite: a hung barrier still fails promptly instead of waiting forever.
    expect(result.elapsedMs).toBeLessThan(20_000);
  }, 60_000);

  test('the real capture hands the gate bound to its barriers and the FAIL line names the setting', () => {
    const preload = join(makeTempDir('transfer-clock-'), 'fast-clock.mjs');
    // Makes every barrier look long-waited, so the first barrier whose
    // predicate is not already true must time out without a real wait.
    writeFileSync(
      preload,
      `const real = performance.now.bind(performance);
performance.now = () => real() * 1000;
`,
    );
    const output = join(makeTempDir('transfer-capture-out-'), 'capture.json');
    let message = '';
    try {
      runTransferCapture({
        candidateRoot: repoRoot,
        targetRoot: repoRoot,
        output,
        baseSha: 'a'.repeat(40),
        timeout: 4_000,
        spawn: ((command: string, args: string[], options: any) => {
          // The gate's own bound is the last argument, passed explicitly.
          expect(args.at(-1)).toBe('4000');
          return spawnSync(
            command,
            ['--import', preload, ...args.slice(0, -1), '2'],
            { ...options, timeout: 180_000 },
          );
        }) as any,
      });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toMatch(
      /barrier timed out after 1ms: external retained.*STATION_TRANSFER_CAPTURE_TIMEOUT_MS=<milliseconds> \(currently 4000\)/,
    );
  }, 240_000);
});
