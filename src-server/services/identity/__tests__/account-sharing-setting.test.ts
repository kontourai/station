import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  accountSharingOriginOptions,
  offeredAccountSharingOrigin,
} from '../account-sharing-origins.js';
import {
  accountSharingSettingPath,
  armStagedAccountSharingChange,
  commitAccountSharingAtBoot,
  deploymentAccountSharingVariables,
  readAccountSharingRecord,
  resolveAccountSharingAtBoot,
  rollBackAccountSharingAtBoot,
  stageAccountSharingChange,
  withdrawStagedAccountSharingChange,
} from '../account-sharing-setting.js';

const makeTempDir = trackTempDirs();
const home = () => makeTempDir('station-account-sharing-');
const now = () => new Date('2026-10-28T12:00:00.000Z');
const on = { enabled: true, publicOrigin: 'https://station.example.test' };
const stored = (path: string) =>
  JSON.parse(readFileSync(accountSharingSettingPath(path), 'utf8'));

describe('stored Project sharing setting (#4305)', () => {
  test('a home without the file boots with sharing off and writes nothing', () => {
    const path = home();
    expect(resolveAccountSharingAtBoot(path, now)).toEqual({
      choice: { enabled: false },
      applying: false,
      unreadable: false,
    });
    expect(readAccountSharingRecord(path).kind).toBe('absent');
  });

  test('a staged change is marked attempted before use and committed after a successful boot', () => {
    const path = home();
    stageAccountSharingChange(path, on, now);
    expect(stored(path).pending).toEqual({
      choice: on,
      stagedAt: now().toISOString(),
      attempted: false,
      ready: false,
    });
    expect(resolveAccountSharingAtBoot(path, now).choice).toEqual({
      enabled: false,
    });
    armStagedAccountSharingChange(path);
    const boot = resolveAccountSharingAtBoot(path, now);
    expect(boot).toEqual({ choice: on, applying: true, unreadable: false });
    // Durable before anything uses it: a crash from here on is a rollback.
    expect(stored(path).pending.attempted).toBe(true);
    commitAccountSharingAtBoot(path, now);
    expect(stored(path)).toEqual({
      version: 1,
      committed: on,
      lastApply: { outcome: 'applied', choice: on, at: now().toISOString() },
    });
    expect(resolveAccountSharingAtBoot(path, now)).toEqual({
      choice: on,
      applying: false,
      unreadable: false,
    });
  });

  test('a boot that finds an attempted change never committed rolls it back to the committed choice', () => {
    const path = home();
    stageAccountSharingChange(path, on, now);
    armStagedAccountSharingChange(path);
    resolveAccountSharingAtBoot(path, now);
    // That boot died before committing. The supervisor's rollback relaunch:
    const relaunch = resolveAccountSharingAtBoot(path, now);
    expect(relaunch).toEqual({
      choice: { enabled: false },
      applying: false,
      unreadable: false,
    });
    expect(stored(path)).toEqual({
      version: 1,
      committed: { enabled: false },
      lastApply: {
        outcome: 'rolled-back',
        choice: on,
        at: now().toISOString(),
        reason: 'Station did not start with this setting.',
      },
    });
  });

  test('a staged change that cannot be marked attempted is not used', () => {
    const path = home();
    stageAccountSharingChange(path, on, now);
    armStagedAccountSharingChange(path);
    const boot = resolveAccountSharingAtBoot(path, now, () => {
      throw new Error('read-only home');
    });
    expect(boot.choice).toEqual({ enabled: false });
    expect(boot.applying).toBe(false);
  });

  test('a load failure during the attempt rolls back with its reason', () => {
    const path = home();
    stageAccountSharingChange(path, on, now);
    armStagedAccountSharingChange(path);
    resolveAccountSharingAtBoot(path, now);
    rollBackAccountSharingAtBoot(path, 'Project sharing could not start', now);
    expect(stored(path).pending).toBeUndefined();
    expect(stored(path).committed).toEqual({ enabled: false });
    expect(stored(path).lastApply).toMatchObject({
      outcome: 'rolled-back',
      reason: 'Project sharing could not start',
    });
  });

  test('turning it off keeps the previous choice only as history', () => {
    const path = home();
    stageAccountSharingChange(path, on, now);
    armStagedAccountSharingChange(path);
    resolveAccountSharingAtBoot(path, now);
    commitAccountSharingAtBoot(path, now);
    stageAccountSharingChange(path, { enabled: false }, now);
    armStagedAccountSharingChange(path);
    resolveAccountSharingAtBoot(path, now);
    commitAccountSharingAtBoot(path, now);
    expect(stored(path).committed).toEqual({ enabled: false });
  });

  test('a withdrawn change leaves the committed choice; an attempted one is not withdrawn', () => {
    const path = home();
    stageAccountSharingChange(path, on, now);
    withdrawStagedAccountSharingChange(path, 'refused', now);
    expect(stored(path)).toMatchObject({
      committed: { enabled: false },
      lastApply: { outcome: 'withdrawn', reason: 'refused' },
    });
    expect(stored(path).pending).toBeUndefined();
    stageAccountSharingChange(path, on, now);
    armStagedAccountSharingChange(path);
    resolveAccountSharingAtBoot(path, now);
    withdrawStagedAccountSharingChange(path, 'late', now);
    expect(stored(path).pending.attempted).toBe(true);
  });

  test('an unreadable or foreign file boots with sharing off', () => {
    for (const content of [
      'not json',
      JSON.stringify({ version: 2, committed: on }),
      JSON.stringify({
        version: 1,
        committed: { enabled: true, publicOrigin: 'x', modulePath: '/a.mjs' },
      }),
      'x'.repeat(17 * 1024),
    ]) {
      const path = home();
      mkdirSync(join(path, 'config'), { recursive: true });
      writeFileSync(accountSharingSettingPath(path), content);
      expect(resolveAccountSharingAtBoot(path, now)).toEqual({
        choice: { enabled: false },
        applying: false,
        unreadable: true,
      });
    }
  });

  test('every deployment variable locks the setting, even when set to 0', () => {
    expect(deploymentAccountSharingVariables({})).toEqual([]);
    for (const name of [
      'STATION_PROJECT_SHARING',
      'STATION_LOCAL_ACCOUNTS',
      'STATION_AUTHENTICATION_MODULE',
      'STATION_AUTHENTICATION_ORIGIN',
      'STATION_AUTHENTICATION_BROWSER_ORIGINS',
      'STATION_LOCAL_ACCOUNT_OIDC_FILE',
      'STATION_HOSTED_TENANT_REGISTRY_FILE',
    ])
      expect(deploymentAccountSharingVariables({ [name]: '0' })).toEqual([
        name,
      ]);
  });
});

