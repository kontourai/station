import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import {
  buildOpenSshForwardArgs,
  buildOpenSshMasterArgs,
  classifyOpenSshDiagnostic,
  OpenSshEnvironmentAdapter,
} from '../openssh-environment-adapter.js';

const EFFECTIVE_CONFIG = `
hostname brian-media.internal
user brian
port 22
identityagent none
proxyjump none
stricthostkeychecking ask
`;

class FakeProcess extends EventEmitter {
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill = vi.fn(() => true);

  close(code: number): void {
    this.exitCode = code;
    this.emit('close', code);
  }
}

function resolvedConfig() {
  return { stdout: EFFECTIVE_CONFIG, stderr: '', exitCode: 0 };
}

describe('OpenSSH process planning', () => {
  test('builds fixed argv with loopback-only forwarding and no agent forwarding', () => {
    expect(
      buildOpenSshMasterArgs({
        alias: 'brian-media',
        controlPath: '/private/control.sock',
      }),
    ).toEqual([
      '-M',
      '-S',
      '/private/control.sock',
      '-N',
      '-T',
      '-o',
      'ControlMaster=yes',
      '-o',
      'ControlPersist=no',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'ForkAfterAuthentication=no',
      '-o',
      'PermitLocalCommand=no',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UpdateHostKeys=no',
      '-o',
      'RemoteCommand=none',
      '-o',
      'SessionType=none',
      '-o',
      'Tunnel=no',
      '-o',
      'ClearAllForwardings=yes',
      '--',
      'brian-media',
    ]);
    expect(
      buildOpenSshForwardArgs({
        alias: 'brian-media',
        controlPath: '/private/control.sock',
        localPort: 45123,
        remotePort: 3141,
      }),
    ).toEqual([
      '-S',
      '/private/control.sock',
      '-O',
      'forward',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ClearAllForwardings=no',
      '-L',
      '127.0.0.1:45123:127.0.0.1:3141',
      '--',
      'brian-media',
    ]);
  });

  test('classifies host-key, prompt, agent, and forwarding states', () => {
    expect(
      classifyOpenSshDiagnostic('REMOTE HOST IDENTIFICATION HAS CHANGED!'),
    ).toEqual({ phase: 'host-key', reason: 'changed' });
    expect(classifyOpenSshDiagnostic('Host key verification failed.')).toEqual({
      phase: 'host-key',
      reason: 'confirmation-required',
    });
    expect(classifyOpenSshDiagnostic('Enter passphrase for key x:')).toEqual({
      phase: 'prompt',
      prompt: 'passphrase',
    });
    expect(
      classifyOpenSshDiagnostic(
        'sign_and_send_pubkey: signing failed: agent refused operation',
      ),
    ).toEqual({ phase: 'agent', reason: 'rejected' });
    expect(
      classifyOpenSshDiagnostic('ssh: communication with agent failed'),
    ).toEqual({ phase: 'agent', reason: 'unavailable' });
    expect(classifyOpenSshDiagnostic('bind: Address already in use')).toEqual({
      phase: 'unavailable',
      reason: 'forward',
    });
  });
});

