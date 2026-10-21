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
  launchEnv: { GOOSE_DISABLE_KEYRING: '1', DROID_DISABLE_AUTO_UPDATE: 'true' },
  platforms: ['darwin', 'linux'] as Array<'darwin' | 'linux'>,
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
          GOOSE_API_KEY: 'x',
          DROID_SESSION_AUTH: 'x',
          FACTORY_TOKEN: 'x',
          // KEYRING is not KEY: this one is allowed.
          GOOSE_DISABLE_KEYRING: '1',
        },
      }),
    ).toEqual([
      'launchEnv.GOOSE_API_KEY: credentials never go in launchEnv',
      'launchEnv.DROID_SESSION_AUTH: credentials never go in launchEnv',
      'launchEnv.FACTORY_TOKEN: credentials never go in launchEnv',
    ]);
  });

  test('refuses a launch variable the descriptor itself names as a credential', () => {
    expect(
      validateACPEngineDescriptor({
        launchEnv: { GOOSE_LOGIN: 'x' },
        auth: { credentialEnvVars: ['GOOSE_LOGIN'] },
      }),
    ).toEqual(['launchEnv.GOOSE_LOGIN: credentials never go in launchEnv']);
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
        launchEnv: Object.fromEntries(
          names(17).map((name) => [`GOOSE_${name}`, '1']),
        ),
      }),
    ).toEqual(['launchEnv may set at most 16 variables']);
  });

  test('refuses loader, path, proxy and runtime variables: only engine-scoped prefixes are allowed', () => {
    const refused = [
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'HTTPS_PROXY',
      'http_proxy',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'PATH',
      'HOME',
      'PYTHONPATH',
      'ELECTRON_RUN_AS_NODE',
      'OPENCODE_CONFIG_CONTENT',
    ];
    expect(
      validateACPEngineDescriptor({
        launchEnv: Object.fromEntries(refused.map((name) => [name, '1'])),
      }),
    ).toEqual(
      refused.map(
        (name) => `launchEnv.${name}: not an engine-scoped launch variable`,
      ),
    );
    expect(
      validateACPEngineDescriptor({
        launchEnv: {
          GOOSE_DISABLE_KEYRING: '1',
          DROID_DISABLE_AUTO_UPDATE: 'true',
          FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
        },
      }),
    ).toEqual([]);
  });

  test('refuses control characters, line breaks and bidi overrides in shown text', () => {
    expect(
      validateACPEngineDescriptor({
        install: {
          darwin: { command: 'brew install engine\nrm -rf ~' },
          linux: { command: 'curl https://x.example | sh\u202E' },
          win32: { note: 'Run\u0007 it', docsUrl: 'https://x.example' },
        },
        auth: { signInHint: 'Sign in\u2066 here' },
      }),
    ).toEqual([
      'install.darwin.command is not valid',
      'install.linux.command is not valid',
      'install.win32.note is not valid',
      'auth.signInHint is not valid',
    ]);
  });

  test('refuses unsafe or empty shown names, descriptions and source names', () => {
    expect(
      validateACPEngineDescriptor({
        name: 'Engine\u202E',
        description: 'one\ntwo',
        sourceName: ' ',
      }),
    ).toEqual([
      'name is not valid',
      'description is not valid',
      'sourceName is not valid',
    ]);
    expect(
      validateACPEngineDescriptor({ name: 'Engine', description: 'Fine.' }),
    ).toEqual([]);
  });

  test('refuses an unknown platform in platforms', () => {
    expect(
      validateACPEngineDescriptor({ platforms: ['darwin', 'beos'] as never }),
    ).toEqual(['platforms[1]: unknown platform']);
  });

  test('refuses a malformed status command and env names', () => {
    expect(
      validateACPEngineDescriptor({
        launchEnv: { 'GOOSE-NOT-A-NAME': '1' },
        auth: { statusCommand: [], credentialEnvVars: ['1BAD'] },
      }),
    ).toEqual([
      'launchEnv.GOOSE-NOT-A-NAME: not a variable name',
      'auth.statusCommand must be a list of 1-16 entries',
      'auth.credentialEnvVars[0] is not valid',
    ]);
  });

  test('accepts a status rule and terms notice, and refuses a rule that reads nothing', () => {
    expect(
      validateACPEngineDescriptor({
        auth: {
          statusCommand: ['engine', 'status', '--json'],
          statusRule: {
            signedInJsonField: 'isAuthenticated',
            signedOutText: ['Not logged in'],
            signedOutExitCodes: [3],
          },
          subscriptionTermsNotices: [
            {
              provider: 'Anthropic',
              termsUrl: 'https://example.com/terms',
              authMethodIds: ['login'],
            },
          ],
        },
      }),
    ).toEqual([]);
    expect(
      validateACPEngineDescriptor({
        auth: { statusCommand: ['engine', 'status'], statusRule: {} },
      }),
    ).toEqual(['auth.statusRule reads nothing']);
  });

  test('refuses a rule without a command, a bad field or exit code, and a non-https terms link', () => {
    expect(
      validateACPEngineDescriptor({
        auth: {
          statusRule: {
            signedInJsonField: 'a.b',
            signedOutExitCodes: [0],
            exitZeroMeansSignedIn: 'yes' as never,
            extra: true,
          } as never,
          subscriptionTermsNotices: [
            { provider: 'Anthropic', termsUrl: 'http://example.com/terms' },
          ],
        },
      }),
    ).toEqual([
      'auth.statusRule needs auth.statusCommand',
      'auth.statusRule: unknown field extra',
      'auth.statusRule.signedInJsonField must be a field name',
      'auth.statusRule.signedOutExitCodes must be exit codes 1-255',
      'auth.statusRule.exitZeroMeansSignedIn must be a boolean',
      'auth.subscriptionTermsNotices[0].termsUrl must be an https URL',
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