describe('offered sign-in origins (#4305)', () => {
  const base = {
    port: 3141,
    browserOrigins: [
      'http://localhost:3141',
      'http://127.0.0.1:3141',
      'http://[::1]:3141',
      'http://localhost:3000',
      'https://station.tailnet.ts.net',
      'http://192.168.1.20:3000',
    ],
    allowedOrigins: [
      'http://localhost:3000',
      'https://station.tailnet.ts.net',
      'http://192.168.1.20:3000',
    ],
    tailscaleServeOrigins: [
      'https://station.tailnet.ts.net',
      'https://other.tailnet.ts.net',
    ],
  };

  test('lists known origins with their sources and why any cannot be chosen', () => {
    const options = accountSharingOriginOptions(base);
    expect(options).toEqual([
      {
        origin: 'https://station.tailnet.ts.net',
        sources: ['tailscale-serve', 'allowed-origin'],
      },
      {
        origin: 'https://other.tailnet.ts.net',
        sources: ['tailscale-serve'],
        unavailable: 'not-a-browser-origin',
      },
      { origin: 'http://localhost:3000', sources: ['allowed-origin'] },
      {
        origin: 'http://192.168.1.20:3000',
        sources: ['allowed-origin'],
        unavailable: 'requires-https',
      },
      { origin: 'http://localhost:3141', sources: ['station-loopback'] },
      { origin: 'http://127.0.0.1:3141', sources: ['station-loopback'] },
      { origin: 'http://[::1]:3141', sources: ['station-loopback'] },
    ]);
  });

  test('only a selectable option is accepted, compared exactly', () => {
    const options = accountSharingOriginOptions(base);
    expect(
      offeredAccountSharingOrigin(options, 'https://station.tailnet.ts.net'),
    ).toBe('https://station.tailnet.ts.net');
    for (const refused of [
      'https://other.tailnet.ts.net',
      'http://192.168.1.20:3000',
      'https://station.tailnet.ts.net/',
      'http://127.0.0.1:3000',
      'https://evil.example',
    ])
      expect(offeredAccountSharingOrigin(options, refused)).toBeUndefined();
  });

  test('a bound host offers both schemes, and an allowed origin spelled differently is not admitted', () => {
    const options = accountSharingOriginOptions({
      ...base,
      host: '100.64.0.7',
      allowedOrigins: ['https://station.tailnet.ts.net/'],
      browserOrigins: ['https://station.tailnet.ts.net/'],
      tailscaleServeOrigins: [],
    });
    expect(options.slice(0, 3)).toEqual([
      {
        origin: 'https://station.tailnet.ts.net',
        sources: ['allowed-origin'],
        unavailable: 'not-a-browser-origin',
      },
      {
        origin: 'https://100.64.0.7:3141',
        sources: ['bound-host'],
        unavailable: 'not-a-browser-origin',
      },
      {
        origin: 'http://100.64.0.7:3141',
        sources: ['bound-host'],
        unavailable: 'requires-https',
      },
    ]);
  });
});

