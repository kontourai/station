import { createHash } from 'node:crypto';
import {
  APPLICATION_SESSION_NATIVE_HEADER as CONTINUATION,
  APPLICATION_SESSION_NATIVE_PROOF_HEADER as PROOF,
  APPLICATION_SESSION_NATIVE_VERSION as VERSION,
} from '@kontourai/station-contracts/application-session';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { createApplicationSessionKey } from '@kontourai/station-sdk/application-session';
import {
  applicationSessionKeyThumbprint,
  createNativeApplicationSessionProof,
} from '@kontourai/station-sdk/application-session-native';
import { expect, test, vi } from 'vitest';
import {
  createNativeAccountSessionBridge,
  type NativeAccountApplicationOwner,
} from '../nativeAccountSessionBridge';

const opaque = (value: number) => Buffer.alloc(32, value).toString('base64url');
async function fixture(contextLifetimeMs = 120000, serverLifetimeMs = 300000) {
  const key = await createApplicationSessionKey();
  const signal = new AbortController();
  const preparedAt = Date.now();
  let current = true;
  const target = {
    kind: 'station-native' as const,
    stationId: '11111111-1111-4111-8111-111111111111',
    audience: 'https://station.example',
    surface: {
      kind: 'station-native' as const,
      appIdentifier: 'io.kontourai.station.nightly',
      channel: 'nightly' as const,
      clientInstanceId: '22222222-2222-4222-8222-222222222222',
      keyThumbprint: opaque(1),
    },
  };
  const deviceId = '33333333-3333-4333-8333-333333333333';
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const continuation = {
    version: VERSION,
    credential: opaque(3),
    nonce: opaque(4),
    expiresAt,
    authorityKey: '44444444-4444-4444-8444-444444444444',
    principal: humanPrincipal('fixture', 'zach', 'Zach'),
    deviceId,
    target,
    keyThumbprint: await applicationSessionKeyThumbprint(key.publicKey),
  };
  const context = opaque(5),
    challengeId = opaque(6),
    challengeNonce = opaque(7);
  const membership = {
    scope: {
      stationId: target.stationId,
      localProjectId: 'project-1',
      localProjectSlug: 'shared',
      portableProjectId: 'portable-1',
    },
    grantsDeviceAccess: false as const,
  };
  let acceptanceResponse: unknown = { data: membership };
  let logoutResponse: unknown = { data: { revoked: true } };
  let hangAcceptance = false;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const application: NativeAccountApplicationOwner = {
    origin: target.audience,
    scope: {
      stationId: target.stationId,
      enrollmentId: '55555555-5555-4555-8555-555555555555',
      routingGeneration: 1,
    },
    surface: target.surface,
    isCurrent: () => current,
    assertCurrent: async () => {
      if (!current) throw new Error('retired');
    },
    async fetch(input, init) {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/native/challenge'))
        return Response.json({
          data: {
            version: VERSION,
            challengeId,
            nonce: challengeNonce,
            expiresAt,
            target,
            deviceId,
            keyThumbprint: continuation.keyThumbprint,
          },
        });
      if (url.endsWith('/native/exchange'))
        return Response.json({
          data: {
            ...continuation,
            expiresAt: new Date(Date.now() + serverLifetimeMs).toISOString(),
          },
        });
      if (url.endsWith('/native/revoke')) return Response.json(logoutResponse);
      if (url.endsWith('/accept-invitation'))
        return hangAcceptance
          ? new Response(new ReadableStream())
          : Response.json(acceptanceResponse);
      throw new Error('unlisted request');
    },
  };
  const invoke = {
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'station_native_account_challenge_prepare')
        return {
          version: 'station-native-account-operation/v1',
          accountContextHandle: context,
          contextExpiresAtMs: preparedAt + contextLifetimeMs,
          publicKey: key.publicKey,
          target,
          deviceId,
          body: { version: VERSION, publicKey: key.publicKey },
        };
      if (args?.accountContextHandle !== context)
        throw new Error('wrong context');
      const trust = { ...target, deviceId };
      if (command === 'station_native_account_exchange_prepare') {
        const credentials = args.credentials as {
          username: string;
          password: string;
        };
        const ordered = {
          username: credentials.username,
          password: credentials.password,
        };
        const proof = await createNativeApplicationSessionProof(key, trust, {
          purpose: 'exchange',
          deviceId,
          nonce: challengeNonce,
          method: 'POST',
          path: '/api/account-auth/continuations/native/exchange',
          challengeIdHash: createHash('sha256')
            .update(challengeId)
            .digest('base64url'),
          credentialsHash: createHash('sha256')
            .update(JSON.stringify(ordered))
            .digest('base64url'),
          expiresAtMs: Date.parse(expiresAt),
        });
        return {
          body: { version: VERSION, challengeId, credentials: ordered, proof },
          headers: { [PROOF]: proof },
        };
      }
      const request = args.request as
        | { method: 'GET' | 'HEAD' | 'POST'; path: string }
        | undefined;
      const proof = await createNativeApplicationSessionProof(key, trust, {
        purpose: 'request',
        deviceId,
        nonce: continuation.nonce,
        method: request?.method ?? 'POST',
        path:
          request?.path ??
          (command === 'station_native_account_revoke_prepare'
            ? '/api/account-auth/continuations/native/revoke'
            : '/api/account-auth/accept-invitation'),
        credentialHash: createHash('sha256')
          .update(continuation.credential)
          .digest('base64url'),
        expiresAtMs: Date.parse(expiresAt),
      });
      const headers = {
        [CONTINUATION]: continuation.credential,
        [PROOF]: proof,
      };
      if (
        command === 'station_native_account_request_headers' ||
        command === 'station_native_account_management_headers'
      )
        return headers;
      if (command === 'station_native_account_revoke_prepare')
        return { body: {}, headers };
      if (command === 'station_native_account_accept_invitation_prepare')
        return { body: { token: args.token }, headers };
      throw new Error('unlisted command');
    }),
  };
  const bridge = await createNativeAccountSessionBridge({
    profileName: 'Station',
    expectedProfileRevision: 2,
    signal: signal.signal,
    application,
    invoke,
  });
  return {
    bridge,
    preparedAt,
    membership,
    setLogout: (result: unknown) => {
      logoutResponse = result;
    },
    setAcceptance: (result: unknown) => {
      acceptanceResponse = result;
    },
    signal,
    calls,
    invoke,
    hang: () => {
      hangAcceptance = true;
    },
    retireOwner: () => {
      current = false;
    },
  };
}

