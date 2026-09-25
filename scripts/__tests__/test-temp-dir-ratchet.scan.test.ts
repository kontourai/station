/**
 * The real-tree half of `test-temp-dir-ratchet.test.ts`, moved here unchanged
 * (#2176) so the `repo-scans` pull-request job can run it: both tests read
 * the tracked test files under the scan roots, which no import edge connects
 * to this test.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  countFiles,
  evaluate,
  listScannedFiles,
  SCOPE_SENTINELS,
} from '../test-temp-dir-ratchet.mjs';

describe('test temp-dir ratchet scope honesty', () => {
  test('the scanned set is the tracked test files under the scan roots', () => {
    // Independent re-derivation, so a bug in the gate's lister cannot agree
    // with itself (station#1559 class).
    const tracked = execFileSync(
      'git',
      [
        'ls-files',
        '--',
        'src-server',
        'src-shared',
        'src-ui',
        'packages',
        'scripts',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
      .split('\n')
      .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
      .filter((file) => /(^|\/)__tests__\/|\.(test|spec)\./.test(file));
    const scanned = new Set(listScannedFiles());
    for (const file of tracked) expect(scanned.has(file)).toBe(true);
    for (const sentinel of SCOPE_SENTINELS)
      expect(scanned.has(sentinel)).toBe(true);
  });

  test('this repository is within its checked-in baseline', () => {
    const files = listScannedFiles();
    const baseline = JSON.parse(
      readFileSync('scripts/test-temp-dir-baseline.json', 'utf8'),
    );
    // `under` is deliberately not asserted: the gate lets a count fall below
    // its row (see the script's header), because a sibling that removes a call
    // must not fail the next queued pull request. Only growth is a failure.
    expect(evaluate(countFiles(files), files, baseline)).toMatchObject({
      over: [],
      missingSentinels: [],
      ok: true,
    });
  });
});
