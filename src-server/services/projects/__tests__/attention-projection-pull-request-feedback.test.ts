/**
 * Pull request agent feedback in Needs you: the composed feedback runtime
 * over a real store file reads what needs a person, and the real attention
 * projection keeps it only for a Session the reader may read (the inbox
 * harness's real OrchestrationService), with `updatedAt` from the pause so an
 * acknowledgement holds until the next one (a real acknowledgement file).
 */

import { isAcknowledgeableAttentionKind } from '@kontourai/station-contracts/attention';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import { pullRequestFeedbackKey } from '@kontourai/station-contracts/pull-request-feedback';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  CONVERSATION,
  createInboxHarness,
  eventually,
  OWNER,
  STRANGER,
} from '../../../routes/orchestration/__tests__/helpers/thread-inbox-harness.js';
import { createAttentionRoutes } from '../../../routes/orchestration/attention.js';
import { runtimeAttentionRouteOptions } from '../../../runtime/routes/runtime-attention-route-options.js';
import { composePullRequestFeedbackRuntime } from '../../../runtime/routes/runtime-pull-request-feedback.js';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { FileConversationAcknowledgementStore } from '../../orchestration/conversation-acknowledgement-store.js';
import {
  PullRequestFeedbackStore,
  pullRequestFeedbackStorePath,
} from '../../pull-requests/pull-request-feedback-store.js';
import { AttentionProjectionService } from '../attention-projection.js';

const PR: PullRequestLinkIdentity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const PR_KEY = pullRequestFeedbackKey(PR);
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PAUSED_AT = '2026-11-16T09:00:00.000Z';
const station = createInboxHarness();
const tempDir = trackTempDirs();
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const authority = (userId: string) =>
  sessionReadAuthorityFromRequest(userId, undefined, undefined);

async function setup() {
  const world = station();
  const first = await world.send('first', 'open the pull request');
  expect(first.status, await first.clone().text()).toBe(200);
  await eventually(() =>
    expect(world.inbox.mustQueue(CONVERSATION)).toBe(false),
  );
  const homeDir = tempDir('pr-feedback-attention-');
  const store = new PullRequestFeedbackStore(
    pullRequestFeedbackStorePath(homeDir),
  );
  closers.push(() => store.close());
  store.writeClaim({
    prKey: PR_KEY,
    identity: PR,
    conversationId: CONVERSATION,
    settings: {
      fixFailingChecks: true,
      addressReviewComments: false,
      reviewEachHead: false,
    },
    enabledBy: OWNER,
    now: '2026-11-16T08:00:00.000Z',
  });
  const runtime = composePullRequestFeedbackRuntime({
    homeDir,
    hosted: false,
    featurePreviews: {
      bind: () => ({
        select: (branches: { enabled: () => unknown }) => branches.enabled(),
      }),
    } as never,
    eventStore: world.store,
    inbox: world.inbox,
    orchestration: world.service,
    eventBus: { subscribe: () => () => {} },
    providers: () => [],
    links: { list: () => [PR] } as never,
    keptForSessions: () => [],
    access: {
      current: () => true,
      canRead: () => true,
      operator: () => OWNER,
      readerOf: () => () => true,
    },
    logger: { warn: vi.fn() },
  })!;
  closers.push(() => runtime.close());
  const projection = new AttentionProjectionService(
    { list: async () => [] },
    world.service,
    { getRunConsole: async () => ({ gates: [] }) } as never,
    undefined,
    new FileConversationAcknowledgementStore(tempDir('pr-feedback-ack-')),
    () => OWNER,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { pullRequestFeedback: runtime },
  );
  const feedbackItems = async (userId: string) =>
    (
      await projection.list(authority(userId), {
        mayChangePullRequestFeedback: (conversationId) =>
          conversationId === CONVERSATION,
      })
    ).items.filter((item) => item.kind === 'pull-request-feedback');
  const pause = (at: string) =>
    store.setCondition(PR_KEY, {
      state: 'paused',
      reason: 'round-limit',
      cap: 'head',
      headSha: HEAD,
      failing: ['ci / unit-tests', 'security/scan', 'lint'],
      rounds: 3,
      at,
    });
  return { world, store, runtime, projection, feedbackItems, pause };
}

