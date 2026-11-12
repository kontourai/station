import type { ExecFileSyncOptions } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  execFileSyncBounded,
  spawnSyncBounded,
} from '../lib/bounded-capture.mjs';
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

const root = fileURLToPath(new URL('../..', import.meta.url));
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
      crashEvents: () => [],
      evidenceRoot: makeTempDir('station-floor-evidence-'),
    });
    expect(spawnSync).toHaveBeenCalledTimes(5);
    expect(spawnSync.mock.calls[1]).toEqual([
      process.execPath,
      [
        '--import',
        WORKER_EXITS,
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
            // Vitest's own teardown: a SIGTERM it asked for is no death.
            JSON.stringify({
              pid: 9,
              code: null,
              signal: 'SIGTERM',
              stopRequestedAt: '2026-11-06T00:00:00.000Z',
            }),
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
      workers: [{ pid: 7 }, { pid: 8, code: 3221225477 }, { pid: 9 }],
      applicationEvents: [{ Id: 1000 }],
    });
    expect(crashEvents).toHaveBeenCalledOnce();
    expect(logged.at(-1)).toContain(
      '1 worker(s) exited before Vitest stopped them (pid 8 exit 3221225477)',
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

  it.runIf(process.platform === 'win32').each([
    {
      name: 'success projection',
      body: `
[pscustomobject]@{ TimeCreated = [datetime]::Parse('2026-11-05T01:02:03Z').ToUniversalTime(); Id = 1000; ProviderName = 'Application Error'; Message = 'fixture-event' }
[pscustomobject]@{ TimeCreated = [datetime]::Parse('2026-11-05T01:02:03Z').ToUniversalTime(); Id = 9999; ProviderName = 'Unrelated provider'; Message = 'not-a-crash-provider' }
`,
      expected: 'projection',
      message: '',
    },
    {
      name: 'successful empty query',
      body: 'return',
      expected: 'empty',
      message: '',
    },
    {
      name: 'base no-matching ID',
      body: "$PSCmdlet.WriteError([System.Management.Automation.ErrorRecord]::new([Exception]::new('fixture-no-match'), 'NoMatchingEventsFound', [System.Management.Automation.ErrorCategory]::ObjectNotFound, $null))",
      expected: 'empty',
      message: '',
    },
    {
      name: 'qualified no-matching ID',
      body: "$PSCmdlet.WriteError([System.Management.Automation.ErrorRecord]::new([Exception]::new('fixture-no-match'), 'NoMatchingEventsFound,FixtureProvider', [System.Management.Automation.ErrorCategory]::ObjectNotFound, $null))",
      expected: 'empty',
      message: '',
    },
    {
      name: 'different ID with no-matching text',
      body: "$PSCmdlet.WriteError([System.Management.Automation.ErrorRecord]::new([Exception]::new('NoMatchingEventsFound'), 'OtherCollectionFailure', [System.Management.Automation.ErrorCategory]::InvalidOperation, $null))",
      expected: 'error',
      message: 'NoMatchingEventsFound',
    },
    {
      name: 'access denied',
      body: "$PSCmdlet.WriteError([System.Management.Automation.ErrorRecord]::new([UnauthorizedAccessException]::new('fixture-access-denied'), 'LogAccessDenied', [System.Management.Automation.ErrorCategory]::PermissionDenied, $null))",
      expected: 'error',
      message: 'fixture-access-denied',
    },
    {
      name: 'log unavailable',
      body: "$PSCmdlet.WriteError([System.Management.Automation.ErrorRecord]::new([InvalidOperationException]::new('fixture-log-unavailable'), 'NoLogMatchingLogNameFound', [System.Management.Automation.ErrorCategory]::ObjectNotFound, $null))",
      expected: 'error',
      message: 'fixture-log-unavailable',
    },
  ])(
    'classifies generated Application log query: $name',
    ({ body, expected, message }) => {
      const stub = `
function Get-WinEvent {
  [CmdletBinding()]
  param([hashtable]$FilterHashtable)
  if ($FilterHashtable.LogName -ne 'Application') { throw 'fixture received the wrong query' }
  ${body}
}
if ((Get-Command Get-WinEvent -ErrorAction Stop).CommandType -ne 'Function') {
  throw 'refusing to execute a live Application log query'
}
`;
      const run = <O extends ExecFileSyncOptions>(
        file: string,
        args: readonly string[] = [],
        options?: O,
      ) => {
        expect(file).toBe('powershell.exe');
        expect(args.slice(0, 3)).toEqual([
          '-NoProfile',
          '-NonInteractive',
          '-Command',
        ]);
        const generated = args.at(-1);
        if (!generated)
          throw new Error('The collector supplied no PowerShell program');
        return execFileSyncBounded(
          file,
          [...args.slice(0, -1), `${stub}\n${generated}`],
          options,
        );
      };
      const events = applicationCrashEvents(new Date('2026-11-05T00:00:00Z'), {
        run,
      });
      if (expected === 'projection') {
        expect(events).toEqual([
          {
            time: '2026-11-05T01:02:03.0000000Z',
            Id: 1000,
            ProviderName: 'Application Error',
            Message: 'fixture-event',
          },
        ]);
      } else if (expected === 'empty') {
        expect(events).toEqual([]);
      } else {
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ error: expect.stringContaining(message) });
      }
    },
  );

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
        crashEvents: () => [],
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
      const logs = existsSync(output)
        ? readdirSync(output).filter((name) =>
            /^windows-workers-\d+\.jsonl$/.test(name),
          )
        : [];
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
