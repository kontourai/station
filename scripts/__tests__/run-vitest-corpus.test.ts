import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildVitestCommand,
  buildWindowsSerializedCommand,
  coverageSliceArguments,
  descriptorFiles,
  emitResult,
  ORDINARY_SHARD_COUNT,
  ORDINARY_SHARD_DESCRIPTORS,
  parseVitestCorpusArguments,
  partitionShardFiles,
  quarantineExclusionReport,
  reportQuarantineExclusions,
  runVitestCorpus,
  runVitestGroup,
  runWindowsSerializedCorpus,
  VITEST_CORPUS_GROUPS,
  withoutQuarantinedFiles,
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
      {
        name: 'coordinator-exclusive',
        maxWorkers: 1,
        noFileParallelism: true,
      },
      {
        name: 'credential-ledger-exclusive',
        maxWorkers: 1,
        noFileParallelism: true,
      },
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
    expect(processHeavy).toContain('--maxWorkers=2');
    expect(processHeavy.some((arg) => arg.startsWith('--reporter='))).toBe(
      false,
    );
    expect(
      buildVitestCommand(VITEST_CORPUS_GROUPS[2], ['exclusive.test.ts']),
    ).toEqual(
      expect.arrayContaining(['--maxWorkers=1', '--no-file-parallelism']),
    );
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
    expect(
      parseVitestCorpusArguments(['--group=process-heavy', '--shard=2/2']),
    ).toEqual({ groupName: 'process-heavy', shard: '2/2' });
    for (const shard of ['0/2', '3/2', '1/1', '1/9', '1/', 'x/2', '01/2'])
      expect(
        () =>
          parseVitestCorpusArguments([
            '--group=process-heavy',
            `--shard=${shard}`,
          ]),
        shard,
      ).toThrow(/process-heavy Vitest corpus accepts only/);
    expect(() =>
      parseVitestCorpusArguments(['--group=shared-output', '--shard=1/2']),
    ).toThrow(/only with --group=ordinary or --group=process-heavy/);
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

  it('reports a signal-cancelled group as CANCELLED, never as a test failure', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      emitResult({
        name: 'ordinary',
        passed: false,
        cancelled: true,
        status: null,
        error: 'Vitest corpus cancelled: SIGTERM',
        stdout: 'partial transcript',
        stderr: '',
        outputBytes: 903230,
      });
      const out = stdout.mock.calls.flat().join('');
      // The exact regression: a 45-minute phase deadline was printed as FAIL,
      // sending readers to look for a failing test that never existed.
      expect(out).toContain('[vitest-corpus] ordinary: CANCELLED; 903230');
      expect(out).not.toContain('ordinary: FAIL');
      expect(out).toContain('no test results were produced');
      expect(stderr.mock.calls.flat().join('')).toContain(
        'Vitest corpus cancelled: SIGTERM',
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('still reports a genuine non-zero Vitest status as FAIL', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      emitResult({
        name: 'ordinary-2-of-8',
        passed: false,
        status: 1,
        error: 'Vitest exited 1',
        stdout: 'x',
        stderr: 'y',
        outputBytes: 2,
      });
      const out = stdout.mock.calls.flat().join('');
      expect(out).toContain('[vitest-corpus] ordinary-2-of-8: FAIL; 2');
      expect(out).not.toContain('no test results were produced');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('marks a corpus interrupted by the coordinator as cancelled, not failed', async () => {
    const controller = new AbortController();
    controller.abort('SIGTERM');
    const { passed, results } = await runVitestCorpus({
      signal: controller.signal,
      onResult: () => {},
      runGroup: () => {
        throw new Error('must not run a group after cancellation');
      },
    });
    expect(passed).toBe(false);
    expect(results[0].cancelled).toBe(true);
    expect(results[0].error).toContain('cancelled');
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
      ['coordinator-exclusive', undefined],
      ['credential-ledger-exclusive', undefined],
      ['shared-output', undefined],
      ['dogfood-reconcile', undefined],
    ]);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(14);
  });
});

