/**
 * #1970 hub lockdown: the managed device hub and its serve-sim stream
 * helpers are Station listeners. Their ports, read LIVE from the device
 * toolchain, join the host browser's deny set and can never be registered
 * as a Project's local target.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  LocalTargetError,
  LocalTargetStore,
} from '../browser-local-targets.js';
import {
  createBrowserService,
  egressPolicyFor,
  withExtraListenerPorts,
} from '../browser-service.js';
import { decideEgress } from '../egress-policy.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('device hub ports as Station listeners', () => {
  test('extra ports are unioned into the listener set', () => {
    expect(
      withExtraListenerPorts(
        { ports: [4100, 4101], hostnames: ['x'] },
        [3100, 4100, 0, 70_000],
      ),
    ).toEqual({ ports: [3100, 4100, 4101], hostnames: ['x'] });
  });

  test('the provider is read live: a restarted hub on a new port is denied at once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-browser-hub-ports-'));
    homes.push(home);
    let hubPorts: number[] = [51_001, 3100];
    const service = createBrowserService({
      stationHome: home,
      serverPort: 4100,
      configuredOrigins: [],
      extraListenerPorts: () => hubPorts,
    });
    try {
      expect(service.listeners().ports).toEqual(
        expect.arrayContaining([51_001, 3100, 4100]),
      );
      hubPorts = [52_002];
      expect(service.listeners().ports).toContain(52_002);
      expect(service.listeners().ports).not.toContain(51_001);
      // Every profile, operator included, is refused the hub's port.
      const policy = egressPolicyFor(
        { projectId: 'p-1', reach: 'operator' },
        service.listeners,
        service.localTargets,
      );
      expect(decideEgress('127.0.0.1', 52_002, policy)).toBe(
        'station-listener',
      );
      expect(decideEgress('127.0.0.1', 5173, policy)).toBeUndefined();
      // And the operator cannot share it with a Project as a local target.
      const targets = new LocalTargetStore(home);
      expect(() =>
        targets.add(
          'p-1',
          { host: '127.0.0.1', port: 52_002, label: 'hub' },
          'operator',
          service.listeners(),
        ),
      ).toThrow(LocalTargetError);
    } finally {
      await service.shutdown();
    }
  });
});
