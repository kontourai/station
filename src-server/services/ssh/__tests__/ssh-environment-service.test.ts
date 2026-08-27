import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OpenSshEnvironmentAdapter } from '../openssh-environment-adapter.js';
import { OpenSshLaunchError } from '../openssh-launch-bootstrap.js';
import { SshEnvironmentService } from '../ssh-environment-service.js';

const homes: string[] = [];
const HOST = {
  alias: 'brian-media',
  hostname: 'brian-media.internal',
  user: 'brian',
  port: 22,
  identityAgent: 'default' as const,
  proxyJump: null,
  strictHostKeyChecking: 'ask',
};
const WORKER = {
  protocolVersion: 1,
  nodeVersion: 'v24.18.0',
  platform: 'linux',
  arch: 'x64',
  remoteHome: '/home/brian',
  remoteProjectPath: '/home/brian/dev/github/kontourai/station',
  environmentId: '11111111-1111-4111-8111-111111111111',
  instanceId: 'brian-media-dogfood',
  sha: 'a'.repeat(40),
  bootId: '22222222-2222-4222-8222-222222222222',
};

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'station-ssh-service-'));
  homes.push(value);
  return value;
}

function fakeTunnel(worker = WORKER) {
  return {
    start: vi.fn(async () => ({
      phase: 'connected' as const,
      localUrl: 'http://127.0.0.1:45123',
      host: HOST,
    })),
    probeWorker: vi.fn(async () => worker),
    runLaunchBootstrap: vi.fn(async () => {
      throw new Error('runLaunchBootstrap not configured for this fixture');
    }),
    retarget: vi.fn(async () => ({
      phase: 'connected' as const,
      localUrl: 'http://127.0.0.1:45123',
      host: HOST,
    })),
    stop: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  for (const value of homes.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('SshEnvironmentService', () => {
  test('binds first connection to worker, host, and project identity', async () => {
    const tunnel = fakeTunnel();
    const counter = { add: vi.fn() };
    const duration = { record: vi.fn() };
    const service = new SshEnvironmentService(home(), {
      // station#1144: pin a known alias so add()'s new known-alias gate
      // doesn't depend on this machine's real ~/.ssh/config.
      adapter: {
        createTunnel: vi.fn(() => tunnel),
      } as unknown as OpenSshEnvironmentAdapter,
      counter,
      duration,
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValue(1_100),
    });
    await service.initialize();
    const added = await service.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
    });
    const connected = await service.connect(added.profile.id);
    expect(connected.state).toMatchObject({
      phase: 'connected',
      localUrl: 'http://127.0.0.1:45123',
      instanceId: 'brian-media-dogfood',
    });
    expect(connected.profile).toMatchObject({
      environmentId: WORKER.environmentId,
      remoteHome: WORKER.remoteHome,
      verifiedProjectPath: WORKER.remoteProjectPath,
      workerProtocolVersion: 1,
    });
    expect(connected.profile.hostIdentity).toMatch(/^ssh:/);
    expect(duration.record).toHaveBeenCalledWith(100, {
      operation: 'connect',
      outcome: 'success',
    });
  });

  test('rejects identity rebinding and tears down the new tunnel', async () => {
    const first = fakeTunnel();
    const second = fakeTunnel({
      ...WORKER,
      environmentId: 'other-environment',
    });
    const createTunnel = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const service = new SshEnvironmentService(home(), {
      // station#1144: pin a known alias so add()'s new known-alias gate
      // doesn't depend on this machine's real ~/.ssh/config.
      adapter: { createTunnel } as unknown as OpenSshEnvironmentAdapter,
    });
    await service.initialize();
    const added = await service.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '/srv/station',
    });
    await service.connect(added.profile.id);
    await service.disconnect(added.profile.id);
    const rejected = await service.connect(added.profile.id);
    expect(rejected.state).toMatchObject({
      phase: 'error',
      reason: 'identity-mismatch',
    });
    expect(second.stop).toHaveBeenCalled();
    expect(rejected.profile.environmentId).toBe(WORKER.environmentId);
  });

  test('serializes concurrent connect calls for one environment', async () => {
    const tunnel = fakeTunnel();
    const service = new SshEnvironmentService(home(), {
      // station#1144: pin a known alias so add()'s new known-alias gate
      // doesn't depend on this machine's real ~/.ssh/config.
      adapter: {
        createTunnel: vi.fn(() => tunnel),
      } as unknown as OpenSshEnvironmentAdapter,
    });
    await service.initialize();
    const added = await service.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '/srv/station',
    });
    const [left, right] = await Promise.all([
      service.connect(added.profile.id),
      service.connect(added.profile.id),
    ]);
    expect(left).toEqual(right);
    expect(tunnel.start).toHaveBeenCalledOnce();
    expect(tunnel.probeWorker).toHaveBeenCalledOnce();
  });
});

