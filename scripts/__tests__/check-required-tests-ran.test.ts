/**
 * #4772: `scripts/check-required-tests-ran.mjs`, run as a child process, the
 * way the hosted macOS lane runs it.
 *
 * Fixtures are real Vitest JSON reports (`--reporter=json`), with only the
 * checkout path replaced by `/station`:
 * - `seatbelt-process-macos.report.json`: `seatbelt.process.test.ts` run on a
 *   macOS host where `sandbox-exec` applies the production profile (51 passed).
 * - `vitest-statuses.report.json`: a throwaway file with a `describe.skipIf`
 *   suite, a `test.skipIf`, a `ctx.skip()`, a failure and a `test.todo`, so
 *   the statuses the reporter writes for each are read from a real run.
 * Known-bad seatbelt cases are copies of the real report with one result
 * changed, so they keep the reporter's exact shape.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CHECK = join(ROOT, 'scripts/check-required-tests-ran.mjs');
const PROFILES = join(ROOT, 'scripts/required-test-profiles.json');
const FIXTURES = join(ROOT, 'scripts/__tests__/fixtures/required-tests-ran');
const SEATBELT_FILE =
  'src-server/security/confinement/__tests__/seatbelt.process.test.ts';
const SUITE = 'Seatbelt profile under the real kernel';
const MUST_PASS_TITLE =
  'a write in the workspace is allowed; a write outside it is denied';
const MAY_SKIP_TITLE =
  'the login Keychain is unreachable through the security tool';

const makeTempDir = trackTempDirs({ lifetime: 'file' });

type AssertionResult = {
  ancestorTitles: string[];
  title: string;
  status: string;
};
type Report = {
  testResults: { name: string; assertionResults: AssertionResult[] }[];
};

function seatbeltReport(): Report {
  return JSON.parse(
    readFileSync(join(FIXTURES, 'seatbelt-process-macos.report.json'), 'utf8'),
  );
}

function results(report: Report): AssertionResult[] {
  return report.testResults[0].assertionResults;
}

function withTitle(report: Report, title: string): AssertionResult {
  const found = results(report).filter((result) => result.title === title);
  expect(found).toHaveLength(1);
  return found[0];
}

function writeReport(contents: unknown): string {
  const path = join(makeTempDir('required-tests-report-'), 'report.json');
  writeFileSync(
    path,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
  return path;
}

function check(
  report: string,
  { profile = 'seatbelt-kernel', profiles = PROFILES } = {},
) {
  const result = spawnSync(
    process.execPath,
    [
      CHECK,
      '--profile',
      profile,
      '--report',
      report,
      '--root',
      '/station',
      '--profiles',
      profiles,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
  expect(result.error).toBeUndefined();
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const id = (title: string) => `${SEATBELT_FILE} > ${SUITE} > ${title}`;

describe('the seatbelt-kernel profile over a real macOS report', () => {
  test('passes when every pinned leg ran and passed', () => {
    const result = check(join(FIXTURES, 'seatbelt-process-macos.report.json'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      '[required-tests] OK: profile "seatbelt-kernel": 50 passed, 0 allowed runtime skip(s), 1 not required',
    );
  });

  test('fails and names a must-pass leg that was skipped', () => {
    const report = seatbeltReport();
    withTitle(report, MUST_PASS_TITLE).status = 'skipped';
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `skipped, and must not skip: ${id(MUST_PASS_TITLE)}`,
    );
    expect(result.stderr).toContain('1 of 50 required test(s)');
  });

  test('fails and names a leg that is absent from the report', () => {
    const report = seatbeltReport();
    report.testResults[0].assertionResults = results(report).filter(
      (result) => result.title !== MUST_PASS_TITLE,
    );
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`absent: ${id(MUST_PASS_TITLE)}`);
  });

  test('fails and names a leg that failed', () => {
    const report = seatbeltReport();
    withTitle(report, MUST_PASS_TITLE).status = 'failed';
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`failed: ${id(MUST_PASS_TITLE)}`);
  });

  test('fails when the leg was renamed, even by one character', () => {
    const report = seatbeltReport();
    withTitle(report, MUST_PASS_TITLE).title = `${MUST_PASS_TITLE}.`;
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`absent: ${id(MUST_PASS_TITLE)}`);
  });

  test('fails on a host that skipped the whole suite, naming every leg', () => {
    // What a Linux runner writes: same titles, every one skipped.
    const report = seatbeltReport();
    for (const result of results(report)) result.status = 'skipped';
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    // 48 must-pass legs fail; the two runtime-skip legs are allowed.
    expect(result.stderr).toContain('48 of 50 required test(s)');
    expect(result.stderr).toContain(
      `skipped, and must not skip: ${id('the probe ran the production profile, not a stand-in')}`,
    );
  });

  test('fails a narrowed selection that collected none of the legs', () => {
    const result = check(writeReport({ ...seatbeltReport(), testResults: [] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('50 of 50 required test(s)');
  });

  test('fails when the same file ran from another root', () => {
    // The id is the file relative to --root; a report from elsewhere is absent.
    const report = seatbeltReport();
    report.testResults[0].name = `/elsewhere/${SEATBELT_FILE}`;
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('50 of 50 required test(s)');
  });

  test('allows a runtime skip of a leg the profile marks mayRuntimeSkip, and says so', () => {
    const report = seatbeltReport();
    withTitle(report, MAY_SKIP_TITLE).status = 'skipped';
    const result = check(writeReport(report));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `skipped at runtime (allowed by the profile): ${id(MAY_SKIP_TITLE)}`,
    );
    expect(result.stdout).toContain('49 passed, 1 allowed runtime skip(s)');
  });

  test('still fails a mayRuntimeSkip leg that failed', () => {
    const report = seatbeltReport();
    withTitle(report, MAY_SKIP_TITLE).status = 'failed';
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`failed: ${id(MAY_SKIP_TITLE)}`);
  });

  test('fails a leg that appears twice rather than picking one', () => {
    const report = seatbeltReport();
    results(report).push({
      ...withTitle(report, MUST_PASS_TITLE),
      status: 'skipped',
    });
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `ambiguous (2 results: passed, skipped): ${id(MUST_PASS_TITLE)}`,
    );
  });

  test('ignores an unrelated skipped test', () => {
    const report = seatbeltReport();
    report.testResults.push({
      name: '/station/scripts/__tests__/unrelated.test.ts',
      assertionResults: [
        { ancestorTitles: [SUITE], title: 'unrelated', status: 'skipped' },
      ],
    });
    results(report).push({
      ancestorTitles: [SUITE],
      title: 'a leg the profile does not name',
      status: 'skipped',
    });
    const result = check(writeReport(report));
    expect(result.status).toBe(0);
  });
});

describe('an unusable report fails closed', () => {
  test.each([
    ['missing', () => join(makeTempDir('required-tests-none-'), 'none.json')],
    ['empty', () => writeReport('')],
    ['not JSON', () => writeReport('{"testResults": [')],
    ['without testResults', () => writeReport({ success: true })],
    [
      'with a result lacking its status',
      () => {
        const report = seatbeltReport();
        delete (results(report)[0] as Partial<AssertionResult>).status;
        return writeReport(report);
      },
    ],
  ])('a %s report exits 2', (_label, report) => {
    const result = check(report());
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^\[required-tests\] FAIL: report /);
  });

  test('an unknown profile exits 2', () => {
    const result = check(join(FIXTURES, 'seatbelt-process-macos.report.json'), {
      profile: 'no-such-profile',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no profile named "no-such-profile"');
  });

  test('a profile that lists a test twice exits 2', () => {
    const profiles = join(makeTempDir('required-tests-profile-'), 'p.json');
    const titles = [SUITE, MUST_PASS_TITLE];
    writeFileSync(
      profiles,
      JSON.stringify({
        twice: {
          description: 'x',
          files: {
            [SEATBELT_FILE]: {
              mustPass: [titles],
              mayRuntimeSkip: [{ test: titles, reason: 'x' }],
              notRequired: [],
            },
          },
        },
      }),
    );
    const result = check(join(FIXTURES, 'seatbelt-process-macos.report.json'), {
      profile: 'twice',
      profiles,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('listed twice');
  });
});

describe('statuses read from a real run of every skip form', () => {
  const STATUS_FILE = 'scripts/__tests__/zz-scratch-4772/shape.test.ts';

  function profileFor(entry: Record<string, unknown>): string {
    const profiles = join(makeTempDir('required-tests-profile-'), 'p.json');
    writeFileSync(
      profiles,
      JSON.stringify({
        shapes: {
          description: 'x',
          files: {
            [STATUS_FILE]: { mayRuntimeSkip: [], notRequired: [], ...entry },
          },
        },
      }),
    );
    return profiles;
  }

  const shapes = join(FIXTURES, 'vitest-statuses.report.json');

  test.each([
    ['a describe.skipIf suite', ['a skipped suite', 'inside a skipped suite']],
    ['a test.skipIf', ['a running suite', 'skipped by skipIf']],
    ['a ctx.skip()', ['a running suite', 'skipped at runtime']],
  ])('%s fails a must-pass id', (_label, titles) => {
    const result = check(shapes, {
      profile: 'shapes',
      profiles: profileFor({ mustPass: [titles] }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `skipped, and must not skip: ${STATUS_FILE} > ${titles.join(' > ')}`,
    );
  });

  test('a todo is not a pass', () => {
    const result = check(shapes, {
      profile: 'shapes',
      profiles: profileFor({ mustPass: [['a running suite', 'a todo']] }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `todo: ${STATUS_FILE} > a running suite > a todo`,
    );
  });

  test('a passing id passes beside skipped and failing neighbours', () => {
    const result = check(shapes, {
      profile: 'shapes',
      profiles: profileFor({
        mustPass: [['a running suite', 'passes']],
        mayRuntimeSkip: [
          { test: ['a running suite', 'skipped at runtime'], reason: 'x' },
        ],
      }),
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('the pinned profile agrees with the real test file', () => {
  test('every pinned id is collected from seatbelt.process.test.ts on this host', {
    timeout: 120_000,
  }, () => {
    // A filtered run collects every registered test, skipped or not, without
    // running a body or hook. `vitest list` is not used: it omits tests under
    // a skipped describe, which is every leg here on a non-macOS host.
    const report = join(makeTempDir('required-tests-collect-'), 'report.json');
    const run = spawnSync(
      process.execPath,
      [
        join(ROOT, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--root',
        ROOT,
        SEATBELT_FILE,
        '--testNamePattern=(?!)',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 110_000, windowsHide: true },
    );
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    expect(run.error, output).toBeUndefined();
    expect(run.status, output).toBe(0);
    const collected: Report = JSON.parse(readFileSync(report, 'utf8'));
    const statuses = collected.testResults.flatMap((file) =>
      file.assertionResults.map((result) => result.status),
    );
    // Nothing ran, and the file was collected at all.
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set(['skipped']));

    // Every pinned id present: rewrite the collected report as passed and
    // let the real check decide, so this agrees with how the lane matches.
    for (const file of collected.testResults)
      for (const result of file.assertionResults) result.status = 'passed';
    const rewritten = writeReport(collected);
    const result = spawnSync(
      process.execPath,
      [CHECK, '--profile', 'seatbelt-kernel', '--report', rewritten],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000, windowsHide: true },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
