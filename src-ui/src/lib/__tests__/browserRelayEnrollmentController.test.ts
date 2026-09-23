/** @vitest-environment jsdom */

import type { SavedConnection } from '@kontourai/station-connect';
import { APPLICATION_SESSION_VERSION } from '@kontourai/station-contracts/application-session';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  RELAY_ENROLLMENT_ACTIVATE_PATH,
  RELAY_ENROLLMENT_BEGIN_PATH,
  RELAY_ENROLLMENT_FINALIZE_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
  RELAY_ENROLLMENT_VERSION,
  type RelayEnrollmentChallenge,
  type RelayEnrollmentContinuationBundle,
  type RelayEnrollmentDeliveredResponse,
} from '@kontourai/station-contracts/relay-enrollment';
import {
  createRelayEnrollmentKey,
  digestRelayEnrollmentBundle,
} from '@kontourai/station-sdk/relay-enrollment';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserRelayEnrollmentController,
  type BrowserRelayEnrollmentRoute,
} from '../browserRelayEnrollmentController';

const stationId = '11111111-1111-4111-8111-111111111111';
const route: NonNullable<SavedConnection['brokerRoute']> = {
  brokerOrigin: 'https://broker.example.test',
  scope: {
    stationId,
    enrollmentId: '22222222-2222-4222-8222-222222222222',
    routingGeneration: 4,
    browserOrigin: window.location.origin,
  },
};
const applicationOrigin = 'https://station.example.test';
const opaque = (value: string) => value.repeat(43).slice(0, 43);