// station#1133 R3/AC1-AC6: managed-launch connect-flow integration, using a
// stubbed tunnel (the bootstrap script's own logic is covered end-to-end,
// through a real local shell, in openssh-launch-bootstrap.test.ts).
describe('SshEnvironmentService managed launch', () => {
  function stationUnavailable(): Error {
    return new Error('station-unavailable');
  }

  test('AC1/R3: a managed profile that fails station-unavailable runs the bootstrap, retargets, then reports serverKind managed', async () => {
    const probeWorker = vi
      .fn()
      .mockRejectedValueOnce(stationUnavailable())
      .mockResolvedValueOnce(WORKER);
    const runLaunchBootstrap = vi.fn(async () => ({
      remotePort: 51234,
      serverKind: 'managed' as const,
    }));
    const retarget = vi.fn(async () => ({
      phase: 'connected' as const,
      localUrl: 'http://127.0.0.1:45999',
      host: HOST,
    }));
    const states: unknown[] = [];
    const tunnel = {
      ...fakeTunnel(),
      probeWorker,
      runLaunchBootstrap,
      retarget,
    };
    const service = new SshEnvironmentService(home(), {
      // station#1144: pin a known alias so add()'s new known-alias gate
      // doesn't depend on this machine's real ~/.ssh/config.
      adapter: {
        createTunnel: vi.fn((options) => {
          const original = options.onStateChange;
          options.onStateChange = (state: unknown) => {
            states.push(state);
            original?.(state);
          };
          return tunnel;
        }),
      } as unknown as OpenSshEnvironmentAdapter,
    });
    await service.initialize();
    const added = await service.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
      launchMode: 'managed',
    });

    const connected = await service.connect(added.profile.id);

    expect(runLaunchBootstrap).toHaveBeenCalledWith({
      remoteProjectPath: '~/dev/github/kontourai/station',
      launchKey: added.profile.id,
    });
    expect(retarget).toHaveBeenCalledWith(51234);
    expect(connected.state).toMatchObject({
      phase: 'connected',
      localUrl: 'http://127.0.0.1:45999',
      serverKind: 'managed',
    });
    expect(probeWorker).toHaveBeenCalledTimes(2);
  });

  test('AC2: an already-answering managed profile never invokes the bootstrap and reports serverKind external', async () => {
    const runLaunchBootstrap = vi.fn();
    const tunnel = { ...fakeTunnel(), runLaunchBootstrap };
    const service = new SshEnvironmentService(home(), {
      // station#1144: pin a known alias so add()'s new known-alias gate
      // doesn't depend on this machine's real ~/.ssh/config.
      adapter: {
        createTunnel: vi.fn(() => tunnel),
      } as unknown as OpenSshEnvironmentAdapter,
    });
    await service.initialize();
    const added = await service.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
      launchMode: 'managed',
    });

    const connected = await service.connect(added.profile.id);

    expect(runLaunchBootstrap).not.toHaveBeenCalled();
    expect(connected.state).toMatchObject({
      phase: 'connected',
      serverKind: 'external',
    });
  });

  test('AC3: reconnecting a managed profile that reuses the same launched port skips retargeting', async () => {
    const probeWorker = vi
      .fn()
      .mockRejectedValueOnce(stationUnavailable())
      .mockResolvedValueOnce(WORKER);
    const runLaunchBootstrap = vi.fn(async () => ({
      remotePort: 3141, // matches the profile's own configured remotePort
      serverKind: 'managed' as const,
    }));
    const retarget = vi.fn();
    const tunnel = {
      ...fakeTunnel(),
      probeWorker,
      runLaunchBootstrap,
      retarget,
    };
    const service = new SshEnvironmentService(home(), {
      // station#1144: pin a known alias so add()'s new known-alias gate
      // doesn't depend on this machine's real ~/.ssh/config.
      adapter: {
        createTunnel: vi.fn(() => tunnel),
      } as unknown as OpenSshEnvironmentAdapter,
    });
    await service.initialize();
    const added = await service.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
      remotePort: 3141,
      launchMode: 'managed',
    });

    const connected = await service.connect(added.profile.id);

    expect(retarget).not.toHaveBeenCalled();
    expect(connected.state).toMatchObject({
      phase: 'connected',
      serverKind: 'managed',
    });
  });

  test('AC4: an attach-mode profile never attempts the bootstrap on station-unavailable (byte-identical prior behavior)', async () => {
    const probeWorker = vi.fn().mockRejectedValueOnce(stationUnavailable());
    const runLaunchBootstrap = vi.fn();
    const tunnel = { ...fakeTunnel(), probeWorker, runLaunchBootstrap };
    const service = new SshEnvironmentService(home(), {
      // station#1144: pin a known alias so add()'s new known-alias gate
      // doesn't depend on this machine's real ~/.ssh/config.
      adapter: {
        createTunnel: vi.fn(() => tunnel),
      } as unknown as OpenSshEnvironmentAdapter,
    });
    await service.initialize();
    const added = await service.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
    });
    expect(added.profile.launchMode).toBe('attach');

    const connected = await service.connect(added.profile.id);

    expect(runLaunchBootstrap).not.toHaveBeenCalled();
    expect(connected.state).toMatchObject({
      phase: 'error',
      reason: 'station-unavailable',
    });
    expect(connected.state).not.toHaveProperty('serverKind');
  });

  test.each([
    ['node-not-found', 'launch-node-not-found'],
    ['unsupported-node-version', 'launch-unsupported-node-version'],
    ['project-unavailable', 'launch-project-unavailable'],
    ['port-in-use', 'launch-port-in-use'],
    ['readiness-timeout', 'launch-readiness-timeout'],
    ['requires-build', 'launch-requires-build'],
    ['port-conflict', 'launch-port-conflict'],
    ['protocol-violation', 'launch-failed'],
  ] as const)(
    'AC5: %s from the bootstrap surfaces as the typed environment reason %s',
    async (bootstrapReason, expectedReason) => {
      const probeWorker = vi.fn().mockRejectedValueOnce(stationUnavailable());
      const runLaunchBootstrap = vi.fn(async () => {
        throw new OpenSshLaunchError(
          bootstrapReason,
          `boom: ${bootstrapReason}`,
        );
      });
      const tunnel = { ...fakeTunnel(), probeWorker, runLaunchBootstrap };
      const service = new SshEnvironmentService(home(), {
        // station#1144: pin a known alias so add()'s new known-alias gate
        // doesn't depend on this machine's real ~/.ssh/config.
        adapter: {
          createTunnel: vi.fn(() => tunnel),
        } as unknown as OpenSshEnvironmentAdapter,
      });
      await service.initialize();
      const added = await service.add({
        hostAlias: 'brian-media',
        remoteProjectPath: '~/dev/github/kontourai/station',
        launchMode: 'managed',
      });

      const connected = await service.connect(added.profile.id);

      expect(connected.state).toMatchObject({
        phase: 'error',
        reason: expectedReason,
      });
      expect(tunnel.stop).toHaveBeenCalled();
    },
  );

  test('AC6: disconnect never invokes the launch bootstrap or any remote-stop mechanism for a managed profile', async () => {
    const probeWorker = vi
      .fn()
      .mockRejectedValueOnce(stationUnavailable())
      .mockResolvedValueOnce(WORKER);
    const runLaunchBootstrap = vi.fn(async () => ({
      remotePort: 3141,
      serverKind: 'managed' as const,
    }));
    const tunnel = { ...fakeTunnel(), probeWorker, runLaunchBootstrap };
    const service = new SshEnvironmentService(home(), {
      // station#1144: pin a known alias so add()'s new known-alias gate
      // doesn't depend on this machine's real ~/.ssh/config.
      adapter: {
        createTunnel: vi.fn(() => tunnel),
      } as unknown as OpenSshEnvironmentAdapter,
    });
    await service.initialize();
    const added = await service.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
      remotePort: 3141,
      launchMode: 'managed',
    });
    await service.connect(added.profile.id);
    runLaunchBootstrap.mockClear();

    const disconnected = await service.disconnect(added.profile.id);

    expect(disconnected.state).toEqual({
      phase: 'disconnected',
      reason: 'stopped',
    });
    // The tunnel forward is torn down (never a remote-process action)...
    expect(tunnel.stop).toHaveBeenCalled();
    // ...and the launch bootstrap — the only thing that could ever start or
    // stop a remote Station — is never invoked from disconnect at all.
    expect(runLaunchBootstrap).not.toHaveBeenCalled();
    expect(
      Object.keys(tunnel).some((key) => /stop.*remote|kill/i.test(key)),
    ).toBe(false);
  });
});

