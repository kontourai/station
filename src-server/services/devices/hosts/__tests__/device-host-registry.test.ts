/**
 * SSH device hosts, composed (#1973): the store's validation, the
 * connection test's steps, the install that sends Station's verified tree,
 * the on-demand endpoint (consent first), the per-host AVD lookup, and the
 * ports that join the host browser's Station-listener deny set.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createBrowserService,
  egressPolicyFor,
} from '../../../browser/browser-service.js';
import { decideEgress } from '../../../browser/egress-policy.js';
import { DeviceHostBusyError, DeviceShareStore } from '../../device-shares.js';
import {
  DeviceHostError,
  DeviceHostRegistry,
} from '../device-host-registry.js';
import { DeviceHostStore, DeviceHostStoreError } from '../device-host-store.js';
import type { SshDeviceHub, SshDeviceHubOptions } from '../ssh-device-hub.js';
import { FakeSsh } from './fake-ssh.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A tiny verified-looking local install: node_modules only matters. */
function localInstall(): string {
  const dir = tempDir('station-local-hub-');
  const file = join(
    dir,
    'node_modules',
    'expo-device-hub',
    'dist',
    'server',
    'cli.mjs',
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'console.log("hub")\n');
  writeFileSync(
    join(dir, 'node_modules', 'expo-device-hub', 'package.json'),
    '{}\n',
  );
  return dir;
}

function setup(
  options: { installed?: boolean; respond?: (child: FakeSsh) => void } = {},
) {
  const home = tempDir('station-device-hosts-');
  const shares = new DeviceShareStore(home);
  const install = options.installed === false ? undefined : localInstall();
  const spawned: FakeSsh[] = [];
  const hubOptions: SshDeviceHubOptions[] = [];
  const registry = new DeviceHostRegistry({
    stationHome: home,
    store: new DeviceHostStore(home),
    localHub: () =>
      install ? { installDir: install, version: '0.10.1' } : undefined,
    dropShares: (hostId) => void shares.removeHost(hostId),
    spawn: (args) => {
      const child = new FakeSsh(args);
      spawned.push(child);
      // Answer once the header (and any payload) has been written.
      child.stdin.on('finish', () => options.respond?.(child));
      return child;
    },
    createHub: (hubOpts) => {
      hubOptions.push(hubOpts);
      // A stand-in hub with fixed live ports.
      let ports: number[] = [];
      return {
        hostId: hubOpts.hostId,
        state: () => ({ state: 'stopped' as const }),
        listeningPorts: () => ports,
        ensureStarted: async () => {
          ports = [41_500, 50_500];
          throw new Error('not in this test');
        },
        stop: async () => {
          ports = [];
        },
        connection: () => undefined,
      } as unknown as SshDeviceHub;
    },
  });
  return { home, install, registry, spawned, hubOptions, shares };
}

const reply = (child: FakeSsh, event: Record<string, unknown>, code = 0) => {
  child.stdout.write(`${JSON.stringify(event)}\n`);
  child.exit(code);
};

