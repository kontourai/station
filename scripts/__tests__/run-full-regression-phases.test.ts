import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseFullRegressionPhaseArguments,
  resolveFullRegressionPhasePlan,
  runFullRegressionPhases,
  runPhaseProcess,
  snapshotWorkspace,
} from '../run-full-regression-phases.mjs';
import { FULL_REGRESSION_PHASES } from '../verification-lanes.mjs';

const root = resolve(import.meta.dirname, '../..');
const driver = resolve(root, 'scripts/run-full-regression-phases.mjs');
// A workspace that never changes, for tests about exit-status handling.
// Collects a child's forwarded bytes instead of writing them into this
// Vitest worker's stdout, where they would become the run's own output.
function sinks() {
  const bytes = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  return {
    bytes,
    forward: {
      stdout: (chunk: Buffer) => bytes.stdout.push(chunk) > 0,
      stderr: (chunk: Buffer) => bytes.stderr.push(chunk) > 0,
    },
  };
}

const unchangedWorkspace = () => ({
  headSha: 'a'.repeat(40),
  workspaceDigest: 'w',
  dependencyDigest: 'd',
  status: [] as string[],
});

describe('full-regression phase driver', () => {
  it('resolves every canonical phase to its own private script, in canonical order', () => {
    const reversed = [...FULL_REGRESSION_PHASES].reverse().map(({ id }) => id);
    const plan = resolveFullRegressionPhasePlan(
      parseFullRegressionPhaseArguments(reversed.map((id) => `--phase=${id}`)),
    );
    expect(plan.map(({ id }) => id)).toEqual(
      FULL_REGRESSION_PHASES.map(({ id }) => id),
    );
    for (const [index, step] of plan.entries()) {
      const phase = FULL_REGRESSION_PHASES[index];
      // The canonical command is `npm run <privateScript>`; the driver runs
      // exactly that, with the phase's own deadline.
      expect(`npm ${step.args.join(' ')}`).toBe(phase.command);
      expect(step.timeoutMs).toBe(phase.timeoutMs);
    }
  });

  it('forwards a process-heavy slice only to the process-heavy phase', () => {
    const plan = resolveFullRegressionPhasePlan(
      parseFullRegressionPhaseArguments([
        '--phase=test-full-process-heavy',
        '--phase=test-full-shared-output',
        '--process-heavy-shard=2/2',
      ]),
    );
    expect(plan.map(({ args }) => args)).toEqual([
      ['run', 'test:full:process-heavy:raw', '--', '--shard=2/2'],
      ['run', 'test:full:shared-output:raw'],
    ]);
  });

  it('rejects unknown, duplicate, missing, and misapplied selections', () => {
    expect(() => parseFullRegressionPhaseArguments([])).toThrow(/usage/);
    expect(() =>
      parseFullRegressionPhaseArguments(['--phase=not-a-phase']),
    ).toThrow(/unknown full-regression phase 'not-a-phase'/);
    expect(() =>
      parseFullRegressionPhaseArguments([
        '--phase=app-builds',
        '--phase=app-builds',
      ]),
    ).toThrow(/more than once/);
    expect(() =>
      parseFullRegressionPhaseArguments([
        '--phase=app-builds',
        '--process-heavy-shard=1/2',
      ]),
    ).toThrow(/requires --phase=test-full-process-heavy/);
    expect(() =>
      parseFullRegressionPhaseArguments([
        '--phase=test-full-process-heavy',
        '--process-heavy-shard=half',
      ]),
    ).toThrow(/must be <k>\/<n>/);
    expect(() =>
      parseFullRegressionPhaseArguments(['--phase=app-builds', 'extra']),
    ).toThrow(/usage/);
  });

  it('fails closed when a phase names a package script that does not exist', () => {
    expect(() =>
      resolveFullRegressionPhasePlan(
        { phaseIds: ['app-builds'], processHeavyShard: null },
        { scripts: {} },
      ),
    ).toThrow(/package script 'proof:app-builds'/);
  });

  it('continues past a failed phase and fails the run', async () => {
    const plan = resolveFullRegressionPhasePlan(
      parseFullRegressionPhaseArguments([
        '--phase=repo-governance',
        '--phase=sdk-builds',
        '--phase=app-builds',
      ]),
    );
    const ran: string[] = [];
    const lines: string[] = [];
    const result = await runFullRegressionPhases(plan, {
      log: (line) => lines.push(line),
      snapshot: unchangedWorkspace,
      runPhase: async (step) => {
        ran.push(step.id);
        return step.id === 'sdk-builds'
          ? { status: 1, error: null }
          : { status: 0, error: null };
      },
    });
    expect(ran).toEqual(['repo-governance', 'sdk-builds', 'app-builds']);
    expect(result.passed).toBe(false);
    expect(result.results.map(({ id, passed }) => [id, passed])).toEqual([
      ['repo-governance', true],
      ['sdk-builds', false],
      ['app-builds', true],
    ]);
    expect(lines.join('\n')).toContain('FAIL  sdk-builds');
  });

  it('treats a runner error, a deadline, or a throw as failure even with status 0', async () => {
    const plan = resolveFullRegressionPhasePlan(
      parseFullRegressionPhaseArguments([
        '--phase=repo-governance',
        '--phase=sdk-builds',
        '--phase=app-builds',
      ]),
    );
    const result = await runFullRegressionPhases(plan, {
      log: () => {},
      snapshot: unchangedWorkspace,
      runPhase: async (step) => {
        if (step.id === 'repo-governance')
          return { status: 0, error: 'left an owned process tree alive' };
        if (step.id === 'sdk-builds')
          return { status: null, error: 'exceeded its deadline' };
        throw new Error('spawn failed');
      },
    });
    expect(result.passed).toBe(false);
    expect(result.results.every(({ passed }) => !passed)).toBe(true);
  });

  it('passes only when every planned phase passed (false-positive control)', async () => {
    const plan = resolveFullRegressionPhasePlan(
      parseFullRegressionPhaseArguments(['--phase=app-builds']),
    );
    const result = await runFullRegressionPhases(plan, {
      log: () => {},
      snapshot: unchangedWorkspace,
      runPhase: async () => ({ status: 0, error: null }),
    });
    expect(result.passed).toBe(true);
    expect((await runFullRegressionPhases([], { log: () => {} })).passed).toBe(
      false,
    );
  });

  it('marks the remaining phases not-run after a cancellation', async () => {
    const plan = resolveFullRegressionPhasePlan(
      parseFullRegressionPhaseArguments([
        '--phase=repo-governance',
        '--phase=app-builds',
      ]),
    );
    const controller = new AbortController();
    const result = await runFullRegressionPhases(plan, {
      log: () => {},
      snapshot: unchangedWorkspace,
      signal: controller.signal,
      runPhase: async () => {
        controller.abort('SIGTERM');
        return { status: null, error: 'cancelled: SIGTERM' };
      },
    });
    expect(result.passed).toBe(false);
    expect(result.results[1]).toMatchObject({
      id: 'app-builds',
      error: 'not run: cancelled',
    });
  });

  it('exits non-zero from the real CLI on an invalid selection, before running anything', () => {
    const result = spawnSync(
      process.execPath,
      [driver, '--phase=not-a-phase'],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "unknown full-regression phase 'not-a-phase'",
    );
    expect(result.stdout).not.toContain('START');
  });

  it('reports a real failing npm script as a non-zero status', async () => {
    const outcome = await runPhaseProcess(
      {
        id: 'missing-script',
        args: ['run', 'station-no-such-script-for-driver-test'],
        timeoutMs: 60_000,
      },
      { cwd: root, forward: sinks().forward },
    );
    expect(outcome.status).not.toBe(0);
    expect(outcome.status).not.toBeNull();
  });

  it('kills a phase that overruns its deadline and reports it as an error', async () => {
    const started = Date.now();
    const outcome = await runPhaseProcess(
      {
        id: 'overrun',
        args: ['exec', '--', 'node', '-e', 'setTimeout(() => {}, 120000)'],
        timeoutMs: 3_000,
      },
      { cwd: root, forward: sinks().forward },
    );
    expect(outcome.error).toMatch(/exceeded its 3000 ms deadline/);
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 90_000);

  it('fails a phase whose output is not valid UTF-8, as the canonical runner does', async () => {
    // Regression (PR #2322 fast-checks): these bytes once went to the worker's
    // real stdout and made the enclosing Vitest run's own output invalid
    // UTF-8, which ci:fast records as an infrastructure error. They must reach
    // only the injected sink.
    const bad = sinks();
    const write = vi.spyOn(process.stdout, 'write');
    const outcome = await runPhaseProcess(
      {
        id: 'bad-utf8',
        args: [
          'exec',
          '--',
          'node',
          '-e',
          'process.stdout.write(Buffer.from([0x6f, 0x6b, 0xff, 0xfe]))',
        ],
        timeoutMs: 60_000,
      },
      { cwd: root, forward: bad.forward },
    );
    const leaked = write.mock.calls.some(([chunk]) =>
      Buffer.from(chunk as Uint8Array).includes(Buffer.from([0xff, 0xfe])),
    );
    write.mockRestore();
    expect(leaked).toBe(false);
    expect(Buffer.concat(bad.bytes.stdout)).toEqual(
      Buffer.from([0x6f, 0x6b, 0xff, 0xfe]),
    );
    expect(outcome.status).toBe(0);
    expect(outcome.error).toMatch(/output was not valid UTF-8/);
    const control = await runPhaseProcess(
      {
        id: 'good-utf8',
        args: ['exec', '--', 'node', '-e', 'process.stdout.write("ok ✓")'],
        timeoutMs: 60_000,
      },
      { cwd: root, forward: sinks().forward },
    );
    expect(control).toEqual({ status: 0, error: null });
  }, 120_000);

  it('binds the history ref to the checked-out HEAD, overriding inheritance', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    const inherited = process.env.STATION_VERIFICATION_HISTORY_REF;
    process.env.STATION_VERIFICATION_HISTORY_REF = 'f'.repeat(40);
    try {
      const outcome = await runPhaseProcess(
        {
          id: 'history-ref',
          args: [
            'exec',
            '--',
            'node',
            '-e',
            `process.exit(process.env.STATION_VERIFICATION_HISTORY_REF === '${head}' ? 0 : 3)`,
          ],
          timeoutMs: 60_000,
        },
        { cwd: root, forward: sinks().forward },
      );
      expect(outcome).toEqual({ status: 0, error: null });
    } finally {
      if (inherited === undefined)
        delete process.env.STATION_VERIFICATION_HISTORY_REF;
      else process.env.STATION_VERIFICATION_HISTORY_REF = inherited;
    }
  }, 120_000);

  it('exits 1 from the real CLI when a phase fails', () => {
    // An out-of-range slice makes the real process-heavy phase exit 2 before
    // it runs any test, so this exercises the CLI's failed-phase exit cheaply.
    const result = spawnSync(
      process.execPath,
      [driver, '--phase=test-full-process-heavy', '--process-heavy-shard=3/2'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('FAIL  test-full-process-heavy');
    expect(result.stderr).toContain('process-heavy Vitest corpus accepts only');
  }, 150_000);
});

describe('workspace mutation check', () => {
  function repository() {
    const directory = mkdtempSync(join(tmpdir(), 'full-regression-phases-'));
    const run = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, windowsHide: true });
    run('init', '--quiet');
    run('config', 'user.email', 'test@example.invalid');
    run('config', 'user.name', 'Test');
    run('config', 'commit.gpgsign', 'false');
    writeFileSync(join(directory, '.gitignore'), 'ignored.txt\nignored/\n');
    writeFileSync(join(directory, 'package-lock.json'), '{}\n');
    writeFileSync(join(directory, 'tracked.txt'), 'original\n');
    run('add', '.');
    run('commit', '--quiet', '-m', 'fixture');
    return { directory, run };
  }

  async function runWith(
    directory: string,
    mutate: () => void,
  ): Promise<{ passed: boolean; error: string | null }> {
    const result = await runFullRegressionPhases(
      [
        {
          id: 'phase',
          script: 'phase',
          args: ['run', 'phase'],
          timeoutMs: 1_000,
        },
      ],
      {
        cwd: directory,
        log: () => {},
        runPhase: async () => {
          mutate();
          return { status: 0, error: null };
        },
      },
    );
    return { passed: result.passed, error: result.results[0].error };
  }

  const cleanups: string[] = [];
  afterEach(() => {
    for (const directory of cleanups.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it('fails a phase that modifies a tracked file and names it', async () => {
    const { directory } = repository();
    cleanups.push(directory);
    const result = await runWith(directory, () =>
      writeFileSync(join(directory, 'tracked.txt'), 'changed\n'),
    );
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/phase mutated the workspace/);
    expect(result.error).toContain(' M tracked.txt');
  });

  it('fails a phase that creates an untracked file and names it', async () => {
    const { directory } = repository();
    cleanups.push(directory);
    const result = await runWith(directory, () =>
      writeFileSync(join(directory, 'stray.txt'), 'new\n'),
    );
    expect(result.passed).toBe(false);
    expect(result.error).toContain('?? stray.txt');
  });

  it('fails a phase that rewrites an already-modified file', async () => {
    const { directory } = repository();
    cleanups.push(directory);
    writeFileSync(join(directory, 'tracked.txt'), 'dirty before\n');
    const result = await runWith(directory, () =>
      writeFileSync(join(directory, 'tracked.txt'), 'dirty after\n'),
    );
    expect(result.passed).toBe(false);
    expect(result.error).toContain(
      'content changed under already-modified paths:  M tracked.txt',
    );
  });

  it('fails a phase that moves HEAD', async () => {
    const { directory, run } = repository();
    cleanups.push(directory);
    const result = await runWith(directory, () => {
      run('commit', '--quiet', '--allow-empty', '-m', 'inside a phase');
    });
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(
      /HEAD moved from [0-9a-f]{40} to [0-9a-f]{40}/,
    );
  });

  it('passes a phase that writes only ignored files (false-positive control)', async () => {
    const { directory } = repository();
    cleanups.push(directory);
    const result = await runWith(directory, () => {
      writeFileSync(join(directory, 'ignored.txt'), 'scratch\n');
      mkdirSync(join(directory, 'ignored'));
      writeFileSync(join(directory, 'ignored', 'output.json'), '{}\n');
    });
    expect(result).toEqual({ passed: true, error: null });
    expect(snapshotWorkspace(directory).status).toEqual([]);
  });
});
