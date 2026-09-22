import type { HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import {
  LIVE_SURFACE_FRAMES_CONTENT_TYPE,
  LIVE_SURFACE_INPUT_MAX_BODY_BYTES,
  LIVE_SURFACE_INPUT_MAX_EVENTS,
  type LiveSurfaceRecord,
  LiveSurfaceRecordDecoder,
} from '@kontourai/station-contracts/live-surface';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  SyntheticLiveSurfaceProducer,
  syntheticFrameCounter,
} from '../../__test-utils__/synthetic-live-surface-producer.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import { isRuntimeRequestPrincipalCurrent } from '../../security/runtime-request-security.js';
import {
  claimAgentControl,
  type LiveSurfaceAuthorizer,
  LiveSurfaceRegistry,
} from '../../services/live-surface/registry.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { createLiveSurfaceRoutes } from '../live-surface.js';

const SURFACE = 'browser:session-1';
const base = `/api/live-surfaces/${encodeURIComponent(SURFACE)}`;

function harness(
  options: { register?: boolean; authorize?: LiveSurfaceAuthorizer } = {},
) {
  const credentials = new Map([
    ['operator', DEFAULT_GRANT_PAIRING_SCOPE],
    ['viewer', pairingScopePresetString('read-only')],
  ]);
  const principals = new Map([
    ['operator', 'human:local:operator'],
    ['viewer', 'human:local:viewer'],
  ]);
  const security = {
    verifyCredential: (value: string) => credentials.has(value),
    authorizeCredential: (value: string) => credentials.has(value),
    resolveGrantedScope: (value: string) => credentials.get(value),
    allowedOrigins: [],
  };
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return this;
    },
    setLevel() {},
    getLevel() {
      return 'info' as const;
    },
  };
  const app = new Hono<{ Bindings: HttpBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: new EventBus(),
    security,
  } as Parameters<typeof configureRuntimeHttp>[0]);
  const registry = new LiveSurfaceRegistry({ hub: { heartbeatMs: 60_000 } });
  const producer = new SyntheticLiveSurfaceProducer(SURFACE);
  const authorizeCalls: [string, string, string][] = [];
  const authorize: LiveSurfaceAuthorizer =
    options.authorize ??
    ((principal, surfaceId, action) => {
      authorizeCalls.push([principal, surfaceId, action]);
      return principal === 'human:local:operator';
    });
  if (options.register !== false) registry.register(producer, { authorize });
  app.route(
    '/api/live-surfaces',
    createLiveSurfaceRoutes(registry, {
      isRequestPrincipalCurrent: (request) =>
        isRuntimeRequestPrincipalCurrent(request, security),
      // The runtime composition's resolver is exercised separately, through
      // the real credential pipeline (runtime-routes-live-surface.test.ts).
      resolveHumanCaller: (c) => {
        const credential = c.req
          .header('Authorization')
          ?.replace(/^Bearer /, '');
        const principal = credential && principals.get(credential);
        return principal
          ? { principal, device: `credential:${credential}` }
          : null;
      },
      principalRecheckMs: 0,
    }),
  );
  const request = (
    path: string,
    credential?: string,
    body?: string,
    init: { signal?: AbortSignal } = {},
  ) =>
    app.request(
      path,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body }),
        ...init,
      },
      {
        incoming: { socket: { remoteAddress: '100.96.12.7' } },
      } as HttpBindings,
    );
  return { app, credentials, registry, producer, request, authorizeCalls };
}

/** Read records off a frames response as a real client would. */
function recordReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new LiveSurfaceRecordDecoder();
  const ready: LiveSurfaceRecord[] = [];
  return {
    async next(): Promise<LiveSurfaceRecord | null> {
      while (ready.length === 0) {
        const chunk = await reader.read();
        if (chunk.done) return null;
        ready.push(...decoder.push(chunk.value));
      }
      return ready.shift()!;
    },
    cancel: () => reader.cancel(),
  };
}

const click = (x: number, y: number) => [
  { kind: 'pointer', type: 'down', x, y, button: 'left', clickCount: 1 },
  { kind: 'pointer', type: 'up', x, y, button: 'left', clickCount: 1 },
];