describe('the device host store', () => {
  test('adds, edits and removes hosts; ids are minted, targets strictly parsed', () => {
    const home = tempDir('station-device-hosts-');
    const store = new DeviceHostStore(home);
    const host = store.add({
      label: ' Mac mini ',
      sshTarget: 'brian@mac-mini',
    });
    expect(host).toMatchObject({
      label: 'Mac mini',
      sshTarget: 'brian@mac-mini',
      hubEnabled: false,
    });
    expect(host.hostId).toMatch(/^ssh-[0-9a-f]{12}$/);
    expect(new DeviceHostStore(home).list()).toEqual([host]);
    expect(() =>
      store.add({ label: 'Dup', sshTarget: 'brian@mac-mini' }),
    ).toThrow(DeviceHostStoreError);
    for (const sshTarget of ['-oProxyCommand=sh', 'a b', 'host;id', '', 7])
      expect(() => store.add({ label: 'x', sshTarget })).toThrow(
        DeviceHostStoreError,
      );
    for (const label of [
      '',
      ' ',
      'x\u0007',
      'x'.repeat(81),
      3,
      'Mac\u202Eini',
      'a\u200Db',
    ])
      expect(() => store.add({ label, sshTarget: 'other' })).toThrow(
        DeviceHostStoreError,
      );
    store.remove(host.hostId);
    expect(store.list()).toEqual([]);
    expect(() => store.remove(host.hostId)).toThrow(DeviceHostStoreError);
  });

  test('a new target withdraws the hub consent given for the old machine', () => {
    const store = new DeviceHostStore(tempDir('station-device-hosts-'));
    const host = store.add({ label: 'Box', sshTarget: 'box' });
    store.setHubEnabled(host.hostId, true);
    expect(store.update(host.hostId, { label: 'Box 2' }).hubEnabled).toBe(true);
    expect(store.update(host.hostId, { sshTarget: 'box2' }).hubEnabled).toBe(
      false,
    );
  });

  test('a hand-edited file cannot smuggle an option-shaped target or a bad id in', () => {
    const home = tempDir('station-device-hosts-');
    mkdirSync(join(home, 'devices'), { recursive: true });
    const base = {
      label: 'x',
      hubEnabled: true,
      createdAt: 'a',
      updatedAt: 'b',
    };
    writeFileSync(
      join(home, 'devices', 'hosts.json'),
      JSON.stringify({
        version: 1,
        hosts: [
          {
            ...base,
            hostId: 'ssh-000000000001',
            sshTarget: '-oProxyCommand=touch /tmp/x',
          },
          { ...base, hostId: 'local', sshTarget: 'box' },
          { ...base, hostId: 'ssh-000000000002', sshTarget: 'good-box' },
        ],
      }),
    );
    expect(new DeviceHostStore(home).list().map((host) => host.hostId)).toEqual(
      ['ssh-000000000002'],
    );
  });
});

describe('Test connection', () => {
  test('a reachable host: every step, from ssh to the hub', async () => {
    const s = setup({
      respond: (child) =>
        reply(child, {
          event: 'probe',
          node: '24.1.0',
          nodeOk: true,
          ios: true,
          android: false,
          hubInstalled: true,
          hubRunning: false,
        }),
    });
    const host = s.registry.add({ label: 'Mac', sshTarget: 'brian@mac-mini' });
    const result = await s.registry.check(host.hostId);
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => [step.id, step.state])).toEqual([
      ['ssh', 'pass'],
      ['host-key', 'pass'],
      ['node', 'pass'],
      ['ios', 'pass'],
      ['android', 'warn'],
      ['hub-installed', 'pass'],
      ['hub-running', 'warn'],
    ]);
    // The probe carried this Station's owner key and the verified digest.
    const params = s.spawned[0]!.params();
    expect(params.mode).toBe('probe');
    expect(params.owner).toBe(s.registry.ownerKey(host.hostId));
    expect(params.digest).toMatch(/^[0-9a-f]{64}$/);
    // …and ssh reached the operator's target, strictly.
    expect(s.spawned[0]!.args).toContain('StrictHostKeyChecking=yes');
    expect(
      s.spawned[0]!.args.slice(
        s.spawned[0]!.args.indexOf('--'),
        s.spawned[0]!.args.indexOf('--') + 2,
      ),
    ).toEqual(['--', 'mac-mini']);
  });

  test('an unknown host key stops at the host-key step, typed', async () => {
    const s = setup({
      respond: (child) =>
        child.exit(
          255,
          'No ED25519 host key is known for mac-mini and you have requested strict checking.\r\nHost key verification failed.\r\n',
        ),
    });
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    const result = await s.registry.check(host.hostId);
    expect(result).toMatchObject({ ok: false, failure: 'host-key-unverified' });
    expect(result.steps.map((step) => [step.id, step.state])).toEqual([
      ['ssh', 'pass'],
      ['host-key', 'fail'],
      ['node', 'skipped'],
      ['ios', 'skipped'],
      ['android', 'skipped'],
      ['hub-installed', 'skipped'],
      ['hub-running', 'skipped'],
    ]);
  });

  test('a refused key fails the ssh step; no node fails the node step', async () => {
    const auth = setup({
      respond: (child) =>
        child.exit(255, 'brian@mac-mini: Permission denied (publickey).\r\n'),
    });
    const a = auth.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    const refused = await auth.registry.check(a.hostId);
    expect(refused.failure).toBe('auth-failed');
    expect(refused.steps.slice(0, 2).map((step) => step.state)).toEqual([
      'fail',
      'pass',
    ]);
    const node = setup({
      respond: (child) => child.exit(97, 'STATION_DEVICE_HOST_NODE_MISSING\n'),
    });
    const n = node.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    const missing = await node.registry.check(n.hostId);
    expect(missing.failure).toBe('node-missing');
    expect(missing.steps.find((step) => step.id === 'node')?.state).toBe(
      'fail',
    );
  });
});

