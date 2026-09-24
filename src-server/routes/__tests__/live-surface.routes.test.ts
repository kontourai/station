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
  authorizeDeviceSurfaceAction,
  type DeviceAccess,
  deviceAccessFromShares,
  failClosedDeviceAccess,
} from '../../services/devices/device-access.js';
import { DeviceHostBusyError } from '../../services/devices/device-shares.js';
import {
  claimAgentControl,
  type LiveSurfaceAuthorizer,
  LiveSurfaceRegistry,
  releaseAgentControl,
} from '../../services/live-surface/registry.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import {
  createLiveSurfaceRoutes,
  type LiveSurfaceRouteOptions,
} from '../live-surface.js';

const SURFACE = 'browser:session-1';
const base = `/api/live-surfaces/${encodeURIComponent(SURFACE)}`;

function harness(
  options: {
    register?: boolean;
    authorize?: LiveSurfaceAuthorizer;
    dispatchTimeoutMs?: number;
    routes?: Pick<
      LiveSurfaceRouteOptions,
      'now' | 'viewRecheckWaitMs' | 'viewBusyGraceMs'
    >;
  } = {},
) {
  const credentials = new Map([
    ['operator', DEFAULT_GRANT_PAIRING_SCOPE],
    ['viewer', pairingScopePresetString('read-only')],
    ['viewer2', DEFAULT_GRANT_PAIRING_SCOPE],
  ]);
  const principals = new Map([
    ['operator', 'human:local:operator'],
    ['viewer', 'human:local:viewer'],
    ['viewer2', 'human:local:second'],
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
  const registry = new LiveSurfaceRegistry({
    hub: { heartbeatMs: 60_000 },
    ...(options.dispatchTimeoutMs
      ? { dispatchTimeoutMs: options.dispatchTimeoutMs }
      : {}),
  });
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
      ...options.routes,
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
        lease: {
          surfaceId: SURFACE,
          epoch: 0,
          holder: null,
          expiresAt: null,
          fence: 0,
        },
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
        wedged: false,
        wedgedSince: null,
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
          fence: 1,
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
    // A lapsed first claim makes the fence and the viewer epoch diverge, so
    // the test cannot pass by confusing the two.
    const first = (
      await claimAgentControl(entry, agent, 'human:local:operator')
    ).lease;
    releaseAgentControl(entry, agent, first.fence!);
    const claim = (
      await claimAgentControl(entry, agent, 'human:local:operator')
    ).lease;
    const agentEpoch = claim.epoch;
    const agentFence = claim.fence!;
    expect(agentFence).not.toBe(agentEpoch);

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
    expect(lease.isCurrent(agentFence, agent).ok).toBe(true);

    // With the current epoch, the human takes over and the agent is fenced.
    const takeover = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: agentEpoch, events: click(1, 1) }),
    );
    expect(takeover.status).toBe(200);
    expect(lease.isCurrent(agentFence, agent)).toMatchObject({
      ok: false,
      code: 'stale-fence',
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
      data: {
        surfaceId: SURFACE,
        epoch: 0,
        holder: null,
        expiresAt: null,
        fence: 0,
      },
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
  test('a human can take control over HTTP while the surface is wedged; input stays refused (W1c)', async () => {
    const h = harness({ dispatchTimeoutMs: 20, authorize: () => true });
    // The page's click handler opened a dialog: the dispatch never returns.
    h.producer.dispatchImpl = () => new Promise(() => {});
    const first = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: 0, events: click(1, 1) }),
    );
    expect(first.status).toBe(502);
    expect(h.registry.get(SURFACE)!.hub.state()).toMatchObject({
      wedged: true,
      wedgedSince: expect.any(Number),
    });
    const input = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: 1, events: click(2, 2) }),
    );
    expect(input.status).toBe(409);
    expect(await input.json()).toMatchObject({
      data: { ok: false, code: 'surface-wedged' },
    });
    // The takeover itself does not wait behind the wedge.
    const claim = await Promise.race([
      h.request(
        `${base}/lease`,
        'viewer2',
        JSON.stringify({ action: 'claim' }),
      ),
      new Promise<'timed-out'>((resolve) =>
        setTimeout(() => resolve('timed-out'), 2_000),
      ),
    ]);
    expect(claim).not.toBe('timed-out');
    const response = claim as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        ok: true,
        lease: { holder: { principal: 'human:local:second' } },
      },
    });
  });
});

