import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { executeOwnedProcess } from '../lib/owned-process.mjs';
import {
  GROUP_MANIFEST_DIR_ENV,
  groupExplained,
  JOB_MANIFEST_FILE,
  jobExplained,
  MANIFEST_DIR_ENV,
  manifestDirectoryFromEnv,
  parseGroupManifest,
  parseJobManifest,
} from '../lib/qualification-failure-manifest.mjs';
import { e2eJobManifest } from '../run-e2e-suite.mjs';
import {
  phaseJobManifest,
  readPhaseGroups,
  resolveFullRegressionPhasePlan,
  runFullRegressionPhases,
  runPhaseProcess,
  writeJobManifest,
} from '../run-full-regression-phases.mjs';
import {
  buildVitestCommand,
  runVitestGroup,
  vitestGroupManifest,
} from '../run-vitest-corpus.mjs';
import VitestFailureReporter, {
  FAILURE_REPORT_OUTPUT_KEY,
} from '../vitest-failure-reporter.mjs';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();

/**
 * A tiny real Vitest project: this checkout's installed packages, the
 * failure-identity reporter at the path the corpus runner names, and the
 * given test files. The REAL corpus runner then runs it as a child process.
 */
function fixture(files: Record<string, string>) {
  const root = makeTempDir('station-failure-manifest-');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
  copyFileSync(
    join(repo, 'scripts', 'vitest-failure-reporter.mjs'),
    join(root, 'scripts', 'vitest-failure-reporter.mjs'),
  );
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    "export default { test: { include: ['**/*.test.mjs'], exclude: ['node_modules/**'] } };\n",
  );
  for (const [name, source] of Object.entries(files))
    writeFileSync(join(root, name), source);
  return root;
}

const FAILING = `import { describe, expect, it } from 'vitest';
describe('outer', () => {
  describe('inner [ipv6]', () => {
    it('fails here', () => { expect(1).toBe(2); });
  });
  it('passes', () => {});
});
`;
const group = { name: 'process-heavy', maxWorkers: 1 } as const;