it('audit mode runs every independent group and retains every failure', async () => {
  const calls: string[] = [];
  const result = await runVitestCorpus({
    groups: GROUPS,
    platform: 'linux',
    keepGoing: true,
    onResult: () => {},
    runGroup: async (group) => {
      calls.push(group.resultName ?? group.name);
      const failed = ['ordinary-1-of-8', 'process-heavy'].includes(
        group.resultName ?? group.name,
      );
      return { name: group.name, passed: !failed, status: failed ? 1 : 0 };
    },
  });
  expect(calls).toContain('dogfood-reconcile');
  expect(result.results.filter((row) => !row.passed)).toHaveLength(2);
  expect(result.passed).toBe(false);
});
it('audit mode stops on unsafe cleanup or cancellation', async () => {
  const result = await runVitestCorpus({
    groups: GROUPS,
    platform: 'linux',
    keepGoing: true,
    onResult: () => {},
    runGroup: async (group) => ({
      name: group.name,
      passed: false,
      status: 1,
      error: 'owned child did not settle',
    }),
  });
  expect(result.results).toHaveLength(1);
  expect(result.passed).toBe(false);
  expect(parseVitestCorpusArguments(['--keep-going'])).toEqual({
    keepGoing: true,
  });
  expect(() =>
    parseVitestCorpusArguments(['--keep-going', '--keep-going']),
  ).toThrow(/usage/);
});