test('native account bridge composes structured host proofs and forwards fixed invitation body while exposing only public account scope', async () => {
  const h = await fixture();
  expect(h.bridge.current()).toBeNull();
  const publicScope = await h.bridge.login({
    username: 'zach',
    password: 'Native fixture password',
  });
  expect(h.bridge.current()).toBe(publicScope);
  expect(publicScope).not.toHaveProperty('credential');
  expect(publicScope).not.toHaveProperty('nonce');
  expect(publicScope).not.toHaveProperty('accountContextHandle');
  const headers = await h.bridge.requestHeaders({
    method: 'GET',
    path: '/api/projects',
  });
  expect(headers[PROOF]).toBeTypeOf('string');
  await expect(h.bridge.acceptInvitation(opaque(8))).resolves.toEqual(
    h.membership,
  );
  h.setAcceptance({ data: { grantsDeviceAccess: false } });
  await expect(h.bridge.acceptInvitation(opaque(8))).rejects.toThrow();
  h.setAcceptance({
    data: {
      ...h.membership,
      scope: {
        ...h.membership.scope,
        stationId: '99999999-9999-4999-8999-999999999999',
      },
    },
  });
  await expect(h.bridge.acceptInvitation(opaque(8))).rejects.toThrow(
    'native_account_membership_owner_mismatch',
  );
  const accepted = h.calls.find((call) =>
    call.url.endsWith('/accept-invitation'),
  )!;
  expect(accepted.init?.method).toBe('POST');
  expect(accepted.init?.body).toBe(JSON.stringify({ token: opaque(8) }));
  expect(new Headers(accepted.init?.headers).has('Origin')).toBe(false);
  expect(new Headers(accepted.init?.headers).has('Cookie')).toBe(false);
  expect(new Headers(accepted.init?.headers).has('Authorization')).toBe(false);
  const observer = vi.fn();
  h.bridge.subscribe(observer);
  h.bridge.retire();
  expect(h.bridge.current()).toBeNull();
  expect(observer).toHaveBeenCalledTimes(1);
  await expect(
    h.bridge.requestHeaders({ method: 'GET', path: '/api/projects' }),
  ).rejects.toThrow('retired');
});
test('native account bridge cancellation clears public scope and settles a caller waiting for response EOF', async () => {
  const h = await fixture();
  await h.bridge.login({
    username: 'zach',
    password: 'Native fixture password',
  });
  h.hang();
  const pending = h.bridge.acceptInvitation(opaque(8));
  await vi.waitFor(() =>
    expect(
      h.calls.some((call) => call.url.endsWith('/accept-invitation')),
    ).toBe(true),
  );
  h.signal.abort();
  await expect(pending).rejects.toThrow();
  expect(h.bridge.current()).toBeNull();
});

