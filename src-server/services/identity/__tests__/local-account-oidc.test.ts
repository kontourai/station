import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod/v3';
import { DeploymentAuthenticationService } from '../deployment-authentication-service.js';
import { createLocalAccountProvider } from '../local-account-provider.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const stationOrigin = 'http://127.0.0.1:48999';
const basePath = '/api/account-auth';
const invitation = 'invitation-valid-fixture-0001';

async function fixture(discoveryAvailable = true) {
  const key = await generateKeyPair('RS256');
  const rotatedKey = await generateKeyPair('RS256');
  const rotatedJwk = {
    ...(await exportJWK(rotatedKey.publicKey)),
    kid: 'key-two',
    alg: 'RS256',
    use: 'sig',
  };
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: 'key-one',
    alg: 'RS256',
    use: 'sig',
  };
  const codes = new Map<
    string,
    { nonce: string; challenge: string; redirect: string }
  >();
  let issuerOrigin = '';
  let tokenIssuer: string | undefined;
  let badNonce = false;
  let badAudience = false;
  let omitIdToken = false;
  let rotated = false;
  let forged = false;
  let expired = false;
  let badPkce = false;
  let allowed = true;
  const eligibility: { invitation: string; email?: string }[] = [];
  const app = new Hono();
  app.get('/.well-known/openid-configuration', (c) =>
    !discoveryAvailable
      ? c.json({ error: 'unavailable' }, 503)
      : c.json({
          issuer: issuerOrigin,
          authorization_endpoint: `${issuerOrigin}/authorize`,
          token_endpoint: `${issuerOrigin}/token`,
          jwks_uri: `${issuerOrigin}/jwks`,
          userinfo_endpoint: `${issuerOrigin}/userinfo`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: [
            'client_secret_post',
            'client_secret_basic',
          ],
        }),
  );
  app.get('/jwks', (c) => c.json({ keys: [jwk, rotatedJwk] }));
  app.get('/userinfo', (c) =>
    c.json({
      sub: 'immutable-person-one',
      id: 'immutable-person-one',
      email: 'person@example.test',
      email_verified: true,
      name: 'Fixture Person',
    }),
  );
  app.get('/authorize', (c) => {
    const url = new URL(c.req.url);
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      nonce: url.searchParams.get('nonce') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
      redirect: url.searchParams.get('redirect_uri') ?? '',
    });
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('iss', issuerOrigin);
    return c.redirect(callback.href);
  });
  app.post('/token', async (c) => {
    const form = new URLSearchParams(await c.req.text());
    const code = form.get('code') ?? '';
    const flow = codes.get(code);
    codes.delete(code);
    const basic = c.req.header('authorization');
    const authorized =
      basic ===
        `Basic ${Buffer.from('station-test:fixture-client-secret').toString('base64')}` ||
      (form.get('client_id') === 'station-test' &&
        form.get('client_secret') === 'fixture-client-secret');
    const challenge = createHash('sha256')
      .update(form.get('code_verifier') ?? '')
      .digest('base64url');
    if (
      !authorized ||
      !flow?.nonce ||
      !flow.challenge ||
      badPkce ||
      challenge !== flow.challenge ||
      form.get('redirect_uri') !== flow.redirect
    )
      return c.json({ error: 'invalid_grant' }, 400);
    const idToken = await new SignJWT({
      nonce: badNonce ? 'wrong-nonce' : flow.nonce,
      email: 'person@example.test',
      email_verified: true,
      name: 'Fixture Person',
    })
      .setProtectedHeader({
        alg: 'RS256',
        kid: rotated ? 'key-two' : 'key-one',
      })
      .setIssuer(tokenIssuer ?? issuerOrigin)
      .setAudience(badAudience ? 'different-client' : 'station-test')
      .setSubject('immutable-person-one')
      .setIssuedAt()
      .setExpirationTime(expired ? '-1m' : '5m')
      .sign(rotated || forged ? rotatedKey.privateKey : key.privateKey);
    return c.json({
      access_token: 'fixture-access',
      token_type: 'Bearer',
      expires_in: 300,
      ...(omitIdToken ? {} : { id_token: idToken }),
    });
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Issuer did not listen');
  issuerOrigin = `http://127.0.0.1:${address.port}`;
  const stateDirectory = await mkdtemp(join(tmpdir(), 'station-oidc-'));
  cleanup.push(() => rm(stateDirectory, { recursive: true, force: true }));
  const provider = await createLocalAccountProvider(
    {
      stationId: 'oidc-test',
      publicOrigin: stationOrigin,
      stateDirectory,
      basePath,
    },
    randomBytes(32).toString('hex'),
    {
      mayRegister: async (input) => {
        eligibility.push(input);
        return (
          allowed &&
          input.invitation === invitation &&
          (!input.email || input.email === 'person@example.test')
        );
      },
      deliver: async () => {
        throw new Error('OIDC must not send local mail');
      },
    },
    'username-password',
    [
      {
        id: 'test-idp',
        displayName: 'Test identity',
        issuer: issuerOrigin,
        clientId: 'station-test',
        clientSecret: 'fixture-client-secret',
      },
    ],
  );
  const service = new DeploymentAuthenticationService(provider);
  cleanup.push(() => service.close());
  const jar = new Map<string, string>();
  const call = async (
    path: string,
    options?: { body?: unknown; invitation?: string; url?: string },
  ) => {
    const headers = new Headers({
      Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    });
    if (options?.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      headers.set('Origin', stationOrigin);
    }
    if (options?.invitation)
      headers.set('x-station-invitation', options.invitation);
    const response = await service.handle(
      new Request(options?.url ?? `${stationOrigin}${basePath}${path}`, {
        method: options?.body !== undefined ? 'POST' : 'GET',
        headers,
        ...(options?.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      }),
      path,
    );
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  };
  const begin = async (token = invitation) => {
    const response = await call('/oidc/test-idp/begin', {
      body: {},
      invitation: token,
    });
    expect(response.status).toBe(200);
    const value = z
      .object({ data: z.object({ url: z.string().url() }) })
      .parse(await response.json());
    expect(value.data.url).not.toContain(invitation);
    const authorize = await fetch(value.data.url, { redirect: 'manual' });
    const callback = authorize.headers.get('location');
    if (!callback) throw new Error('Issuer did not return a callback');
    return callback;
  };
  const account = () =>
    service.authenticate(
      new Request(`${stationOrigin}/private`, {
        headers: {
          Cookie: [...jar]
            .map(([name, value]) => `${name}=${value}`)
            .join('; '),
        },
      }),
    );
  return {
    begin,
    call,
    account,
    eligibility,
    setTokenIssuer: (value: string) => {
      tokenIssuer = value;
    },
    description: service.describe(),
    stateDirectory,
    clearCookies: () => jar.clear(),
    rotateKey: () => {
      rotated = true;
    },
    forgeSignature: () => {
      forged = true;
    },
    expireToken: () => {
      expired = true;
    },
    corruptPkce: () => {
      badPkce = true;
    },
    omitIdToken: () => {
      omitIdToken = true;
    },
    corruptAudience: () => {
      badAudience = true;
    },
    corruptNonce: () => {
      badNonce = true;
    },
    withdraw: () => {
      allowed = false;
    },
  };
}

describe('local accounts with a real HTTP OIDC issuer', () => {
  test('verifies a code/PKCE/nonce flow and rechecks the invitation using verified email', async () => {
    const f = await fixture();
    const callback = await f.begin();
    const response = await f.call('/callback/test-idp', { url: callback });
    expect(response.status).toBe(302);
    expect(await f.account()).toMatchObject({
      kind: 'authenticated',
      session: { contacts: [{ kind: 'email', value: 'person@example.test' }] },
    });
    const database = new DatabaseSync(
      join(f.stateDirectory, 'local-accounts.sqlite'),
      { readOnly: true },
    );
    try {
      const row = database.prepare('SELECT accessToken FROM account').get();
      expect(row?.accessToken).toBeTruthy();
      expect(row?.accessToken).not.toBe('fixture-access');
    } finally {
      database.close();
    }
    expect(f.eligibility).toContainEqual({
      invitation,
      email: 'person@example.test',
    });
  });
  test.each([
    'issuer',
    'nonce',
    'audience',
    'state',
    'missing-id-token',
    'signature',
    'expiry',
    'pkce',
    'invitation',
  ] as const)('refuses %s changes during the redirect', async (fault) => {
    const f = await fixture();
    let callback = await f.begin();
    if (fault === 'issuer') f.setTokenIssuer('https://other.example.test');
    if (fault === 'nonce') f.corruptNonce();
    if (fault === 'audience') f.corruptAudience();
    if (fault === 'missing-id-token') f.omitIdToken();
    if (fault === 'signature') f.forgeSignature();
    if (fault === 'expiry') f.expireToken();
    if (fault === 'pkce') f.corruptPkce();
    if (fault === 'state') {
      const url = new URL(callback);
      url.searchParams.set('state', 'wrong-state');
      callback = url.href;
    }
    if (fault === 'invitation') f.withdraw();
    await f.call('/callback/test-idp', { url: callback });
    expect((await f.account()).kind).not.toBe('authenticated');
  });
  test('publishes only configured login choices and refuses a replayed callback without its browser state', async () => {
    const f = await fixture();
    expect(f.description.externalLogins).toEqual([
      {
        id: 'test-idp',
        displayName: 'Test identity',
        startPath: '/oidc/test-idp/begin',
        available: true,
      },
    ]);
    expect(JSON.stringify(f.description)).not.toContain(
      'fixture-client-secret',
    );
    const callback = await f.begin();
    await f.call('/callback/test-idp', { url: callback });
    expect((await f.account()).kind).toBe('authenticated');
    f.clearCookies();
    await f.call('/callback/test-idp', { url: callback });
    expect((await f.account()).kind).not.toBe('authenticated');
  });
  test('an unavailable optional issuer leaves local username signup/login usable', async () => {
    const f = await fixture(false);
    expect(f.description.externalLogins?.[0].available).toBe(false);
    expect(
      (await f.call('/oidc/test-idp/begin', { body: {}, invitation })).status,
    ).toBe(503);
    const credentials = {
      username: 'local.person',
      password: 'Local fallback password 12345',
    };
    expect(
      (await f.call('/sign-up/username', { body: credentials, invitation }))
        .status,
    ).toBe(200);
    expect(
      (await f.call('/sign-in/username', { body: credentials })).status,
    ).toBe(200);
    expect((await f.account()).kind).toBe('authenticated');
  });
  test('a prepublished signing-key rotation preserves the same account on later login', async () => {
    const f = await fixture();
    await f.call('/callback/test-idp', { url: await f.begin() });
    const first = await f.account();
    expect(first.kind).toBe('authenticated');
    f.clearCookies();
    f.rotateKey();
    await f.call('/callback/test-idp', { url: await f.begin('') });
    const second = await f.account();
    expect(second.kind).toBe('authenticated');
    if (first.kind !== 'authenticated' || second.kind !== 'authenticated')
      throw new Error('Fixture accounts were not authenticated');
    expect(second.session.subject).toBe(first.session.subject);
  });
});