it('audit mode enforces the cataloged group deadline and releases its timer', async () => {
  const { FULL_REGRESSION_PHASES } = await import('../verification-lanes.mjs');
  vi.useFakeTimers();
  const parent = new AbortController();
  let observed: AbortSignal | undefined;
  const run = runVitestCorpus({
    groups: GROUPS,
    platform: 'linux',
    keepGoing: true,
    signal: parent.signal,
    onResult: () => {},
    runGroup: async (group, _files, { signal }) => {
      observed = signal;
      return new Promise<{
        name: string;
        passed: false;
        status: null;
        cancelled: true;
        error: string;
      }>((resolve) =>
        signal!.addEventListener(
          'abort',
          () =>
            resolve({
              name: group.name,
              passed: false,
              status: null,
              cancelled: true,
              error: 'group expired',
            }),
          { once: true },
        ),
      );
    },
  });
  try {
    const budget = FULL_REGRESSION_PHASES.find(
      (phase) => phase.id === 'test-full-ordinary-1-of-8',
    )!.timeoutMs;
    await vi.advanceTimersByTimeAsync(budget);
    expect(observed?.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    const result = await run;
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    parent.abort();
    await run;
    vi.useRealTimers();
  }
});

it('Windows serialized diagnostics receive an execution bound and report timeout as cancellation', () => {
  const spawnSync = vi.fn(() => ({
    status: null,
    signal: 'SIGTERM',
    error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    stdout: '',
    stderr: '',
  }));
  const result = runWindowsSerializedCorpus({ spawnSync, timeoutMs: 100 });
  expect(spawnSync).toHaveBeenCalledWith(
    process.execPath,
    expect.any(Array),
    expect.objectContaining({ timeout: 100 }),
  );
  expect(result).toMatchObject({ passed: false, cancelled: true });
});

describe('process-heavy sharding across machines', () => {
  const files = Array.from(
    { length: 11 },
    (_, index) =>
      `scripts/__tests__/heavy-${String(index).padStart(2, '0')}.test.ts`,
  ).reverse();

  it('partitions the group exhaustively and disjointly for every supported count', () => {
    for (let count = 2; count <= 8; count += 1) {
      const slices = Array.from({ length: count }, (_, index) =>
        partitionShardFiles(files, `${index + 1}/${count}`),
      );
      const union = slices.flat();
      expect(new Set(union).size, `count ${count}: no duplicates`).toBe(
        union.length,
      );
      expect([...union].sort(), `count ${count}: no file lost`).toEqual(
        [...files].sort(),
      );
    }
    // Deterministic regardless of discovery order.
    expect(partitionShardFiles([...files].sort(), '1/2')).toEqual(
      partitionShardFiles(files, '1/2'),
    );
  });

  it('refuses an empty slice instead of passing it vacuously', () => {
    expect(() => partitionShardFiles(['only.test.ts'], '2/2')).toThrow(
      /selected no files/,
    );
  });

  it('runs only its slice, at the group worker bound, under the group budget', async () => {
    const groups = {
      ...GROUPS,
      processHeavy: ['c.test.ts', 'a.test.ts', 'b.test.ts'],
    };
    const seen: Array<{ name: string; files: string[]; command: string[] }> =
      [];
    const result = await runVitestCorpus({
      groups,
      platform: 'linux',
      groupName: 'process-heavy',
      shard: '1/2',
      keepGoing: true,
      onResult: () => {},
      runGroup: async (group, selected) => {
        seen.push({
          name: group.resultName ?? group.name,
          files: selected,
          command: buildVitestCommand(group, selected),
        });
        return {
          name: group.resultName ?? group.name,
          passed: true,
          status: 0,
        };
      },
    });
    expect(result.passed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('process-heavy-1-of-2');
    expect(seen[0].files).toEqual(['a.test.ts', 'c.test.ts']);
    expect(seen[0].command).toContain('--maxWorkers=2');
    expect(seen[0].command).not.toContain('b.test.ts');
    expect(seen[0].command.some((arg) => arg.startsWith('--shard='))).toBe(
      false,
    );
    expect(
      descriptorFiles(groups, { name: 'process-heavy', shard: '2/2' }),
    ).toEqual(['b.test.ts']);
    // Unsharded (the canonical full:regression phase) still runs the group.
    expect(descriptorFiles(groups, { name: 'process-heavy' })).toEqual(
      groups.processHeavy,
    );
  });

  it('applies the slice on the Windows serialized fallback too', () => {
    const groups = { ...GROUPS, processHeavy: ['b.test.ts', 'a.test.ts'] };
    const result = runWindowsSerializedCorpus({
      groupName: 'process-heavy',
      shard: '2/2',
      groups,
      spawnSync: (_executable, args) => {
        expect(args).toContain('b.test.ts');
        expect(args).not.toContain('a.test.ts');
        return { status: 0, stdout: '', stderr: '' } as never;
      },
    });
    expect(result.passed).toBe(true);
    expect(result.name).toBe('process-heavy-2-of-2');
  });
});

describe('merge-queue quarantine exclusion', () => {
  const groups = {
    ordinary: ['ordinary.test.ts', 'flaky-ordinary.test.ts'],
    processHeavy: ['a.test.ts', 'flaky-heavy.test.ts', 'b.test.ts'],
    processExclusive: ['exclusive.test.ts'],
    coordinatorExclusive: ['flaky-coordinator.test.ts'],
    credentialLedgerExclusive: ['ledger.test.ts'],
    sharedOutput: ['shared.test.ts'],
    dogfoodReconcile: ['scripts/__tests__/station-dogfood-reconcile.test.ts'],
  };
  const now = new Date('2026-09-22T12:00:00Z');
  const entry = (file: string, expires = '2026-09-30') => ({
    file,
    issue: 'https://github.com/kontourai/station/issues/2400',
    expires,
    evidence:
      'commit 8e40e858a1b2c3d4e5f60718293a4b5c6d7e8f90 passed in run 35756143372 and failed in run 35756143999',
  });
  const quarantine = [
    entry('flaky-ordinary.test.ts'),
    entry('flaky-heavy.test.ts'),
    entry('flaky-coordinator.test.ts'),
  ];

  type Seen = {
    name: string;
    files: string[];
    options: Record<string, unknown>;
  };
  async function run(options: Record<string, unknown>) {
    const seen: Seen[] = [];
    const results: Array<Record<string, unknown>> = [];
    const reports: Array<{ annotations: string[]; summary: string[] }> = [];
    const outcome = await runVitestCorpus({
      groups,
      platform: 'linux',
      quarantine,
      now,
      reportExclusions: (report) => reports.push(report),
      onResult: (result) => results.push(result),
      runGroup: async (group, files, runOptions) => {
        seen.push({
          name: group.resultName ?? group.name,
          files,
          options: runOptions,
        });
        return {
          name: group.resultName ?? group.name,
          passed: true,
          status: 0,
        };
      },
      ...options,
    });
    return { outcome, seen, results, reports };
  }

  it('announces every excluded file per run, and nothing for an untouched group or the canonical lane', async () => {
    const heavy = await run({
      groupName: 'process-heavy',
      shard: '2/2',
      excludeQuarantined: true,
    });
    expect(heavy.reports).toHaveLength(1);
    expect(heavy.reports[0].annotations).toEqual([
      '::notice title=Quarantined test excluded::flaky-heavy.test.ts was excluded from merge-queue run process-heavy-2-of-2 (quarantined until 2026-09-30, https://github.com/kontourai/station/issues/2400); Nightly still runs it.',
    ]);
    expect(heavy.reports[0].summary).toEqual([
      '- `flaky-heavy.test.ts` excluded from `process-heavy-2-of-2` (quarantined until 2026-09-30, https://github.com/kontourai/station/issues/2400); Nightly still runs it.',
    ]);
    const ordinary = await run({
      groupName: 'ordinary',
      shard: '3/8',
      excludeQuarantined: true,
    });
    expect(ordinary.reports.flatMap(({ annotations }) => annotations)).toEqual([
      expect.stringContaining(
        'flaky-ordinary.test.ts was excluded from merge-queue run ordinary-3-of-8',
      ),
    ]);
    // A fully quarantined group is announced as well as reported skipped.
    const coordinator = await run({
      groupName: 'coordinator-exclusive',
      excludeQuarantined: true,
    });
    expect(coordinator.reports[0].annotations).toEqual([
      expect.stringContaining('flaky-coordinator.test.ts'),
    ]);
    expect(
      (await run({ groupName: 'shared-output', excludeQuarantined: true }))
        .reports,
    ).toEqual([]);
    expect((await run({ groupName: 'process-heavy' })).reports).toEqual([]);
  });

  it('writes annotations to the log and appends the step summary', () => {
    const report = quarantineExclusionReport('ordinary-1-of-8', [
      { ...quarantine[0], file: 'odd%name.test.ts' },
    ]);
    const written: string[] = [];
    const appended: Array<[string, string]> = [];
    reportQuarantineExclusions(report, {
      env: { GITHUB_STEP_SUMMARY: '/summary.md' },
      write: (text) => written.push(text),
      append: (path, text) => appended.push([path, text]),
    });
    // `%` is escaped so the workflow command cannot be misparsed.
    expect(written).toEqual([expect.stringContaining('odd%25name.test.ts')]);
    expect(appended).toEqual([
      ['/summary.md', expect.stringContaining('`odd%name.test.ts` excluded')],
    ]);
    const outside: Array<[string, string]> = [];
    reportQuarantineExclusions(report, {
      env: {},
      write: () => {},
      append: (path, text) => outside.push([path, text]),
    });
    expect(outside).toEqual([]);
  });

  it('drops quarantined files from every queue group, ordinary through its excludes', async () => {
    const heavy = await run({
      groupName: 'process-heavy',
      excludeQuarantined: true,
    });
    expect(heavy.seen.map(({ files }) => files)).toEqual([
      ['a.test.ts', 'b.test.ts'],
    ]);
    // A slice is dealt from the group AFTER exclusion, so the two slices
    // still cover exactly the non-quarantined files.
    const slices = await Promise.all(
      ['1/2', '2/2'].map((shard) =>
        run({ groupName: 'process-heavy', shard, excludeQuarantined: true }),
      ),
    );
    expect(slices.flatMap(({ seen }) => seen[0].files).sort()).toEqual([
      'a.test.ts',
      'b.test.ts',
    ]);

    // Vitest selects the ordinary shard itself, so exclusion must reach its
    // --exclude argv, not just the file list the runner holds.
    const ordinary = await run({
      groupName: 'ordinary',
      shard: '1/8',
      excludeQuarantined: true,
    });
    const excludes = ordinary.seen[0].options.ordinaryExcludes as string[];
    expect(excludes).toContain('flaky-ordinary.test.ts');
    const command = buildVitestCommand(
      ORDINARY_SHARD_DESCRIPTORS[0],
      ordinary.seen[0].files,
      { ordinaryExcludes: excludes },
    );
    expect(command).toContain('--exclude=flaky-ordinary.test.ts');
    expect(command).toContain('--shard=1/8');
  });

  it('threads the queue excludes into the real ordinary Vitest argv', async () => {
    let argv: string[] = [];
    await runVitestGroup(ORDINARY_SHARD_DESCRIPTORS[0], ['ordinary.test.ts'], {
      execute: (_executable, args) => {
        argv = args;
        return completedExecution();
      },
      capture: () => ({
        finish: () => ({
          stdout: { text: '', sourceBytes: 0 },
          stderr: { text: '', sourceBytes: 0 },
          truncated: false,
        }),
      }),
      ordinaryExcludes: ['flaky-ordinary.test.ts'],
    });
    expect(argv).toContain('--exclude=flaky-ordinary.test.ts');
  });

  it('keeps the canonical lane unchanged: without the flag every quarantined file runs', async () => {
    for (const [groupName, shard, file] of [
      ['ordinary', '1/8', null],
      ['process-heavy', undefined, 'flaky-heavy.test.ts'],
      ['coordinator-exclusive', undefined, 'flaky-coordinator.test.ts'],
    ] as const) {
      const { seen } = await run({ groupName, shard });
      expect(seen, groupName).toHaveLength(1);
      // No queue-only option reaches the runner at all.
      expect(Object.keys(seen[0].options).sort(), groupName).toEqual([
        'root',
        'signal',
      ]);
      if (file) expect(seen[0].files, groupName).toContain(file);
    }
    // The canonical ordinary argv excludes no quarantined file.
    expect(
      buildVitestCommand(ORDINARY_SHARD_DESCRIPTORS[0], ['ordinary.test.ts']),
    ).not.toContain('--exclude=flaky-ordinary.test.ts');
  });

  it('reports a group whose every file is quarantined as skipped, not run', async () => {
    const { seen, results, outcome } = await run({
      groupName: 'coordinator-exclusive',
      excludeQuarantined: true,
    });
    expect(seen).toEqual([]);
    expect(outcome.passed).toBe(true);
    expect(results[0]).toMatchObject({
      name: 'coordinator-exclusive',
      passed: true,
      skipped: expect.stringContaining('Nightly still runs them'),
    });
  });

  it('fails closed on a stale entry, an unsupported platform, and a group-less flag', async () => {
    expect(() =>
      withoutQuarantinedFiles(groups, [entry('renamed-away.test.ts')], {
        now,
      }),
    ).toThrow(/not in the discovered Vitest corpus: renamed-away.test.ts/);
    await expect(
      run({
        groupName: 'shared-output',
        excludeQuarantined: true,
        platform: 'win32',
      }),
    ).rejects.toThrow(/owned \(non-Windows\) runner/);
    expect(
      parseVitestCorpusArguments([
        '--group=process-heavy',
        '--shard=1/2',
        '--exclude-quarantined',
      ]),
    ).toEqual({
      groupName: 'process-heavy',
      shard: '1/2',
      excludeQuarantined: true,
    });
    expect(() => parseVitestCorpusArguments(['--exclude-quarantined'])).toThrow(
      /requires --group/,
    );
    expect(() =>
      parseVitestCorpusArguments([
        '--group=shared-output',
        '--exclude-quarantined',
        '--exclude-quarantined',
      ]),
    ).toThrow(/may be supplied once/);
  });
});

describe('quarantine expiry inside the queue phase', () => {
  const groups = {
    ordinary: ['ordinary.test.ts'],
    processHeavy: ['a.test.ts', 'flaky-heavy.test.ts'],
    processExclusive: ['exclusive.test.ts'],
    coordinatorExclusive: ['coordinator.test.ts'],
    credentialLedgerExclusive: ['ledger.test.ts'],
    sharedOutput: ['shared.test.ts'],
    dogfoodReconcile: ['scripts/__tests__/station-dogfood-reconcile.test.ts'],
  };
  const expired = [
    {
      file: 'flaky-heavy.test.ts',
      issue: 'https://github.com/kontourai/station/issues/2400',
      expires: '2026-09-22',
      evidence:
        'commit 8e40e858a1b2c3d4e5f60718293a4b5c6d7e8f90 passed in run 35756143372 and failed in run 35756143999',
    },
  ];
  const now = new Date('2026-09-22T08:00:00Z');

  it('fails the queue phase on an expired entry instead of excluding its file', async () => {
    const ran: string[][] = [];
    await expect(
      runVitestCorpus({
        groups,
        platform: 'linux',
        groupName: 'process-heavy',
        excludeQuarantined: true,
        quarantine: expired,
        now,
        onResult: () => {},
        runGroup: async (group, files) => {
          ran.push(files);
          return { name: group.name, passed: true, status: 0 };
        },
      }),
    ).rejects.toThrow(
      /test quarantine does not hold; nothing was excluded:\n.*quarantine expired on 2026-09-22/,
    );
    expect(ran).toEqual([]);
    // The day before, the same entry is honoured.
    const dayBefore = await runVitestCorpus({
      groups,
      platform: 'linux',
      groupName: 'process-heavy',
      excludeQuarantined: true,
      quarantine: expired,
      now: new Date('2026-09-21T23:59:00Z'),
      onResult: () => {},
      runGroup: async (group, files) => {
        ran.push(files);
        return { name: group.name, passed: true, status: 0 };
      },
    });
    expect(dayBefore.passed).toBe(true);
    expect(ran).toEqual([['a.test.ts']]);
  });

  it('leaves the canonical lane untouched by an expired entry: it runs the file', async () => {
    const ran: string[][] = [];
    const result = await runVitestCorpus({
      groups,
      platform: 'linux',
      groupName: 'process-heavy',
      quarantine: expired,
      now,
      onResult: () => {},
      runGroup: async (group, files) => {
        ran.push(files);
        return { name: group.name, passed: true, status: 0 };
      },
    });
    expect(result.passed).toBe(true);
    expect(ran).toEqual([['a.test.ts', 'flaky-heavy.test.ts']]);
  });
});

describe('coverage slices', () => {
  it('adds per-slice coverage output with thresholds deferred to the merge', () => {
    const plain = buildVitestCommand(VITEST_CORPUS_GROUPS[2], ['a.test.ts']);
    expect(plain.some((arg) => arg.startsWith('--coverage'))).toBe(false);
    const command = buildVitestCommand(VITEST_CORPUS_GROUPS[2], ['a.test.ts'], {
      coverageDirectory: '/tmp/slices/process-exclusive',
    });
    expect(command).toEqual(
      expect.arrayContaining([
        '--maxWorkers=1',
        '--no-file-parallelism',
        '--coverage.enabled=true',
        '--coverage.reporter=json',
        '--coverage.reportsDirectory=/tmp/slices/process-exclusive',
        '--coverage.thresholds.lines=0',
        '--coverage.thresholds.functions=0',
        '--coverage.thresholds.branches=0',
        '--coverage.thresholds.statements=0',
      ]),
    );
    // Vitest must stay free to suppress a failed slice's report.
    expect(command.some((arg) => arg.includes('reportOnFailure'))).toBe(false);
    expect(() => coverageSliceArguments('')).toThrow(/reports directory/);
  });

  it('gives every slice its own report directory and a scaled group deadline', async () => {
    const { FULL_REGRESSION_PHASES } = await import(
      '../verification-lanes.mjs'
    );
    const directories: string[] = [];
    const result = await runVitestCorpus({
      groups: GROUPS,
      platform: 'linux',
      keepGoing: true,
      coverageRoot: '/tmp/cov/shards',
      onResult: () => {},
      runGroup: async (group, _files, options) => {
        directories.push(String(options?.coverageDirectory));
        return { name: group.name, passed: true, status: 0 };
      },
    });
    expect(result.passed).toBe(true);
    expect(directories).toHaveLength(14);
    expect(new Set(directories).size).toBe(14);
    expect(directories[0].replaceAll('\\', '/')).toBe(
      '/tmp/cov/shards/ordinary-1-of-8',
    );
    expect(directories.at(-1)?.replaceAll('\\', '/')).toBe(
      '/tmp/cov/shards/dogfood-reconcile',
    );

    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    const run = runVitestCorpus({
      groups: GROUPS,
      platform: 'linux',
      keepGoing: true,
      coverageRoot: '/tmp/cov/shards',
      timeoutScale: 1.5,
      onResult: () => {},
      runGroup: async (group, _files, { signal }) => {
        observed = signal;
        return new Promise((resolve) =>
          signal!.addEventListener(
            'abort',
            () =>
              resolve({
                name: group.name,
                passed: false,
                status: null,
                cancelled: true,
                error: 'group expired',
              }),
            { once: true },
          ),
        );
      },
    });
    try {
      const budget = FULL_REGRESSION_PHASES.find(
        (phase) => phase.id === 'test-full-ordinary-1-of-8',
      )!.timeoutMs;
      // The canonical deadline alone no longer expires a coverage slice.
      await vi.advanceTimersByTimeAsync(budget);
      expect(observed?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(budget / 2);
      expect(observed?.aborted).toBe(true);
      expect((await run).passed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('threads the coverage directory into the real Vitest argv', async () => {
    // The corpus runner hands `coverageDirectory` to runVitestGroup; this
    // pins that runVitestGroup passes it on to the argv it executes, so a
    // conflict resolution that drops it cannot stay green.
    const argvFor = async (coverageDirectory?: string) => {
      let argv: string[] = [];
      await runVitestGroup(VITEST_CORPUS_GROUPS[2], ['exclusive.test.ts'], {
        execute: (_executable, args) => {
          argv = args;
          return completedExecution();
        },
        capture: () => ({
          finish: () => ({
            stdout: { text: '', sourceBytes: 0 },
            stderr: { text: '', sourceBytes: 0 },
            truncated: false,
          }),
        }),
        ...(coverageDirectory === undefined ? {} : { coverageDirectory }),
      });
      return argv;
    };
    const covered = await argvFor('/tmp/cov/shards/process-exclusive');
    expect(covered).toContain(
      '--coverage.reportsDirectory=/tmp/cov/shards/process-exclusive',
    );
    expect(covered).toContain('--coverage.enabled=true');
    expect(covered).toContain('exclusive.test.ts');
    const plain = await argvFor();
    expect(plain).toContain('exclusive.test.ts');
    expect(plain.some((arg) => arg.startsWith('--coverage'))).toBe(false);
  });

  it('refuses coverage on the Windows serialized fallback and a shrinking deadline', async () => {
    await expect(
      runVitestCorpus({
        groups: GROUPS,
        platform: 'win32',
        coverageRoot: '/tmp/cov/shards',
        onResult: () => {},
      }),
    ).rejects.toThrow(/not supported on Windows/);
    await expect(
      runVitestCorpus({
        groups: GROUPS,
        platform: 'linux',
        timeoutScale: 0.5,
        onResult: () => {},
      }),
    ).rejects.toThrow(/timeoutScale/);
  });
});
