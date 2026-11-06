import { ChildProcess, execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../scripts/lib/owned-process.mjs';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { isPtyUnavailableError } from '../../domain/pty-adapter.js';
import { NodePtyAdapter } from '../node-pty-adapter.js';

const census = vi.hoisted(() => ({ read: vi.fn() }));
const workloads = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('@kontourai/station-shared/child-workload', async (original) => ({
  ...(await original<
    typeof import('@kontourai/station-shared/child-workload')
  >()),
  prepareChildWorkload: workloads.prepare,
}));
vi.mock('node:child_process', async (original) => {
  const { promisify } = await import('node:util');
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: Object.assign(vi.fn(actual.execFile), {
      [promisify.custom]: census.read,
    }),
  };
});

const SPAWN_INPUT = {
  shell: '/bin/sh',
  cwd: '/tmp',
  cols: 80,
  rows: 24,
  env: {} as NodeJS.ProcessEnv,
};

/** The loader failure shape node-pty's own `loadNativeModule` produces. */
function nativeLoadFailure(): Error {
  return new Error(
    'Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-arm64: Error: Cannot find module\nsecond line that must not leak into the reason',
  );
}

describe('NodePtyAdapter no-pty configuration (#1244)', () => {
  test('probeCapability reports unavailable with the actionable reason', async () => {
    const adapter = new NodePtyAdapter(() =>
      Promise.reject(nativeLoadFailure()),
    );
    const capability = await adapter.probeCapability();
    expect(capability.state).toBe('unavailable');
    if (capability.state !== 'unavailable') return;
    expect(capability.reason).toContain('node-pty failed to load');
    expect(capability.reason).toContain('npm run dependencies:install');
    expect(capability.reason).toContain('agent execution is unaffected');
    // The loader's first line is preserved as the cause…
    expect(capability.reason).toContain('Failed to load native module');
    // …but never its multi-line dump.
    expect(capability.reason).not.toContain('second line');
  });

  test('spawn rejects with the specific PtyUnavailableError, not a generic failure', async () => {
    const adapter = new NodePtyAdapter(() =>
      Promise.reject(nativeLoadFailure()),
    );
    const rejection = await adapter.spawn(SPAWN_INPUT).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isPtyUnavailableError(rejection)).toBe(true);
    expect((rejection as Error).message).toContain(
      'npm run dependencies:install',
    );
  });

  test('a loadable backend keeps the default spawn path and reports available', async () => {
    const fakePty = {
      pid: 4242,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const spawn = vi.fn(() => fakePty);
    const adapter = new NodePtyAdapter(
      () =>
        Promise.resolve({ spawn }) as unknown as Promise<
          typeof import('node-pty')
        >,
    );
    expect(await adapter.probeCapability()).toEqual({ state: 'available' });
    const process = await adapter.spawn(SPAWN_INPUT);
    expect(process.pid).toBe(4242);
    expect(spawn).toHaveBeenCalledWith(
      '/bin/sh',
      [],
      expect.objectContaining({ cwd: '/tmp', cols: 80, rows: 24 }),
    );
  });
});

