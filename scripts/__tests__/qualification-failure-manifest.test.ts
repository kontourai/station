import { execFile } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
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
  groupExplained,
  JOB_MANIFEST_FILE,
  jobExplained,
  parseJobManifest,
} from '../lib/qualification-failure-manifest.mjs';
import {
  phaseJobManifest,
  readPhaseGroups,
} from '../run-full-regression-phases.mjs';
import { runVitestGroup } from '../run-vitest-corpus.mjs';

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
          const report = (args[4] as { env?: NodeJS.ProcessEnv } | undefined)
            ?.env?.STATION_VITEST_FAILURE_REPORT;
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
    expect(readPhaseGroups(dir).errors).toEqual([
      expect.stringContaining('broken.json is unreadable'),
    ]);
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
