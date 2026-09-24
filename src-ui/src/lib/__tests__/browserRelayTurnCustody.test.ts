import { describe, expect, it } from 'vitest';
import {
  BrowserRelayTurnCustody,
  type BrowserRelayTurnStorage,
  parseBrowserRelayTurnConfiguration,
} from '../browserRelayTurnCustody';

const route = {
  brokerOrigin: 'https://broker.example.test',
  scope: {
    stationId: '11111111-1111-4111-8111-111111111111',
    enrollmentId: '22222222-2222-4222-8222-222222222222',
    routingGeneration: 1,
    browserOrigin: 'https://client.example.test',
  },
};

function identity(
  overrides: {
    applicationOrigin?: string;
    browserOrigin?: string;
    brokerOrigin?: string;
    stationId?: string;
    enrollmentId?: string;
    routingGeneration?: number;
    scopeBrowserOrigin?: string;
  } = {},
) {
  return {
    applicationOrigin:
      overrides.applicationOrigin ?? 'https://station.example.test',
    browserOrigin: overrides.browserOrigin ?? route.scope.browserOrigin,
    route: {
      brokerOrigin: overrides.brokerOrigin ?? route.brokerOrigin,
      scope: {
        ...route.scope,
        stationId: overrides.stationId ?? route.scope.stationId,
        enrollmentId: overrides.enrollmentId ?? route.scope.enrollmentId,
        routingGeneration:
          overrides.routingGeneration ?? route.scope.routingGeneration,
        browserOrigin:
          overrides.scopeBrowserOrigin ?? route.scope.browserOrigin,
      },
    },
  };
}

function memoryStorage(): BrowserRelayTurnStorage & {
  records: Map<string, unknown>;
} {
  const records = new Map<string, unknown>();
  return {
    records,
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => {
      records.set(key, structuredClone(value));
    },
    delete: async (key) => {
      records.delete(key);
    },
  };
}

describe('browser relay TURN custody', () => {
  it('persists a versioned secret separately and restores only the exact route', async () => {
    const storage = memoryStorage();
    const firstIdentity = identity();
    const first = new BrowserRelayTurnCustody(firstIdentity, storage);
    const other = new BrowserRelayTurnCustody(
      identity({ routingGeneration: 2 }),
      storage,
    );
    const configuration = {
      schemaVersion: 1,
      url: 'turn:127.0.0.1:3478?transport=tcp',
      username: 'local-turn-user',
      credential: 'local-turn-secret',
    };

    await first.save(configuration);

    expect(await first.restore()).toEqual({
      urls: configuration.url,
      username: configuration.username,
      credential: configuration.credential,
    });
    expect(await other.restore()).toBeNull();
    expect(storage.records.size).toBe(1);
    const [key, record] = [...storage.records.entries()][0]!;
    expect(key).not.toContain(configuration.credential);
    expect(record).toMatchObject({
      schemaVersion: 1,
      identityKey: key,
      url: configuration.url,
      username: configuration.username,
      credential: configuration.credential,
    });

    await other.forget();
    expect(await first.restore()).not.toBeNull();
    await first.forget();
    expect(await first.restore()).toBeNull();
  });

  it('binds custody to broker, application, Station, enrollment, generation and browser origin', async () => {
    const storage = memoryStorage();
    const base = new BrowserRelayTurnCustody(identity(), storage);
    await base.save({
      schemaVersion: 1,
      url: 'turns:turn.example.test:5349?transport=tcp',
      username: 'user',
      credential: 'credential',
    });

    for (const changed of [
      identity({ applicationOrigin: 'https://other.example.test' }),
      identity({ brokerOrigin: 'https://other-broker.example.test' }),
      identity({ stationId: '33333333-3333-4333-8333-333333333333' }),
      identity({ enrollmentId: '44444444-4444-4444-8444-444444444444' }),
      identity({ routingGeneration: 2 }),
      identity({
        browserOrigin: 'https://other-client.example.test',
        scopeBrowserOrigin: 'https://other-client.example.test',
      }),
    ])
      expect(
        await new BrowserRelayTurnCustody(changed, storage).restore(),
      ).toBeNull();

    await expect(
      Promise.resolve().then(
        () =>
          new BrowserRelayTurnCustody(
            identity({ browserOrigin: 'https://other-client.example.test' }),
            storage,
          ),
      ),
    ).rejects.toThrow('different browser origin');
  });

  it.each([
    [
      {
        schemaVersion: 2,
        url: 'turn:turn.example.test',
        username: 'u',
        credential: 'c',
      },
    ],
    [
      {
        schemaVersion: 1,
        url: 'stun:turn.example.test',
        username: 'u',
        credential: 'c',
      },
    ],
    [
      {
        schemaVersion: 1,
        url: 'turn:user@turn.example.test',
        username: 'u',
        credential: 'c',
      },
    ],
    [
      {
        schemaVersion: 1,
        url: 'turn:turn.example.test:0',
        username: 'u',
        credential: 'c',
      },
    ],
    [
      {
        schemaVersion: 1,
        url: 'turn:turn.example.test?transport=icmp',
        username: 'u',
        credential: 'c',
      },
    ],
    [
      {
        schemaVersion: 1,
        url: 'turn:turn.example.test',
        username: 'u',
        credential: 'c',
        extra: true,
      },
    ],
  ])('rejects unsupported or malformed versioned input %#', (value) => {
    expect(() => parseBrowserRelayTurnConfiguration(value)).toThrow();
  });

  it('does not enable partial TURN credentials', () => {
    expect(() =>
      parseBrowserRelayTurnConfiguration({
        schemaVersion: 1,
        url: 'turn:turn.example.test',
        username: 'user',
        credential: '',
      }),
    ).toThrow('TURN credential');
  });

  it('fails closed when a stored record is malformed or belongs to another binding', async () => {
    const storage = memoryStorage();
    const custody = new BrowserRelayTurnCustody(identity(), storage);
    await custody.save({
      schemaVersion: 1,
      url: 'turn:turn.example.test',
      username: 'user',
      credential: 'credential',
    });
    const [key] = [...storage.records.keys()];
    storage.records.set(key!, {
      schemaVersion: 2,
      identityKey: key,
      url: 'turn:turn.example.test',
      username: 'user',
      credential: 'credential',
    });

    await expect(custody.restore()).rejects.toThrow(
      'Browser TURN credential storage is unavailable',
    );
  });
});
