import { join } from 'node:path';
import type {
  SessionLiveContinuity,
  SessionRewindOutcome,
} from '@kontourai/station-contracts/provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus';
import { EventStore } from '../../../services/orchestration/event-store';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service';
import { createOrchestrationRoutes } from '../orchestration';

/**
 * `GET /sessions/:threadId/continuity` and `POST /sessions/:threadId/rewind`,
 * through the real router and service: who may read and ask, what reaches the
 * adapter, and that its typed outcome comes back as given.
 */
const NOW = '2026-11-13T10:00:00.000Z';
const THREAD = 'session-rewind';

const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type RewindAdapter = GateTestAdapter & {
  sessionContinuity?: (threadId: string) => SessionLiveContinuity;
  rewindSession?: (
    threadId: string,
    turnId: string,
  ) => Promise<SessionRewindOutcome>;
};

async function fixture(options: { rewind?: boolean; live?: boolean } = {}) {
  const directory = makeTempDir('station-session-rewind-');
  const store = new EventStore(join(directory, 'events.sqlite'));
  const adapter = new GateTestAdapter() as RewindAdapter;
  vi.spyOn(adapter, 'hasSession').mockResolvedValue(options.live ?? true);
  const rewind = vi.fn(
    async (
      _threadId: string,
      turnId: string,
    ): Promise<SessionRewindOutcome> => ({
      kind: 'rewound',
      beforeTurnId: turnId,
      hiddenTurnIds: [turnId],
    }),
  );
  if (options.rewind ?? true) {
    adapter.rewindSession = rewind;
    adapter.sessionContinuity = () => ({
      live: true,
      rewind: 'in-place',
      fork: 'none',
    });
  }
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  service.initialize();
  await awaitSessionAttachmentSettled(service);
  store.upsertSession({
    provider: 'claude',
    threadId: THREAD,
    status: 'ready',
    createdAt: NOW,
    updatedAt: NOW,
  });
  store.appendEvent({
    eventId: 'configured-rewind',
    provider: 'claude',
    threadId: THREAD,
    method: 'session.configured',
    sessionId: THREAD,
    createdAt: NOW,
    metadata: { userId: 'owner' },
  });
  let user = 'owner';
  let principalCurrent = true;
  const nudge = vi.fn();
  const app = createOrchestrationRoutes(service, {
    eventBus: new EventBus(),
    logger: { debug: vi.fn() },
    getUserId: () => user,
    isRequestPrincipalCurrent: () => principalCurrent,
    // Only the rewind route's own call is modelled here.
    threadInbox: { nudge } as never,
  });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });
  return {
    app,
    rewind,
    nudge,
    setUser: (value: string) => {
      user = value;
    },
    revoke: () => {
      principalCurrent = false;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const post = (f: Fixture, body?: unknown) =>
  f.app.request(`/sessions/${THREAD}/rewind`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }),
  });

const continuity = (f: Fixture) =>
  f.app.request(`/sessions/${THREAD}/continuity`);

describe('session continuity route', () => {
  test("a live session's continuity is the adapter's declaration", async () => {
    const f = await fixture();
    const response = await continuity(f);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { live: true, rewind: 'in-place', fork: 'none' },
    });
  });

  test('a session with no live engine, or an adapter that declares nothing, offers nothing', async () => {
    const none = { live: false, rewind: 'none', fork: 'none' };
    const stopped = await fixture({ live: false });
    expect(await (await continuity(stopped)).json()).toEqual({
      success: true,
      data: none,
    });
    const plain = await fixture({ rewind: false });
    expect(await (await continuity(plain)).json()).toEqual({
      success: true,
      data: none,
    });
  });

  test('a caller who cannot read the session gets 404', async () => {
    const f = await fixture();
    f.setUser('someone-else');
    expect((await continuity(f)).status).toBe(404);
  });
});

describe('session rewind route', () => {
  test("the Session's owner reaches the adapter, and its outcome comes back as given", async () => {
    const f = await fixture();
    const response = await post(f, { turnId: 'turn-2' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        kind: 'rewound',
        beforeTurnId: 'turn-2',
        hiddenTurnIds: ['turn-2'],
      },
    });
    expect(f.rewind).toHaveBeenCalledWith(THREAD, 'turn-2');
  });

  test("the adapter's typed refusal comes back as given", async () => {
    const f = await fixture();
    f.rewind.mockResolvedValueOnce({ kind: 'refused', reason: 'turn-running' });
    expect(await (await post(f, { turnId: 'turn-2' })).json()).toEqual({
      success: true,
      data: { kind: 'refused', reason: 'turn-running' },
    });
  });

  test('every rewind end looks at the inbox again: applied, refused, failed or thrown', async () => {
    const f = await fixture();
    await post(f, { turnId: 'turn-2' });
    expect(f.nudge).toHaveBeenLastCalledWith(THREAD);
    f.rewind.mockResolvedValueOnce({ kind: 'failed', message: 'late' });
    await post(f, { turnId: 'turn-2' });
    f.rewind.mockRejectedValueOnce(new Error('adapter replaced'));
    expect((await post(f, { turnId: 'turn-2' })).status).toBe(409);
    expect(f.nudge).toHaveBeenCalledTimes(3);
  });

  test('anyone but the current owner gets 404 and nothing reaches the engine', async () => {
    const other = await fixture();
    other.setUser('someone-else');
    expect((await post(other, { turnId: 'turn-2' })).status).toBe(404);
    expect(other.rewind).not.toHaveBeenCalled();

    const revoked = await fixture();
    revoked.revoke();
    expect((await post(revoked, { turnId: 'turn-2' })).status).toBe(404);
    expect(revoked.rewind).not.toHaveBeenCalled();
  });

  test('a missing or oversized turn id, and a body key the route does not take, are refused 400', async () => {
    const f = await fixture();
    expect((await post(f)).status).toBe(400);
    expect((await post(f, {})).status).toBe(400);
    expect((await post(f, { turnId: '' })).status).toBe(400);
    expect((await post(f, { turnId: 't', files: true })).status).toBe(400);
    expect((await post(f, { turnId: 'a'.repeat(1025) })).status).toBe(400);
    expect(f.rewind).not.toHaveBeenCalled();
    expect((await post(f, { turnId: 'a'.repeat(1024) })).status).toBe(200);
  });

  test('an adapter with no rewind answers unsupported; a session with no live engine, not-live', async () => {
    const plain = await fixture({ rewind: false });
    expect(await (await post(plain, { turnId: 'turn-2' })).json()).toEqual({
      success: true,
      data: { kind: 'refused', reason: 'unsupported' },
    });
    const stopped = await fixture({ live: false });
    expect(await (await post(stopped, { turnId: 'turn-2' })).json()).toEqual({
      success: true,
      data: { kind: 'refused', reason: 'not-live' },
    });
    expect(stopped.rewind).not.toHaveBeenCalled();
  });
});
