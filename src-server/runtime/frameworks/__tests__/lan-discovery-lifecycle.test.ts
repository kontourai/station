// @vitest-environment node
import type { ServerProviderDeps } from '@voltagent/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanDiscovery } from '../../../services/connections/lan-discovery.js';
import { DIRECT_LISTENER_LINK } from '../../bootstrap/supervisor-link.js';
import { stationHonoServer } from '../voltagent-hono-runtime.js';

const doubles = vi.hoisted(() => ({
  entries: [] as any[],
  listeners: [] as any[],
  failure: '',
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  networkInterfaces: () => ({
    en0: [{ internal: false, family: 'IPv4', address: '192.168.55.2' }],
  }),
}));
vi.mock('@homebridge/ciao', () => ({
  getResponder: (options: unknown) => {
    const responder = {
      shutdown: vi.fn(async () => {}),
      createService(config: any) {
        const listener = doubles.listeners.at(-1);
        expect(listener.listening).toBe(true);
        expect(config.port).toBe(listener.address().port);
        if (doubles.failure === 'create') throw new Error('create failed');
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const pending = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        const service = {
          advertise: vi.fn(() => pending),
          destroy: vi.fn(async () => {}),
          getFQDN: () => 'Nearby Station._station._tcp.local.',
        };
        doubles.entries.push({
          config,
          options,
          responder,
          service,
          resolve,
          reject,
        });
        return service;
      },
    };
    doubles.entries.push({ owner: responder });
    return responder;
  },
}));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  doubles.entries.length = 0;
  doubles.listeners.length = 0;
  doubles.failure = '';
});
function host(discovery: LanDiscovery, hostname = '0.0.0.0') {
  const provider = stationHonoServer(
    {
      port: 0,
      hostname,
      enableWebSocket: false,
      configureFullApp: ({ app }) => {
        app.get('/probe', (c) => c.text('ok'));
      },
    },
    () => ({
      ...DIRECT_LISTENER_LINK,
      async listen(name, server, address) {
        doubles.listeners.push(server);
        return DIRECT_LISTENER_LINK.listen(name, server, address);
      },
    }),
    discovery,
  )({} as ServerProviderDeps);
  cleanup.push(() => provider.stop());
  return provider;
}
describe('API host discovery lifecycle', () => {
  it('defaults off, publishes actual bound API port after completed announcement and withdraws live', async () => {
    const discovery = new LanDiscovery();
    const provider = host(discovery);
    await provider.start();
    expect(doubles.entries).toHaveLength(0);
    await discovery.configure({ lanDiscoveryEnabled: true });
    const entry = doubles.entries.at(-1);
    expect(entry.config).toMatchObject({
      type: 'station',
      restrictedAddresses: ['192.168.55.2'],
      disabledIpv6: true,
      txt: { v: '1', transport: 'http' },
    });
    expect(entry.options.interface).toEqual(['en0']);
    expect(discovery.snapshot().state).toBe('starting');
    entry.resolve();
    await Promise.resolve();
    expect(discovery.snapshot()).toMatchObject({
      state: 'published',
      port: entry.config.port,
      addresses: ['192.168.55.2'],
    });
    await discovery.configure({ lanDiscoveryEnabled: false });
    expect(entry.responder.shutdown).toHaveBeenCalledOnce();
    expect(discovery.snapshot().state).toBe('disabled');
    await discovery.configure({ lanDiscoveryEnabled: true });
    const late = doubles.entries.at(-1);
    await provider.stop();
    late.resolve();
    await Promise.resolve();
    expect(discovery.snapshot().state).toBe('unavailable');
    const replacement = host(discovery);
    await replacement.start();
    expect(doubles.entries.at(-1).config.port).toBe(
      doubles.listeners.at(-1).address().port,
    );
  });
  it('keeps loopback-only host running without publishing unrelated interfaces', async () => {
    const discovery = new LanDiscovery();
    await discovery.configure({ lanDiscoveryEnabled: true });
    const provider = host(discovery, '127.0.0.1');
    await provider.start();
    expect(provider.isRunning()).toBe(true);
    expect(doubles.entries).toHaveLength(0);
    expect(discovery.snapshot().state).toBe('loopback-only');
  });
  it('owns responder cleanup if service creation throws, without stopping the API host', async () => {
    doubles.failure = 'create';
    const discovery = new LanDiscovery();
    await discovery.configure({ lanDiscoveryEnabled: true });
    const provider = host(discovery);
    await provider.start();
    expect(provider.isRunning()).toBe(true);
    expect(doubles.entries[0].owner.shutdown).toHaveBeenCalledOnce();
    expect(discovery.snapshot().state).toBe('unavailable');
  });
  it('contains announcement failure and ignores its stale outcome after disable', async () => {
    const discovery = new LanDiscovery();
    await discovery.configure({ lanDiscoveryEnabled: true });
    const provider = host(discovery);
    await provider.start();
    const entry = doubles.entries.at(-1);
    await discovery.configure({ lanDiscoveryEnabled: false });
    entry.reject(new Error('send failed'));
    await Promise.resolve();
    expect(provider.isRunning()).toBe(true);
    expect(discovery.snapshot().state).toBe('disabled');
  });
});
