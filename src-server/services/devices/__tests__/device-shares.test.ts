/**
 * D12 share keys (#1970): Android shares are keyed by AVD name, because an
 * emulator serial is assigned by port and follows whichever AVD boots there.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createAndroidAvdResolver,
  parseAvdNameOutput,
} from '../android-avd.js';
import {
  DeviceShareError,
  DeviceShareStore,
  mayUseNamedDevice,
} from '../device-shares.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-device-shares-'));
  homes.push(dir);
  return dir;
}

const admin = (shares: ReturnType<DeviceShareStore['list']>) => ({
  kind: 'project-admin' as const,
  projectId: 'p-alpha',
  principalId: 'admin-alpha',
  shares,
});

describe('device share store', () => {
  test('an emulator serial cannot be shared; an AVD name can', () => {
    const store = new DeviceShareStore(home());
    expect(() =>
      store.add(
        'p-alpha',
        {
          hostId: 'local',
          platform: 'android',
          deviceId: 'emulator-5554',
          label: 'By port',
        },
        'operator',
      ),
    ).toThrow(DeviceShareError);
    expect(
      store.add(
        'p-alpha',
        {
          hostId: 'local',
          platform: 'android',
          deviceId: 'Pixel_A',
          label: 'Pixel',
        },
        'operator',
      ).deviceId,
    ).toBe('Pixel_A');
  });

  test('older serial-keyed shares are refused on load (re-shared by the operator)', () => {
    const dir = home();
    mkdirSync(join(dir, 'devices'), { recursive: true });
    writeFileSync(
      join(dir, 'devices', 'shares.json'),
      JSON.stringify({
        version: 1,
        projects: {
          'p-alpha': [
            {
              platform: 'android',
              deviceId: 'emulator-5554',
              label: 'old',
              addedBy: 'operator',
              addedAt: '2026-09-01T00:00:00.000Z',
            },
            {
              platform: 'android',
              deviceId: 'Pixel_A',
              label: 'new',
              addedBy: 'operator',
              addedAt: '2026-09-22T00:00:00.000Z',
            },
          ],
        },
      }),
    );
    expect(
      new DeviceShareStore(dir).list('p-alpha').map((share) => share.deviceId),
    ).toEqual(['Pixel_A']);
  });
});

describe('authorizing a device by the name a request uses', () => {
  const store = new DeviceShareStore(home());
  store.add(
    'p-alpha',
    {
      hostId: 'local',
      platform: 'android',
      deviceId: 'Pixel_A',
      label: 'Pixel',
    },
    'operator',
  );
  const caller = admin(store.list('p-alpha'));

  test('share AVD A on 5554, boot AVD B on 5554: the admin is refused', async () => {
    const onA = { resolveAndroidAvd: async () => 'Pixel_A' };
    const onB = { resolveAndroidAvd: async () => 'Pixel_B' };
    expect(
      await mayUseNamedDevice(
        onA,
        caller,
        'view',
        'android',
        'emulator-5554',
        'local',
      ),
    ).toBe(true);
    expect(
      await mayUseNamedDevice(
        onB,
        caller,
        'view',
        'android',
        'emulator-5554',
        'local',
      ),
    ).toBe(false);
    // No resolver, or one that fails: refused.
    expect(
      await mayUseNamedDevice(
        {},
        caller,
        'view',
        'android',
        'emulator-5554',
        'local',
      ),
    ).toBe(false);
    expect(
      await mayUseNamedDevice(
        { resolveAndroidAvd: async () => Promise.reject(new Error('adb')) },
        caller,
        'view',
        'android',
        'emulator-5554',
        'local',
      ),
    ).toBe(false);
    // The operator needs no lookup.
    expect(
      await mayUseNamedDevice(
        {},
        { kind: 'operator' },
        'operator',
        'android',
        'emulator-5554',
        'local',
      ),
    ).toBe(true);
  });
});

/**
 * #1973: a share names its device host. A UDID shared on `local` says
 * nothing about a device with the same id on an SSH device host, and an
 * emulator serial is resolved on the host that runs it.
 */
