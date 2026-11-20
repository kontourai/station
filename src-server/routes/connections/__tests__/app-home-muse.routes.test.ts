/**
 * #1942: Muse Code through the generic credential-profile surface — the
 * app-home table, the account and device-code login routes, and the session
 * resolver — with nothing Muse-specific on the route side.
 *
 * The login manager is REAL (fake child only), and its capability probe is
 * the real observer fed `muse login --help` as Muse Code 1.4.18 prints it, so
 * these tests reach the probe → spawn → parse → cancel path a caller drives.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { appHomesRootDir } from '../../../providers/app-home/app-home-profiles.js';
import { createCredentialProfileAppHomeEnvResolver } from '../../../providers/app-home/credential-profile-env.js';
import { credentialProfileAppHomeDir } from '../../../providers/app-home/credential-profile-registry.js';
import {
  MUSE_DEVICE_CODE_EXPECTED,
  MUSE_DEVICE_CODE_STDOUT,
  MUSE_LOGIN_HELP_STDOUT,
} from '../../../services/connections/__tests__/device-code-cli-output.js';
import {
  type DeviceCodeChildProcess,
  DeviceCodeLoginManager,
} from '../../../services/connections/device-code-login.js';
import { createEngineLoginCapabilityObserver } from '../../../services/connections/engine-login-capabilities.js';
import { createAppHomeRoutes } from '../app-home.js';

afterEach(() => {
  rmSync(appHomesRootDir(), { recursive: true, force: true });
});

function museConnectionService() {
  const recovery = {
    profiles: [{ ref: 'profile-a', label: 'Work' }],
    group: { profileRefs: ['profile-a'], enrolledProfileRefs: [] },
    policy: { automatic: false },
    application: {
      capability: 'restart_resume' as const,
      activeProfileRef: 'profile-a',
      outcome: 'adopted' as const,
    },
  };
  return {
    recovery,
    service: {
      getConnection: vi.fn(async (id: string) => ({
        id,
        kind: 'agent',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {},
      })),
      getCredentialRecovery: vi.fn(async () => recovery),
    },
  };
}

function fakeChild() {
  let onData: ((chunk: unknown) => void) | undefined;
  const stop = vi.fn(async () => undefined);
  const stream = {
    on(_event: 'data', listener: (chunk: unknown) => void) {
      onData = listener;
      return stream;
    },
  };
  return {
    stop,
    emitPrompt: () => onData?.(Buffer.from(MUSE_DEVICE_CODE_STDOUT, 'utf8')),
    child: {
      stdout: stream as unknown as NodeJS.ReadableStream,
      stderr: null,
      on: () => undefined,
      stop,
    } as unknown as DeviceCodeChildProcess,
  };
}

function museRoutes() {
  const { service } = museConnectionService();
  const spawned = fakeChild();
  const spawnLogin = vi.fn(() => spawned.child);
  const probe = vi.fn(async (command: string, args: string[]) =>
    command === '/opt/muse/bin/muse' && args.join(' ') === 'login --help'
      ? { stdout: MUSE_LOGIN_HELP_STDOUT, stderr: '', code: 0 }
      : null,
  );
  const capabilities = createEngineLoginCapabilityObserver({
    runCommand: probe,
    findBinary: async (command) =>
      command === 'muse' ? '/opt/muse/bin/muse' : null,
    now: () => new Date('2026-11-13T12:00:00.000Z'),
  });
  const verify = vi.fn(async () => ({ state: 'unauthenticated' as const }));
  const deviceCodeLogins = new DeviceCodeLoginManager({
    spawnLogin: spawnLogin as never,
    baseEnv: async () => ({ PATH: '/usr/bin' }),
    capabilities,
    verify,
    now: () => new Date('2026-11-13T12:00:00.000Z'),
    schedule: () => () => undefined,
  });
  const app = createAppHomeRoutes({
    connectionService: service as never,
    isLoginReadCurrent: () => true,
    loginCapabilities: capabilities,
    accountAuth: (async () => ({ state: 'unauthenticated' })) as never,
    deviceCodeLogins,
  });
  return { app, spawned, spawnLogin, verify, probe };
}

const makeTempDir = trackTempDirs();

describe('Muse credential-profile sign-in (#1942)', () => {
  test('lists Muse accounts with the device-code login its CLI advertises', async () => {
    const { app } = museRoutes();
    const res = await app.request('/agent/muse/accounts');
    expect(res.status).toBe(200);
    const body = await readJson<{
      data: {
        engine: string;
        accounts: Array<{ ref: string | null; login: string }>;
      };
    }>(res);
    expect(body.data.engine).toBe('muse');
    expect(body.data.accounts).toEqual([
      expect.objectContaining({ ref: null, login: 'unavailable' }),
      expect.objectContaining({ ref: 'profile-a', login: 'device-code' }),
    ]);
  });

  test('starts the bare `muse login` in the profile home, relays its code, and cancels it', async () => {
    const { app, spawned, spawnLogin, verify } = museRoutes();
    const profileDir = credentialProfileAppHomeDir('muse', 'profile-a');

    const started = await app.request(
      '/agent/muse/account-login?profileRef=profile-a',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(started.status).toBe(200);
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnLogin.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(command).toBe('muse');
    expect(args).toEqual(['login']);
    expect(options.env).toEqual({
      PATH: '/usr/bin',
      MUSE_NO_AUTO_UPDATE: '1',
      MUSE_LOGIN: '0',
      XDG_CONFIG_HOME: profileDir,
    });
    // The sign-in state was asked of the PROFILE home before anything ran.
    expect(verify).toHaveBeenCalledWith('muse', profileDir);
    expect(existsSync(profileDir)).toBe(true);

    spawned.emitPrompt();
    const read = await app.request(
      '/agent/muse/account-login?profileRef=profile-a',
    );
    const body = await readJson<{
      data: { login: Record<string, unknown> };
    }>(read);
    expect(body.data.login).toMatchObject({
      engine: 'muse',
      mechanism: 'device-code',
      phase: 'awaiting-approval',
      verificationUri: MUSE_DEVICE_CODE_EXPECTED.verificationUri,
      userCode: MUSE_DEVICE_CODE_EXPECTED.userCode,
    });

    const cancelled = await app.request(
      '/agent/muse/account-login?profileRef=profile-a',
      { method: 'DELETE' },
    );
    const cancelBody = await readJson<{
      data: { login: { phase: string } };
    }>(cancelled);
    expect(cancelBody.data.login.phase).toBe('cancelled');
    expect(spawned.stop).toHaveBeenCalledOnce();
  });

  test('the home Station signs in is the home a Muse session runs under', async () => {
    // The issue's core concern: a profile nothing reads. The session resolver
    // the runtime hands the Muse adapter must name the same directory the
    // login above wrote into.
    const resolve = createCredentialProfileAppHomeEnvResolver({
      engine: 'muse',
      loadConnectionSettings: async () => ({
        credentialRecovery: {
          profiles: [{ ref: 'profile-a' }],
          activeProfileRef: 'profile-a',
        },
      }),
    });
    await expect(resolve()).resolves.toEqual({
      profileRef: 'profile-a',
      env: {
        XDG_CONFIG_HOME: credentialProfileAppHomeDir('muse', 'profile-a'),
      },
    });
  });

  test('reports and imports the legacy Muse app home into its muse/ folder', async () => {
    const app = createAppHomeRoutes();
    const xdg = makeTempDir('station-fake-xdg-');
    const previous = process.env.XDG_CONFIG_HOME;
    const previousKey = process.env.META_API_KEY;
    process.env.XDG_CONFIG_HOME = xdg;
    // #1942: the user's ambient key belongs to their own Muse; it must not
    // read as the app home's sign-in.
    process.env.META_API_KEY = 'sk-ambient';
    try {
      mkdirSync(join(xdg, 'muse'), { recursive: true });
      writeFileSync(join(xdg, 'muse', 'settings.json'), '{"mcpServers":{}}');
      writeFileSync(join(xdg, 'muse', 'trust.json'), '{}');
      writeFileSync(join(xdg, 'muse', 'auth.json'), '{"providers":{}}');

      const before = await readJson<{
        data: { profileDir: string; authState: string };
      }>(await app.request('/agent/muse/app-home'));
      expect(before.data.profileDir).toBe(join(appHomesRootDir(), 'muse'));
      expect(before.data.authState).toBe('unauthenticated');

      const imported = await app.request('/agent/muse/app-home/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeCredentials: true }),
      });
      expect(imported.status).toBe(200);
      const museDir = join(appHomesRootDir(), 'muse', 'muse');
      expect(existsSync(join(museDir, 'settings.json'))).toBe(true);
      expect(existsSync(join(museDir, 'auth.json'))).toBe(true);
      // A folder-trust decision is never copied into a profile.
      expect(existsSync(join(museDir, 'trust.json'))).toBe(false);

      const after = await readJson<{ data: { authState: string } }>(
        await app.request('/agent/muse/app-home'),
      );
      expect(after.data.authState).toBe('authenticated');
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      if (previousKey === undefined) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = previousKey;
    }
  });
});
