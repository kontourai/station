/**
 * The composed runtime's Task-branch auto-claim, end to end: a Project's
 * defaults on, a live Task whose lead is a real conversation, and a forge
 * that lists the Task branch's pull request. The scheduler tick discovers
 * and claims it and reads it in the same tick; the claim then survives the
 * next delivery run and the next tick, because the chat's linked pull
 * requests include the derived link (delivery and the poller release a
 * claim missing from them). Removing it from the chat releases it.
 * Real store file in a temp home, the inbox harness's event store and inbox.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  type PullRequestFeedbackObservation,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  CONVERSATION,
  createInboxHarness,
  OWNER,
} from '../../../routes/orchestration/__tests__/helpers/thread-inbox-harness.js';
import { createConversationPullRequestLinkRoutes } from '../../../routes/pull-requests/conversation-pull-request-links.js';
import {
  PullRequestFeedbackStore,
  pullRequestFeedbackStorePath,
} from '../../../services/pull-requests/pull-request-feedback-store.js';
import {
  composePullRequestFeedbackRuntime,
  pullRequestFeedbackTaskBranchPorts,
} from '../runtime-pull-request-feedback.js';

const BRANCH = 'station/task/t-91';
const PR: PullRequestLinkIdentity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const PR_KEY = pullRequestFeedbackKey(PR);
const PROJECT = {
  id: 'p-1',
  slug: 'widgets',
  createdAt: '2026-01-01T00:00:00.000Z',
  workingDirectory: '/repos/widgets',
};
const station = createInboxHarness();
const tempDir = trackTempDirs();
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function observation(): PullRequestFeedbackObservation {
  return {
    identity: PR,
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'OPEN',
    draft: false,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    headRefName: BRANCH,
    baseRefName: 'main',
    headOwner: 'acme',
    mergeable: 'mergeable',
    checks: [],
    checksTruncated: false,
    threads: [],
    threadsTotal: 0,
    reviews: [],
    observedAt: new Date().toISOString(),
  };
}

async function setup() {
  const world = station();
  const first = await world.send('first', 'open the pull request');
  expect(first.status, await first.clone().text()).toBe(200);
  await vi.waitFor(() =>
    expect(world.inbox.mustQueue(CONVERSATION)).toBe(false),
  );
  const leadSessionId =
    world.service.currentConversationSessionId(CONVERSATION);
  const homeDir = tempDir('pr-feedback-branches-runtime-');
  const store = new PullRequestFeedbackStore(
    pullRequestFeedbackStorePath(homeDir),
  );
  closers.push(() => store.close());
  store.writeProjectDefaults({
    projectId: PROJECT.id,
    projectCreatedAt: PROJECT.createdAt,
    settings: {
      fixFailingChecks: true,
      addressReviewComments: true,
      reviewEachHead: false,
    },
    setBy: OWNER,
    now: '2026-11-16T09:00:00.000Z',
  });
  const reads = { byHead: 0, feedback: 0 };
  const provider = {
    id: 'github',
    canServeHost: (host: string) => host === 'github.com',
    findOpenPullRequestsByHead: async () => {
      reads.byHead += 1;
      return {
        state: 'read',
        pullRequests: [
          {
            ref: '42',
            headRefName: BRANCH,
            headOwner: 'acme',
            crossRepository: false,
            url: 'https://github.com/acme/widgets/pull/42',
          },
        ],
      };
    },
    getFeedbackObservation: async () => {
      reads.feedback += 1;
      return { state: 'observed', observation: observation() };
    },
  } as unknown as IPullRequestProvider;
  const preview = { on: true };
  const runtime = composePullRequestFeedbackRuntime({
    homeDir,
    hosted: false,
    featurePreviews: {
      bind: () => ({
        select: (branches: {
          enabled: () => unknown;
          disabled: () => unknown;
        }) => (preview.on ? branches.enabled() : branches.disabled()),
      }),
    } as never,
    eventStore: world.store,
    inbox: world.inbox,
    orchestration: world.service,
    eventBus: { subscribe: () => () => {} },
    providers: () => [provider],
    links: { list: () => [] } as never,
    keptForSessions: () => [],
    taskBranches: {
      tasks: () => [
        {
          id: 't-91',
          createdAt: '2026-11-16T08:00:00.000Z',
          projectId: PROJECT.id,
          status: 'in_progress',
          sessionId: leadSessionId,
        },
      ],
      project: (idOrSlug) =>
        idOrSlug === PROJECT.id || idOrSlug === PROJECT.slug
          ? PROJECT
          : undefined,
      taskWorktree: () => ({
        mode: 'worktree',
        repoPath: '/repos/widgets',
        path: '/worktrees/t-91',
        branch: BRANCH,
        baseRef: 'main',
        cleanupPolicy: 'cleanup',
        preserveOnFailure: false,
        createdAt: '2026-11-16T08:00:00.000Z',
        owner: { kind: 'task', taskId: 't-91' },
      }),
      repositoryIdentity: async () => 'github.com/acme/widgets',
      canReadProject: async () => true,
    },
    access: {
      current: () => true,
      canRead: () => true,
      operator: () => OWNER,
      readerOf: () => () => true,
    },
    logger: { warn: vi.fn() },
  })!;
  closers.push(() => runtime.close());
  const signal = new AbortController().signal;
  /** Tick until `done` holds: a tick in flight makes the next a no-op. */
  const tickUntil = (now: number, done: () => void) =>
    vi.waitFor(() => {
      runtime.tick({ now, signal });
      done();
    });
  return { runtime, store, reads, preview, tickUntil };
}

