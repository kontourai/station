import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseFullRegressionPhaseArguments,
  resolveFullRegressionPhasePlan,
  runFullRegressionPhases,
  runPhaseProcess,
} from '../run-full-regression-phases.mjs';
import { FULL_REGRESSION_PHASES } from '../verification-lanes.mjs';

const root = resolve(import.meta.dirname, '../..');
const driver = resolve(root, 'scripts/run-full-regression-phases.mjs');

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
      { cwd: root },
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
      { cwd: root },
    );
    expect(outcome.error).toMatch(/exceeded its 3000 ms deadline/);
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 90_000);
});
