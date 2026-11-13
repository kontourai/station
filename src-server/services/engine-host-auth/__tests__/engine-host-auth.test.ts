import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineHostAuthPolicy } from '@kontourai/station-contracts/engine-credential-provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  AcpInboundExtensionRegistry,
  createAcpInboundExtensionRequestHandler,
  ENGINE_CREDENTIAL_REFUSED_CODE,
  REVIEWED_ENGINE_CREDENTIAL_BINDINGS,
  REVIEWED_ENGINE_SECRET_BINDINGS,
} from '../../acp/acp-inbound-extension-policy.js';
import { BUILDER_ID_PROFILE_ARN } from '../kiro-oidc/oidc.js';
import { installEngineHostAuthResponders } from '../responder.js';
import { EngineHostAuthService, registerEngineHostAuth } from '../service.js';
import { type OidcStub, startOidcStub } from './fixtures/oidc-stub.js';

const makeTempDir = trackTempDirs();

const KIRO = REVIEWED_ENGINE_CREDENTIAL_BINDINGS.find(
  (binding) => binding.id === 'kiro.get-access-token',
)!;
const SECRETS = REVIEWED_ENGINE_SECRET_BINDINGS[0]!;
const SCOPE = {
  connectionId: 'kiro-kas-bundle',
  credentialProfileRef: 'default',
};
const BUNDLE_ARGV = [
  '--experimental-wasm-modules',
  '{script}',
  '--transport=stdio',
  '--auth=acp-callback',
];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  registerEngineHostAuth(null);
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(
  options: {
    policy?: () => EngineHostAuthPolicy;
    now?: () => number;
    oidcRequestTimeoutMs?: number;
  } = {},
) {
  const stub: OidcStub = await startOidcStub();
  const home = makeTempDir('engine-host-auth-');
  cleanups.push(() => stub.close());
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const delays: number[] = [];
  const service = new EngineHostAuthService({
    homeDir: home,
    policy: options.policy ?? (() => 'allowed'),
    endpoints: stub.endpoints,
    ...(options.now ? { now: options.now } : {}),
    ...(options.oidcRequestTimeoutMs !== undefined
      ? { oidcRequestTimeoutMs: options.oidcRequestTimeoutMs }
      : {}),
    schedule: (run, delayMs) => {
      delays.push(delayMs);
      const timer = setTimeout(run, 0);
      return () => clearTimeout(timer);
    },
    launchFacts: (connection) =>
      connection.command === 'station-managed:kiro-kas'
        ? { builtinDescriptor: true, argv: BUNDLE_ARGV }
        : { builtinDescriptor: false, argv: [...(connection.args ?? [])] },
  });
  return { stub, home, service, delays };
}

async function signInBuilderId(
  service: EngineHostAuthService,
  stub: OidcStub,
  token: { accessToken: string; refreshToken?: string; expiresIn?: number },
) {
  stub.deviceAnswers.push(token);
  await service.startLogin(SCOPE, { identity: 'builder-id' });
  await vi.waitFor(() => expect(service.login(SCOPE)?.phase).toBe('completed'));
}

