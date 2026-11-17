import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  ConversationWorkStateStore,
  MAX_HIDDEN_SESSIONS_PER_PERSON,
} from '../../../services/orchestration/conversation-work-state-store.js';
import { createConversationWorkStateRoutes } from '../conversation-work-state.js';

const temp = trackTempDirs();
type WorkStateEnvelope = {
  data: { settled: Record<string, string>; hidden: Record<string, string> };
};
function setup() {
  let enabled = false;
  let current = true;
  const directory = temp('station-work-state-');
  const store = new ConversationWorkStateStore(directory);
  const write = vi.spyOn(store, 'set');
  const hide = vi.spyOn(store, 'setHidden');
  const canRead = vi.fn(async (id: string) => id === 'conversation');
  const canReadSession = vi.fn((id: string) => id === 'external-thread');
  const app = new Hono();
  app.route(
    '/',
    createConversationWorkStateRoutes({
      store,
      canRead,
      canReadSession,
      authorityFor: (request) =>
        sessionReadAuthorityFromRequest(
          request.headers.get('x-person') ?? 'human:local:operator',
          undefined,
          undefined,
        ),
      isOwnerDevice: (id) => id === 'phone',
      current: () => current,
      preview: {
        select: (branches) =>
          enabled ? branches.enabled() : branches.disabled(),
      },
    }),
  );
  app.get('/unrelated', (c) => c.text('ordinary conversation route'));
  const put = (settled: unknown, person?: string, id = 'conversation') =>
    app.request(`/${id}/work-state`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(person ? { 'x-person': person } : {}),
      },
      body: JSON.stringify({ settled }),
    });
  const putHidden = (
    hidden: unknown,
    person?: string,
    id = 'external-thread',
  ) =>
    app.request(`/${id}/inbox-hidden`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(person ? { 'x-person': person } : {}),
      },
      body: JSON.stringify({ hidden }),
    });
  return {
    app,
    store,
    write,
    hide,
    canRead,
    canReadSession,
    directory,
    put,
    putHidden,
    enable: () => {
      enabled = true;
    },
    expire: () => {
      current = false;
    },
  };
}
describe('personal conversation resolution through its routes', () => {
  test('off preview refuses reads and writes with no side effects and leaves ordinary routes available', async () => {
    const h = setup();
    expect((await h.app.request('/work-state')).status).toBe(404);
    expect((await h.put(true)).status).toBe(404);
    expect((await h.putHidden(true)).status).toBe(404);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.hide).not.toHaveBeenCalled();
    expect(h.canRead).not.toHaveBeenCalled();
    expect(h.canReadSession).not.toHaveBeenCalled();
    expect((await h.app.request('/unrelated')).status).toBe(200);
  });
  test('settlement survives restart, syncs owner devices, stays personal and can be reopened', async () => {
    const h = setup();
    h.enable();
    expect((await h.put(true)).status).toBe(200);
    const response = await h.app.request('/work-state', {
      headers: { 'x-person': 'human:device:phone' },
    });
    const body = (await response.json()) as WorkStateEnvelope;
    expect(body.data.settled.conversation).toEqual(expect.any(String));
    expect(
      new ConversationWorkStateStore(h.directory).read('personal:owner')
        .conversation,
    ).toBe(body.data.settled.conversation);
    const other = await h.app.request('/work-state', {
      headers: { 'x-person': 'human:tailnet:other' },
    });
    expect(((await other.json()) as WorkStateEnvelope).data.settled).toEqual(
      {},
    );
    expect((await h.put(false)).status).toBe(200);
    expect(
      ((await (await h.app.request('/work-state')).json()) as WorkStateEnvelope)
        .data.settled,
    ).toEqual({});
  });
  test('unknown conversations, service callers, invalid bodies and expired requests never write', async () => {
    const h = setup();
    h.enable();
    expect((await h.put(true, undefined, 'unreadable')).status).toBe(404);
    expect((await h.put(true, 'service:automation')).status).toBe(403);
    expect((await h.put('yes')).status).toBe(400);
    h.expire();
    expect((await h.put(true)).status).toBe(403);
    expect(h.write).not.toHaveBeenCalled();
  });
  test('a hidden third-party Session stays hidden across devices and restarts, per person, until unhidden', async () => {
    const h = setup();
    h.enable();
    expect((await h.putHidden(true)).status).toBe(200);
    expect(h.canReadSession).toHaveBeenCalledWith(
      'external-thread',
      expect.anything(),
    );
    const phone = (await (
      await h.app.request('/work-state', {
        headers: { 'x-person': 'human:device:phone' },
      })
    ).json()) as WorkStateEnvelope;
    expect(phone.data.hidden['external-thread']).toEqual(expect.any(String));
    expect(phone.data.settled).toEqual({});
    expect(
      new ConversationWorkStateStore(h.directory).readHidden('personal:owner'),
    ).toEqual(phone.data.hidden);
    const other = (await (
      await h.app.request('/work-state', {
        headers: { 'x-person': 'human:tailnet:other' },
      })
    ).json()) as WorkStateEnvelope;
    expect(other.data.hidden).toEqual({});
    // Hiding is independent of settlement: settling leaves it hidden.
    expect((await h.put(true)).status).toBe(200);
    expect(
      new ConversationWorkStateStore(h.directory).readHidden('personal:owner'),
    ).toEqual(phone.data.hidden);
    expect((await h.putHidden(false, 'human:device:phone')).status).toBe(200);
    expect(
      ((await (await h.app.request('/work-state')).json()) as WorkStateEnvelope)
        .data.hidden,
    ).toEqual({});
  });
  test('an unreadable Session, a service caller, an invalid body or an expired request never hides', async () => {
    const h = setup();
    h.enable();
    expect((await h.putHidden(true, undefined, 'conversation')).status).toBe(
      404,
    );
    expect((await h.putHidden(true, 'service:automation')).status).toBe(403);
    expect((await h.putHidden('yes')).status).toBe(400);
    h.expire();
    expect((await h.putHidden(true)).status).toBe(403);
    expect(h.hide).not.toHaveBeenCalled();
  });
});

