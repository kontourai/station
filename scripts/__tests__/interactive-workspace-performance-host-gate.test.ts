import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

/**
 * #577: on a host that cannot produce reference evidence, the
 * interactive-workspace performance bridge spec used to provision every
 * fixture's Station and run the whole browser workload, only for the
 * evaluator to report REFERENCE_OS_MISMATCH at the end.
 *
 * This runs the real spec through Playwright's CLI, as the smoke-live suite
 * does, with `PLAYWRIGHT_BROWSERS_PATH` pointing at an empty directory: any
 * browser launch, by the spec's `browser` fixture or by the adapter child it
 * would start, fails with a missing executable. The control case proves that
 * trap is live by opting into the diagnostic run, which must try to launch.
 *
 * The reference platform is win32, where the gate admits the real workload,
 * so this proof runs only on other hosts.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC = 'tests/interactive-workspace-performance-bridge.spec.ts';
const PLAYWRIGHT_CLI = join(
  repoRoot,
  'node_modules',
  '@playwright',
  'test',
  'cli.js',
);
const PLAYWRIGHT_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = PLAYWRIGHT_TIMEOUT_MS + 30_000;

const makeTempDir = trackTempDirs();

function runSpec(extraEnv: Record<string, string> = {}) {
  const root = makeTempDir('station-iw-host-gate-');
  const browsers = join(root, 'browsers');
  mkdirSync(browsers);
  const report = join(root, 'report', 'interactive-workspace.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsers,
    STATION_E2E_OUTPUT_DIR: join(root, 'test-results'),
    STATION_PERFORMANCE_REPORT_OUTPUT: report,
    // A temp root the spec would create Station homes and fixtures under.
    TMPDIR: join(root, 'tmp'),
    ...extraEnv,
  };
  mkdirSync(env.TMPDIR!);
  if (!('STATION_PERFORMANCE_NON_REFERENCE_DIAGNOSTIC' in extraEnv))
    delete env.STATION_PERFORMANCE_NON_REFERENCE_DIAGNOSTIC;
  const result = spawnSyncBounded(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      SPEC,
      '--project=chromium',
      '--reporter=line',
      '--workers=1',
      '--retries=0',
    ],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: PLAYWRIGHT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  return {
    result,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    browsers,
    report,
    tmp: env.TMPDIR!,
  };
}

describe.skipIf(process.platform === 'win32')(
  'interactive workspace performance bridge on a non-reference host (#577)',
  () => {
    it(
      'skips the workload by name and reports NOT_VERIFIED without launching a browser',
      () => {
        const run = runSpec();

        expect(run.result.error, run.output).toBeUndefined();
        expect(run.result.status, run.output).toBe(0);
        expect(run.output).toContain('1 passed');
        expect(run.output).toContain('1 skipped');
        expect(run.output).toContain('REFERENCE_OS_MISMATCH');
        // Nothing was installed into, or launched from, the empty browser root.
        expect(readdirSync(run.browsers)).toEqual([]);
        expect(run.output).not.toMatch(/Executable doesn't exist/);
        // No Station home or fixture root was provisioned.
        expect(
          readdirSync(run.tmp).filter((entry) =>
            entry.startsWith('station-perf'),
          ),
        ).toEqual([]);
        const report = JSON.parse(readFileSync(run.report, 'utf8'));
        expect(report).toMatchObject({
          status: 'NOT_VERIFIED',
          reasonCodes: ['REFERENCE_OS_MISMATCH'],
        });
        expect(report.summary.PASS).toBe(0);
        expect(
          report.fixtures.every(
            (fixture: { status: string }) => fixture.status === 'NOT_VERIFIED',
          ),
        ).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'control: the diagnostic opt-in runs the workload, so the empty browser root is a live trap',
      () => {
        const run = runSpec({
          STATION_PERFORMANCE_NON_REFERENCE_DIAGNOSTIC: '1',
        });

        expect(run.result.status, run.output).not.toBe(0);
        expect(run.output).toMatch(/Executable doesn't exist/);
        // The gate test is skipped when the workload is admitted.
        expect(run.output).toContain('1 skipped');
        expect(existsSync(run.report)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
