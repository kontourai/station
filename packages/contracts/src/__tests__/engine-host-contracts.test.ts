import { describe, expect, test } from 'vitest';
import { engineCommandRequestParams } from '../engine-commands.js';
import {
  argvDelegatesTo,
  engineCredentialBucketKey,
} from '../engine-credential-provider.js';
import {
  type EngineSecretStorageBinding,
  isPersistedEngineSecretKey,
  readEngineSecretRequest,
} from '../engine-secret-storage.js';
import { validateManagedInstallPin } from '../managed-engine-install.js';

const binding: EngineSecretStorageBinding = {
  id: 'kiro.mcp-grant-storage',
  methods: { get: 'x/get', store: 'x/store', delete: 'x/delete' },
  announce: { metaNamespace: 'x', flag: 'secretStorage' },
  keyPattern: /^ns\.[0-9a-f]{4}\.(client|tokens|verifier|discovery)$/,
  persistedKinds: ['client', 'tokens'],
  maxValueChars: 8,
  scope: 'connection-profile',
  evidence: 'test',
};

describe('readEngineSecretRequest', () => {
  test('reads each method of the binding', () => {
    expect(
      readEngineSecretRequest(binding, 'x/get', { key: 'ns.abcd.client' }),
    ).toEqual({
      op: 'get',
      key: 'ns.abcd.client',
    });
    expect(
      readEngineSecretRequest(binding, 'x/store', {
        key: 'ns.abcd.tokens',
        value: '12345678',
      }),
    ).toEqual({ op: 'store', key: 'ns.abcd.tokens', value: '12345678' });
    expect(
      readEngineSecretRequest(binding, 'x/delete', { key: 'ns.abcd.verifier' }),
    ).toEqual({ op: 'delete', key: 'ns.abcd.verifier' });
  });

  test.each([
    ['another method', 'x/list', { key: 'ns.abcd.client' }, 'unknown-method'],
    [
      'a key outside the namespace',
      'x/get',
      { key: 'other.abcd.client' },
      'key-refused',
    ],
    [
      'a key with a suffix after the kind',
      'x/get',
      { key: 'ns.abcd.client.x' },
      'key-refused',
    ],
    [
      'a value one over the cap',
      'x/store',
      { key: 'ns.abcd.client', value: '123456789' },
      'value-too-long',
    ],
    [
      'a non-string value',
      'x/store',
      { key: 'ns.abcd.client', value: 1 },
      'malformed',
    ],
    ['params that are a list', 'x/get', ['ns.abcd.client'], 'malformed'],
  ])('refuses %s', (_, method, params, refused) => {
    expect(readEngineSecretRequest(binding, method, params)).toEqual({
      refused,
    });
  });

  test('persists only the binding’s persisted kinds', () => {
    expect(isPersistedEngineSecretKey(binding, 'ns.abcd.tokens')).toBe(true);
    expect(isPersistedEngineSecretKey(binding, 'ns.abcd.verifier')).toBe(false);
  });
});

describe('engine credential helpers', () => {
  test('argvDelegatesTo matches a contiguous exact run only', () => {
    const argv = [
      '--experimental-wasm-modules',
      'acp-server.js',
      '--transport=stdio',
      '--auth=acp-callback',
    ];
    expect(argvDelegatesTo(argv, ['--auth=acp-callback'])).toBe(true);
    expect(argvDelegatesTo(argv, ['--auth', 'acp-callback'])).toBe(false);
    expect(
      argvDelegatesTo(['--auth', 'acp-callback'], ['--auth', 'acp-callback']),
    ).toBe(true);
    expect(argvDelegatesTo(argv, [])).toBe(false);
  });

  test('a bucket names kind, connection and profile, and refuses a separator', () => {
    expect(
      engineCredentialBucketKey('kiro.oidc-access-token', {
        connectionId: 'conn-1',
        credentialProfileRef: '',
      }),
    ).toBe('kiro.oidc-access-token:conn-1:default');
    expect(() =>
      engineCredentialBucketKey('kiro.oidc-access-token', {
        connectionId: 'a:b',
        credentialProfileRef: 'default',
      }),
    ).toThrow();
  });
});

describe('validateManagedInstallPin', () => {
  const pin = {
    installId: 'kas-bundle',
    version: '0.66.104',
    manifestUrl: 'https://example.com/kas/0.66.104/manifest.json',
    manifestSha256: 'a'.repeat(64),
    platforms: ['darwin-universal', 'linux-x64'],
  };

  test('accepts a complete pin', () => {
    expect(validateManagedInstallPin(pin)).toEqual([]);
  });

  test('refuses a non-https manifest, a short digest and electron-builtin', () => {
    expect(
      validateManagedInstallPin({
        ...pin,
        manifestUrl: 'http://example.com/manifest.json',
        manifestSha256: 'abc',
        runtimeBuilds: [
          {
            runtime: 'electron-builtin',
            version: '1',
            platform: 'linux-x64',
            url: 'https://example.com/node.tar.gz',
            sha256: 'b'.repeat(64),
            size: 10,
          },
        ],
      }),
    ).toEqual([
      'manifestUrl must be an https URL',
      'manifestSha256 must be 64 lowercase hex characters',
      'runtimeBuilds[0]: electron-builtin is refused',
    ]);
  });
});

describe('engineCommandRequestParams', () => {
  test('builds each params shape from the invocation', () => {
    const invocation = { name: 'compact', args: ' now please ' };
    expect(engineCommandRequestParams('session', 's1', invocation)).toEqual({
      sessionId: 's1',
    });
    expect(
      engineCommandRequestParams('session+subcommand', 's1', invocation),
    ).toEqual({
      sessionId: 's1',
      subcommand: 'now',
    });
    expect(
      engineCommandRequestParams('session+command-object', 's1', invocation),
    ).toEqual({
      sessionId: 's1',
      command: { command: 'compact', args: { value: 'now please' } },
    });
    expect(
      engineCommandRequestParams('session+command-object', 's1', {
        name: 'help',
        args: '',
      }),
    ).toEqual({ sessionId: 's1', command: { command: 'help', args: {} } });
  });

  test('a default subcommand fills in an empty one; fixed params ride along', () => {
    expect(
      engineCommandRequestParams(
        'session+subcommand',
        's1',
        { name: 'context', args: '  ' },
        { defaultSubcommand: 'show' },
      ),
    ).toEqual({ sessionId: 's1', subcommand: 'show' });
    expect(
      engineCommandRequestParams(
        'session',
        's1',
        { name: 'settings', args: '' },
        { fixedParams: { observer: 'session', sessionId: 'spoofed' } },
      ),
    ).toEqual({ observer: 'session', sessionId: 's1' });
  });
});