describe('enabling and installing the hub on a host', () => {
  test('consent is the literal true; without it nothing is enabled or sent', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    await expect(
      s.registry.setHubEnabled(host.hostId, { enabled: true, consent: 'yes' }),
    ).rejects.toBeInstanceOf(DeviceHostError);
    expect(s.registry.view(host.hostId)?.hubEnabled).toBe(false);
    expect(s.spawned).toEqual([]);
  });

  test('the install sends exactly Station’s verified tree, file by file, with its manifest', async () => {
    const s = setup({
      respond: (child) => reply(child, { event: 'installed', already: false }),
    });
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    await s.registry.setHubEnabled(host.hostId, {
      enabled: true,
      consent: true,
    });
    await s.registry.install(host.hostId);
    expect(s.registry.view(host.hostId)?.install).toEqual({
      state: 'installed',
    });
    const child = s.spawned[0]!;
    const params = child.params() as {
      mode: string;
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    expect(params.mode).toBe('install');
    const expected = Buffer.concat(
      params.files.map((file) =>
        readFileSync(join(s.install!, ...file.path.split('/'))),
      ),
    );
    expect(child.payload().equals(expected)).toBe(true);
    for (const file of params.files)
      expect(
        createHash('sha256')
          .update(readFileSync(join(s.install!, ...file.path.split('/'))))
          .digest('hex'),
      ).toBe(file.sha256);
  });

  test('no local install: the host gets nothing, and the failure says why', async () => {
    const s = setup({ installed: false });
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    await s.registry.setHubEnabled(host.hostId, {
      enabled: true,
      consent: true,
    });
    await s.registry.install(host.hostId);
    expect(s.registry.view(host.hostId)?.install).toEqual({
      state: 'failed',
      failure: 'local-hub-not-installed',
    });
    expect(s.spawned).toEqual([]);
  });
});

describe('the host endpoint', () => {
  test('a host the operator has not enabled answers not-configured and starts nothing', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    expect(await s.registry.endpoint(host.hostId).connect()).toEqual({
      ok: false,
      failure: 'not-configured',
    });
    expect(s.hubOptions).toEqual([]);
    expect(await s.registry.ensureHub(host.hostId)).toBeUndefined();
    expect(await s.registry.endpoint('ssh-ffffffffffff').connect()).toEqual({
      ok: false,
      failure: 'not-configured',
    });
  });

  test('each host has its own owner key and target', () => {
    const s = setup();
    const a = s.registry.add({ label: 'A', sshTarget: 'a-box' });
    const b = s.registry.add({ label: 'B', sshTarget: 'me@b-box:2200' });
    s.registry.hub(a.hostId);
    s.registry.hub(b.hostId);
    expect(s.hubOptions.map((options) => options.target())).toEqual([
      { host: 'a-box' },
      { user: 'me', host: 'b-box', port: 2200 },
    ]);
    expect(s.registry.ownerKey(a.hostId)).not.toBe(
      s.registry.ownerKey(b.hostId),
    );
  });
});

