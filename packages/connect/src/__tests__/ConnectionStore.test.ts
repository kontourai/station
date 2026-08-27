/**
 * ConnectionStore unit tests — pure Node, no DOM, no React.
 * Uses an in-memory storage adapter to stay deterministic.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';

// Minimal in-memory adapter so tests don't touch localStorage
function memoryAdapter(): StorageAdapter {
  const store: Record<string, string> = {};
  return {
    get: (k) => store[k] ?? null,
    set: (k, v) => {
      store[k] = v;
    },
    remove: (k) => {
      delete store[k];
    },
  };
}

function makeStore() {
  return new ConnectionStore({ storage: memoryAdapter() });
}

describe('ConnectionStore — basics', () => {
  it('starts empty', () => {
    expect(makeStore().getAll()).toHaveLength(0);
    expect(makeStore().getActive()).toBeNull();
  });

  it('add() returns the new connection', () => {
    const store = makeStore();
    const conn = store.add('Home', 'http://192.168.1.10:3141');
    expect(conn.name).toBe('Home');
    expect(conn.url).toBe('http://192.168.1.10:3141');
    expect(conn.id).toBeTruthy();
  });

  it('getAll() returns all added connections in insertion order', () => {
    const store = makeStore();
    store.add('A', 'http://a:3141');
    store.add('B', 'http://b:3141');
    store.add('C', 'http://c:3141');
    expect(store.getAll().map((c) => c.name)).toEqual(['A', 'B', 'C']);
  });

  it('first added connection becomes active automatically', () => {
    const store = makeStore();
    const conn = store.add('First', 'http://first:3141');
    expect(store.getActive()?.id).toBe(conn.id);
  });

  it('remove() deletes a connection', () => {
    const store = makeStore();
    const a = store.add('A', 'http://a:3141');
    const b = store.add('B', 'http://b:3141');
    store.remove(a.id);
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe(b.id);
  });

  it('remove() of active connection falls back to next one', () => {
    const store = makeStore();
    const a = store.add('A', 'http://a:3141');
    store.add('B', 'http://b:3141');
    store.setActive(a.id);
    store.remove(a.id);
    expect(store.getActive()?.name).toBe('B');
  });

  it('remove() last connection leaves getActive() null', () => {
    const store = makeStore();
    const a = store.add('A', 'http://a:3141');
    store.remove(a.id);
    expect(store.getActive()).toBeNull();
  });

  it('update() changes name and url', () => {
    const store = makeStore();
    const conn = store.add('Old', 'http://old:3141');
    store.update(conn.id, { name: 'New', url: 'http://new:3141' });
    const updated = store.getAll().find((c) => c.id === conn.id)!;
    expect(updated.name).toBe('New');
    expect(updated.url).toBe('http://new:3141');
  });

  it('setActive() activates a specific connection', () => {
    const store = makeStore();
    const a = store.add('A', 'http://a:3141');
    const b = store.add('B', 'http://b:3141');
    store.setActive(b.id);
    expect(store.getActive()?.id).toBe(b.id);
    // a should not be active
    expect(store.getActive()?.id).not.toBe(a.id);
  });

  it('setActive() stamps lastConnected', () => {
    const store = makeStore();
    const a = store.add('A', 'http://a:3141');
    expect(store.getActive()?.lastConnected).toBeUndefined();
    store.setActive(a.id);
    expect(store.getActive()?.lastConnected).toBeGreaterThan(0);
  });
});

describe('ConnectionStore — duplicate URL deduplication', () => {
  it('add() with the same URL returns existing connection without duplicating', () => {
    const store = makeStore();
    const first = store.add('Home', 'http://same:3141');
    const second = store.add('Different Name', 'http://same:3141');
    expect(store.getAll()).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it('coalesces a managed loopback only with its matching native service identity', () => {
    const adapter = memoryAdapter();
    adapter.set(
      'station-connect-connections',
      JSON.stringify([
        {
          profileVersion: 4,
          id: 'station-profile:local',
          name: 'local',
          url: 'http://127.0.0.1:38141',
          ownerId: 'desktop-sidecar-nightly',
        },
        {
          profileVersion: 4,
          id: 'station-profile:paired-at-loopback',
          name: 'paired-at-loopback',
          url: 'http://127.0.0.1:38141',
        },
      ]),
    );
    adapter.set('station-connect-connections-active', 'station-profile:local');
    const store = new ConnectionStore({ storage: adapter });

    store.setInjectedConnection({
      id: 'managed-loopback',
      name: 'Station on this device',
      url: 'http://127.0.0.1:38141',
      source: 'managed-loopback',
      ownerId: 'desktop-sidecar-nightly',
    });

    // The injected owner and the baseDir-owned local profile are one Station.
    // A separately paired profile at that same origin is not.
    expect(store.getAll().map((connection) => connection.id)).toEqual([
      'station-profile:local',
      'station-profile:paired-at-loopback',
    ]);
    expect(store.getActive()?.id).toBe('station-profile:local');
  });

  it('does not coalesce a rotated sidecar until the host has reconciled its saved owner', () => {
    const adapter = memoryAdapter();
    adapter.set(
      'station-connect-connections',
      JSON.stringify([
        {
          profileVersion: 4,
          id: 'station-profile:local',
          name: 'local',
          url: 'http://127.0.0.1:38141',
          ownerId: 'desktop-sidecar-old',
        },
      ]),
    );
    const store = new ConnectionStore({ storage: adapter });

    store.setInjectedConnection({
      id: 'managed-loopback',
      name: 'Station on this device',
      url: 'http://127.0.0.1:38141',
      source: 'managed-loopback',
      ownerId: 'desktop-sidecar-nightly',
    });

    expect(store.getAll().map((connection) => connection.id)).toEqual([
      'managed-loopback',
      'station-profile:local',
    ]);
  });
});

describe('ConnectionStore — subscriptions', () => {
  it('subscribe() fires on add', () => {
    const store = makeStore();
    const fn = vi.fn();
    store.subscribe(fn);
    store.add('A', 'http://a:3141');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('subscribe() fires on remove', () => {
    const store = makeStore();
    const conn = store.add('A', 'http://a:3141');
    const fn = vi.fn();
    store.subscribe(fn);
    store.remove(conn.id);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const store = makeStore();
    const fn = vi.fn();
    const unsub = store.subscribe(fn);
    unsub();
    store.add('A', 'http://a:3141');
    expect(fn).not.toHaveBeenCalled();
  });

  it('multiple subscribers all receive notifications', () => {
    const store = makeStore();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    store.subscribe(fn1);
    store.subscribe(fn2);
    store.add('A', 'http://a:3141');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionStore — migrate()', () => {
  it('upgrades a complete v1 URL profile without losing timestamps', () => {
    const adapter = memoryAdapter();
    adapter.set(
      'station-connect-connections',
      JSON.stringify([
        {
          profileVersion: 1,
          id: 'v1-environment',
          name: 'Legacy Station',
          url: 'http://legacy:3141',
          lastConnected: 42,
        },
      ]),
    );

    const first = new ConnectionStore({ storage: adapter }).getAll();
    const second = new ConnectionStore({ storage: adapter }).getAll();

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      profileVersion: 4,
      id: 'v1-environment',
      name: 'Legacy Station',
      url: 'http://legacy:3141',
      lastConnected: 42,
      accessMethods: [expect.objectContaining({ kind: 'direct-http' })],
    });
    expect(
      JSON.parse(adapter.get('station-connect-connections') ?? '[]')[0],
    ).toMatchObject({ profileVersion: 4, lastConnected: 42 });
  });

  it('upgrades URL-only and v2 fixtures to an idempotent v4 access profile', () => {
    const adapter = memoryAdapter();
    adapter.set(
      'station-connect-connections',
      JSON.stringify([
        {
          profileVersion: 2,
          id: 'legacy-id',
          name: 'My phone Station',
          url: 'https://station.example-tailnet.ts.net',
          environmentId: null,
          authProtocolVersion: null,
          credentialState: 'required',
        },
      ]),
    );

    const first = new ConnectionStore({ storage: adapter }).getAll();
    const second = new ConnectionStore({ storage: adapter }).getAll();

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      profileVersion: 4,
      id: 'legacy-id',
      name: 'My phone Station',
      url: 'https://station.example-tailnet.ts.net',
      selectedEndpointId:
        'endpoint:tailnet-https:https%3A%2F%2Fstation.example-tailnet.ts.net',
      credentialRef: {
        credentialVersion: 1,
        kind: 'connection',
        id: 'legacy-id',
      },
      selectedAccessMethodId:
        'access:direct:endpoint:tailnet-https:https%3A%2F%2Fstation.example-tailnet.ts.net',
    });
    expect(first[0].endpoints).toHaveLength(1);
    expect(first[0].accessMethods).toEqual([
      {
        accessVersion: 1,
        id: 'access:direct:endpoint:tailnet-https:https%3A%2F%2Fstation.example-tailnet.ts.net',
        kind: 'direct-http',
        endpointId:
          'endpoint:tailnet-https:https%3A%2F%2Fstation.example-tailnet.ts.net',
      },
    ]);
    expect(
      JSON.parse(adapter.get('station-connect-connections') ?? '[]')[0],
    ).toMatchObject({ profileVersion: 4 });
  });

  it('persists a credential-free SSH access reference without a resolved URL', () => {
    const adapter = memoryAdapter();
    const store = new ConnectionStore({ storage: adapter });

    const connection = store.addHostTunnel('Media server', {
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
    });

    expect(connection).toMatchObject({
      profileVersion: 4,
      name: 'Media server',
      url: '',
      endpoints: [],
      selectedEndpointId: '',
      credentialState: 'required',
      accessMethods: [
        {
          accessVersion: 1,
          kind: 'host-tunnel',
          adapter: 'ssh',
          hostAlias: 'brian-media',
          remoteProjectPath: '~/dev/github/kontourai/station',
        },
      ],
    });
    expect(connection.selectedAccessMethodId).toBe(
      connection.accessMethods[0].id,
    );
    const serialized = adapter.get('station-connect-connections') ?? '';
    expect(serialized).not.toMatch(
      /privateKey|identityFile|bearer|secret|token|controlPath|localForward/i,
    );
    expect(serialized).not.toContain('127.0.0.1');
    expect(new ConnectionStore({ storage: adapter }).getAll()).toEqual([
      connection,
    ]);
  });

  it('gives an incomplete legacy record a usable display name', () => {
    const adapter = memoryAdapter();
    adapter.set('station-connect-connections', JSON.stringify([{}]));

    const [connection] = new ConnectionStore({ storage: adapter }).getAll();

    expect(connection.name).toBe('Station');
  });

  it('preserves v3 endpoint evidence while adding deterministic direct access methods', () => {
    const adapter = memoryAdapter();
    const endpoint = {
      endpointVersion: 1,
      id: 'endpoint:manual:https%3A%2F%2Fstation.example.test',
      url: 'https://station.example.test',
      kind: 'manual',
      priority: 7,
      verifiedAt: 123,
    };
    adapter.set(
      'station-connect-connections',
      JSON.stringify([
        {
          profileVersion: 3,
          id: 'v3-environment',
          name: 'Existing environment',
          url: endpoint.url,
          endpoints: [endpoint],
          selectedEndpointId: endpoint.id,
          environmentId: 'environment-1',
          authProtocolVersion: 1,
          credentialState: 'saved',
        },
      ]),
    );

    const first = new ConnectionStore({ storage: adapter }).getAll();
    const second = new ConnectionStore({ storage: adapter }).getAll();

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      profileVersion: 4,
      endpoints: [endpoint],
      selectedEndpointId: endpoint.id,
      selectedAccessMethodId: `access:direct:${endpoint.id}`,
      accessMethods: [
        {
          accessVersion: 1,
          id: `access:direct:${endpoint.id}`,
          kind: 'direct-http',
          endpointId: endpoint.id,
        },
      ],
      environmentId: 'environment-1',
      credentialState: 'saved',
    });
  });

  it('imports a legacy single-URL without deleting the recovery source', () => {
    const adapter = memoryAdapter();
    adapter.set('old-api-base', 'http://legacy:3141');

    const store = new ConnectionStore({ storage: adapter });
    store.migrate('old-api-base');

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].url).toBe('http://legacy:3141');
    expect(adapter.get('old-api-base')).toBe('http://legacy:3141');
  });

  it('migrate() is idempotent — does not duplicate if URL already exists', () => {
    const adapter = memoryAdapter();
    adapter.set('old-api-base', 'http://legacy:3141');

    const store = new ConnectionStore({ storage: adapter });
    store.add('Legacy', 'http://legacy:3141'); // pre-existing
    store.migrate('old-api-base');

    expect(store.getAll()).toHaveLength(1);
  });

  it('migrate() is a no-op when legacy key is absent', () => {
    const store = makeStore();
    store.migrate('nonexistent-key');
    expect(store.getAll()).toHaveLength(0);
  });

  it('keeps a legacy remote endpoint usable in a credential-required migration state', () => {
    const adapter = memoryAdapter();
    adapter.set('old-api-base', 'https://station.example.test');

    const store = new ConnectionStore({ storage: adapter });
    store.migrate('old-api-base');

    expect(store.getAll()).toEqual([
      expect.objectContaining({
        url: 'https://station.example.test',
        environmentId: null,
        credentialState: 'required',
      }),
    ]);
    expect(store.getActive()).toEqual(
      expect.objectContaining({ credentialState: 'required' }),
    );
  });
});

describe('ConnectionStore — stable environment profiles', () => {
  const handshake = (environmentId: string) => ({
    environmentId,
    authentication: { scheme: 'bearer' as const, protocolVersion: 1 },
  });

  it('keeps credentials out of ordinary profile serialization', () => {
    const adapter = memoryAdapter();
    const store = new ConnectionStore({ storage: adapter });
    const connection = store.add('Phone', 'https://station.example.test');

    store.setCredential(connection.id, 'fixture-secret-value');

    expect(adapter.get('station-connect-connections')).not.toContain(
      'fixture-secret-value',
    );
    expect(store.getAll()[0]).not.toHaveProperty('credential');
    expect(store.getCredential(connection.id)).toBe('fixture-secret-value');
  });

  it('moves a provisional credential to the verified environment identity', () => {
    const adapter = memoryAdapter();
    const store = new ConnectionStore({ storage: adapter });
    const connection = store.add('Phone', 'https://old.example.test');
    store.setCredential(connection.id, 'fixture-secret-value');

    const verified = store.reconcileHandshake(
      connection.id,
      handshake('environment-1'),
    );

    expect(verified).toMatchObject({
      environmentId: 'environment-1',
      authProtocolVersion: 1,
      credentialState: 'saved',
    });
    expect(store.getCredential(verified!.id)).toBe('fixture-secret-value');
  });

  it('stages a same-identity endpoint without rebinding the trusted profile', () => {
    const store = makeStore();
    const stable = store.add('My Station', 'https://old.example.test');
    store.reconcileHandshake(stable.id, handshake('environment-1'));
    const candidate = store.add('Temporary', 'https://new.example.test');
    store.setActive(candidate.id);

    const merged = store.reconcileHandshake(
      candidate.id,
      handshake('environment-1'),
    );

    expect(store.getAll()).toHaveLength(1);
    expect(merged).toMatchObject({
      id: stable.id,
      name: 'My Station',
      url: 'https://old.example.test',
      environmentId: 'environment-1',
      endpointCandidate: {
        url: 'https://new.example.test',
        state: 'confirmation-required',
      },
    });
    expect(store.getActive()?.id).toBe(stable.id);
  });

  it('keeps an unrelated active Station selected when two other Stations merge', () => {
    const store = makeStore();
    const stable = store.add('My Station', 'https://old.example.test');
    store.reconcileHandshake(stable.id, handshake('environment-1'));
    const candidate = store.add('Temporary', 'https://new.example.test');
    const unrelated = store.add('Other Station', 'https://other.example.test');
    store.setActive(unrelated.id);

    store.reconcileHandshake(candidate.id, handshake('environment-1'));

    expect(store.getActive()?.id).toBe(unrelated.id);
  });

  it('preserves the null active pointer while merging around an injected host', () => {
    const store = makeStore();
    const stable = store.add('My Station', 'https://old.example.test');
    store.reconcileHandshake(stable.id, handshake('environment-1'));
    const candidate = store.add('Temporary', 'https://new.example.test');
    store.setInjectedConnection({
      id: 'managed-loopback',
      name: 'Local Station',
      url: 'http://127.0.0.1:3142',
      source: 'managed-loopback',
      status: 'running',
    });
    store.setActive('managed-loopback');

    store.reconcileHandshake(candidate.id, handshake('environment-1'));

    expect(store.getActive()?.id).toBe('managed-loopback');
  });

  it('merges same-environment host access without staging an empty HTTP endpoint', () => {
    const adapter = memoryAdapter();
    const store = new ConnectionStore({ storage: adapter });
    const direct = store.add('My Station', 'https://station.example.test');
    store.reconcileHandshake(direct.id, handshake('environment-1'));
    const host = store.addHostTunnel('Media access', {
      hostAlias: 'brian-media',
      remoteProjectPath: '/srv/station',
    });
    const hostMethod = host.accessMethods[0];

    const merged = store.reconcileHandshake(
      host.id,
      handshake('environment-1'),
    );

    expect(store.getAll()).toHaveLength(1);
    expect(merged).toMatchObject({
      id: direct.id,
      environmentId: 'environment-1',
      url: 'https://station.example.test',
      selectedAccessMethodId: hostMethod.id,
    });
    expect(merged).not.toHaveProperty('endpointCandidate');
    expect(merged?.accessMethods).toEqual([
      expect.objectContaining({ kind: 'direct-http' }),
      hostMethod,
    ]);

    const directMethod = merged!.accessMethods.find(
      (method) => method.kind === 'direct-http',
    )!;
    store.selectAccessMethod(merged!.id, directMethod.id);
    expect(store.getActive()?.selectedAccessMethodId).toContain(
      'access:direct:',
    );
    store.addHostTunnel('Media access', {
      hostAlias: 'brian-media',
      remoteProjectPath: '/srv/station',
    });
    expect(store.getActive()?.selectedAccessMethodId).toBe(hostMethod.id);
    expect(new ConnectionStore({ storage: adapter }).getActive()).toEqual(
      store.getActive(),
    );
  });

  it('preserves a pending direct endpoint while merging host access', () => {
    const store = makeStore();
    const direct = store.add('My Station', 'https://station.example.test');
    store.reconcileHandshake(direct.id, handshake('environment-1'));
    store.update(direct.id, { url: 'https://candidate.example.test' });
    const pending = store.getActive()?.endpointCandidate;
    const host = store.addHostTunnel('Media access', {
      hostAlias: 'brian-media',
      remoteProjectPath: '/srv/station',
    });

    const merged = store.reconcileHandshake(
      host.id,
      handshake('environment-1'),
    );

    expect(merged?.endpointCandidate).toEqual(pending);
    expect(merged?.selectedAccessMethodId).toBe(host.accessMethods[0].id);
  });

  it('records host-tunnel success without persisting its loopback endpoint', () => {
    const adapter = memoryAdapter();
    const store = new ConnectionStore({ storage: adapter });
    const connection = store.addHostTunnel('Media access', {
      hostAlias: 'brian-media',
      remoteProjectPath: '/srv/station',
    });
    const hostMethod = connection.accessMethods[0];

    store.recordEndpointSuccess(
      connection.id,
      'http://127.0.0.1:43141',
      100,
      'boot-1',
      hostMethod.id,
    );

    expect(store.getActive()).toMatchObject({
      url: '',
      endpoints: [],
      accessMethods: [hostMethod],
      selectedAccessMethodId: hostMethod.id,
      lastConnected: 100,
      lastSuccessAt: 100,
      lastBootId: 'boot-1',
    });
    expect(adapter.get('station-connect-connections')).not.toContain(
      '127.0.0.1',
    );
    const reloaded = new ConnectionStore({ storage: adapter });
    expect(reloaded.getActive()).toEqual(store.getActive());
    reloaded.recordEndpointSuccess(
      connection.id,
      'http://127.0.0.1:44141',
      150,
      'boot-2',
    );
    expect(adapter.get('station-connect-connections')).not.toContain(
      '127.0.0.1',
    );
    expect(() =>
      store.recordEndpointSuccess(
        connection.id,
        'https://remote.example.test',
        200,
        'boot-2',
        hostMethod.id,
      ),
    ).toThrow('loopback');
    expect(() =>
      store.recordEndpointSuccess(
        connection.id,
        'http://127.0.0.1:43141',
        200,
        'boot-2',
        'access:ssh:other',
      ),
    ).toThrow('does not belong');
  });

  it('moves a provisional credential when URL records merge by verified identity', () => {
    const profiles = memoryAdapter();
    const credentials = memoryAdapter();
    const store = new ConnectionStore({
      storage: profiles,
      credentialStorage: credentials,
    });
    const stable = store.add('My Station', 'https://old.example.test');
    store.reconcileHandshake(stable.id, handshake('environment-1'));
    const candidate = store.add('Temporary', 'https://new.example.test');
    store.setCredential(candidate.id, 'new-device-credential');

    const merged = store.reconcileHandshake(
      candidate.id,
      handshake('environment-1'),
    );

    expect(store.getAll()).toHaveLength(1);
    expect(merged).toMatchObject({
      id: stable.id,
      environmentId: 'environment-1',
      credentialState: 'saved',
    });
    expect(store.getCredential(stable.id)).toBe('new-device-credential');
    expect(
      credentials.get('station-connect-connections-credentials'),
    ).not.toContain(`connection:${candidate.id}`);
  });

  it('commits a staged endpoint only after the caller records authenticated proof', () => {
    const store = makeStore();
    const connection = store.add('My Station', 'https://old.example.test');
    store.reconcileHandshake(connection.id, handshake('environment-1'));
    store.setCredential(connection.id, 'existing-credential');
    store.update(connection.id, { url: 'https://new.example.test' });
    store.reconcileHandshake(connection.id, handshake('environment-1'));

    expect(store.getActive()?.url).toBe('https://old.example.test');
    expect(store.commitEndpointCandidate(connection.id)).toMatchObject({
      url: 'https://new.example.test',
      environmentId: 'environment-1',
      credentialState: 'saved',
    });
    expect(store.getActive()?.url).toBe('https://new.example.test');
    expect(
      store.getActive()?.endpoints.map((endpoint) => endpoint.url),
    ).toEqual(['https://old.example.test', 'https://new.example.test']);
  });

  it('records selected endpoint success and redacted failure evidence', () => {
    const store = makeStore();
    const connection = store.add('Phone', 'https://station.example.test');

    store.recordEndpointSuccess(
      connection.id,
      'https://station.example.test',
      100,
    );
    expect(store.getActive()).toMatchObject({
      lastSuccessAt: 100,
      endpoints: [expect.objectContaining({ verifiedAt: 100 })],
    });

    store.recordEndpointFailure(
      connection.id,
      'authentication-failed',
      200,
      'credential rejected',
    );
    expect(store.getActive()?.lastError).toEqual({
      reason: 'authentication-failed',
      endpointId: store.getActive()?.selectedEndpointId,
      at: 200,
      detail: 'credential rejected',
    });
    expect(JSON.stringify(store.getActive())).not.toContain('bearer');
  });

  it('records one observable server-restart transition when boot identity changes', () => {
    const store = makeStore();
    const connection = store.add('Phone', 'https://station.example.test');
    store.recordEndpointSuccess(
      connection.id,
      'https://station.example.test',
      100,
      'boot-1',
    );
    store.recordEndpointSuccess(
      connection.id,
      'https://station.example.test',
      200,
      'boot-2',
    );
    expect(store.getActive()).toMatchObject({
      lastBootId: 'boot-2',
      lastTransition: { reason: 'server-restarted', at: 200 },
    });
    expect(store.getActive()?.lastError).toBeUndefined();

    store.recordEndpointSuccess(
      connection.id,
      'https://station.example.test',
      300,
      'boot-2',
    );
    expect(store.getActive()?.lastTransition).toMatchObject({
      reason: 'server-restarted',
      at: 200,
    });
  });

  it('switches among known endpoints without creating another environment', () => {
    const store = makeStore();
    const connection = store.add('Phone', 'https://old.example.test');
    store.reconcileHandshake(connection.id, handshake('environment-1'));
    store.update(connection.id, { url: 'https://new.example.test' });
    store.reconcileHandshake(connection.id, handshake('environment-1'));
    store.commitEndpointCandidate(connection.id);

    const oldEndpoint = store
      .getActive()!
      .endpoints.find(
        (endpoint) => endpoint.url === 'https://old.example.test',
      )!;
    store.selectEndpoint(connection.id, oldEndpoint.id);

    expect(store.getAll()).toHaveLength(1);
    expect(store.getActive()).toMatchObject({
      environmentId: 'environment-1',
      url: 'https://old.example.test',
      selectedEndpointId: oldEndpoint.id,
    });
  });

  it('can explicitly type the browser origin without changing its URL', () => {
    const store = makeStore();
    const connection = store.add('Default', 'https://station.example.test');
    store.setSelectedEndpointKind(connection.id, 'same-origin');
    expect(store.getActive()).toMatchObject({
      url: 'https://station.example.test',
      selectedEndpointId:
        'endpoint:same-origin:https%3A%2F%2Fstation.example.test',
      endpoints: [expect.objectContaining({ kind: 'same-origin' })],
    });
  });

  it('persists an untrusted candidate without changing the active URL', () => {
    const adapter = memoryAdapter();
    const first = new ConnectionStore({ storage: adapter });
    const connection = first.add('My Station', 'https://trusted.example.test');
    first.reconcileHandshake(connection.id, handshake('environment-1'));
    first.setCredential(connection.id, 'existing-credential');
    first.update(connection.id, { url: 'https://attacker.example.test' });
    first.reconcileHandshake(connection.id, handshake('environment-1'));

    const reloaded = new ConnectionStore({ storage: adapter });
    expect(reloaded.getActive()).toMatchObject({
      url: 'https://trusted.example.test',
      endpointCandidate: {
        url: 'https://attacker.example.test',
        state: 'confirmation-required',
      },
    });
    expect(reloaded.getCredential(connection.id)).toBe('existing-credential');
  });

  it('replaces and removes credential material without rendering it in profile data', () => {
    const store = makeStore();
    const connection = store.add('Phone', 'https://station.example.test');
    store.setCredential(connection.id, 'first-fixture-secret');
    store.setCredential(connection.id, 'second-fixture-secret');
    expect(store.getCredential(connection.id)).toBe('second-fixture-secret');
    expect(store.getAll()[0].credentialState).toBe('saved');

    store.removeCredential(connection.id);
    expect(store.getCredential(connection.id)).toBeNull();
    expect(store.getAll()[0].credentialState).toBe('required');
  });

  /**
   * This covers the equality guard ONLY, and it hand-supplies the old
   * credential — which assumes the SDK preserved the credential the rejected
   * request actually carried. That assumption was false until the transport
   * stopped re-resolving at response time, and it cannot be checked from here.
   * Two suites check it where it is decidable:
   * `ConnectionStore.authenticated-recovery.test.ts` (the generation guard,
   * including the device-session case where both values are `undefined` and
   * equality can decide nothing) and
   * `src-ui/src/contexts/__tests__/ApiBaseContext.credential-recovery.test.tsx`
   * (the real resolver, through `ApiBaseProvider` and the real SDK).
   */
  it('does not let a stale unauthorized response clear a newer credential', () => {
    const store = makeStore();
    const connection = store.add('Phone', 'https://station.example.test');
    store.setCredential(connection.id, 'old-credential');
    store.setCredential(connection.id, 'new-credential');

    store.markCredentialRequired(connection.id, 'old-credential');

    expect(store.getCredential(connection.id)).toBe('new-credential');
    expect(store.getAll()[0].credentialState).toBe('saved');

    store.markCredentialRequired(connection.id, 'new-credential');
    expect(store.getCredential(connection.id)).toBeNull();
    expect(store.getAll()[0].credentialState).toBe('required');
  });

  it('persists paired browser-session state without persisting credential material', () => {
    const storage = memoryAdapter();
    const first = new ConnectionStore({ storage });
    const connection = first.add('Phone', 'https://station.example.test');
    first.setCredential(connection.id, 'old-operator-credential');
    first.markDeviceSession(connection.id);

    const reloaded = new ConnectionStore({ storage });
    expect(reloaded.getActive()?.credentialState).toBe('device-session');
    expect(reloaded.getCredential(connection.id)).toBeNull();
    reloaded.reconcileHandshake(
      connection.id,
      handshake('persistent-environment'),
    );
    expect(reloaded.getActive()?.credentialState).toBe('device-session');

    reloaded.markCredentialRequired(connection.id);
    expect(reloaded.getActive()?.credentialState).toBe('required');
  });

  it('keeps the verified environment active across endpoint update, reload, and Default healing', () => {
    const adapter = memoryAdapter();
    const first = new ConnectionStore({ storage: adapter });
    const defaultConnection = first.add('Default', 'http://localhost:3000');
    const remote = first.add(
      'Phone Station',
      'https://station-one.example.test',
    );
    first.setActive(remote.id);
    first.reconcileHandshake(remote.id, handshake('environment-1'));
    first.update(remote.id, { url: 'https://station-two.example.test' });
    first.reconcileHandshake(remote.id, handshake('environment-1'));
    first.commitEndpointCandidate(remote.id);

    const reloaded = new ConnectionStore({ storage: adapter });
    reloaded.update(defaultConnection.id, { url: 'http://localhost:5400' });

    expect(reloaded.getActive()).toMatchObject({
      id: remote.id,
      name: 'Phone Station',
      url: 'https://station-two.example.test',
      environmentId: 'environment-1',
    });
  });
});

