/**
 * Authority observation capture/revalidate/guard unit tests.
 *
 * The seam under test here is the registry snapshot discipline (clone
 * before `await`, stable equality, post-`await` re-derivation) and the
 * delivery guard — with deterministic wait barriers, not sleeps. The
 * `security` object is a stub registry BY DESIGN: these tests prove what
 * capture does with shared mutable records, which the real registry never
 * hands out. The canonical principal owner is intentionally a fixed echo
 * here; the route suite covers the REAL owner end to end, and the one
 * route-level fault-injection there covers the resolver-throw mapping.
 * `isRuntimeRequestPrincipalCurrent` runs REAL (WeakMap-registered
 * principal, real scope table), so currency still means what the boundary
 * means.
 */
import type {
  PairedDevice,
  PublicStationHandshake,
} from '@kontourai/station-contracts/environment-security';
import { describe, expect, test } from 'vitest';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import {
  AuthorityObservationRejected,
  type CapturedAuthorityObservation,
  captureAuthorityObservation,
  guardAuthorityObservationResponse,
  revalidateAuthorityObservation,
} from '../authority-observation.js';
import type { ResolvedDeploymentAuthentication } from '../deployment-authentication-service.js';

const CREDENTIAL = 'u'.repeat(43);
const READ_SCOPE = 'orchestration:read orchestration:operate';

interface Gate {
  entered: () => void;
  wait: Promise<void>;
}

function deferredGate(): Gate & {
  enteredPromise: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markEntered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  return { entered: markEntered, enteredPromise, wait, release };
}

interface StubState {
  authorized: boolean;
  scope: string | undefined;
  environmentId: string;
  /** Shared mutable record: every lookup returns THIS object. */
  device: PairedDevice | null;
  handshakeGate: Gate | null;
  authenticateGate: Gate | null;
  account: 'authenticated' | 'absent' | 'invalid' | 'unavailable';
  accountPrincipalId: string;
  accountWasAuthenticated: boolean;
  calls: string[];
}

function makeState(): StubState {
  return {
    authorized: true,
    scope: READ_SCOPE,
    environmentId: 'env-1',
    device: {
      id: 'device-1',
      name: 'stub-device',
      scope: READ_SCOPE,
      kind: 'device',
      createdAt: 1,
      activityTracking: 'tracked-since-issued',
      lastSeenFrom: null,
      usageCount: null,
      lastActiveDay: null,
      revokedAt: null,
      revocation: { state: 'not-revoked' },
      principalBinding: {
        provider: 'tailscale-serve',
        subject: 'alice',
        approvedAt: 1,
        approvalId: 'approval-1',
        approvedBy: 'human:local:operator',
      },
    },
    handshakeGate: null,
    authenticateGate: null,
    account: 'authenticated',
    accountPrincipalId: 'human:device:device-1',
    accountWasAuthenticated: true,
    calls: [],
  };
}

function stubHandshake(environmentId: string): PublicStationHandshake {
  return {
    schemaVersion: 1,
    environmentId,
    authentication: { scheme: 'bearer', protocolVersion: 1 },
    transports: { http: 1, sse: 1, websocket: 1 },
    compatibility: {
      serverVersion: 'test',
      protocolVersion: 1,
      minClientProtocol: 1,
    },
  };
}

function makeSecurity(state: StubState) {
  return {
    getPublicHandshake: async () => {
      state.calls.push('handshake');
      if (state.handshakeGate) {
        state.handshakeGate.entered();
        await state.handshakeGate.wait;
      }
      return stubHandshake(state.environmentId);
    },
    identifyDevice: (credential: string) => {
      state.calls.push('identifyDevice');
      if (credential !== CREDENTIAL) return null;
      return state.device;
    },
    resolveGrantedScope: (credential: string) => {
      state.calls.push('resolveGrantedScope');
      if (credential !== CREDENTIAL) return undefined;
      return state.scope;
    },
    authorizeCredential: (credential: string) => {
      state.calls.push('authorizeCredential');
      return credential === CREDENTIAL && state.authorized;
    },
  };
}

function stubAuthenticatedAccount(
  principalId: string,
): ResolvedDeploymentAuthentication {
  return {
    kind: 'authenticated',
    issuer: 'urn:station:stub',
    principal: { id: principalId, kind: 'human', display: 'Device' },
    session: {
      subject: 'stub-subject',
      displayName: 'Device',
      sessionId: 'non-secret-record',
      authenticatedAt: new Date(0).toISOString(),
      expiresAt: new Date(3_600_000).toISOString(),
      contacts: [],
    },
  };
}