/** The failure report path the corpus runner hands Vitest on its argv. */
function failureReportArgument(argv: readonly string[]) {
  const prefix = `--outputFile.${FAILURE_REPORT_OUTPUT_KEY}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function produce(
  files: Record<string, string>,
  options: Record<string, unknown> = {},
) {
  const root = fixture(files);
  const manifestDirectory = join(root, 'manifest');
  const result = await runVitestGroup(
    group,
    Object.keys(files).filter((name) => name.endsWith('.test.mjs')),
    { root, manifestDirectory, ...options },
  );
  const entry = JSON.parse(
    readFileSync(join(manifestDirectory, 'process-heavy.json'), 'utf8'),
  );
  return { result, entry };
}

describe('Vitest corpus failure manifest (real runner, fixture corpora)', () => {
  it('explains a run whose only failure is a named test', async () => {
    const { entry } = await produce({ 'a.test.mjs': FAILING });
    expect(entry).toEqual({
      group: 'process-heavy',
      exitStatus: 1,
      signal: null,
      failedTests: [
        {
          file: 'a.test.mjs',
          titlePath: ['outer', 'inner [ipv6]', 'fails here'],
        },
      ],
      failedFiles: [],
      runnerErrors: [],
      counts: {
        reporterFailedTests: 1,
        reporterFailedFiles: 1,
        unhandledErrors: 0,
      },
      explained: true,
    });
  });

  it('explains a passing run with no failures', async () => {
    const { entry } = await produce({
      'a.test.mjs': "import { it } from 'vitest';\nit('passes', () => {});\n",
    });
    expect(entry).toMatchObject({
      exitStatus: 0,
      failedTests: [],
      runnerErrors: [],
      explained: true,
    });
  });

  it('does not explain a failing test beside a file that fails to load', async () => {
    const { entry } = await produce({
      'a.test.mjs': FAILING,
      'b.test.mjs': "throw new Error('cannot load');\n",
    });
    expect(entry.failedFiles).toEqual([{ file: 'b.test.mjs', reason: 'load' }]);
    expect(entry.explained).toBe(false);
  });

  it('does not explain a failing test beside an unhandled rejection', async () => {
    const { entry } = await produce({
      'a.test.mjs': FAILING,
      'c.test.mjs': `import { it } from 'vitest';
it('leaves a rejection unhandled', async () => {
  Promise.reject(new Error('nobody waits for this'));
  await new Promise((done) => setTimeout(done, 50));
});
`,
    });
    expect(entry.counts.unhandledErrors).toBeGreaterThan(0);
    expect(entry.explained).toBe(false);
  });

  it('records an owned process tree left alive as a runner error', async () => {
    const { entry } = await produce({
      'a.test.mjs': `${FAILING}
import { spawn } from 'node:child_process';
it('leaks a child', () => {
  spawn('sleep', ['60'], { stdio: 'ignore' }).unref();
});
`,
    });
    expect(
      entry.runnerErrors.map((error: { kind: string }) => error.kind),
    ).toContain('process-tree-alive');
    expect(entry.explained).toBe(false);
  }, 60_000);

  it('records output over the byte limit as a runner error', async () => {
    const { entry } = await produce({
      'a.test.mjs': `${FAILING}
it('prints too much', () => { console.log('x'.repeat(3 * 1024 * 1024)); });
`,
    });
    expect(
      entry.runnerErrors.map((error: { kind: string }) => error.kind),
    ).toContain('output-limit');
    expect(entry.explained).toBe(false);
  }, 60_000);

  it('records a deadline kill: no reports, a cancellation, unexplained', async () => {
    const controller = new AbortController();
    const { entry } = await produce(
      {
        'a.test.mjs': `import { it } from 'vitest';
it('outlives the deadline', async () => { await new Promise((done) => setTimeout(done, 30_000)); }, 60_000);
`,
      },
      {
        signal: controller.signal,
        execute: (...args: Parameters<typeof executeOwnedProcess>) => {
          const execution = executeOwnedProcess(...args);
          setTimeout(() => controller.abort('group execution deadline'), 1_500);
          return execution;
        },
      },
    );
    const kinds = entry.runnerErrors.map(
      (error: { kind: string }) => error.kind,
    );
    expect(kinds).toContain('cancelled');
    expect(kinds).toContain('failure-report-missing');
    expect(entry.explained).toBe(false);
  }, 60_000);

  it('records reports that vanish before the runner reads them', async () => {
    const { entry } = await produce(
      { 'a.test.mjs': FAILING },
      {
        // The nearest seam: delete the failure report as the child exits.
        execute: (...args: Parameters<typeof executeOwnedProcess>) => {
          const execution = executeOwnedProcess(...args);
          const report = failureReportArgument(args[1] as string[]);
          execution.completion = execution.completion.then((value) => {
            if (report) rmSync(report, { force: true });
            return value;
          });
          return execution;
        },
      },
    );
    expect(
      entry.runnerErrors.map((error: { kind: string }) => error.kind),
    ).toEqual(['failure-report-missing']);
    expect(entry.explained).toBe(false);
  });
});

// A hook failure in the known test's own file used to read as known-only:
// the suite-failed file was the known test's file, so the file count
// reconciled. Any failed file now leaves the group unexplained.
describe('hook failures beside a failing test (real runner)', () => {
  const KNOWN = `import { afterAll, beforeAll, describe, expect, it } from 'vitest';
describe('known', () => { it('fails here', () => { expect(1).toBe(2); }); });
`;
  const cases: Record<string, string> = {
    'beforeAll throws in another describe': `${KNOWN}
describe('other', () => { beforeAll(() => { throw new Error('setup'); }); it('is skipped', () => {}); });
`,
    'top-level afterAll throws': `${KNOWN}
afterAll(() => { throw new Error('teardown'); });
`,
    'nested afterAll throws': `${KNOWN}
describe('other', () => { afterAll(() => { throw new Error('teardown'); }); it('passes', () => {}); });
`,
    'afterAll hook times out': `${KNOWN}
describe('other', () => { afterAll(() => new Promise((done) => setTimeout(done, 5_000)), 50); it('passes', () => {}); });
`,
  };
  for (const [name, source] of Object.entries(cases))
    it(name, async () => {
      const { entry } = await produce({ 'a.test.mjs': source });
      expect(entry.failedTests).toContainEqual({
        file: 'a.test.mjs',
        titlePath: ['known', 'fails here'],
      });
      expect(entry.failedFiles).toEqual([
        { file: 'a.test.mjs', reason: 'suite' },
      ]);
      expect(entry.explained).toBe(false);
    }, 60_000);
});

describe('the manifest never changes a run (real runner)', () => {
  const GREEN = "import { it } from 'vitest';\nit('passes', () => {});\n";
  // The failure reporter's target is a directory, so both its report and
  // its fallback error record fail to write inside onTestRunEnd.
  const unwritableReport = (directory: string) => ({
    execute: (...args: Parameters<typeof executeOwnedProcess>) => {
      const argv = args[1] as string[];
      const index = argv.findIndex((arg) =>
        arg.startsWith(`--outputFile.${FAILURE_REPORT_OUTPUT_KEY}=`),
      );
      expect(index).toBeGreaterThan(-1);
      argv[index] = `--outputFile.${FAILURE_REPORT_OUTPUT_KEY}=${directory}`;
      return executeOwnedProcess(...args);
    },
  });

  it('keeps green and red exits when the failure reporter cannot write', async () => {
    for (const [source, status] of [
      [GREEN, 0],
      [FAILING, 1],
    ] as const) {
      const root = fixture({ 'a.test.mjs': source });
      const blocked = join(root, 'blocked');
      mkdirSync(blocked);
      const manifestDirectory = join(root, 'manifest');
      const result = await runVitestGroup(group, ['a.test.mjs'], {
        root,
        manifestDirectory,
        ...unwritableReport(blocked),
      });
      expect(result.status).toBe(status);
      const entry = JSON.parse(
        readFileSync(join(manifestDirectory, 'process-heavy.json'), 'utf8'),
      );
      expect(
        entry.runnerErrors.map((error: { kind: string }) => error.kind),
      ).toContain('failure-report-missing');
      expect(entry.explained).toBe(false);
    }
  }, 120_000);

  it('records a reporter that throws instead of letting it escape', () => {
    const root = makeTempDir('station-reporter-throw-');
    const target = join(root, 'failures.json');
    const reporter = new VitestFailureReporter();
    reporter.onInit({
      config: { outputFile: { [FAILURE_REPORT_OUTPUT_KEY]: target } },
    });
    expect(() =>
      reporter.onTestRunEnd(
        [
          {
            moduleId: join(root, 'a.test.mjs'),
            children: {
              allTests() {
                throw new Error('reporter bug');
              },
            },
          },
        ] as never,
        [],
        'passed',
      ),
    ).not.toThrow();
    const entry = vitestGroupManifest(
      { name: 'process-heavy', status: 0, signal: null, error: null },
      { failureReport: target, jsonReport: join(root, 'absent.json') },
    );
    expect(
      entry.runnerErrors.map((error: { kind: string }) => error.kind),
    ).toContain('failure-reporter-error');
    expect(entry.explained).toBe(false);
  });

  it('keeps green and red exits when the manifest directory is unwritable, and then alerts', async () => {
    for (const [source, status] of [
      [GREEN, 0],
      [FAILING, 1],
    ] as const) {
      const root = fixture({ 'a.test.mjs': source });
      writeFileSync(join(root, 'not-a-directory'), '');
      const manifestDirectory = join(root, 'not-a-directory', 'manifest');
      const result = await runVitestGroup(group, ['a.test.mjs'], {
        root,
        manifestDirectory,
      });
      expect(result.status).toBe(status);
      expect(readPhaseGroups(manifestDirectory).groups).toEqual([]);
    }
    // A corpus phase with no group entry is never explained.
    const job = phaseJobManifest(
      [{ id: 'test-full-process-heavy' }],
      [{ id: 'test-full-process-heavy', status: 1, error: null }],
      new Map([['test-full-process-heavy', { groups: [], errors: [] }]]),
      { jobLabel: 'x', sourceSha: 'a'.repeat(40), runId: '1', runAttempt: '1' },
    );
    expect(job.explained).toBe(false);
  }, 120_000);
});

describe('a failure reporter Vitest cannot load (real runner)', () => {
  it('runs the group as with the gate off and records why, so green and red keep their exits', async () => {
    for (const [source, status] of [
      ["import { it } from 'vitest';\nit('passes', () => {});\n", 0],
      [FAILING, 1],
    ] as const) {
      const root = fixture({ 'a.test.mjs': source });
      writeFileSync(
        join(root, 'scripts', 'vitest-failure-reporter.mjs'),
        'export default class {\n',
      );
      const manifestDirectory = join(root, 'manifest');
      const result = await runVitestGroup(group, ['a.test.mjs'], {
        root,
        manifestDirectory,
      });
      expect(result.status).toBe(status);
      const entry = JSON.parse(
        readFileSync(join(manifestDirectory, 'process-heavy.json'), 'utf8'),
      );
      expect(
        entry.runnerErrors.map((error: { kind: string }) => error.kind),
      ).toContain('failure-reporter-unavailable');
      expect(entry.explained).toBe(false);
    }
  }, 120_000);
});

describe('the producers write nothing with the gate unset (real CLIs)', () => {
  const run = async (
    script: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => {
    const scratch = makeTempDir('station-gate-off-');
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      RUNNER_TEMP: scratch,
      TMPDIR: scratch,
      GITHUB_RUN_ID: '7',
      GITHUB_RUN_ATTEMPT: '1',
      ...env,
    };
    delete environment.STATION_QUALIFICATION_MANIFEST_DIR;
    Object.assign(environment, env);
    await exec(process.execPath, [join(repo, script), ...args], {
      cwd: scratch,
      env: environment,
      windowsHide: true,
    }).catch(() => undefined);
    const found = execFileSyncList(scratch);
    return found;
  };
  // Every file the CLI left under its scratch cwd, RUNNER_TEMP and TMPDIR.
  function execFileSyncList(directory: string): string[] {
    const listed: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true }))
        if (entry.isDirectory()) walk(join(current, entry.name));
        else listed.push(entry.name);
    };
    walk(directory);
    return listed;
  }

  for (const [script, args] of [
    ['scripts/run-full-regression-phases.mjs', ['--phase=no-such-phase']],
    ['scripts/run-e2e-suite.mjs', ['--suite=no-such-suite']],
  ] as const)
    it(`${script} writes a manifest only when the directory is set`, async () => {
      expect(await run(script, [...args], {})).not.toContain(JOB_MANIFEST_FILE);
      const directory = makeTempDir('station-gate-on-');
      await run(script, [...args], {
        STATION_QUALIFICATION_MANIFEST_DIR: directory,
      });
      expect(readdirSync(directory)).toContain(JOB_MANIFEST_FILE);
    }, 60_000);

  it('reads the gate as unset when absent or empty', () => {
    expect(manifestDirectoryFromEnv({})).toBeUndefined();
    expect(
      manifestDirectoryFromEnv({ STATION_QUALIFICATION_MANIFEST_DIR: '' }),
    ).toBeUndefined();
    expect(
      manifestDirectoryFromEnv({ STATION_QUALIFICATION_MANIFEST_DIR: '/x' }),
    ).toBe('/x');
  });
});

describe('the manifest gate (STATION_QUALIFICATION_MANIFEST_DIR)', () => {
  const files = ['a.test.mjs'];
  it('adds nothing when unset: the spawned argv is the plain command, and no file is written', async () => {
    const root = fixture({ 'a.test.mjs': FAILING });
    const spawned: string[][] = [];
    await runVitestGroup(group, files, {
      root,
      execute: (...args: Parameters<typeof executeOwnedProcess>) => {
        spawned.push([...(args[1] as string[])]);
        return executeOwnedProcess(...args);
      },
    });
    expect(spawned).toEqual([
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--maxWorkers=1',
        'a.test.mjs',
      ],
    ]);
    const seen: object[] = [];
    await runFullRegressionPhases(
      [{ id: 'verify-static', args: [], timeoutMs: 1 }] as never,
      {
        runPhase: async (_step: unknown, options: object) => {
          seen.push(options);
          return { status: 0, error: null };
        },
        snapshot: () => ({
          headSha: 'a',
          workspaceDigest: 'b',
          dependencyDigest: 'c',
          status: [],
        }),
        log: () => {},
      } as never,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('extraEnv');
  }, 60_000);

  it('adds exactly the default, json and failure reporters when set', () => {
    const plain = buildVitestCommand(group, files, {
      root: '/r',
      failureReportJson: '/t/vitest.json',
      failureReport: '/t/failures.json',
      env: {},
    });
    expect(plain).toEqual([
      '/r/node_modules/vitest/vitest.mjs',
      'run',
      '--maxWorkers=1',
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=/t/vitest.json',
      '--reporter=/r/scripts/vitest-failure-reporter.mjs',
      '--outputFile.stationFailures=/t/failures.json',
      'a.test.mjs',
    ]);
    expect(
      buildVitestCommand(group, files, {
        root: '/r',
        failureReportJson: '/t/vitest.json',
        env: { GITHUB_ACTIONS: 'true' },
      }).filter((arg) => arg.startsWith('--reporter=')),
    ).toEqual([
      '--reporter=default',
      '--reporter=github-actions',
      '--reporter=json',
      '--reporter=/r/scripts/vitest-failure-reporter.mjs',
    ]);
    // A group that already names its reporters keeps them and adds the two.
    expect(
      buildVitestCommand({ name: 'process-exclusive', maxWorkers: 1 }, files, {
        root: '/r',
        failureReportJson: '/t/vitest.json',
        env: { GITHUB_ACTIONS: 'true' },
      }).filter((arg) => arg.startsWith('--reporter=')),
    ).toEqual([
      '--reporter=default',
      '--reporter=/r/scripts/vitest-inflight-reporter.mjs',
      '--reporter=json',
      '--reporter=/r/scripts/vitest-failure-reporter.mjs',
    ]);
  });
});

describe('the explanation rule', () => {
  const explained = {
    group: 'g',
    exitStatus: 1,
    signal: null,
    failedTests: [{ file: 'a.test.mjs', titlePath: ['fails'] }],
    failedFiles: [],
    runnerErrors: [],
    counts: {
      reporterFailedTests: 1,
      reporterFailedFiles: 1,
      unhandledErrors: 0,
    },
    explained: true,
  };
  it('requires every count to reconcile and nothing else to have failed', () => {
    expect(groupExplained(explained)).toBe(true);
    for (const change of [
      { counts: { ...explained.counts, reporterFailedTests: 2 } },
      { counts: { ...explained.counts, reporterFailedFiles: 2 } },
      { counts: { ...explained.counts, unhandledErrors: 1 } },
      { counts: { ...explained.counts, reporterFailedTests: null } },
      { runnerErrors: [{ kind: 'runner-error', message: 'x' }] },
      { failedFiles: [{ file: 'b.test.mjs', reason: 'load' }] },
      { failedFiles: [{ file: 'a.test.mjs', reason: 'suite' }] },
      {
        failedTests: [explained.failedTests[0], explained.failedTests[0]],
        counts: { ...explained.counts, reporterFailedTests: 2 },
      },
      { signal: 'SIGKILL' },
      { exitStatus: 2 },
      { exitStatus: null },
      { exitStatus: 0 },
      { failedTests: [] },
    ])
      expect(
        groupExplained({ ...explained, ...change }),
        JSON.stringify(change),
      ).toBe(false);
  });

  it('explains a phase and job only when every planned phase reports its own verdict', () => {
    const plan = [{ id: 'test-full-ordinary-1-of-8' }, { id: 'verify-static' }];
    const identity = {
      jobLabel: 'Ordinary corpus 1-2 of 8',
      sourceSha: 'a'.repeat(40),
      runId: '1',
      runAttempt: '1',
    };
    const groups = new Map([
      ['test-full-ordinary-1-of-8', { groups: [explained], errors: [] }],
    ]);
    const pass = { id: 'verify-static', status: 0, error: null };
    const corpus = { id: 'test-full-ordinary-1-of-8', status: 1, error: null };
    const job = phaseJobManifest(plan, [corpus, pass], groups, identity);
    expect(job.explained).toBe(true);
    expect(jobExplained(parseJobManifest(JSON.stringify(job)))).toBe(true);
    // A failed phase with no test groups names no test.
    expect(
      phaseJobManifest(plan, [corpus, { ...pass, status: 1 }], groups, identity)
        .explained,
    ).toBe(false);
    // A planned phase that never reported.
    const partial = phaseJobManifest(plan, [corpus], groups, identity);
    expect(partial.complete).toBe(false);
    expect(partial.explained).toBe(false);
    // A corpus phase that wrote no group manifest (killed before writing).
    expect(
      phaseJobManifest(plan, [corpus, pass], new Map(), identity).explained,
    ).toBe(false);
    // The driver's own error on a phase.
    expect(
      phaseJobManifest(
        plan,
        [{ ...corpus, error: 'phase mutated the workspace' }, pass],
        groups,
        identity,
      ).explained,
    ).toBe(false);
    // An unreadable group manifest is a phase error.
    const dir = makeTempDir('station-phase-groups-');
    writeFileSync(join(dir, 'broken.json'), '{');
    expect(readPhaseGroups(dir, ['broken'])).toEqual({
      groups: [],
      errors: [
        expect.stringContaining(
          'broken.json is not a valid entry for group broken',
        ),
      ],
    });
  });

  it('writes a manifest that alerts when the driver cannot even plan', async () => {
    const directory = makeTempDir('station-driver-manifest-');
    await expect(
      exec(
        process.execPath,
        [
          join(repo, 'scripts/run-full-regression-phases.mjs'),
          '--phase=no-such-phase',
        ],
        {
          cwd: repo,
          env: {
            ...process.env,
            STATION_QUALIFICATION_MANIFEST_DIR: directory,
            STATION_QUALIFICATION_JOB_LABEL: 'Static and app builds',
            GITHUB_RUN_ID: '7',
            GITHUB_RUN_ATTEMPT: '1',
          },
          windowsHide: true,
        },
      ),
    ).rejects.toMatchObject({ code: 2 });
    const manifest = parseJobManifest(
      readFileSync(join(directory, JOB_MANIFEST_FILE), 'utf8'),
    );
    expect(manifest).toMatchObject({
      jobLabel: 'Static and app builds',
      runId: '7',
      phases: [],
      explained: false,
    });
  });
});

/**
 * Run `fn` with the manifest location variables set in this process, as the
 * hosted job sets them on the processes above a test, then restore them.
 */
async function withManifestEnvironment<T>(
  values: Partial<Record<string, string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const keys = [MANIFEST_DIR_ENV, GROUP_MANIFEST_DIR_ENV];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys)
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  try {
    return await fn();
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

/** Every file under `directory`, as paths relative to it. */
function filesUnder(directory: string): string[] {
  const listed: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }))
      if (entry.isDirectory())
        walk(join(current, entry.name), `${prefix}${entry.name}/`);
      else listed.push(`${prefix}${entry.name}`);
  };
  walk(directory, '');
  return listed.sort();
}

// A grandchild that behaves like a producer a test spawns: it writes into
// whatever manifest location it can see.
const LEAKING_GRANDCHILD = `
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
for (const key of ['${MANIFEST_DIR_ENV}', '${GROUP_MANIFEST_DIR_ENV}']) {
  const directory = process.env[key];
  if (directory) writeFileSync(join(directory, 'leak.json'), '{}');
}
`;

describe('test processes never see the manifest location (real corpus runner)', () => {
  it('a runner spawned inside a test cannot write into the job or group directory above it', async () => {
    const jobDirectory = makeTempDir('station-job-manifest-');
    const handedDirectory = makeTempDir('station-handed-groups-');
    const root = fixture({
      'a.test.mjs': `import { it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
it('spawns a producer-like grandchild', () => {
  const seen = Object.entries(process.env)
    .filter(([key, value]) =>
      key === '${MANIFEST_DIR_ENV}' ||
      key === '${GROUP_MANIFEST_DIR_ENV}' ||
      String(value).includes('station-vitest-manifest-'))
    .map(([key]) => key);
  writeFileSync('seen.json', JSON.stringify(seen));
  const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(LEAKING_GRANDCHILD)}], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('grandchild failed');
});
`,
    });
    const manifestDirectory = join(handedDirectory, 'groups');
    const result = await withManifestEnvironment(
      {
        [MANIFEST_DIR_ENV]: jobDirectory,
        [GROUP_MANIFEST_DIR_ENV]: handedDirectory,
      },
      () => runVitestGroup(group, ['a.test.mjs'], { root, manifestDirectory }),
    );
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'seen.json'), 'utf8'))).toEqual(
      [],
    );
    expect(filesUnder(jobDirectory)).toEqual([]);
    expect(filesUnder(handedDirectory)).toEqual(['groups/process-heavy.json']);
    expect(
      parseGroupManifest(
        readFileSync(join(manifestDirectory, 'process-heavy.json'), 'utf8'),
      ),
    ).toMatchObject({ group: 'process-heavy', exitStatus: 0, explained: true });
  }, 60_000);
});

describe('a direct Vitest run with the repository config (vitest.setup.ts)', () => {
  it('starts every test worker without a manifest location', async () => {
    const directory = makeTempDir('station-repo-config-');
    const jobDirectory = join(directory, 'job');
    const groupDirectory = join(directory, 'group');
    mkdirSync(jobDirectory);
    mkdirSync(groupDirectory);
    const seen = join(directory, 'seen.json');
    // The repository config itself, only pointed at one fixture file; its
    // setup file is the only layer between an exported location and a test.
    writeFileSync(
      join(directory, 'vitest.config.mjs'),
      `import base from ${JSON.stringify(join(repo, 'vitest.config.ts'))};
