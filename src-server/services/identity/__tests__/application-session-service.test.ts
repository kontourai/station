import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  APPLICATION_SESSION_NATIVE_CHALLENGE_PATH,
  APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
  APPLICATION_SESSION_NATIVE_HEADER,
  APPLICATION_SESSION_NATIVE_PROOF_HEADER,
  APPLICATION_SESSION_NATIVE_PROOF_TYPE,
  APPLICATION_SESSION_NATIVE_VERSION,
} from '@kontourai/station-contracts/application-session';
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import {
  ApplicationSessionClient,
  createApplicationSessionKey,
} from '@kontourai/station-sdk/application-session';
import { NativeApplicationSessionClient } from '@kontourai/station-sdk/application-session-native';
import { Hono } from 'hono';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApplicationSessionRoutes } from '../../../routes/system/application-session-routes.js';
import {
  configureRuntimeHttp,
  parseSecureDeviceSessionCookie,
} from '../../../runtime/bootstrap/runtime-http.js';
import { createLogger } from '../../../utils/logger.js';
import { openPrivateSqlite } from '../../../utils/private-sqlite.js';
import {
  readVerifiedNativeVirtualApplicationRequest,
  VirtualApplicationIngress,
} from '../../connections/virtual-application.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { createApplicationSessionRuntime } from '../application-session-runtime.js';
import type {
  ReadVerifiedNativeApplicationRequest,
  VerifiedNativeApplicationRequest,
} from '../application-session-service.js';
import { loadLocalAccounts } from '../local-account-runtime.js';

const origin = 'https://station.example.test';
const alternateOrigin = 'https://app.example.test';
const stationId = '33333333-3333-4333-8333-333333333333';
const cleanup: Array<() => Promise<void>> = [];
const nativeSurface = {
  kind: 'station-native' as const,
  appIdentifier: 'com.kontourai.station',
  channel: 'dev' as const,
  clientInstanceId: 'native-instance-1',
  keyThumbprint: 'r'.repeat(43),
};
const nativeFacts = (
  surface = nativeSurface,
  targetStationId = stationId,
  requestOrigin = origin,
): VerifiedNativeApplicationRequest => ({
  stationId: targetStationId,
  surface,
  connectionEnrollmentId: 'e'.repeat(43),
  routingGeneration: 1,
  connectionId: 'native-connection-1',
  requestOrigin,
  isCurrent: () => true,
});
const nativeHash = (value: string) =>
  createHash('sha256').update(value).digest('base64url');
async function signNativeProof(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
) {
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: 'ES256',
      typ: APPLICATION_SESSION_NATIVE_PROOF_TYPE,
    })
    .sign(privateKey);
}
async function nativeAccount(h: Awaited<ReturnType<typeof harness>>) {
  const login = await h.accounts().service.handle(
    new Request(`${origin}/api/account-auth/sign-in/username`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: h.password }),
    }),
    '/sign-in/username',
  );
  const accountCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const account = await h.accounts().service.authenticate(
    new Request(`${origin}/api/account-auth/session`, {
      headers: { Cookie: accountCookie },
    }),
  );
  if (account.kind !== 'authenticated')
    throw new Error('Fixture sign-in failed.');
  h.setNativeAccountBinding({
    kind: 'account',
    issuer: account.issuer,
    subject: account.session.subject,
    displayName: account.principal.display,
    approvedAt: Date.now(),
    approvalId: randomUUID(),
    approvedBy: account.principal.id,
  });
  return account;
}
async function nativeKey() {
  const pair = await generateKeyPair('ES256');
  const jwk = await exportJWK(pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    },
  };
}
function readNativeProviderSessionId(
  home: string,
  continuation: { credential: string },
) {
  const database = new DatabaseSync(
    join(home, 'authentication', 'application-sessions.sqlite'),
  );
  try {
    const row = database
      .prepare(
        'SELECT record FROM application_session_native_sessions WHERE token_hash=?',
      )
      .get(nativeHash(continuation.credential));
    if (typeof row?.record !== 'string')
      throw new Error('Native continuation fixture is missing.');
    const record = JSON.parse(row.record) as { providerSessionId?: unknown };
    if (typeof record.providerSessionId !== 'string')
      throw new Error('Native provider session fixture is missing.');
    return record.providerSessionId;
  } finally {
    database.close();
  }
}
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

