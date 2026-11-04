import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConversationWorkStateStore } from '../../../services/orchestration/conversation-work-state-store.js';
import { createConversationWorkStateRoutes } from '../conversation-work-state.js';

const temp = trackTempDirs();
type WorkStateEnvelope = { data: { settled: Record<string, string> } };
function setup() {
  let enabled = false;
  let current = true;
  const directory = temp('station-work-state-');
  const store = new ConversationWorkStateStore(directory);
  const write = vi.spyOn(store, 'set');
  const canRead = vi.fn(async (id: string) => id === 'conversation');
  const app = new Hono();
  app.route(
    '/',
    createConversationWorkStateRoutes({
      store,
      canRead,
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
  return {
    app,
    store,
    write,
    canRead,
    directory,
    put,
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
    expect(h.write).not.toHaveBeenCalled();
    expect(h.canRead).not.toHaveBeenCalled();
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
});
