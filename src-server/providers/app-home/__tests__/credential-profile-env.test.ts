import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  appHomeProfileDir,
  appHomesRootDir,
  ensureAppHomeProfile,
} from '../app-home-profiles.js';
import {
  CredentialProfileEnvUnavailableError,
  configuredEngineHomes,
  createCredentialProfileAppHomeEnvResolver,
  credentialProfileEnvForHome,
  credentialProfileRoutingFingerprint,
  credentialProfilesRouteAlike,
} from '../credential-profile-env.js';
import {
  credentialProfileAppHomeDir,
  credentialProfileStorageId,
  ensureCredentialProfileAppHome,
} from '../credential-profile-registry.js';

const makeTempDir = trackTempDirs();

async function tempHome(): Promise<string> {
  return makeTempDir('station-profile-env-');
}

const routed = {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
  ANTHROPIC_API_KEY: '',
};

describe('credential profile env resolver (#2966)', () => {
  test('an explicitly selected profile resolves to its overlay with its own home keys last', async () => {
    const homeDir = await tempHome();
    const resolve = createCredentialProfileAppHomeEnvResolver({
      engine: 'claude',
      homeDir,
      loadConnectionSettings: async () => ({
        credentialRecovery: {
          profiles: [{ ref: 'proxy', env: routed }],
        },
      }),
    });

    const resolved = await resolve('proxy');
    const env = resolved?.env;
    expect(resolved?.profileRef).toBe('proxy');

    const dir = credentialProfileAppHomeDir('claude', 'proxy', homeDir);
    expect(env).toEqual({
      ...routed,
      CLAUDE_CONFIG_DIR: dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
    });
    expect(Object.keys(env ?? {}).slice(-2)).toEqual([
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    ]);
    expect(existsSync(dir)).toBe(true);
  });

  test("the connection's configured active profile applies its overlay (codex home key)", async () => {
    const homeDir = await tempHome();
    const resolve = createCredentialProfileAppHomeEnvResolver({
      engine: 'codex',
      homeDir,
      loadConnectionSettings: async () => ({
        credentialRecovery: {
          profiles: [
            { ref: 'proxy', env: { OPENAI_BASE_URL: 'http://127.0.0.1:9' } },
          ],
          activeProfileRef: 'proxy',
        },
      }),
    });

    await expect(resolve()).resolves.toEqual({
      profileRef: 'proxy',
      env: {
        OPENAI_BASE_URL: 'http://127.0.0.1:9',
        CODEX_HOME: credentialProfileAppHomeDir('codex', 'proxy', homeDir),
      },
    });
  });

  test('a tampered persisted overlay fails closed with the typed error, no partial overlay, and no profile home', async () => {
    const homeDir = await tempHome();
    const warn = vi.fn();
    const resolve = createCredentialProfileAppHomeEnvResolver({
      engine: 'claude',
      homeDir,
      warn,
      loadConnectionSettings: async () => ({
        credentialRecovery: {
          profiles: [
            {
              ref: 'proxy',
              env: { ...routed, ANTHROPIC_AUTH_TOKEN: 'canary-secret' },
            },
          ],
          activeProfileRef: 'proxy',
        },
      }),
    });

    const failure = await resolve().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CredentialProfileEnvUnavailableError);
    expect(String((failure as Error).message)).not.toContain('canary-secret');
    // A server-side diagnostic names the storage id and variable, never the
    // raw ref or the value.
    expect(warn).toHaveBeenCalledTimes(1);
    const diagnostic = String(warn.mock.calls[0]?.[0]);
    expect(diagnostic).toContain(credentialProfileStorageId('claude', 'proxy'));
    expect(diagnostic).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(diagnostic).not.toContain('canary-secret');
    expect(diagnostic).not.toMatch(/\bproxy\b/);
    expect(
      existsSync(credentialProfileAppHomeDir('claude', 'proxy', homeDir)),
    ).toBe(false);
  });

  test('a normalized profile carrying the value-free marker fails closed with its names', async () => {
    const homeDir = await tempHome();
    const warn = vi.fn();
    const resolve = createCredentialProfileAppHomeEnvResolver({
      engine: 'codex',
      homeDir,
      warn,
      loadConnectionSettings: async () => ({
        credentialRecovery: {
          profiles: [
            { ref: 'proxy', envInvalid: { names: ['OPENAI_API_KEY'] } },
          ],
        },
      }),
    });

    const failure = await resolve('proxy').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CredentialProfileEnvUnavailableError);
    expect(
      (failure as CredentialProfileEnvUnavailableError).invalidVariableNames,
    ).toEqual(['OPENAI_API_KEY']);
    expect(String(warn.mock.calls[0]?.[0])).toContain('OPENAI_API_KEY');
    expect(
      existsSync(credentialProfileAppHomeDir('codex', 'proxy', homeDir)),
    ).toBe(false);
  });

  test('without a selected profile, a lookup failure still degrades to the global config', async () => {
    const warn = vi.fn();
    const resolve = createCredentialProfileAppHomeEnvResolver({
      engine: 'claude',
      homeDir: await tempHome(),
      warn,
      loadConnectionSettings: async () => {
        throw new Error('config unreadable');
      },
    });

    await expect(resolve()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('an invalid overlay routes alike with nothing, not even another invalid overlay', () => {
    const invalid = { env: { ANTHROPIC_AUTH_TOKEN: 'x' } };
    expect(credentialProfileRoutingFingerprint(invalid)).toBeUndefined();
    expect(credentialProfilesRouteAlike(invalid, invalid)).toBe(false);
    const marked = { envInvalid: { names: [] } };
    expect(credentialProfileRoutingFingerprint(marked)).toBeUndefined();
    expect(credentialProfilesRouteAlike(marked, marked)).toBe(false);
    expect(credentialProfilesRouteAlike(marked, {})).toBe(false);
    expect(credentialProfilesRouteAlike({}, undefined)).toBe(true);
  });

  test('routing fingerprint compares sorted env entries only', () => {
    expect(
      credentialProfileRoutingFingerprint({ env: { B: '2', A: '1' } }),
    ).toBe(credentialProfileRoutingFingerprint({ env: { A: '1', B: '2' } }));
    expect(credentialProfileRoutingFingerprint(undefined)).toBe(
      credentialProfileRoutingFingerprint({}),
    );
    expect(credentialProfileRoutingFingerprint({ env: { A: '' } })).not.toBe(
      credentialProfileRoutingFingerprint({}),
    );
    expect(credentialProfileRoutingFingerprint({ env: { A: '1' } })).not.toBe(
      credentialProfileRoutingFingerprint({ env: { A: '2' } }),
    );
  });
});

describe('configuredEngineHomes', () => {
  test('lists the connection home, the legacy app home and every profile home without creating them', async () => {
    const homeDir = await tempHome();
    const homes = await configuredEngineHomes({
      engine: 'codex',
      homeDir,
      loadConnectionSettings: async () => ({
        config: { configHome: '/srv/codex-home', useAppHome: true },
        credentialRecovery: {
          profiles: [{ ref: 'work' }, { ref: 'personal' }],
        },
      }),
    });

    // An explicit configHome outranks useAppHome, so no legacy app home.
    expect(homes).toEqual([
      '/srv/codex-home',
      credentialProfileAppHomeDir('codex', 'work', homeDir),
      credentialProfileAppHomeDir('codex', 'personal', homeDir),
    ]);
    expect(
      existsSync(credentialProfileAppHomeDir('codex', 'work', homeDir)),
    ).toBe(false);

    const legacy = await configuredEngineHomes({
      engine: 'codex',
      homeDir,
      loadConnectionSettings: async () => ({ config: { useAppHome: true } }),
    });
    expect(legacy).toEqual([appHomeProfileDir('codex', homeDir)]);
    expect(existsSync(appHomeProfileDir('codex', homeDir))).toBe(false);

    expect(
      await configuredEngineHomes({
        engine: 'codex',
        homeDir,
        loadConnectionSettings: async () => undefined,
      }),
    ).toEqual([]);
  });
});

describe('credentialProfileEnvForHome', () => {
  test('maps a profile home back to its overlay, and no other home to one', async () => {
    const homeDir = await tempHome();
    const settings = {
      credentialRecovery: {
        profiles: [
          {
            ref: 'proxy',
            env: { OPENAI_BASE_URL: 'http://127.0.0.1:9', OPENAI_API_KEY: '' },
          },
          { ref: 'plain' },
        ],
      },
    };
    const loadConnectionSettings = vi.fn(async () => settings);
    const options = {
      engine: 'codex' as const,
      homeDir,
      loadConnectionSettings,
    };
    const proxyHome = (
      await ensureCredentialProfileAppHome('codex', 'proxy', { homeDir })
    ).dir;
    const plainHome = (
      await ensureCredentialProfileAppHome('codex', 'plain', { homeDir })
    ).dir;

    expect(
      await credentialProfileEnvForHome(options, realpathSync(proxyHome)),
    ).toEqual({
      OPENAI_BASE_URL: 'http://127.0.0.1:9',
      OPENAI_API_KEY: '',
    });
    expect(
      await credentialProfileEnvForHome(options, realpathSync(plainHome)),
    ).toEqual({});
    loadConnectionSettings.mockClear();
    // The default home is no profile's: answered without reading configuration.
    expect(
      await credentialProfileEnvForHome(options, '/Users/someone/.codex'),
    ).toBeUndefined();
    expect(loadConnectionSettings).not.toHaveBeenCalled();
  });

  test('an invalid saved overlay refuses rather than running on the bare home', async () => {
    const homeDir = await tempHome();
    const home = (
      await ensureCredentialProfileAppHome('codex', 'broken', { homeDir })
    ).dir;
    await expect(
      credentialProfileEnvForHome(
        {
          engine: 'codex',
          homeDir,
          loadConnectionSettings: async () => ({
            credentialRecovery: {
              profiles: [
                { ref: 'broken', env: { OPENAI_API_KEY: 'not-a-real-key' } },
              ],
            },
          }),
        },
        realpathSync(home),
      ),
    ).rejects.toBeInstanceOf(CredentialProfileEnvUnavailableError);
  });

  test("a home under the app homes that is no current profile's (a deleted profile) refuses; the legacy home does not", async () => {
    const homeDir = await tempHome();
    const deletedHome = (
      await ensureCredentialProfileAppHome('codex', 'deleted', { homeDir })
    ).dir;
    const legacyHome = (await ensureAppHomeProfile('codex', { homeDir })).dir;
    const options = {
      engine: 'codex' as const,
      homeDir,
      // The profile was deleted; its directory stays behind.
      loadConnectionSettings: async () => ({
        credentialRecovery: { profiles: [{ ref: 'other' }] },
      }),
    };
    await expect(
      credentialProfileEnvForHome(options, realpathSync(deletedHome)),
    ).rejects.toBeInstanceOf(CredentialProfileEnvUnavailableError);
    await expect(
      credentialProfileEnvForHome(options, realpathSync(legacyHome)),
    ).resolves.toBeUndefined();
  });

  test('refusing an invalid overlay logs the profile storage id and variable names only', async () => {
    const homeDir = await tempHome();
    const home = (
      await ensureCredentialProfileAppHome('codex', 'broken-ref', { homeDir })
    ).dir;
    const warn = vi.fn();
    await expect(
      credentialProfileEnvForHome(
        {
          engine: 'codex',
          homeDir,
          warn,
          loadConnectionSettings: async () => ({
            credentialRecovery: {
              profiles: [
                { ref: 'broken-ref', env: { OPENAI_API_KEY: 'value-canary' } },
              ],
            },
          }),
        },
        realpathSync(home),
      ),
    ).rejects.toBeInstanceOf(CredentialProfileEnvUnavailableError);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(
      credentialProfileStorageId('codex', 'broken-ref'),
    );
    expect(message).toContain('OPENAI_API_KEY');
    expect(message).not.toContain('value-canary');
    expect(message).not.toContain('broken-ref');
  });

  test("a connection config home placed under the app homes is the connection's, not an orphaned profile home", async () => {
    const homeDir = await tempHome();
    const configHome = join(appHomesRootDir(homeDir), 'my-codex');
    mkdirSync(configHome, { recursive: true });
    await expect(
      credentialProfileEnvForHome(
        {
          engine: 'codex',
          homeDir,
          loadConnectionSettings: async () => ({
            config: { configHome },
            credentialRecovery: { profiles: [{ ref: 'other' }] },
          }),
        },
        realpathSync(configHome),
      ),
    ).resolves.toBeUndefined();
  });
});