function makeDeploymentAuthentication(state: StubState) {
  return {
    service: {
      current: (): ResolvedDeploymentAuthentication | undefined => {
        if (!state.accountWasAuthenticated) return { kind: 'absent' };
        return stubAuthenticatedAccount(state.accountPrincipalId);
      },
      authenticate: async (): Promise<ResolvedDeploymentAuthentication> => {
        state.calls.push('authenticate');
        if (state.authenticateGate) {
          state.authenticateGate.entered();
          await state.authenticateGate.wait;
        }
        switch (state.account) {
          case 'authenticated':
            return stubAuthenticatedAccount(state.accountPrincipalId);
          case 'absent':
            return { kind: 'absent' };
          case 'invalid':
            return { kind: 'invalid', reason: 'revoked' };
          case 'unavailable':
            return { kind: 'unavailable' };
        }
      },
    },
  };
}

function makeRequest(): Request {
  const request = new Request('https://station.test/api/auth/authority');
  setRuntimeAuthenticatedRequestPrincipal(request, {
    kind: 'credential',
    credential: CREDENTIAL,
    authority: 'device-credential',
    deviceId: 'device-1',
    source: 'bearer',
  });
  return request;
}

async function capture(state: StubState) {
  const security = makeSecurity(state);
  const request = makeRequest();
  return captureAuthorityObservation({
    context: { env: {}, req: { raw: request, header: () => undefined } },
    request,
    runtimePrincipal: {
      kind: 'credential',
      credential: CREDENTIAL,
      authority: 'device-credential',
      deviceId: 'device-1',
      source: 'bearer',
    },
    security,
    deploymentAuthentication: makeDeploymentAuthentication(state),
    // Fixed echo: the canonical owner is covered by the route suite; the
    // seam under test here is snapshot discipline, not resolution.
    resolveRequestPrincipal: () => ({
      id: 'human:device:device-1',
      kind: 'human',
      display: 'Device',
    }),
  });
}

async function revalidate(
  state: StubState,
  captured: CapturedAuthorityObservation,
) {
  return revalidateAuthorityObservation({
    // A fresh WeakMap registration carrying the SAME credential: currency
    // still means what the boundary means, without sharing request state
    // between capture and release.
    request: makeRequest(),
    captured,
    security: makeSecurity(state),
    deploymentAuthentication: makeDeploymentAuthentication(state),
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<{
  status: number;
  code: string;
}> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthorityObservationRejected) {
      return { status: error.status, code: error.code };
    }
    throw error;
  }
  throw new Error('expected AuthorityObservationRejected');
}

describe('binding comparison behavior', () => {
  test('key reordering without value drift still validates', async () => {
    const state = makeState();
    const captured = await capture(state);
    // Same values, different key insertion order (whose JSON differs):
    // structural equality must pass where a stringify compare would refuse.
    const reordered = {
      approvedBy: 'human:local:operator',
      approvalId: 'approval-1',
      approvedAt: 1,
      subject: 'alice',
      provider: 'tailscale-serve' as const,
    };
    expect(JSON.stringify(state.device!.principalBinding)).not.toBe(
      JSON.stringify(reordered),
    );
    state.device = { ...state.device!, principalBinding: reordered };
    await revalidate(state, captured);
  });

  test('binding variant replacement fails closed', async () => {
    const state = makeState();
    const captured = await capture(state);
    state.device = {
      ...state.device!,
      principalBinding: {
        kind: 'account',
        issuer: 'urn:station:x',
        subject: 'alice',
        displayName: 'Alice',
        approvedAt: 1,
        approvalId: 'approval-1',
        approvedBy: 'human:local:operator',
      },
    };
    expect(await rejectionOf(revalidate(state, captured))).toEqual({
      status: 403,
      code: 'authority_changed',
    });
  });
});

describe('captureAuthorityObservation snapshot discipline', () => {
  test('reads device and scopes BEFORE the handshake await', async () => {
    const state = makeState();
    const gate = deferredGate();
    state.handshakeGate = gate;
    const pending = capture(state);
    // The handshake is parked; every synchronous registry fact must
    // already be recorded — nothing may be read after the await.
    await gate.enteredPromise;
    expect(state.calls).toContain('identifyDevice');
    expect(state.calls).toContain('resolveGrantedScope');
    const deviceCallsBeforeRelease = state.calls.filter(
      (call) => call === 'identifyDevice',
    ).length;
    expect(deviceCallsBeforeRelease).toBe(1);
    gate.release();
    const captured = await pending;
    expect(captured.envelope.grant).toEqual({
      kind: 'device',
      deviceId: 'device-1',
      grantedScopes: ['orchestration:read', 'orchestration:operate'],
    });
  });

  test('in-place mutation of the shared record after capture fails closed', async () => {
    const state = makeState();
    const captured = await capture(state);
    // The provider mutates its shared record in place (same object the
    // capture read). A retained live reference would now agree with the
    // fresh read and pass; the structured-clone snapshot must refuse.
    // Intentional in-place mutation of the shared record (cast through
    // the readonly contract fields) — exactly the provider behavior the
    // snapshot discipline defends against.
    (state.device!.principalBinding as { subject: string }).subject = 'mallory';
    await expect(revalidate(state, captured)).rejects.toThrow(
      'authority_changed',
    );
    expect(await rejectionOf(revalidate(state, captured))).toEqual({
      status: 403,
      code: 'authority_changed',
    });
  });

  test('scope drift after capture fails closed', async () => {
    const state = makeState();
    const captured = await capture(state);
    // Still current for the route (keeps the read tier) but no longer the
    // captured grant: drift, not loss of currency, so 403 — while dropping
    // the read tier entirely is a 401 (see the route suite's narrowed grant).
    state.scope = 'orchestration:read terminal:operate';
    expect(await rejectionOf(revalidate(state, captured))).toEqual({
      status: 403,
      code: 'authority_changed',
    });
  });
});