describe('pending native PTY startup admission', () => {
  afterEach(() => {
    workloads.prepare.mockReset();
    vi.useRealTimers();
  });

  async function pendingBackend() {
    const socket = new EventEmitter();
    const data = new EventEmitter();
    const exits = new Set<
      (event: { exitCode: number; signal?: number }) => void
    >();
    const pty = {
      pid: 0,
      cols: 80,
      rows: 24,
      process: 'cmd.exe',
      handleFlowControl: false,
      _socket: socket,
      _agent: { kill: vi.fn() },
      onData: (callback: (value: string) => void) => {
        data.on('data', callback);
        return { dispose: () => data.off('data', callback) };
      },
      onExit: (
        callback: (event: { exitCode: number; signal?: number }) => void,
      ) => {
        exits.add(callback);
        return { dispose: () => exits.delete(callback) };
      },
      write: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } satisfies import('node-pty').IPty & {
      _socket: EventEmitter;
      _agent: { kill(): void };
    };
    const launch = {
      command: SPAWN_INPUT.shell,
      args: [],
      env: SPAWN_INPUT.env,
      started: vi.fn(),
      close: vi.fn(async () => {}),
    };
    workloads.prepare.mockReturnValue(launch);
    const native = await vi.importActual<typeof import('node-pty')>('node-pty');
    const spawn = vi.fn(() => pty);
    const adapter = new NodePtyAdapter(async () => ({ ...native, spawn }));
    return {
      pty,
      socket,
      launch,
      spawn,
      adapter,
      data: (value: string) => data.emit('data', value),
      exit: () => {
        for (const callback of exits) callback({ exitCode: 1 });
      },
    };
  }

  test('does not publish or track PID zero, and admits a quiet ready process', async () => {
    const backend = await pendingBackend();
    let admitted = false;
    const pending = backend.adapter.spawn(SPAWN_INPUT).then((proc) => {
      admitted = true;
      return proc;
    });
    await vi.waitFor(() => expect(backend.spawn).toHaveBeenCalledOnce());
    expect(admitted).toBe(false);
    expect(backend.launch.started).not.toHaveBeenCalled();
    backend.pty.pid = 9321;
    backend.socket.emit('ready_datapipe');
    const proc = await pending;
    expect(proc.pid).toBe(9321);
    expect(backend.launch.started).toHaveBeenCalledExactlyOnceWith(9321);
    const output = vi.fn();
    proc.onData(output);
    backend.data('after admission');
    expect(output).toHaveBeenCalledExactlyOnceWith('after admission');
    backend.exit();
    await vi.waitFor(() => expect(backend.launch.close).toHaveBeenCalledOnce());
  });

  test('releases a quiet Windows backend after its admitted process exits', async () => {
    const backend = await pendingBackend();
    const pending = backend.adapter.spawn(SPAWN_INPUT);
    await vi.waitFor(() => expect(backend.spawn).toHaveBeenCalledOnce());
    backend.pty.pid = 9321;
    backend.socket.emit('ready_datapipe');
    const proc = await pending;
    expect(proc.pid).toBe(9321);
    backend.exit();
    await vi.waitFor(() => expect(backend.launch.close).toHaveBeenCalledOnce());
    expect(backend.pty._agent.kill).toHaveBeenCalledOnce();
    expect(backend.pty.kill).not.toHaveBeenCalled();
  });

  test.each([
    'error',
    'error during ready',
    'close',
    'exit',
    'exit during ready',
    'invalid PID',
  ] as const)(
    'refuses a pre-admission %s and closes its owned launch',
    async (failure) => {
      const backend = await pendingBackend();
      if (failure === 'error during ready') {
        backend.socket.once('ready_datapipe', () => {
          backend.pty.pid = 9321;
          // node-pty's ready handler installs this pipe-error ownership check.
          backend.socket.on('error', () => {
            if (backend.socket.listenerCount('error') < 2) {
              throw new Error('unowned terminal pipe error');
            }
          });
        });
      }
      const rejected = backend.adapter.spawn(SPAWN_INPUT).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(backend.spawn).toHaveBeenCalledOnce());
      const reason = new Error('named pipe refused');
      if (failure === 'error') backend.socket.emit('error', reason);
      else if (failure === 'error during ready') {
        backend.socket.emit('ready_datapipe');
        backend.socket.emit('error', reason);
      } else if (failure === 'close') backend.socket.emit('close');
      else if (failure === 'exit') backend.exit();
      else if (failure === 'exit during ready') {
        backend.pty.pid = 9321;
        backend.socket.emit('ready_datapipe');
        backend.exit();
      } else backend.socket.emit('ready_datapipe');
      const error = await rejected;
      expect(error).toBeInstanceOf(Error);
      if (failure === 'error' || failure === 'error during ready') {
        expect(error).toBe(reason);
      }
      expect(isPtyUnavailableError(error)).toBe(false);
      expect(backend.launch.started).not.toHaveBeenCalled();
      expect(backend.launch.close).toHaveBeenCalledOnce();
      const killedByAdapter =
        failure === 'exit' || failure === 'exit during ready' ? 0 : 1;
      expect(backend.pty._agent.kill).toHaveBeenCalledTimes(killedByAdapter);
      expect(backend.pty.kill).not.toHaveBeenCalled();
      backend.pty.pid = 9321;
      backend.socket.emit('ready_datapipe');
      await Promise.resolve();
      expect(backend.launch.started).not.toHaveBeenCalled();
      expect(backend.pty._agent.kill).toHaveBeenCalledTimes(killedByAdapter);
      expect(backend.socket.listenerCount('ready_datapipe')).toBe(0);
      if (failure !== 'close') {
        expect(() =>
          backend.socket.emit('error', new Error('pipe closing')),
        ).not.toThrow();
        backend.socket.emit('close');
      }
      expect(backend.socket.listenerCount('error')).toBe(
        failure === 'error during ready' ? 1 : 0,
      );
    },
  );

  test('bounds a missing readiness signal and ignores a later completion', async () => {
    const backend = await pendingBackend();
    vi.useFakeTimers();
    const rejected = backend.adapter.spawn(SPAWN_INPUT).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(backend.launch.close).not.toHaveBeenCalled();
    expect(backend.launch.started).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await rejected).toMatchObject({
      message: 'PTY startup readiness timed out',
    });
    expect(backend.pty._agent.kill).toHaveBeenCalledOnce();
    expect(backend.launch.close).toHaveBeenCalledOnce();
    backend.pty.pid = 9321;
    backend.socket.emit('ready_datapipe');
    await vi.runAllTimersAsync();
    expect(backend.launch.started).not.toHaveBeenCalled();
    expect(backend.socket.listenerCount('ready_datapipe')).toBe(0);
  });
});

