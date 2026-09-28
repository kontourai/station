import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PeerCredentialStore } from '../../peers/peer-credential-store.js';
import {
  createRemoteStationForwarder,
  isRemoteStationTarget,
  REMOTE_STATION_REQUEST_TIMEOUT_MS,
  remoteStationRequestTimeoutMs,
} from '../remote-station-forwarder.js';

const ENV = 'environment-remote-b';
const SECRET = 'peer-forwarder-secret-0123456789';

function sshView(
  overrides: {
    environmentId?: string;
    verifiedProjectPath?: string | null;
    phase?: string;
    localUrl?: string;
    action?: string;
  } = {},
) {
  return {
    profile: {
      id: 'ssh-profile-1',
      name: 'Box B',
      environmentId: overrides.environmentId ?? ENV,
      verifiedProjectPath:
        overrides.verifiedProjectPath === undefined
          ? '/srv/project'
          : overrides.verifiedProjectPath,
      remoteHome: '/home/b',
    },
    state: {
      phase: overrides.phase ?? 'connected',
      localUrl: overrides.localUrl ?? 'http://127.0.0.1:47001',
      ...(overrides.action ? { action: overrides.action } : {}),
    },
  } as never;
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function realPeerStore(withPeer: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'station-forwarder-'));
  directories.push(home);
  mkdirSync(join(home, 'security'), { mode: 0o700 });
  const store = new PeerCredentialStore(home);
  if (withPeer) {
    await store.upsert({
      environmentId: ENV,
      apiBase: 'https://peer-b.example.test',
      scope: 'orchestration:read orchestration:operate',
      credential: SECRET,
      label: 'Peer B',
    });
  }
  return store;
}

describe('RemoteStationForwarder (#2377 C2b)', () => {
  test('a peer with no SSH profile resolves to its origin with its bearer, from the real store', async () => {
    const connect = vi.fn();
    const forwarder = createRemoteStationForwarder({
      ssh: { list: () => [], connect },
      peers: await realPeerStore(true),
    });
    const target = await forwarder.resolve(ENV);
    expect(target).toMatchObject({
      kind: 'peer',
      apiBase: 'https://peer-b.example.test',
      environmentId: ENV,
      environmentName: 'Peer B',
      requestOptions: { headers: { Authorization: `Bearer ${SECRET}` } },
    });
    expect(connect).not.toHaveBeenCalled();
    expect(isRemoteStationTarget(target)).toBe(true);
    expect(Object.isFrozen(target)).toBe(true);
  });

  test('an SSH profile wins over a peer credential, and carries the bearer through the tunnel', async () => {
    const forwarder = createRemoteStationForwarder({
      ssh: { list: () => [sshView()], connect: async () => sshView() },
      peers: await realPeerStore(true),
    });
    const target = await forwarder.resolve(ENV);
    expect(target).toMatchObject({
      kind: 'ssh',
      apiBase: 'http://127.0.0.1:47001',
      projectPath: '/srv/project',
      remoteHome: '/home/b',
      requestOptions: { headers: { Authorization: `Bearer ${SECRET}` } },
    });
  });

  test('neither an SSH profile nor a peer: the not-found error', async () => {
    const forwarder = createRemoteStationForwarder({
      ssh: { list: () => [], connect: vi.fn() },
      peers: await realPeerStore(false),
    });
    await expect(forwarder.resolve(ENV)).rejects.toThrow(
      'not a saved, verified SSH environment',
    );
  });

  test.each([
    [
      'an unverified profile',
      { verifiedProjectPath: null },
      undefined,
      /not yet verified/,
    ],
    [
      'a project path other than the verified one',
      {},
      '/elsewhere',
      /does not match the verified SSH environment binding/,
    ],
    [
      'a tunnel that is not loopback',
      { localUrl: 'http://10.0.0.8:47001' },
      undefined,
      /non-loopback tunnel/,
    ],
    [
      'a profile that is not connected',
      { phase: 'failed', action: 'Reconnect Box B' },
      undefined,
      /Reconnect Box B/,
    ],
  ] as const)(
    '%s is refused and never falls through to the peer credential',
    async (_name, overrides, requestedPath, message) => {
      const peers = await realPeerStore(true);
      const get = vi.spyOn(peers, 'get');
      const forwarder = createRemoteStationForwarder({
        ssh: {
          list: () => [sshView(overrides)],
          connect: async () => sshView(overrides),
        },
        peers,
      });
      await expect(forwarder.resolve(ENV, requestedPath)).rejects.toThrow(
        message,
      );
      // The only allowed read on these paths is the tunnel's own bearer
      // lookup after a successful connect; none of these get that far,
      // except the non-loopback case, whose target is still never returned.
      expect(get.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  test('a binding that changes while connecting is refused', async () => {
    const forwarder = createRemoteStationForwarder({
      ssh: {
        list: () => [sshView()],
        connect: async () => sshView({ environmentId: 'environment-other' }),
      },
      peers: await realPeerStore(false),
    });
    await expect(forwarder.resolve(ENV)).rejects.toThrow(/binding changed/);
  });

  test('a failed credential read keeps the tunnel and is reported, never silent', async () => {
    const warn = vi.fn();
    const forwarder = createRemoteStationForwarder({
      ssh: { list: () => [sshView()], connect: async () => sshView() },
      peers: {
        get: () => {
          throw new Error('store unreadable');
        },
      },
      warn,
    });
    const target = await forwarder.resolve(ENV);
    expect(target.kind).toBe('ssh');
    expect(target.requestOptions).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('store unreadable'),
    );
  });

  test('a look-alike object is not a forwarder target', () => {
    expect(
      isRemoteStationTarget({
        kind: 'peer',
        apiBase: 'https://peer-b.example.test',
        environmentId: ENV,
        environmentName: 'forged',
      }),
    ).toBe(false);
    expect(isRemoteStationTarget(null)).toBe(false);
  });
});

describe('the route-owned remote request bound (#2377 C2b)', () => {
  test('defaults to 30 s and accepts an override inside 1..600000', () => {
    expect(REMOTE_STATION_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(remoteStationRequestTimeoutMs({})).toBe(30_000);
    expect(
      remoteStationRequestTimeoutMs({ STATION_REMOTE_REQUEST_TIMEOUT_MS: '1' }),
    ).toBe(1);
    expect(
      remoteStationRequestTimeoutMs({
        STATION_REMOTE_REQUEST_TIMEOUT_MS: '600000',
      }),
    ).toBe(600_000);
  });

  test.each(['0', '600001', '-5', '1.5', '30s', ' 30'])(
    'refuses %j rather than clamping it',
    (value) => {
      expect(() =>
        remoteStationRequestTimeoutMs({
          STATION_REMOTE_REQUEST_TIMEOUT_MS: value,
        }),
      ).toThrow(/must be an integer from 1 to 600000/);
    },
  );
});