test('remote native logout consumes only the fixed host prepared operation and retires public account state after confirmed acknowledgment', async () => {
  const h = await fixture();
  await h.bridge.login({ username: 'zach', password: 'password' });
  await expect(h.bridge.logout()).resolves.toEqual({ revoked: true });
  expect(h.bridge.current()).toBeNull();
  const request = h.calls.find((call) => call.url.endsWith('/native/revoke'));
  expect(request?.init?.body).toBe('{}');
  expect(request?.init?.method).toBe('POST');
  expect(
    h.invoke.invoke.mock.calls.some(
      (call) => call[0] === 'station_native_account_revoke_prepare',
    ),
  ).toBe(true);
  await expect(
    h.bridge.requestHeaders({ method: 'GET', path: '/api/projects' }),
  ).rejects.toThrow();
});

test('remote native logout refuses an unconfirmed success response while still removing local account scope', async () => {
  const h = await fixture();
  await h.bridge.login({ username: 'zach', password: 'password' });
  h.setLogout({ data: { revoked: false } });
  await expect(h.bridge.logout()).rejects.toThrow();
  expect(h.bridge.current()).toBeNull();
});

test('account sign-in delay never publishes server continuation beyond the actual captured host preparation deadline', async () => {
  const h = await fixture(900000, 900000);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(h.preparedAt + 60000);
  try {
    const account = await h.bridge.login({
      username: 'zach',
      password: 'password',
    });
    expect(Date.parse(account.expiresAt)).toBe(h.preparedAt + 900000);
    clock.mockReturnValue(Date.parse(account.expiresAt));
    expect(h.bridge.current()).toBeNull();
    await expect(
      h.bridge.requestHeaders({ method: 'GET', path: '/api/projects' }),
    ).rejects.toThrow();
    await expect(h.bridge.logout()).rejects.toThrow();
  } finally {
    clock.mockRestore();
  }
});

test('management proof follows the selected native account through the dedicated host operation and refuses unlisted or retired requests', async () => {
  const h = await fixture();
  await h.bridge.login({
    username: 'zach',
    password: 'Native fixture password',
  });
  const target = {
    method: 'POST' as const,
    path: '/api/relay-management/invitations',
  };
  const headers = await h.bridge.managementHeaders(target);
  expect(headers[PROOF]).toBeTypeOf('string');
  expect(h.invoke.invoke).toHaveBeenCalledWith(
    'station_native_account_management_headers',
    expect.objectContaining({ request: target }),
  );
  const count = h.invoke.invoke.mock.calls.length;
  await expect(
    h.bridge.managementHeaders({
      method: 'POST',
      path: '/api/pairing/devices',
    }),
  ).rejects.toThrow();
  expect(h.invoke.invoke.mock.calls.length).toBe(count);
  h.retireOwner();
  await expect(h.bridge.managementHeaders(target)).rejects.toThrow('retired');
});
