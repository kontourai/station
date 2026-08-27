import { execFileSync, spawnSync } from 'node:child_process';
import {
  CI_FAST_INFRASTRUCTURE_EXIT_CODE,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTENT_INTEGRITY_FAST_COMMAND,
  FAST_FEEDBACK_TIMEOUT_MS,
  FAST_STATIC_COMMANDS,
  FAST_STATIC_RESERVE_MS,
  fastBase,
  runCiFast,
  SELECTOR_DEFERRED_EXIT_CODE,
  SELECTOR_DEFERRED_MESSAGE,
} from '../run-ci-fast.mjs';

const [, contentIntegrityArgs] = CONTENT_INTEGRITY_FAST_COMMAND;
const contentIntegrityScript = contentIntegrityArgs[1];
const contentGateRepos = new Set<string>();

afterEach(() => {
  for (const dir of contentGateRepos)
    rmSync(dir, { recursive: true, force: true });
  contentGateRepos.clear();
});

function contentGateRepo(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-ci-fast-content-gate-'));
  contentGateRepos.add(dir);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'src-server'), { recursive: true });
  copyFileSync(
    join(process.cwd(), 'scripts', 'content-integrity-gate.mjs'),
    join(dir, 'scripts', 'content-integrity-gate.mjs'),
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: {
        [contentIntegrityScript]: 'node scripts/content-integrity-gate.mjs',
      },
    }),
  );
  writeFileSync(join(dir, 'src-server', 'fixture.ts'), source);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'ci-fast@test.invalid');
  git('config', 'user.name', 'ci-fast');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return dir;
}

function runOnlyContentGate(cwd: string): {
  status: number;
  output: string;
} {
  let output = '';
  const status = runCiFast({
    cwd,
    env: { STATION_CI_FAST_BASE: 'fixture-base' },
    execute(command, args, { cwd: childCwd, timeout }) {
      if (command !== CONTENT_INTEGRITY_FAST_COMMAND[0]) return 0;
      if (args !== contentIntegrityArgs) return 0;
      const result = spawnSync(command, args, {
        cwd: childCwd,
        timeout,
        encoding: 'utf8',
        windowsHide: true,
      });
      output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      return result.status ?? 1;
    },
  });
  return { status, output };
}