/**
 * #2433 through the real device authorizer: `failClosedDeviceAccess` over
 * an access whose share lookup is refused by a saturated SSH device host
 * (`DeviceHostBusyError`), adapted by `authorizeDeviceSurfaceAction` and
 * registered as the surface's authorizer. Busy is a retryable 503, never an
 * "access denied"; a running stream keeps its last allow for a bounded
 * while; every other failure still fails closed; busy grants nothing.
 */
describe('a busy device host is not an access refusal (#2433)', () => {
  type Answer = 'allow' | 'deny' | 'busy' | 'throw';

  function deviceAuthorizer(answer: () => Answer): LiveSurfaceAuthorizer {
    const access: DeviceAccess = failClosedDeviceAccess({
      isOperator: async () => false,
      hasStanding: async () => true,
      mayAccessDevice: async () => {
        const next = answer();
        if (next === 'busy') throw new DeviceHostBusyError();
        if (next === 'throw') throw new Error('share store unreadable');
        return next === 'allow';
      },
    });
    const session = {
      hostId: 'ssh-host-1',
      platform: 'android' as const,
      deviceId: 'emulator-5554',
      isOpen: () => true,
    };
    return (principal, _surfaceId, action, context) =>
      principal === 'human:local:operator' &&
      authorizeDeviceSurfaceAction(access, session, action, context?.request);
  }

  test('input, lease claim and a new frames stream answer 503 surface-busy, and busy dispatches nothing', async () => {
    const h = harness({ authorize: deviceAuthorizer(() => 'busy') });
    const input = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: 0, events: click(1, 1) }),
    );
    expect(input.status).toBe(503);
    expect(input.headers.get('Retry-After')).toBe('1');
    expect(await input.json()).toEqual({
      success: false,
      code: 'surface-busy',
    });
    expect(h.producer.dispatched).toEqual([]);
    const claim = await h.request(
      `${base}/lease`,
      'operator',
      JSON.stringify({ action: 'claim' }),
    );
    expect(claim.status).toBe(503);
    expect(await claim.json()).toEqual({
      success: false,
      code: 'surface-busy',
    });
    expect(h.registry.get(SURFACE)!.lease.snapshot().holder).toBeNull();
    const frames = await h.request(`${base}/frames`, 'operator');
    expect(frames.status).toBe(503);
    expect(await frames.json()).toEqual({
      success: false,
      code: 'surface-busy',
    });
    expect(h.registry.get(SURFACE)!.hub.viewerCount).toBe(0);
  });

  test('any other authorizer failure still fails closed as access-denied', async () => {
    const h = harness({ authorize: deviceAuthorizer(() => 'throw') });
    const input = await h.request(
      `${base}/input`,
      'operator',
      JSON.stringify({ epoch: 0, events: click(1, 1) }),
    );
    expect(input.status).toBe(403);
    expect(await input.json()).toEqual({
      success: false,
      code: 'access-denied',
    });
    expect(h.producer.dispatched).toEqual([]);
  });

  test('a busy re-check keeps a running stream on its last allow; a deny still ends it', async () => {
    let answer: Answer = 'allow';
    const h = harness({ authorize: deviceAuthorizer(() => answer) });
    const records = recordReader(await h.request(`${base}/frames`, 'operator'));
    expect((await records.next())?.kind).toBe('state');
    await h.registry.get(SURFACE)!.hub.settled();
    answer = 'busy';
    h.producer.emit();
    expect((await records.next())?.kind).toBe('frame');
    await h.registry.get(SURFACE)!.hub.settled();
    answer = 'deny';
    h.producer.emit();
    expect(await records.next()).toBeNull();
  });

  test('busy keeps an allow only for the grace window, then the stream ends', async () => {
    let answer: Answer = 'allow';
    let clock = 1_000;
    const h = harness({
      authorize: deviceAuthorizer(() => answer),
      routes: { now: () => clock, viewBusyGraceMs: 30_000 },
    });
    const records = recordReader(await h.request(`${base}/frames`, 'operator'));
    expect((await records.next())?.kind).toBe('state');
    await h.registry.get(SURFACE)!.hub.settled();
    answer = 'busy';
    clock += 29_000;
    h.producer.emit();
    expect((await records.next())?.kind).toBe('frame');
    await h.registry.get(SURFACE)!.hub.settled();
    clock += 2_000;
    h.producer.emit();
    expect(await records.next()).toBeNull();
  });

  test('a re-check stuck in the host queue does not stall the stream, and its deny still lands', async () => {
    let release!: (value: boolean) => void;
    let calls = 0;
    const h = harness({
      authorize: (principal) => {
        calls += 1;
        if (calls === 1) return principal === 'human:local:operator';
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
      routes: { viewRecheckWaitMs: 20 },
    });
    const records = recordReader(await h.request(`${base}/frames`, 'operator'));
    expect((await records.next())?.kind).toBe('state');
    await h.registry.get(SURFACE)!.hub.settled();
    h.producer.emit();
    const started = Date.now();
    expect((await records.next())?.kind).toBe('frame');
    expect(Date.now() - started).toBeLessThan(2_000);
    // The pending re-check answers deny: the stream ends without another frame.
    const ended = records.next();
    release(false);
    expect(await ended).toBeNull();
  });
});