// station#1144's two-tier "is this alias configured?" gate is GONE (sol
// review finding 2). It was a caller-set boolean (`allowUnknownHost`) in
// front of a proxy signal: an SSH-config Host stanza is not a trust
// decision about a machine, and the flag turned the whole gate off for any
// caller willing to type it. What actually decides whether Station can
// reach a computer is the operator's own `known_hosts`, enforced by
// `StrictHostKeyChecking=yes` on BOTH the probe and the master session —
// so `add` keeps only the guard the alias string itself needs.
describe('SshEnvironmentService alias admission', () => {
  function service() {
    return new SshEnvironmentService(home(), {
      adapter: {
        createTunnel: vi.fn(() => fakeTunnel()),
      } as unknown as OpenSshEnvironmentAdapter,
    });
  }

  test('a raw hostname or IP is stored with no flag — the host key, not a config stanza, is what gates reaching it', async () => {
    const subject = service();
    await subject.initialize();

    const added = await subject.add({
      hostAlias: '203.0.113.42',
      remoteProjectPath: '~/dev/github/kontourai/station',
    });

    expect(added.profile.hostAlias).toBe('203.0.113.42');
  });

  // Regression: retiring the gate must not widen the pre-existing FORMAT
  // guard — a flag-like/metacharacter-ish alias is still rejected outright,
  // before the store runs.
  test('a flag-like alias is still rejected by the existing format regex', async () => {
    const subject = service();
    await subject.initialize();

    await expect(
      subject.add({
        hostAlias: '-oProxyCommand=bad',
        remoteProjectPath: '~/dev/github/kontourai/station',
      }),
    ).rejects.toThrow('SSH host alias');
  });
});