describe('bounded ci:fast runner', () => {
  it('runs the affected selector before the fixed static invariant set', () => {
    const calls: Array<{ command: string; args: string[]; timeout: number }> =
      [];
    const status = runCiFast({
      cwd: '/fixture',
      env: { STATION_CI_FAST_BASE: 'base-sha' },
      now: () => 1_000,
      execute(command, args, { timeout }) {
        calls.push({ command, args, timeout });
        return 0;
      },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([
      {
        command: process.execPath,
        args: ['scripts/run-changed-verification.mjs', '--base=base-sha'],
        timeout: FAST_FEEDBACK_TIMEOUT_MS - FAST_STATIC_RESERVE_MS,
      },
      ...FAST_STATIC_COMMANDS.map(([command, args]) => ({
        command,
        args,
        timeout: FAST_FEEDBACK_TIMEOUT_MS,
      })),
    ]);
  });

  it('pins a small static invariant allowlist with no broad static or full Vitest lane', () => {
    expect(FAST_STATIC_COMMANDS).toEqual([
      [process.execPath, ['scripts/node-runtime-contract.mjs']],
      ['npm', ['run', 'lockfile-sync:gate']],
      ['npm', ['run', 'channel-ports:check']],
      ['npm', ['run', 'gate:workflows']],
      ['npm', ['run', 'content:integrity']],
      ['npm', ['run', 'verification:policy:gate']],
      // station#4273: the typecheck invariant, and `build:connect` as its
      // stated precondition (typecheck:ui resolves @kontourai/station-connect
      // through packages/connect/dist). The aggregate is invoked DIRECTLY
      // rather than via `npm run typecheck`, which chains dist:freshness
      // ahead of the lanes and would fail on an unbuilt packages/cli/dist
      // before any lane ran.
      ['npm', ['run', 'build:connect']],
      [process.execPath, ['scripts/typecheck-aggregate.mjs']],
    ]);
    expect(JSON.stringify(FAST_STATIC_COMMANDS)).not.toMatch(
      /verify:static|test:full|vitest-corpus/,
    );
  });

  it('fails the fixed static lane for a tracked source hidden by a literal NUL', () => {
    const nul = String.fromCharCode(0);
    const repo = contentGateRepo(`export const key = "left${nul}right";\n`);

    const result = runOnlyContentGate(repo);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'tracked file(s) contain control characters',
    );
    expect(result.output).toContain('src-server/fixture.ts');
  });

  it('accepts a conformant tracked source through the same fixed static lane', () => {
    const repo = contentGateRepo('export const key = "left\\0right";\n');

    const result = runOnlyContentGate(repo);

    expect(result.status).toBe(0);
    expect(result.output).toContain('OK: no control characters');
  });

  it('continues after an explicit selector deferral without treating it as completion', () => {
    const calls: string[] = [];
    const reports: string[] = [];
    expect(
      runCiFast({
        env: { STATION_CI_FAST_BASE: 'base-sha' },
        execute(command) {
          calls.push(command);
          return calls.length === 1 ? SELECTOR_DEFERRED_EXIT_CODE : 0;
        },
        report(message) {
          reports.push(message);
        },
      }),
    ).toBe(0);
    expect(calls).toEqual([
      process.execPath,
      ...FAST_STATIC_COMMANDS.map(([command]) => command),
    ]);
    expect(reports).toEqual([SELECTOR_DEFERRED_MESSAGE]);
  });

  it('preserves the product-law infrastructure exit for the coordinator to classify', () => {
    expect(
      runCiFast({
        env: { STATION_CI_FAST_BASE: 'base-sha' },
        execute(_command, args) {
          return args[1] === 'verification:policy:gate'
            ? CI_FAST_INFRASTRUCTURE_EXIT_CODE
            : 0;
        },
      }),
    ).toBe(CI_FAST_INFRASTRUCTURE_EXIT_CODE);
  });

  it('fails closed for an option-like base and a non-deferred child failure', () => {
    expect(() => fastBase({ STATION_CI_FAST_BASE: '--bad' })).toThrow(
      'must be a Git ref',
    );
    let calls = 0;
    expect(
      runCiFast({
        env: { STATION_CI_FAST_BASE: 'base-sha' },
        execute() {
          calls += 1;
          return 1;
        },
      }),
    ).toBe(1);
    expect(calls).toBe(1);
  });

  it('reserves time for static invariants and passes the remaining budget to each command', () => {
    let clock = 1_000;
    const calls: number[] = [];
    expect(
      runCiFast({
        env: { STATION_CI_FAST_BASE: 'base-sha' },
        now: () => clock,
        execute(_command, _args, { timeout }) {
          calls.push(timeout);
          clock += 12_345;
          return 0;
        },
      }),
    ).toBe(0);
    expect(calls).toEqual([
      FAST_FEEDBACK_TIMEOUT_MS - FAST_STATIC_RESERVE_MS,
      FAST_FEEDBACK_TIMEOUT_MS - 12_345,
      FAST_FEEDBACK_TIMEOUT_MS - 24_690,
      FAST_FEEDBACK_TIMEOUT_MS - 37_035,
      FAST_FEEDBACK_TIMEOUT_MS - 49_380,
      FAST_FEEDBACK_TIMEOUT_MS - 61_725,
      FAST_FEEDBACK_TIMEOUT_MS - 74_070,
      // station#4273 added two commands; the arithmetic is unchanged.
      FAST_FEEDBACK_TIMEOUT_MS - 86_415,
      FAST_FEEDBACK_TIMEOUT_MS - 98_760,
    ]);
  });

  it('does not launch the next child after the five-minute budget is exhausted', () => {
    let clock = 1_000;
    let calls = 0;
    expect(() =>
      runCiFast({
        env: { STATION_CI_FAST_BASE: 'base-sha' },
        now: () => clock,
        execute() {
          calls += 1;
          clock += FAST_FEEDBACK_TIMEOUT_MS;
          return 0;
        },
      }),
    ).toThrow('exceeded its 5-minute feedback budget');
    expect(calls).toBe(1);
  });
});
