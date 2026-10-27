import { describe, expect, it, vi } from 'vitest';
import { ConnectionHealthCoordinator } from '../core/ConnectionHealthCoordinator';
import { ConnectionStore } from '../core/ConnectionStore';
import {
  connectionRouteKind,
  connectionRouteRemovable,
} from '../core/connectionRoutes';
import { createAccessEndpoint } from '../core/environmentProfiles';
import type { StorageAdapter } from '../core/types';

function memoryAdapter(): StorageAdapter {
  const values: Record<string, string> = {};
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

const handshake = (environmentId: string) => ({
  environmentId,
  authentication: { scheme: 'bearer' as const, protocolVersion: 1 },
});

function pairedStation(url = 'http://192.168.1.20:3141') {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  const connection = store.add('Home', url);
  store.reconcileHandshake(connection.id, handshake('env-home'));
  const read = () => store.getAll().find((item) => item.id === connection.id)!;
  return { store, id: connection.id, read };
}

const urls = (connection: { endpoints: { url: string }[] }) =>
  connection.endpoints.map((endpoint) => endpoint.url);

describe('connectionRouteKind', () => {
  it.each([
    ['http://127.0.0.1:3141', 'local'],
    ['http://192.168.1.20:3141', 'lan'],
    ['http://10.0.0.5:3141', 'lan'],
    ['http://station.local:3141', 'lan'],
    ['http://100.77.142.114:3141', 'tailscale'],
    ['https://box.tail1.ts.net', 'tailscale-https'],
    ['https://station.example.com', 'internet'],
    ['http://100.200.1.1:3141', 'internet'],
  ])('%s is a %s route', (url, kind) => {
    expect(connectionRouteKind(createAccessEndpoint(url))).toBe(kind);
  });

  it('keeps relay and SSH tunnel kinds from the endpoint itself', () => {
    expect(
      connectionRouteKind({
        url: 'https://relay.example',
        kind: 'broker-route',
      }),
    ).toBe('relay');
    expect(
      connectionRouteKind({
        url: 'http://127.0.0.1:4000',
        kind: 'ssh-forward',
      }),
    ).toBe('ssh');
  });
});

describe('advertised routes', () => {
  it('learns new routes only from the same Station, marked as found automatically', () => {
    const { store, id, read } = pairedStation();
    const routes = [
      { kind: 'lan' as const, url: 'http://192.168.1.20:3141' },
      { kind: 'tailscale' as const, url: 'http://100.77.142.114:3141' },
      { kind: 'tailscale-https' as const, url: 'https://box.tail1.ts.net' },
    ];

    expect(
      store.applyAdvertisedRoutes(id, 'env-other', routes, {
        clientProtocol: 'native:',
      }),
    ).toBe(false);
    expect(urls(read())).toEqual(['http://192.168.1.20:3141']);

    expect(
      store.applyAdvertisedRoutes(id, 'env-home', routes, {
        clientProtocol: 'native:',
      }),
    ).toBe(true);
    const connection = read();
    expect(urls(connection)).toEqual([
      'http://192.168.1.20:3141',
      'http://100.77.142.114:3141',
      'https://box.tail1.ts.net',
    ]);
    // The paired address stays the user's; the learned ones are advertised.
    expect(connection.endpoints.map((endpoint) => endpoint.source)).toEqual([
      undefined,
      'advertised',
      'advertised',
    ]);
    expect(connection.accessMethods).toHaveLength(3);
    expect(connection.selectedEndpointId).toBe(connection.endpoints[0]!.id);
    // A repeat report changes nothing.
    expect(
      store.applyAdvertisedRoutes(id, 'env-home', routes, {
        clientProtocol: 'native:',
      }),
    ).toBe(false);
  });

  it('refuses to learn before the Station identity is known', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const connection = store.add('Home', 'http://192.168.1.20:3141');
    expect(
      store.applyAdvertisedRoutes(
        connection.id,
        'env-home',
        [{ kind: 'tailscale', url: 'http://100.77.142.114:3141' }],
        { clientProtocol: 'native:' },
      ),
    ).toBe(false);
  });

  it('drops routes the Station stopped reporting, except the one in use', () => {
    const { store, id, read } = pairedStation();
    store.applyAdvertisedRoutes(
      id,
      'env-home',
      [
        { kind: 'tailscale', url: 'http://100.77.142.114:3141' },
        { kind: 'tailscale-https', url: 'https://box.tail1.ts.net' },
      ],
      { clientProtocol: 'native:' },
    );
    const inUse = read().endpoints.find(
      (endpoint) => endpoint.url === 'https://box.tail1.ts.net',
    )!;
    store.selectEndpoint(id, inUse.id);

    store.applyAdvertisedRoutes(id, 'env-home', [], {
      clientProtocol: 'native:',
    });

    expect(urls(read())).toEqual([
      'http://192.168.1.20:3141',
      'https://box.tail1.ts.net',
    ]);
  });

  it('skips plain HTTP routes an HTTPS page could never use', () => {
    const { store, id, read } = pairedStation('https://station.example.com');
    store.applyAdvertisedRoutes(
      id,
      'env-home',
      [
        { kind: 'lan', url: 'http://192.168.1.20:3141' },
        { kind: 'tailscale-https', url: 'https://box.tail1.ts.net' },
      ],
      { clientProtocol: 'https:' },
    );
    expect(urls(read())).toEqual([
      'https://station.example.com',
      'https://box.tail1.ts.net',
    ]);
  });
});

