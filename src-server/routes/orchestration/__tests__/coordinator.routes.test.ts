/**
 * #3628: the person's coordinator designation routes over the real store.
 */
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  bindStationControlRequestAuthority,
  stationControlRequestAuthority,
} from '../../../security/station-control-request-authority.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../../tools/station-control-shared.js';
import { createCoordinatorRoutes } from '../coordinator.js';

const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function app(options: {
  userId?: string;
  writable?: (conversationId: string) => boolean;
  store?: 'none';
}) {
  const store = new EventStore(
    join(makeTempDir('coordinator-routes-'), 'orchestration.sqlite'),
  );
  stores.push(store);
  const userId = options.userId ?? 'human:local:owner';
  const routes = createCoordinatorRoutes({
    store: options.store === 'none' ? undefined : store.coordinatorStore(),
    person: () => ({
      userId,
      mayRead: () => true,
      mayMutate: options.writable ?? (() => true),
    }),
    dispatchActor: () => ({ userId }),
  });
  const hono = new Hono();
  hono.route('/api/orchestration', routes);
  const call = (method: string, body?: unknown, agent = false) =>
    hono.request('/api/orchestration/coordinator', {
      method,
      headers: {
        'content-type': 'application/json',
        ...(agent
          ? {
              [STATION_CONTROL_ORIGIN_HEADER]:
                STATION_CONTROL_ORIGIN_AGENT_TOOL,
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, store };
}

describe('coordinator routes', () => {
  test('designate, read, refuse a second, replace explicitly, undesignate', async () => {
    const { call } = app({});
    expect(await (await call('GET')).json()).toEqual({
      success: true,
      data: { designation: null },
    });
    const first = await call('PUT', { conversationId: 'chat-a' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      data: { designation: { conversationId: 'chat-a' } },
    });
    const second = await call('PUT', { conversationId: 'chat-b' });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      success: false,
      code: 'coordinator_already_designated',
    });
    expect(
      (await call('PUT', { conversationId: 'chat-b', replace: true })).status,
    ).toBe(200);
    expect(await (await call('GET')).json()).toMatchObject({
      data: { designation: { conversationId: 'chat-b' } },
    });
    expect(await (await call('DELETE')).json()).toEqual({
      success: true,
      data: { undesignated: true },
    });
    expect(await (await call('GET')).json()).toMatchObject({
      data: { designation: null },
    });
  });

  test('a conversation the person cannot send to is not found, and a bad body is refused', async () => {
    const { call, store } = app({ writable: (id) => id !== 'someone-else' });
    expect((await call('PUT', { conversationId: 'someone-else' })).status).toBe(
      404,
    );
    expect((await call('PUT', { conversationId: '' })).status).toBe(400);
    expect(
      (await call('PUT', { conversationId: 'chat-a', replace: 'yes' })).status,
    ).toBe(400);
    expect(store.coordinatorStore().designations()).toEqual([]);
  });

  test('an agent cannot designate itself or read the designation', async () => {
    const { call, store } = app({});
    expect((await call('PUT', { conversationId: 'chat-a' }, true)).status).toBe(
      403,
    );
    expect((await call('GET', undefined, true)).status).toBe(403);
    expect((await call('DELETE', undefined, true)).status).toBe(403);
    expect(store.coordinatorStore().designations()).toEqual([]);
  });

  test('a hosted Station (no store) answers unavailable', async () => {
    const { call } = app({ store: 'none' });
    expect((await call('GET')).status).toBe(503);
    expect((await call('PUT', { conversationId: 'chat-a' })).status).toBe(503);
  });
});

describe('coordinator routes: targets that stop being the coordinator', () => {
  function appWith(options: { readable?: (id: string) => boolean }) {
    const store = new EventStore(
      join(makeTempDir('coordinator-routes-retire-'), 'orchestration.sqlite'),
    );
    stores.push(store);
    const retired: string[] = [];
    const hono = new Hono().route(
      '/api/orchestration',
      createCoordinatorRoutes({
        store: store.coordinatorStore(),
        person: () => ({
          userId: 'human:local:owner',
          mayRead: options.readable ?? (() => true),
          mayMutate: () => true,
        }),
        dispatchActor: () => ({ userId: 'human:local:owner' }),
        wakes: {
          retire: (_user, conversationId) => {
            retired.push(conversationId);
            return 0;
          },
        },
        delivery: (conversationId) => ({
          wakes: conversationId === 'chat-codex' ? 'blocked' : 'ready',
          toolsPending: true,
        }),
      }),
    );
    const call = (method: string, body?: unknown) =>
      hono.request('/api/orchestration/coordinator', {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { call, retired };
  }

  test('replacing and removing withdraw the old target; reads carry delivery', async () => {
    const { call, retired } = appWith({});
    expect(
      await (await call('PUT', { conversationId: 'chat-codex' })).json(),
    ).toMatchObject({
      data: { delivery: { wakes: 'blocked', toolsPending: true } },
    });
    expect(retired).toEqual([]);
    await call('PUT', { conversationId: 'chat-b', replace: true });
    expect(retired).toEqual(['chat-codex']);
    expect(await (await call('GET')).json()).toMatchObject({
      data: {
        designation: { conversationId: 'chat-b' },
        delivery: { wakes: 'ready' },
      },
    });
    await call('DELETE');
    expect(retired).toEqual(['chat-codex', 'chat-b']);
  });

  test('a designation the person can no longer read is replaced without asking', async () => {
    let gone = false;
    const { call, retired } = appWith({
      readable: (id) => !(gone && id === 'chat-deleted'),
    });
    await call('PUT', { conversationId: 'chat-deleted' });
    gone = true;
    expect(await (await call('GET')).json()).toMatchObject({
      data: { designation: null },
    });
    const next = await call('PUT', { conversationId: 'chat-new' });
    expect(next.status).toBe(200);
    expect(retired).toEqual(['chat-deleted']);
  });
});

describe('coordinator working picture', () => {
  test('a verified coordinator writes its owner picture, and each read rechecks source access', async () => {
    const store = new EventStore(
      join(makeTempDir('coordinator-picture-route-'), 'store.sqlite'),
    );
    stores.push(store);
    const coordinator = store.coordinatorStore();
    coordinator.designate({
      conversationId: 'coordinator',
      actor: { userId: 'owner' },
      replace: false,
      now: 1,
    });
    const denied = new Set<string>();
    let preview = true;
    let callerConversation = 'coordinator';
    let callerCurrent = true;
    let observedCaller: (() => void) | undefined;
    const routes = createCoordinatorRoutes({
      store: coordinator,
      person: () => ({
        userId: 'owner',
        mayRead: (id) => !denied.has(id),
        mayMutate: () => true,
      }),
      dispatchActor: () => ({ userId: 'owner' }),
      picturePreview: {
        select: ({ enabled, disabled }) => (preview ? enabled() : disabled()),
      },
      isInternalRequest: () => true,
      resolvePictureCaller: (request) => {
        const authority = stationControlRequestAuthority(request);
        observedCaller?.();
        return callerCurrent && authority?.kind === 'caller'
          ? authority.caller
          : null;
      },
      agentMayRead: (_caller, id) => !denied.has(id),
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (c.req.path.includes('/station-control/'))
        bindStationControlRequestAuthority(c.req.raw, {
          kind: 'caller',
          boundOperator: true,
          caller: {
            sessionId: 'coordinator',
            conversationId: callerConversation,
            assurance: 'bound',
            principal: {
              id: 'owner',
              source: 'session-owner',
              elevationEligible: true,
            },
          },
        });
      await next();
    });
    app.route('/api/orchestration', routes);
    const send = (path: string, method = 'GET', body?: unknown) =>
      app.request(`/api/orchestration/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect(
      (
        await send('station-control/coordinator-picture', 'POST', {
          conversationId: 'work-a',
          status: 'waiting',
          summary: 'Needs review',
        })
      ).status,
    ).toBe(200);
    expect(await (await send('coordinator/picture')).json()).toMatchObject({
      data: { items: [{ conversationId: 'work-a', summary: 'Needs review' }] },
    });
    callerConversation = 'other-chat';
    expect((await send('station-control/coordinator-picture')).status).toBe(
      404,
    );
    callerConversation = 'coordinator';
    preview = false;
    expect(await (await send('coordinator/picture')).json()).toMatchObject({
      success: false,
      code: 'feature_preview_disabled',
      previewId: 'coordinator-picture',
    });
    expect(
      (
        await send('station-control/coordinator-picture', 'POST', {
          conversationId: 'work-b',
          status: 'waiting',
          summary: 'No write while disabled',
        })
      ).status,
    ).toBe(404);
    expect(coordinator.pictureItems('owner')).toHaveLength(1);
    preview = true;
    let finishBody!: (text: string) => void;
    let started!: () => void;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    observedCaller = started;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finishBody = (text) => {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        };
      },
    });
    const request = new Request(
      'http://station.test/api/orchestration/station-control/coordinator-picture',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
    );
    const inFlight = app.fetch(request);
    await admitted;
    callerCurrent = false;
    finishBody(
      JSON.stringify({
        conversationId: 'work-b',
        status: 'waiting',
        summary: 'Must not be written',
      }),
    );
    expect((await inFlight).status).toBe(404);
    expect(
      coordinator
        .pictureItems('owner')
        .some((item) => item.conversationId === 'work-b'),
    ).toBe(false);
    callerCurrent = true;
    observedCaller = undefined;
    coordinator.setPictureItem({
      userId: 'owner',
      conversationId: 'expired',
      status: 'finished',
      summary: 'Old finished work',
      now: 1,
    });
    expect(await (await send('coordinator/picture')).json()).not.toMatchObject({
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({ summary: 'Old finished work' }),
        ]),
      },
    });
    denied.add('work-a');
    expect(await (await send('coordinator/picture')).json()).toMatchObject({
      data: { items: [] },
    });
    expect(
      await (await send('station-control/coordinator-picture')).json(),
    ).toMatchObject({ data: { items: [] } });
    expect(
      (
        await send('station-control/coordinator-picture', 'POST', {
          conversationId: 'work-a',
          status: 'finished',
          summary: 'Done',
        })
      ).status,
    ).toBe(404);
    denied.delete('work-a');
    expect(await (await send('coordinator/picture')).json()).toMatchObject({
      data: { items: [{ summary: 'Needs review' }] },
    });
  });
});