describe('Kiro device sign-in against a stub SSO-OIDC', () => {
  test('removing the connection while a token poll is in flight keeps no credential', async () => {
    const { stub, service } = await setup();
    stub.deviceAnswers.push({
      accessToken: 'late-access',
      refreshToken: 'late-refresh',
      delayMs: 400,
    });
    await service.startLogin(SCOPE, { identity: 'builder-id' });
    await vi.waitFor(() =>
      expect(
        stub.requests.some(
          (r) =>
            r.body.grantType === 'urn:ietf:params:oauth:grant-type:device_code',
        ),
      ).toBe(true),
    );
    await service.removeConnection(SCOPE.connectionId);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(service.vault.read('kiro.oidc-access-token', SCOPE)).toBeUndefined();
    expect(service.status(SCOPE).state).toBe('signed-out');
  });

  test('Builder ID: pending, then slow_down widens the interval, then the credential lands in the vault', async () => {
    const { stub, service, delays } = await setup();
    stub.deviceAnswers.push('authorization_pending', 'slow_down', {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
    const started = await service.startLogin(SCOPE, { identity: 'builder-id' });
    expect(started).toMatchObject({
      kind: 'kiro.oidc-access-token',
      phase: 'awaiting-approval',
      userCode: 'ABCD-EFGH',
      verificationUri:
        'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
    });
    await vi.waitFor(() =>
      expect(service.login(SCOPE)?.phase).toBe('completed'),
    );
    // interval 1s; slow_down adds five seconds to every later poll.
    expect(delays).toEqual([1000, 1000, 6000]);
    expect(
      stub.requests.filter((r) => r.path.endsWith('/client/register')),
    ).toHaveLength(1);
    expect(
      stub.requests.find((r) => r.path.endsWith('/client/register'))?.body,
    ).toMatchObject({ clientName: 'Station', clientType: 'public' });
    expect(service.status(SCOPE)).toMatchObject({
      owner: 'station',
      state: 'signed-in',
      identity: { kind: 'builder-id', region: 'us-east-1' },
    });
  });

  test('expired_token fails the attempt and stores nothing', async () => {
    const { stub, service } = await setup();
    stub.deviceAnswers.push('authorization_pending', 'expired_token');
    await service.startLogin(SCOPE, { identity: 'builder-id' });
    await vi.waitFor(() => expect(service.login(SCOPE)?.phase).toBe('failed'));
    expect(service.login(SCOPE)?.reason).toMatch(/expired/);
    expect(service.status(SCOPE).state).toBe('signed-out');
  });

  test('Identity Center takes the start URL and region, and resolves the profile from the control plane', async () => {
    const { stub, service } = await setup();
    stub.profiles = [
      'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC123',
    ];
    stub.deviceAnswers.push({
      accessToken: 'idc-access',
      refreshToken: 'idc-refresh',
    });
    await service.startLogin(SCOPE, {
      identity: 'identity-center',
      startUrl: 'https://acme.awsapps.com/start/',
      region: 'eu-central-1',
    });
    await vi.waitFor(() =>
      expect(service.login(SCOPE)?.phase).toBe('completed'),
    );
    expect(
      stub.requests.find((r) => r.path.endsWith('/device_authorization')),
    ).toMatchObject({
      path: '/oidc/eu-central-1/device_authorization',
      body: { startUrl: 'https://acme.awsapps.com/start' },
    });
    const issued = await service.issuerFor(SCOPE).issue(KIRO);
    expect(issued).toEqual({
      kind: 'issued',
      issue: {
        accessToken: 'idc-access',
        expiresAt: expect.any(String),
        attributes: {
          profileArn:
            'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC123',
          provider: 'Enterprise',
        },
      },
    });
  });

  test('an Identity Center start URL that is not https is refused before any request', async () => {
    const { stub, service } = await setup();
    await expect(
      service.startLogin(SCOPE, {
        identity: 'identity-center',
        startUrl: 'http://acme.awsapps.com/start',
        region: 'us-east-1',
      }),
    ).rejects.toThrow(/access portal URL/);
    expect(stub.requests).toEqual([]);
  });
});

describe('the vault issuer', () => {
  test('issues the access token and expiry only, with the Builder ID profile', async () => {
    const { stub, service } = await setup();
    await signInBuilderId(service, stub, {
      accessToken: 'access-1',
      refreshToken: 'refresh-secret-1',
    });
    const issued = await service.issuerFor(SCOPE).issue(KIRO);
    expect(issued).toEqual({
      kind: 'issued',
      issue: {
        accessToken: 'access-1',
        expiresAt: expect.any(String),
        attributes: {
          profileArn: BUILDER_ID_PROFILE_ARN,
          provider: 'BuilderId',
        },
      },
    });
    const text = JSON.stringify(issued);
    expect(text).not.toContain('refresh-secret-1');
    expect(text).not.toContain('stub-client-secret');
  });

  test('a token inside the refresh margin is refreshed once for concurrent requests (single-flight)', async () => {
    let now = Date.now();
    const { stub, service } = await setup({ now: () => now });
    await signInBuilderId(service, stub, {
      accessToken: 'access-old',
      refreshToken: 'refresh-1',
      expiresIn: 600,
    });
    now += 8 * 60 * 1000; // two minutes left: inside the three-minute margin
    stub.refreshAnswers.push({
      accessToken: 'access-new',
      refreshToken: 'refresh-2',
      delayMs: 50,
    });
    const issuer = service.issuerFor(SCOPE);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => issuer.issue(KIRO)),
    );
    expect(
      results.map((r) =>
        r.kind === 'issued' ? r.issue.accessToken : r.reason,
      ),
    ).toEqual(Array(5).fill('access-new'));
    expect(
      stub.requests.filter((r) => r.body.grantType === 'refresh_token'),
    ).toHaveLength(1);
    expect(service.status(SCOPE).issueCount24h).toBe(1);
  });

  test('a refresh refused with invalid_grant surfaces as refresh-rejected and is not retried', async () => {
    let now = Date.now();
    const { stub, service } = await setup({ now: () => now });
    await signInBuilderId(service, stub, {
      accessToken: 'access-old',
      refreshToken: 'refresh-dead',
      expiresIn: 600,
    });
    now += 9 * 60 * 1000;
    stub.refreshAnswers.push('invalid_grant');
    const issuer = service.issuerFor(SCOPE);
    expect(await issuer.issue(KIRO)).toEqual({
      kind: 'refused',
      reason: 'refresh-rejected',
    });
    expect(service.status(SCOPE).state).toBe('refresh-rejected');
    expect(await issuer.issue(KIRO)).toEqual({
      kind: 'refused',
      reason: 'refresh-rejected',
    });
    expect(
      stub.requests.filter((r) => r.body.grantType === 'refresh_token'),
    ).toHaveLength(1);
  });

  test('a refresh endpoint that never answers is abandoned: unavailable, no token, lock released', async () => {
    let now = Date.now();
    const { stub, service } = await setup({
      now: () => now,
      oidcRequestTimeoutMs: 200,
    });
    await signInBuilderId(service, stub, {
      accessToken: 'access-old',
      refreshToken: 'refresh-1',
      expiresIn: 600,
    });
    now += 9 * 60 * 1000;
    stub.refreshAnswers.push({
      accessToken: 'access-late',
      refreshToken: 'refresh-2',
      delayMs: 3_000,
    });
    const issuer = service.issuerFor(SCOPE);
    const started = Date.now();
    const result = await issuer.issue(KIRO);
    expect(result).toEqual({ kind: 'refused', reason: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.stringify(result)).not.toMatch(/access|refresh-/);
    // The refresh lock was released: the next issue refreshes again.
    stub.refreshAnswers.push({
      accessToken: 'access-new',
      refreshToken: 'refresh-3',
    });
    const next = await issuer.issue(KIRO);
    expect(next.kind === 'issued' ? next.issue.accessToken : next).toBe(
      'access-new',
    );
  });

  test('re-handing the unchanged cached token is not counted against the hourly cap', async () => {
    const { stub, service } = await setup();
    await signInBuilderId(service, stub, {
      accessToken: 'a',
      refreshToken: 'r',
    });
    const issuer = service.issuerFor(SCOPE);
    // Probes and relaunches each ask once; none of them changes the token.
    for (let i = 0; i < 100; i++)
      expect((await issuer.issue(KIRO)).kind).toBe('issued');
    expect(service.status(SCOPE).issueCount24h).toBe(1);
  });

  test('the thirty-first issue in an hour that refreshes is refused rate-limited', async () => {
    let now = Date.now();
    const { stub, service } = await setup({ now: () => now });
    await signInBuilderId(service, stub, {
      accessToken: 'access-0',
      refreshToken: 'r',
      expiresIn: 60, // inside the refresh margin: every issue refreshes
    });
    const issuer = service.issuerFor(SCOPE);
    for (let i = 1; i <= 31; i++)
      stub.refreshAnswers.push({ accessToken: `access-${i}`, expiresIn: 60 });
    for (let i = 1; i <= 30; i++) {
      now += 1_000;
      const result = await issuer.issue(KIRO);
      expect(result.kind === 'issued' ? result.issue.accessToken : result).toBe(
        `access-${i}`,
      );
    }
    now += 1_000;
    expect(await issuer.issue(KIRO)).toEqual({
      kind: 'refused',
      reason: 'rate-limited',
    });
    expect(
      stub.requests.filter((r) => r.body.grantType === 'refresh_token'),
    ).toHaveLength(30);
  });

  test('managed policy off refuses every issue', async () => {
    let policy: EngineHostAuthPolicy = 'allowed';
    const { stub, service } = await setup({ policy: () => policy });
    await signInBuilderId(service, stub, {
      accessToken: 'a',
      refreshToken: 'r',
    });
    policy = 'off';
    expect(await service.issuerFor(SCOPE).issue(KIRO)).toEqual({
      kind: 'refused',
      reason: 'policy-off',
    });
  });

  test('signed out is refused, and the audit log records outcomes without any value', async () => {
    const { stub, service, home } = await setup();
    expect(await service.issuerFor(SCOPE).issue(KIRO)).toEqual({
      kind: 'refused',
      reason: 'signed-out',
    });
    await signInBuilderId(service, stub, {
      accessToken: 'access-secret-value',
      refreshToken: 'refresh-secret-value',
    });
    await service.issuerFor(SCOPE).issue(KIRO);
    await service.signOut(SCOPE);
    const audit = readFileSync(service.auditFile, 'utf8');
    const events = audit
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    expect(events).toEqual(['refused', 'signed-in', 'issued', 'signed-out']);
    for (const secret of [
      'access-secret-value',
      'refresh-secret-value',
      'stub-client-secret',
    ])
      expect(audit).not.toContain(secret);
    if (process.platform !== 'win32')
      expect(statSync(service.auditFile).mode & 0o777).toBe(0o600);
    // The vault itself is 0600 and holds nothing after sign-out.
    const vault = join(home, 'security', 'engine-host-auth.json');
    if (process.platform !== 'win32')
      expect(statSync(vault).mode & 0o777).toBe(0o600);
    expect(service.status(SCOPE).state).toBe('signed-out');
  });
});

describe('responders on an inbound registry', () => {
  test('a launch carrying a non-default credential profile installs nothing', async () => {
    const { stub, service } = await setup();
    registerEngineHostAuth(service);
    await signInBuilderId(service, stub, {
      accessToken: 'vault-token',
      refreshToken: 'r',
    });
    const registry = new AcpInboundExtensionRegistry();
    expect(
      installEngineHostAuthResponders(registry, {
        connection: {
          id: SCOPE.connectionId,
          command: 'station-managed:kiro-kas',
          credentialProfileRef: 'work',
        },
      }),
    ).toEqual({ credentialMethods: [], secretMethods: [] });
    await expect(
      createAcpInboundExtensionRequestHandler({ registry })(
        '_kiro/auth/getAccessToken',
        {},
      ),
    ).rejects.toMatchObject({ code: -32601 });
  });

  test('a managed bundle launch answers getAccessToken from the vault; a custom command gets -32601 and no token', async () => {
    const { stub, service } = await setup();
    registerEngineHostAuth(service);
    await signInBuilderId(service, stub, {
      accessToken: 'vault-token',
      refreshToken: 'r',
    });

    const bundle = new AcpInboundExtensionRegistry();
    expect(
      installEngineHostAuthResponders(bundle, {
        connection: {
          id: SCOPE.connectionId,
          command: 'station-managed:kiro-kas',
        },
      }),
    ).toEqual({
      credentialMethods: ['_kiro/auth/getAccessToken'],
      secretMethods: [
        '_kiro/secret/get',
        '_kiro/secret/store',
        '_kiro/secret/delete',
      ],
    });
    const answer = await createAcpInboundExtensionRequestHandler({
      registry: bundle,
    })('_kiro/auth/getAccessToken', {});
    expect(answer).toMatchObject({
      accessToken: 'vault-token',
      profileArn: BUILDER_ID_PROFILE_ARN,
    });

    const custom = new AcpInboundExtensionRegistry();
    expect(
      installEngineHostAuthResponders(custom, {
        connection: {
          id: SCOPE.connectionId,
          command: process.execPath,
          args: ['agent.mjs', '--auth=acp-callback'],
        },
        builtinDescriptor: true,
      }),
    ).toEqual({ credentialMethods: [], secretMethods: [] });
    await expect(
      createAcpInboundExtensionRequestHandler({ registry: custom })(
        '_kiro/auth/getAccessToken',
        {},
      ),
    ).rejects.toMatchObject({ code: -32601 });
  });

  test('a signed-out vault answers -32000 with fixed text', async () => {
    const { service } = await setup();
    registerEngineHostAuth(service);
    const registry = new AcpInboundExtensionRegistry();
    installEngineHostAuthResponders(registry, {
      connection: {
        id: SCOPE.connectionId,
        command: 'station-managed:kiro-kas',
      },
    });
    await expect(
      createAcpInboundExtensionRequestHandler({ registry })(
        '_kiro/auth/getAccessToken',
        {},
      ),
    ).rejects.toMatchObject({
      code: ENGINE_CREDENTIAL_REFUSED_CODE,
      message: 'Station has no signed-in credential for this engine',
    });
  });
});

describe('the engine secret store', () => {
  const key = (kind: string) => `kiro.mcp.${'a'.repeat(64)}.${kind}`;

  test('persists client and tokens, keeps verifier and discovery in this process only', async () => {
    const { service } = await setup();
    const first = service.secretStoreFor(SCOPE, SECRETS);
    await first.store(key('tokens'), 'tok');
    await first.store(key('client'), 'cli');
    await first.store(key('verifier'), 'ver');
    await first.store(key('discovery'), 'dis');
    const second = service.secretStoreFor(SCOPE, SECRETS);
    expect(await second.get(key('tokens'))).toBe('tok');
    expect(await second.get(key('client'))).toBe('cli');
    expect(await second.get(key('verifier'))).toBeUndefined();
    expect(await second.get(key('discovery'))).toBeUndefined();
    expect(await first.get(key('verifier'))).toBe('ver');
  });

  test('refuses a key outside the namespace and a value over the cap, through the responder too', async () => {
    const { service } = await setup();
    const store = service.secretStoreFor(SCOPE, SECRETS);
    expect(() => store.get('kiro.mcp.short.tokens')).toThrow(/namespace/);
    expect(() => store.store(key('tokens'), 'x'.repeat(65_537))).toThrow(
      /size limit/,
    );
    await store.store(key('tokens'), 'x'.repeat(65_536));
    registerEngineHostAuth(service);
    const registry = new AcpInboundExtensionRegistry();
    installEngineHostAuthResponders(registry, {
      connection: {
        id: SCOPE.connectionId,
        command: 'station-managed:kiro-kas',
      },
    });
    const handler = createAcpInboundExtensionRequestHandler({ registry });
    await expect(
      handler('_kiro/secret/store', { key: 'kiro.other.key', value: 'v' }),
    ).rejects.toMatchObject({ code: -32602 });
    const refusal: unknown = await Promise.resolve(
      handler('_kiro/secret/store', {
        key: key('tokens'),
        value: 'y'.repeat(65_537),
      }),
    ).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: -32602 });
    expect(JSON.stringify(refusal)).not.toContain('yyyy');
  });

  test('a delete removes only the revision this process saw, never a newer one', async () => {
    const { service } = await setup();
    const stale = service.secretStoreFor(SCOPE, SECRETS);
    const fresh = service.secretStoreFor(SCOPE, SECRETS);
    await stale.store(key('tokens'), 'old-grant');
    await fresh.store(key('tokens'), 'new-grant');
    await stale.delete(key('tokens'));
    expect(await fresh.get(key('tokens'))).toBe('new-grant');
    // A process that never touched the key deletes it outright.
    const other = service.secretStoreFor(SCOPE, SECRETS);
    await other.delete(key('tokens'));
    expect(await fresh.get(key('tokens'))).toBeUndefined();
  });

  test('removing the connection wipes its credential and its secrets', async () => {
    const { stub, service } = await setup();
    await signInBuilderId(service, stub, {
      accessToken: 'a',
      refreshToken: 'r',
    });
    await service.secretStoreFor(SCOPE, SECRETS).store(key('tokens'), 'tok');
    const otherScope = {
      connectionId: 'other',
      credentialProfileRef: 'default',
    };
    await service
      .secretStoreFor(otherScope, SECRETS)
      .store(key('tokens'), 'keep');
    expect(service.vault.bucketIds().sort()).toEqual([
      'engine-secret:kiro-kas-bundle:default',
      'engine-secret:other:default',
      'kiro.oidc-access-token:kiro-kas-bundle:default',
    ]);
    await service.removeConnection(SCOPE.connectionId);
    expect(service.vault.bucketIds()).toEqual(['engine-secret:other:default']);
    expect(service.status(SCOPE).state).toBe('signed-out');
  });
});