describe('shares are keyed by (hostId, platform, id)', () => {
  const REMOTE = 'ssh-0123456789ab';
  const UDID = '11111111-2222-3333-4444-555555555555';

  test('a local share does not admit the same UDID on an SSH host, and vice versa', async () => {
    const store = new DeviceShareStore(home());
    store.add(
      'p-alpha',
      { hostId: 'local', platform: 'ios', deviceId: UDID, label: 'Local' },
      'operator',
    );
    const localOnly = admin(store.list('p-alpha'));
    expect(
      await mayUseNamedDevice({}, localOnly, 'drive', 'ios', UDID, 'local'),
    ).toBe(true);
    expect(
      await mayUseNamedDevice({}, localOnly, 'drive', 'ios', UDID, REMOTE),
    ).toBe(false);
    store.add(
      'p-alpha',
      { hostId: REMOTE, platform: 'ios', deviceId: UDID, label: 'Remote' },
      'operator',
    );
    const both = admin(store.list('p-alpha'));
    expect(
      await mayUseNamedDevice({}, both, 'drive', 'ios', UDID, REMOTE),
    ).toBe(true);
    store.remove('p-alpha', 'ios', UDID, 'local');
    const remoteOnly = admin(store.list('p-alpha'));
    expect(
      await mayUseNamedDevice({}, remoteOnly, 'drive', 'ios', UDID, 'local'),
    ).toBe(false);
    expect(
      await mayUseNamedDevice({}, remoteOnly, 'drive', 'ios', UDID, REMOTE),
    ).toBe(true);
  });

  test('a malformed host id is refused, on add and on use', async () => {
    const store = new DeviceShareStore(home());
    for (const hostId of ['', 'LOCAL', 'ssh-XYZ', '../local', undefined])
      expect(() =>
        store.add(
          'p-alpha',
          { hostId, platform: 'ios', deviceId: UDID, label: 'x' },
          'operator',
        ),
      ).toThrow(DeviceShareError);
  });

  test('an emulator serial is resolved on the host that names it', async () => {
    const store = new DeviceShareStore(home());
    store.add(
      'p-alpha',
      { hostId: REMOTE, platform: 'android', deviceId: 'Pixel_A', label: 'P' },
      'operator',
    );
    const caller = admin(store.list('p-alpha'));
    const asked: string[] = [];
    const deps = {
      resolveAndroidAvd: async (serial: string, hostId: string) => {
        asked.push(`${hostId}:${serial}`);
        return hostId === REMOTE ? 'Pixel_A' : 'Other';
      },
    };
    expect(
      await mayUseNamedDevice(
        deps,
        caller,
        'view',
        'android',
        'emulator-5554',
        REMOTE,
      ),
    ).toBe(true);
    expect(
      await mayUseNamedDevice(
        deps,
        caller,
        'view',
        'android',
        'emulator-5554',
        'local',
      ),
    ).toBe(false);
    expect(asked).toEqual([`${REMOTE}:emulator-5554`, 'local:emulator-5554']);
  });

  test('records written before device hosts are local shares', () => {
    const dir = home();
    mkdirSync(join(dir, 'devices'), { recursive: true });
    writeFileSync(
      join(dir, 'devices', 'shares.json'),
      JSON.stringify({
        version: 1,
        projects: {
          'p-alpha': [
            {
              platform: 'ios',
              deviceId: UDID,
              label: 'old',
              addedBy: 'operator',
              addedAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        },
      }),
    );
    expect(new DeviceShareStore(dir).list('p-alpha')[0]?.hostId).toBe('local');
  });
});

describe('adb emu avd name output', () => {
  test('parses the AVD name followed by OK, and nothing else', () => {
    expect(parseAvdNameOutput('Pixel_A\r\nOK\r\n')).toBe('Pixel_A');
    expect(parseAvdNameOutput('KO: unknown command\r\n')).toBeUndefined();
    expect(parseAvdNameOutput('Pixel A\nOK\n')).toBeUndefined();
    expect(parseAvdNameOutput('')).toBeUndefined();
  });
});

describe('serial to AVD resolver', () => {
  function resolver(clock = { now: 0 }) {
    const pending: Array<(value: string) => void> = [];
    const run = vi.fn(
      (_command: string, _args: string[], _env: NodeJS.ProcessEnv) =>
        new Promise<string | undefined>((resolve) => {
          pending.push(resolve);
        }),
    );
    const resolve = createAndroidAvdResolver({
      run,
      now: () => clock.now,
      env: {
        PATH: '/usr/bin',
        HOME: '/home/me',
        ANDROID_HOME: '/sdk',
        STATION_TOKEN: 'secret',
        ANTHROPIC_API_KEY: 'secret',
      },
    });
    // Answers every adb run started so far.
    const finish = (out: string) => {
      for (const resolve of pending.splice(0)) resolve(out);
    };
    return { run, resolve, clock, finish };
  }

  test('concurrent lookups of one serial share a single adb run', async () => {
    const r = resolver();
    const lookups = [
      r.resolve('emulator-5554'),
      r.resolve('emulator-5554'),
      r.resolve('emulator-5554'),
    ];
    r.finish('Pixel_A\nOK\n');
    expect(await Promise.all(lookups)).toEqual([
      'Pixel_A',
      'Pixel_A',
      'Pixel_A',
    ]);
    expect(r.run).toHaveBeenCalledTimes(1);
  });

  test('an answer is reused for five seconds, then looked up again', async () => {
    const r = resolver();
    const first = r.resolve('emulator-5554');
    r.finish('Pixel_A\nOK\n');
    await first;
    r.clock.now = 4_000;
    const cached = r.resolve('emulator-5554');
    // Were this a fresh adb run, it would answer Pixel_B.
    r.finish('Pixel_B\nOK\n');
    expect(await cached).toBe('Pixel_A');
    expect(r.run).toHaveBeenCalledTimes(1);
    r.clock.now = 6_000;
    const again = r.resolve('emulator-5554');
    r.finish('Pixel_B\nOK\n');
    expect(await again).toBe('Pixel_B');
    expect(r.run).toHaveBeenCalledTimes(2);
  });

  test('adb runs with the allowlisted environment, never Station secrets', async () => {
    const r = resolver();
    const lookup = r.resolve('emulator-5554');
    r.finish('Pixel_A\nOK\n');
    await lookup;
    const [command, args, env] = r.run.mock.calls[0] ?? [];
    expect(args).toEqual(['-s', 'emulator-5554', 'emu', 'avd', 'name']);
    expect(command).toBe('adb');
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      ANDROID_HOME: '/sdk',
    });
  });

  test('a non-serial is never passed to adb', async () => {
    const r = resolver();
    expect(await r.resolve('emulator-5554; rm -rf /')).toBeUndefined();
    expect(r.run).not.toHaveBeenCalled();
  });
});
