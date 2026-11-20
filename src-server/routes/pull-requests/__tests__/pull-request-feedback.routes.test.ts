/**
 * `/api/pull-request-feedback`: a person turns feedback on; Station's own
 * internal principal (an agent's tool call) and a delegation credential are
 * refused before anything is written; another chat's claim answers 409 with
 * the owner; the off preview answers 404; and the pairing table puts reads
 * at orchestration:read and writes at access:manage.
 */
import { join } from 'node:path';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  findUnclassifiedRuntimeHttpRoutes,
  requiredPairingScope,
} from '../../../security/pairing-route-scopes.js';
import { PullRequestFeedbackDelivery } from '../../../services/pull-requests/pull-request-feedback-delivery.js';
import { PullRequestFeedbackOwnership } from '../../../services/pull-requests/pull-request-feedback-ownership.js';
import { PullRequestFeedbackStore } from '../../../services/pull-requests/pull-request-feedback-store.js';
import { createPullRequestFeedbackRoutes } from '../pull-request-feedback.js';

const PR: PullRequestLinkIdentity = {
  provider: 'github',
  host: 'GitHub.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const tempDir = trackTempDirs();
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup() {
  const store = new PullRequestFeedbackStore(
    join(tempDir('pr-feedback-routes-'), 'pull-request-feedback.sqlite'),
  );
  closers.push(() => store.close());
  const state = { enabled: true, person: true, mayContinue: true };
  const ownership = new PullRequestFeedbackOwnership({
    store: () => store,
    readStore: () => store,
    linkedIdentities: async () => [{ ...PR, host: 'github.com' }],
    session: () => ({ state: 'idle', ownerUserId: 'owner' }),
    mayContinue: () => true,
    title: () => 'Other chat',
  });
  const delivery = new PullRequestFeedbackDelivery({
    store: () => store,
    enabled: () => state.enabled,
    session: () => ({ state: 'idle', ownerUserId: 'owner' }),
    mayContinue: () => true,
    turnWindows: () => [],
    inbox: () => undefined,
    logger: { warn: vi.fn() },
  });
  const refreshed: string[] = [];
  const app = new Hono().route(
    '/api/pull-request-feedback',
    createPullRequestFeedbackRoutes(
      ownership,
      () => delivery,
      (id) => refreshed.push(id),
      {
        enabled: () => state.enabled,
        current: () => true,
        canRead: () => true,
        operator: () => 'owner',
        readerOf: () => () => true,
        isPerson: () => state.person,
        mayContinue: () => state.mayContinue,
      },
    ),
  );
  const put = (conversationId: string, body: Record<string, unknown>) =>
    app.request(`/api/pull-request-feedback/conversations/${conversationId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const on = {
    identity: PR,
    settings: { fixFailingChecks: true, addressReviewComments: true },
  };
  return { store, state, app, put, on, refreshed };
}

describe('pull request feedback routes', () => {
  it("an agent's request (internal principal or delegation) cannot turn its own feedback on", async () => {
    const t = setup();
    t.state.person = false;
    expect((await t.put('chat-a', t.on)).status).toBe(404);
    expect(t.store.allClaims()).toEqual([]);
    // Nor send again or turn it off.
    for (const [method, path] of [
      ['POST', 'chat-a/send-again'],
      ['DELETE', 'chat-a'],
    ] as const)
      expect(
        (
          await t.app.request(
            `/api/pull-request-feedback/conversations/${path}`,
            {
              method,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ identity: PR }),
            },
          )
        ).status,
      ).toBe(404);
    t.state.person = true;
    const response = await t.put('chat-a', t.on);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(t.store.allClaims()).toMatchObject([
      { conversationId: 'chat-a', enabledBy: 'owner' },
    ]);
    // Turning it on reads the pull request now, not at the next tick.
    expect(t.refreshed).toEqual(['chat-a']);
  });

  it('another chat gets 409 naming the owner, and moves it with move: true', async () => {
    const t = setup();
    expect((await t.put('chat-a', t.on)).status).toBe(200);
    const refused = await t.put('chat-b', t.on);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: 'pull_request_feedback_owned_elsewhere',
      details: { owner: { conversationId: 'chat-a', title: 'Other chat' } },
    });
    const moved = await t.put('chat-b', { ...t.on, move: true });
    expect(moved.status).toBe(200);
    expect(t.store.allClaims()).toMatchObject([
      { conversationId: 'chat-b', generation: 2 },
    ]);
  });

  it('send again on a pull request that is not paused answers 409', async () => {
    const t = setup();
    expect((await t.put('chat-a', t.on)).status).toBe(200);
    const response = await t.app.request(
      '/api/pull-request-feedback/conversations/chat-a/send-again',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identity: PR }),
      },
    );
    expect(response.status).toBe(409);
  });

  it('send again, like every write, needs a person who may continue the chat (one rule with viewerMayChange)', async () => {
    const t = setup();
    expect((await t.put('chat-a', t.on)).status).toBe(200);
    const prKey = t.store.allClaims()[0]!.prKey;
    t.store.setCondition(prKey, {
      state: 'paused',
      reason: 'round-limit',
      cap: 'head',
      headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      at: '2026-11-16T09:00:00.000Z',
    });
    const sendAgain = () =>
      t.app.request(
        '/api/pull-request-feedback/conversations/chat-a/send-again',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ identity: PR }),
        },
      );
    const mayChange = async () =>
      (
        await readJson<{ data: { viewerMayChange: boolean } }>(
          await t.app.request(
            '/api/pull-request-feedback/conversations/chat-a',
          ),
        )
      ).data.viewerMayChange;
    expect(await mayChange()).toBe(true);
    t.state.mayContinue = false;
    expect(await mayChange()).toBe(false);
    expect((await sendAgain()).status).toBe(404);
    expect(t.store.claim(prKey)?.condition).toMatchObject({ state: 'paused' });
    t.state.mayContinue = true;
    t.state.person = false;
    expect(await mayChange()).toBe(false);
    t.state.person = true;
    expect(await mayChange()).toBe(true);
    expect((await sendAgain()).status).toBe(200);
    expect(t.store.claim(prKey)?.condition).toBeUndefined();
  });

  it('answers 404 while the preview is off', async () => {
    const t = setup();
    t.state.enabled = false;
    expect(
      (await t.app.request('/api/pull-request-feedback/conversations/chat-a'))
        .status,
    ).toBe(404);
    expect((await t.put('chat-a', t.on)).status).toBe(404);
    // A malformed body too: the preview is checked before the body.
    expect((await t.put('chat-a', { nonsense: true })).status).toBe(404);
    expect(
      (
        await t.app.request(
          '/api/pull-request-feedback/conversations/chat-a/send-again',
          { method: 'POST', body: 'not json' },
        )
      ).status,
    ).toBe(404);
  });

  it('a body with unknown settings is refused', async () => {
    const t = setup();
    expect(
      (
        await t.put('chat-a', {
          identity: PR,
          settings: {
            fixFailingChecks: true,
            addressReviewComments: true,
            merge: true,
          },
        })
      ).status,
    ).toBe(400);
    expect(t.store.allClaims()).toEqual([]);
  });

  it('pairing scopes: reading is a conversation read, every write is access management', () => {
    const path = '/api/pull-request-feedback/conversations/chat-a';
    expect(requiredPairingScope('GET', path)).toBe('orchestration:read');
    expect(requiredPairingScope('PUT', path)).toBe('access:manage');
    expect(requiredPairingScope('DELETE', path)).toBe('access:manage');
    expect(requiredPairingScope('POST', `${path}/send-again`)).toBe(
      'access:manage',
    );
  });

  it('registers only routes the pairing table classifies (the runtime refuses to start otherwise)', () => {
    const t = setup();
    expect(findUnclassifiedRuntimeHttpRoutes(t.app.routes)).toEqual([]);
  });
});