describe('ConnectionStore — persistence', () => {
  it('keeps credentials in an injected vault separate from connection profiles', () => {
    const profiles = memoryAdapter();
    const credentials = memoryAdapter();
    const store = new ConnectionStore({
      storage: profiles,
      credentialStorage: credentials,
    });
    const connection = store.add('Phone', 'https://station.example.test');

    store.setCredential(connection.id, 'device-credential-fixture');

    expect(profiles.get('station-connect-connections')).not.toContain(
      'device-credential-fixture',
    );
    expect(profiles.get('station-connect-connections-credentials')).toBeNull();
    expect(
      credentials.get('station-connect-connections-credentials'),
    ).toContain('device-credential-fixture');
  });

  it('survives a store re-instantiation with the same storage', () => {
    const adapter = memoryAdapter();

    const store1 = new ConnectionStore({ storage: adapter });
    const conn = store1.add('Persisted', 'http://persisted:3141');
    store1.setActive(conn.id);

    // Simulate page reload — new store instance, same storage
    const store2 = new ConnectionStore({ storage: adapter });
    expect(store2.getAll()).toHaveLength(1);
    expect(store2.getActive()?.url).toBe('http://persisted:3141');
  });
});

describe('ConnectionStore — injected connection', () => {
  const injected = {
    id: 'managed-loopback',
    name: 'Station on this device',
    url: 'http://127.0.0.1:3142',
    source: 'managed-loopback' as const,
  };

  it('prepends the injected connection into getAll() without persisting it', () => {
    const adapter = memoryAdapter();
    const store = new ConnectionStore({ storage: adapter });
    store.add('Saved', 'http://saved:3141');
    store.setInjectedConnection(injected);

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe('managed-loopback');
    expect(all[1].name).toBe('Saved');

    // The injected connection is NEVER serialized to storage.
    const persisted = adapter.get('station-connect-connections');
    expect(persisted).not.toBeNull();
    expect(persisted).not.toContain('managed-loopback');
    expect(persisted).not.toContain('127.0.0.1');
    const reloaded = new ConnectionStore({ storage: adapter });
    expect(reloaded.getAll()).toHaveLength(1);
    expect(reloaded.getAll()[0].name).toBe('Saved');
  });

  it('keeps mobile defaults for different Stations while preserving managed loopback rows', () => {
    const mobile = new ConnectionStore({ storage: memoryAdapter() });
    mobile.add('Paired Station', 'https://paired.example.test:8444');
    mobile.setInjectedConnection({
      id: 'mobile-default-nightly',
      name: 'Station Nightly',
      url: 'https://different.example.test:8444',
      source: 'mobile-default',
    });
    expect(mobile.getAll()).toHaveLength(2);

    const desktop = new ConnectionStore({ storage: memoryAdapter() });
    desktop.add('Saved loopback profile', 'http://127.0.0.1:3142');
    desktop.setInjectedConnection(injected);
    expect(desktop.getAll()).toHaveLength(2);
    expect(desktop.getAll()[0].id).toBe('managed-loopback');
  });

  it('tags the managed-loopback endpoint kind so health probing can skip it', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.setInjectedConnection(injected);
    const active = store.getActive();
    expect(active?.endpoints[0].kind).toBe('managed-loopback');
    expect(active?.credentialState).toBe('not-required');
  });

  it('resolves as active when no saved connection is explicitly active', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.add('Saved', 'http://saved:3141'); // auto-active as first add
    store.setInjectedConnection(injected);
    // A saved connection is explicitly active → it wins over the injected one.
    expect(store.getActive()?.name).toBe('Saved');
  });

  it('wins as active when no saved connection is active (desktop shape)', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.setInjectedConnection(injected);
    expect(store.getActive()?.id).toBe('managed-loopback');
    expect(store.getActive()?.url).toBe('http://127.0.0.1:3142');
  });

  it('is non-removable and non-editable through the persisted operations', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.setInjectedConnection(injected);
    store.remove('managed-loopback');
    store.update('managed-loopback', { url: 'http://evil:9999' });
    const active = store.getActive();
    expect(store.getAll().some((c) => c.id === 'managed-loopback')).toBe(true);
    expect(active?.url).toBe('http://127.0.0.1:3142');
  });

  it('updates the injected URL in place when the server restarts on a new port', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.setInjectedConnection(injected);
    store.setInjectedConnection({ ...injected, url: 'http://127.0.0.1:3175' });
    const all = store.getAll().filter((c) => c.id === 'managed-loopback');
    expect(all).toHaveLength(1);
    expect(store.getActive()?.url).toBe('http://127.0.0.1:3175');
  });

  it('clears the injected connection when passed null', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.setInjectedConnection(injected);
    expect(store.getAll()).toHaveLength(1);
    store.setInjectedConnection(null);
    expect(store.getAll()).toHaveLength(0);
    expect(store.getActive()).toBeNull();
  });

  it('notifies subscribers when the injected slot changes', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setInjectedConnection(injected);
    expect(listener).toHaveBeenCalledTimes(1);
    // Setting the byte-identical value again is a no-op (no extra notify).
    store.setInjectedConnection(injected);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  const notRunning = {
    id: 'managed-loopback',
    name: 'Station on this device',
    source: 'managed-loopback' as const,
    status: 'failed' as const,
  };

  it('lists a url-less (not-running) injected connection but never resolves it as active', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.setInjectedConnection(notRunning);
    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('managed-loopback');
    expect(all[0].injectedStatus).toBe('failed');
    expect(all[0].url).toBe('');
    // Nothing to talk to → not auto-selected as the active base.
    expect(store.getActive()).toBeNull();
  });

  it('keeps a paired remote active when the injected local server is not running', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const saved = store.add('Remote', 'https://remote:3141');
    store.setInjectedConnection(notRunning);
    // The local server is listed (first) but the remote stays the active base.
    expect(store.getAll().map((c) => c.id)).toEqual([
      'managed-loopback',
      saved.id,
    ]);
    expect(store.getActive()?.id).toBe(saved.id);
  });

  it('stays listed and becomes active when it transitions from not-running to running, and back', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.setInjectedConnection(notRunning);
    expect(store.getActive()).toBeNull();

    // running → gains a URL, becomes the active base.
    store.setInjectedConnection({ ...injected, status: 'running' });
    expect(store.getActive()?.id).toBe('managed-loopback');
    expect(store.getActive()?.url).toBe('http://127.0.0.1:3142');

    // running → not-running: still listed, no longer active (no reload).
    store.setInjectedConnection(notRunning);
    expect(store.getAll().some((c) => c.id === 'managed-loopback')).toBe(true);
    expect(store.getActive()).toBeNull();
  });

  it('re-notifies on a lifecycle-state change even while the URL stays empty', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setInjectedConnection({ ...notRunning, status: 'starting' });
    expect(listener).toHaveBeenCalledTimes(1);
    // Same id, same (empty) URL, different lifecycle state → must still notify.
    store.setInjectedConnection({ ...notRunning, status: 'failed' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getAll()[0].injectedStatus).toBe('failed');
  });

  it('never resolves a down injected connection as active even when an explicit active id names it', () => {
    // Directly seed the persisted active-id pointer at the injected id — a
    // state `setActive` won't produce today, guarding the active-resolution
    // logic on its own terms rather than relying on that cross-file invariant.
    const adapter = memoryAdapter();
    adapter.set('station-connect-connections-active', 'managed-loopback');
    const store = new ConnectionStore({ storage: adapter });
    store.setInjectedConnection(notRunning);
    // No usable base and no saved connection → nothing active.
    expect(store.getActive()).toBeNull();
  });

  it('falls through to a saved connection when the explicit active id names a down injected connection', () => {
    const adapter = memoryAdapter();
    const store = new ConnectionStore({ storage: adapter });
    const saved = store.add('Remote', 'https://remote:3141');
    // Point the active id at the down injected connection out-of-band.
    adapter.set('station-connect-connections-active', 'managed-loopback');
    store.setInjectedConnection(notRunning);
    expect(store.getActive()?.id).toBe(saved.id);
  });

  describe('setActive() on the injected connection (#1289)', () => {
    it('activates the injected connection even when a saved one is explicitly active', () => {
      const store = new ConnectionStore({ storage: memoryAdapter() });
      const saved = store.add('Saved', 'http://saved:3141');
      store.setActive(saved.id);
      store.setInjectedConnection(injected);
      // Sanity: the saved connection still wins per existing precedence.
      expect(store.getActive()?.id).toBe(saved.id);

      const listener = vi.fn();
      store.subscribe(listener);
      const result = store.setActive('managed-loopback');

      expect(result).toBe(true);
      expect(store.getActive()?.id).toBe('managed-loopback');
      expect(
        store.getAll().find((c) => c.id === 'managed-loopback'),
      ).toBeTruthy();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('setActive back to a persisted connection still works after activating the injected one', () => {
      const store = new ConnectionStore({ storage: memoryAdapter() });
      const saved = store.add('Saved', 'http://saved:3141');
      store.setInjectedConnection(injected);
      store.setActive('managed-loopback');
      expect(store.getActive()?.id).toBe('managed-loopback');

      const result = store.setActive(saved.id);

      expect(result).toBe(true);
      expect(store.getActive()?.id).toBe(saved.id);
    });

    it('setActive with a bogus id is a no-op that does not corrupt state', () => {
      const store = new ConnectionStore({ storage: memoryAdapter() });
      const saved = store.add('Saved', 'http://saved:3141');
      store.setInjectedConnection(injected);
      store.setActive(saved.id);

      const listener = vi.fn();
      store.subscribe(listener);
      const result = store.setActive('does-not-exist');

      expect(result).toBe(false);
      expect(store.getActive()?.id).toBe(saved.id);
      expect(store.getAll()).toHaveLength(2);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