describe('OpenSSH tunnel lifecycle', () => {
  test('resolves config, starts a multiplexed tunnel, and stops through control', async () => {
    const child = new FakeProcess();
    const run = vi
      .fn()
      .mockResolvedValueOnce(resolvedConfig())
      .mockResolvedValueOnce({
        stdout: 'Master running',
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: 'Exit request sent',
        stderr: '',
        exitCode: 0,
      });
    const spawn = vi.fn(() => child);
    const removeControlDirectory = vi.fn(async () => undefined);
    const adapter = new OpenSshEnvironmentAdapter({
      run,
      spawn,
      reservePort: async () => 45123,
      createControlDirectory: async () => '/private/control',
      removeControlDirectory,
      pollIntervalMs: 1,
    });
    const tunnel = adapter.createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
    });

    await expect(tunnel.start()).resolves.toMatchObject({
      phase: 'connected',
      localUrl: 'http://127.0.0.1:45123',
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.arrayContaining(['-S', '/private/control/control.sock', '-M']),
    );
    await tunnel.stop();
    expect(run).toHaveBeenLastCalledWith([
      '-S',
      '/private/control/control.sock',
      '-O',
      'exit',
      '--',
      'brian-media',
    ]);
    expect(removeControlDirectory).toHaveBeenCalledWith('/private/control');
    expect(tunnel.state).toEqual({ phase: 'disconnected', reason: 'stopped' });
  });

  test('retries a colliding ephemeral port before connecting', async () => {
    const child = new FakeProcess();
    let forwardCount = 0;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '-G') return resolvedConfig();
      if (args.includes('check')) {
        return { stdout: 'Master running', stderr: '', exitCode: 0 };
      }
      if (args.includes('forward')) {
        forwardCount += 1;
        if (forwardCount === 1) throw new Error('Address already in use');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error('unexpected command');
    });
    const ports = [45123, 45124];
    const adapter = new OpenSshEnvironmentAdapter({
      run,
      spawn: vi.fn(() => child),
      reservePort: async () => ports.shift() ?? 0,
      createControlDirectory: async () => '/private/control',
      removeControlDirectory: async () => undefined,
      pollIntervalMs: 1,
    });
    const tunnel = adapter.createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
      connectTimeoutMs: 100,
    });

    await expect(tunnel.start()).resolves.toMatchObject({
      phase: 'connected',
      localUrl: 'http://127.0.0.1:45124',
    });
  });

  test('surfaces changed host keys without leaking the diagnostic', async () => {
    const child = new FakeProcess();
    const states: unknown[] = [];
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '-G') return resolvedConfig();
      throw new Error('not ready');
    });
    const adapter = new OpenSshEnvironmentAdapter({
      run,
      spawn: () => {
        queueMicrotask(() => {
          child.stderr.write(
            'REMOTE HOST IDENTIFICATION HAS CHANGED! /private/path',
          );
          child.close(255);
        });
        return child;
      },
      reservePort: async () => 45123,
      createControlDirectory: async () => '/private/control',
      removeControlDirectory: async () => undefined,
      pollIntervalMs: 1,
    });
    const tunnel = adapter.createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
      onStateChange: (state) => states.push(state),
    });

    await expect(tunnel.start()).resolves.toEqual({
      phase: 'host-key',
      reason: 'changed',
    });
    expect(JSON.stringify(states)).not.toContain('/private/path');
  });

  test('reports a missing system ssh executable', async () => {
    const missingChild = new FakeProcess();
    const runConfig = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '-G') return resolvedConfig();
      throw new Error('control socket unavailable');
    });
    const missingAdapter = new OpenSshEnvironmentAdapter({
      run: runConfig,
      spawn: () => {
        queueMicrotask(() =>
          missingChild.emit('error', new Error('spawn ssh ENOENT')),
        );
        return missingChild;
      },
      createControlDirectory: async () => '/private/missing',
      removeControlDirectory: async () => undefined,
      pollIntervalMs: 1,
    });
    await expect(
      missingAdapter
        .createTunnel({ alias: 'brian-media', remotePort: 3141 })
        .start(),
    ).resolves.toEqual({ phase: 'unavailable', reason: 'ssh-not-found' });
  });

  test('cleans up after disconnect without surfacing filesystem errors', async () => {
    const connectedChild = new FakeProcess();
    const states: unknown[] = [];
    const removeConnectedControlDirectory = vi.fn(async () => {
      throw new Error('/private/connected could not be removed');
    });
    const connectedAdapter = new OpenSshEnvironmentAdapter({
      run: vi.fn(async (args: readonly string[]) =>
        args[0] === '-G'
          ? resolvedConfig()
          : { stdout: '', stderr: '', exitCode: 0 },
      ),
      spawn: () => connectedChild,
      reservePort: async () => 45123,
      createControlDirectory: async () => '/private/connected',
      removeControlDirectory: removeConnectedControlDirectory,
      pollIntervalMs: 1,
    });
    const tunnel = connectedAdapter.createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
      onStateChange: (state) => states.push(state),
    });
    await tunnel.start();
    connectedChild.close(255);
    expect(states.at(-1)).toEqual({
      phase: 'disconnected',
      reason: 'transport-error',
    });
    await vi.waitFor(() => {
      expect(removeConnectedControlDirectory).toHaveBeenCalledWith(
        '/private/connected',
      );
    });
  });

  test('does not publish connected when the master closes after forwarding', async () => {
    let resolveForward!: (value: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => void;
    let markForwardStarted!: () => void;
    const forwardStarted = new Promise<void>((resolve) => {
      markForwardStarted = resolve;
    });
    const forward = new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      resolveForward = resolve;
    });
    const child = new FakeProcess();
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '-G') return resolvedConfig();
      if (args.includes('check')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      markForwardStarted();
      return await forward;
    });
    const tunnel = new OpenSshEnvironmentAdapter({
      run,
      spawn: () => child,
      reservePort: async () => 45123,
      createControlDirectory: async () => '/private/close-race',
      removeControlDirectory: async () => undefined,
      pollIntervalMs: 1,
    }).createTunnel({ alias: 'brian-media', remotePort: 3141 });

    const starting = tunnel.start();
    await forwardStarted;
    resolveForward({ stdout: '', stderr: '', exitCode: 0 });
    child.close(255);
    await expect(starting).resolves.toEqual({
      phase: 'disconnected',
      reason: 'transport-error',
    });
  });

  test('serializes concurrent starts into one owned SSH master', async () => {
    let resolveConfig!: (value: ReturnType<typeof resolvedConfig>) => void;
    const config = new Promise<ReturnType<typeof resolvedConfig>>((resolve) => {
      resolveConfig = resolve;
    });
    const child = new FakeProcess();
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '-G') return await config;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const spawn = vi.fn(() => child);
    const tunnel = new OpenSshEnvironmentAdapter({
      run,
      spawn,
      reservePort: async () => 45123,
      createControlDirectory: async () => '/private/concurrent',
      removeControlDirectory: async () => undefined,
      pollIntervalMs: 1,
    }).createTunnel({ alias: 'brian-media', remotePort: 3141 });

    const firstStart = tunnel.start();
    const secondStart = tunnel.start();
    expect(secondStart).toBe(firstStart);
    resolveConfig(resolvedConfig());
    await expect(firstStart).resolves.toMatchObject({ phase: 'connected' });
    expect(spawn).toHaveBeenCalledTimes(1);
    await tunnel.stop();
  });

  test('cancels safely during config resolution without spawning a master', async () => {
    let resolveConfig!: (value: ReturnType<typeof resolvedConfig>) => void;
    const config = new Promise<ReturnType<typeof resolvedConfig>>((resolve) => {
      resolveConfig = resolve;
    });
    const spawn = vi.fn(() => new FakeProcess());
    const createControlDirectory = vi.fn(async () => '/private/cancelled');
    const tunnel = new OpenSshEnvironmentAdapter({
      run: vi.fn(async () => await config),
      spawn,
      createControlDirectory,
      removeControlDirectory: async () => undefined,
    }).createTunnel({ alias: 'brian-media', remotePort: 3141 });

    const starting = tunnel.start();
    const stopping = tunnel.stop();
    resolveConfig(resolvedConfig());
    await Promise.all([starting, stopping]);
    expect(spawn).not.toHaveBeenCalled();
    expect(createControlDirectory).not.toHaveBeenCalled();
    expect(tunnel.state).toEqual({ phase: 'disconnected', reason: 'stopped' });
  });

  test('runs the managed-launch bootstrap over the connected control master', async () => {
    const child = new FakeProcess();
    const runLaunchBootstrap = vi.fn(async () => ({
      remotePort: 51234,
      serverKind: 'managed' as const,
    }));
    const adapter = new OpenSshEnvironmentAdapter({
      run: vi.fn(async (args: readonly string[]) =>
        args[0] === '-G'
          ? resolvedConfig()
          : { stdout: '', stderr: '', exitCode: 0 },
      ),
      spawn: () => child,
      reservePort: async () => 45123,
      createControlDirectory: async () => '/private/launch',
      removeControlDirectory: async () => undefined,
      runLaunchBootstrap,
      pollIntervalMs: 1,
    });
    const tunnel = adapter.createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
    });
    await tunnel.start();

    const result = await tunnel.runLaunchBootstrap({
      remoteProjectPath: '~/dev/station',
      launchKey: '11111111-1111-4111-8111-111111111111',
    });

    expect(result).toEqual({ remotePort: 51234, serverKind: 'managed' });
    expect(runLaunchBootstrap).toHaveBeenCalledWith({
      alias: 'brian-media',
      controlPath: '/private/launch/control.sock',
      remoteProjectPath: '~/dev/station',
      launchKey: '11111111-1111-4111-8111-111111111111',
      targetPort: 3141,
    });
  });

  test('refuses to run the launch bootstrap before the tunnel is connected', async () => {
    const adapter = new OpenSshEnvironmentAdapter({
      run: vi.fn(async () => resolvedConfig()),
      spawn: () => new FakeProcess(),
      createControlDirectory: async () => '/private/not-connected',
      removeControlDirectory: async () => undefined,
    });
    const tunnel = adapter.createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
    });
    await expect(
      tunnel.runLaunchBootstrap({
        remoteProjectPath: '~/dev/station',
        launchKey: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toThrow('SSH environment is not connected');
  });

  test('retarget adds a second forward and updates the published localUrl', async () => {
    const child = new FakeProcess();
    const ports = [45123, 51000];
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '-G') return resolvedConfig();
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const adapter = new OpenSshEnvironmentAdapter({
      run,
      spawn: () => child,
      reservePort: async () => ports.shift() ?? 0,
      createControlDirectory: async () => '/private/retarget',
      removeControlDirectory: async () => undefined,
      pollIntervalMs: 1,
    });
    const tunnel = adapter.createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
    });
    await expect(tunnel.start()).resolves.toMatchObject({
      phase: 'connected',
      localUrl: 'http://127.0.0.1:45123',
    });

    await expect(tunnel.retarget(51234)).resolves.toMatchObject({
      phase: 'connected',
      localUrl: 'http://127.0.0.1:51000',
    });
    expect(run).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        '-L',
        '127.0.0.1:51000:127.0.0.1:51234',
        '--',
        'brian-media',
      ]),
    );
    // The original forward is never torn down — a second `-L` binding is
    // added on the same control master (ClearAllForwardings=no).
    expect(run).not.toHaveBeenCalledWith(
      expect.arrayContaining(['-O', 'exit']),
    );
  });

  // archive#1133 live-verification finding (BLOCKER): retarget() moving the
  // local -L forward is only half of "point at the launched port" — the
  // remote worker probe script independently needs to be told which port
  // TO CHECK ON THE REMOTE HOST. An earlier revision left that argument
  // pinned to the tunnel's original construction-time remotePort forever,
  // so after a managed launch retargeted to a different port, the probe
  // kept checking the profile's configured port (where nothing answered)
  // even though Station was genuinely running on the retargeted one.
  test('probeWorker asks the remote script to check the retargeted port, not the tunnel construction-time remotePort', async () => {
    const child = new FakeProcess();
    const ports = [45123, 51000];
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '-G') return resolvedConfig();
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const probeWorker = vi.fn(async () => ({
      protocolVersion: 1,
      nodeVersion: 'v24.18.0',
      platform: 'linux',
      arch: 'x64',
      remoteHome: '/home/brian',
      remoteProjectPath: '/home/brian/dev/github/kontourai/station',
      environmentId: '11111111-1111-4111-8111-111111111111',
      instanceId: 'brian-media-managed',
      sha: 'a'.repeat(40),
      bootId: '22222222-2222-4222-8222-222222222222',
    }));
    const adapter = new OpenSshEnvironmentAdapter({
      run,
      spawn: () => child,
      reservePort: async () => ports.shift() ?? 0,
      createControlDirectory: async () => '/private/probe-retarget',
      removeControlDirectory: async () => undefined,
      probeWorker,
      pollIntervalMs: 1,
    });
    const tunnel = adapter.createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
    });
    await tunnel.start();
    await tunnel.retarget(39129);

    await tunnel.probeWorker('~/dev/github/kontourai/station');

    expect(probeWorker).toHaveBeenCalledWith(
      expect.objectContaining({ remotePort: 39129 }),
    );
    expect(probeWorker).not.toHaveBeenCalledWith(
      expect.objectContaining({ remotePort: 3141 }),
    );
  });

  test('retarget retries past a raced ephemeral port before succeeding', async () => {
    const child = new FakeProcess();
    let forwardCount = 0;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '-G') return resolvedConfig();
      if (args.includes('check')) {
        return { stdout: 'Master running', stderr: '', exitCode: 0 };
      }
      if (args.includes('forward')) {
        forwardCount += 1;
        // The initial start() forward (call 1) succeeds; only retarget's
        // own first attempt (call 2) races, so this specifically proves
        // retarget's own retry loop, not the one start() already exercises.
        if (forwardCount === 2) throw new Error('Address already in use');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error('unexpected command');
    });
    const ports = [45123, 51000, 51001];
    const adapter = new OpenSshEnvironmentAdapter({
      run,
      spawn: () => child,
      reservePort: async () => ports.shift() ?? 0,
      createControlDirectory: async () => '/private/retarget-retry',
      removeControlDirectory: async () => undefined,
      pollIntervalMs: 1,
    });
    const tunnel = adapter.createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
    });
    await expect(tunnel.start()).resolves.toMatchObject({
      phase: 'connected',
      localUrl: 'http://127.0.0.1:45123',
    });

    await expect(tunnel.retarget(51234)).resolves.toMatchObject({
      phase: 'connected',
      localUrl: 'http://127.0.0.1:51001',
    });
  });

  test('refuses to retarget before the tunnel is connected', async () => {
    const adapter = new OpenSshEnvironmentAdapter({
      run: vi.fn(async () => resolvedConfig()),
      spawn: () => new FakeProcess(),
      createControlDirectory: async () => '/private/not-connected-retarget',
      removeControlDirectory: async () => undefined,
    });
    const tunnel = adapter.createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
    });
    await expect(tunnel.retarget(51234)).rejects.toThrow(
      'SSH environment is not connected',
    );
  });

  test('cancels an in-flight forward and cleans the owned master', async () => {
    let resolveForward!: (value: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => void;
    let markForwardStarted!: () => void;
    const forwardStarted = new Promise<void>((resolve) => {
      markForwardStarted = resolve;
    });
    const forward = new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      resolveForward = resolve;
    });
    const child = new FakeProcess();
    const states: unknown[] = [];
    const removeControlDirectory = vi.fn(async () => undefined);
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '-G') return resolvedConfig();
      if (args.includes('check')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args.includes('forward')) {
        markForwardStarted();
        return await forward;
      }
      throw new Error('unexpected command');
    });
    const tunnel = new OpenSshEnvironmentAdapter({
      run,
      spawn: () => child,
      reservePort: async () => 45123,
      createControlDirectory: async () => '/private/in-flight',
      removeControlDirectory,
      pollIntervalMs: 1,
    }).createTunnel({
      alias: 'brian-media',
      remotePort: 3141,
      onStateChange: (state) => states.push(state),
    });

    const starting = tunnel.start();
    await forwardStarted;
    const stopping = tunnel.stop();
    resolveForward({ stdout: '', stderr: '', exitCode: 0 });
    await Promise.all([starting, stopping]);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(removeControlDirectory).toHaveBeenCalledWith('/private/in-flight');
    expect(states).not.toContainEqual(
      expect.objectContaining({ phase: 'connected' }),
    );
    expect(tunnel.state).toEqual({ phase: 'disconnected', reason: 'stopped' });
  });
});
