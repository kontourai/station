import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { playwrightGroup } from '../lib/playwright-failure-manifest.mjs';
import { parseJobManifest } from '../lib/qualification-failure-manifest.mjs';
import { e2eJobManifest } from '../run-e2e-suite.mjs';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();
const identity = {
  jobLabel: 'Mobile Playwright (Android viewport)',
  sourceSha: 'a'.repeat(40),
  runId: '42',
  runAttempt: '1',
};

/**
 * Run the REAL Playwright test runner on a tiny project shaped like the
 * Android suite (project `android`, testDir tests/android) and return its
 * JSON report. No browser is needed: the specs use no page fixture.
 */
async function playwright(
  specs: Record<string, string>,
  config = "export default { testDir: './tests', projects: [{ name: 'android', testDir: './tests/android' }] };\n",
) {
  const root = makeTempDir('station-playwright-manifest-');
  mkdirSync(join(root, 'tests', 'android'), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'playwright.config.mjs'), config);
  for (const [name, source] of Object.entries(specs))
    writeFileSync(join(root, name), source);
  const reportPath = join(root, 'report.json');
  let status = 0;
  try {
    await exec(
      process.execPath,
      [
        join(repo, 'node_modules/@playwright/test/cli.js'),
        'test',
        '--reporter=json',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
          CI: '1',
        },
        windowsHide: true,
      },
    );
  } catch (error) {
    status = (error as { code: number }).code;
  }
  return {
    root,
    reportPath,
    status,
    report: JSON.parse(readFileSync(reportPath, 'utf8')),
  };
}

const FAILING = `import { test, expect } from '@playwright/test';
test.describe('Android — Mobile Layout', () => {
  test('sidebar drawer is named navigation', () => { expect(1).toBe(2); });
  test('passes', () => {});
});
`;

describe('Playwright failure manifest (real runner, fixture projects)', () => {
  it('explains a run whose only failure is a named test, with its project', async () => {
    const run = await playwright({ 'tests/android/a.spec.mjs': FAILING });
    expect(run.status).toBe(1);
    const group = playwrightGroup(run.report, {
      group: 'android',
      exitStatus: run.status,
      cwd: run.root,
    });
    expect(group.failedTests).toEqual([
      {
        file: 'tests/android/a.spec.mjs',
        titlePath: [
          'Android — Mobile Layout',
          'sidebar drawer is named navigation',
        ],
        project: 'android',
      },
    ]);
    expect(group.explained).toBe(true);
  }, 60_000);

  it('does not explain an error outside any test (a spec that fails to load)', async () => {
    const run = await playwright({
      'tests/android/a.spec.mjs': FAILING,
      'tests/android/b.spec.mjs': "throw new Error('cannot load');\n",
    });
    const group = playwrightGroup(run.report, {
      group: 'android',
      exitStatus: run.status,
      cwd: run.root,
    });
    expect(group.runnerErrors.map((error) => error.kind)).toContain(
      'error-outside-tests',
    );
    expect(group.explained).toBe(false);
  }, 60_000);

  it('does not explain a global setup failure', async () => {
    const run = await playwright(
      {
        'tests/android/a.spec.mjs': FAILING,
        'setup.mjs':
          "export default () => { throw new Error('setup failed'); };\n",
      },
      "export default { globalSetup: './setup.mjs', testDir: './tests', projects: [{ name: 'android', testDir: './tests/android' }] };\n",
    );
    const group = playwrightGroup(run.report, {
      group: 'android',
      exitStatus: run.status,
      cwd: run.root,
    });
    expect(group.runnerErrors.map((error) => error.kind)).toContain(
      'error-outside-tests',
    );
    expect(group.explained).toBe(false);
  }, 60_000);

  it('does not explain a worker that exits mid-test', async () => {
    const run = await playwright({
      'tests/android/a.spec.mjs': `${FAILING}
test('crashes its worker', () => { process.exit(3); });
`,
    });
    const group = playwrightGroup(run.report, {
      group: 'android',
      exitStatus: run.status,
      cwd: run.root,
    });
    expect(group.runnerErrors.map((error) => error.kind)).toContain(
      'worker-exited',
    );
    expect(group.explained).toBe(false);
  }, 60_000);

  it('does not explain a missing or unreadable report', () => {
    expect(
      playwrightGroup(undefined, {
        group: 'android',
        exitStatus: 1,
        reportError: 'ENOENT',
      }).explained,
    ).toBe(false);
    expect(
      playwrightGroup({}, { group: 'android', exitStatus: 1 }).explained,
    ).toBe(false);
  });

  it('lists a cleanup, lease or startup failure as a runner phase that never explains', async () => {
    const run = await playwright({ 'tests/android/a.spec.mjs': FAILING });
    const runError = Object.assign(
      new Error('npx playwright test exited with 1'),
      {
        exitStatus: 1,
      },
    );
    const phase = {
      name: 'android',
      report: run.report,
      reportError: undefined,
      runError,
      exitStatus: 1,
    };
    const explained = e2eJobManifest(
      [phase],
      new AggregateError([runError], 'android'),
      {
        identity,
        cwd: run.root,
      },
    );
    expect(parseJobManifest(JSON.stringify(explained)).explained).toBe(true);
    for (const thrown of [
      new Error('E2E cleanup failed; retained lease and outputs: /tmp/x'),
      new AggregateError([runError, new Error('cleanup')], 'mixed'),
    ]) {
      const manifest = e2eJobManifest([phase], thrown, {
        identity,
        cwd: run.root,
      });
      expect(manifest.explained, thrown.message).toBe(false);
      expect(manifest.phases.at(-1)).toMatchObject({
        phase: 'e2e-runner',
        corpus: false,
      });
    }
    // Startup failed before any Playwright phase.
    expect(
      e2eJobManifest([], new Error('Station did not start'), { identity })
        .explained,
    ).toBe(false);
  }, 60_000);
});