describe('Android serials on an SSH host', () => {
  test('are resolved on that host; anything but a serial is never sent', async () => {
    const s = setup({
      respond: (child) => reply(child, { event: 'avd', avd: 'Pixel_A' }),
    });
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    s.registry.store.setHubEnabled(host.hostId, true);
    expect(
      await s.registry.resolveAndroidAvd(host.hostId, 'emulator-5554'),
    ).toBe('Pixel_A');
    expect(s.spawned[0]!.params()).toEqual({
      mode: 'avd',
      serial: 'emulator-5554',
    });
    expect(
      await s.registry.resolveAndroidAvd(host.hostId, 'emulator-5554; id'),
    ).toBeUndefined();
    expect(
      await s.registry.resolveAndroidAvd('ssh-ffffffffffff', 'emulator-5554'),
    ).toBeUndefined();
    expect(s.spawned).toHaveLength(1);
  });
});

describe('M1: AVD lookups are bounded and need the operator\u2019s consent', () => {
  test('a host without hub consent opens no ssh at all', async () => {
    const s = setup({
      respond: (child) => reply(child, { event: 'avd', avd: 'Pixel_A' }),
    });
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    const answers = await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        s.registry.resolveAndroidAvd(host.hostId, `emulator-${5554 + n}`),
      ),
    );
    expect(answers.every((avd) => avd === undefined)).toBe(true);
    expect(s.spawned).toHaveLength(0);
  });

  test('20 concurrent lookups of one serial are ONE ssh run', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    s.registry.store.setHubEnabled(host.hostId, true);
    const lookups = Array.from({ length: 20 }, () =>
      s.registry.resolveAndroidAvd(host.hostId, 'emulator-5554'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.spawned).toHaveLength(1);
    reply(s.spawned[0]!, { event: 'avd', avd: 'Pixel_A' });
    expect(new Set(await Promise.all(lookups))).toEqual(new Set(['Pixel_A']));
    expect(s.spawned).toHaveLength(1);
  });

  test('D2: three shared emulators looked up at once ALL resolve (the third waits for a slot)', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    s.registry.store.setHubEnabled(host.hostId, true);
    const lookups = ['emulator-5554', 'emulator-5556', 'emulator-5558'].map(
      (serial) => s.registry.resolveAndroidAvd(host.hostId, serial),
    );
    await new Promise((resolve) => setImmediate(resolve));
    // Two run; the third is queued, not refused.
    expect(s.spawned).toHaveLength(2);
    const answer = (child: FakeSsh) =>
      reply(child, {
        event: 'avd',
        avd: `Pixel_${String(child.params().serial).slice(-4)}`,
      });
    answer(s.spawned[0]!);
    for (let i = 0; i < 20 && s.spawned.length < 3; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(s.spawned).toHaveLength(3);
    answer(s.spawned[1]!);
    answer(s.spawned[2]!);
    expect(await Promise.all(lookups)).toEqual([
      'Pixel_5554',
      'Pixel_5556',
      'Pixel_5558',
    ]);
  });

  test('D2: an overflowed queue fails TYPED and transient, never as "not shared"', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    s.registry.store.setHubEnabled(host.hostId, true);
    // 2 running + 16 queued fit; the 19th and 20th overflow.
    const lookups = Array.from({ length: 20 }, (_, n) =>
      s.registry
        .resolveAndroidAvd(host.hostId, `emulator-${5554 + 2 * n}`)
        .then(
          (avd) => ({ avd }),
          (error: unknown) => ({ error }),
        ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.spawned).toHaveLength(2);
    // Drain the queue: answer every lookup as it gets its slot.
    for (let answered = 0; answered < 18; ) {
      const next = s.spawned[answered];
      if (next) {
        reply(next, { event: 'avd', avd: 'X' });
        answered += 1;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const results = await Promise.all(lookups);
    expect(results.filter((r) => 'avd' in r && r.avd === 'X')).toHaveLength(18);
    const refused = results.filter((r) => 'error' in r);
    expect(refused).toHaveLength(2);
    for (const r of refused)
      expect((r as { error: unknown }).error).toBeInstanceOf(
        DeviceHostBusyError,
      );
    expect(results.some((r) => 'avd' in r && r.avd === undefined)).toBe(false);
  });
});