describe('pull request feedback that needs a person', () => {
  it('(a) projects a pause with its exact title, body and actions, dated by the pause', async () => {
    const t = await setup();
    expect(await t.feedbackItems(OWNER)).toEqual([]);
    t.pause(PAUSED_AT);
    const sessionId =
      t.world.service.currentConversationSessionId(CONVERSATION);
    expect(await t.feedbackItems(OWNER)).toEqual([
      {
        id: expect.stringMatching(/^pull-request-feedback:[0-9a-f]{16}$/),
        kind: 'pull-request-feedback',
        title: '#42 still failing after 3 rounds',
        body: 'ci / unit-tests, security/scan and 1 more failed on a1b2c3d. Auto-fix is paused.',
        createdAt: PAUSED_AT,
        updatedAt: PAUSED_AT,
        sessionId,
        source: { conversationId: CONVERSATION, identity: PR },
        reason: 'round-limit',
        cap: 'head',
        headSha: HEAD,
        failing: ['ci / unit-tests', 'security/scan', 'lint'],
        openHref: expect.stringContaining(encodeURIComponent(sessionId)),
        viewerMayChange: true,
      },
    ]);
  });

  it('(b) a reader who may not read the chat is shown nothing', async () => {
    const t = await setup();
    t.pause(PAUSED_AT);
    expect(await t.feedbackItems(OWNER)).toHaveLength(1);
    expect(await t.feedbackItems(STRANGER)).toEqual([]);
  });

  it('(c, d) an acknowledgement holds until the next pause', async () => {
    const t = await setup();
    t.pause(PAUSED_AT);
    const [item] = await t.feedbackItems(OWNER);
    expect(isAcknowledgeableAttentionKind('pull-request-feedback')).toBe(true);
    expect(await t.projection.acknowledge(item!.id, authority(OWNER))).toBe(
      true,
    );
    const read = await t.projection.list(authority(OWNER));
    expect(
      read.items.find((candidate) => candidate.id === item!.id),
    ).toMatchObject({ acknowledgedAt: PAUSED_AT });
    expect(read.pendingCount).toBe(
      read.items.filter((candidate) => !candidate.acknowledgedAt).length,
    );
    // Read again later: still acknowledged (the version is the pause's).
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await t.feedbackItems(OWNER))[0]?.acknowledgedAt).toBe(PAUSED_AT);
    // A new pause is a new version: it needs the person again.
    t.pause('2026-11-16T10:00:00.000Z');
    const [again] = await t.feedbackItems(OWNER);
    expect(again?.id).toBe(item!.id);
    expect(again?.acknowledgedAt).toBeUndefined();
  });

  it('an agent that stopped with feedback waiting: Needs you says what was not sent', async () => {
    const t = await setup();
    t.store.writeObservation(PR_KEY, {
      observation: {
        identity: PR,
        url: 'https://github.com/acme/widgets/pull/42',
        state: 'OPEN',
        draft: false,
        headSha: HEAD,
        baseSha: 'b'.repeat(40),
        headRefName: 'feature',
        baseRefName: 'main',
        mergeable: 'mergeable',
        checks: [],
        checksTruncated: false,
        threads: [],
        threadsTotal: 0,
        reviews: [],
        observedAt: '2026-11-16T08:30:00.000Z',
      },
      observedAt: '2026-11-16T08:30:00.000Z',
      unchangedSince: '2026-11-16T08:30:00.000Z',
      digest: 'd',
    });
    t.store.recordDelivery({
      id: 'waiting-1',
      prKey: PR_KEY,
      conversationId: CONVERSATION,
      headSha: HEAD,
      category: 'failing-checks',
      signature: 's1',
      summary: { count: 2, failing: ['ci / unit-tests', 'lint'] },
      now: '2026-11-16T08:31:00.000Z',
    });
    // Not stopped: nothing needs the person yet.
    expect(await t.feedbackItems(OWNER)).toEqual([]);
    // The agent's next turn is cancelled: the chat's agent has stopped.
    t.world.adapter.holdTurns = true;
    const second = await t.world.send('second', 'keep going');
    expect(second.status, await second.clone().text()).toBe(200);
    await eventually(() => expect(t.world.adapter.turns).toHaveLength(2));
    const sessionId =
      t.world.service.currentConversationSessionId(CONVERSATION);
    const turn = t.world.adapter.turns[1]!;
    t.world.adapter.events.push({
      eventId: 'inbox-turn-2:aborted',
      provider: 'claude',
      method: 'turn.aborted',
      threadId: sessionId,
      turnId: 'inbox-turn-2',
      invocationId: turn.invocationId,
      createdAt: new Date().toISOString(),
      reason: 'cancelled',
    } as unknown as CanonicalRuntimeEvent);
    await eventually(async () =>
      expect(await t.feedbackItems(OWNER)).toHaveLength(1),
    );
    expect((await t.feedbackItems(OWNER))[0]).toMatchObject({
      title: '#42 has feedback waiting',
      body: 'Its agent stopped, so 2 failing checks were not sent.',
      reason: 'agent-stopped',
      waiting: 2,
      createdAt: '2026-11-16T08:31:00.000Z',
      updatedAt: '2026-11-16T08:31:00.000Z',
      pullRequestUrl: 'https://github.com/acme/widgets/pull/42',
    });
  });

  it('the HTTP seam says who may change it: the operator in person may, an agent or a delegation may not', async () => {
    const t = await setup();
    t.pause(PAUSED_AT);
    const asCaller = async (
      principal: RuntimeAuthenticatedRequestPrincipal,
    ) => {
      const app = new Hono();
      app.use('*', async (c, next) => {
        setRuntimeAuthenticatedRequestPrincipal(c.req.raw, principal);
        await next();
      });
      app.route(
        '/api/attention',
        createAttentionRoutes(
          t.projection,
          runtimeAttentionRouteOptions({
            readAuthorityForRequest: () => authority(OWNER),
            resolvePrincipal: () => ({ id: OWNER }),
            security: {
              authorizeCredential: () => true,
              verifyOperatorCredential: () => true,
              credentialMayDecidePairingRequests: () => false,
              resolveGrantedScope: () => undefined,
            } as never,
            stationControlDispatchScope: undefined,
            pullRequestFeedback: t.runtime,
          }),
        ),
      );
      const response = await app.request('/api/attention');
      const body = (await response.json()) as {
        data: { items: Array<{ kind: string; viewerMayChange?: boolean }> };
      };
      return body.data.items.find(
        (item) => item.kind === 'pull-request-feedback',
      )?.viewerMayChange;
    };
    expect(
      await asCaller({
        kind: 'credential',
        credential: 'operator-secret',
        authority: 'operator-credential',
        source: 'bearer',
      }),
    ).toBe(true);
    expect(
      await asCaller({
        kind: 'internal',
        credential: 'internal',
        authority: undefined,
        source: 'bearer',
      }),
    ).toBe(false);
    expect(
      await asCaller({
        kind: 'credential',
        credential: 'peer',
        authority: 'device-credential',
        deviceId: 'peer-station',
        deviceKind: 'delegation',
        source: 'bearer',
      } as RuntimeAuthenticatedRequestPrincipal),
    ).toBe(false);
  });
});
