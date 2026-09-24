/**
 * SSH device hosts over REAL ssh (#1973), against this machine's own sshd.
 *
 * Runs only where `ssh localhost` already works non-interactively with key
 * auth and a known host key (BatchMode, StrictHostKeyChecking=yes — the
 * exact policy Station uses). That is rarely true on a developer machine
 * and never on a CI runner, so every case otherwise reports an explicit
 * skip naming why. This test never edits ssh config, known_hosts or
 * authorized_keys.
 *
 * Part 1 (key auth only): "Test connection" over real ssh — ssh, host key
 * and node steps pass. The probe writes nothing on the host.
 *
 * Part 2 (also needs `STATION_DEVICE_HUB_TEST_HOME`, a Station home that
 * already holds a completed managed install of the pinned hub): sends that
 * verified tree to the host (this machine's `~/.station-device-host`),
 * starts the REAL hub there under the guard, proves a direct request
 * without the secret is refused while the forwarded connection works, and
 * stops it. Installs nothing locally and never downloads.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { DeviceToolchain } from '../../toolchain/device-toolchain.js';
import { DeviceHostRegistry } from '../device-host-registry.js';
import { DeviceHostStore } from '../device-host-store.js';
import {
  buildSshDeviceCommandArgs,
  parseSshDeviceTarget,
  sshDeviceEnvironment,
} from '../ssh-device-target.js';

const TARGET = 'localhost';

function sshReachable(): { ok: boolean; why: string } {
  if (process.platform === 'win32')
    return { ok: false, why: 'Windows runner: no local sshd' };
  const args = buildSshDeviceCommandArgs(parseSshDeviceTarget(TARGET));
  // The same policy, but a trivial remote command instead of the loader.
  const end = args.indexOf('--');
  const probe = spawnSync('ssh', [...args.slice(0, end + 2), 'true'], {
    env: sshDeviceEnvironment(),
    timeout: 15_000,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  if (probe.error)
    return { ok: false, why: `no ssh client (${probe.error.message})` };
  if (probe.status !== 0)
    return {
      ok: false,
      why: `ssh ${TARGET} is not available with key auth and a known host key`,
    };
  return { ok: true, why: '' };
}

const reach = sshReachable();
const hubHome = process.env.STATION_DEVICE_HUB_TEST_HOME;
const localTools = hubHome
  ? new DeviceToolchain({
      stationHome: hubHome,
      installer: { run: async () => undefined },
    })
  : undefined;
const hubInstalled =
  localTools?.installedEntry('expo-device-hub') !== undefined;

const home = mkdtempSync(join(tmpdir(), 'station-ssh-real-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function registry() {
  return new DeviceHostRegistry({
    stationHome: home,
    store: new DeviceHostStore(home),
    localHub: () =>
      hubInstalled && localTools
        ? {
            installDir: localTools.installDir('expo-device-hub'),
            version: localTools.pin('expo-device-hub').version,
          }
        : undefined,
  });
}

describe('SSH device host over real ssh (part 1: Test connection)', () => {
  test.skipIf(!reach.ok)(
    `Test connection passes ssh, host key and node (${reach.ok ? TARGET : `skipped: ${reach.why}`})`,
    async () => {
      const r = registry();
      const host = r.add({ label: 'This machine', sshTarget: TARGET });
      const result = await r.check(host.hostId);
      expect(result.steps.slice(0, 3)).toEqual([
        { id: 'ssh', state: 'pass' },
        { id: 'host-key', state: 'pass' },
        expect.objectContaining({ id: 'node' }),
      ]);
      await r.remove(host.hostId);
    },
    60_000,
  );
});

describe('SSH device host over real ssh (part 2: the real hub)', () => {
  const why = !reach.ok
    ? reach.why
    : !hubInstalled
      ? 'STATION_DEVICE_HUB_TEST_HOME does not name a home with a completed hub install'
      : '';
  test.skipIf(why !== '')(
    `installs, starts the guarded hub through a forward, and stops it (${why ? `skipped: ${why}` : TARGET})`,
    async () => {
      const r = registry();
      const host = r.add({ label: 'This machine', sshTarget: TARGET });
      await r.setHubEnabled(host.hostId, { enabled: true, consent: true });
      await r.install(host.hostId);
      expect(r.view(host.hostId)?.install).toEqual({ state: 'installed' });
      const connected = await r.endpoint(host.hostId).connect();
      expect(connected.ok).toBe(true);
      if (!connected.ok) return;
      const ready = await connected.connection.request('GET', '/api/devices');
      expect(ready.status).toBe(200);
      await ready.body?.cancel();
      const ports = r.listeningPorts();
      expect(ports).toHaveLength(2);
      // The host's own hub port, reached directly without the secret: 403.
      const hubPort = ports.find(
        (port) => !connected.connection.baseUrl.endsWith(`:${port}`),
      )!;
      const direct = await fetch(`http://127.0.0.1:${hubPort}/api/devices`);
      expect(direct.status).toBe(403);
      await r.remove(host.hostId);
      expect(r.listeningPorts()).toEqual([]);
    },
    300_000,
  );
});
