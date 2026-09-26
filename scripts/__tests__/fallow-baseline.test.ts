/**
 * `npm run fallow:baseline` (#2682). It runs fallow's JS launcher under the
 * current Node, so its arguments start at the subcommand: a leading `fallow`
 * token (what `npx fallow …` needed) makes every run print
 * `unrecognized subcommand 'fallow'`. And a subcommand that fails must fail
 * the script, not leave it at exit 0 with no baseline written.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  FALLOW_BASELINES,
  fallowBaselineInvocations,
  runFallowBaselines,
} from '../fallow-baseline.mjs';

describe('fallow baseline invocations', () => {
  test('run the fallow launcher under Node with the subcommand first', () => {
    const invocations = fallowBaselineInvocations();
    expect(invocations.map(({ args }) => args[1])).toEqual([
      'dead-code',
      'health',
      'dupes',
    ]);
    for (const { command, args } of invocations) {
      expect(command).toBe(process.execPath);
      expect(args[0]).toMatch(/[\\/]fallow[\\/]bin[\\/]fallow$/);
      expect(existsSync(args[0] ?? '')).toBe(true);
      expect(args.slice(2)).toEqual([
        '--save-baseline',
        expect.stringMatching(/^fallow-baselines\/.+\.json$/),
      ]);
    }
    expect(FALLOW_BASELINES).toHaveLength(invocations.length);
  });

  // The real fallow CLI decides whether the argument list parses. `--help`
  // in place of `--save-baseline <file>` keeps the check from writing.
  test.each(
    fallowBaselineInvocations().map(({ command, args }) => [
      args[1],
      command,
      args,
    ]),
  )('fallow accepts the %s subcommand as built', (_name, command, args) => {
    const result = spawnSync(
      command as string,
      [...(args as string[]).slice(0, 2), '--help'],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain('unrecognized subcommand');
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('runFallowBaselines', () => {
  const invocations = fallowBaselineInvocations('/fallow');

  test('exits 0 only when every subcommand exits 0', () => {
    const spawned: string[] = [];
    const code = runFallowBaselines({
      invocations,
      spawn: ((_command: string, args: string[]) => {
        spawned.push(args[1] ?? '');
        return { status: 0, signal: null };
      }) as never,
      report: () => {},
    });
    expect(code).toBe(0);
    expect(spawned).toEqual(['dead-code', 'health', 'dupes']);
  });

  test.each([
    ['a nonzero exit', { status: 2, signal: null }, 'exited 2'],
    ['a signal', { status: null, signal: 'SIGTERM' }, 'terminated by SIGTERM'],
    [
      'a spawn error',
      { status: null, signal: null, error: new Error('spawn EINVAL') },
      'spawn EINVAL',
    ],
  ])('fails, naming the command, on %s', (_label, failure, detail) => {
    const spawned: string[] = [];
    const reports: string[] = [];
    const code = runFallowBaselines({
      invocations,
      spawn: ((_command: string, args: string[]) => {
        spawned.push(args[1] ?? '');
        return args[1] === 'health' ? failure : { status: 0, signal: null };
      }) as never,
      report: (message: string) => reports.push(message),
    });
    expect(code).toBe(1);
    // Stops at the failure: a later baseline is not written over a failed one.
    expect(spawned).toEqual(['dead-code', 'health']);
    expect(reports).toEqual([
      `fallow health --save-baseline fallow-baselines/health.json: ${detail}`,
    ]);
  });
});