describe('the composed Task-branch auto-claim', () => {
  it('survives the next delivery run and the next tick', async () => {
    const t = await setup();
    const start = Date.now();
    await t.tickUntil(start, () => expect(t.reads.feedback).toBe(1));
    expect(t.reads.byHead).toBe(1);
    expect(t.store.claim(PR_KEY)).toMatchObject({
      conversationId: CONVERSATION,
      enabledBy: OWNER,
      origin: 'project-default',
      settings: { fixFailingChecks: true, addressReviewComments: true },
    });
    expect(t.runtime.derivedLinks(CONVERSATION)).toMatchObject([
      { ...PR, source: 'branch-derived' },
    ]);

    await t.runtime.routeArgs[1]()!.deliver(CONVERSATION);
    // Past the claim's next due time: the next tick reads it again.
    await t.tickUntil(start + 60 * 60_000, () =>
      expect(t.reads.feedback).toBe(2),
    );
    expect(t.store.claim(PR_KEY)?.settings).toEqual({
      fixFailingChecks: true,
      addressReviewComments: true,
      reviewEachHead: false,
    });
    // The Task already has its derived link: not listed again.
    expect(t.reads.byHead).toBe(1);
  });

  it('Remove from this chat releases the claim and keeps the pull request out', async () => {
    const t = await setup();
    await t.tickUntil(Date.now(), () => expect(t.reads.feedback).toBe(1));
    // What the DELETE route calls once its writer rule passes.
    const ports = t.runtime.routeArgs[4]!;
    expect(ports.taskBranches.dismiss(CONVERSATION, PR)).toBe(true);
    ports.dismissed(CONVERSATION);
    expect(t.runtime.derivedLinks(CONVERSATION)).toEqual([]);
    await vi.waitFor(() =>
      expect(t.store.claim(PR_KEY)?.settings).toEqual({
        fixFailingChecks: false,
        addressReviewComments: false,
        reviewEachHead: false,
      }),
    );
  });

  it('shows no derived links while the preview is off', async () => {
    const t = await setup();
    await t.tickUntil(Date.now(), () => expect(t.reads.feedback).toBe(1));
    t.preview.on = false;
    expect(t.runtime.derivedLinks(CONVERSATION)).toEqual([]);
  });

  it("a preview read that throws never fails the chat's pull request list", async () => {
    const world = station();
    const warn = vi.fn();
    const runtime = composePullRequestFeedbackRuntime({
      homeDir: tempDir('pr-feedback-branches-soft-'),
      hosted: false,
      featurePreviews: {
        bind: () => ({
          select: () => {
            throw new Error('preview registry unavailable');
          },
        }),
      } as never,
      eventStore: world.store,
      inbox: world.inbox,
      orchestration: world.service,
      eventBus: { subscribe: () => () => {} },
      providers: () => [],
      links: { list: () => [] } as never,
      keptForSessions: () => [],
      taskBranches: {
        tasks: () => [],
        project: () => undefined,
        taskWorktree: () => undefined,
        repositoryIdentity: async () => '',
        canReadProject: async () => true,
      },
      access: {
        current: () => true,
        canRead: () => true,
        operator: () => OWNER,
        readerOf: () => () => true,
      },
      logger: { warn },
    })!;
    closers.push(() => runtime.close());
    expect(runtime.derivedLinks(CONVERSATION)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Task-branch pull requests not read',
      expect.objectContaining({ error: 'preview registry unavailable' }),
    );
    const explicit = { ...PR, source: 'explicit' as const };
    const declared = { ...PR, ref: '43', source: 'task-declared' as const };
    const app = new Hono().route(
      '/api/conversation-pull-requests',
      createConversationPullRequestLinkRoutes(
        { list: () => [explicit] } as never,
        () => [],
        {
          current: () => true,
          canRead: () => true,
          operator: () => OWNER,
          declared: async () => [declared],
          derived: (id) => runtime.derivedLinks(id),
        },
      ),
    );
    const response = await app.request(
      `/api/conversation-pull-requests/${encodeURIComponent(CONVERSATION)}`,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      data: { links: Array<{ ref: string; source: string }> };
    };
    expect(body.data.links.map((link) => [link.ref, link.source])).toEqual([
      ['42', 'explicit'],
      ['43', 'task-declared'],
    ]);
  });

  it("reads a Project's `~/` folder as the host user's, by id or by slug", () => {
    const ports = pullRequestFeedbackTaskBranchPorts({
      taskGraph: { listTasks: () => [], readTaskWorktree: () => undefined },
      projects: {
        listProjects: () => [{ id: 'p-1', slug: 'widgets' }],
        getProject: () => ({
          ...PROJECT,
          workingDirectory: '~/repos/widgets',
        }),
      },
      eventStore: undefined,
      canReadProject: async () => true,
    });
    const expected = join(homedir(), 'repos', 'widgets');
    expect(ports.project('p-1')?.workingDirectory).toBe(expected);
    expect(ports.project('widgets')?.workingDirectory).toBe(expected);
    expect(ports.project('nope')).toBeUndefined();
  });
});
