import { existsSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  CredentialProfileEnvUnavailableError,
  createCredentialProfileAppHomeEnvResolver,
  credentialProfileRoutingFingerprint,
  credentialProfilesRouteAlike,
} from '../credential-profile-env.js';
import {
  credentialProfileAppHomeDir,
  credentialProfileStorageId,
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
  test('an explicitly selected profile resolves to its overlay with its own home key last', async () => {
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
    expect(env).toEqual({ ...routed, CLAUDE_CONFIG_DIR: dir });
    expect(Object.keys(env ?? {}).at(-1)).toBe('CLAUDE_CONFIG_DIR');
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