describe('conversation work-state store growth', () => {
  test("forget drops every person's settled and hidden records for the ids, and nothing else", () => {
    const directory = temp('station-work-state-forget-');
    const store = new ConversationWorkStateStore(directory);
    store.set('a', 'gone', true, '2026-11-01T00:00:00.000Z');
    store.set('a', 'kept', true, '2026-11-01T00:00:00.000Z');
    store.set('b', 'gone', true, '2026-11-01T00:00:00.000Z');
    store.setHidden('a', 'gone', true, '2026-11-01T00:00:00.000Z');
    store.setHidden('b', 'other', true, '2026-11-01T00:00:00.000Z');
    store.forget(['gone']);
    expect(store.read('a')).toEqual({ kept: '2026-11-01T00:00:00.000Z' });
    expect(store.read('b')).toEqual({});
    expect(store.readHidden('a')).toEqual({});
    expect(store.readHidden('b')).toEqual({
      other: '2026-11-01T00:00:00.000Z',
    });
  });
  test('the hidden map keeps only the newest records per person', () => {
    const store = new ConversationWorkStateStore(
      temp('station-work-state-bound-'),
    );
    for (let index = 0; index <= MAX_HIDDEN_SESSIONS_PER_PERSON; index++)
      store.setHidden(
        'a',
        `thread-${index}`,
        true,
        new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
      );
    const hidden = store.readHidden('a');
    expect(Object.keys(hidden)).toHaveLength(MAX_HIDDEN_SESSIONS_PER_PERSON);
    expect(hidden).not.toHaveProperty('thread-0');
    expect(hidden).toHaveProperty(`thread-${MAX_HIDDEN_SESSIONS_PER_PERSON}`);
  });
});