async function thumbprint(
  key: Awaited<ReturnType<typeof createRelayEnrollmentKey>>,
) {
  const canonical = JSON.stringify({
    crv: key.publicKey.crv,
    kty: key.publicKey.kty,
    x: key.publicKey.x,
    y: key.publicKey.y,
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeRoute(
  transport: typeof fetch,
  isCurrent = () => true,
): BrowserRelayEnrollmentRoute {
  return {
    connectionId: 'connection-1',
    applicationOrigin,
    clientOrigin: window.location.origin,
    route,
    transport,
    isCurrent,
  };
}

function requestTransport(
  handler: (request: Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBeInstanceOf(URL);
    const request =
      input instanceof Request && init === undefined
        ? input
        : new Request(input, init);
    return handler(request, init);
  }) as typeof fetch;
}

function proofClaims(compact: string) {
  const payload = compact.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(payload)) as Record<string, unknown>;
}

async function proofDigest(compact: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(compact)),
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

afterEach(() => vi.useRealTimers());

describe('browser relay fresh enrollment controller', () => {
  it('keeps the client un-enrolled until signed activation succeeds', async () => {
    const steps: string[] = [];
    let challenge: RelayEnrollmentChallenge | undefined;
    let delivery: RelayEnrollmentDeliveredResponse | undefined;
    let finalizeCount = 0;
    const handler = vi.fn(async (request: Request, init?: RequestInit) => {
      const url = new URL(request.url);
      const body = await request.json();
      steps.push(url.pathname);
      expect(url.origin).toBe(applicationOrigin);
      expect(request.method).toBe('POST');
      const origin = new Headers(init?.headers).get('Origin');
      expect(origin).toBe(window.location.origin);
      if (url.pathname === RELAY_ENROLLMENT_BEGIN_PATH) {
        // The public key in the request is rebound to the returned challenge.
        const publicKey = body.publicKey;
        const keyThumbprint = await thumbprint({ publicKey } as Awaited<
          ReturnType<typeof createRelayEnrollmentKey>
        >);
        challenge = {
          version: RELAY_ENROLLMENT_VERSION,
          stationId,
          requestOrigin: applicationOrigin,
          clientOrigin: window.location.origin,
          enrollmentId: opaque('E'),
          publicKey,
          keyThumbprint,
          nonce: opaque('N'),
          purpose: 'login',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        return json(challenge, 201);
      }
      if (url.pathname === RELAY_ENROLLMENT_LOGIN_PATH) {
        expect(body.enrollmentId).toBe(challenge!.enrollmentId);
        expect(body.proof).toContain('.');
        expect(proofClaims(body.proof as string)).toMatchObject({
          stationId,
          clientOrigin: origin,
          htm: 'POST',
          htu: `${applicationOrigin}${RELAY_ENROLLMENT_LOGIN_PATH}`,
        });
        expect(body.credentials).toEqual({
          username: 'zach',
          password: 'secret',
        });
        return json(
          {
            version: RELAY_ENROLLMENT_VERSION,
            state: 'pending',
            enrollmentId: challenge!.enrollmentId,
            requestId: 'pairing-request-1',
            expiresAt: challenge!.expiresAt,
          },
          202,
        );
      }
      if (url.pathname === RELAY_ENROLLMENT_FINALIZE_PATH) {
        finalizeCount += 1;
        if (finalizeCount === 1)
          return json({
            version: RELAY_ENROLLMENT_VERSION,
            state: 'pending',
            enrollmentId: challenge!.enrollmentId,
            expiresAt: challenge!.expiresAt,
          });
        const bundle: RelayEnrollmentContinuationBundle = {
          stationId,
          deviceId: '33333333-3333-4333-8333-333333333333',
          deviceCredential: opaque('D'),
          continuation: {
            version: APPLICATION_SESSION_VERSION,
            credential: opaque('C'),
            authorityKey: 'authority-key-1',
            stationId,
            deviceId: '33333333-3333-4333-8333-333333333333',
            principal: humanPrincipal('test-issuer', 'person-1', 'Zach'),
            requestOrigin: applicationOrigin,
            clientOrigin: window.location.origin,
            keyThumbprint: challenge!.keyThumbprint,
            nonce: opaque('Q'),
            expiresAt: challenge!.expiresAt,
          },
        };
        delivery = {
          version: RELAY_ENROLLMENT_VERSION,
          state: 'delivered',
          enrollmentId: challenge!.enrollmentId,
          activationNonce: opaque('A'),
          bundleDigest: await digestRelayEnrollmentBundle(bundle),
          bundle,
          expiresAt: challenge!.expiresAt,
        };
        return json(delivery);
      }
      if (url.pathname === RELAY_ENROLLMENT_ACTIVATE_PATH) {
        expect(body).toMatchObject({
          enrollmentId: challenge!.enrollmentId,
          deviceId: delivery!.bundle.deviceId,
          authorityKey: delivery!.bundle.continuation.authorityKey,
          bundleDigest: delivery!.bundleDigest,
        });
        expect(steps).toContain('provisional-installed');
        return json({
          version: RELAY_ENROLLMENT_VERSION,
          state: 'active',
          enrollmentId: challenge!.enrollmentId,
          deviceId: delivery!.bundle.deviceId,
          receiptDigest: await proofDigest(body.proof as string),
          receiptExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      return json({ error: { code: 'not_found' } }, 404);
    });
    const transport = requestTransport(handler);
    const credentials = { username: 'zach', password: 'secret' };
    const states: string[] = [];
    const controller = new BrowserRelayEnrollmentController({
      route: makeRoute(transport),
      pollIntervalMs: 250,
      wait: async (_milliseconds, signal) => signal.throwIfAborted(),
      stageApprovedBundle: async (stageId, bundle, key) => {
        expect(stageId).toBe(challenge!.enrollmentId);
        steps.push('provisional-installed');
        expect(bundle.deviceId).toBe('33333333-3333-4333-8333-333333333333');
        expect(key.privateKey.extractable).toBe(false);
        // The same JWK that was bound into the challenge is retained for
        // account continuation proof custody.
        expect(key.publicKey).toEqual(challenge!.publicKey);
        expect(states).not.toContain('enrolled');
      },
      publishAuthority: async (
        stageId,
        _bundle,
        _key,
        _receipt,
        isRouteCurrent,
      ) => {
        expect(stageId).toBe(challenge!.enrollmentId);
        expect(isRouteCurrent()).toBe(true);
        steps.push('authority-published');
      },
      removeProvisionalAuthority: async () => {
        steps.push('provisional-removed');
      },
      onState: (state) => states.push(state),
    });
    const activated = await controller.enroll(credentials);
    expect(activated.state).toBe('active');
    expect(controller.state).toBe('enrolled');
    expect(states.at(-1)).toBe('enrolled');
    expect(credentials).toEqual({ username: '', password: '' });
    expect(steps).toEqual([
      RELAY_ENROLLMENT_BEGIN_PATH,
      RELAY_ENROLLMENT_LOGIN_PATH,
      RELAY_ENROLLMENT_FINALIZE_PATH,
      RELAY_ENROLLMENT_FINALIZE_PATH,
      'provisional-installed',
      RELAY_ENROLLMENT_ACTIVATE_PATH,
      'authority-published',
    ]);
  });

  it('clears submitted credentials and refuses unsupported provider login without provisional authority', async () => {
    const handler = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === RELAY_ENROLLMENT_BEGIN_PATH) {
        const body = await request.json();
        const key = body.publicKey as {
          kty: 'EC';
          crv: 'P-256';
          x: string;
          y: string;
        };
        const fakeKey = { publicKey: key } as Awaited<
          ReturnType<typeof createRelayEnrollmentKey>
        >;
        return json(
          {
            version: RELAY_ENROLLMENT_VERSION,
            stationId,
            requestOrigin: applicationOrigin,
            clientOrigin: window.location.origin,
            enrollmentId: opaque('E'),
            publicKey: key,
            keyThumbprint: await thumbprint(fakeKey),
            nonce: opaque('N'),
            purpose: 'login',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          201,
        );
      }
      return json({ error: { code: 'relay_enrollment_unsupported' } }, 501);
    });
    const transport = requestTransport(handler);
    const stage = vi.fn(async () => {});
    const publish = vi.fn(async () => {});
    const cleanup = vi.fn();
    const credentials = { username: 'zach', password: 'secret' };
    const controller = new BrowserRelayEnrollmentController({
      route: makeRoute(transport),
      stageApprovedBundle: stage,
      publishAuthority: publish,
      removeProvisionalAuthority: async () => {
        cleanup();
      },
    });
    await expect(controller.enroll(credentials)).rejects.toThrow(/unsupported/);
    expect(credentials).toEqual({ username: '', password: '' });
    expect(stage).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(controller.state).toBe('failed');
  });

  it('cancels approval polling without staging or publishing authority', async () => {
    let challenge: RelayEnrollmentChallenge | undefined;
    const handler = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === RELAY_ENROLLMENT_BEGIN_PATH) {
        const body = await request.json();
        const publicKey =
          body.publicKey as RelayEnrollmentChallenge['publicKey'];
        challenge = {
          version: RELAY_ENROLLMENT_VERSION,
          stationId,
          requestOrigin: applicationOrigin,
          clientOrigin: window.location.origin,
          enrollmentId: opaque('E'),
          publicKey,
          keyThumbprint: await thumbprint({ publicKey } as Awaited<
            ReturnType<typeof createRelayEnrollmentKey>
          >),
          nonce: opaque('N'),
          purpose: 'login',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        return json(challenge, 201);
      }
      if (path === RELAY_ENROLLMENT_LOGIN_PATH)
        return json(
          {
            version: RELAY_ENROLLMENT_VERSION,
            state: 'pending',
            enrollmentId: challenge!.enrollmentId,
            requestId: 'request-1',
            expiresAt: challenge!.expiresAt,
          },
          202,
        );
      if (path === RELAY_ENROLLMENT_FINALIZE_PATH)
        return json({
          version: RELAY_ENROLLMENT_VERSION,
          state: 'pending',
          enrollmentId: challenge!.enrollmentId,
          expiresAt: challenge!.expiresAt,
        });
      throw new Error('Cancelled approval polling must not continue.');
    });
    const transport = requestTransport(handler);
    const staged = vi.fn();
    const published = vi.fn();
    const removed = vi.fn();
    let waitStarted!: () => void;
    const waiting = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const controller = new BrowserRelayEnrollmentController({
      route: makeRoute(transport),
      wait: async (_milliseconds, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
          waitStarted();
        });
      },
      stageApprovedBundle: async () => {
        staged();
      },
      publishAuthority: async () => {
        published();
      },
      removeProvisionalAuthority: async () => {
        removed();
      },
    });
    const cancellation = new AbortController();
    const enrollment = controller.enroll(
      { username: 'zach', password: 'secret' },
      cancellation.signal,
    );
    await waiting;
    cancellation.abort(new Error('User cancelled enrollment.'));
    await expect(enrollment).rejects.toBeTruthy();
    expect(handler).toHaveBeenCalledTimes(3);
    expect(staged).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(controller.state).toBe('cancelled');
  });

  it('aborts a stalled response body when the Station challenge expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'));
    let challenge: RelayEnrollmentChallenge | undefined;
    let finalizeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      finalizeStarted = resolve;
    });
    const handler = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === RELAY_ENROLLMENT_BEGIN_PATH) {
        const body = await request.json();
        const publicKey =
          body.publicKey as RelayEnrollmentChallenge['publicKey'];
        challenge = {
          version: RELAY_ENROLLMENT_VERSION,
          stationId,
          requestOrigin: applicationOrigin,
          clientOrigin: window.location.origin,
          enrollmentId: opaque('E'),
          publicKey,
          keyThumbprint: await thumbprint({ publicKey } as Awaited<
            ReturnType<typeof createRelayEnrollmentKey>
          >),
          nonce: opaque('N'),
          purpose: 'login',
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
        };
        return json(challenge, 201);
      }
      if (path === RELAY_ENROLLMENT_LOGIN_PATH)
        return json(
          {
            version: RELAY_ENROLLMENT_VERSION,
            state: 'pending',
            enrollmentId: challenge!.enrollmentId,
            requestId: 'request-1',
            expiresAt: challenge!.expiresAt,
          },
          202,
        );
      if (path === RELAY_ENROLLMENT_FINALIZE_PATH) {
        finalizeStarted();
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => {}),
          }),
          { status: 200 },
        );
      }
      throw new Error('Expired enrollment must not continue.');
    });
    const staged = vi.fn();
    const controller = new BrowserRelayEnrollmentController({
      route: makeRoute(requestTransport(handler)),
      stageApprovedBundle: async () => {
        staged();
      },
      publishAuthority: async () => {},
      removeProvisionalAuthority: async () => {},
    });
    const enrollment = controller.enroll({
      username: 'zach',
      password: 'secret',
    });
    const rejection = expect(enrollment).rejects.toBeTruthy();
    await started;
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(handler).toHaveBeenCalledTimes(3);
    expect(staged).not.toHaveBeenCalled();
    expect(controller.state).toBe('failed');
  });

  it('rejects oversized JSON before parsing or sending login credentials', async () => {
    const handler = vi.fn(
      async () =>
        new Response('x'.repeat(16 * 1024 + 1), {
          status: 201,
          headers: { 'Content-Length': String(16 * 1024 + 1) },
        }),
    );
    const staged = vi.fn();
    const controller = new BrowserRelayEnrollmentController({
      route: makeRoute(requestTransport(handler)),
      stageApprovedBundle: async () => {
        staged();
      },
      publishAuthority: async () => {},
      removeProvisionalAuthority: async () => {},
    });
    await expect(
      controller.enroll({ username: 'zach', password: 'secret' }),
    ).rejects.toThrow(/response is too large/);
    expect(handler).toHaveBeenCalledOnce();
    expect(staged).not.toHaveBeenCalled();
    expect(controller.state).toBe('failed');
  });

  it('removes staged custody when Station returns the wrong activation receipt digest', async () => {
    let challenge: RelayEnrollmentChallenge | undefined;
    let delivery: RelayEnrollmentDeliveredResponse | undefined;
    let finalizeCount = 0;
    const staged = vi.fn();
    const published = vi.fn();
    const removed = vi.fn();
    const handler = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const body = await request.json();
      if (url.pathname === RELAY_ENROLLMENT_BEGIN_PATH) {
        const publicKey = body.publicKey;
        challenge = {
          version: RELAY_ENROLLMENT_VERSION,
          stationId,
          requestOrigin: applicationOrigin,
          clientOrigin: window.location.origin,
          enrollmentId: opaque('E'),
          publicKey,
          keyThumbprint: await thumbprint({ publicKey } as Awaited<
            ReturnType<typeof createRelayEnrollmentKey>
          >),
          nonce: opaque('N'),
          purpose: 'login',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        return json(challenge, 201);
      }
      if (url.pathname === RELAY_ENROLLMENT_LOGIN_PATH)
        return json(
          {
            version: RELAY_ENROLLMENT_VERSION,
            state: 'pending',
            enrollmentId: challenge!.enrollmentId,
            requestId: 'request-1',
            expiresAt: challenge!.expiresAt,
          },
          202,
        );
      if (url.pathname === RELAY_ENROLLMENT_FINALIZE_PATH) {
        finalizeCount += 1;
        if (finalizeCount === 1)
          return json({
            version: RELAY_ENROLLMENT_VERSION,
            state: 'pending',
            enrollmentId: challenge!.enrollmentId,
            expiresAt: challenge!.expiresAt,
          });
        const bundle: RelayEnrollmentContinuationBundle = {
          stationId,
          deviceId: '33333333-3333-4333-8333-333333333333',
          deviceCredential: opaque('D'),
          continuation: {
            version: APPLICATION_SESSION_VERSION,
            credential: opaque('C'),
            authorityKey: 'authority-key-1',
            stationId,
            deviceId: '33333333-3333-4333-8333-333333333333',
            principal: humanPrincipal('test-issuer', 'person-1', 'Zach'),
            requestOrigin: applicationOrigin,
            clientOrigin: window.location.origin,
            keyThumbprint: challenge!.keyThumbprint,
            nonce: opaque('Q'),
            expiresAt: challenge!.expiresAt,
          },
        };
        delivery = {
          version: RELAY_ENROLLMENT_VERSION,
          state: 'delivered',
          enrollmentId: challenge!.enrollmentId,
          activationNonce: opaque('A'),
          bundleDigest: await digestRelayEnrollmentBundle(bundle),
          bundle,
          expiresAt: challenge!.expiresAt,
        };
        return json(delivery);
      }
      if (url.pathname === RELAY_ENROLLMENT_ACTIVATE_PATH)
        return json({
          version: RELAY_ENROLLMENT_VERSION,
          state: 'active',
          enrollmentId: challenge!.enrollmentId,
          deviceId: delivery!.bundle.deviceId,
          receiptDigest: opaque('R'),
          receiptExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      return json({ error: { code: 'not_found' } }, 404);
    });
    const transport = requestTransport(handler);
    const states: string[] = [];
    const controller = new BrowserRelayEnrollmentController({
      route: makeRoute(transport),
      wait: async (_milliseconds, signal) => signal.throwIfAborted(),
      stageApprovedBundle: async (stageId) => {
        expect(stageId).toBe(challenge!.enrollmentId);
        staged();
      },
      publishAuthority: async () => {
        published();
      },
      removeProvisionalAuthority: async (stageId) => {
        expect(stageId).toBe(challenge!.enrollmentId);
        removed();
      },
      onState: (state) => states.push(state),
    });
    await expect(
      controller.enroll({ username: 'zach', password: 'secret' }),
    ).rejects.toThrow(/did not confirm Device activation/);
    expect(staged).toHaveBeenCalledOnce();
    expect(published).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledOnce();
    expect(controller.state).toBe('failed');
    expect(states).not.toContain('enrolled');
  });

  it('rolls back the exact stage if the selected route changes during publication', async () => {
    let current = true;
    let authorityLive = false;
    let challenge: RelayEnrollmentChallenge | undefined;
    let delivery: RelayEnrollmentDeliveredResponse | undefined;
    let finalizeCount = 0;
    const removed = vi.fn();
    const handler = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      if (path === RELAY_ENROLLMENT_BEGIN_PATH) {
        const publicKey = body.publicKey;
        challenge = {
          version: RELAY_ENROLLMENT_VERSION,
          stationId,
          requestOrigin: applicationOrigin,
          clientOrigin: window.location.origin,
          enrollmentId: opaque('E'),
          publicKey,
          keyThumbprint: await thumbprint({ publicKey } as Awaited<
            ReturnType<typeof createRelayEnrollmentKey>
          >),
          nonce: opaque('N'),
          purpose: 'login',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        return json(challenge, 201);
      }
      if (path === RELAY_ENROLLMENT_LOGIN_PATH)
        return json(
          {
            version: RELAY_ENROLLMENT_VERSION,
            state: 'pending',
            enrollmentId: challenge!.enrollmentId,
            requestId: 'request-1',
            expiresAt: challenge!.expiresAt,
          },
          202,
        );
      if (path === RELAY_ENROLLMENT_FINALIZE_PATH) {
        finalizeCount += 1;
        if (finalizeCount === 1)
          return json({
            version: RELAY_ENROLLMENT_VERSION,
            state: 'pending',
            enrollmentId: challenge!.enrollmentId,
            expiresAt: challenge!.expiresAt,
          });
        const bundle: RelayEnrollmentContinuationBundle = {
          stationId,
          deviceId: '33333333-3333-4333-8333-333333333333',
          deviceCredential: opaque('D'),
          continuation: {
            version: APPLICATION_SESSION_VERSION,
            credential: opaque('C'),
            authorityKey: 'authority-key-1',
            stationId,
            deviceId: '33333333-3333-4333-8333-333333333333',
            principal: humanPrincipal('test-issuer', 'person-1', 'Zach'),
            requestOrigin: applicationOrigin,
            clientOrigin: window.location.origin,
            keyThumbprint: challenge!.keyThumbprint,
            nonce: opaque('Q'),
            expiresAt: challenge!.expiresAt,
          },
        };
        delivery = {
          version: RELAY_ENROLLMENT_VERSION,
          state: 'delivered',
          enrollmentId: challenge!.enrollmentId,
          activationNonce: opaque('A'),
          bundleDigest: await digestRelayEnrollmentBundle(bundle),
          bundle,
          expiresAt: challenge!.expiresAt,
        };
        return json(delivery);
      }
      if (path === RELAY_ENROLLMENT_ACTIVATE_PATH)
        return json({
          version: RELAY_ENROLLMENT_VERSION,
          state: 'active',
          enrollmentId: challenge!.enrollmentId,
          deviceId: delivery!.bundle.deviceId,
          receiptDigest: await proofDigest(body.proof as string),
          receiptExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      throw new Error('Unexpected enrollment endpoint.');
    });
    const transport = requestTransport(handler);
    const publish = vi.fn();
    const controller = new BrowserRelayEnrollmentController({
      route: makeRoute(transport, () => current),
      wait: async (_milliseconds, signal) => signal.throwIfAborted(),
      stageApprovedBundle: async () => {
        authorityLive = false;
      },
      publishAuthority: async (
        stageId,
        _bundle,
        _key,
        _receipt,
        isRouteCurrent,
      ) => {
        expect(stageId).toBe(challenge!.enrollmentId);
        expect(isRouteCurrent()).toBe(true);
        publish();
        authorityLive = true;
        // Simulate a route retirement after the adapter's publication starts.
        current = false;
      },
      removeProvisionalAuthority: async (stageId) => {
        expect(stageId).toBe(challenge!.enrollmentId);
        authorityLive = false;
        removed();
      },
    });
    await expect(
      controller.enroll({ username: 'zach', password: 'secret' }),
    ).rejects.toThrow(/route changed/);
    expect(handler).toHaveBeenCalledTimes(5);
    expect(publish).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledOnce();
    expect(authorityLive).toBe(false);
    expect(controller.state).toBe('failed');
  });
});
