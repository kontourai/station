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