async function harness(
  options: {
    now?: () => number;
    nativeReader?: ReadVerifiedNativeApplicationRequest;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'station-application-session-'));
  await mkdir(join(home, 'security'), { mode: 0o700 });
  let pairing = new DevicePairingService({
    homeDir: home,
    environmentId: stationId,
  });
  const pair = (name: string) => {
    const offer = pairing.createOffer({
      endpoint: origin,
      scope: pairingScopePresetString('standard'),
    });
    const request = pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
      requesterPosition: 'off-box',
    });
    pairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
  };
  const device = pair('First device');
  const second = pair('Second device');
  let nativeFacts: VerifiedNativeApplicationRequest | undefined;
  let nativeAccountBinding: PairedDevice['principalBinding'];
  const identifyDevice = (credential: string) => {
    const identified = pairing.identifyDevice(credential);
    return identified?.id === device.device.id && nativeAccountBinding
      ? { ...identified, principalBinding: nativeAccountBinding }
      : identified;
  };
  const readNativeRequest = (request: Request) =>
    options.nativeReader ? options.nativeReader(request) : nativeFacts;
  const configuration = {
    publicOrigin: origin,
    allowedBrowserOrigins: [alternateOrigin],
  };
  const host = { homeDirectory: home, stationId };
  const enrollment = { mayRegister: async () => true };
  let resolvePendingRelayDevice = (_deviceId: string, _enrollmentId: string) =>
    null as {
      deviceId: string;
      enrollmentId: string;
      issuer: string;
      subject: string;
      approvalId: string;
      approvedBy: string;
      scope: readonly string[];
    } | null;
  const resolvePending = (deviceId: string, enrollmentId: string) =>
    resolvePendingRelayDevice(deviceId, enrollmentId);
  const resolveActive = (deviceId: string, enrollmentId: string) =>
    pairing.resolveActiveRelayEnrollmentDevice(deviceId, enrollmentId);
  let accounts = await loadLocalAccounts(configuration, host, enrollment);
  let browserCookieJar = '';
  let lastIssuedAliasCredential: string | undefined;
  let sessions = createApplicationSessionRuntime(
    home,
    stationId,
    accounts,
    identifyDevice,
    resolvePending,
    resolveActive,
    options.now,
    (value) => pairing.credentialAliasId(value),
    {
      readSecureDeviceCookie: (request) =>
        parseSecureDeviceSessionCookie(
          request.headers.get('cookie') ?? undefined,
        ),
      issueAlias: (parentCredential, deviceId, aliasId) => {
        const alias = pairing.issueRelayCredentialAlias(
          parentCredential,
          deviceId,
          undefined,
          aliasId,
        );
        lastIssuedAliasCredential = alias.credential;
        return alias;
      },
      revokeAlias: (deviceId, aliasId) =>
        pairing.revokeRelayCredentialAlias(deviceId, aliasId),
    },
    readNativeRequest,
  )!;
  const app = () => {
    const result = new Hono();
    result.route(
      '/api/account-auth/continuations',
      createApplicationSessionRoutes(sessions),
    );
    result.get('/resource', async (c) => {
      const account = await accounts.service.authenticate(c.req.raw);
      return c.json(
        account.kind === 'authenticated'
          ? { principal: account.principal }
          : { kind: account.kind },
        account.kind === 'authenticated'
          ? 200
          : account.kind === 'unavailable'
            ? 503
            : 401,
      );
    });
    return result;
  };
  let currentApp = app();
  const browserFetch = vi.fn((url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.credentials === 'same-origin') {
      headers.set('Cookie', browserCookieJar);
      headers.set('Origin', origin);
    }
    return currentApp.request(url, { ...init, headers });
  });
  vi.stubGlobal('fetch', browserFetch);
  const password = 'Application session fixture password';
  const signup = await accounts.service.handle(
    new Request(`${origin}/api/account-auth/sign-up/username`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'x-station-invitation': 'fixture-enrollment',
      },
      body: JSON.stringify({ username: 'alice', password }),
    }),
    '/sign-up/username',
  );
  expect(signup.status).toBe(200);
  const key = await createApplicationSessionKey();
  const client = new ApplicationSessionClient(
    origin,
    stationId,
    origin,
    { credential: device.credential, credentialOrigin: origin },
    key,
  );
  cleanup.push(async () => {
    sessions.close();
    await accounts.service.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    client,
    key,
    device,
    home,
    second,
    get pairing() {
      return pairing;
    },
    password,
    accounts: () => accounts,
    application: () => currentApp,
    browserFetch,
    lastAliasCredential: () => lastIssuedAliasCredential,
    setBrowserCookieJar(value: string) {
      browserCookieJar = value;
    },
    sessions: () => sessions,
    request: (path: string, init: RequestInit) =>
      currentApp.request(origin + path, init),
    async restart() {
      sessions.close();
      await accounts.service.close();
      pairing = new DevicePairingService({
        homeDir: home,
        environmentId: stationId,
      });
      accounts = await loadLocalAccounts(configuration, host, enrollment);
      sessions = createApplicationSessionRuntime(
        home,
        stationId,
        accounts,
        identifyDevice,
        resolvePending,
        resolveActive,
        options.now,
        (value) => pairing.credentialAliasId(value),
        {
          readSecureDeviceCookie: (request) =>
            parseSecureDeviceSessionCookie(
              request.headers.get('cookie') ?? undefined,
            ),
          issueAlias: (parentCredential, deviceId, aliasId) => {
            const alias = pairing.issueRelayCredentialAlias(
              parentCredential,
              deviceId,
              undefined,
              aliasId,
            );
            lastIssuedAliasCredential = alias.credential;
            return alias;
          },
          revokeAlias: (deviceId, aliasId) =>
            pairing.revokeRelayCredentialAlias(deviceId, aliasId),
        },
        readNativeRequest,
      )!;
      currentApp = app();
    },
    setPendingRelayDeviceResolver(resolver: typeof resolvePendingRelayDevice) {
      resolvePendingRelayDevice = resolver;
    },
    setNativeRequestFacts(facts: VerifiedNativeApplicationRequest | undefined) {
      nativeFacts = facts;
    },
    setNativeAccountBinding(binding: PairedDevice['principalBinding']) {
      nativeAccountBinding = binding;
    },
  };
}