test.skipIf(process.platform === 'win32')(
  'refuses a linked config directory for reads and writes',
  () => {
    const path = home();
    const outside = home();
    chmodSync(outside, 0o777);
    symlinkSync(outside, join(path, 'config'));
    writeFileSync(
      join(outside, 'account-sharing.json'),
      JSON.stringify({ version: 1, committed: on }),
      { mode: 0o600 },
    );
    expect(readAccountSharingRecord(path).kind).toBe('unreadable');
    expect(resolveAccountSharingAtBoot(path).choice).toEqual({
      enabled: false,
    });
    expect(() => stageAccountSharingChange(path, on)).toThrow();
    expect(
      JSON.parse(readFileSync(join(outside, 'account-sharing.json'), 'utf8'))
        .committed,
    ).toEqual(on);
  },
);

test.skipIf(process.platform === 'win32')(
  'refuses nonprivate directories and files, symlinks, hard links, and FIFOs',
  () => {
    for (const kind of ['directory', 'file', 'symlink', 'hardlink', 'fifo']) {
      const path = home();
      const config = join(path, 'config');
      mkdirSync(config, { mode: 0o700 });
      const file = accountSharingSettingPath(path);
      const content = JSON.stringify({ version: 1, committed: on });
      if (kind === 'directory') {
        writeFileSync(file, content, { mode: 0o600 });
        chmodSync(config, 0o777);
      } else if (kind === 'file') {
        writeFileSync(file, content, { mode: 0o600 });
        chmodSync(file, 0o644);
      } else if (kind === 'fifo') {
        execFileSync('mkfifo', [file], { windowsHide: true });
      } else {
        const other = join(path, 'other');
        writeFileSync(other, content, { mode: 0o600 });
        if (kind === 'symlink') symlinkSync(other, file);
        else linkSync(other, file);
      }
      expect(readAccountSharingRecord(path).kind, kind).toBe('unreadable');
      expect(() => stageAccountSharingChange(path, on), kind).toThrow();
      expect(existsSync(file), kind).toBe(true);
    }
  },
);
