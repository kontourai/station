/**
 * #3628: the person's coordinator designation routes over the real store.
 */
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
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
