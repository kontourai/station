/**
 * `GET /api/pull-request-feedback/by-pull-request`: one pull request's
 * feedback whichever chat is open. A reader of the owning chat sees its
 * title, status and the checks sent on the observed head; anyone else sees
 * only `{ readable: false }`. The preview off answers 404. And the 409 on
 * turning feedback on elsewhere names the owner only to a reader of it.
 * Real store file and ownership; access stubs stand in for the runtime.
 */
import { join } from 'node:path';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  type PullRequestFeedbackObservation,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import { PullRequestFeedbackDelivery } from '../../../services/pull-requests/pull-request-feedback-delivery.js';
import { PullRequestFeedbackOwnership } from '../../../services/pull-requests/pull-request-feedback-ownership.js';
import { PullRequestFeedbackStore } from '../../../services/pull-requests/pull-request-feedback-store.js';
import { createPullRequestFeedbackRoutes } from '../pull-request-feedback.js';

const PR: PullRequestLinkIdentity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const PR_KEY = pullRequestFeedbackKey(PR);
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OLD_HEAD = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';
const UNIT = 'ci / unit-tests';
const UNIT_URL = 'https://github.com/acme/widgets/actions/runs/1/job/2';
const SENT_AT = '2026-11-10T12:05:00.000Z';
const QUERY =
  '/api/pull-request-feedback/by-pull-request?provider=github&host=GitHub.com&owner=acme&name=widgets&ref=42';

const tempDir = trackTempDirs();
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function observation(headSha: string): PullRequestFeedbackObservation {
  return {
    identity: PR,
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'OPEN',
    draft: false,
    headSha,
    baseSha: 'b'.repeat(40),
    headRefName: 'feature',
    baseRefName: 'main',
    mergeable: 'mergeable',
    checks: [
      {
        name: UNIT,
        conclusion: 'FAILURE',
        completed: true,
        required: true,
        url: UNIT_URL,
      },
      { name: 'lint', conclusion: 'FAILURE', completed: true, required: true },
    ],
    checksTruncated: false,
    threads: [],
    threadsTotal: 0,
    reviews: [],
    observedAt: '2026-11-10T12:00:00.000Z',
  };
}

/** A failing-checks message the inbox placed, through the store's own path. */
function sent(
  store: PullRequestFeedbackStore,
  headSha: string,
  failing: string[],
  at: string,
) {
  const delivery = store.recordDelivery({
    id: `d-${headSha}-${failing.join()}`,
    prKey: PR_KEY,
    conversationId: 'chat-a',
    headSha,
    category: 'failing-checks',
    signature: `${headSha}:${failing.join()}`,
    summary: { count: failing.length, failing },
    now: at,
  });
  const key = `prf-${headSha}-${failing.join()}`;
  store.beginBatch(
    {
      key,
      conversationId: 'chat-a',
      generation: 1,
      state: 'submitting',
      message: 'feedback',
      actor: { userId: 'owner' },
      createdAt: at,
      summary: [
        {
          prKey: PR_KEY,
          headSha,
          generation: 1,
          categories: [{ category: 'failing-checks', count: failing.length }],
        },
      ],
    },
    [delivery.id],
  );
  store.settleBatch(key, 'sent', at);
}

