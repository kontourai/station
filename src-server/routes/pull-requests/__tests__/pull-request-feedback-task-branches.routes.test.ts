/**
 * Project defaults and "Remove from this chat" on `/api/pull-request-feedback`:
 * only this Station's owner in person may set the defaults (Station's own
 * internal principal and a delegation credential are refused before
 * anything is written, and so is another reader of the Project, who sees
 * them read-only); a reader the Project refuses gets 404; the off preview
 * answers 404; a removed derived link is gone for good; and every route is
 * one the pairing table classifies.
 */
import { join } from 'node:path';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import { pullRequestFeedbackKey } from '@kontourai/station-contracts/pull-request-feedback';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  findUnclassifiedRuntimeHttpRoutes,
  requiredPairingScope,
} from '../../../security/pairing-route-scopes.js';
import { PullRequestFeedbackDelivery } from '../../../services/pull-requests/pull-request-feedback-delivery.js';
import { PullRequestFeedbackOwnership } from '../../../services/pull-requests/pull-request-feedback-ownership.js';
import { PullRequestFeedbackStore } from '../../../services/pull-requests/pull-request-feedback-store.js';
import { PullRequestFeedbackTaskBranches } from '../../../services/pull-requests/pull-request-feedback-task-branches.js';
import { createPullRequestFeedbackRoutes } from '../pull-request-feedback.js';