describe('live surface routes through runtime authentication', () => {
  test('with no producer registered every route is an inert typed 404', async () => {
    const h = harness({ register: false });
    for (const [path, body] of [
      [`${base}/frames`, undefined],
      [`${base}/lease`, undefined],
      [`${base}/input`, JSON.stringify({ epoch: 0, events: click(1, 1) })],
      [`${base}/lease`, JSON.stringify({ action: 'claim' })],
    ] as const) {
      const response = await h.request(path, 'operator', body);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        code: 'unknown-surface',
      });
    }
  });

  test('unauthenticated and read-only callers cannot watch or drive a surface', async () => {
    const h = harness();
    expect((await h.request(`${base}/frames`)).status).toBe(401);
    expect((await h.request(`${base}/frames`, 'viewer')).status).toBe(403);
    expect((await h.request(`${base}/lease`, 'viewer')).status).toBe(403);
    expect(
      (
        await h.request(
          `${base}/input`,
          'viewer',
          JSON.stringify({ epoch: 0, events: click(1, 1) }),
        )
      ).status,
    ).toBe(403);
    expect(h.producer.starts).toEqual([]);
    expect(h.producer.dispatched).toEqual([]);
  });

  test('frames decode round trip: state first, then the synthetic frame; cancel stops the producer', async () => {
    const h = harness();
    const response = await h.request(
      `${base}/frames?maxFps=5&maxWidth=640`,
      'operator',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      LIVE_SURFACE_FRAMES_CONTENT_TYPE,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    const records = recordReader(response);
    expect(await records.next()).toEqual({
      kind: 'state',
      state: {
        surfaceId: SURFACE,
        lease: { surfaceId: SURFACE, epoch: 0, holder: null, expiresAt: null },
        effectiveParams: {
          maxFps: 5,
          quality: 70,
          maxWidth: 640,
          maxHeight: 1280,
        },
        // Each viewer is told who IT is (S9), so the UI never guesses.
        viewer: {
          principal: 'human:local:operator',
          device: 'credential:operator',
        },
      },
    });
    const entry = h.registry.get(SURFACE)!;
    await entry.hub.settled();
    expect(h.producer.starts).toEqual([
      { maxFps: 5, quality: 70, maxWidth: 640, maxHeight: 1280 },
    ]);
    expect(h.producer.emit()).toBe(true);
    const frame = await records.next();
    expect(frame?.kind).toBe('frame');
    if (frame?.kind !== 'frame') return;
    expect(frame.header).toMatchObject({
      surfaceId: SURFACE,
      seq: 1,
      epoch: 0,
      codec: 'png',
      width: 320,
      height: 200,
    });
    expect(syntheticFrameCounter(frame.body)).toBe(1);
    // Reading the frame acked it to the producer.
    expect(h.producer.acks).toEqual([1]);

    await records.cancel();
    await entry.hub.settled();
    expect(entry.hub.viewerCount).toBe(0);
    expect(h.producer.stops).toBe(1);
  });

  test('stream params outside their bounds or unknown query keys are refused', async () => {
    const h = harness();
    for (const query of [
      'maxFps=0',
      'maxFps=31',
      'quality=abc',
      'maxWidth=99999',
      'fps=10',
      'maxFps=5&maxFps=6',
    ]) {
      const response = await h.request(`${base}/frames?${query}`, 'operator');
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        code: 'invalid-request',
      });
    }
    expect(h.registry.get(SURFACE)!.hub.viewerCount).toBe(0);
  });

  test('narrowing the credential scope ends a running frames stream', async () => {
    const h = harness();
    const records = recordReader(await h.request(`${base}/frames`, 'operator'));
    expect((await records.next())?.kind).toBe('state');
    await h.registry.get(SURFACE)!.hub.settled();
    h.credentials.set('operator', pairingScopePresetString('read-only'));
    h.producer.emit();
    expect(await records.next()).toBeNull();
  });

  test('human input auto-claims the lease and reaches the producer in order', async () => {
    const h = harness();
    const events = [...click(10, 20), { kind: 'text', text: 'héllo' }];
    const response = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: 0, events }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        ok: true,
        accepted: 3,
        lease: {
          surfaceId: SURFACE,
          epoch: 1,
          holder: {
            kind: 'human',
            principal: 'human:local:operator',
            device: 'credential:operator',
          },
          expiresAt: expect.any(Number),
        },
      },
    });
    expect(h.producer.dispatched).toEqual(events);
  });

  test('human input fences an agent, and a stale epoch is rejected', async () => {
    const h = harness();
    const entry = h.registry.get(SURFACE)!;
    const { lease } = entry;
    const agent = {
      kind: 'agent' as const,
      principal: 'agent:builtin:coder',
      sessionId: 'session-a',
    };
    const agentEpoch = (
      await claimAgentControl(entry, agent, 'human:local:operator')
    ).lease.epoch;

    // A viewer that has not yet seen the agent's claim acts on epoch 0.
    const stale = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: 0, events: click(1, 1) }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      success: false,
      data: {
        ok: false,
        code: 'stale-epoch',
        accepted: 0,
        lease: { epoch: 1 },
      },
    });
    expect(h.producer.dispatched).toEqual([]);
    expect(lease.isCurrent(agentEpoch, agent).ok).toBe(true);

    // With the current epoch, the human takes over and the agent is fenced.
    const takeover = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: agentEpoch, events: click(1, 1) }),
    );
    expect(takeover.status).toBe(200);
    expect(lease.isCurrent(agentEpoch, agent)).toMatchObject({
      ok: false,
      code: 'stale-epoch',
    });
  });

  test('oversized, over-long and malformed input batches are rejected before dispatch', async () => {
    const h = harness();
    const oversized = JSON.stringify({
      epoch: 0,
      events: [
        { kind: 'text', text: 'x'.repeat(LIVE_SURFACE_INPUT_MAX_BODY_BYTES) },
      ],
    });
    const tooLarge = await h.request(`${base}/input`, 'operator', oversized);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({
      success: false,
      code: 'request-too-large',
    });

    const tooMany = JSON.stringify({
      epoch: 0,
      events: Array.from({ length: LIVE_SURFACE_INPUT_MAX_EVENTS + 1 }, () => ({
        kind: 'pointer',
        type: 'move',
        x: 1,
        y: 1,
      })),
    });
    expect(tooMany.length).toBeLessThan(LIVE_SURFACE_INPUT_MAX_BODY_BYTES);
    for (const body of [
      tooMany,
      'not json',
      JSON.stringify({ epoch: 0, events: [] }),
      JSON.stringify({ epoch: -1, events: click(1, 1) }),
      JSON.stringify({ epoch: 0, events: click(1, 1), extra: true }),
      JSON.stringify({
        epoch: 0,
        events: [{ kind: 'pointer', type: 'down', x: Number.NaN, y: 1 }],
      }),
      JSON.stringify({
        epoch: 0,
        events: [{ kind: 'script', source: 'alert(1)' }],
      }),
    ]) {
      const response = await h.request(`${base}/input`, 'operator', body);
      expect(response.status, body.slice(0, 60)).toBe(400);
    }
    expect(h.producer.dispatched).toEqual([]);
    expect(h.registry.get(SURFACE)!.lease.snapshot().epoch).toBe(0);
  });

  test('an input kind the producer does not accept is refused as a whole batch', async () => {
    const h = harness({ register: false });
    const producer = new SyntheticLiveSurfaceProducer(SURFACE, {
      input: ['pointer'],
    });
    h.registry.register(producer, { authorize: () => true });
    const response = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({
        epoch: 0,
        events: [...click(1, 1), { kind: 'text', text: 'a' }],
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      data: { ok: false, code: 'unsupported-input', accepted: 0 },
    });
    expect(producer.dispatched).toEqual([]);
  });

  test('lease read, human claim and release', async () => {
    const h = harness();
    const read = await h.request(`${base}/lease`, 'operator');
    expect(await read.json()).toEqual({
      success: true,
      data: { surfaceId: SURFACE, epoch: 0, holder: null, expiresAt: null },
    });
    const claim = await h.request(
      `${base}/lease`,
      'operator',
      JSON.stringify({ action: 'claim' }),
    );
    expect(await claim.json()).toMatchObject({
      success: true,
      data: { ok: true, lease: { epoch: 1, holder: { kind: 'human' } } },
    });
    const staleRelease = await h.request(
      `${base}/lease`,
      'operator',
      JSON.stringify({ action: 'release', epoch: 0 }),
    );
    expect(staleRelease.status).toBe(409);
    const release = await h.request(
      `${base}/lease`,
      'operator',
      JSON.stringify({ action: 'release', epoch: 1 }),
    );
    expect(await release.json()).toMatchObject({
      success: true,
      data: { ok: true, lease: { epoch: 1, holder: null } },
    });
    // An agent cannot be named in a lease request body.
    const agentClaim = await h.request(
      `${base}/lease`,
      'operator',
      JSON.stringify({ action: 'claim', kind: 'agent', sessionId: 's' }),
    );
    expect(agentClaim.status).toBe(400);
  });

  test('an invalid surface id is refused distinctly from an unknown one', async () => {
    const h = harness();
    const response = await h.request(
      '/api/live-surfaces/%20bad%20id/lease',
      'operator',
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      code: 'invalid-surface-id',
    });
  });
  test('a surface registered without an authorizer denies everyone (fail closed)', async () => {
    const h = harness({ register: false });
    const producer = new SyntheticLiveSurfaceProducer(SURFACE);
    h.registry.register(producer);
    for (const [path, body] of [
      [`${base}/frames`, undefined],
      [`${base}/lease`, undefined],
      [`${base}/input`, JSON.stringify({ epoch: 0, events: click(1, 1) })],
      [`${base}/lease`, JSON.stringify({ action: 'claim' })],
    ] as const) {
      const response = await h.request(path, 'operator', body);
      expect(response.status, path).toBe(403);
      expect(await response.json()).toEqual({
        success: false,
        code: 'access-denied',
      });
    }
    expect(producer.starts).toEqual([]);
    expect(producer.dispatched).toEqual([]);
    expect(h.registry.get(SURFACE)!.lease.snapshot().epoch).toBe(0);
  });

  test('a principal granted view but not input can watch and cannot drive', async () => {
    const h = harness({
      authorize: (principal, _surface, action) =>
        principal === 'human:local:operator' && action === 'view',
    });
    const records = recordReader(await h.request(`${base}/frames`, 'operator'));
    expect((await records.next())?.kind).toBe('state');
    expect((await h.request(`${base}/lease`, 'operator')).status).toBe(200);
    const input = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: 0, events: click(1, 1) }),
    );
    expect(input.status).toBe(403);
    const claim = await h.request(
      `${base}/lease`,
      'operator',
      JSON.stringify({ action: 'claim' }),
    );
    expect(claim.status).toBe(403);
    expect(h.producer.dispatched).toEqual([]);
    expect(h.registry.get(SURFACE)!.lease.snapshot().epoch).toBe(0);
    await records.cancel();
  });

  test('the authorizer is asked for the resolved human principal and the exact action', async () => {
    const h = harness();
    await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: 0, events: click(1, 1) }),
    );
    expect(h.authorizeCalls).toEqual([
      ['human:local:operator', SURFACE, 'input'],
      ['human:local:operator', SURFACE, 'control'],
    ]);
  });

  test('withdrawing the view grant ends a running frames stream', async () => {
    let allowed = true;
    const h = harness({ authorize: () => allowed });
    const records = recordReader(await h.request(`${base}/frames`, 'operator'));
    expect((await records.next())?.kind).toBe('state');
    await h.registry.get(SURFACE)!.hub.settled();
    allowed = false;
    h.producer.emit();
    expect(await records.next()).toBeNull();
  });
  test('input needs control as well as input: an input-only grant is refused (behavioural)', async () => {
    const h = harness({
      authorize: (_principal, _surface, action) => action !== 'control',
    });
    const response = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: 0, events: click(1, 1) }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      code: 'access-denied',
    });
    expect(h.producer.dispatched).toEqual([]);
    expect(h.registry.get(SURFACE)!.lease.snapshot()).toMatchObject({
      epoch: 0,
      holder: null,
    });
  });
});