describe('routes the user adds and removes', () => {
  it('adds a typed route, refuses a non-HTTP address, and ignores a duplicate', () => {
    const { store, id, read } = pairedStation();
    expect(store.addRoute(id, ' http://100.77.142.114:3141/path ')).toBe(true);
    expect(urls(read())).toContain('http://100.77.142.114:3141');
    expect(() => store.addRoute(id, 'ftp://box')).toThrow(/http:\/\//);
    expect(store.addRoute(id, 'http://100.77.142.114:3141')).toBe(false);
  });

  it('removes only routes the user added, never the last one, and reselects', () => {
    const { store, id, read } = pairedStation();
    store.addRoute(id, 'http://100.77.142.114:3141');
    store.applyAdvertisedRoutes(
      id,
      'env-home',
      [{ kind: 'tailscale-https', url: 'https://box.tail1.ts.net' }],
      { clientProtocol: 'native:' },
    );
    const [paired, typed, advertised] = read().endpoints;
    expect(connectionRouteRemovable(read(), advertised!)).toBe(false);
    expect(store.removeRoute(id, advertised!.id)).toBe(false);

    store.selectEndpoint(id, typed!.id);
    expect(store.removeRoute(id, typed!.id)).toBe(true);
    const after = read();
    expect(urls(after)).toEqual([
      'http://192.168.1.20:3141',
      'https://box.tail1.ts.net',
    ]);
    expect(after.selectedEndpointId).not.toBe(typed!.id);
    expect(after.accessMethods.map((method) => method.id)).toContain(
      after.selectedAccessMethodId,
    );

    expect(store.removeRoute(id, paired!.id)).toBe(true);
    expect(store.removeRoute(id, advertised!.id)).toBe(false);
    expect(read().endpoints).toHaveLength(1);
  });
});

describe('per-route health results', () => {
  it('reports the failed route, the one in use, and the ones never reached', async () => {
    const lan = createAccessEndpoint('http://192.168.1.20:3141', {
      priority: 1,
    });
    const tailscale = createAccessEndpoint('http://100.77.142.114:3141', {
      priority: 2,
    });
    const https = createAccessEndpoint('https://box.tail1.ts.net', {
      priority: 3,
    });
    const blocked = createAccessEndpoint('http://10.0.0.9:3141', {
      priority: 0,
    });
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [lan, tailscale, https, blocked],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check: async (endpoint) =>
        endpoint.id === https.id
          ? { ok: true }
          : { ok: false, reason: 'unreachable' },
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().status).toBe('connected'),
    );
    expect(coordinator.getSnapshot().routes).toEqual(
      expect.arrayContaining([
        { endpointId: https.id, state: 'in-use' },
        { endpointId: blocked.id, state: 'blocked', reason: 'mixed-content' },
        { endpointId: lan.id, state: 'blocked', reason: 'mixed-content' },
      ]),
    );
    unsubscribe();
  });

  it('marks routes after the one in use as not checked', async () => {
    const first = createAccessEndpoint('https://a.tail1.ts.net', {
      priority: 1,
    });
    const second = createAccessEndpoint('https://b.tail1.ts.net', {
      priority: 2,
    });
    const third = createAccessEndpoint('https://c.tail1.ts.net', {
      priority: 3,
    });
    const check = vi.fn(async (endpoint: { id: string }) =>
      endpoint.id === first.id
        ? ({ ok: false, reason: 'identity-mismatch' } as const)
        : ({ ok: true } as const),
    );
    const coordinator = new ConnectionHealthCoordinator({
      endpoints: () => [first, second, third],
      compatibility: () => ({ clientProtocol: 'https:', online: true }),
      check,
    });
    const unsubscribe = coordinator.subscribe(vi.fn());

    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().status).toBe('connected'),
    );
    expect(coordinator.getSnapshot().routes).toEqual([
      { endpointId: first.id, state: 'failed', reason: 'identity-mismatch' },
      { endpointId: second.id, state: 'in-use' },
      { endpointId: third.id, state: 'not-checked' },
    ]);
    expect(check).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
