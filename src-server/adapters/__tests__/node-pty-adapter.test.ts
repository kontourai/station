import { describe, expect, test, vi } from 'vitest';
import { isPtyUnavailableError } from '../../domain/pty-adapter.js';
import { NodePtyAdapter } from '../node-pty-adapter.js';

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
    expect(capability.reason).toContain('npm rebuild node-pty');
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
    expect((rejection as Error).message).toContain('npm rebuild node-pty');
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
