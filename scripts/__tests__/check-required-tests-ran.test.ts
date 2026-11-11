/**
 * #4772: `scripts/check-required-tests-ran.mjs`, run as a child process, the
 * way the hosted macOS lane runs it.
 *
 * Fixtures are real Vitest JSON reports (`--reporter=json`), with only the
 * checkout path replaced by `/station`:
 * - `seatbelt-process-macos.report.json`: `seatbelt.process.test.ts` run on a
 *   macOS host where `sandbox-exec` applies the production profile (51 passed).
 * - `bubblewrap-process-linux.report.json`: `bubblewrap.process.test.ts` run
 *   on a Linux kernel where `bwrap` applies the production sandbox (#4770,
 *   55 passed).
 * - `vitest-statuses.report.json`: a throwaway file with a `describe.skipIf`
 *   suite, a `test.skipIf`, a `ctx.skip()`, a failure and a `test.todo`, so
 *   the statuses the reporter writes for each are read from a real run.
 * Known-bad seatbelt cases are copies of the real report with one result
 * changed, so they keep the reporter's exact shape.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CHECK = join(ROOT, 'scripts/check-required-tests-ran.mjs');
const PROFILES = join(ROOT, 'scripts/required-test-profiles.json');
const FIXTURES = join(ROOT, 'scripts/__tests__/fixtures/required-tests-ran');
const MACOS_REPORT = join(FIXTURES, 'seatbelt-process-macos.report.json');
const WORKFLOW = join(ROOT, '.github/workflows/seatbelt-kernel.yml');
const LINUX_REPORT = join(FIXTURES, 'bubblewrap-process-linux.report.json');
const BUBBLEWRAP_WORKFLOW = join(
  ROOT,
  '.github/workflows/bubblewrap-kernel.yml',
);
const BUBBLEWRAP_FILE =
  'src-server/security/confinement/__tests__/bubblewrap.process.test.ts';
const USAGE = /^\[required-tests\] FAIL: usage: check-required-tests-ran\.mjs /;
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
  duration?: number;
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

/** As the reporter writes a test skipped before its body started. */
function skipBeforeStart(result: AssertionResult) {
  result.status = 'skipped';
  delete result.duration;
}

/** As the reporter writes a test whose body called `ctx.skip()`. */
function skipAtRuntime(result: AssertionResult) {
  expect(typeof result.duration).toBe('number');
  result.status = 'skipped';
}

