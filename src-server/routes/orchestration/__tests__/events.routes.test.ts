import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  SERVER_EVENT_BROADCAST_SAFETY,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import {
  collectSSE,
  readStreamUntil,
} from '../../../__test-utils__/sse-helpers.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';

// station#1205: this file's new real-service ownership-gate suite imports
// the real `OrchestrationService`, which (via `EventStore`) touches several
// other `telemetry/metrics.js` instruments beyond `sseOps`. That module is
// "safe to import even when no SDK is configured — all instruments become
// no-ops" (see its own file header) and every other real-service suite in
// this package (`orchestration.routes.test.ts`) already imports it
// unmocked, so this file no longer mocks it either — a partial `vi.mock`
// here previously broke as soon as a second instrument was touched
// (`orchestrationEventsPersisted`).
const {
  createEventRoutes,
  isApprovalEvent,
  isNotificationEvent,
  isUiNavigateEvent,
} = await import('../events.js');
const { EventBus } = await import(
  '../../../services/orchestration/event-bus.js'
);

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('paired-device event-stream lifecycle', () => {
  test('does not acquire a lease or subscribe for an already-aborted request', () => {
    const connectPairedDevice = vi.fn();
    const subscribe = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const app = createEventRoutes({
      eventBus: { subscribe } as unknown as InstanceType<typeof EventBus>,
      getACPStatus: () => ({ connected: false, connections: [] }),
      logger: mockLogger,
      connectPairedDevice,
    });
    app.request(
      new Request('http://station.test/', { signal: controller.signal }),
    );
    expect(connectPairedDevice).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
  test('releases a registered paired-device lease when subscription setup throws', async () => {
    const release = vi.fn();
    const connectPairedDevice = vi.fn(() => ({ touch: vi.fn(), release }));
    const app = createEventRoutes({
      eventBus: {
        subscribe: () => {
          throw new Error('injected subscription setup failure');
        },
      } as unknown as InstanceType<typeof EventBus>,
      getACPStatus: () => ({ connected: false, connections: [] }),
      logger: mockLogger,
      connectPairedDevice,
    });

    app.request('/');
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(connectPairedDevice).toHaveBeenCalledTimes(1);
  });

  test('releases after the initial SSE write fails before a keepalive can touch', async () => {
    const touch = vi.fn();
    const release = vi.fn();
    const app = createEventRoutes({
      eventBus: new EventBus(),
      getACPStatus: () => ({ connected: false, connections: [] }),
      logger: mockLogger,
      connectPairedDevice: () => ({ touch, release }),
      writeSse: () =>
        Promise.reject(new Error('injected initial write failure')),
    });

    app.request('/');
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(touch).not.toHaveBeenCalled();
  });

  test('settles and releases on a keepalive-only authorization flip', async () => {
    vi.useFakeTimers();
    try {
      let authorized = true;
      const release = vi.fn();
      const touch = vi.fn();
      const app = createEventRoutes({
        eventBus: new EventBus(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
        connectPairedDevice: () => ({ touch, release }),
        isPairedDeviceConnectionCurrent: () => authorized,
      });
      app.request('/');
      await Promise.resolve();
      authorized = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(release).toHaveBeenCalled();
      expect(touch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not touch after a successful write observes a closed stream', async () => {
    vi.useFakeTimers();
    try {
      const touch = vi.fn();
      const release = vi.fn();
      const app = createEventRoutes({
        eventBus: new EventBus(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
        connectPairedDevice: () => ({ touch, release }),
        writeSse: async (stream, frame) => {
          if (frame.event === 'ping')
            (stream as { closed?: boolean }).closed = true;
        },
      });
      app.request('/');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(touch).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [
    { id: 'alpha', authority: 'alpha.example.test' },
    { id: 'bravo', authority: 'bravo.example.test' },
  ],
});

function hostedAuthority(tenant: 'alpha' | 'bravo') {
  return sessionReadAuthorityFromRequest(
    `${tenant}-user`,
    { tenantId: tenantId(tenant) },
    hostedRegistry,
  );
}

// station#3583 review round (LOW-4): `gatedChannelLeakProbe` returns the
// exact secret substring `gatedChannelFixture` embeds in a genuine payload
// field for every channel, and the AC2c sweep below asserts it is absent
// from the stream. Without this, the sweep's only channel-specific
// assertion was `not.toContain('event: ${name}')` — independent of the
// payload entirely — so `gatedChannelFixture` returning `{}` for every
// channel left 25/25 green (review fault injection) and the "realistic
// per-channel payload" claim proved nothing: a wrong shape, or the payload
// leaking under some OTHER frame's event name, would have been
// unobservable. Asserting this probe closes both: it makes the fixture
// load-bearing, and it additionally proves the actual secret content never
// reaches the stream, not merely that this one event name's frame doesn't.
function gatedChannelLeakProbe(name: string): string {
  return `leak-probe-for-${name}`;
}

// A realistic (not a synthetic `{id, path}` union) payload per gated
// channel, matching the shape its real emitter uses elsewhere in this
// codebase — `NOTIFICATION_DELIVERED`/`_UPDATED`/`_DISMISSED` carry
// `toPublicNotification(...)` (`notification-service.ts`, always has `id`),
// `NOTIFICATION_CLEARED` carries `{clearedCount, retainedCount}` (never an
// `id`), `APPROVAL_OPENED`/`_RESOLVED` carry `{approvalId, ...}`
// (`approval-registry.ts`), and `UI_NAVIGATE` carries `{path}`. Every case
// embeds `gatedChannelLeakProbe(name)` verbatim in one of those genuine
// fields (not a bolted-on extra key), so the payload assertion above checks
// real field content. A channel not named here (i.e. a FUTURE gated
// channel this map hasn't been taught yet) falls back to the same generic
// marker/secret shape `AC2b` already uses for ungated channels below,
// still carrying the probe in `secret` — the sweep still runs and still
// proves denial for it, it just isn't wearing that channel's real
// production shape yet.
function gatedChannelFixture(name: string): Record<string, unknown> {
  const probe = gatedChannelLeakProbe(name);
  switch (name) {
    case SERVER_EVENTS.UI_NAVIGATE:
      return { path: `/agents/${probe}` };
    case SERVER_EVENTS.NOTIFICATION_DELIVERED:
      return { id: probe, body: `secret-body-for-${probe}` };
    case SERVER_EVENTS.NOTIFICATION_UPDATED:
      return { id: probe, status: 'dismissed' };
    case SERVER_EVENTS.NOTIFICATION_DISMISSED:
      return { id: probe };
    case SERVER_EVENTS.NOTIFICATION_CLEARED:
      return { clearedCount: 1, retainedCount: 0, marker: probe };
    case SERVER_EVENTS.APPROVAL_OPENED:
      return { approvalId: probe };
    case SERVER_EVENTS.APPROVAL_RESOLVED:
      return { approvalId: probe, status: 'approved' };
    default:
      return { marker: name, secret: probe };
  }
}

describe('Event Routes (SSE)', () => {
  test('GET / streams initial ACP status event', async () => {
    const bus = new EventBus();
    const app = createEventRoutes({
      eventBus: bus,
      getACPStatus: () => ({ connected: false, connections: [] }),
      logger: mockLogger,
    });

    const res = await app.request('/');
    const events = await collectSSE(res, { maxEvents: 1, timeoutMs: 500 });

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].event).toBe('acp:status');
    expect(events[0].parsed).toEqual({ connected: false, connections: [] });
  });

  test('GET / streams events emitted on the bus', async () => {
    const bus = new EventBus();
    const app = createEventRoutes({
      eventBus: bus,
      getACPStatus: () => ({ connected: false, connections: [] }),
      logger: mockLogger,
    });

    // Start the SSE stream
    const resPromise = app.request('/');

    // Give the stream time to connect, then emit
    await new Promise((r) => setTimeout(r, 50));
    bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { key: 'value' });

    const res = await resPromise;
    const events = await collectSSE(res, { maxEvents: 3, timeoutMs: 500 });

    // Should have ACP status + our custom event
    expect(events.some((e) => e.event === 'acp:status')).toBe(true);
  });

  test('subscribes before exposing the response and flushes snapshot-time events after the snapshot', async () => {
    const bus = new EventBus();
    const app = createEventRoutes({
      eventBus: bus,
      getACPStatus: () => {
        bus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, { id: 'during-replay' });
        return { connected: false, connections: [] };
      },
      logger: mockLogger,
    });

    const res = await app.request('/');
    const events = await collectSSE(res, { maxEvents: 2, timeoutMs: 500 });

    expect(events.map((event) => event.event)).toEqual([
      SERVER_EVENTS.ACP_STATUS,
      SERVER_EVENTS.NOTIFICATION_UPDATED,
    ]);
    expect(events[1].parsed).toEqual({ id: 'during-replay' });
  });

  test('hosted bare SSE filters notification content, IDs, and aggregate frames by request authority', async () => {
    const bus = new EventBus();
    const canReadNotificationEvent = vi.fn(
      (_event: string, data: unknown) =>
        typeof data === 'object' &&
        data !== null &&
        (data as Record<string, unknown>).sessionId === 'alpha-session',
    );
    const app = createEventRoutes({
      eventBus: bus,
      getACPStatus: () => ({ connected: false, connections: [] }),
      logger: mockLogger,
      readAuthorityForRequest: () => hostedAuthority('alpha'),
      canReadNotificationEvent,
    });

    const response = await app.request('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
      id: 'bravo-id',
      sessionId: 'bravo-session',
      body: 'bravo secret',
    });
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
      id: 'alpha-id',
      sessionId: 'alpha-session',
      body: 'alpha notice',
    });
    bus.emit(SERVER_EVENTS.NOTIFICATION_CLEARED, { clearedCount: 2 });
    bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'liveness' });

    const payload = await readStreamUntil(response.body!, (text) =>
      text.includes('"marker":"liveness"'),
    );
    expect(payload).toContain('alpha-id');
    expect(payload).toContain('alpha notice');
    expect(payload).not.toContain('bravo-id');
    expect(payload).not.toContain('bravo secret');
    expect(payload).not.toContain('clearedCount');
    expect(canReadNotificationEvent).toHaveBeenCalledTimes(3);
  });

  test('hosted bare SSE suppresses notification frames when runtime filtering is unavailable', async () => {
    const bus = new EventBus();
    const app = createEventRoutes({
      eventBus: bus,
      getACPStatus: () => ({ connected: false, connections: [] }),
      logger: mockLogger,
      readAuthorityForRequest: () => hostedAuthority('alpha'),
    });

    const response = await app.request('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    bus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, {
      id: 'bravo-id',
      status: 'dismissed',
    });
    bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'liveness' });
    const payload = await readStreamUntil(response.body!, (text) =>
      text.includes('"marker":"liveness"'),
    );
    expect(payload).not.toContain('bravo-id');
    expect(payload).toContain('"marker":"liveness"');
  });

  test('hosted bare SSE with missing tenant context suppresses notifications without invoking its filter', async () => {
    const bus = new EventBus();
    const canReadNotificationEvent = vi.fn(() => true);
    const app = createEventRoutes({
      eventBus: bus,
      getACPStatus: () => ({ connected: false, connections: [] }),
      logger: mockLogger,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('missing', undefined, hostedRegistry),
      canReadNotificationEvent,
    });

    const response = await app.request('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
      id: 'alpha-id',
      sessionId: 'alpha-session',
    });
    bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'liveness' });
    const payload = await readStreamUntil(response.body!, (text) =>
      text.includes('"marker":"liveness"'),
    );
    expect(payload).not.toContain('alpha-id');
    expect(canReadNotificationEvent).not.toHaveBeenCalled();
  });

  test('hosted bare SSE filters pending and live approval lifecycle frames through the same authority', async () => {
    const bus = new EventBus();
    const app = createEventRoutes({
      eventBus: bus,
      getACPStatus: () => {
        bus.emit(SERVER_EVENTS.APPROVAL_OPENED, {
          approvalId: 'bravo-pending',
        });
        bus.emit(SERVER_EVENTS.APPROVAL_OPENED, {
          approvalId: 'alpha-pending',
        });
        return { connected: false, connections: [] };
      },
      logger: mockLogger,
      readAuthorityForRequest: () => hostedAuthority('alpha'),
      canReadApprovalEvent: (_event, data) =>
        (data as { approvalId?: string }).approvalId?.startsWith('alpha') ===
        true,
    });

    const response = await app.request('/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    bus.emit(SERVER_EVENTS.APPROVAL_RESOLVED, {
      approvalId: 'bravo-live',
      status: 'approved',
    });
    bus.emit(SERVER_EVENTS.APPROVAL_RESOLVED, {
      approvalId: 'alpha-live',
      status: 'approved',
    });
    bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'approval-liveness' });

    const payload = await readStreamUntil(response.body!, (text) =>
      text.includes('approval-liveness'),
    );
    expect(payload).toContain('alpha-pending');
    expect(payload).toContain('alpha-live');
    expect(payload).not.toContain('bravo-pending');
    expect(payload).not.toContain('bravo-live');
  });

  // station#3583: `canRelayNotificationEvent`/`canRelayApprovalEvent`'s own
  // opening branch — `if (!authority) return canReadNotificationEvent ===
  // undefined` — has a fail-closed half (authority missing AND a filter IS
  // wired -> deny) that nothing above this point exercises. Every existing
  // "missing authority" case in this file either omits the filter too
  // (falling into the fail-OPEN "personal mode" half, same as today) or
  // supplies a real hosted/personal authority. Mirrors
  // `no-authority-wired SSE denies UI_NAVIGATE` below: construct the route
  // with NO `readAuthorityForRequest` at all (authority undefined, the
  // production-unreachable-but-must-still-deny case) while wiring a
  // permissive filter, and prove denial without ever invoking that filter —
  // the fail-closed branch returns before the callback is called.
  describe('NOTIFICATION relay fail-closed on missing authority (station#3583)', () => {
    test('no-authority-wired SSE denies NOTIFICATION_DELIVERED when a filter is wired (fail-closed on unknown mode)', async () => {
      const bus = new EventBus();
      const canReadNotificationEvent = vi.fn(() => true);
      const app = createEventRoutes({
        eventBus: bus,
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
        canReadNotificationEvent,
      });

      const res = await app.request('/');
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Liveness control, part 1.
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'before' });
      bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
        id: 'unknown-mode-notification',
        body: 'unknown-mode secret body',
      });
      // Liveness control, part 2.
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after' });

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('"marker":"after"'),
      );
      expect(payload).toContain('"marker":"before"');
      expect(payload).toContain('"marker":"after"');
      expect(payload).not.toContain('event: notification:delivered');
      expect(payload).not.toContain('unknown-mode-notification');
      expect(payload).not.toContain('unknown-mode secret body');
      // The fail-closed branch returns before invoking the filter at all.
      expect(canReadNotificationEvent).not.toHaveBeenCalled();
    });
  });

  // station#3583: same gap, `canRelayApprovalEvent`'s fail-closed half.
  describe('APPROVAL relay fail-closed on missing authority (station#3583)', () => {
    test('no-authority-wired SSE denies APPROVAL_OPENED when a filter is wired (fail-closed on unknown mode)', async () => {
      const bus = new EventBus();
      const canReadApprovalEvent = vi.fn(() => true);
      const app = createEventRoutes({
        eventBus: bus,
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
        canReadApprovalEvent,
      });

      const res = await app.request('/');
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Liveness control, part 1.
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'before' });
      bus.emit(SERVER_EVENTS.APPROVAL_OPENED, {
        approvalId: 'unknown-mode-approval',
      });
      // Liveness control, part 2.
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after' });

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('"marker":"after"'),
      );
      expect(payload).toContain('"marker":"before"');
      expect(payload).toContain('"marker":"after"');
      expect(payload).not.toContain('event: approval:opened');
      expect(payload).not.toContain('unknown-mode-approval');
      // The fail-closed branch returns before invoking the filter at all.
      expect(canReadApprovalEvent).not.toHaveBeenCalled();
    });
  });

  // station#3567 fix round FIX 1: `UI_NAVIGATE`'s payload (`{path}`) carries
  // no destination identity at all, so there is no per-event predicate to
  // test (unlike notification/approval above) — the whole decision is
  // personal-vs-hosted, and BOTH directions need their own proof: a gate
  // whose rejection path has never executed is unproven, and (per TRAP 1)
  // constructing the route with no `readAuthorityForRequest` at all would
  // prove delivery through a branch production never takes (it always wires
  // one — `runtime-routes.ts`). So the personal-mode case below supplies a
  // REAL personal-mode `SessionReadAuthority`, not an omitted dependency —
  // doubly so since station#3567 second fix round FIX 2 removed the
  // fail-open `!authority` branch: undefined authority now denies.
  describe('UI_NAVIGATE: personal mode delivers, hosted mode denies (station#3567 fix round FIX 1)', () => {
    function personalAuthority(userId: string) {
      return sessionReadAuthorityFromRequest(userId, undefined, undefined);
    }

    test('personal-mode SSE delivers UI_NAVIGATE to the connection', async () => {
      const bus = new EventBus();
      const app = createEventRoutes({
        eventBus: bus,
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
        readAuthorityForRequest: () => personalAuthority('solo-user'),
      });

      const resPromise = app.request('/');
      await new Promise((resolve) => setTimeout(resolve, 50));
      bus.emit(SERVER_EVENTS.UI_NAVIGATE, { path: '/agents/foo' });

      const res = await resPromise;
      const events = await collectSSE(res, { maxEvents: 2, timeoutMs: 1000 });
      const frame = events.find((e) => e.event === SERVER_EVENTS.UI_NAVIGATE);
      expect(frame, 'expected UI_NAVIGATE to be delivered').toBeTruthy();
      expect(frame?.parsed).toEqual({ path: '/agents/foo' });
    });

    test('hosted-mode SSE denies UI_NAVIGATE: no destination identity to route it to one tenant', async () => {
      const bus = new EventBus();
      const app = createEventRoutes({
        eventBus: bus,
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
        readAuthorityForRequest: () => hostedAuthority('alpha'),
      });

      const res = await app.request('/');
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Liveness control, part 1.
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'before' });
      bus.emit(SERVER_EVENTS.UI_NAVIGATE, { path: '/agents/private-target' });
      // Liveness control, part 2.
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after' });

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('"marker":"after"'),
      );
      expect(payload).toContain('"marker":"before"');
      expect(payload).toContain('"marker":"after"');
      expect(payload).not.toContain('event: ui:navigate');
      expect(payload).not.toContain('private-target');
    });

    // station#3567 second fix round FIX 2: fail-CLOSED, not fail-open, when
    // authority is unknown. Before this fix,
    // `if (!authority) return true` treated missing authority as clearance —
    // the only relay predicate on this route that did. This test proves the
    // replacement (`authority !== undefined && ...`) denies rather than
    // defaults to personal-mode delivery when no `readAuthorityForRequest`
    // is wired at all (the same construction shape AC2a/AC2b use for every
    // other channel).
    test('no-authority-wired SSE denies UI_NAVIGATE (fail-closed on unknown mode)', async () => {
      const bus = new EventBus();
      const app = createEventRoutes({
        eventBus: bus,
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
      });

      const res = await app.request('/');
      await new Promise((resolve) => setTimeout(resolve, 50));
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'before' });
      bus.emit(SERVER_EVENTS.UI_NAVIGATE, {
        path: '/agents/unknown-mode-target',
      });
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after' });

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('"marker":"after"'),
      );
      expect(payload).toContain('"marker":"before"');
      expect(payload).toContain('"marker":"after"');
      expect(payload).not.toContain('event: ui:navigate');
      expect(payload).not.toContain('unknown-mode-target');
    });
  });

  // station#1205: `/events` (this file's `createEventRoutes`) is a broadcast
  // route with no user-identity concept, sharing one `EventBus` with the
  // gated `/api/orchestration/events` route. `SERVER_EVENTS.ORCHESTRATION_EVENT`
  // carries per-session content (`request.opened` payloads with
  // `requestId`/`title`, etc.) that the gated route filters through
  // `canUserReadSession` — this route must never relay that event type at
  // all, so it can't reopen the same hole a third time (#1164, #1197 were
  // the first two instances on the gated route itself).
  describe('never relays ORCHESTRATION_EVENT (station#1205, station#3567)', () => {
    // station#3567: AC2 used to iterate `SERVER_EVENTS` minus a hand-picked
    // exclusion list and assert the remainder ARE forwarded — a positive
    // assertion that only caught the denylist and this list drifting apart.
    // A brand-new session-scoped channel with no denylist entry and no
    // exclusion-list entry sat entirely outside its awareness and stayed
    // GREEN while broadcasting verbatim. (station#3567 fix round FIX 4: this
    // comment used to cite a specific pass count from that probe — dropped,
    // not re-derived, because it never matched this suite's actual test
    // count at any commit and the claim it supports — that the old
    // exclusion-list guard certified a synthetic scoped member as safe —
    // stands without it.)
    //
    // Rewritten to guard the direction that actually failed, and to be
    // structurally ungameable by an exclusion list: both halves below derive
    // their expectations from `SERVER_EVENT_BROADCAST_SAFETY` — the SAME
    // tag map `events.ts` reads to decide relay-or-deny — never from a
    // second hand-picked name list. Tagging a channel `'broadcast'` when it
    // should be `'scoped'` is a judgment call no test can make (the issue's
    // own point: payload sensitivity isn't decidable from the tag's name);
    // what these tests CAN and DO prove is that the route actually honors
    // whatever the tag says — which is exactly the wiring that broke.
    const broadcastNames = Object.entries(SERVER_EVENT_BROADCAST_SAFETY)
      .filter(([, safety]) => safety === 'broadcast')
      .map(([name]) => name);
    // Scoped channels with their OWN dedicated identity gate (notification,
    // approval, ui:navigate) are covered by the dedicated tests elsewhere in
    // this file that exercise the real gate function, not a generic denial
    // check. Derived from the route's own
    // `isNotificationEvent`/`isApprovalEvent`/`isUiNavigateEvent` exports
    // rather than a second copy of their member lists, so this test cannot
    // silently drift from what the route actually recognizes.
    const gatedScopedNames = Object.keys(SERVER_EVENT_BROADCAST_SAFETY).filter(
      (name) =>
        isNotificationEvent(name) ||
        isApprovalEvent(name) ||
        isUiNavigateEvent(name),
    );
    const ungatedScopedNames = Object.entries(SERVER_EVENT_BROADCAST_SAFETY)
      .filter(
        ([name, safety]) =>
          safety === 'scoped' && !gatedScopedNames.includes(name),
      )
      .map(([name]) => name);

    // station#3583: the structural half. A channel that gains its own
    // `isXEvent`/`canRelayXEvent` gate immediately leaves `gatedScopedNames`
    // above (and therefore the AC2b sweep) — that's by design, the dedicated
    // gate is stricter. But nothing REPLACES that coverage unless someone
    // deliberately writes both-directions tests for the new gate, and a
    // forgotten pair is silent: the channel simply never appears in any
    // assertion again. `UI_NAVIGATE` demonstrated this live during #3582's
    // fix round (reverting its fail-open branch reddened nothing, because it
    // had already dropped out of the sweep), and the notification/approval
    // families had never been in the sweep at all (#3583) because they've
    // had dedicated gates since they were written.
    //
    // station#3583 review round: a first version of this test used a
    // hand-maintained checklist Set (channel names "on record" as having a
    // proven test elsewhere) instead of proving denial itself, and named
    // only 3 of these 7 channels' *own* fail-closed test even though it
    // claimed per-channel proof — the other 4 (`NOTIFICATION_UPDATED`/
    // `_DISMISSED`/`_CLEARED`, `APPROVAL_RESOLVED`) were vouched for only
    // transitively, through their family's shared gate function. That is a
    // label stronger than its derivation — the exact defect class this
    // branch exists to close.
    //
    // The fail-closed contract is uniform across every gated channel
    // (`authority` missing + a filter wired ⇒ deny; `UI_NAVIGATE` denies
    // unconditionally on missing authority), so it can be swept
    // mechanically from `gatedScopedNames` itself instead of hand-vouched:
    // this sweeps and PROVES denial for all 7, with zero checklist to
    // forget, and auto-covers the next gated channel with no edit here at
    // all.
    test.each(gatedScopedNames)(
      'AC2c: %s denies when authority is missing and its filter is wired (fail-closed on unknown mode)',
      async (name) => {
        const bus = new EventBus();
        // Both wired and permissive for every channel — irrelevant to
        // channels that don't read them (e.g. `UI_NAVIGATE`), and proves
        // for notification/approval that a wired-but-missing-authority
        // filter still denies rather than being consulted.
        const canReadNotificationEvent = vi.fn(() => true);
        const canReadApprovalEvent = vi.fn(() => true);
        const app = createEventRoutes({
          eventBus: bus,
          getACPStatus: () => ({ connected: false, connections: [] }),
          logger: mockLogger,
          canReadNotificationEvent,
          canReadApprovalEvent,
        });

        const res = await app.request('/');
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Liveness control, part 1.
        bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'before' });
        bus.emit(name as never, gatedChannelFixture(name));
        // Liveness control, part 2.
        bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after' });

        const payload = await readStreamUntil(res.body!, (text) =>
          text.includes('"marker":"after"'),
        );
        expect(payload).toContain('"marker":"before"');
        expect(payload).toContain('"marker":"after"');
        expect(payload, name).not.toContain(`event: ${name}`);
        // station#3583 review round (LOW-4): makes the fixture load-bearing
        // — proves the payload's actual secret content never reaches the
        // stream, not merely that this event name's own frame doesn't
        // (which the check above already covers independent of payload).
        expect(payload, name).not.toContain(gatedChannelLeakProbe(name));
      },
    );

    test('the AC2c sweep has channels to sweep', () => {
      expect(gatedScopedNames.length).toBeGreaterThan(0);
    });

    test('AC2a: every broadcast-tagged channel is forwarded verbatim', async () => {
      const bus = new EventBus();
      const app = createEventRoutes({
        eventBus: bus,
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
      });

      const resPromise = app.request('/');
      await new Promise((r) => setTimeout(r, 50));

      expect(broadcastNames.length).toBeGreaterThan(0);
      for (const name of broadcastNames) {
        bus.emit(name as never, { marker: name });
      }

      const res = await resPromise;
      const events = await collectSSE(res, {
        // +1 for the initial acp:status replay frame.
        maxEvents: broadcastNames.length + 1,
        timeoutMs: 1000,
      });

      for (const name of broadcastNames) {
        const frame = events.find(
          (e) => e.event === name && e.parsed?.marker === name,
        );
        expect(frame, `expected a forwarded frame for ${name}`).toBeTruthy();
      }
    });

    // station#3567's probe, generalized: a synthetic scoped channel with no
    // dedicated gate must be denied, not just the three named at the time of
    // the fix. Proves the mechanism, not a memorized list of channel names —
    // and would catch the NEXT scoped channel that is added, since it is
    // derived from the tag map, not hand-enumerated here.
    test('AC2b: every scoped channel without a dedicated identity gate is denied by default, not forwarded', async () => {
      const bus = new EventBus();
      const app = createEventRoutes({
        eventBus: bus,
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
      });

      const res = await app.request('/');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(ungatedScopedNames.length).toBeGreaterThan(0);
      // Liveness control, part 1: prove the connection is alive BEFORE
      // asserting absence.
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'before' });
      for (const name of ungatedScopedNames) {
        bus.emit(name as never, {
          marker: name,
          secret: `private-payload-for-${name}`,
        });
      }
      // Liveness control, part 2: the connection is still alive AFTER the
      // leak-attempt window.
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after' });

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('"marker":"after"'),
      );
      expect(payload).toContain('"marker":"before"');
      expect(payload).toContain('"marker":"after"');
      for (const name of ungatedScopedNames) {
        // station#3567 fix round FIX 5: this used to assert
        // `.not.toContain(`"${name}"`)`, which reads as checking the SSE
        // frame's own `event: <name>` line — but that line is emitted
        // UNQUOTED (hono's `writeSSE` writes `event: ${message.event}` with
        // no surrounding quotes), so a forwarded frame's event line would
        // never match a quoted needle. The assertion only ever had power
        // because the same test also puts `name` in `data.marker`, which
        // DOES get JSON-quoted (`"marker":"<name>"`) — i.e. it was really
        // re-checking the `secret` assertion below by accident. Assert the
        // real SSE wire shape directly instead.
        expect(
          payload,
          `expected ${name} to be denied (event line present)`,
        ).not.toContain(`event: ${name}`);
        expect(
          payload,
          `expected ${name}'s payload to be denied (secret marker present)`,
        ).not.toContain(`private-payload-for-${name}`);
      }
    });

    test('private operational-work notifications never cross the identity-free broadcast route', async () => {
      const bus = new EventBus();
      const app = createEventRoutes({
        eventBus: bus,
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
      });

      const resPromise = app.request('/');
      await new Promise((resolve) => setTimeout(resolve, 50));
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'before' });
      bus.emit(SERVER_EVENTS.OPERATIONAL_EVENT, {
        marker: 'private-operational-payload',
      });
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after' });

      const events = await collectSSE(await resPromise, {
        maxEvents: 3,
        timeoutMs: 1000,
      });
      expect(events.some((frame) => frame.parsed?.marker === 'before')).toBe(
        true,
      );
      expect(events.some((frame) => frame.parsed?.marker === 'after')).toBe(
        true,
      );
      expect(
        events.some(
          (frame) => frame.parsed?.marker === 'private-operational-payload',
        ),
      ).toBe(false);
    });

    // station#3525 fix round (BLOCKING): probe-proven — before this fix,
    // this exact payload (another user's session identity) was relayed
    // verbatim on this unauthenticated route.
    test('internal-stop-redispatch-failed signals never cross the identity-free broadcast route', async () => {
      const bus = new EventBus();
      const app = createEventRoutes({
        eventBus: bus,
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
      });

      const resPromise = app.request('/');
      await new Promise((resolve) => setTimeout(resolve, 50));
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'before' });
      bus.emit(SERVER_EVENTS.INTERNAL_STOP_REDISPATCH_FAILED, {
        threadId: 'private-thread-of-another-user',
        turnId: 'private-turn-id',
        provider: 'codex',
      });
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after' });

      const events = await collectSSE(await resPromise, {
        maxEvents: 3,
        timeoutMs: 1000,
      });
      expect(events.some((frame) => frame.parsed?.marker === 'before')).toBe(
        true,
      );
      expect(events.some((frame) => frame.parsed?.marker === 'after')).toBe(
        true,
      );
      expect(
        events.some(
          (frame) =>
            frame.event === SERVER_EVENTS.INTERNAL_STOP_REDISPATCH_FAILED,
        ),
      ).toBe(false);
      expect(
        events.some((frame) =>
          JSON.stringify(frame.parsed ?? {}).includes(
            'private-thread-of-another-user',
          ),
        ),
      ).toBe(false);
    });

    // Real-service harness (station#1164/#1197 pattern, reused per #1205's
    // instruction): a minimal-but-real `ProviderAdapterShape` feeds a real
    // `OrchestrationService` backed by a real `EventStore`, which persists
    // and then emits `SERVER_EVENTS.ORCHESTRATION_EVENT` on a real
    // `EventBus` — the SAME bus `/events` subscribes to. This proves the
    // fix against genuine production event flow, not a hand-built fake bus
    // frame.
    let tmp: string;
    let eventStore: EventStore;
    let eventBus: InstanceType<typeof EventBus>;
    let adapter: GateTestAdapter;
    let service: OrchestrationService;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'events-routes-orchestration-gate-'));
      eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
      eventBus = new EventBus();
      adapter = new GateTestAdapter();
      service = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(adapter),
        eventBus,
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      service.initialize();
    });

    afterEach(() => {
      eventStore.close();
      rmSync(tmp, { recursive: true, force: true });
    });

    test('AC1/AC3/AC4: a client on /events never receives an ORCHESTRATION_EVENT frame, proven alive both before and after the leak attempt', async () => {
      const app = createEventRoutes({
        eventBus,
        getACPStatus: () => ({ connected: false, connections: [] }),
        logger: mockLogger,
      });

      const res = await app.request('/');
      // Let the SSE subscription register before anything is emitted
      // (mirrors this file's other GET / tests and the gated-route suite).
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Liveness control, part 1 (AC3: prove the connection is alive BEFORE
      // asserting absence — a dead connection would trivially pass an
      // absence check). A real, non-orchestration broadcast event.
      eventBus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'pre-secret' });

      // `OrchestrationService.initialize()` starts an async, fire-and-forget
      // `consumeAdapterEvents` loop per adapter (`orchestration-service.ts`
      // line ~795) — pushing onto `adapter.events` does NOT synchronously
      // reach the bus. A raw bus subscriber, registered before the push,
      // lets the test await the REAL moment the real service actually
      // persists and emits `ORCHESTRATION_EVENT` with the secret payload,
      // instead of guessing a delay. Because `EventBus.emit` calls every
      // listener synchronously in one pass, this subscriber and the
      // `/events` route's own subscriber observe the SAME emission in the
      // same synchronous unwind — so once this promise resolves, the
      // route's subscriber (pre-fix) has already been invoked with it too.
      const secretReachedBus = new Promise<void>((resolve) => {
        const unsubRaw = eventBus.subscribe((evt) => {
          if (
            evt.event === SERVER_EVENTS.ORCHESTRATION_EVENT &&
            JSON.stringify(evt.data ?? {}).includes('req-owner-secret')
          ) {
            unsubRaw();
            resolve();
          }
        });
      });

      // A real orchestration session, driven through the REAL
      // OrchestrationService — the same pipeline production uses. This is
      // the specific secret payload that must never appear on /events.
      adapter.events.push({
        eventId: 'evt-owner-session-started',
        provider: 'claude',
        threadId: 'thread-owner',
        createdAt: '2026-07-28T00:00:00.000Z',
        method: 'session.started',
        sessionId: 'thread-owner',
        initialState: 'created',
        metadata: { userId: 'owner-user' },
      } as CanonicalRuntimeEvent);
      adapter.events.push({
        eventId: 'evt-owner-secret',
        provider: 'claude',
        threadId: 'thread-owner',
        createdAt: '2026-07-28T00:00:01.000Z',
        method: 'request.opened',
        requestId: 'req-owner-secret',
        requestType: 'approval',
        title: 'Owner-only request',
      } as CanonicalRuntimeEvent);

      await secretReachedBus;

      // Liveness control, part 2: prove this exact connection is STILL
      // alive after the leak-attempt window, so the eventual absence check
      // isn't just racing a connection that quietly died. Wait for a
      // deterministic marker emitted (and, per the ordering argument above,
      // necessarily forwarded after any pre-fix secret frame) after the bus
      // has genuinely carried the secret event.
      eventBus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'post-secret' });

      const payload = await readStreamUntil(res.body!, (text) =>
        text.includes('"marker":"post-secret"'),
      );
      expect(payload).toContain('"marker":"pre-secret"');
      expect(payload).toContain('"marker":"post-secret"');
      // The specific leaked payload — never a generic count/length check.
      expect(payload).not.toContain('"requestId":"req-owner-secret"');
      expect(payload).not.toContain('thread-owner');
      expect(payload).not.toContain(SERVER_EVENTS.ORCHESTRATION_EVENT);
    });
  });
});