describe.skipIf(process.platform !== 'win32')('Windows ConPTY release', () => {
  const makeTempDir = trackTempDirs();

  async function runNativeFixture(fixture: URL, schema: string, label: string) {
    const execution = executeOwnedCommand(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(fixture),
        makeTempDir('node-pty-native-lifecycle-'),
      ],
      spawn,
      label,
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const capture = captureOwnedProcessOutput(execution, {
      maxBytes: 64 * 1024,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: Awaited<typeof execution.completion> | undefined;
    let failure: unknown;
    let containment: Awaited<ReturnType<typeof terminateSuiteExecution>>;
    try {
      result = await Promise.race([
        execution.completion,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native PTY child did not retire')),
            20_000,
          );
        }),
      ]);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      containment = await terminateSuiteExecution(execution, {
        waitForSuiteSettlement,
        terminationGraceMs: 1_000,
        terminationForceMs: 2_000,
        processLabel: label,
      });
    }
    const output = capture.finish();
    const diagnostic = JSON.stringify({
      result,
      failure: failure instanceof Error ? failure.message : failure,
      containment,
      stdout: output.stdout.text,
      stderr: output.stderr.text,
    });
    expect(failure, diagnostic).toBeUndefined();
    expect(result, diagnostic).toMatchObject({ status: 0, signal: null });
    expect(result?.error, diagnostic).toBeUndefined();
    expect(output.truncated, diagnostic).toBe(false);
    expect(output.invalidUtf8, diagnostic).toBe(false);
    expect(containment, diagnostic).toEqual({
      settled: true,
      escalated: false,
      errors: [],
    });
    expect(execution.isAlive(), diagnostic).toBe(false);
    const receipts = output.stdout.text
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`{"schema":"${schema}"`));
    expect(receipts, diagnostic).toHaveLength(1);
    const receipt = JSON.parse(receipts[0]);
    expect(receipt, diagnostic).toMatchObject({ status: 'PASS' });
    return { receipt, diagnostic };
  }

  test('concurrent native exits and resizes survive through process retirement (#4626)', async () => {
    const { receipt, diagnostic } = await runNativeFixture(
      new URL('./fixtures/node-pty-concurrent-exit.mjs', import.meta.url),
      'station-pty-concurrent-exit/1',
      'native PTY concurrent exit regression',
    );
    expect(receipt, diagnostic).toMatchObject({
      started: 30,
      ready: 30,
      exited: 30,
    });
    expect(receipt.resizes, diagnostic).toBeGreaterThan(0);
  }, 30_000);

  test('a silent native child exits and releases its output reader', async () => {
    const { receipt, diagnostic } = await runNativeFixture(
      new URL('./fixtures/node-pty-quiet-exit.mjs', import.meta.url),
      'station-pty-quiet-exit/1',
      'native PTY quiet exit regression',
    );
    expect(Number.isInteger(receipt.pid), diagnostic).toBe(true);
    expect(receipt.pid, diagnostic).toBeGreaterThan(0);
    expect(receipt, diagnostic).toMatchObject({ outputBytes: 0, exitCode: 0 });
    expect([null, 0], diagnostic).toContain(receipt.signal);
    expect(receipt.readerPortsAfter, diagnostic).toBeLessThanOrEqual(
      receipt.readerPortsBefore,
    );
  }, 30_000);

  /** node-pty runs each ConPTY's output reader on a worker thread. */
  const workerThreads = () =>
    process.getActiveResourcesInfo().filter((name) => name === 'MessagePort')
      .length;

  test.each(['taskkill close', 'natural exit'] as const)(
    'a %s releases the ConPTY and never signals the old shell pid later',
    async (ending) => {
      const before = workerThreads();
      const signalled: number[] = [];
      const signal = process.kill.bind(process);
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
        signalled.push(Number(pid));
        return signal(pid, name);
      });
      try {
        const proc = await new NodePtyAdapter().spawn({
          shell: process.env.COMSPEC ?? 'cmd.exe',
          cwd: tmpdir(),
          cols: 80,
          rows: 24,
          env: process.env,
        });
        const exited = new Promise((resolve) => proc.onExit(resolve));
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        if (ending === 'taskkill close') await proc.terminate!();
        else proc.write('exit\r');
        await exited;
        // node-pty's console-list fallback signals five seconds after kill();
        // its output reader thread is released a second after the release.
        await new Promise((resolve) => setTimeout(resolve, 6_500));
        expect(signalled).not.toContain(proc.pid);
        expect(workerThreads()).toBe(before);
      } finally {
        kill.mockRestore();
      }
    },
    30_000,
  );
});

