/**
 * #1970/#1973 device ports reach the browser's REAL per-connection policy.
 * `browser-device-hub-listeners.test.ts` proves `service.listeners` carries
 * them; this proves what `createBrowserService` actually hands on — the
 * egress policy the host resolver gives every Chromium host, and the
 * registry's `isStationAddress` — read that same extended set, live, and
 * never the base set without device ports. Only the Chromium host and the
 * session registry are replaced, by stand-ins that record what they were
 * constructed with; the resolver and the policy are the service's own.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type BrowserHostResolver,
  LOCAL_BROWSER_HOST_ID,
} from '../browser-host.js';
import { ChromiumAcquisition } from '../chromium-acquisition.js';
import { decideEgress, type EgressPolicy } from '../egress-policy.js';

const built = vi.hoisted(() => ({
  hosts: [] as { egressPolicy: unknown }[],
  registries: [] as {
    isStationAddress: (url: string) => boolean;
    hostResolver: unknown;
  }[],
}));

vi.mock('../hosts/chromium-server-host.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../hosts/chromium-server-host.js')>();
  return {
    ...actual,
    ChromiumServerHost: class {
      constructor(options: { egressPolicy: unknown }) {
        built.hosts.push(options);
      }
    },
  };
});

vi.mock('../browser-session-registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../browser-session-registry.js')>();
  return {
    ...actual,
    BrowserSessionRegistry: class {
      constructor(options: (typeof built.registries)[number]) {
        built.registries.push(options);
      }
      async shutdown() {}
    },
  };
});

import { createBrowserService } from '../browser-service.js';

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  built.hosts.splice(0);
  built.registries.splice(0);
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('createBrowserService: device ports in the resolver’s egress policy', () => {
  test('every host the resolver builds denies the live device ports, per connection, and the registry refuses them as Station addresses', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-browser-resolver-'));
    homes.push(home);
    vi.spyOn(
      ChromiumAcquisition.prototype,
      'resolveExecutable',
    ).mockReturnValue('/nonexistent/chromium');
    let devicePorts: number[] = [51_001];
    const service = createBrowserService({
      stationHome: home,
      serverPort: 4100,
      configuredOrigins: [],
      extraListenerPorts: () => devicePorts,
    });
    try {
      const registry = built.registries[0]!;
      const resolver = registry.hostResolver as BrowserHostResolver;
      for (const principalKey of ['operator', 'principal:admin-1']) {
        await resolver.resolve({
          projectId: 'p-1',
          principalKey,
          hostId: LOCAL_BROWSER_HOST_ID,
        });
      }
      expect(built.hosts).toHaveLength(2);
      for (const host of built.hosts) {
        const policy = host.egressPolicy as EgressPolicy;
        expect(decideEgress('127.0.0.1', 51_001, policy)).toBe(
          'station-listener',
        );
      }
      expect(registry.isStationAddress('http://127.0.0.1:51001/')).toBe(true);

      // Read per connection: a hub restarted on a new port is denied by the
      // hosts ALREADY built, with no rebuild.
      devicePorts = [52_002];
      for (const host of built.hosts) {
        const policy = host.egressPolicy as EgressPolicy;
        expect(decideEgress('127.0.0.1', 52_002, policy)).toBe(
          'station-listener',
        );
      }
      expect(registry.isStationAddress('http://127.0.0.1:52002/')).toBe(true);
    } finally {
      await service.shutdown();
    }
  });
});
