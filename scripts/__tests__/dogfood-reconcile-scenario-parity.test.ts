import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const entrypoints = [
  'station-dogfood-reconcile.test.ts',
  'station-dogfood-reconcile.recovery-locking.test.ts',
  'station-dogfood-reconcile.installer-static-launchd-rollback.test.ts',
  'station-dogfood-reconcile.cutover-matrix-0.test.ts',
  'station-dogfood-reconcile.cutover-matrix-1.test.ts',
  'station-dogfood-reconcile.cutover-matrix-2.test.ts',
].map((file) => `scripts/__tests__/${file}`);

const DISCOVERY_PROCESS_TIMEOUT_MS = 15_000;
const PROCESS_INTEGRATION_TEST_TIMEOUT_MS = 20_000;

describe('dogfood reconcile scenario parity', () => {
  it('preserves every scenario name and physical shard exactly once', {
    timeout: PROCESS_INTEGRATION_TEST_TIMEOUT_MS,
  }, () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const expected = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dirname,
          'station-dogfood-reconcile',
          'scenario-names.json',
        ),
        'utf8',
      ),
    ) as string[];
    const macosOnly = expected.filter(
      (name) =>
        name.includes('station-dogfood-reconcile.cutover-matrix-') ||
        name.includes('executes the installer rollback transaction for '),
    );
    expect(expected).toHaveLength(156);
    expect(macosOnly).toHaveLength(40);
    const expectedForHost =
      process.platform === 'darwin'
        ? expected
        : expected.filter((name) => !macosOnly.includes(name));
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
        'list',
        ...entrypoints,
        '--no-file-parallelism',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: DISCOVERY_PROCESS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );

    const diagnostic = [result.error?.message, result.stderr]
      .filter(Boolean)
      .join('\n');
    expect(result.status, diagnostic).toBe(0);
    // vitest's global temp-dir reclaimer logs "[vitest] reclaimed N stale
    // Station temp directories" onto the same stdout as `vitest list` whenever
    // an earlier invocation left stale dirs (station#998) — those lines are
    // runner chatter, not scenarios.
    const actual = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.startsWith('[vitest]'))
      .sort();
    expect(actual).toEqual(expectedForHost);
    expect(actual).toHaveLength(process.platform === 'darwin' ? 156 : 116);
  });
});
