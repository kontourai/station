/**
 * The toolchain service's setup choices (#1970): the hub starts only after
 * the operator enabled it and it is installed; an explicitly configured hub
 * wins; agent access off keeps agent-device absent.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DeviceHubSupervisor,
  type SupervisedChild,
} from '../device-hub-supervisor.js';
import {
  DeviceToolConsentRequiredError,
  DeviceToolchain,
} from '../device-toolchain.js';
import {
  DeviceActionRefusedError,
  DeviceToolchainService,
  DeviceToolNotConsentedError,
} from '../device-toolchain-service.js';
import {
  syntheticPins,
  syntheticTool,
  writeFakeInstall,
} from './fake-tool-install.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function setup(options: { configuredHubUrl?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'station-device-service-'));
  homes.push(home);
  const installs: string[] = [];
  const synthetic = {
    'expo-device-hub': syntheticTool('expo-device-hub'),
    'agent-device': syntheticTool('agent-device'),
  };
  const toolchain = new DeviceToolchain({
    stationHome: home,
    pins: syntheticPins(),
    installer: {
      run: async ({ dir }) => {
        const manifest = JSON.parse(
          readFileSync(join(dir, 'package.json'), 'utf8'),
        );
        const tool = Object.keys(
          manifest.dependencies,
        )[0] as keyof typeof synthetic;
        installs.push(tool);
        writeFakeInstall(dir, synthetic[tool]);
      },
    },
  });
  const spawned: string[][] = [];
  const supervisor = new DeviceHubSupervisor({
    resolveLaunch: () => {
      const entry = toolchain.installedEntry('expo-device-hub');
      return entry
        ? {
            entry,
            cwd: toolchain.installDir('expo-device-hub'),
            // The guard is verified for the real pinned hub version.
            version: '0.10.1',
            runDir: join(home, 'devices', 'run'),
          }
        : undefined;
    },
    spawn: (_command, args) => {
      spawned.push(args);
      const stdout = new PassThrough();
      let exit:
        | ((code: number | null, signal: string | null) => void)
        | undefined;
      queueMicrotask(() => stdout.write('  Local:   http://localhost:51234\n'));
      const child: SupervisedChild = {
        pid: 1,
        stdout,
        onExit: (listener) => {
          exit = listener;
        },
        onError: () => {},
        terminate: () => exit?.(null, 'SIGTERM'),
        release: () => {},
      };
      return child;
    },
    probeReady: async () => true,
  });
  const service = new DeviceToolchainService({
    stationHome: home,
    toolchain,
    supervisor,
    probePlatforms: async () => [],
    ...options,
  });
  return { home, service, installs, spawned };
}

describe('device toolchain service', () => {
  test('nothing installs or starts until the operator enables the hub with consent', async () => {
    const s = setup();
    expect(await s.service.ensureHub()).toBeUndefined();
    expect(() => s.service.enableHub({} as { consent: true })).toThrow(
      DeviceToolConsentRequiredError,
    );
    expect(s.installs).toEqual([]);
    expect(s.spawned).toEqual([]);
    const status = await s.service.status();
    expect(status).toMatchObject({
      managedBy: 'station',
      hubEnabled: false,
      hubSource: 'none',
      hub: { state: 'needs-consent' },
      hubProcess: { state: 'stopped' },
    });
  });

  test('enabling installs the pinned hub, starts it, and routes use it', async () => {
    const s = setup();
    await s.service.enableHub({ consent: true }).completion;
    expect(s.installs).toEqual(['expo-device-hub']);
    expect(s.spawned).toHaveLength(1);
    expect(s.service.hubConnection()?.baseUrl).toBe('http://127.0.0.1:51234');
    expect(await s.service.status()).toMatchObject({
      hubEnabled: true,
      hubSource: 'managed',
      hub: { state: 'installed', version: '9.9.9' },
      hubProcess: { state: 'running' },
      agentDevice: { state: 'needs-consent' },
    });
    expect(s.service.versions().tools[0]).toEqual({
      tool: 'expo-device-hub',
      required: '9.9.9',
      installed: ['9.9.9'],
      running: '0.10.1',
    });
    await s.service.disableHub();
    expect(s.service.hubConnection()).toBeUndefined();
    expect(await s.service.ensureHub()).toBeUndefined();
  });

  test('an explicitly configured hub URL takes precedence over the managed one', async () => {
    const s = setup({ configuredHubUrl: 'http://127.0.0.1:43871' });
    await s.service.enableHub({ consent: true }).completion;
    expect(await s.service.ensureHub()).toBeUndefined();
    expect(s.spawned).toEqual([]);
    expect((await s.service.status()).hubSource).toBe('configured');
  });

  test('agent access off installs nothing; on requires consent and installs agent-device', async () => {
    const s = setup();
    await s.service.setAgentAccess(false).completion;
    expect(s.installs).toEqual([]);
    expect(() => s.service.setAgentAccess(true)).toThrow(
      DeviceToolConsentRequiredError,
    );
    await s.service.setAgentAccess(true, { consent: true }).completion;
    expect(s.installs).toEqual(['agent-device']);
    expect((await s.service.status()).agentAccess).toBe(true);
  });

  test('an update needs a tool that was set up', () => {
    const s = setup();
    expect(() => s.service.update('agent-device')).toThrow(
      DeviceToolNotConsentedError,
    );
  });

  describe('stream helper attach/detach (server-side, D12)', () => {
    const UDID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
    const OTHER = 'D0EF88EE-6F52-4669-A407-936B76F63C90';
    const admin = {
      kind: 'project-admin' as const,
      projectId: 'p-alpha',
      principalId: 'admin-alpha',
      shares: [
        {
          hostId: 'local',
          platform: 'ios' as const,
          deviceId: UDID,
          label: 'iPhone',
          addedBy: 'operator',
          addedAt: '2026-09-22T00:00:00.000Z',
        },
      ],
    };

    async function running() {
      const s = setup();
      await s.service.enableHub({ consent: true }).completion;
      const hub = s.service.hubConnection();
      if (!hub) throw new Error('hub not running');
      const request = vi
        .spyOn(hub, 'request')
        .mockResolvedValue(new Response('{"ok":true}'));
      return { ...s, request };
    }

    test('an admin attaches a helper to a shared simulator through the connection', async () => {
      const s = await running();
      const response = await s.service.attachStreamHelper(admin, UDID);
      expect(response.ok).toBe(true);
      expect(s.request).toHaveBeenCalledWith(
        'POST',
        '/vendor/serve-sim/grid/api/start',
        {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ udid: UDID }),
        },
      );
    });

    test('an unshared simulator, or a grid shutdown (power off), is refused for an admin', async () => {
      const s = await running();
      await expect(s.service.attachStreamHelper(admin, OTHER)).rejects.toThrow(
        DeviceActionRefusedError,
      );
      await expect(s.service.detachStreamHelper(admin, UDID)).rejects.toThrow(
        'access-denied',
      );
      expect(s.request).not.toHaveBeenCalled();
      await s.service.detachStreamHelper({ kind: 'operator' }, UDID);
      expect(s.request).toHaveBeenCalledWith(
        'POST',
        '/vendor/serve-sim/grid/api/shutdown',
        expect.anything(),
      );
    });

    test('nothing starts a hub the operator has not enabled', async () => {
      const s = setup();
      await expect(s.service.attachStreamHelper(admin, UDID)).rejects.toThrow(
        'hub-unavailable',
      );
      expect(s.spawned).toEqual([]);
    });
  });
});