function setup() {
  const store = new PullRequestFeedbackStore(
    join(tempDir('pr-feedback-by-pr-'), 'pull-request-feedback.sqlite'),
  );
  closers.push(() => store.close());
  const state = { enabled: true, current: true, reads: new Set(['chat-a']) };
  const ownership = new PullRequestFeedbackOwnership({
    store: () => store,
    readStore: () => store,
    linkedIdentities: async () => [PR],
    session: () => ({ state: 'idle', ownerUserId: 'owner' }),
    mayContinue: () => true,
    title: (id) => (id === 'chat-a' ? 'Fix the parser' : undefined),
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
  const app = new Hono().route(
    '/api/pull-request-feedback',
    createPullRequestFeedbackRoutes(ownership, () => delivery, vi.fn(), {
      enabled: () => state.enabled,
      current: () => state.current,
      // chat-b is the reader's own chat; chat-a only when allowed.
      canRead: (_request, id) => id === 'chat-b' || state.reads.has(id),
      operator: () => 'owner',
      readerOf: () => (id) => id === 'chat-b' || state.reads.has(id),
      isPerson: () => true,
      mayContinue: () => true,
    }),
  );
  store.writeClaim({
    prKey: PR_KEY,
    identity: PR,
    conversationId: 'chat-a',
    settings: {
      fixFailingChecks: true,
      addressReviewComments: false,
      reviewEachHead: false,
    },
    enabledBy: 'owner',
    now: '2026-11-10T12:00:00.000Z',
  });
  const get = async () => {
    const response = await app.request(QUERY);
    return { status: response.status, body: (await response.json()) as any };
  };
  return { store, state, app, get };
}

describe('pull request feedback by pull request', () => {
  it('a reader of the owning chat gets its title, status and the checks sent on the observed head', async () => {
    const t = setup();
    sent(t.store, OLD_HEAD, ['lint'], '2026-11-10T11:00:00.000Z');
    sent(t.store, HEAD, [UNIT], SENT_AT);
    t.store.writeObservation(PR_KEY, {
      observation: observation(HEAD),
      observedAt: '2026-11-10T12:00:00.000Z',
      unchangedSince: '2026-11-10T12:00:00.000Z',
      digest: 'd',
    });
    const { status, body } = await t.get();
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      identity: PR,
      owner: {
        readable: true,
        conversationId: 'chat-a',
        title: 'Fix the parser',
      },
      status: { state: 'watching' },
      settings: { fixFailingChecks: true },
      last: { state: 'sent', headSha: HEAD, at: SENT_AT },
    });
    // Only the observed head's sends, with the observation's link: lint
    // went about an earlier push and says nothing about this one.
    expect(body.data.sentChecks).toEqual({
      headSha: HEAD,
      checks: [{ name: UNIT, url: UNIT_URL, at: SENT_AT }],
    });
  });

  it('a send about an earlier push is not the last send: the head moved on', async () => {
    const t = setup();
    sent(t.store, OLD_HEAD, ['lint'], '2026-11-10T11:00:00.000Z');
    t.store.writeObservation(PR_KEY, {
      observation: observation(HEAD),
      observedAt: '2026-11-10T12:00:00.000Z',
      unchangedSince: '2026-11-10T12:00:00.000Z',
      digest: 'd',
    });
    const { body } = await t.get();
    expect(body.data).toMatchObject({
      owner: { readable: true },
      status: { state: 'watching' },
    });
    expect(body.data).not.toHaveProperty('last');
    expect(body.data).not.toHaveProperty('sentChecks');
  });

  it('a reader who may not read the owning chat gets exactly { readable: false }', async () => {
    const t = setup();
    t.state.reads.clear();
    sent(t.store, HEAD, [UNIT], SENT_AT);
    t.store.writeObservation(PR_KEY, {
      observation: observation(HEAD),
      observedAt: '2026-11-10T12:00:00.000Z',
      unchangedSince: '2026-11-10T12:00:00.000Z',
      digest: 'd',
    });
    const { status, body } = await t.get();
    expect(status).toBe(200);
    expect(body.data).toEqual({ identity: PR, owner: { readable: false } });
    expect(JSON.stringify(body)).not.toContain('chat-a');
  });

  it('no chat gets it: owner null, and nothing else', async () => {
    const t = setup();
    t.store.releaseClaim(PR_KEY, '2026-11-10T12:10:00.000Z');
    expect((await t.get()).body.data).toEqual({ identity: PR, owner: null });
  });

  it('answers 404 while the preview is off or the requester lost standing, and 400 for a malformed identity', async () => {
    const t = setup();
    t.state.enabled = false;
    expect((await t.get()).status).toBe(404);
    t.state.enabled = true;
    t.state.current = false;
    expect((await t.get()).status).toBe(404);
    t.state.current = true;
    const bad = await t.app.request(
      '/api/pull-request-feedback/by-pull-request?provider=github&host=github.com&owner=acme&name=widgets&ref=x',
    );
    expect(bad.status).toBe(400);
  });

  it('is a conversation read for pairing', () => {
    expect(
      requiredPairingScope('GET', '/api/pull-request-feedback/by-pull-request'),
    ).toBe('orchestration:read');
  });

  it('the 409 on turning it on elsewhere names the owner only to a reader of it', async () => {
    const t = setup();
    t.state.reads.clear();
    const refused = await t.app.request(
      '/api/pull-request-feedback/conversations/chat-b',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identity: PR,
          settings: { fixFailingChecks: true, addressReviewComments: false },
        }),
      },
    );
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as any;
    expect(body).toMatchObject({
      code: 'pull_request_feedback_owned_elsewhere',
      error: 'Feedback for this pull request goes to another chat.',
      details: { owner: {} },
    });
    expect(JSON.stringify(body)).not.toContain('chat-a');
  });
});