/**
 * #2433 review HIGH: the grace budget binds a re-check that has NOT answered
 * too. Before, the cap ran only when a re-check settled, so a hung or slow
 * authorizer let every pull deliver indefinitely (the reviewer's probe P1:
 * five frames across fifty minutes with a 30 s grace). Applies to every
 * registrant, the Browser pane's included.
 */
describe('a pending view re-check spends the same grace budget (#2433)', () => {
  test('a re-check that never answers ends the stream once the last allow is older than the grace', async () => {
    let calls = 0;
    let clock = 1_000;
    const h = harness({
      authorize: (principal) => {
        calls += 1;
        if (calls === 1) return principal === 'human:local:operator';
        return new Promise<boolean>(() => {});
      },
      routes: {
        now: () => clock,
        viewRecheckWaitMs: 20,
        viewBusyGraceMs: 30_000,
      },
    });
    const records = recordReader(await h.request(`${base}/frames`, 'operator'));
    expect((await records.next())?.kind).toBe('state');
    await h.registry.get(SURFACE)!.hub.settled();
    clock += 10_000;
    h.producer.emit();
    expect((await records.next())?.kind).toBe('frame');
    await h.registry.get(SURFACE)!.hub.settled();
    clock += 21_000;
    h.producer.emit();
    expect(await records.next()).toBeNull();
  });

  test('a slow (over 1 s) Browser-style authorizer delivers nothing past the grace while it is pending', async () => {
    let calls = 0;
    let clock = 1_000;
    const h = harness({
      authorize: async (principal) => {
        calls += 1;
        if (calls > 1)
          await new Promise((resolve) => setTimeout(resolve, 1_200));
        return principal === 'human:local:operator';
      },
      routes: { now: () => clock, viewBusyGraceMs: 30_000 },
    });
    const records = recordReader(await h.request(`${base}/frames`, 'operator'));
    expect((await records.next())?.kind).toBe('state');
    await h.registry.get(SURFACE)!.hub.settled();
    clock += 31_000;
    h.producer.emit();
    // The pull waits its 1 s for the re-check, which is still pending: past
    // the grace, the frame is not delivered.
    expect(await records.next()).toBeNull();
  });

  test('one view re-check is in flight at a time', async () => {
    let calls = 0;
    const h = harness({
      authorize: (principal) => {
        calls += 1;
        if (calls === 1) return principal === 'human:local:operator';
        return new Promise<boolean>(() => {});
      },
      routes: { viewRecheckWaitMs: 5 },
    });
    const records = recordReader(await h.request(`${base}/frames`, 'operator'));
    expect((await records.next())?.kind).toBe('state');
    for (let frame = 0; frame < 3; frame += 1) {
      await h.registry.get(SURFACE)!.hub.settled();
      h.producer.emit();
      expect((await records.next())?.kind).toBe('frame');
    }
    // The open's check, then ONE re-check that never answered.
    expect(calls).toBe(2);
    await records.cancel();
  });
});

