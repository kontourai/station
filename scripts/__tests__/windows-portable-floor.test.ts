import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import {
  floorFailures,
  planFloorInvocations,
  runFloorInvocations,
} from '../windows-portable-floor.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const makeTempDir = trackTempDirs();
const SESSIONS =
  'src-server/services/terminal/__tests__/terminal-sessions.process.test.ts';
const HANDOFF =
  'src-server/services/terminal/__tests__/supervisor-terminal.real.test.ts';
const PROGRAMS =
  'src-server/services/terminal/__tests__/terminal-command-programs.test.ts';
const SSH =
  'src-server/services/ssh/__tests__/openssh-launch-bootstrap.test.ts';

describe('the Windows portable floor runner', () => {
  it('runs the other files together and each terminal process suite alone, with the same options', () => {
    expect(
      planFloorInvocations([
        'run',
        SSH,
        SESSIONS,
        PROGRAMS,
        HANDOFF,
        '--maxWorkers=1',
        '--no-file-parallelism',
      ]),
    ).toEqual([
      ['run', SSH, PROGRAMS, '--maxWorkers=1', '--no-file-parallelism'],
      ['run', SESSIONS, '--maxWorkers=1', '--no-file-parallelism'],
      ['run', HANDOFF, '--maxWorkers=1', '--no-file-parallelism'],
    ]);
    expect(() => planFloorInvocations(['run', '--maxWorkers=1'])).toThrow(
      'names no test files',
    );
  });

  it('runs every invocation after one fails and reports each failure, a crash and a signal included', () => {
    const results = [
      { status: 0, signal: null },
      { status: 1, signal: null },
      { status: null, signal: 'SIGTERM' as const },
      { status: null, signal: null, error: new Error('spawn EPERM') },
      { status: 0, signal: null },
    ];
    const spawnSync = vi.fn(() => results.shift()!);
    const invocations = ['a', 'b', 'c', 'd', 'e'].map((file) => [
      'run',
      `${file}.test.ts`,
      '--maxWorkers=1',
    ]);
    const outcomes = runFloorInvocations(invocations, {
      root,
      spawnSync,
      log: () => {},
    });
    expect(spawnSync).toHaveBeenCalledTimes(5);
    expect(spawnSync.mock.calls[1]).toEqual([
      process.execPath,
      [
        '--import',
        pathToFileURL(
          resolve(root, 'scripts/lib/windows-worker-diagnostics.mjs'),
        ).href,
        resolve(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        'b.test.ts',
        '--maxWorkers=1',
      ],
      expect.objectContaining({ cwd: root, windowsHide: true }),
    ]);
    expect(
      outcomes.map((outcome: { passed: boolean }) => outcome.passed),
    ).toEqual([true, false, false, false, true]);
    expect(floorFailures(outcomes)).toEqual([
      'b.test.ts: exit 1',
      'c.test.ts: signal SIGTERM',
      'd.test.ts: spawn EPERM',
    ]);
  });

  it.each([
    { name: 'successful exit', source: 'process.exit(0)', code: 0 },
    { name: 'nonzero exit', source: 'process.exit(37)', code: 37 },
    {
      name: 'uncaught exception',
      source: 'throw new Error("worker failure")',
      code: 1,
    },
  ])(
    'captures the real fork code without changing $name',
    ({ source, code }) => {
      const fixture = makeTempDir('station-windows-worker-');
      const vitest = resolve(fixture, 'node_modules/vitest');
      const library = resolve(fixture, 'scripts/lib');
      mkdirSync(vitest, { recursive: true });
      mkdirSync(library, { recursive: true });
      copyFileSync(
        resolve(root, 'scripts/lib/windows-worker-diagnostics.mjs'),
        resolve(library, 'windows-worker-diagnostics.mjs'),
      );
      writeFileSync(resolve(vitest, 'worker.cjs'), source);
      writeFileSync(
        resolve(vitest, 'vitest.mjs'),
        `
      import { fork } from 'node:child_process';
      const child = fork(new URL('./worker.cjs', import.meta.url), ['private-argument'], {
        execArgv: [], stdio: 'inherit', windowsHide: true,
      });
      child.on('exit', (code) => { process.exitCode = code; });
    `,
      );
      const outcomes = runFloorInvocations([['run', 'probe.test.ts']], {
        root: fixture,
        spawnSync: (command: string, args: string[], options: object) =>
          spawnSyncBounded(command, args, {
            ...options,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 30_000,
            windowsHide: true,
          }),
        log: () => {},
      });
      expect(outcomes).toMatchObject([
        { status: code, signal: null, error: null, passed: code === 0 },
      ]);
      const output = resolve(fixture, '.kontourai/verification-output');
      const logs = existsSync(output) ? readdirSync(output) : [];
      expect(logs).toHaveLength(1);
      const diagnostic = readFileSync(resolve(output, logs[0]), 'utf8');
      const events = diagnostic
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'coordinator',
            suites: ['probe.test.ts'],
          }),
          expect.objectContaining({
            event: 'spawn',
            child: expect.any(Number),
          }),
          expect.objectContaining({
            event: 'exit',
            code,
            signal: null,
            hex: `0x${code.toString(16).padStart(8, '0')}`,
          }),
        ]),
      );
      expect(diagnostic).not.toContain('private-argument');
    },
  );

  it('is how test:windows:portable runs its Vitest files', () => {
    const script = (
      JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts['test:windows:portable'];
    expect(script).toMatch(
      /^npm run test:prepush && node scripts\/windows-portable-floor\.mjs run /,
    );
    expect(script).not.toContain('node_modules/vitest/vitest.mjs');
  });
});
