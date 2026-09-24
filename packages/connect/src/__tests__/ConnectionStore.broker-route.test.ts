import { describe, expect, it } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
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

const route = {
  brokerOrigin: 'https://broker.example.test',
  scope: {
    stationId: 'station_00000001',
    enrollmentId: 'enroll_00000001',
    routingGeneration: 3,
    browserOrigin: 'https://client.example.test',
  },
};

describe('ConnectionStore broker-only routes', () => {
  it('persists secret-free route metadata without creating a direct endpoint or selecting it', () => {
    const storage = memoryAdapter();
    const store = new ConnectionStore({ storage });
    const direct = store.add('Direct', 'https://station.example.test');
    const broker = store.addBrokerRoute({
      name: 'Station over broker',
      applicationOrigin: 'https://station.example.test',
      brokerRoute: route,
    });

    expect(store.getActive()?.id).toBe(direct.id);
    expect(broker.brokerRoute).toEqual(route);
    expect(broker.url).toBe('https://station.example.test');
    expect(broker.endpoints).toEqual([]);
    expect(broker.accessMethods).toEqual([]);
    expect(broker.credentialState).toBe('required');
    expect(JSON.stringify(broker)).not.toMatch(/secret|credential-value/i);
    expect(store.setActive(broker.id)).toBe(false);
    expect(store.getActive()?.id).toBe(direct.id);

    const reloaded = new ConnectionStore({ storage });
    expect(
      reloaded.getAll().find((item) => item.id === broker.id)?.brokerRoute,
    ).toEqual(route);
    expect(reloaded.getActive()?.brokerRoute).toBeUndefined();
  });

  it('refuses to reuse one invitation scope for another Station application origin', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.addBrokerRoute({
      name: 'Station A',
      applicationOrigin: 'https://station-a.example.test',
      brokerRoute: route,
    });
    expect(() =>
      store.addBrokerRoute({
        name: 'Station B',
        applicationOrigin: 'https://station-b.example.test',
        brokerRoute: route,
      }),
    ).toThrow(/different Station application origin/);
  });

  it('persists broker reachability without creating a direct endpoint or inferring Device auth', () => {
    const storage = memoryAdapter();
    const store = new ConnectionStore({ storage });
    const connection = store.addBrokerRoute({
      name: 'Station over broker',
      applicationOrigin: 'https://station.example.test',
      brokerRoute: route,
    });

    store.recordBrokerRouteSuccess(connection.id, 1234, 'boot-broker');

    const reloaded = new ConnectionStore({ storage });
    const saved = reloaded.getAll()[0]!;
    expect(saved.endpoints).toEqual([]);
    expect(saved.accessMethods).toEqual([]);
    expect(saved.lastConnected).toBe(1234);
    expect(saved.lastSuccessAt).toBe(1234);
    expect(saved.lastBootId).toBe('boot-broker');
    expect(saved.credentialState).toBe('required');
  });
});