function writeReport(contents: unknown): string {
  const path = join(makeTempDir('required-tests-report-'), 'report.json');
  writeFileSync(
    path,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
  return path;
}

function runCheck(args: string[]) {
  const result = spawnSync(process.execPath, [CHECK, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function check(
  report: string,
  { profile = 'seatbelt-kernel', profiles = PROFILES } = {},
) {
  return runCheck([
    '--profile-name',
    profile,
    '--report',
    report,
    '--root',
    '/station',
    '--profiles-file',
    profiles,
  ]);
}

/** One `[required-tests] FAIL:` line on stderr, nothing on stdout, no stack. */
function expectInputFailure(
  result: ReturnType<typeof runCheck>,
  message: RegExp,
) {
  expect(result.status, result.stderr).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(message);
  expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
  expect(result.stderr).not.toMatch(/\n\s+at /);
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
    skipBeforeStart(withTitle(report, MUST_PASS_TITLE));
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `skipped, and must not skip: ${id(MUST_PASS_TITLE)}`,
    );
    expect(result.stderr).toContain('1 of 50 required test(s)');
  });

  test('fails and names a must-pass leg that skipped itself at runtime', () => {
    const report = seatbeltReport();
    skipAtRuntime(withTitle(report, MUST_PASS_TITLE));
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `skipped at runtime, and must not skip: ${id(MUST_PASS_TITLE)}`,
    );
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
    // What a Linux runner writes: same titles, every one skipped unstarted.
    const report = seatbeltReport();
    for (const result of results(report)) skipBeforeStart(result);
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('50 of 50 required test(s)');
    expect(result.stderr).toContain(
      `skipped, and must not skip: ${id('the probe ran the production profile, not a stand-in')}`,
    );
    // A skip that never started is not the runtime skip the profile allows.
    expect(result.stderr).toContain(
      `skipped before it started, not at runtime: ${id(MAY_SKIP_TITLE)}`,
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
    skipAtRuntime(withTitle(report, MAY_SKIP_TITLE));
    const result = check(writeReport(report));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `skipped at runtime (allowed by the profile): ${id(MAY_SKIP_TITLE)}`,
    );
    expect(result.stdout).toContain('49 passed, 1 allowed runtime skip(s)');
  });

  test('fails a mayRuntimeSkip leg that a filter or skipped suite left out', () => {
    const report = seatbeltReport();
    skipBeforeStart(withTitle(report, MAY_SKIP_TITLE));
    const result = check(writeReport(report));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `skipped before it started, not at runtime: ${id(MAY_SKIP_TITLE)}`,
    );
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
    const copy = { ...withTitle(report, MUST_PASS_TITLE) };
    skipBeforeStart(copy);
    results(report).push(copy);
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

  test('a report path that is a directory exits 2 without a stack', () => {
    const result = check(makeTempDir('required-tests-report-dir-'));
    expectInputFailure(
      result,
      /^\[required-tests\] FAIL: report is unreadable \(EISDIR\): /,
    );
  });

  // Permission bits do not deny the owner on every host (root, Windows), so
  // this runs only where the denial was observed to take effect.
  test('a report the process may not read exits 2 without a stack', (ctx) => {
    const report = writeReport(JSON.stringify(seatbeltReport()));
    chmodSync(report, 0o000);
    let denied = false;
    try {
      readFileSync(report);
    } catch (error) {
      denied = (error as NodeJS.ErrnoException).code === 'EACCES';
    }
    if (!denied) {
      chmodSync(report, 0o600);
      ctx.skip('this host does not deny the owner a mode-000 file');
    }
    try {
      expectInputFailure(
        check(report),
        /^\[required-tests\] FAIL: report is unreadable \(EACCES\): /,
      );
    } finally {
      chmodSync(report, 0o600);
    }
  });

  // A FIFO with no writer would block the read forever; the check must refuse
  // it before reading. Windows has no mkfifo, so this runs only where one was
  // created.
  test('a report path that is a FIFO exits 2 without blocking', {
    timeout: 40_000,
  }, (ctx) => {
    const fifo = join(makeTempDir('required-tests-fifo-'), 'report.json');
    const made = spawnSync('mkfifo', [fifo], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    let isFifo = false;
    try {
      isFifo = made.status === 0 && statSync(fifo).isFIFO();
    } catch {
      isFifo = false;
    }
    if (!isFifo)
      ctx.skip(
        `could not create a FIFO on this host (mkfifo: ${made.error?.message ?? made.stderr ?? made.status})`,
      );
    // runCheck's 30 s child timeout turns a hang into result.error.
    expectInputFailure(
      check(fifo),
      /^\[required-tests\] FAIL: report is not a regular file \(a FIFO\): /,
    );
  });

  test('a missing profile file exits 2', () => {
    const result = check(join(FIXTURES, 'seatbelt-process-macos.report.json'), {
      profiles: join(makeTempDir('required-tests-none-'), 'none.json'),
    });
    expectInputFailure(
      result,
      /^\[required-tests\] FAIL: profile file not found: /,
    );
  });

  test('a profile file that is a directory exits 2 without a stack', () => {
    const result = check(join(FIXTURES, 'seatbelt-process-macos.report.json'), {
      profiles: makeTempDir('required-tests-profile-dir-'),
    });
    expectInputFailure(
      result,
      /^\[required-tests\] FAIL: profile file is unreadable \(EISDIR\): /,
    );
  });

  test.each([
    ['no arguments', []],
    ['only a report', ['--report', 'report.json']],
    ['a flag without its value', ['--profile-name']],
  ])('%s is a usage error that exits 2', (_label, args) => {
    expectInputFailure(runCheck(args), /^\[required-tests\] FAIL: /);
  });

  test('the retired name for --profile-name is refused in an otherwise passing command', () => {
    // The same command with --profile-name exits 0 (the first test above),
    // so this fails if the retired name is ever accepted as an alias again.
    expectInputFailure(
      runCheck([
        '--profile',
        'seatbelt-kernel',
        '--report',
        MACOS_REPORT,
        '--root',
        '/station',
      ]),
      USAGE,
    );
  });

  test.each([
    [
      '--report',
      [
        '--profile-name',
        'seatbelt-kernel',
        '--report',
        join(FIXTURES, 'does-not-exist.report.json'),
        '--report',
        MACOS_REPORT,
        '--root',
        '/station',
      ],
    ],
    [
      '--profile-name',
      [
        '--profile-name',
        'no-such-profile',
        '--profile-name',
        'seatbelt-kernel',
        '--report',
        MACOS_REPORT,
        '--root',
        '/station',
      ],
    ],
  ])(
    '%s given twice exits 2 even when the last value would pass',
    (flag, args) => {
      expectInputFailure(
        runCheck(args),
        new RegExp(
          `^\\[required-tests\\] FAIL: ${flag} given more than once$`,
          'm',
        ),
      );
    },
  );

  test('an unknown profile exits 2', () => {
    const result = check(join(FIXTURES, 'seatbelt-process-macos.report.json'), {
      profile: 'no-such-profile',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no profile named "no-such-profile"');
  });

  test.each([
    ['mayRuntimeSkip', 'an empty', ''],
    ['mayRuntimeSkip', 'a whitespace-only', '  '],
    ['mayRuntimeSkip', 'a numeric', 7],
    ['notRequired', 'an empty', ''],
    ['notRequired', 'a numeric', 7],
  ])('a %s entry with %s reason exits 2', (list, _label, reason) => {
    const profiles = join(makeTempDir('required-tests-profile-'), 'p.json');
    writeFileSync(
      profiles,
      JSON.stringify({
        unreasoned: {
          description: 'x',
          files: {
            [SEATBELT_FILE]: {
              mustPass: [[SUITE, MUST_PASS_TITLE]],
              mayRuntimeSkip: [],
              notRequired: [],
              [list]: [{ test: [SUITE, MAY_SKIP_TITLE], reason }],
            },
          },
        },
      }),
    );
    const result = check(join(FIXTURES, 'seatbelt-process-macos.report.json'), {
      profile: 'unreasoned',
      profiles,
    });
    expectInputFailure(
      result,
      new RegExp(`${list} needs \\{test, reason\\} with a nonempty reason`),
    );
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

describe('the hosted workflow invokes the check with arguments it accepts', () => {
  type Step = { name?: string; run?: string };
  type Workflow = { jobs: Record<string, { steps?: Step[] }> };

  test.each([
    ['seatbelt-kernel', 'macOS', WORKFLOW, MACOS_REPORT],
    ['linux-bubblewrap-kernel', 'Linux', BUBBLEWRAP_WORKFLOW, LINUX_REPORT],
  ])(
    'the %s workflow check step passes over the real %s report',
    (profile, _host, workflowFile, realReport) => {
      const workflow = load(readFileSync(workflowFile, 'utf8')) as Workflow;
      const runs = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .map((step) => step.run ?? '')
        .filter((run) => run.includes('scripts/check-required-tests-ran.mjs'));
      expect(runs, `no step in ${workflowFile} runs the check`).toHaveLength(1);
      // The step is one folded command line; split it the way the shell would
      // for plain and double-quoted words, and refuse anything fancier.
      const command = runs[0].trim();
      expect(command).not.toMatch(/[|;&<>`\n\\]|\$\(/);
      const words = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(
        (match) => match[1] ?? match[2],
      );
      expect(words.slice(0, 2)).toEqual([
        'node',
        'scripts/check-required-tests-ran.mjs',
      ]);
      expect(words).toContain(profile);
      // Only the runner's report path is replaced, by the real report the
      // workflow's test step writes; --root maps its /station checkout path.
      const args = words
        .slice(2)
        .map((word) => (word.includes('$RUNNER_TEMP') ? realReport : word));
      expect(args).toContain(realReport);
      const result = runCheck([...args, '--root', '/station']);
      expect(
        result.status,
        `the workflow's arguments ${JSON.stringify(words.slice(2))} were refused: ${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toMatch(/^\[required-tests\] OK: profile "/);
    },
  );
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
    [
      'a describe.skipIf suite',
      ['a skipped suite', 'inside a skipped suite'],
      'skipped',
    ],
    ['a test.skipIf', ['a running suite', 'skipped by skipIf'], 'skipped'],
    [
      'a ctx.skip()',
      ['a running suite', 'skipped at runtime'],
      'skipped at runtime',
    ],
  ])('%s fails a must-pass id', (_label, titles, reading) => {
    const result = check(shapes, {
      profile: 'shapes',
      profiles: profileFor({ mustPass: [titles] }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${reading}, and must not skip: ${STATUS_FILE} > ${titles.join(' > ')}`,
    );
  });

  test.each([
    ['a describe.skipIf suite', ['a skipped suite', 'inside a skipped suite']],
    ['a test.skipIf', ['a running suite', 'skipped by skipIf']],
  ])('%s is not a runtime skip', (_label, titles) => {
    const result = check(shapes, {
      profile: 'shapes',
      profiles: profileFor({
        mustPass: [['a running suite', 'passes']],
        mayRuntimeSkip: [{ test: titles, reason: 'x' }],
      }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `skipped before it started, not at runtime: ${STATUS_FILE} > ${titles.join(' > ')}`,
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
  test.each([
    // 48 must-pass + 2 may-skip + 1 not-required today.
    ['seatbelt.process.test.ts', 'seatbelt-kernel', SEATBELT_FILE, 51],
    // 52 must-pass + 3 may-skip today (#4770).
    [
      'bubblewrap.process.test.ts',
      'linux-bubblewrap-kernel',
      BUBBLEWRAP_FILE,
      55,
    ],
  ] as const)(
    'the profile classifies exactly the tests %s registers on this host',
    {
      timeout: 120_000,
    },
    (_name, profileName, testFile, registeredCount) => {
      // A filtered run collects every registered test, skipped or not, without
      // running a body or hook. `vitest list` is not used: it omits tests under
      // a skipped describe, which is every leg here on a host that cannot
      // apply the mechanism.
      const report = join(
        makeTempDir('required-tests-collect-'),
        'report.json',
      );
      const run = spawnSync(
        process.execPath,
        [
          join(ROOT, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--root',
          ROOT,
          testFile,
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
      // Live canary for the reporter premise the runtime-skip rule rests on:
      // a test that never started has no duration. The fixtures above are
      // frozen, so only this run notices a Vitest that changes it.
      const timedButNeverStarted = collected.testResults.flatMap((file) =>
        file.assertionResults
          .filter((result) => typeof result.duration === 'number')
          .map((result) =>
            [...result.ancestorTitles, result.title].join(' > '),
          ),
      );
      expect(
        timedButNeverStarted,
        'Vitest wrote a duration for a test that never started. check-required-tests-ran.mjs reads a skipped result with a duration as a runtime skip, so a skipped suite or filtered-out mayRuntimeSkip leg would now pass; revisit that rule before trusting the check.',
      ).toEqual([]);

      // Every pinned id present: rewrite the collected report as passed and
      // let the real check decide, so this agrees with how the lane matches.
      for (const file of collected.testResults)
        for (const result of file.assertionResults) result.status = 'passed';
      const rewritten = writeReport(collected);
      const result = spawnSync(
        process.execPath,
        [CHECK, '--profile-name', profileName, '--report', rewritten],
        { cwd: ROOT, encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      // And the reverse: every test the file registers is classified, so a new
      // leg, or an id deleted from the profile, fails here rather than leaving
      // the profile silently smaller than the file.
      type Entry = { test: string[] };
      const profile: Record<
        string,
        {
          mustPass: string[][];
          mayRuntimeSkip: Entry[];
          notRequired: Entry[];
        }
      > = JSON.parse(readFileSync(PROFILES, 'utf8'))[profileName].files;
      expect(Object.keys(profile)).toEqual([testFile]);
      const { mustPass, mayRuntimeSkip, notRequired } = profile[testFile];
      const classified = [
        ...mustPass,
        ...mayRuntimeSkip.map((entry) => entry.test),
        ...notRequired.map((entry) => entry.test),
      ].map((titles) => JSON.stringify(titles));
      const registered = collected.testResults.flatMap((file) =>
        file.assertionResults.map((entry) =>
          JSON.stringify([...entry.ancestorTitles, entry.title]),
        ),
      );
      expect(registered.filter((key) => !classified.includes(key))).toEqual([]);
      expect(classified.filter((key) => !registered.includes(key))).toEqual([]);
      // Pinned beside the derivation above, per row.
      expect(registered).toHaveLength(registeredCount);
    },
  );
});
