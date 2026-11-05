import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  applicationCrashEvents,
  floorFailures,
  planFloorInvocations,
  runFloorInvocations,
} from '../windows-portable-floor.mjs';

const makeTempDir = trackTempDirs();
const WORKER_EXITS = pathToFileURL(
  resolve(import.meta.dirname, '../lib/floor-worker-exits.mjs'),
).href;

const root = resolve(import.meta.dirname, '../..');
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
      { status: 0 },
      { status: 1 },
      { status: null, signal: 'SIGTERM' },
      { status: null, error: new Error('spawn EPERM') },
      { status: 0 },
    ];
    const spawnSync = vi.fn(() => results.shift()!);
    const invocations = ['a', 'b', 'c', 'd', 'e'].map((file) => [
      'run',
      `${file}.test.ts`,
      '--maxWorkers=1',
    ]);
    const outcomes = runFloorInvocations(invocations, {
      root,
      spawnSync: spawnSync as never,
      log: () => {},
      crashEvents: () => [],
      evidenceRoot: makeTempDir('station-floor-evidence-'),
    });
    expect(spawnSync).toHaveBeenCalledTimes(5);
    expect(spawnSync.mock.calls[1]).toEqual([
      process.execPath,
      [
        '--import',
        WORKER_EXITS,
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

  it('keeps crash evidence for a failed invocation only (#4626)', () => {
    const evidenceRoot = makeTempDir('station-floor-evidence-');
    const results = [{ status: 0 }, { status: 1 }];
    const logged: string[] = [];
    const crashEvents = vi.fn(() => [
      { Id: 1000, ProviderName: 'Application Error', Message: 'node.exe' },
    ]);
    const spawnSync = vi.fn(
      (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        // The invocation's workers, as the preload records them.
        writeFileSync(
          options.env.STATION_FLOOR_WORKER_EXIT_LOG!,
          [
            JSON.stringify({ pid: 7, code: 0, signal: null }),
            JSON.stringify({ pid: 8, code: 3221225477, signal: null }),
            '',
          ].join('\n'),
        );
        expect(options.env.NODE_OPTIONS).toContain('--report-on-fatalerror');
        expect(options.env.NODE_OPTIONS).toContain('--report-directory=');
        return results.shift()!;
      },
    );
    runFloorInvocations(
      [
        ['run', 'src/pass.test.ts'],
        ['run', 'src/fail.test.ts'],
      ],
      {
        root,
        spawnSync: spawnSync as never,
        log: (line: string) => logged.push(line),
        crashEvents,
        platform: 'win32',
        evidenceRoot,
      },
    );
    expect(existsSync(join(evidenceRoot, '01-pass.test.ts'))).toBe(false);
    const summary = JSON.parse(
      readFileSync(
        join(evidenceRoot, '02-fail.test.ts', 'summary.json'),
        'utf8',
      ),
    );
    expect(summary).toMatchObject({
      files: ['src/fail.test.ts'],
      status: 1,
      workers: [{ pid: 7 }, { pid: 8, code: 3221225477 }],
      applicationEvents: [{ Id: 1000 }],
    });
    expect(crashEvents).toHaveBeenCalledOnce();
    expect(logged.at(-1)).toContain(
      '1 worker(s) ended abnormally (pid 8 exit 3221225477)',
    );
  });

  it('reads Application log crash entries since the invocation started', () => {
    const run = vi.fn((_file: string, _args: string[]) =>
      JSON.stringify({ Id: 1000, Message: 'x' }),
    );
    expect(
      applicationCrashEvents(new Date('2026-11-05T00:00:00Z'), {
        run: run as never,
      }),
    ).toEqual([{ Id: 1000, Message: 'x' }]);
    const [file, args] = run.mock.calls[0]!;
    expect(file).toBe('powershell.exe');
    expect(args.at(-1)).toContain(
      "[datetime]::Parse('2026-11-05T00:00:00.000Z')",
    );
    expect(args.at(-1)).toContain("'Application Error'");
    // A failed read is evidence too, never a thrown floor.
    expect(
      applicationCrashEvents(new Date(), {
        run: () => {
          throw new Error('no event log');
        },
      }),
    ).toEqual([{ error: 'no event log' }]);
  });

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