const PR: PullRequestLinkIdentity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const PROJECT = {
  id: 'p-1',
  slug: 'widgets',
  createdAt: '2026-01-01T00:00:00.000Z',
  workingDirectory: '/repos/widgets',
};
const tempDir = trackTempDirs();
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup() {
  const store = new PullRequestFeedbackStore(
    join(
      tempDir('pr-feedback-defaults-routes-'),
      'pull-request-feedback.sqlite',
    ),
  );
  closers.push(() => store.close());
  const state = {
    enabled: true,
    person: true,
    operator: 'owner' as string | undefined,
    projectReadable: true,
    mayContinue: true,
    unreadable: [] as string[],
  };
  const ownership = new PullRequestFeedbackOwnership({
    store: () => store,
    readStore: () => store,
    linkedIdentities: async () => [],
    session: () => ({ state: 'idle', ownerUserId: 'owner' }),
    mayContinue: () => true,
    title: () => 'Lead chat',
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
  const taskBranches = new PullRequestFeedbackTaskBranches({
    enabled: () => state.enabled,
    store: () => store,
    readStore: () => store,
    tasks: () => [],
    project: (idOrSlug) =>
      idOrSlug === PROJECT.id || idOrSlug === PROJECT.slug
        ? PROJECT
        : undefined,
    taskWorktree: () => undefined,
    repositoryIdentity: async () => 'github.com/acme/widgets',
    providers: () => [],
    conversationOf: (id) => id,
    session: () => ({ state: 'idle' }),
    mayContinue: () => true,
    logger: { warn: vi.fn() },
  });
  const dismissed: string[] = [];
  const app = new Hono().route(
    '/api/pull-request-feedback',
    createPullRequestFeedbackRoutes(
      ownership,
      () => delivery,
      () => {},
      {
        enabled: () => state.enabled,
        current: () => true,
        canRead: () => true,
        operator: () => state.operator,
        readerOf: () => (id) => !state.unreadable.includes(id),
        isPerson: () => state.person,
        mayContinue: () => state.mayContinue,
      },
      {
        taskBranches,
        canReadProject: async () => state.projectReadable,
        dismissed: (id) => dismissed.push(id),
      },
    ),
  );
  const request = (method: string, path: string, body?: unknown) =>
    app.request(`/api/pull-request-feedback/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const on = {
    settings: { fixFailingChecks: true, addressReviewComments: false },
  };
  const stored = () =>
    store.projectDefaults(PROJECT.id, PROJECT.createdAt)?.settings;
  return { store, state, app, request, on, stored, dismissed };
}

describe('Project defaults routes', () => {
  it("refuses an agent's request (internal principal or delegation) before writing", async () => {
    const t = setup();
    t.state.person = false;
    expect(
      (await t.request('PUT', 'projects/widgets/defaults', t.on)).status,
    ).toBe(404);
    expect(t.stored()).toBeUndefined();
    t.state.person = true;
    const response = await t.request('PUT', 'projects/widgets/defaults', t.on);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        projectSlug: 'widgets',
        settings: { fixFailingChecks: true, addressReviewComments: false },
        canChange: true,
        stillOn: 0,
      },
    });
    expect(
      t.store.projectDefaults(PROJECT.id, PROJECT.createdAt),
    ).toMatchObject({ setBy: 'owner' });
  });

  it("another reader of the Project sees them and can't change them", async () => {
    const t = setup();
    t.state.operator = undefined;
    const read = await t.request('GET', 'projects/widgets/defaults');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      data: {
        canChange: false,
        settings: { fixFailingChecks: false, addressReviewComments: false },
      },
    });
    expect(
      (await t.request('PUT', 'projects/widgets/defaults', t.on)).status,
    ).toBe(404);
    expect(t.stored()).toBeUndefined();
  });

  it('a reader the Project refuses, an unknown Project and the off preview all get 404', async () => {
    const t = setup();
    t.state.projectReadable = false;
    expect((await t.request('GET', 'projects/widgets/defaults')).status).toBe(
      404,
    );
    expect(
      (await t.request('PUT', 'projects/widgets/defaults', t.on)).status,
    ).toBe(404);
    t.state.projectReadable = true;
    expect((await t.request('GET', 'projects/p-1/defaults')).status).toBe(404);
    t.state.enabled = false;
    expect((await t.request('GET', 'projects/widgets/defaults')).status).toBe(
      404,
    );
    expect(
      (await t.request('PUT', 'projects/widgets/defaults', { bad: true }))
        .status,
    ).toBe(404);
    expect(t.stored()).toBeUndefined();
  });

  it('removes a derived link from its chat for good, only for a writer of that chat', async () => {
    const t = setup();
    t.store.recordDerivedLink({
      taskId: 't-91',
      taskCreatedAt: '2026-11-16T08:00:00.000Z',
      projectId: PROJECT.id,
      conversationId: 'lead-chat',
      prKey: pullRequestFeedbackKey(PR),
      identity: PR,
      headRef: 'station/task/t-91',
      derivedAt: '2026-11-16T09:00:00.000Z',
    });
    t.state.mayContinue = false;
    expect(
      (
        await t.request('DELETE', 'conversations/lead-chat/derived', {
          identity: PR,
        })
      ).status,
    ).toBe(404);
    expect(t.store.derivedLinks('lead-chat')).toHaveLength(1);
    t.state.mayContinue = true;
    const removed = await t.request(
      'DELETE',
      'conversations/lead-chat/derived',
      {
        identity: { ...PR, host: 'GitHub.com' },
      },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(t.store.derivedLinks('lead-chat')).toEqual([]);
    expect(t.dismissed).toEqual(['lead-chat']);
    // Nothing left to remove.
    expect(
      (
        await t.request('DELETE', 'conversations/lead-chat/derived', {
          identity: PR,
        })
      ).status,
    ).toBe(404);
  });

  it('puts reads at orchestration:read, writes at access:manage, and registers only classified routes', () => {
    const t = setup();
    const defaults = '/api/pull-request-feedback/projects/widgets/defaults';
    expect(requiredPairingScope('GET', defaults)).toBe('orchestration:read');
    expect(requiredPairingScope('PUT', defaults)).toBe('access:manage');
    expect(
      requiredPairingScope(
        'DELETE',
        '/api/pull-request-feedback/conversations/c/derived',
      ),
    ).toBe('access:manage');
    expect(findUnclassifiedRuntimeHttpRoutes(t.app.routes)).toEqual([]);
  });

  it('counts what the defaults still have on only in chats this reader may read', async () => {
    const t = setup();
    expect(
      (await t.request('PUT', 'projects/widgets/defaults', t.on)).status,
    ).toBe(200);
    for (const [ref, chat] of [
      ['42', 'lead-a'],
      ['43', 'lead-b'],
    ] as const) {
      const identity = { ...PR, ref };
      const prKey = pullRequestFeedbackKey(identity);
      t.store.recordDerivedLink({
        taskId: `t-${ref}`,
        taskCreatedAt: '2026-11-16T08:00:00.000Z',
        projectId: PROJECT.id,
        conversationId: chat,
        prKey,
        identity,
        headRef: `station/task/t-${ref}`,
        derivedAt: '2026-11-16T09:00:00.000Z',
      });
      t.store.autoClaim({
        prKey,
        identity,
        taskId: `t-${ref}`,
        conversationId: chat,
        settings: {
          fixFailingChecks: true,
          addressReviewComments: false,
          reviewEachHead: false,
        },
        enabledBy: 'owner',
        now: '2026-11-16T09:00:00.000Z',
      });
    }
    const stillOn = async () =>
      (
        (await (
          await t.request('GET', 'projects/widgets/defaults')
        ).json()) as any
      ).data.stillOn;
    expect(await stillOn()).toBe(2);
    t.state.unreadable = ['lead-b'];
    expect(await stillOn()).toBe(1);
    // The write answers with the same reader's count.
    const written = await t.request('PUT', 'projects/widgets/defaults', t.on);
    expect(((await written.json()) as any).data.stillOn).toBe(1);
  });
});