describe('N1: queued AVD lookups never outlive the host they were asked about', () => {
  // 5 lookups: 2 run, 3 queue. Every ssh is answered 150ms after it spawns.
  async function queued() {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'me@machine-a' });
    s.registry.store.setHubEnabled(host.hostId, true);
    const originalLength = () => s.spawned.length;
    const answerLater = setInterval(() => {
      for (const child of s.spawned)
        if (!child.exited && !(child as { answered?: boolean }).answered) {
          (child as { answered?: boolean }).answered = true;
          setTimeout(() => {
            if (!child.exited) reply(child, { event: 'avd', avd: 'X' });
          }, 150);
        }
    }, 5);
    cleanups.push(() => clearInterval(answerLater));
    const lookups = [0, 2, 4, 6, 8].map((n) =>
      s.registry.resolveAndroidAvd(host.hostId, `emulator-${5554 + n}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(originalLength()).toBe(2);
    return { s, host, lookups };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

  test('shutdown: no queued lookup spawns ssh afterwards', async () => {
    const { s, lookups } = await queued();
    await s.registry.shutdown();
    await settle();
    expect(s.spawned).toHaveLength(2);
    expect(await Promise.all(lookups)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('consent withdrawn: no queued lookup spawns ssh afterwards', async () => {
    const { s, host, lookups } = await queued();
    await s.registry.setHubEnabled(host.hostId, { enabled: false });
    await settle();
    expect(s.spawned).toHaveLength(2);
    expect((await Promise.all(lookups)).every((avd) => avd === undefined)).toBe(
      true,
    );
  });

  test('retarget: nothing runs against the old machine, and nothing stale is cached', async () => {
    const { s, host, lookups } = await queued();
    await s.registry.update(host.hostId, { sshTarget: 'me@machine-b' });
    await settle();
    expect(s.spawned).toHaveLength(2);
    expect((await Promise.all(lookups)).every((avd) => avd === undefined)).toBe(
      true,
    );
    // The retarget withdrew consent; with it given again for machine-b, a
    // lookup runs AGAINST machine-b (no answer was cached from machine-a).
    s.registry.store.setHubEnabled(host.hostId, true);
    const fresh = s.registry.resolveAndroidAvd(host.hostId, 'emulator-5554');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.spawned).toHaveLength(3);
    const third = s.spawned[2]!;
    expect(third.args[third.args.indexOf('--') + 1]).toBe('machine-b');
    await fresh;
  });
});

describe('N1(a): a lookup re-checks the host after its wait', () => {
  test('consent withdrawn behind the registry\u2019s back: a granted waiter still spawns nothing', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'me@machine-a' });
    s.registry.store.setHubEnabled(host.hostId, true);
    const lookups = [0, 2, 4].map((n) =>
      s.registry.resolveAndroidAvd(host.hostId, `emulator-${5554 + n}`),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.spawned).toHaveLength(2);
    // The store changes WITHOUT the registry (no bump, no flush): only the
    // re-check after the slot can notice.
    s.registry.store.setHubEnabled(host.hostId, false);
    for (const child of s.spawned) reply(child, { event: 'avd', avd: 'X' });
    await Promise.all(lookups);
    expect(s.spawned).toHaveLength(2);
  });
});

describe('N2: nothing new starts after shutdown', () => {
  test('hub(), install(), check() and AVD lookups refuse without spawning', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    s.registry.store.setHubEnabled(host.hostId, true);
    await s.registry.shutdown();
    expect(s.registry.hub(host.hostId)).toBeUndefined();
    expect(await s.registry.ensureHub(host.hostId)).toBeUndefined();
    await s.registry.install(host.hostId);
    expect(
      await s.registry.resolveAndroidAvd(host.hostId, 'emulator-5554'),
    ).toBeUndefined();
    await expect(s.registry.check(host.hostId)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(s.spawned).toHaveLength(0);
    expect(s.hubOptions).toHaveLength(0);
  });
});

describe('M2: shares go with the machine', () => {
  test('a retarget withdraws the host\u2019s shares; a label-only edit keeps them', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    const other = s.registry.add({ label: 'Box', sshTarget: 'linux-box' });
    const share = (hostId: string) =>
      s.shares.add(
        'p-alpha',
        {
          hostId,
          platform: 'android',
          deviceId: 'Pixel_8_API_35',
          label: 'Pixel',
        },
        'operator',
      );
    share(host.hostId);
    share(other.hostId);
    share('local');
    const keys = () =>
      s.shares
        .list('p-alpha')
        .map((row) => `${row.hostId}:${row.deviceId}`)
        .sort();
    await s.registry.update(host.hostId, { label: 'Studio Mac' });
    expect(keys()).toContain(`${host.hostId}:Pixel_8_API_35`);
    await s.registry.update(host.hostId, { sshTarget: 'other-mac' });
    expect(keys()).toEqual(
      [`${other.hostId}:Pixel_8_API_35`, 'local:Pixel_8_API_35'].sort(),
    );
    // …and so does removing a host.
    await s.registry.remove(other.hostId);
    expect(keys()).toEqual(['local:Pixel_8_API_35']);
  });
});

describe('M3: an install belongs to the machine it was sent to', () => {
  test('enable A, retarget to B, re-enable: B gets its own install; A\u2019s late completion is ignored and its ssh killed', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'machine-a' });
    await s.registry.setHubEnabled(host.hostId, {
      enabled: true,
      consent: true,
    });
    for (let i = 0; i < 20 && s.spawned.length === 0; i++)
      await new Promise((resolve) => setImmediate(resolve));
    const installA = s.spawned[0]!;
    const destination = (child: FakeSsh) =>
      child.args[child.args.indexOf('--') + 1];
    expect(destination(installA)).toBe('machine-a');
    await s.registry.update(host.hostId, { sshTarget: 'machine-b' });
    expect(installA.killed).toContain('SIGKILL');
    // The cancelled install's own outcome says nothing about machine B.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.registry.view(host.hostId)?.install).toEqual({ state: 'unknown' });
    await s.registry.setHubEnabled(host.hostId, {
      enabled: true,
      consent: true,
    });
    for (let i = 0; i < 20 && s.spawned.length < 2; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(s.spawned.map(destination)).toEqual(['machine-a', 'machine-b']);
    // A's (late) success must not mark machine B installed.
    installA.stdout.write(
      `${JSON.stringify({ event: 'installed', already: false })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.registry.view(host.hostId)?.install).toEqual({
      state: 'installing',
    });
    // B's own completion does.
    reply(s.spawned[1]!, { event: 'installed', already: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.registry.view(host.hostId)?.install).toEqual({
      state: 'installed',
    });
  });

  test('disabling kills the install in flight', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'machine-a' });
    await s.registry.setHubEnabled(host.hostId, {
      enabled: true,
      consent: true,
    });
    for (let i = 0; i < 20 && s.spawned.length === 0; i++)
      await new Promise((resolve) => setImmediate(resolve));
    await s.registry.setHubEnabled(host.hostId, { enabled: false });
    expect(s.spawned[0]!.killed).toContain('SIGKILL');
    // L-d: and the view no longer claims an install is running.
    expect(s.registry.view(host.hostId)?.install).toEqual({ state: 'unknown' });
  });
});

