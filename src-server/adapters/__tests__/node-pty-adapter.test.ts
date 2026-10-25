import { ChildProcess, execFile } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isPtyUnavailableError } from '../../domain/pty-adapter.js';
import { NodePtyAdapter } from '../node-pty-adapter.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
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

describe.skipIf(process.platform === 'win32')(
  'paused PTY exit observations',
  () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.mocked(execFile).mockReset();
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
        kill() {},
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

    test.each(['timeout', 'missing', 'persistent'] as const)(
      '%s ps failure stays paused and retries with bounded backoff',
      async (failure) => {
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
                    failure === 'missing'
                      ? { code: 'ENOENT' }
                      : { killed: true, signal: 'SIGTERM' as const },
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