export default { ...base, test: { ...base.test, dir: ${JSON.stringify(directory)}, include: ['probe.test.mjs'] } };
`,
    );
    writeFileSync(
      join(directory, 'probe.test.mjs'),
      `import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
it('records its environment and spawns a producer-like grandchild', () => {
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env).filter((key) => key === '${MANIFEST_DIR_ENV}' || key === '${GROUP_MANIFEST_DIR_ENV}')));
  const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(LEAKING_GRANDCHILD)}], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('grandchild failed');
});
`,
    );
    await exec(
      process.execPath,
      [
        join(repo, 'node_modules/vitest/vitest.mjs'),
        'run',
        `--config=${join(directory, 'vitest.config.mjs')}`,
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          [MANIFEST_DIR_ENV]: jobDirectory,
          [GROUP_MANIFEST_DIR_ENV]: groupDirectory,
        },
        windowsHide: true,
      },
    );
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual([]);
    expect(filesUnder(jobDirectory)).toEqual([]);
    expect(filesUnder(groupDirectory)).toEqual([]);
  }, 120_000);
});

describe('a group entry a test forges under the planned name (real corpus runner)', () => {
  it('is replaced by the runner, even when the test made it read-only', async () => {
    const holder = makeTempDir('station-forged-group-');
    const manifestDirectory = join(holder, 'groups');
    const target = join(manifestDirectory, 'process-heavy.json');
    // A passing, explained entry: if it survived, the real failure would be
    // gone and the job would read as explained.
    const forged = JSON.stringify({
      ...groupEntry('process-heavy'),
      exitStatus: 0,
      failedTests: [],
      counts: {
        reporterFailedTests: 0,
        reporterFailedFiles: 0,
        unhandledErrors: 0,
      },
    });
    const root = fixture({
      'a.test.mjs': `${FAILING}
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
it('forges the group entry', () => {
  mkdirSync(${JSON.stringify(manifestDirectory)}, { recursive: true });
  writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(forged)});
  chmodSync(${JSON.stringify(target)}, 0o444);
});
`,
    });
    const result = await runVitestGroup(group, ['a.test.mjs'], {
      root,
      manifestDirectory,
    });
    expect(result.status).toBe(1);
    expect(readdirSync(manifestDirectory)).toEqual(['process-heavy.json']);
    const entry = parseGroupManifest(readFileSync(target, 'utf8'));
    expect(entry.exitStatus).toBe(1);
    expect(entry.failedTests).toContainEqual({
      file: 'a.test.mjs',
      titlePath: ['outer', 'inner [ipv6]', 'fails here'],
    });
  }, 60_000);

  it('leaves a visible stray entry when it cannot replace the target', async () => {
    const holder = makeTempDir('station-unreplaceable-group-');
    const manifestDirectory = join(holder, 'groups');
    // A directory at the target: the rename over it fails.
    mkdirSync(join(manifestDirectory, 'process-heavy.json'), {
      recursive: true,
    });
    const root = fixture({ 'a.test.mjs': FAILING });
    const result = await runVitestGroup(group, ['a.test.mjs'], {
      root,
      manifestDirectory,
    });
    expect(result.status).toBe(1);
    const { groups, errors } = readPhaseGroups(manifestDirectory, [
      'process-heavy',
    ]);
    expect(groups).toEqual([]);
    expect(errors).toContainEqual(
      expect.stringMatching(/^unexpected entry \.process-heavy\.json\..*\.tmp/),
    );
  }, 60_000);
});

describe('the real producer CLIs remove the manifest location from their own environment', () => {
  // Loaded into each CLI with --import: records, as the process exits,
  // whether a location variable is still in its environment (everything it
  // spawned inherited exactly that environment).
  const probe = (directory: string) => {
    const path = join(directory, 'probe.mjs');
    writeFileSync(
      path,
      `import { writeFileSync } from 'node:fs';