async function nativeContinuationFixture() {
  const h = await harness();
  const account = await nativeAccount(h);
  h.setNativeRequestFacts(nativeFacts());
  const key = await nativeKey();
  const credentials = { username: 'alice', password: h.password };
  const providerLoginHeaders: Headers[] = [];
  const providerLoginBodies: string[] = [];
  const loginVirtualSession = h
    .accounts()
    .service.loginVirtualSession.bind(h.accounts().service);
  vi.spyOn(h.accounts().service, 'loginVirtualSession').mockImplementation(
    async (providerRequest) => {
      providerLoginHeaders.push(new Headers(providerRequest.headers));
      providerLoginBodies.push(await providerRequest.clone().text());
      return loginVirtualSession(providerRequest);
    },
  );
  const challengeRequest = new Request(
    `${origin}${APPLICATION_SESSION_NATIVE_CHALLENGE_PATH}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.device.credential}` },
    },
  );
  const challenge = await h.sessions().nativeChallenge(challengeRequest, {
    publicKey: key.publicKey,
  });
  const exchangeRequest = () =>
    new Request(`${origin}${APPLICATION_SESSION_NATIVE_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.device.credential}` },
    });
  const exchangeProof = async (signer = key.privateKey) =>
    signNativeProof(signer, {
      version: APPLICATION_SESSION_NATIVE_VERSION,
      purpose: 'exchange',
      aud: challenge.target.audience,
      stationId: challenge.target.stationId,
      surface: challenge.target.surface,
      deviceId: challenge.deviceId,
      nonce: challenge.nonce,
      method: 'POST',
      path: APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
      challengeIdHash: nativeHash(challenge.challengeId),
      credentialsHash: nativeHash(JSON.stringify(credentials)),
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
    });
  const establish = async (proof?: string) =>
    h.sessions().establishNative(exchangeRequest(), {
      challengeId: challenge.challengeId,
      credentials,
      proof: proof ?? (await exchangeProof()),
    });
  const continuation = await establish();
  const authenticateRequest = async (jti = randomUUID()) => {
    const request = new Request(`${origin}/api/protected/resource?native=1`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${h.device.credential}`,
        [APPLICATION_SESSION_NATIVE_HEADER]: continuation.credential,
      },
    });
    const proof = await signNativeProof(key.privateKey, {
      version: APPLICATION_SESSION_NATIVE_VERSION,
      purpose: 'request',
      aud: continuation.target.audience,
      stationId: continuation.target.stationId,
      surface: continuation.target.surface,
      deviceId: continuation.deviceId,
      nonce: continuation.nonce,
      method: 'GET',
      path: '/api/protected/resource?native=1',
      credentialHash: nativeHash(continuation.credential),
      jti,
      iat: Math.floor(Date.now() / 1000),
    });
    request.headers.set(APPLICATION_SESSION_NATIVE_PROOF_HEADER, proof);
    return request;
  };
  return {
    h,
    account,
    key,
    challenge,
    credentials,
    providerLoginHeaders,
    providerLoginBodies,
    continuation,
    exchangeProof,
    exchangeRequest,
    establish,
    authenticateRequest,
  };
}

describe('native application-session continuation service seam', () => {
  test('uses the native SDK through verified virtual ingress for provider login, read and write', async () => {
    const h = await harness({
      nativeReader: readVerifiedNativeVirtualApplicationRequest,
    });
    await nativeAccount(h);
    const key = await createApplicationSessionKey();
    const directNative = await h
      .application()
      .request(`${origin}${APPLICATION_SESSION_NATIVE_CHALLENGE_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${h.device.credential}` },
        body: JSON.stringify({
          version: APPLICATION_SESSION_NATIVE_VERSION,
          publicKey: key.publicKey,
        }),
      });
    expect(directNative.status).toBe(401);
    const peer = new AbortController();
    const ingress = new VirtualApplicationIngress(origin, undefined, () => ({
      peerNonce: 'n'.repeat(43),
      stationId,
      connectionEnrollmentId: 'e'.repeat(43),
      routingGeneration: 1,
      connectionId: 'native-connection-1',
      stationOrigin: origin,
      surface: nativeSurface,
      signal: peer.signal,
      isCurrent: () => !peer.signal.aborted,
    }));
    const secured = new Hono();
    configureRuntimeHttp({
      app: secured as never,
      logger: createLogger({ name: 'native-ingress-test', level: 'error' }),
      eventBus: new EventBus(),
      security: {
        deploymentAuthentication: h.accounts().service,
        allowedOrigins: [origin],
        verifyCredential: (credential) =>
          h.pairing.identifyDevice(credential) !== null,
        resolveGrantedScope: () => DEFAULT_GRANT_PAIRING_SCOPE,
      },
    });
    secured.route(
      '/api/account-auth/continuations',
      createApplicationSessionRoutes(h.sessions()),
    );
    secured.get('/api/projects', (c) => {
      const account = h.accounts().service.current(c.req.raw);
      return c.json({
        principal: account?.kind === 'authenticated' ? account.principal : null,
      });
    });
    let mutations = 0;
    secured.post('/api/projects', async (c) => {
      const body = await c.req.json();
      mutations++;
      return c.json({ body, mutations });
    });
    ingress.bind({ fetch: (request) => secured.fetch(request) });
    const virtual = ingress.activate();
    try {
      const client = new NativeApplicationSessionClient(
        {
          post: async ({ path, headers, body }) => {
            const response = await virtual.fetch(
              new Request(`${origin}${path}`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${h.device.credential}`,
                  'Content-Type': 'application/json',
                  ...headers,
                },
                body: JSON.stringify(body),
              }),
            );
            if (!response.ok)
              throw new Error(`native route ${response.status}`);
            return ((await response.json()) as { data: unknown }).data;
          },
        },
        () => ({
          kind: 'station-native',
          stationId,
          audience: origin,
          deviceId: h.device.device.id,
          surface: nativeSurface,
        }),
        key,
      );
      const continuation = await client.exchange({
        username: 'alice',
        password: h.password,
      });
      const readHeaders = await client.headers(continuation, {
        method: 'GET',
        path: '/api/projects?limit=2',
      });
      const protectedRead = await virtual.fetch(
        new Request(`${origin}/api/projects?limit=2`, {
          headers: {
            Authorization: `Bearer ${h.device.credential}`,
            ...readHeaders,
          },
        }),
      );
      expect(protectedRead.status).toBe(200);
      expect(
        ((await protectedRead.json()) as { principal: { id: string } })
          .principal.id,
      ).toMatch(/^human:deployment:/);
      const mutationHeaders = await client.headers(continuation, {
        method: 'POST',
        path: '/api/projects',
      });
      const mutation = await virtual.fetch(
        new Request(`${origin}/api/projects`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.device.credential}`,
            'Content-Type': 'application/json',
            ...mutationHeaders,
          },
          body: JSON.stringify({ value: 'once' }),
        }),
      );
      expect(mutation.status).toBe(200);
      expect(await mutation.json()).toEqual({
        body: { value: 'once' },
        mutations: 1,
      });
      expect(mutations).toBe(1);
      peer.abort();
      expect(
        (await virtual.fetch(new Request(`${origin}/api/projects`))).status,
      ).toBe(403);
    } finally {
      ingress.stop();
    }
  });
  test('binds exchange to provider login, the verified Station surface, Device and independent proof key', async () => {
    const f = await nativeContinuationFixture();
    expect(f.continuation.target).toEqual({
      kind: 'station-native',
      stationId,
      audience: origin,
      surface: nativeSurface,
    });
    expect(f.continuation.keyThumbprint).toBe(
      await calculateJwkThumbprint(f.key.publicKey),
    );
    expect(f.continuation.keyThumbprint).not.toBe(nativeSurface.keyThumbprint);
    expect(f.continuation).not.toHaveProperty('requestOrigin');
    expect(f.continuation).not.toHaveProperty('clientOrigin');
    expect(f.challenge).not.toHaveProperty('providerSessionId');
    expect(f.continuation).not.toHaveProperty('providerSessionId');
    expect(f.providerLoginHeaders).toHaveLength(1);
    expect([...f.providerLoginHeaders[0]!.keys()]).toEqual(['content-type']);
    expect(JSON.parse(f.providerLoginBodies[0]!)).toEqual(f.credentials);
    await expect(f.establish(await f.exchangeProof())).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  test('rejects target changes, proof-key substitution and replayed exchanges', async () => {
    const f = await nativeContinuationFixture();
    // The setup already consumed its challenge, so issue an independent challenge for negative target/proof tests.
    const key = await nativeKey();
    const challenge = await f.h.sessions().nativeChallenge(
      new Request(`${origin}${APPLICATION_SESSION_NATIVE_CHALLENGE_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${f.h.device.credential}` },
      }),
      { publicKey: key.publicKey },
    );
    const credentials = {
      username: 'alice',
      password: f.h.password,
    };
    const proofClaims = {
      version: APPLICATION_SESSION_NATIVE_VERSION,
      purpose: 'exchange',
      aud: challenge.target.audience,
      stationId,
      surface: challenge.target.surface,
      deviceId: challenge.deviceId,
      nonce: challenge.nonce,
      method: 'POST',
      path: APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
      challengeIdHash: nativeHash(challenge.challengeId),
      credentialsHash: nativeHash(JSON.stringify(credentials)),
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
    };
    f.h.setNativeRequestFacts(
      nativeFacts({ ...nativeSurface, clientInstanceId: 'other-instance' }),
    );
    await expect(
      f.h.sessions().establishNative(f.exchangeRequest(), {
        challengeId: challenge.challengeId,
        credentials,
        proof: await signNativeProof(key.privateKey, proofClaims),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    f.h.setNativeRequestFacts(nativeFacts());
    const wrongKey = await nativeKey();
    const badProof = await signNativeProof(wrongKey.privateKey, proofClaims);
    await expect(
      f.h.sessions().establishNative(f.exchangeRequest(), {
        challengeId: challenge.challengeId,
        credentials,
        proof: badProof,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    const proof = await signNativeProof(key.privateKey, proofClaims);
    const established = await f.h
      .sessions()
      .establishNative(f.exchangeRequest(), {
        challengeId: challenge.challengeId,
        credentials,
        proof,
      });
    expect(established.target.surface.clientInstanceId).toBe(
      nativeSurface.clientInstanceId,
    );
    await expect(
      f.h.sessions().establishNative(f.exchangeRequest(), {
        challengeId: challenge.challengeId,
        credentials,
        proof,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  test('checks provider session and approved account Device on every native request; request proofs are one-use', async () => {
    const f = await nativeContinuationFixture();
    const request = await f.authenticateRequest();
    expect((await f.h.sessions().authenticateNative(request)).kind).toBe(
      'authenticated',
    );
    // Runtime delivery revalidates the same Request, including fresh provider
    // and Device state, without consuming its one-use proof a second time.
    expect((await f.h.sessions().authenticateNative(request)).kind).toBe(
      'authenticated',
    );
    expect(
      (await f.h.sessions().authenticateNative(new Request(request))).kind,
    ).toBe('invalid');

    const revokedDeviceId = f.h.device.device.id;
    f.h.pairing.revokeDevice(revokedDeviceId, 'operator-credential');
    expect(
      (await f.h.sessions().authenticateNative(await f.authenticateRequest()))
        .kind,
    ).toBe('invalid');
  });

  test('bounds the native replay journal after provider and Device checks', async () => {
    const f = await nativeContinuationFixture();
    const database = new DatabaseSync(
      join(f.h.home, 'authentication', 'application-sessions.sqlite'),
    );
    const expiresAt = Date.now() + 120_000;
    const insert = database.prepare(
      'INSERT INTO application_session_native_proofs VALUES (?,?,?)',
    );
    database.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < 100_000; index += 1)
        insert.run(
          nativeHash(f.continuation.credential),
          `capacity-${index.toString().padStart(20, '0')}`,
          expiresAt,
        );
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      database.close();
    }
    expect(
      (await f.h.sessions().authenticateNative(await f.authenticateRequest()))
        .kind,
    ).toBe('unavailable');
  });

  test('refuses a revoked provider session and does not accept native credentials on browser authentication', async () => {
    const f = await nativeContinuationFixture();
    const browserResult = await f.h
      .sessions()
      .authenticate(await f.authenticateRequest());
    expect(browserResult.kind).toBe('invalid');
    await f.h
      .accounts()
      .service.revokeSessionReference(
        readNativeProviderSessionId(f.h.home, f.continuation),
        new AbortController().signal,
      );
    expect(
      (await f.h.sessions().authenticateNative(await f.authenticateRequest()))
        .kind,
    ).toBe('invalid');
  });

  test('fails closed when the provider cannot perform native login or trusted native facts are absent', async () => {
    const h = await harness();
    const key = await nativeKey();
    const unavailable = vi
      .spyOn(h.accounts().service, 'sessionReferenceCapabilities')
      .mockReturnValue({ verify: false, login: false });
    await expect(
      h.sessions().nativeChallenge(
        new Request(`${origin}${APPLICATION_SESSION_NATIVE_CHALLENGE_PATH}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${h.device.credential}` },
        }),
        { publicKey: key.publicKey },
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    unavailable.mockRestore();
    await nativeAccount(h);
    await expect(
      h.sessions().nativeChallenge(
        new Request(`${origin}${APPLICATION_SESSION_NATIVE_CHALLENGE_PATH}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${h.device.credential}` },
        }),
        { publicKey: key.publicKey },
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  test('refuses a different HTTP audience and stale Pion connection facts', async () => {
    const h = await harness();
    await nativeAccount(h);
    h.setNativeRequestFacts(nativeFacts());
    const key = await nativeKey();
    const makeRequest = (requestOrigin: string) =>
      new Request(
        `${requestOrigin}${APPLICATION_SESSION_NATIVE_CHALLENGE_PATH}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${h.device.credential}` },
        },
      );
    await expect(
      h.sessions().nativeChallenge(makeRequest(alternateOrigin), {
        publicKey: key.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      h.sessions().nativeChallenge(
        new Request(`${origin}${APPLICATION_SESSION_NATIVE_CHALLENGE_PATH}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.device.credential}`,
            Origin: alternateOrigin,
          },
        }),
        { publicKey: key.publicKey },
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    h.setNativeRequestFacts(
      nativeFacts(nativeSurface, '44444444-4444-4444-8444-444444444444'),
    );
    await expect(
      h.sessions().nativeChallenge(makeRequest(origin), {
        publicKey: key.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    h.setNativeRequestFacts({
      ...nativeFacts(),
      isCurrent: () => false,
    });
    await expect(
      h.sessions().nativeChallenge(makeRequest(origin), {
        publicKey: key.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('Device-bound continuation persistence and negative admission', () => {
  test('compensates an alias when continuation persistence faults after mint', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    const accountCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    h.setBrowserCookieJar(
      `__Host-station-device=${h.device.credential}; ${accountCookie}`,
    );
    const browser = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {},
      await createApplicationSessionKey(),
    );
    const database = new DatabaseSync(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
    );
    database.exec(`CREATE TRIGGER injected_adoption_insert_failure
      BEFORE INSERT ON application_sessions
      BEGIN SELECT RAISE(ABORT, 'injected adoption persistence failure'); END;`);
    await expect(browser.adoptCookies()).rejects.toMatchObject({ status: 503 });
    const orphan = h.lastAliasCredential();
    expect(orphan).toBeDefined();
    expect(h.pairing.credentialAliasId(orphan!)).toBeUndefined();
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
    expect(
      database
        .prepare('SELECT count(*) AS n FROM application_session_adoptions')
        .get()?.n,
    ).toBe(0);
    expect(
      database.prepare('SELECT count(*) AS n FROM application_sessions').get()
        ?.n,
    ).toBe(0);
    database.exec('DROP TRIGGER injected_adoption_insert_failure');
    database.close();

    const adoption = await browser.adoptCookies();
    expect(h.pairing.credentialAliasId(adoption.aliasCredential)).toBe(
      adoption.aliasId,
    );
  });

  test('startup revokes prepared and undelivered aliases left by an interrupted adoption', async () => {
    const h = await harness();
    const deviceId = h.device.device.id;
    const preparedId = randomUUID();
    const issuedId = randomUUID();
    const preparedAlias = h.pairing.issueRelayCredentialAlias(
      h.device.credential,
      deviceId,
      undefined,
      randomUUID(),
    );
    const issuedAlias = h.pairing.issueRelayCredentialAlias(
      h.device.credential,
      deviceId,
      undefined,
      randomUUID(),
    );
    const database = new DatabaseSync(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
    );
    const expiry = Date.now() + 24 * 60 * 60_000;
    const adoptionInsert = database.prepare(
      'INSERT INTO application_session_adoptions VALUES (?,?,?,?,?)',
    );
    adoptionInsert.run(
      preparedId,
      deviceId,
      preparedAlias.aliasId,
      expiry,
      'prepared',
    );
    adoptionInsert.run(
      issuedId,
      deviceId,
      issuedAlias.aliasId,
      expiry,
      'issued',
    );
    const unactivatedHash = 'u'.repeat(43);
    database
      .prepare('INSERT INTO application_sessions VALUES (?,?,?)')
      .run(unactivatedHash, expiry, JSON.stringify({ adoptionId: issuedId }));
    database
      .prepare('INSERT INTO application_session_proofs VALUES (?,?,?)')
      .run(unactivatedHash, 'p'.repeat(22), expiry);
    database.close();

    await h.restart();
    expect(
      h.pairing.credentialAliasId(preparedAlias.credential),
    ).toBeUndefined();
    expect(h.pairing.credentialAliasId(issuedAlias.credential)).toBeUndefined();
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
    const recovered = new DatabaseSync(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
    );
    expect(
      recovered
        .prepare('SELECT count(*) AS n FROM application_session_adoptions')
        .get()?.n,
    ).toBe(0);
    expect(
      recovered.prepare('SELECT count(*) AS n FROM application_sessions').get()
        ?.n,
    ).toBe(0);
    expect(
      recovered
        .prepare('SELECT count(*) AS n FROM application_session_proofs')
        .get()?.n,
    ).toBe(0);
    recovered.close();
  });

  test('adopts existing HTTPS Device and local-account cookies, survives restart, and revokes only the alias', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    const accountCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const cookieJar = `__Host-station-device=${h.device.credential}; ${accountCookie}`;
    h.setBrowserCookieJar(cookieJar);
    const browserKey = await createApplicationSessionKey();
    expect(browserKey.privateKey.extractable).toBe(false);
    const browser = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {},
      browserKey,
    );
    await expect(browser.capabilities()).resolves.toMatchObject({
      cookieAdoption: true,
      stationId,
      requestOrigin: origin,
    });
    const wrongOrigin = await h.request(
      '/api/account-auth/continuations/adopt-cookie/challenge',
      {
        method: 'POST',
        headers: {
          Origin: alternateOrigin,
          Cookie: `__Host-station-device=${h.device.credential}; ${accountCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ publicKey: browserKey.publicKey }),
      },
    );
    expect(wrongOrigin.status).toBe(403);
    const insecureDeviceCookie = await h.request(
      '/api/account-auth/continuations/adopt-cookie/challenge',
      {
        method: 'POST',
        headers: {
          Origin: origin,
          Cookie: `station-device=${h.device.credential}; ${accountCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ publicKey: browserKey.publicKey }),
      },
    );
    expect(insecureDeviceCookie.status).toBe(401);
    const devicesBefore = h.pairing.listDevices().map((device) => device.id);
    const adoption = await browser.adoptCookies();
    expect(adoption).toMatchObject({
      version: 'station.application-session/v1',
      continuation: {
        stationId,
        clientOrigin: origin,
        deviceId: h.device.device.id,
      },
    });
    expect(h.pairing.credentialAliasId(adoption.aliasCredential)).toBe(
      adoption.aliasId,
    );
    expect(h.pairing.listDevices().map((device) => device.id)).toEqual(
      devicesBefore,
    );
    expect(JSON.stringify(adoption)).not.toContain(accountCookie);
    expect(JSON.stringify(adoption)).not.toContain(h.device.credential);
    const adoptionCalls = h.browserFetch.mock.calls.filter(([url]) =>
      url.includes('/adopt-cookie/'),
    );
    expect(adoptionCalls).toHaveLength(2);
    for (const [, init] of adoptionCalls) {
      expect(init?.credentials).toBe('same-origin');
      expect(new Headers(init?.headers).has('Cookie')).toBe(false);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    }

    const relay = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: adoption.aliasCredential,
        credentialOrigin: origin,
      },
      browserKey,
    );
    const requestHeaders = await relay.headers(adoption.continuation, {
      method: 'GET',
      url: `${origin}/resource`,
    });
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...requestHeaders,
            Authorization: `Bearer ${adoption.aliasCredential}`,
          },
        })
      ).status,
    ).toBe(200);

    const ingress = new VirtualApplicationIngress(origin);
    ingress.bind({ fetch: (request) => h.application().fetch(request) });
    const virtual = ingress.activate();
    const cookieAttempt = await virtual.fetch(
      new Request(
        `${origin}/api/account-auth/continuations/adopt-cookie/challenge`,
        {
          method: 'POST',
          headers: {
            Origin: origin,
            Cookie: cookieJar,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publicKey: browserKey.publicKey }),
        },
      ),
    );
    expect(cookieAttempt.status).toBe(400);
    const cookieFreeAttempt = await virtual.fetch(
      new Request(
        `${origin}/api/account-auth/continuations/adopt-cookie/challenge`,
        {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: browserKey.publicKey }),
        },
      ),
    );
    expect(cookieFreeAttempt.status).toBe(401);
    ingress.stop();

    await h.restart();
    const afterRestartHeaders = await relay.headers(adoption.continuation, {
      method: 'GET',
      url: `${origin}/resource`,
    });
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...afterRestartHeaders,
            Authorization: `Bearer ${adoption.aliasCredential}`,
          },
        })
      ).status,
    ).toBe(200);

    await browser.revokeAlias(adoption.aliasCredential, adoption.continuation);
    expect(
      h.pairing.credentialAliasId(adoption.aliasCredential),
    ).toBeUndefined();
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
    expect(
      (
        await h.accounts().service.authenticate(
          new Request(`${origin}/api/account-auth/session`, {
            headers: { Cookie: accountCookie },
          }),
        )
      ).kind,
    ).toBe('authenticated');
  });

  test('reauthentication after continuation expiry keeps the exact adoption link through restart and alias revocation', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    const accountCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    h.setBrowserCookieJar(
      `__Host-station-device=${h.device.credential}; ${accountCookie}`,
    );
    const firstKey = await createApplicationSessionKey();
    const secondKey = await createApplicationSessionKey();
    const firstAdopter = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {},
      firstKey,
    );
    const secondAdopter = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {},
      secondKey,
    );
    const first = await firstAdopter.adoptCookies();
    const second = await secondAdopter.adoptCookies();
    expect(first.continuation.deviceId).toBe(h.device.device.id);
    expect(second.continuation.deviceId).toBe(first.continuation.deviceId);

    const firstRelay = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: first.aliasCredential,
        credentialOrigin: origin,
        headers: { Cookie: accountCookie },
      },
      firstKey,
    );
    const secondRelay = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: second.aliasCredential,
        credentialOrigin: origin,
        headers: { Cookie: accountCookie },
      },
      secondKey,
    );
    const resourceHeaders = async (
      client: ApplicationSessionClient,
      continuation: Awaited<ReturnType<ApplicationSessionClient['establish']>>,
      aliasCredential: string,
    ) => ({
      ...(await client.headers(continuation, {
        method: 'GET',
        url: `${origin}/resource`,
      })),
      Authorization: `Bearer ${aliasCredential}`,
    });
    expect(
      (
        await h.request('/resource', {
          headers: await resourceHeaders(
            firstRelay,
            first.continuation,
            first.aliasCredential,
          ),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request('/resource', {
          headers: await resourceHeaders(
            secondRelay,
            second.continuation,
            second.aliasCredential,
          ),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...(await resourceHeaders(
              firstRelay,
              first.continuation,
              first.aliasCredential,
            )),
            Authorization: `Bearer ${second.aliasCredential}`,
          },
        })
      ).status,
    ).toBe(401);

    const sessions = new DatabaseSync(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
    );
    const firstHash = createHash('sha256')
      .update(first.continuation.credential)
      .digest('base64url');
    const expired = Date.now() - 1;
    const session = sessions
      .prepare('SELECT record FROM application_sessions WHERE token_hash=?')
      .get(firstHash);
    expect(typeof session?.record).toBe('string');
    const record = JSON.parse(session!.record as string) as {
      expiresAt: number;
    };
    record.expiresAt = expired;
    expect(
      sessions
        .prepare(
          'UPDATE application_sessions SET expires_at=?, record=? WHERE token_hash=?',
        )
        .run(expired, JSON.stringify(record), firstHash).changes,
    ).toBe(1);
    sessions.close();
    expect(
      (
        await h.request('/resource', {
          headers: await resourceHeaders(
            firstRelay,
            first.continuation,
            first.aliasCredential,
          ),
        })
      ).status,
    ).toBe(401);

    await h.restart();
    const reauthenticated = await firstRelay.establish();
    expect(reauthenticated).toMatchObject({
      stationId,
      deviceId: h.device.device.id,
      principal: first.continuation.principal,
    });
    expect(
      (
        await h.request('/resource', {
          headers: await resourceHeaders(
            firstRelay,
            reauthenticated,
            first.aliasCredential,
          ),
        })
      ).status,
    ).toBe(200);

    await firstRelay.revokeAlias(first.aliasCredential, reauthenticated);
    expect(h.pairing.credentialAliasId(first.aliasCredential)).toBeUndefined();
    await expect(firstRelay.establish()).rejects.toMatchObject({ status: 401 });
    expect(h.pairing.credentialAliasId(second.aliasCredential)).toBe(
      second.aliasId,
    );
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
    expect(
      (
        await h.accounts().service.authenticate(
          new Request(`${origin}/api/account-auth/session`, {
            headers: { Cookie: accountCookie },
          }),
        )
      ).kind,
    ).toBe('authenticated');
    expect(
      (
        await h.request('/resource', {
          headers: await resourceHeaders(
            secondRelay,
            second.continuation,
            second.aliasCredential,
          ),
        })
      ).status,
    ).toBe(200);
  });

  test('an alias continuation is bound to its exact alias and alias bearers alone are denied over HTTP and VAI', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const firstAlias = h.pairing.issueRelayCredentialAlias(
      h.device.credential,
      h.device.device.id,
    );
    const secondAlias = h.pairing.issueRelayCredentialAlias(
      h.device.credential,
      h.device.device.id,
    );
    const firstClient = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: firstAlias.credential,
        credentialOrigin: origin,
        headers: { Cookie: cookie },
      },
      await createApplicationSessionKey(),
    );
    const secondClient = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: secondAlias.credential,
        credentialOrigin: origin,
        headers: { Cookie: cookie },
      },
      await createApplicationSessionKey(),
    );
    const firstSession = await firstClient.establish();
    const secondSession = await secondClient.establish();
    const proof = async (
      client: ApplicationSessionClient,
      session: Awaited<ReturnType<ApplicationSessionClient['establish']>>,
      credential: string,
    ) => ({
      ...(await client.headers(session, {
        method: 'GET',
        url: `${origin}/resource`,
      })),
      Authorization: `Bearer ${credential}`,
    });
    const firstHeaders = await proof(
      firstClient,
      firstSession,
      firstAlias.credential,
    );
    expect(
      (await h.request('/resource', { headers: firstHeaders })).status,
    ).toBe(200);

    expect(
      (
        await h.request('/resource', {
          headers: { Authorization: `Bearer ${firstAlias.credential}` },
        })
      ).status,
    ).toBe(401);
    const ingress = new VirtualApplicationIngress(origin);
    ingress.bind({ fetch: (request) => h.application().fetch(request) });
    const virtual = ingress.activate();
    expect(
      (
        await virtual.fetch(
          new Request(`${origin}/resource`, {
            headers: { Authorization: `Bearer ${firstAlias.credential}` },
          }),
        )
      ).status,
    ).toBe(401);
    ingress.stop();

    expect(
      (
        await h.request('/resource', {
          headers: {
            ...(await proof(firstClient, firstSession, firstAlias.credential)),
            Authorization: `Bearer ${secondAlias.credential}`,
          },
        })
      ).status,
    ).toBe(401);

    expect(
      h.pairing.revokeRelayCredentialAlias(
        h.device.device.id,
        firstAlias.aliasId,
      ),
    ).toBe(true);
    expect(
      (
        await h.request('/resource', {
          headers: await proof(
            firstClient,
            firstSession,
            firstAlias.credential,
          ),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.request('/resource', {
          headers: await proof(
            secondClient,
            secondSession,
            secondAlias.credential,
          ),
        })
      ).status,
    ).toBe(200);
  });

  test('relay cleanup keys cannot remove an ordinary continuation', async () => {
    const h = await harness();
    const continuation = await h.client.establish({
      username: 'alice',
      password: h.password,
    });
    const headers = {
      ...(await h.client.headers(continuation, {
        method: 'GET',
        url: `${origin}/resource`,
      })),
      Authorization: `Bearer ${h.device.credential}`,
    };
    expect(
      h
        .sessions()
        .discardUncommittedAuthority(continuation.authorityKey, 'N'.repeat(43)),
    ).toBe(0);
    expect(() =>
      h
        .sessions()
        .discardUncommittedAuthority(
          continuation.authorityKey,
          undefined as never,
        ),
    ).toThrow();
    expect(
      (await h.request('/resource', { method: 'GET', headers })).status,
    ).toBe(200);
  });

  test('pending relay continuation stays inert until its exact Device activates and provider session is promoted', async () => {
    let sessionNow = Date.now();
    const h = await harness({ now: () => sessionNow });
    const enrollmentId = 'N'.repeat(43);
    const pending = await h.accounts().service.createPendingEnrollment(
      enrollmentId,
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
    );
    expect(pending.kind).toBe('pending');
    if (pending.kind !== 'pending')
      throw new Error('provider did not create a pending enrollment session');
    const issuer = h.accounts().service.describe().issuer;
    const relayOffer = h.pairing.requestRelayEnrollmentAccess({
      enrollmentId,
      endpoint: origin,
      candidate: {
        issuer,
        subject: pending.session.subject,
        displayName: pending.session.displayName,
      },
      sessionId: pending.session.sessionId,
    });
    const relayConfirmation = h.pairing.confirmRelayEnrollmentRequest(
      relayOffer.requestId,
      { kind: 'presented-credential' },
      'human:deployment:operator',
      {
        enrollmentId,
        sessionId: pending.session.sessionId,
        issuer,
        subject: pending.session.subject,
      },
    );
    const relayBinding = relayConfirmation.principalBinding;
    if (
      !relayBinding ||
      !('kind' in relayBinding) ||
      relayBinding.kind !== 'account'
    )
      throw new Error('operator confirmation did not bind an account');
    const device = h.pairing.exchangeRelayEnrollment({
      offerId: relayOffer.offerId,
      proof: relayOffer.proof,
      requestId: relayOffer.requestId,
      enrollmentId,
      deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    const key = await createApplicationSessionKey();
    const authorityKey = randomUUID();
    const pendingDeviceAssertion = (
      candidateId: string,
      candidateEnrollmentId: string,
    ) =>
      candidateId === device.device.id && candidateEnrollmentId === enrollmentId
        ? {
            deviceId: device.device.id,
            enrollmentId,
            issuer,
            subject: pending.session.subject,
            approvalId: relayBinding.approvalId,
            approvedBy: relayBinding.approvedBy,
            scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
          }
        : null;
    h.setPendingRelayDeviceResolver(pendingDeviceAssertion);
    const issueInput = {
      enrollmentId,
      deviceId: device.device.id,
      providerSessionId: pending.session.sessionId,
      issuer,
      subject: pending.session.subject,
      approvalId: relayBinding.approvalId,
      approvedBy: relayBinding.approvedBy,
      authorityKey,
      stationId,
      clientOrigin: origin,
      key: key.publicKey,
      keyThumbprint: await calculateJwkThumbprint(key.publicKey),
      nonce: 'Z'.repeat(43),
      expiresAt: Date.parse(pending.session.expiresAt),
      signal: new AbortController().signal,
    };
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        stationId: `${stationId}-wrong`,
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        clientOrigin: 'https://untrusted.example.test',
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        keyThumbprint: 'Y'.repeat(43),
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        providerSessionId: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        enrollmentId: 'O'.repeat(43),
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        deviceId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      }),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => null);
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => ({
      deviceId: device.device.id,
      enrollmentId,
      issuer: `${issuer}-foreign`,
      subject: pending.session.subject,
      approvalId: relayBinding.approvalId,
      approvedBy: relayBinding.approvedBy,
      scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
    }));
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => ({
      deviceId: device.device.id,
      enrollmentId,
      issuer,
      subject: `${pending.session.subject}-foreign`,
      approvalId: relayBinding.approvalId,
      approvedBy: relayBinding.approvedBy,
      scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
    }));
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => ({
      deviceId: device.device.id,
      enrollmentId,
      issuer,
      subject: pending.session.subject,
      approvalId: relayBinding.approvalId,
      approvedBy: relayBinding.approvedBy,
      scope: [],
    }));
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => ({
      deviceId: device.device.id,
      enrollmentId,
      issuer,
      subject: pending.session.subject,
      approvalId: randomUUID(),
      approvedBy: relayBinding.approvedBy,
      scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
    }));
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(() => ({
      deviceId: device.device.id,
      enrollmentId,
      issuer,
      subject: pending.session.subject,
      approvalId: relayBinding.approvalId,
      approvedBy: `${relayBinding.approvedBy}-changed`,
      scope: [PAIRING_SCOPE_ORCHESTRATION_READ],
    }));
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    h.setPendingRelayDeviceResolver(pendingDeviceAssertion);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        authorityKey: randomUUID(),
        signal: aborted.signal,
      }),
    ).rejects.toThrow();
    const faultInput = issueInput;
    const faultDb = openPrivateSqlite(
      join(h.home, 'authentication', 'application-sessions.sqlite'),
      'Application session persistence fault fixture',
    );
    try {
      faultDb.exec(`CREATE TRIGGER fail_relay_continuation_insert
        BEFORE INSERT ON application_sessions
        WHEN json_extract(NEW.record, '$.relayEnrollmentId') IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected relay persistence fault'); END`);
      await expect(
        h.sessions().issuePendingRelayContinuation(faultInput),
      ).rejects.toThrow();
      faultDb.exec('DROP TRIGGER fail_relay_continuation_insert');
      expect(
        faultDb
          .prepare(
            "SELECT count(*) AS n FROM application_sessions WHERE json_extract(record, '$.authorityKey')=?",
          )
          .get(faultInput.authorityKey)?.n,
      ).toBe(0);
    } finally {
      faultDb.exec('DROP TRIGGER IF EXISTS fail_relay_continuation_insert');
      faultDb.close();
    }
    const continuation = await h
      .sessions()
      .issuePendingRelayContinuation(issueInput);
    expect(h.sessions().verifyPendingRelayContinuation(issueInput)).toBe(true);
    expect(
      h.sessions().verifyPendingRelayContinuation({
        ...issueInput,
        approvalId: randomUUID(),
      }),
    ).toBe(false);
    expect(
      h.sessions().verifyPendingRelayContinuation({
        ...issueInput,
        approvedBy: `${issueInput.approvedBy}-changed`,
      }),
    ).toBe(false);
    await expect(
      h.sessions().issuePendingRelayContinuation({
        ...issueInput,
        authorityKey: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      h.sessions().issuePendingRelayContinuation(issueInput),
    ).rejects.toThrow();
    const pendingClient = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      { credential: device.credential, credentialOrigin: origin },
      key,
    );
    const signed = await pendingClient.headers(continuation, {
      method: 'GET',
      url: `${origin}/resource`,
    });
    const response = await h.request('/resource', {
      method: 'GET',
      headers: {
        ...signed,
        Authorization: `Bearer ${device.credential}`,
      },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ kind: 'invalid' });
    expect(h.pairing.identifyDevice(device.credential)).toBeNull();

    h.pairing.activateRelayEnrollmentDevice(device.device.id, enrollmentId);
    const pendingProvider = await h.request('/resource', {
      method: 'GET',
      headers: {
        ...(await pendingClient.headers(continuation, {
          method: 'GET',
          url: `${origin}/resource`,
        })),
        Authorization: `Bearer ${device.credential}`,
      },
    });
    expect(pendingProvider.status).toBe(401);

    await h
      .accounts()
      .service.promotePendingEnrollment(
        enrollmentId,
        pending.session.sessionId,
        new AbortController().signal,
      );
    const admitted = await h.request('/resource', {
      method: 'GET',
      headers: {
        ...signed,
        Authorization: `Bearer ${device.credential}`,
      },
    });
    expect(await h.sessions().verifyActiveRelayContinuation(issueInput)).toBe(
      true,
    );
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({
      principal: continuation.principal,
    });
    await h.restart();
    const afterRestart = await h.request('/resource', {
      method: 'GET',
      headers: {
        ...(await pendingClient.headers(continuation, {
          method: 'GET',
          url: `${origin}/resource`,
        })),
        Authorization: `Bearer ${device.credential}`,
      },
    });
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.json()).toMatchObject({
      principal: continuation.principal,
    });
    let expirationVerificationEntered!: () => void;
    let releaseExpirationVerification!: () => void;
    const expirationEntered = new Promise<void>((resolve) => {
      expirationVerificationEntered = resolve;
    });
    const expirationGate = new Promise<void>((resolve) => {
      releaseExpirationVerification = resolve;
    });
    const verifyBeforeExpiry = h
      .accounts()
      .service.verifySessionReference.bind(h.accounts().service);
    const expirationSpy = vi
      .spyOn(h.accounts().service, 'verifySessionReference')
      .mockImplementation(async (...args) => {
        expirationVerificationEntered();
        await expirationGate;
        return verifyBeforeExpiry(...args);
      });
    try {
      const checking = h.sessions().verifyActiveRelayContinuation(issueInput);
      await expirationEntered;
      sessionNow = Date.parse(continuation.expiresAt) + 1;
      releaseExpirationVerification();
      await expect(checking).resolves.toBe(false);
    } finally {
      releaseExpirationVerification();
      expirationSpy.mockRestore();
      sessionNow = Date.now();
    }
    expect(
      h.sessions().discardUncommittedAuthority(authorityKey, 'O'.repeat(43)),
    ).toBe(0);
    let providerVerificationEntered!: () => void;
    let releaseProviderVerification!: () => void;
    const entered = new Promise<void>((resolve) => {
      providerVerificationEntered = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProviderVerification = resolve;
    });
    const originalVerify = h
      .accounts()
      .service.verifySessionReference.bind(h.accounts().service);
    const verifySpy = vi
      .spyOn(h.accounts().service, 'verifySessionReference')
      .mockImplementation(async (...args) => {
        providerVerificationEntered();
        await providerGate;
        return originalVerify(...args);
      });
    try {
      const checking = h.sessions().verifyActiveRelayContinuation(issueInput);
      await entered;
      h.pairing.revokeDevice(device.device.id, 'operator-credential');
      releaseProviderVerification();
      await expect(checking).resolves.toBe(false);
    } finally {
      releaseProviderVerification();
      verifySpy.mockRestore();
    }
    expect(
      h.sessions().discardUncommittedAuthority(authorityKey, enrollmentId),
    ).toBe(1);
  });

  test('an account-bound Device accepts only the matching provider account while cookie-only enrollment stays available', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    const Cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const authenticated = await h.accounts().service.authenticate(
      new Request(`${origin}/api/account-auth/session`, {
        headers: { Cookie },
      }),
    );
    expect(authenticated.kind).toBe('authenticated');
    if (authenticated.kind !== 'authenticated') return;
    const offer = h.pairing.createOffer({ endpoint: origin });
    const pending = h.pairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Account-bound device',
      requesterPosition: 'off-box',
      accountCandidate: {
        issuer: authenticated.issuer,
        subject: authenticated.session.subject,
        displayName: authenticated.session.displayName,
      },
      accountCandidateSessionId: authenticated.session.sessionId,
    });
    h.pairing.confirmRequest(
      pending.requestId,
      { kind: 'presented-credential' },
      { principalId: 'human:local:operator', kind: 'account' },
    );
    const bound = h.pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    });
    const matching = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: bound.credential,
        credentialOrigin: origin,
        headers: { Cookie },
      },
      await createApplicationSessionKey(),
    );
    await expect(matching.establish()).resolves.toMatchObject({
      principal: authenticated.principal,
    });

    const signup = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-up/username`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'x-station-invitation': 'second-enrollment',
        },
        body: JSON.stringify({
          username: 'bob',
          password: 'Second account fixture password',
        }),
      }),
      '/sign-up/username',
    );
    expect(signup.status).toBe(200);
    const wrong = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      { credential: bound.credential, credentialOrigin: origin },
      await createApplicationSessionKey(),
    );
    await expect(
      wrong.establish({
        username: 'bob',
        password: 'Second account fixture password',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  test('a cookie exchange keeps cookies private, persists replay refusal across restart and preserves its account identity', async () => {
    const h = await harness();
    const login = await h.accounts().service.handle(
      new Request(`${origin}/api/account-auth/sign-in/username`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: h.password }),
      }),
      '/sign-in/username',
    );
    expect(login.status).toBe(200);
    const Cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const cookieClient = new ApplicationSessionClient(
      origin,
      stationId,
      origin,
      {
        credential: h.device.credential,
        credentialOrigin: origin,
        headers: { Cookie },
      },
      h.key,
    );
    const session = await cookieClient.establish();
    expect(JSON.stringify(session)).not.toContain(Cookie);
    const proof = await h.client.headers(session, {
      method: 'GET',
      url: `${origin}/resource`,
    });
    const headers = {
      ...proof,
      Authorization: `Bearer ${h.device.credential}`,
    };
    const first = await h.request('/resource', { headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ principal: session.principal });
    await h.restart();
    expect((await h.request('/resource', { headers })).status).toBe(401);
    const fresh = await h.client.headers(session, {
      method: 'GET',
      url: `${origin}/resource`,
    });
    expect(
      (
        await h.request('/resource', {
          headers: { ...fresh, Authorization: `Bearer ${h.device.credential}` },
        })
      ).status,
    ).toBe(200);
  });

  test('another active Device or an alternate allowed origin cannot reuse a continuation, and account disable revokes it', async () => {
    const h = await harness();
    const session = await h.client.establish({
      username: 'alice',
      password: h.password,
    });
    const proof = () =>
      h.client.headers(session, { method: 'GET', url: `${origin}/resource` });
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...(await proof()),
            Authorization: `Bearer ${h.second.credential}`,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...(await proof()),
            Authorization: `Bearer ${h.device.credential}`,
            Origin: alternateOrigin,
          },
        })
      ).status,
    ).toBe(401);
    const account = h.accounts().administration.list()[0]!;
    h.accounts().administration.setDisabled(account.accountId, true);
    expect(
      (
        await h.request('/resource', {
          headers: {
            ...(await proof()),
            Authorization: `Bearer ${h.device.credential}`,
          },
        })
      ).status,
    ).toBe(401);
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
  });

  test('failed login uses no cookie shortcut, and oversized controls are refused by the body owner', async () => {
    const h = await harness();
    await expect(
      h.client.establish({ username: 'alice', password: 'wrong password' }),
    ).rejects.toThrow();
    const oversized = await h.request('/api/account-auth/continuations/login', {
      method: 'POST',
      body: 'x'.repeat(20 * 1024),
      headers: {
        Origin: origin,
        Authorization: `Bearer ${h.device.credential}`,
      },
    });
    expect(oversized.status).toBe(413);
    expect(h.pairing.verifyCredential(h.device.credential)).toBe(true);
  });
});
