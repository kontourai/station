import { ChildProcess, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isPtyUnavailableError } from '../../domain/pty-adapter.js';
import { NodePtyAdapter } from '../node-pty-adapter.js';

const census = vi.hoisted(() => ({ read: vi.fn() }));
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

describe('Windows PTY output-pipe custody', () => {
  test.each(['connected', 'exited-before-connect'] as const)(
    'tree cleanup waits for pipe wiring: %s',
    async (ending) => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      const socket = new EventEmitter();
      const exits = new Set<(event: { exitCode: number }) => void>();
      const exit = () => {
        for (const listener of [...exits]) listener({ exitCode: 0 });
      };
      const pty = {
        pid: 4242,
        _socket: socket,
        onData: () => ({ dispose() {} }),
        onExit: (listener: (event: { exitCode: number }) => void) => {
          exits.add(listener);
          return { dispose: () => exits.delete(listener) };
        },
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
      const taskkill = vi
        .mocked(execFile)
        .mockImplementation((_command, _args, _options, callback) => {
          callback!(null, '', '');
          exit();
          return new ChildProcess();
        });
      let stopped: Promise<void> | undefined;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const adapter = new NodePtyAdapter(
          () =>
            Promise.resolve({ spawn: () => pty }) as unknown as Promise<
              typeof import('node-pty')
            >,
        );
        const proc = await adapter.spawn(SPAWN_INPUT);
        let completed = false;
        stopped = proc.terminate!().then(() => {
          completed = true;
        });
        await Promise.resolve();
        expect(taskkill).not.toHaveBeenCalled();
        if (ending === 'exited-before-connect') {
          exit();
          await vi.waitFor(() => expect(completed).toBe(true));
        } else socket.emit('ready_datapipe');
        await stopped;
        expect(taskkill).toHaveBeenCalledTimes(ending === 'connected' ? 1 : 0);
      } finally {
        socket.emit('ready_datapipe');
        await stopped;
        Object.defineProperty(process, 'platform', platform);
        vi.mocked(execFile).mockReset();
      }
    },
  );
});

describe.skipIf(process.platform !== 'win32')('Windows ConPTY release', () => {
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