process.on('exit', () => {
  writeFileSync(${JSON.stringify(join(directory, 'seen-'))} + process.pid + '.json', JSON.stringify({
    argv: process.argv.slice(1),
    job: process.env.${MANIFEST_DIR_ENV} ?? null,
    group: process.env.${GROUP_MANIFEST_DIR_ENV} ?? null,
  }));
});
`,
    );
    return path;
  };
  for (const [script, args, writesJobManifest] of [
    ['scripts/run-full-regression-phases.mjs', ['--phase=no-such-phase'], true],
    ['scripts/run-e2e-suite.mjs', ['--suite=no-such-suite'], true],
    // The corpus runner writes no job manifest; it takes the group
    // location first thing, before it even parses its arguments.
    ['scripts/run-vitest-corpus.mjs', ['--group=no-such-group'], false],
  ] as const)
    it(`${script} takes the location from its own environment${writesJobManifest ? ' and replaces a read-only job manifest' : ''}`, async () => {
      const directory = makeTempDir('station-cli-take-');
      const jobDirectory = join(directory, 'job');
      mkdirSync(jobDirectory);
      // A read-only file already at the target: a plain write would fail
      // with EACCES and leave it standing as the job's manifest.
      const forged = join(jobDirectory, JOB_MANIFEST_FILE);
      writeFileSync(forged, '{"forged":true}\n');
      chmodSync(forged, 0o444);
      const probePath = probe(directory);
      await exec(
        process.execPath,
        ['--import', probePath, join(repo, script), ...args],
        {
          cwd: repo,
          env: {
            ...process.env,
            [MANIFEST_DIR_ENV]: jobDirectory,
            [GROUP_MANIFEST_DIR_ENV]: join(directory, 'groups'),
            GITHUB_RUN_ID: '7',
            GITHUB_RUN_ATTEMPT: '1',
          },
          windowsHide: true,
        },
      ).catch(() => undefined);
      expect(readdirSync(jobDirectory)).toEqual([JOB_MANIFEST_FILE]);
      const written = readFileSync(forged, 'utf8');
      if (writesJobManifest)
        expect(parseJobManifest(written)).toMatchObject({
          runId: '7',
          explained: false,
        });
      else expect(written).toBe('{"forged":true}\n');
      const seen = readdirSync(directory)
        .filter((name) => name.startsWith('seen-'))
        .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')))
        .find((entry) => entry.argv[0] === join(repo, script));
      expect(seen).toMatchObject({ job: null, group: null });
    }, 60_000);
});

/** A group entry exactly as the corpus runner writes one. */
function groupEntry(name: string) {
  return {
    group: name,
    exitStatus: 1,
    signal: null,
    failedTests: [{ file: 'a.test.mjs', titlePath: ['outer', 'fails here'] }],
    failedFiles: [],
    runnerErrors: [],
    counts: {
      reporterFailedTests: 1,
      reporterFailedFiles: 1,
      unhandledErrors: 0,
    },
    explained: true,
  };
}

describe('a corpus phase accepts exactly its planned groups (real phase process)', () => {
  // A committed git fixture whose npm scripts stand in for a corpus runner:
  // each writes the group entries its mode names into the directory the
  // driver handed it, and prints which manifest locations it can see.
  function phaseFixture(foreign: object) {
    const root = makeTempDir('station-phase-fixture-');
    const scripts = Object.fromEntries(
      [
        'planned',
        'hosted-pollution',
        'foreign-only',
        'malformed',
        'misnamed',
        'grandchild',
        'dies',
      ].map((mode) => [mode, `node phase.mjs ${mode}`]),
    );
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'phase-fixture', private: true, scripts })}\n`,
    );
    writeFileSync(join(root, 'foreign.json'), JSON.stringify(foreign));
    writeFileSync(
      join(root, 'phase.mjs'),
      `import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2];
const directory = process.env.${GROUP_MANIFEST_DIR_ENV};
const entries = ${JSON.stringify({ fixture: groupEntry('fixture'), other: groupEntry('other') })};
const entry = (name) => entries[name];
const write = (name, value) =>
  writeFileSync(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
console.log('SEEN ' + JSON.stringify({ job: process.env.${MANIFEST_DIR_ENV} ?? null, group: directory ?? null }));
if (mode === 'planned' || mode === 'hosted-pollution' || mode === 'grandchild') write('fixture.json', entry('fixture'));
// What the hosted run left in the group directory: a job manifest written by
// an e2e suite runner a test spawned.
if (mode === 'hosted-pollution') write('job-manifest.json', readFileSync('foreign.json', 'utf8'));
if (mode === 'foreign-only') write('other.json', entry('other'));
if (mode === 'malformed') write('fixture.json', { group: 'fixture' });
if (mode === 'misnamed') write('fixture.json', entry('other'));
// The runner is killed before it writes its group entry.
if (mode === 'dies') process.kill(process.pid, 'SIGKILL');
if (mode === 'grandchild') {
  const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(LEAKING_GRANDCHILD)}], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(3);
}
process.exit(1);
`,
    );
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, windowsHide: true });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    return root;
  }

  const identity = {
    jobLabel: 'Process-heavy corpus 3 of 3',
    sourceSha: 'a'.repeat(40),
    runId: '7',
    runAttempt: '1',
  };

  async function runMode(mode: string) {
    const root = phaseFixture(
      e2eJobManifest([], null, { identity: { ...identity, runId: '' } }),
    );
    const jobDirectory = makeTempDir('station-job-manifest-');
    const plan = [
      {
        id: 'test-full-fixture',
        script: mode,
        args: ['run', '--silent', mode],
        timeoutMs: 60_000,
        corpusGroups: ['fixture'],
      },
    ];
    const phaseGroups = new Map();
    const stdout: string[] = [];
    const { results } = await withManifestEnvironment(
      // The job's own location is set on the driver, as in the hosted job.
      { [MANIFEST_DIR_ENV]: jobDirectory },
      () =>
        runFullRegressionPhases(
          plan as never,
          {
            cwd: root,
            manifestDirectory: jobDirectory,
            phaseGroups,
            log: () => {},
            snapshot: () => ({
              headSha: 'a',
              workspaceDigest: 'b',
              dependencyDigest: 'c',
              status: [],
            }),
            runPhase: (step: never, options: object) =>
              runPhaseProcess(step, {
                ...options,
                forward: {
                  stdout: (chunk: Buffer) =>
                    stdout.push(chunk.toString('utf8')) > 0,
                  stderr: () => true,
                },
              }),
          } as never,
        ),
    );
    const written = writeJobManifest(jobDirectory, plan, results, phaseGroups, {
      cwd: root,
      env: { GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1' },
    });
    const manifest = parseJobManifest(
      readFileSync(join(jobDirectory, JOB_MANIFEST_FILE), 'utf8'),
    );
    expect(manifest).toEqual(written);
    const seenLine = stdout
      .join('')
      .split('\n')
      .find((line) => line.startsWith('SEEN '));
    return {
      manifest,
      phase: manifest.phases[0],
      jobDirectory,
      seen: JSON.parse(String(seenLine).slice('SEEN '.length)),
    };
  }

  it('explains a phase whose only entry is its planned group (positive control)', async () => {
    const { manifest, phase, seen, jobDirectory } = await runMode('planned');
    expect(phase).toMatchObject({
      phase: 'test-full-fixture',
      exitStatus: 1,
      error: null,
      groups: [groupEntry('fixture')],
      explained: true,
    });
    expect(manifest.explained).toBe(true);
    // The phase saw only its own fresh group directory, never the job's.
    expect(seen.job).toBeNull();
    expect(seen.group).toMatch(/groups\/test-full-fixture-[^/]+$/);
    expect(seen.group.startsWith(jobDirectory)).toBe(true);
  }, 60_000);

  it('keeps the failing test and alerts when a job manifest sits in the group directory (the hosted crash)', async () => {
    const { manifest, phase } = await runMode('hosted-pollution');
    expect(phase.groups).toEqual([groupEntry('fixture')]);
    expect(phase.error).toContain(
      'unexpected entry job-manifest.json in the group manifest directory',
    );
    expect(phase.explained).toBe(false);
    expect(manifest.explained).toBe(false);
  }, 60_000);

  it('never lets another group stand in for a planned group that wrote nothing', async () => {
    const { manifest, phase } = await runMode('foreign-only');
    expect(phase.groups).toEqual([]);
    expect(phase.error).toContain('unexpected entry other.json');
    expect(phase.error).toContain('group fixture wrote no manifest');
    expect(manifest.explained).toBe(false);
  }, 60_000);

  for (const [mode, reason] of [
    ['malformed', 'fixture.json is not a valid entry for group fixture'],
    ['misnamed', 'it names group "other"'],
  ] as const)
    it(`records a ${mode} entry under a planned name as a phase error`, async () => {
      const { manifest, phase } = await runMode(mode);
      expect(phase.groups).toEqual([]);
      expect(phase.error).toContain(reason);
      expect(manifest.explained).toBe(false);
    }, 60_000);

  it('alerts, naming the group, when the runner dies before writing its entry', async () => {
    const { manifest, phase } = await runMode('dies');
    expect(phase.groups).toEqual([]);
    expect(phase.error).toContain('group fixture wrote no manifest');
    expect(phase.explained).toBe(false);
    expect(manifest.explained).toBe(false);
  }, 60_000);

  it('gives a phase no way to reach the job manifest directory', async () => {
    const { phase, jobDirectory } = await runMode('grandchild');
    // The stand-in runner does not withhold its group directory, so its
    // grandchild writes there and the phase is unexplained; the job's own
    // directory holds nothing but the driver's manifest and the groups.
    expect(phase.error).toContain('unexpected entry leak.json');
    expect(phase.explained).toBe(false);
    expect(
      filesUnder(jobDirectory).filter((file) => !file.startsWith('groups/')),
    ).toEqual([JOB_MANIFEST_FILE]);
  }, 60_000);
});

