/**
 * #4519 round 1: `station start` under a managed policy that allows no
 * remote clients refuses a non-loopback `STATION_HOST`, which it would
 * otherwise replace with its own host for the server child without a word.
 * The real `start()` runs with the policy injected through the test file
 * override; the refusal happens before anything is spawned or written.
 * The accepted hosts are checked on the helper `start()` calls, since past
 * it `start()` would launch Station.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { start } from '../commands/lifecycle.js';
import { assertManagedInheritedStationHost } from '../commands/managed-remote-clients.js';

const makeTempDir = trackTempDirs();
const saved = {
  host: process.env.STATION_HOST,
  policy: process.env.STATION_MANAGED_POLICY_TEST_FILE,
};

afterEach(() => {
  for (const [key, value] of [
    ['STATION_HOST', saved.host],
    ['STATION_MANAGED_POLICY_TEST_FILE', saved.policy],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

function installPolicy(clients: string[]): void {
  const path = join(makeTempDir('station-start-policy-'), 'policy.json');
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      organization: 'Acme',
      limits: { clients },
    }),
  );
  process.env.STATION_MANAGED_POLICY_TEST_FILE = path;
}

describe('station start with STATION_HOST under the managed limit', () => {
  test('refuses a wildcard, LAN or name STATION_HOST with the managed sentence', async () => {
    installPolicy(['desktop', 'local-browser']);
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'station.local']) {
      process.env.STATION_HOST = host;
      await expect(start({})).rejects.toThrow(
        `Acme's policy manages remote access: only this computer can connect to Station. Contact your administrator for help. Station listens only on this computer; STATION_HOST=${host} is not supported.`,
      );
    }
  });

  test('a loopback STATION_HOST, none, or no limit is not refused', () => {
    const limit = {
      organization: 'Acme',
      supportUrl: null,
      lockedSettings: [],
      limits: { clients: ['desktop', 'local-browser'] },
    } as never;
    for (const host of ['127.0.0.1', '127.8.0.1', 'localhost', '::1', ''])
      expect(() =>
        assertManagedInheritedStationHost(limit, { STATION_HOST: host }),
      ).not.toThrow();
    expect(() => assertManagedInheritedStationHost(limit, {})).not.toThrow();
    expect(() =>
      assertManagedInheritedStationHost(null, { STATION_HOST: '0.0.0.0' }),
    ).not.toThrow();
    // The same helper refuses what start() refuses above.
    expect(() =>
      assertManagedInheritedStationHost(limit, { STATION_HOST: '0.0.0.0' }),
    ).toThrow('STATION_HOST=0.0.0.0 is not supported');
  });
});
