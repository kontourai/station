/**
 * #4519 round 1, finding 4: every listener Station opens after startup is
 * admitted under the managed limit (literal loopback bind, no Tailscale
 * Serve route to its port). These drive the real listeners: the isolated
 * repair relay and the browser egress proxy bind actual sockets, and the
 * checks are made against what is actually listening.
 */
import { networkInterfaces } from 'node:os';
import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy';
import type { LoadedManagedPolicy } from '@kontourai/station-shared/managed-policy';
import { afterEach, describe, expect, test } from 'vitest';
import { authorityRelay } from '../../services/automation/repair-worker.mjs';
import { BrowserEgressProxy } from '../../services/browser/browser-egress-proxy.js';
import { deriveStationListeners } from '../../services/browser/station-listeners.js';
import {
  createManagedListenerAdmission,
  installManagedListenerAdmission,
  MANAGED_REPAIR_RELAY_REFUSED,
  managedRepairRelayHost,
} from '../managed-network-exposure.js';

function policy(limits: ManagedPolicySummary['limits']): LoadedManagedPolicy {
  return {
    source: { kind: 'test-override', location: '/tmp/policy.json' },
    digest: `sha256:${'a'.repeat(64)}`,
    document: { schemaVersion: 1, organization: 'Acme', limits },
    summary: {
      organization: 'Acme',
      supportUrl: null,
      lockedSettings: [],
      limits,
    },
  } as LoadedManagedPolicy;
}

const local = policy({ clients: ['desktop', 'local-browser'] });

/** A Tailscale stand-in whose Serve forwards to `port` (or nothing). */
function serving(port?: number) {
  return async (args: readonly string[]) =>
    args[0] === 'serve'
      ? {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify(
            port === undefined
              ? {}
              : {
                  Web: {
                    'n.example.ts.net:443': {
                      Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } },
                    },
                  },
                },
          ),
        }
      : { exitCode: 0, stderr: '', stdout: '{"BackendState":"Running"}' };
}

const lan = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);

async function reachable(host: string, port: number): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/`, {
      method: 'POST',
      signal: AbortSignal.timeout(3_000),
    });
    return true;
  } catch {
    return false;
  }
}

const backend = {
  baseUrl: 'http://127.0.0.1:9',
  capability: 'c',
  model: 'm',
};

afterEach(() => installManagedListenerAdmission(undefined));

describe('the isolated repair relay', () => {
  test('without the limit it binds every interface; under it, loopback off Linux and refused on Linux', () => {
    expect(managedRepairRelayHost(undefined)).toBe('0.0.0.0');
    const admission = createManagedListenerAdmission(local, serving());
    expect(managedRepairRelayHost(admission, 'darwin')).toBe('127.0.0.1');
    expect(managedRepairRelayHost(admission, 'win32')).toBe('127.0.0.1');
    expect(() => managedRepairRelayHost(admission, 'linux')).toThrow(
      MANAGED_REPAIR_RELAY_REFUSED,
    );
  });

  test('under the limit the real relay answers on loopback only', async () => {
    const admission = createManagedListenerAdmission(local, serving());
    const host = managedRepairRelayHost(admission, 'darwin');
    const relay = await authorityRelay(
      backend,
      async () => {},
      new AbortController().signal,
      {
        host,
        admit: (port: number) =>
          admission.admit({ name: 'repair relay', host, port }),
      },
    );
    try {
      const port = Number(new URL(relay.baseUrl).port);
      expect(await reachable('127.0.0.1', port)).toBe(true);
      if (lan) expect(await reachable(lan.address, port)).toBe(false);
    } finally {
      await relay.close();
    }
  });

  test('a Serve route to the relay port refuses it and closes the listener', async () => {
    let bound: number | undefined;
    const admission = createManagedListenerAdmission(local, async (args) =>
      serving(bound)(args),
    );
    await expect(
      authorityRelay(backend, async () => {}, new AbortController().signal, {
        host: '127.0.0.1',
        admit: (port: number) => {
          bound = port;
          return admission.admit({
            name: 'repair relay',
            host: '127.0.0.1',
            port,
          });
        },
      }),
    ).rejects.toThrow(/Tailscale Serve forwards port \d+ to it/);
    expect(bound).toBeDefined();
    expect(await reachable('127.0.0.1', bound as number)).toBe(false);
  });
});

describe('listeners admitted through the installed admission', () => {
  test('the browser egress proxy starts when Serve forwards elsewhere, and is refused and closed when Serve forwards to its port', async () => {
    const proxyFor = () =>
      new BrowserEgressProxy({
        policy: {
          listeners: () =>
            deriveStationListeners({ serverPort: 1, configuredOrigins: [] }),
          interfaceAddresses: () => [],
          reach: { kind: 'operator' },
        },
      });
    installManagedListenerAdmission(
      createManagedListenerAdmission(local, serving(9)),
    );
    const started = proxyFor();
    expect(await started.start()).toBeGreaterThan(0);
    await started.close();

    // Serve forwards to whatever port the proxy binds.
    let bound: number | undefined;
    installManagedListenerAdmission({
      localClientsOnly: true,
      admit: async (listener) => {
        bound = listener.port;
        await createManagedListenerAdmission(
          local,
          serving(listener.port),
        ).admit(listener);
      },
    });
    await expect(proxyFor().start()).rejects.toThrow(
      /Tailscale Serve forwards port \d+ to it/,
    );
    expect(bound).toBeDefined();
    expect(await reachable('127.0.0.1', bound as number)).toBe(false);
  });

  test('a non-loopback host is refused before any Serve check', async () => {
    let asked = false;
    const admission = createManagedListenerAdmission(local, async (args) => {
      asked = true;
      return serving()(args);
    });
    await expect(
      admission.admit({ name: 'test', host: '0.0.0.0', port: 1 }),
    ).rejects.toThrow('its test listener would bind "0.0.0.0"');
    await expect(
      admission.admit({ name: 'test', host: 'localhost', port: 1 }),
    ).rejects.toThrow('would bind "localhost"');
    expect(asked).toBe(false);
    // Without the limit nothing is checked.
    await createManagedListenerAdmission(null, async () => {
      throw new Error('asked');
    }).admit({ name: 'x', host: '0.0.0.0', port: 1 });
  });
});
