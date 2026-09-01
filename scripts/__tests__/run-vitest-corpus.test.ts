import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildVitestCommand,
  buildWindowsSerializedCommand,
  emitResult,
  ORDINARY_SHARD_COUNT,
  ORDINARY_SHARD_DESCRIPTORS,
  parseVitestCorpusArguments,
  runVitestCorpus,
  runVitestGroup,
  runWindowsSerializedCorpus,
  VITEST_CORPUS_GROUPS,
  vitestGroupEnvironment,
} from '../run-vitest-corpus.mjs';

const GROUPS = {
  ordinary: ['ordinary.test.ts'],
  processHeavy: ['process.test.ts'],
  processExclusive: ['exclusive.test.ts'],
  sharedOutput: ['shared.test.ts'],
  dogfoodReconcile: ['scripts/__tests__/station-dogfood-reconcile.test.ts'],
};

function completedExecution(status = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1234;
  return {
    child,
    completion: Promise.resolve({ status, signal: null }),
    isAlive: () => false,
    terminate: async () => {},
    forceTerminate: async () => {},
  };
}

describe('Vitest corpus runner', () => {
  it('builds explicit Node/Vitest commands with resource-bounded worker counts', () => {
    expect(VITEST_CORPUS_GROUPS).toEqual([
      { name: 'ordinary', maxWorkers: 4 },
      { name: 'process-heavy', maxWorkers: 1, noFileParallelism: true },
      { name: 'process-exclusive', maxWorkers: 1, noFileParallelism: true },
      { name: 'shared-output', maxWorkers: 1, noFileParallelism: true },
      { name: 'dogfood-reconcile', maxWorkers: 1, noFileParallelism: true },
    ]);
    expect(ORDINARY_SHARD_COUNT).toBe(8);
    expect(ORDINARY_SHARD_DESCRIPTORS.map(({ shard }) => shard)).toEqual([
      '1/8',
      '2/8',
      '3/8',
      '4/8',
      '5/8',
      '6/8',
      '7/8',
      '8/8',
    ]);
    const command = buildVitestCommand(ORDINARY_SHARD_DESCRIPTORS[0], [
      'one.test.ts',
    ]);
    expect(command[0].replaceAll('\\', '/')).toContain(
      'node_modules/vitest/vitest.mjs',
    );
    expect(command).toContain('--maxWorkers=4');
    expect(command).not.toContain('one.test.ts');
    expect(command.some((arg) => arg.startsWith('--exclude='))).toBe(true);
    expect(command).toContain('--shard=1/8');
    expect(command).toContain('--reporter=default');
    expect(
      command.some((arg) =>
        arg
          .replaceAll('\\', '/')
          .endsWith('/scripts/vitest-inflight-reporter.mjs'),
      ),
    ).toBe(true);
    expect(command).not.toContain('--no-file-parallelism');
    const processHeavy = buildVitestCommand(VITEST_CORPUS_GROUPS[1], [
      'process.test.ts',
    ]);
    expect(processHeavy).toEqual(
      expect.arrayContaining(['--maxWorkers=1', '--no-file-parallelism']),
    );
    expect(processHeavy.some((arg) => arg.startsWith('--reporter='))).toBe(
      false,
    );
    expect(
      buildVitestCommand(VITEST_CORPUS_GROUPS[2], ['exclusive.test.ts']),
    ).toEqual(
      expect.arrayContaining(['--maxWorkers=1', '--no-file-parallelism']),
    );
  });

  it('removes only the inherited Playwright cache from process-heavy work', () => {
    const inherited = {
      PATH: '/reviewed/bin',
      PLAYWRIGHT_BROWSERS_PATH: '/ambient/ms-playwright',
      STATION_TEST_MARKER: 'preserved',
    };
    expect(vitestGroupEnvironment(VITEST_CORPUS_GROUPS[1], inherited)).toEqual({
      PATH: '/reviewed/bin',
      STATION_TEST_MARKER: 'preserved',
    });
    expect(
      vitestGroupEnvironment(ORDINARY_SHARD_DESCRIPTORS[0], inherited),
    ).toBe(inherited);
  });

  it('never accepts an empty group as a pass', async () => {
    expect(() => buildVitestCommand(ORDINARY_SHARD_DESCRIPTORS[0], [])).toThrow(
      /has no discovered tests/,
    );
    expect(() =>
      buildVitestCommand(VITEST_CORPUS_GROUPS[0], ['ordinary.test.ts']),
    ).toThrow(/requires exactly one/);
    await expect(
      runVitestCorpus({
        groups: { ...GROUPS, ordinary: [] },
        // Exercise the grouped path explicitly. On Windows the production
        // runner deliberately selects one serialized corpus; allowing that
        // here would recursively start this test from inside itself.
        platform: 'linux',
        onResult: () => {},
      }),
    ).rejects.toThrow(/has no discovered tests/);
  });

  it('runs groups in canonical order and fails fast on the first failure', async () => {
    const calls: string[] = [];
    const result = await runVitestCorpus({
      groups: GROUPS,
      platform: 'linux',
      runGroup: async (group) => {
        calls.push(group.resultName ?? group.name);
        return {
          name: group.name,
          passed: group.name !== 'process-heavy',
          status: group.name === 'process-heavy' ? 1 : 0,
          outputBytes: 0,
          output: '',
        };
      },
      onResult: () => {},
    });
    expect(calls).toEqual([
      'ordinary-1-of-8',
      'ordinary-2-of-8',
      'ordinary-3-of-8',
      'ordinary-4-of-8',
      'ordinary-5-of-8',
      'ordinary-6-of-8',
      'ordinary-7-of-8',
      'ordinary-8-of-8',
      'process-heavy',
    ]);
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(9);
  });

  it('settles an ordinary writer before starting the shared-output policy reader', async () => {
    const events: string[] = [];
    const result = await runVitestCorpus({
      groups: {
        ...GROUPS,
        ordinary: ['synthetic-ordinary-writer.test.ts'],
        sharedOutput: ['verification-policy-reader.test.ts'],
      },
      platform: 'linux',
      runGroup: async (group) => {
        if (group.resultName === 'ordinary-8-of-8') {
          events.push('writer-started');
          await Promise.resolve();
          events.push('writer-settled');
        }
        if (group.name === 'shared-output') {
          expect(events).toContain('writer-settled');
          events.push('policy-read-started');
        }
        return {
          name: group.name,
          passed: true,
          status: 0,
          output: '',
          outputBytes: 0,
        };
      },
      onResult: () => {},
    });

    expect(result.passed).toBe(true);
    expect(events).toEqual([
      'writer-started',
      'writer-settled',
      'policy-read-started',
    ]);
  });

  it('runs one named resource group as an independently checkpointable corpus slice', async () => {
    const calls: string[] = [];
    const result = await runVitestCorpus({
      groups: GROUPS,
      platform: 'linux',
      groupName: 'shared-output',
      runGroup: async (group) => {
        calls.push(group.name);
        return { name: group.name, passed: true, status: 0, output: '' };
      },
      onResult: () => {},
    });
    expect(calls).toEqual(['shared-output']);
    expect(result.passed).toBe(true);
  });

  it('accepts only a known explicit resource-group selector', () => {
    expect(parseVitestCorpusArguments([])).toEqual({});
    expect(
      parseVitestCorpusArguments(['--group=ordinary', '--shard=3/8']),
    ).toEqual({ groupName: 'ordinary', shard: '3/8' });
    expect(() => parseVitestCorpusArguments(['--group=ordinary'])).toThrow(
      /requires exactly --shard/,
    );
    expect(() =>
      parseVitestCorpusArguments(['--group=process-heavy', '--shard=1/8']),
    ).toThrow(/only with --group=ordinary/);
    expect(() =>
      parseVitestCorpusArguments(['--group=ordinary', '--shard=0/8']),
    ).toThrow(/requires exactly --shard/);
    expect(() =>
      parseVitestCorpusArguments(['--group=ordinary', '--shard=1/9']),
    ).toThrow(/requires exactly --shard/);
    expect(() => parseVitestCorpusArguments(['--group=unknown'])).toThrow(
      /unknown Vitest corpus group/,
    );
    expect(() => parseVitestCorpusArguments(['--unexpected'])).toThrow(/usage/);
  });

  it('uses the exact current Node executable to own a child group', async () => {
    let executable = '';
    const result = await runVitestGroup(
      ORDINARY_SHARD_DESCRIPTORS[0],
      ['ordinary.test.ts'],
      {
        execute: (command, _args, _spawn, _label, options) => {
          executable = command;
          expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
          return completedExecution();
        },
        capture: () => ({
          finish: () => ({
            stdout: { text: 'ok', sourceBytes: 2 },
            stderr: { text: '', sourceBytes: 0 },
            truncated: false,
          }),
        }),
      },
    );
    expect(executable).toBe(process.execPath);
    expect(result.passed).toBe(true);
    expect(result.output).toBe('ok');
    expect(result).toMatchObject({
      name: 'ordinary-1-of-8',
      stdout: 'ok',
      stderr: '',
      stdoutBytes: 2,
      stderrBytes: 0,
    });
  });

  it('retains shard identity and separate stream tails in failure output', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      emitResult({
        name: 'ordinary-2-of-8',
        passed: false,
        status: 1,
        error: 'Vitest exited 1',
        stdout: 'last passing test',
        stderr: 'fatal diagnostic',
        outputBytes: 33,
      });
      expect(stdout.mock.calls.flat().join('')).toContain(
        '[vitest-corpus] ordinary-2-of-8 stdout tail:\nlast passing test',
      );
      expect(stderr.mock.calls.flat().join('')).toContain(
        '[vitest-corpus] ordinary-2-of-8 stderr tail:\nfatal diagnostic',
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('does not spawn owned work when a group is already interrupted', async () => {
    const controller = new AbortController();
    controller.abort('test interrupt');
    let terminated = 0;
    const result = await runVitestGroup(
      ORDINARY_SHARD_DESCRIPTORS[0],
      ['ordinary.test.ts'],
      {
        signal: controller.signal,
        execute: () => {
          throw new Error('must not execute');
        },
        capture: () => ({
          finish: () => ({
            stdout: { text: '', sourceBytes: 0 },
            stderr: { text: '', sourceBytes: 0 },
            truncated: false,
          }),
        }),
        terminate: async () => {
          terminated += 1;
          return { settled: true, errors: [] };
        },
      },
    );
    expect(terminated).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/cancelled/);
  });

  it('does not admit a later group after a signal arrives between groups', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const result = await runVitestCorpus({
      groups: GROUPS,
      platform: 'linux',
      signal: controller.signal,
      runGroup: async (group) => {
        calls.push(group.resultName ?? group.name);
        controller.abort('between groups');
        return {
          name: group.name,
          passed: true,
          status: 0,
          output: '',
          outputBytes: 0,
        };
      },
      onResult: () => {},
    });
    expect(calls).toEqual(['ordinary-1-of-8']);
    expect(result.passed).toBe(false);
    expect(result.results.at(-1)?.error).toMatch(/between groups/);
  });

  it('does not even discover or admit a corpus after an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort('before discovery');
    const result = await runVitestCorpus({
      // A missing root proves discovery did not spawn Vitest before the abort
      // check; passing groups would not cover this default-path regression.
      root: '/definitely-missing-station-root',
      signal: controller.signal,
      runGroup: async () => {
        throw new Error('must not execute');
      },
      onResult: () => {},
    });
    expect(result.passed).toBe(false);
    expect(result.results[0].error).toMatch(/before discovery/);
  });

  it('actively terminates a noisy child before it reports close', async () => {
    let terminated = 0;
    const execution = {
      ...completedExecution(),
      completion: new Promise<never>(() => {}),
    };
    const result = await runVitestGroup(
      ORDINARY_SHARD_DESCRIPTORS[0],
      ['ordinary.test.ts'],
      {
        execute: () => execution,
        capture: (_execution, options) => {
          options.onOverflow();
          return {
            finish: () => ({
              stdout: { text: '', sourceBytes: 0 },
              stderr: { text: '', sourceBytes: 0 },
              truncated: true,
            }),
          };
        },
        terminate: async () => {
          terminated += 1;
          return { settled: true, errors: [] };
        },
      },
    );
    expect(terminated).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/output exceeded/);
  });

  it('fails closed when a Windows-owned tree has no settlement proof', async () => {
    const result = await runVitestGroup(
      ORDINARY_SHARD_DESCRIPTORS[0],
      ['ordinary.test.ts'],
      {
        execute: () => ({ ...completedExecution(), isAlive: () => true }),
        capture: () => ({
          finish: () => ({
            stdout: { text: '', sourceBytes: 0 },
            stderr: { text: '', sourceBytes: 0 },
            truncated: false,
          }),
        }),
        terminate: async () => ({ settled: false, errors: [] }),
        waitForSettlement: async () => false,
      },
    );
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/left an owned process tree alive/);
  });

  it('allows descendants a bounded natural-reap window after Vitest closes', async () => {
    let alive = true;
    let terminated = 0;
    const result = await runVitestGroup(
      ORDINARY_SHARD_DESCRIPTORS[0],
      ['ordinary.test.ts'],
      {
        execute: () => ({
          ...completedExecution(),
          isAlive: () => alive,
        }),
        capture: () => ({
          finish: () => ({
            stdout: { text: '', sourceBytes: 0 },
            stderr: { text: '', sourceBytes: 0 },
            truncated: false,
          }),
        }),
        waitForSettlement: async () => {
          alive = false;
          return true;
        },
        terminate: async () => {
          terminated += 1;
          return { settled: true, errors: [] };
        },
      },
    );
    expect(result.passed).toBe(true);
    expect(terminated).toBe(0);
  });

  it('uses the explicit serialized fallback on Windows instead of treating launcher close as settlement', async () => {
    const command = buildWindowsSerializedCommand();
    expect(command).toEqual(
      expect.arrayContaining(['--maxWorkers=1', '--no-file-parallelism']),
    );
    let spawned = 0;
    const fallback = runWindowsSerializedCorpus({
      spawnSync: (executable, args) => {
        spawned += 1;
        expect(executable).toBe(process.execPath);
        expect(args).toEqual(command);
        return { status: 0, stdout: 'ok', stderr: '' } as never;
      },
    });
    expect(spawned).toBe(1);
    expect(fallback.passed).toBe(true);
    const ordinaryFallback = runWindowsSerializedCorpus({
      groupName: 'ordinary',
      shard: '2/8',
      groups: GROUPS,
      spawnSync: (_executable, args) => {
        expect(args).toEqual(
          expect.arrayContaining([
            '--maxWorkers=1',
            '--shard=2/8',
            '--no-file-parallelism',
          ]),
        );
        return { status: 0, stdout: 'ordinary ok', stderr: '' } as never;
      },
    });
    expect(ordinaryFallback.name).toBe('ordinary-2-of-8');
    let normalRunGroups = 0;
    const serializedCalls: Array<[string, string | undefined]> = [];
    const result = await runVitestCorpus({
      groups: GROUPS,
      platform: 'win32',
      runGroup: async () => {
        normalRunGroups += 1;
        throw new Error('normal owned runner must not run on Windows');
      },
      runWindowsSerialized: ({ groupName, shard }) => {
        serializedCalls.push([groupName, shard]);
        return {
          ...fallback,
          name: shard ? `ordinary-${shard.replace('/', '-of-')}` : groupName,
        };
      },
      onResult: () => {},
    });
    expect(normalRunGroups).toBe(0);
    expect(serializedCalls).toEqual([
      ['ordinary', '1/8'],
      ['ordinary', '2/8'],
      ['ordinary', '3/8'],
      ['ordinary', '4/8'],
      ['ordinary', '5/8'],
      ['ordinary', '6/8'],
      ['ordinary', '7/8'],
      ['ordinary', '8/8'],
      ['process-heavy', undefined],
      ['process-exclusive', undefined],
      ['shared-output', undefined],
      ['dogfood-reconcile', undefined],
    ]);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(12);
  });
});