describe('revalidateAuthorityObservation freshness', () => {
  test('credential revoked DURING the account await fails closed after it', async () => {
    const state = makeState();
    const captured = await capture(state);
    const gate = deferredGate();
    state.authenticateGate = gate;
    const pending = revalidate(state, captured);
    await gate.enteredPromise;
    // Revoke mid-await: the registry no longer knows the credential at all.
    state.authorized = false;
    state.device = null;
    state.scope = undefined;
    gate.release();
    expect(await rejectionOf(pending)).toEqual({
      status: 401,
      code: 'authentication_required',
    });
  });

  test('binding replaced DURING the account await fails closed after it', async () => {
    const state = makeState();
    const captured = await capture(state);
    const gate = deferredGate();
    state.authenticateGate = gate;
    const pending = revalidate(state, captured);
    await gate.enteredPromise;
    state.device = {
      ...state.device!,
      principalBinding: {
        provider: 'tailscale-serve',
        subject: 'replacement',
        approvedAt: 2,
        approvalId: 'approval-2',
        approvedBy: 'human:local:operator',
      },
    };
    gate.release();
    expect(await rejectionOf(pending)).toEqual({
      status: 403,
      code: 'authority_changed',
    });
  });

  test('account lost DURING the environment await is caught by the trailing authenticate', async () => {
    const state = makeState();
    const captured = await capture(state);
    const gate = deferredGate();
    state.handshakeGate = gate;
    const pending = revalidate(state, captured);
    await gate.enteredPromise;
    // The session dies while the environment read is in flight. The
    // trailing re-authentication — the final authority proof, never the
    // cached per-request result — must refuse.
    state.account = 'invalid';
    gate.release();
    expect(await rejectionOf(pending)).toEqual({
      status: 401,
      code: 'authentication_required',
    });
  });

  test('lost account backing fails closed; mismatched account conflicts; outage is 503', async () => {
    const state = makeState();
    const captured = await capture(state);
    state.account = 'absent';
    expect(await rejectionOf(revalidate(state, captured))).toEqual({
      status: 401,
      code: 'authentication_required',
    });
    state.account = 'authenticated';
    state.accountPrincipalId = 'human:device:someone-else';
    expect(await rejectionOf(revalidate(state, captured))).toEqual({
      status: 403,
      code: 'authority_changed',
    });
    state.accountPrincipalId = 'human:device:device-1';
    state.account = 'unavailable';
    expect(await rejectionOf(revalidate(state, captured))).toEqual({
      status: 503,
      code: 'authentication_unavailable',
    });
  });

  test('environment rotation fails closed', async () => {
    const state = makeState();
    const captured = await capture(state);
    state.environmentId = 'env-2';
    expect(await rejectionOf(revalidate(state, captured))).toEqual({
      status: 403,
      code: 'authority_changed',
    });
  });
});

describe('guardAuthorityObservationResponse', () => {
  test('refuses before the first byte without publishing the queued body', async () => {
    const guarded = await guardAuthorityObservationResponse(
      Response.json({ environmentId: 'env-1', secret: 'marker' }),
      async () => {
        throw new AuthorityObservationRejected(401, 'authentication_required');
      },
    );
    expect(guarded.status).toBe(401);
    expect(guarded.headers.get('Cache-Control')).toBe('no-store');
    expect(await guarded.json()).toEqual({
      error: { code: 'authentication_required' },
    });
  });

  test('passes bytes through with no-store when current', async () => {
    const guarded = await guardAuthorityObservationResponse(
      Response.json({ environmentId: 'env-1' }),
      async () => {},
    );
    expect(guarded.status).toBe(200);
    expect(guarded.headers.get('Cache-Control')).toBe('no-store');
    expect(await guarded.json()).toEqual({ environmentId: 'env-1' });
  });

  test('refuses mid-stream without waiting for the producer', async () => {
    let current = true;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first'));
        controller.enqueue(new TextEncoder().encode('second'));
      },
    });
    const guarded = await guardAuthorityObservationResponse(
      new Response(source),
      async () => {
        if (!current) {
          throw new AuthorityObservationRejected(403, 'authority_changed');
        }
      },
    );
    const reader = guarded.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    current = false;
    await expect(reader.read()).rejects.toThrow(
      'Authority observation ended before response delivery.',
    );
  });
});