/**
 * #2433 review MEDIUM: a revoked share is seen at once even while the
 * device host is busy. The device session remembers the share key (the AVD
 * name) a check resolved; a re-check refuses from the share store alone
 * when the caller no longer holds that key, before asking the host.
 */
describe('a revoked device share ends the stream while the host is busy (#2433)', () => {
  test('revoking the share while the AVD lookup is busy ends the stream on the next pull', async () => {
    const share = (deviceId: string) => ({
      hostId: 'local',
      platform: 'android' as const,
      deviceId,
      label: deviceId,
      addedBy: 'operator',
      addedAt: '2026-09-01T00:00:00.000Z',
    });
    let shares = [share('Pixel_8'), share('Other_AVD')];
    let hostBusy = false;
    let avdLookups = 0;
    const access = deviceAccessFromShares({
      authorizeOperator: async () => false,
      resolveProject: (slug) =>
        slug === 'demo' ? { id: 'project-demo' } : undefined,
      authorizeProject: async () =>
        ({
          kind: 'project-admin',
          principalId: 'admin-1',
        }) as never,
      shares: { list: () => shares },
      resolveAndroidAvd: async () => {
        avdLookups += 1;
        if (hostBusy) throw new DeviceHostBusyError();
        return 'Pixel_8';
      },
    });
    const session = {
      hostId: 'local',
      platform: 'android' as const,
      deviceId: 'emulator-5554',
      isOpen: () => true,
      shareKeyMemo: {},
    };
    const h = harness({
      authorize: (_principal, _surfaceId, action, context) =>
        authorizeDeviceSurfaceAction(access, session, action, context?.request),
    });
    const records = recordReader(
      await h.request(`${base}/frames?projectSlug=demo`, 'operator'),
    );
    expect((await records.next())?.kind).toBe('state');
    await h.registry.get(SURFACE)!.hub.settled();
    hostBusy = true;
    h.producer.emit();
    // Busy alone keeps the stream (the share still stands).
    expect((await records.next())?.kind).toBe('frame');
    await h.registry.get(SURFACE)!.hub.settled();
    shares = [share('Other_AVD')];
    const lookupsBefore = avdLookups;
    h.producer.emit();
    expect(await records.next()).toBeNull();
    // One fresh resolve was tried; the host answered busy, and with the
    // remembered share gone that refuses.
    expect(avdLookups).toBe(lookupsBefore + 1);
  });

  test('a stale remembered key does not refuse once the host answers with a key the caller holds', async () => {
    const share = (deviceId: string) => ({
      hostId: 'local',
      platform: 'android' as const,
      deviceId,
      label: deviceId,
      addedBy: 'operator',
      addedAt: '2026-09-01T00:00:00.000Z',
    });
    const access = deviceAccessFromShares({
      authorizeOperator: async () => false,
      resolveProject: (slug) =>
        slug === 'demo' ? { id: 'project-demo' } : undefined,
      authorizeProject: async () =>
        ({ kind: 'project-admin', principalId: 'admin-1' }) as never,
      shares: { list: () => [share('New_AVD')] },
      resolveAndroidAvd: async () => 'New_AVD',
    });
    // The emulator on this serial used to run Old_AVD, which is not shared.
    const shareKeyMemo: { key?: string } = { key: 'Old_AVD' };
    const request = new Request(
      'http://station.test/api/live-surfaces/x/frames?projectSlug=demo',
    );
    expect(
      await access.mayAccessDevice(
        request,
        'android',
        'emulator-5554',
        'view',
        'local',
        shareKeyMemo,
      ),
    ).toBe(true);
    expect(shareKeyMemo.key).toBe('New_AVD');
  });
});
