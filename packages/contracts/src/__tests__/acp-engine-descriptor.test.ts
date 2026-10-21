import { describe, expect, test } from 'vitest';
import {
  installRecipeForPlatform,
  validateACPEngineDescriptor,
} from '../acp.js';

const valid = {
  homepageUrl: 'https://example.com/engine',
  install: {
    darwin: {
      command: 'brew install engine',
      docsUrl: 'https://example.com/install',
    },
    linux: { note: 'No Linux build yet.' },
    win32: { docsUrl: 'https://example.com/install#windows' },
  },
  launchEnv: { GOOSE_DISABLE_KEYRING: '1', ENGINE_AUTO_UPDATE: 'false' },
  auth: {
    statusCommand: ['engine', 'status'],
    signInHint: 'Run engine login.',
    credentialEnvVars: ['ENGINE_API_KEY'],
    hiddenAuthMethodIds: ['terminal-login'],
  },
};

describe('validateACPEngineDescriptor', () => {
  test('accepts a complete descriptor and an entry with none of the fields', () => {
    expect(validateACPEngineDescriptor(valid)).toEqual([]);
    expect(validateACPEngineDescriptor({})).toEqual([]);
  });

  test('refuses a platform it does not know', () => {
    expect(
      validateACPEngineDescriptor({
        install: { freebsd: { command: 'pkg install engine' } } as never,
      }),
    ).toEqual(['install.freebsd: unknown platform']);
  });

  test('refuses URLs that are not https, or not URLs', () => {
    expect(
      validateACPEngineDescriptor({
        homepageUrl: 'http://example.com',
        install: {
          darwin: { docsUrl: 'javascript:alert(1)' },
          linux: { docsUrl: 'example.com/install' },
        },
      }),
    ).toEqual([
      'homepageUrl must be an https URL',
      'install.darwin.docsUrl must be an https URL',
      'install.linux.docsUrl must be an https URL',
    ]);
  });

  test('refuses an empty recipe and fields a recipe does not have', () => {
    expect(
      validateACPEngineDescriptor({
        install: {
          darwin: {},
          linux: { command: 'x', run: true } as never,
        },
      }),
    ).toEqual([
      'install.darwin needs a command, docsUrl or note',
      'install.linux: unknown field run',
    ]);
  });

  test('refuses credential-shaped launch variables, by name segment', () => {
    expect(
      validateACPEngineDescriptor({
        launchEnv: {
          ENGINE_API_KEY: 'x',
          AUGMENT_SESSION_AUTH: 'x',
          GH_TOKEN: 'x',
          // KEYRING is not KEY: this one is allowed.
          GOOSE_DISABLE_KEYRING: '1',
        },
      }),
    ).toEqual([
      'launchEnv.ENGINE_API_KEY: credentials never go in launchEnv',
      'launchEnv.AUGMENT_SESSION_AUTH: credentials never go in launchEnv',
      'launchEnv.GH_TOKEN: credentials never go in launchEnv',
    ]);
  });

  test('refuses a launch variable the descriptor itself names as a credential', () => {
    expect(
      validateACPEngineDescriptor({
        launchEnv: { ENGINE_LOGIN: 'x' },
        auth: { credentialEnvVars: ['ENGINE_LOGIN'] },
      }),
    ).toEqual(['launchEnv.ENGINE_LOGIN: credentials never go in launchEnv']);
  });

  test('refuses text one character over the bound, accepts it at the bound', () => {
    // 400 is ACP_DESCRIPTOR_TEXT_MAX.
    const atBound = 'a'.repeat(400);
    expect(
      validateACPEngineDescriptor({ install: { darwin: { note: atBound } } }),
    ).toEqual([]);
    expect(
      validateACPEngineDescriptor({
        install: { darwin: { note: `${atBound}a` } },
      }),
    ).toEqual(['install.darwin.note is not valid']);
  });

  test('refuses a list one entry over the bound', () => {
    // 16 is ACP_DESCRIPTOR_LIST_MAX.
    const names = (count: number) =>
      Array.from({ length: count }, (_, i) => `ENGINE_VAR_${i}`);
    expect(
      validateACPEngineDescriptor({ auth: { credentialEnvVars: names(16) } }),
    ).toEqual([]);
    expect(
      validateACPEngineDescriptor({ auth: { credentialEnvVars: names(17) } }),
    ).toEqual(['auth.credentialEnvVars must be a list of 1-16 entries']);
    expect(
      validateACPEngineDescriptor({
        launchEnv: Object.fromEntries(names(17).map((name) => [name, '1'])),
      }),
    ).toEqual(['launchEnv may set at most 16 variables']);
  });

  test('refuses a malformed status command and env names', () => {
    expect(
      validateACPEngineDescriptor({
        launchEnv: { 'NOT-A-NAME': '1' },
        auth: { statusCommand: [], credentialEnvVars: ['1BAD'] },
      }),
    ).toEqual([
      'launchEnv.NOT-A-NAME: not a variable name',
      'auth.statusCommand must be a list of 1-16 entries',
      'auth.credentialEnvVars[0] is not valid',
    ]);
  });
});

describe('installRecipeForPlatform', () => {
  test('returns the recipe for a known platform and nothing for another', () => {
    expect(installRecipeForPlatform(valid.install, 'darwin')).toEqual(
      valid.install.darwin,
    );
    expect(installRecipeForPlatform(valid.install, 'aix')).toBeUndefined();
    expect(installRecipeForPlatform(undefined, 'darwin')).toBeUndefined();
  });
});
