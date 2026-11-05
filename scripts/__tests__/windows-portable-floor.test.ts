import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  floorFailures,
  planFloorInvocations,
  runFloorInvocations,
} from '../windows-portable-floor.mjs';

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
    });
    expect(spawnSync).toHaveBeenCalledTimes(5);
    expect(spawnSync.mock.calls[1]).toEqual([
      process.execPath,
      [
        resolve(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        'b.test.ts',
        '--maxWorkers=1',
      ],
      expect.objectContaining({ cwd: root, windowsHide: true }),
    ]);
    expect(outcomes.map((outcome) => outcome.passed)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(floorFailures(outcomes)).toEqual([
      'b.test.ts: exit 1',
      'c.test.ts: signal SIGTERM',
      'd.test.ts: spawn EPERM',
    ]);
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
