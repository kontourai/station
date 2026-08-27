import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForOwnedOutputEOF,
} from '../lib/owned-process.mjs';

const NEVER = new Promise<never>(() => {});

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};
function mockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('owned process lifecycle', () => {
  test('binds and completes without a launcher CIM resolver or PID cleanup', async () => {
    let taskkillCalls = 0;
    const wrapperSignals: string[] = [];
    const child = Object.assign(mockChild(), {
      pid: 4242,
      kill: (signal: string) => {
        wrapperSignals.push(signal);
        return true;
      },
      send: () => true,
    });
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
      },
      {
        platform: 'win32',
        runWindowsTaskkill: async () => {
          taskkillCalls += 1;
        },
      },
    );
    child.emit('message', {
      type: 'owned-command-bound',
      pid: 5151,
      processStart: 'target-birth',
      guard: { pid: 5152, start: 'guard-birth' },
      jobBound: true,
    });
    child.emit('message', { type: 'owned-command-complete', status: 0 });
    child.stdout.emit('end');
    child.stderr.emit('end');

    await expect(execution.promise).resolves.toMatchObject({
      status: 0,
    });
    await expect(execution.forceTerminate()).resolves.toBeUndefined();
    expect(taskkillCalls).toBe(0);
    expect(wrapperSignals).toEqual([]);
  });

  test('records normal COMPLETE plus raw EOF as Job settlement even after wrapper close', async () => {
    const child = Object.assign(mockChild(), {
      pid: 4242,
      connected: true,
      kill: () => true,
      send: () => true,
      disconnect: () => {},
    });
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
      },
      { platform: 'win32' },
    );
    child.emit('message', {
      type: 'owned-command-bound',
      pid: 5151,
      processStart: 'target-birth',
      guard: { pid: 5152, start: 'guard-birth' },
      jobBound: true,
    });
    child.emit('message', { type: 'owned-command-complete', status: 0 });
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.emit('close', 0, null);

    await expect(execution.promise).resolves.toMatchObject({ status: 0 });
    expect(execution.isAlive()).toBe(false);
  });

  test('settles an abort only after the launcher Job-settlement acknowledgement', async () => {
    const sent: unknown[] = [];
    const child = Object.assign(mockChild(), {
      pid: 4242,
      connected: true,
      kill: () => true,
      send: (message: unknown) => {
        sent.push(message);
        return true;
      },
    });
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
      },
      { platform: 'win32' },
    );
    const settlement = execution.terminate();
    await Promise.resolve();
    expect(sent).toContainEqual({ type: 'owned-command-abort' });

    child.emit('message', { type: 'owned-command-tree-settled' });
    await expect(settlement).resolves.toBeUndefined();
    child.emit('close', 0, null);
    await execution.launcherCompletion;
    expect(execution.isAlive()).toBe(false);
  });

  test('retains the fence when the launcher does not acknowledge abort settlement', async () => {
    const child = Object.assign(mockChild(), {
      pid: 4242,
      connected: true,
      kill: () => true,
      send: () => true,
    });
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
        treeSettlementTimeoutMs: 1,
      },
      { platform: 'win32' },
    );
    await expect(execution.terminate()).rejects.toThrow(/did not acknowledge/);
    child.emit('close', 0, null);
    await execution.launcherCompletion;
    expect(execution.isAlive()).toBe(true);
  });

  test('force-kills only the wrapper handle and retains the fence without Job proof', async () => {
    const wrapperSignals: string[] = [];
    const child = Object.assign(mockChild(), {
      pid: 4242,
      connected: true,
      kill: (signal: string) => {
        wrapperSignals.push(signal);
        return true;
      },
      send: () => true,
    });
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
        treeSettlementTimeoutMs: 1,
      },
      { platform: 'win32' },
    );
    await expect(execution.forceTerminate()).rejects.toThrow(
      /did not acknowledge/,
    );
    expect(wrapperSignals).toEqual(['SIGKILL']);
    child.emit('close', 0, null);
    await execution.launcherCompletion;
    expect(execution.isAlive()).toBe(true);
  });

  test('never signals bound target or guard identities by PID when they are recycled or unavailable', async () => {
    const sent: unknown[] = [];
    const wrapperSignals: string[] = [];
    const child = Object.assign(mockChild(), {
      pid: 4242,
      connected: true,
      kill: (signal: string) => {
        wrapperSignals.push(signal);
        return true;
      },
      send: (message: unknown) => {
        sent.push(message);
        return true;
      },
    });
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
        treeSettlementTimeoutMs: 1,
      },
      { platform: 'win32' },
    );
    child.emit('message', {
      type: 'owned-command-bound',
      pid: 5151,
      processStart: 'recycled-or-unavailable-target',
      guard: { pid: 5152, start: 'recycled-or-unavailable-guard' },
      jobBound: true,
    });

    await expect(execution.forceTerminate()).rejects.toThrow(
      /did not acknowledge/,
    );
    expect(sent).toContainEqual({ type: 'owned-command-abort' });
    expect(wrapperSignals).toEqual(['SIGKILL']);
  });

  test('does not spawn a Windows phase when the round-trip UTC coordinator CreationDate is unavailable', async () => {
    let spawns = 0;
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => {
        spawns += 1;
        return mockChild();
      }) as never,
      'fixture',
      { resolveParentIdentity: () => null },
      { platform: 'win32' },
    );
    await expect(execution.promise).resolves.toMatchObject({
      status: null,
      error: expect.any(Error),
    });
    expect(spawns).toBe(0);
  });

  test('publishes a Windows child only after the Job guard binding acknowledgement', async () => {
    const child = Object.assign(mockChild(), {
      pid: 4242,
      kill: () => true,
      send: () => true,
    });
    let bound: unknown;
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
        onSpawn: (_child: unknown, identity: unknown) => {
          bound = identity;
        },
      },
      { platform: 'win32' },
    );
    expect(bound).toBeUndefined();
    child.emit('message', {
      type: 'owned-command-bound',
      pid: 5151,
      processStart: 'child-birth',
      guard: { pid: 5152, start: 'guard-birth' },
      jobBound: true,
    });
    expect(bound).toMatchObject({
      pid: 5151,
      processStart: 'child-birth',
      jobBound: true,
      guard: { pid: 5152, start: 'guard-birth' },
    });
    child.emit('message', { type: 'owned-command-complete', status: 0 });
    child.stdout.emit('end');
    child.stderr.emit('end');
    await expect(execution.promise).resolves.toMatchObject({ status: 0 });
  });

  test('aborts the suspended guard when lease publication throws', async () => {
    const sent: unknown[] = [];
    const child = Object.assign(mockChild(), {
      pid: 4242,
      kill: () => true,
      send: (message: unknown) => sent.push(message),
    });
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
        onSpawn: () => {
          throw new Error('lease write failed');
        },
      },
      { platform: 'win32' },
    );
    child.emit('message', {
      type: 'owned-command-bound',
      token: 'guard-token',
      pid: 5151,
      processStart: 'child-birth',
      guard: { pid: 5152, start: 'guard-birth' },
      jobBound: true,
    });
    child.stdout.emit('end');
    child.stderr.emit('end');
    await expect(execution.promise).resolves.toMatchObject({
      status: null,
      error: expect.objectContaining({ message: 'lease write failed' }),
    });
    expect(sent).toContainEqual({
      type: 'owned-command-abort',
      token: 'guard-token',
    });
  });

  test('rejects a Job acknowledgement missing exact guard identity before onSpawn', async () => {
    const sent: unknown[] = [];
    const child = Object.assign(mockChild(), {
      pid: 4242,
      kill: () => true,
      send: (message: unknown) => sent.push(message),
    });
    let published = false;
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
        onSpawn: () => {
          published = true;
        },
      },
      { platform: 'win32' },
    );
    child.emit('message', {
      type: 'owned-command-bound',
      pid: 5151,
      processStart: 'child-birth',
      jobBound: true,
    });
    child.stdout.emit('end');
    child.stderr.emit('end');
    await expect(execution.promise).resolves.toMatchObject({ status: null });
    expect(published).toBe(false);
    expect(sent).toContainEqual({ type: 'owned-command-abort' });
  });

  test('waits for trailing raw stdout and stderr EOF after COMPLETE 0 before capture settles', async () => {
    const child = Object.assign(mockChild(), {
      pid: 4242,
      kill: () => true,
      send: () => true,
    });
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
        onSpawn: () => {},
      },
      { platform: 'win32' },
    );
    const capture = captureOwnedProcessOutput(execution);
    child.emit('message', {
      type: 'owned-command-bound',
      pid: 5151,
      processStart: 'child-birth',
      guard: { pid: 5152, start: 'guard-birth' },
      jobBound: true,
    });
    child.emit('message', { type: 'owned-command-complete', status: 0 });
    child.stdout.emit('data', Buffer.from('late stdout'));
    child.stderr.emit('data', Buffer.from('late stderr'));
    let settled = false;
    void execution.promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdout.emit('end');
    child.stderr.emit('end');
    await expect(execution.promise).resolves.toMatchObject({ status: 0 });
    expect(capture.finish()).toMatchObject({
      stdout: { text: 'late stdout' },
      stderr: { text: 'late stderr' },
    });
  });

  test('fails closed when a receiver output stream never reaches EOF', async () => {
    const child = mockChild();
    const barrier = waitForOwnedOutputEOF(child, 1);
    child.stdout.emit('end');
    await expect(barrier).rejects.toThrow(/did not reach EOF/);
  });

  test('fails closed when a receiver output stream errors before EOF', async () => {
    const child = mockChild();
    const barrier = waitForOwnedOutputEOF(child, 1);
    child.stdout.emit('error', new Error('raw output failure'));
    await expect(barrier).rejects.toThrow(/raw output failure/);
  });

  test('records an output EOF failure before command completion without an unhandled rejection', async () => {
    const child = Object.assign(mockChild(), {
      pid: 4242,
      kill: () => true,
      send: () => true,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const execution = executeOwnedCommand(
        'phase.exe',
        [],
        (() => child) as never,
        'fixture',
        {
          resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
        },
        { platform: 'win32' },
      );
      child.stdout.emit('close');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);

      child.emit('message', {
        type: 'owned-command-bound',
        pid: 5151,
        processStart: 'child-birth',
        guard: { pid: 5152, start: 'guard-birth' },
        jobBound: true,
      });
      child.emit('message', { type: 'owned-command-complete', status: 0 });

      await expect(execution.promise).resolves.toMatchObject({
        status: null,
        error: expect.objectContaining({
          message: expect.stringMatching(/closed before EOF/),
        }),
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('starts the trailing EOF timeout only after command completion', async () => {
    const child = Object.assign(mockChild(), {
      pid: 4242,
      kill: () => true,
      send: () => true,
    });
    const execution = executeOwnedCommand(
      'phase.exe',
      [],
      (() => child) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
        outputEofTimeoutMs: 1,
      },
      { platform: 'win32' },
    );
    let settled = false;
    void execution.promise.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    child.emit('message', {
      type: 'owned-command-bound',
      pid: 5151,
      processStart: 'child-birth',
      guard: { pid: 5152, start: 'guard-birth' },
      jobBound: true,
    });
    child.emit('message', { type: 'owned-command-complete', status: 0 });
    child.stdout.emit('end');
    child.stderr.emit('end');

    await expect(execution.promise).resolves.toMatchObject({ status: 0 });
  });

  test('preserves empty, spaced, and quoted Windows guard arguments in its opaque envelope', async () => {
    const child = Object.assign(mockChild(), { pid: 4242, kill: () => true });
    const calls: unknown[][] = [];
    const execution = executeOwnedCommand(
      'C:\\Program Files\\fixture.exe',
      ['', 'two words', 'a"quoted"value'],
      ((...args: unknown[]) => {
        calls.push(args);
        return child;
      }) as never,
      'fixture',
      {
        resolveParentIdentity: () => ({ pid: 99, start: 'parent-birth' }),
      },
      { platform: 'win32' },
    );
    const launcherArgs = calls[0][1] as string[];
    const envelope = JSON.parse(
      Buffer.from(launcherArgs[1], 'base64url').toString('utf8'),
    );
    expect(envelope).toMatchObject({
      executable: 'C:\\Program Files\\fixture.exe',
      args: ['', 'two words', 'a"quoted"value'],
    });
    child.emit('message', { type: 'owned-command-complete', status: 0 });
    child.stdout.emit('end');
    child.stderr.emit('end');
    await execution.promise;
  });

  test('retains exact bytes when the stream fits within the cap', () => {
    const child = mockChild();
    const capture = captureOwnedProcessOutput({ child } as never, {
      maxBytes: 16,
    });
    child.stdout.emit('data', Buffer.from('hello world', 'utf8'));
    const output = capture.finish();
    expect(output.stdout).toMatchObject({
      text: 'hello world',
      sourceBytes: 11,
      retainedBytes: 11,
      truncated: false,
      invalidUtf8: false,
    });
    expect(output.stdout.text).toBe('hello world');
  });

  test('retains the exact bounded prefix and counts every drained source byte on overflow', () => {
    const child = mockChild();
    const capture = captureOwnedProcessOutput({ child } as never, {
      maxBytes: 4,
    });
    child.stdout.emit('data', Buffer.from('ab'));
    child.stdout.emit('data', Buffer.from('cd'));
    child.stdout.emit('data', Buffer.from('ef'));
    child.stdout.emit('data', Buffer.from('gh'));
    const output = capture.finish();
    expect(output.stdout).toMatchObject({
      text: 'abcd',
      sourceBytes: 8,
      retainedBytes: 4,
      truncated: true,
    });
  });

  test('reassembles a multibyte sequence split across chunks before decoding', () => {
    const child = mockChild();
    const capture = captureOwnedProcessOutput({ child } as never, {
      maxBytes: 64,
    });
    // 'é' is 0xC3 0xA9; emit it split across two data events after ASCII text.
    child.stdout.emit('data', Buffer.from('caf'));
    child.stdout.emit('data', Buffer.from([0xc3]));
    child.stdout.emit('data', Buffer.from([0xa9]));
    const output = capture.finish();
    expect(output.stdout.text).toBe('café');
    expect(output.stdout.invalidUtf8).toBe(false);
  });

  test('backs off a valid multibyte code point that crosses the byte cap', () => {
    const child = mockChild();
    const capture = captureOwnedProcessOutput({ child } as never, {
      maxBytes: 2,
    });
    child.stdout.emit('data', Buffer.from('aé'));
    const output = capture.finish();
    expect(output.stdout).toMatchObject({
      text: 'a',
      sourceBytes: 3,
      retainedBytes: 1,
      truncated: true,
      invalidUtf8: false,
    });
  });

  test('keeps stdout and stderr as independent bounded streams', () => {
    const child = mockChild();
    const capture = captureOwnedProcessOutput({ child } as never, {
      maxBytes: 4,
    });
    child.stdout.emit('data', Buffer.from('stdout-bytes'));
    child.stderr.emit('data', Buffer.from('er'));
    const output = capture.finish();
    expect(output.stdout).toMatchObject({
      text: 'stdo',
      sourceBytes: 12,
      truncated: true,
    });
    expect(output.stderr).toMatchObject({
      text: 'er',
      sourceBytes: 2,
      truncated: false,
    });
    expect(output.truncated).toBe(true);
  });

  test('fail-closes invalid UTF-8 without printing the garbled bytes', () => {
    const child = mockChild();
    const capture = captureOwnedProcessOutput({ child } as never, {
      maxBytes: 64,
    });
    child.stderr.emit('data', Buffer.from([0xc3, 0x28]));
    const output = capture.finish();
    expect(output.stderr.invalidUtf8).toBe(true);
    expect(output.stderr.text).toBe('');
    expect(output.stderr.sourceBytes).toBe(2);
    expect(output.invalidUtf8).toBe(true);
  });

  test('remembers malformed UTF-8 observed immediately beyond the output cap', () => {
    const child = mockChild();
    const capture = captureOwnedProcessOutput({ child } as never, {
      maxBytes: 2,
    });
    child.stdout.emit('data', Buffer.from([0x61, 0x62, 0xff]));
    const output = capture.finish();
    expect(output.stdout).toMatchObject({
      text: '',
      sourceBytes: 3,
      truncated: true,
      invalidUtf8: true,
    });
  });

  test('a successful child that overflows its cap carries the nonpass truncation signal', async () => {
    const execution = executeOwnedProcess(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.alloc(5000, 0x61));'],
      undefined,
      'overflow success',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const capture = captureOwnedProcessOutput(execution, { maxBytes: 1024 });
    const result = await execution.promise;
    const output = capture.finish();
    // The child exited zero, but its full stream was not retained. Existing
    // callers (e.g. run-vitest-corpus) consume `truncated` as a nonpass signal
    // (passed = status === 0 && !error), so this cannot look like a complete
    // passing evidence capture.
    expect(result.status).toBe(0);
    expect(output.truncated).toBe(true);
    expect(output.stdout.sourceBytes).toBe(5000);
    expect(output.stdout.retainedBytes).toBe(1024);
    expect(output.stdout.text).toBe('a'.repeat(1024));
  });

  test('notifies the exact owner at the first bounded-output overflow', () => {
    const child = mockChild();
    let overflows = 0;
    const capture = captureOwnedProcessOutput({ child } as never, {
      maxBytes: 4,
      onOverflow: () => {
        overflows += 1;
      },
    });
    child.stdout.emit('data', Buffer.from('overflow'));
    child.stderr.emit('data', Buffer.from('again'));
    capture.finish();
    expect(overflows).toBe(1);
  });

  test('cleans lifecycle and pipe listeners after identity publication throws', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: (signal: string) => boolean;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 999_999;
    child.kill = () => true;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const execution = executeOwnedProcess(
      'fixture',
      [],
      (() => child) as never,
      'fixture',
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        onSpawn: () => {
          throw new Error('identity publication failed');
        },
      },
    );
    const capture = captureOwnedProcessOutput(execution);
    child.stdout.emit('data', Buffer.from('x'.repeat(16 * 1024)));
    await expect(execution.promise).resolves.toMatchObject({ status: null });
    capture.finish();
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stdout.listenerCount('error')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('error')).toBe(0);
  });

  test('owns an exact detached child rather than discovering by process name', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: (signal: string) => boolean;
    };
    child.pid = 4242;
    child.kill = () => true;
    const calls: unknown[][] = [];
    const execution = executeOwnedProcess(
      'node',
      ['fixture.mjs'],
      ((...args: unknown[]) => {
        calls.push(args);
        return child;
      }) as never,
      'fixture',
    );
    child.emit('close', 0, null);
    await expect(execution.promise).resolves.toEqual({
      status: 0,
      signal: null,
    });
    expect(calls[0]).toEqual([
      'node',
      ['fixture.mjs'],
      expect.objectContaining({ detached: process.platform !== 'win32' }),
    ]);
  });

  test('reports a surviving owned tree after bounded TERM and KILL cleanup', async () => {
    const signals: string[] = [];
    const outcome = await terminateSuiteExecution(
      {
        promise: NEVER,
        isAlive: () => true,
        terminate: () => signals.push('TERM'),
        forceTerminate: () => signals.push('KILL'),
      },
      {
        processLabel: 'fixture',
        terminationGraceMs: 1,
        terminationForceMs: 1,
        waitForSuiteSettlement: async () => false,
      },
    );
    expect(signals).toEqual(['TERM', 'KILL']);
    expect(outcome).toMatchObject({ settled: false, escalated: true });
    expect(outcome.errors.at(-1)?.message).toMatch(/remained alive/);
  });

  test('fails closed on Windows launcher close without a proven tree settlement', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: (signal: string) => boolean;
    };
    child.pid = 7171;
    child.kill = () => true;
    const execution = executeOwnedProcess(
      'fixture',
      [],
      (() => child) as never,
      'fixture',
      {},
      { platform: 'win32' },
    );
    child.emit('close', 0, null);
    await execution.completion;
    expect(execution.isAlive()).toBe(true);
    const proven = executeOwnedProcess(
      'fixture',
      [],
      (() => child) as never,
      'fixture',
      { treeSettled: () => true },
      { platform: 'win32' },
    );
    child.emit('close', 0, null);
    await proven.completion;
    expect(proven.isAlive()).toBe(false);
  });
});
