import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  buildVitestCommand,
  buildWindowsSerializedCommand,
  parseVitestCorpusArguments,
  runVitestCorpus,
  runVitestGroup,
  runWindowsSerializedCorpus,
  VITEST_CORPUS_GROUPS,
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
      { name: 'process-heavy', maxWorkers: 2 },
      { name: 'process-exclusive', maxWorkers: 1, noFileParallelism: true },
      { name: 'shared-output', maxWorkers: 1, noFileParallelism: true },
      { name: 'dogfood-reconcile', maxWorkers: 1, noFileParallelism: true },
    ]);
    const command = buildVitestCommand(VITEST_CORPUS_GROUPS[0], [
      'one.test.ts',
    ]);
    expect(command[0].replaceAll('\\', '/')).toContain(
      'node_modules/vitest/vitest.mjs',
    );
    expect(command).toContain('--maxWorkers=4');
    expect(command).not.toContain('one.test.ts');
    expect(command.some((arg) => arg.startsWith('--exclude='))).toBe(true);
    expect(command).not.toContain('--no-file-parallelism');
    expect(
      buildVitestCommand(VITEST_CORPUS_GROUPS[1], ['process.test.ts']),
    ).toContain('--maxWorkers=2');
    expect(
      buildVitestCommand(VITEST_CORPUS_GROUPS[2], ['exclusive.test.ts']),
    ).toEqual(
      expect.arrayContaining(['--maxWorkers=1', '--no-file-parallelism']),
    );
  });

  it('never accepts an empty group as a pass', async () => {
    expect(() => buildVitestCommand(VITEST_CORPUS_GROUPS[0], [])).toThrow(
      /has no discovered tests/,
    );
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
        calls.push(group.name);
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
    expect(calls).toEqual(['ordinary', 'process-heavy']);
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(2);
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
        if (group.name === 'ordinary') {
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
    expect(parseVitestCorpusArguments(['--group=ordinary'])).toEqual({
      groupName: 'ordinary',
    });
    expect(() => parseVitestCorpusArguments(['--group=unknown'])).toThrow(
      /unknown Vitest corpus group/,
    );
    expect(() => parseVitestCorpusArguments(['--unexpected'])).toThrow(/usage/);
  });

  it('uses the exact current Node executable to own a child group', async () => {
    let executable = '';
    const result = await runVitestGroup(
      VITEST_CORPUS_GROUPS[0],
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
  });

  it('does not spawn owned work when a group is already interrupted', async () => {
    const controller = new AbortController();
    controller.abort('test interrupt');
    let terminated = 0;
    const result = await runVitestGroup(
      VITEST_CORPUS_GROUPS[0],
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
        calls.push(group.name);
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
    expect(calls).toEqual(['ordinary']);
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
      VITEST_CORPUS_GROUPS[0],
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
      VITEST_CORPUS_GROUPS[0],
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
      VITEST_CORPUS_GROUPS[0],
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
    let normalRunGroups = 0;
    const result = await runVitestCorpus({
      groups: GROUPS,
      platform: 'win32',
      runGroup: async () => {
        normalRunGroups += 1;
        throw new Error('normal owned runner must not run on Windows');
      },
      runWindowsSerialized: () => fallback,
      onResult: () => {},
    });
    expect(normalRunGroups).toBe(0);
    expect(result).toEqual({ passed: true, results: [fallback] });
  });
});