describe.skipIf(process.platform === 'win32')(
  'owned PTY cleanup and paused exit observations',
  () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.mocked(execFile).mockReset();
      census.read.mockReset();
    });

    async function backend() {
      vi.useFakeTimers();
      const exits: ((event: { exitCode: number; signal?: number }) => void)[] =
        [];
      const pty = {
        pid: 4242,
        cols: 80,
        rows: 24,
        process: 'sh',
        handleFlowControl: false,
        onData: vi.fn(() => ({ dispose() {} })),
        onExit: (
          callback: (event: { exitCode: number; signal?: number }) => void,
        ) => {
          exits.push(callback);
          return { dispose() {} };
        },
        write() {},
        resize() {},
        clear() {},
        kill: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      } satisfies import('node-pty').IPty;
      const native =
        await vi.importActual<typeof import('node-pty')>('node-pty');
      const adapter = new NodePtyAdapter(async () => ({
        ...native,
        spawn: () => pty,
      }));
      const proc = await adapter.spawn(SPAWN_INPUT);
      const onExit = vi.fn();
      proc.onExit(onExit);
      return {
        proc,
        pty,
        onExit,
        exit: () => exits.forEach((callback) => callback({ exitCode: 0 })),
      };
    }

    test.each(['??', 'none'])(
      'kills the owned shell when the census refuses tty %s',
      async (tty) => {
        const { proc, pty } = await backend();
        census.read.mockResolvedValue({ stdout: `4242 1 4242 ${tty}\n` });
        const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
        await expect(proc.terminate!()).rejects.toThrow(
          'Terminal controlling tty ownership unavailable',
        );
        expect(pty.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
        expect(signal).not.toHaveBeenCalled();
      },
    );

    test('paused observation retries cap backoff at one second', async () => {
      const { proc, pty } = await backend();
      vi.mocked(execFile).mockImplementation(
        (_file, _args, _options, callback) => {
          callback?.(
            Object.assign(new Error('unknown'), { code: 2, cmd: 'ps' }),
            '',
            '',
          );
          return new ChildProcess();
        },
      );
      proc.pause!();
      for (const delay of [50, 100, 200, 400, 800, 1000, 1000]) {
        const observed = vi.mocked(execFile).mock.calls.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(execFile).toHaveBeenCalledTimes(observed);
        await vi.advanceTimersByTimeAsync(1);
        expect(execFile).toHaveBeenCalledTimes(observed + 1);
      }
      expect(pty.resume).not.toHaveBeenCalled();
      proc.resume!();
    });

    test('exit 1 with stderr stays paused instead of declaring the child gone', async () => {
      const { proc, pty } = await backend();
      vi.mocked(execFile).mockImplementation(
        (_file, _args, _options, callback) => {
          callback?.(
            Object.assign(new Error('diagnostic'), { code: 1, cmd: 'ps' }),
            '',
            'ps: observation denied',
          );
          return new ChildProcess();
        },
      );
      proc.pause!();
      await vi.advanceTimersByTimeAsync(150);
      expect(execFile).toHaveBeenCalledTimes(2);
      expect(pty.resume).not.toHaveBeenCalled();
      proc.resume!();
    });

    test.each([
      ['timeout', { killed: true, signal: 'SIGTERM' }],
      ['missing', { code: 'ENOENT' }],
      ['persistent', { code: 2 }],
      ['timed-out exit 1', { code: 1, killed: true }],
      ['signaled exit 1', { code: 1, signal: 'SIGTERM' }],
    ] as const)(
      '%s ps failure stays paused and retries with bounded backoff',
      async (failure, properties) => {
        const { proc, pty, onExit, exit } = await backend();
        let calls = 0;
        vi.mocked(execFile).mockImplementation(
          (_file, _args, _options, callback) => {
            calls++;
            const error =
              failure === 'persistent' || calls === 1
                ? Object.assign(
                    new Error('observation unavailable'),
                    { cmd: 'ps' },
                    properties,
                  )
                : null;
            callback?.(error, error ? '' : 'S', '');
            return new ChildProcess();
          },
        );
        proc.pause!();
        await vi.advanceTimersByTimeAsync(1550);
        expect(calls).toBeGreaterThan(1);
        expect(calls).toBeLessThanOrEqual(5);
        expect(pty.resume).not.toHaveBeenCalled();
        proc.resume!();
        const observed = calls;
        await vi.advanceTimersByTimeAsync(2000);
        expect(calls).toBe(observed);
        exit();
        expect(onExit).toHaveBeenCalledWith(
          expect.objectContaining({ outputIncomplete: false }),
        );
      },
    );

    test.each(['Z', '?Es', 'gone'] as const)(
      'positive %s observation releases delivery and retains incomplete output after drain',
      async (status) => {
        const { proc, pty, onExit, exit } = await backend();
        vi.mocked(execFile).mockImplementation(
          (_file, _args, _options, callback) => {
            callback?.(
              status === 'gone'
                ? Object.assign(new Error('gone'), { code: 1, cmd: 'ps' })
                : null,
              status === 'gone' ? '' : status,
              '',
            );
            return new ChildProcess();
          },
        );
        proc.pause!();
        await vi.advanceTimersByTimeAsync(50);
        expect(pty.resume).toHaveBeenCalledOnce();
        exit();
        expect(onExit).toHaveBeenCalledWith(
          expect.objectContaining({ outputIncomplete: true }),
        );
      },
    );

    test('backend exit while paused marks output incomplete without a census observation', async () => {
      const { proc, onExit, exit } = await backend();
      proc.pause!();
      exit();
      expect(onExit).toHaveBeenCalledWith(
        expect.objectContaining({ outputIncomplete: true }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(execFile).not.toHaveBeenCalled();
    });
  },
);