describe('L-a: a hub being stopped keeps its ports denied', () => {
  test('removing a host: the registry denies the ports until stop() resolves', async () => {
    const home = tempDir('station-device-hosts-');
    let release!: () => void;
    let ports = [41_500, 50_500];
    const registry = new DeviceHostRegistry({
      stationHome: home,
      store: new DeviceHostStore(home),
      localHub: () => undefined,
      createHub: (hubOpts) =>
        ({
          hostId: hubOpts.hostId,
          state: () => ({ state: 'running' as const, startedAt: 'x' }),
          listeningPorts: () => ports,
          // The children take a moment to exit.
          stop: () =>
            new Promise<void>((resolve) => {
              release = () => {
                ports = [];
                resolve();
              };
            }),
          connection: () => undefined,
        }) as unknown as SshDeviceHub,
    });
    const host = registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    registry.hub(host.hostId);
    expect(registry.listeningPorts()).toEqual([41_500, 50_500]);
    const removing = registry.remove(host.hostId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.listeningPorts()).toEqual([41_500, 50_500]);
    release();
    await removing;
    expect(registry.listeningPorts()).toEqual([]);
  });
});

describe('L-e: shutdown leaves no ssh child and no timer', () => {
  test('an install and an AVD lookup in flight are killed; no timer holds the process', async () => {
    // Track the timers created during this test rather than counting every
    // Timeout in the process: an unrelated timer from an earlier test in the
    // same worker can fire mid-test and move a process-wide count (#2488).
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const created: NodeJS.Timeout[] = [];
    const settled = new Set<unknown>();
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const handle = realSetTimeout(() => {
        settled.add(handle);
        callback(...args);
      }, ms);
      created.push(handle);
      return handle;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      handle?: NodeJS.Timeout,
    ) => {
      settled.add(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout);
    try {
      const s = setup();
      const host = s.registry.add({ label: 'Mac', sshTarget: 'machine-a' });
      await s.registry.setHubEnabled(host.hostId, {
        enabled: true,
        consent: true,
      });
      const lookup = s.registry.resolveAndroidAvd(host.hostId, 'emulator-5554');
      for (let i = 0; i < 20 && s.spawned.length < 2; i++)
        await new Promise((resolve) => setImmediate(resolve));
      expect(s.spawned).toHaveLength(2);
      // Their deadlines exist and are unref'd: none keeps the process alive
      // even now.
      const live = created.filter((handle) => !settled.has(handle));
      expect(live.length).toBeGreaterThan(0);
      expect(live.filter((handle) => handle.hasRef())).toEqual([]);
      await s.registry.shutdown();
      expect(await lookup).toBeUndefined();
      for (const child of s.spawned) expect(child.killed).toContain('SIGKILL');
      await new Promise((resolve) => setImmediate(resolve));
      // Every timer the shutdown path created or inherited is gone.
      expect(created.filter((handle) => !settled.has(handle))).toEqual([]);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

describe('the Station-listener deny set', () => {
  test('an SSH host hub’s forward and hub ports are denied to the host browser, read live', async () => {
    const s = setup();
    const host = s.registry.add({ label: 'Mac', sshTarget: 'mac-mini' });
    const hub = s.registry.hub(host.hostId)!;
    await hub.ensureStarted().catch(() => {});
    expect(s.registry.listeningPorts()).toEqual([41_500, 50_500]);
    // Composed exactly as the runtime composes it.
    const service = createBrowserService({
      stationHome: s.home,
      serverPort: 4100,
      configuredOrigins: [],
      extraListenerPorts: () => s.registry.listeningPorts(),
    });
    try {
      const policy = egressPolicyFor(
        { projectId: 'p-1', reach: 'operator' },
        service.listeners,
        service.localTargets,
      );
      expect(decideEgress('127.0.0.1', 41_500, policy)).toBe(
        'station-listener',
      );
      expect(decideEgress('127.0.0.1', 50_500, policy)).toBe(
        'station-listener',
      );
      await s.registry.remove(host.hostId);
      expect(decideEgress('127.0.0.1', 41_500, policy)).toBeUndefined();
    } finally {
      await service.shutdown();
    }
  });

  test('the runtime feeds every SSH host port into the browser’s listener provider', () => {
    const runtime = readFileSync(
      join(__dirname, '../../../../runtime/routes/runtime-routes.ts'),
      'utf8',
    );
    expect(runtime).toMatch(
      /extraListenerPorts:\s*\(\)\s*=>\s*\[[\s\S]{0,200}?deviceHostRegistry\?\.listeningPorts\(\)/,
    );
  });
});