describe('the job manifest is always written', () => {
  const identity = {
    jobLabel: 'Process-heavy corpus 3 of 3',
    sourceSha: 'a'.repeat(40),
    runId: '7',
    runAttempt: '1',
  };

  it('writes an unexplained manifest when the phases cannot be read', () => {
    const directory = makeTempDir('station-unbuildable-');
    const plan = [{ id: 'test-full-process-heavy' }, { id: 'verify-static' }];
    const hostile = {
      get() {
        throw new Error('hostile phase groups');
      },
    };
    writeJobManifest(
      directory,
      plan,
      [
        { id: 'test-full-process-heavy', status: 1, error: null },
        { id: 'verify-static', status: 0, error: null },
      ],
      hostile,
      { cwd: repo, env: { GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1' } },
    );
    const manifest = parseJobManifest(
      readFileSync(join(directory, JOB_MANIFEST_FILE), 'utf8'),
    );
    expect(manifest).toMatchObject({
      complete: false,
      explained: false,
      phases: [
        {
          phase: 'test-full-process-heavy',
          // The alert still says which phase failed, and how.
          exitStatus: 1,
          error: expect.stringContaining(
            'the job manifest could not be built: hostile phase groups',
          ),
          explained: false,
        },
        // A phase that passed keeps its status and still explains nothing.
        { phase: 'verify-static', exitStatus: 0, explained: false },
      ],
    });
  });

  it('never explains, and never throws on, a group that is not exactly a group entry', () => {
    const malformed = [
      {},
      { ...groupEntry('fixture'), failedTests: undefined },
      { ...groupEntry('fixture'), extra: true },
      // The shape the hosted run put in a group directory: a job manifest.
      e2eJobManifest([], null, { identity }),
    ];
    for (const group of malformed) {
      expect(groupExplained(group as never), JSON.stringify(group)).toBe(false);
      const job = phaseJobManifest(
        [{ id: 'test-full-fixture' }],
        [{ id: 'test-full-fixture', status: 1, error: null }],
        new Map([['test-full-fixture', { groups: [group], errors: [] }]]),
        identity,
      );
      expect(job.explained).toBe(false);
    }
    expect(groupExplained(groupEntry('fixture'))).toBe(true);
  });

  it('plans exactly the group each canonical corpus phase runs', () => {
    const plan = resolveFullRegressionPhasePlan({
      phaseIds: [
        'test-full-ordinary-7-of-8',
        'test-full-process-heavy',
        'test-full-process-exclusive',
        'test-full-shared-output',
        'verify-static',
      ],
      processHeavyShard: '3/3',
    });
    expect(
      Object.fromEntries(plan.map((step) => [step.id, step.corpusGroups])),
    ).toEqual({
      'verify-static': undefined,
      'test-full-ordinary-7-of-8': ['ordinary-7-of-8'],
      'test-full-process-heavy': ['process-heavy-3-of-3'],
      'test-full-process-exclusive': ['process-exclusive'],
      'test-full-shared-output': ['shared-output'],
    });
    expect(
      resolveFullRegressionPhasePlan({
        phaseIds: ['test-full-process-heavy'],
        processHeavyShard: null,
      })[0].corpusGroups,
    ).toEqual(['process-heavy']);
  });
});
