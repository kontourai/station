/**
 * #4508 PR1: Task tracker follow-ups, end to end at the service seams.
 *
 * Real: `TaskGraphService` (its store, statuses and the keep ledger the
 * existing keep rule writes), the Feature Preview registry, the follow-up
 * poller, its SQLite store, the gh reader started through the real
 * process-group runner, and the Task brief built through the runtime's own
 * composition (`composeTaskBriefSource`). Only GitHub is a stand-in: a fake
 * `gh` executable answering with sanitized github.com GraphQL answers
 * (`fixtures/fake-gh-graphql.ts`).
 */
import { existsSync } from 'node:fs';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FeaturePreviewRegistry } from '../../feature-previews/feature-preview-registry.js';
import { composeTaskBriefSource } from '../../projects/task-brief-source.js';
import { TaskGraphService } from '../../projects/task-graph-service.js';
import { GhGitHubFollowUpReader } from '../github-follow-up-reader.js';
import {
  composeTaskFollowUpPoller,
  TASK_FOLLOW_UP_PREVIEW_ID,
  type TaskFollowUpPoller,
} from '../task-follow-up-poller.js';
import {
  TaskFollowUpStoreHolder,
  taskFollowUpStorePath,
} from '../task-follow-up-store.js';
import {
  answer,
  calls,
  fixture,
  installFakeGhGraphql,
} from './fixtures/fake-gh-graphql.js';

const temp = trackTempDirs();

const ISSUE = 14882;
const PR = 14804;
const ISSUE_REF = `github:acme/widgets#${ISSUE}`;
const PR_REF = `github:acme/widgets#${PR}`;
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** The cursor of a fixture connection's last edge. */
const last = (page: any, stream: 'comments' | 'reviews'): string =>
  page.data.repository.issueOrPullRequest[stream].edges.at(-1).cursor;

const issuePage1 = fixture('issue-page-1');
const issuePage2 = fixture('issue-page-2');
const prPage1 = fixture('pull-request-page-1');
const prPage2 = fixture('pull-request-page-2');
// Pinned beside the derivation: the cursors are GitHub's own.
const ISSUE_C2 = last(issuePage1, 'comments');
const ISSUE_C3 = last(issuePage2, 'comments');
const PR_C1 = last(prPage1, 'comments');
const PR_R2 = last(prPage1, 'reviews');
const PR_R3 = last(prPage2, 'reviews');
test('fixture cursors are the captured ones', () => {
  expect([ISSUE_C2, ISSUE_C3, PR_C1, PR_R2, PR_R3]).toEqual([
    'Y3Vyc29yOnYyOpHPAAAAAYfx678=',
    'Y3Vyc29yOnYyOpHPAAAAAYhicJ4=',
    'Y3Vyc29yOnYyOpHPAAAAAXvNS2g=',
    'Y3Vyc29yOnYyOpO0MjAyNi0xMC0yM1QxODo0NToyMFq0MjAyNi0xMC0yM1QxODo0MToyMVrPAAAAAU_AK4A=',
    'Y3Vyc29yOnYyOpO0MjAyNi0xMC0yM1QxOToyNzowOFq0MjAyNi0xMC0yM1QxOToyNzowOFrPAAAAAU_HbZs=',
  ]);
  // Page 1 says there is more after its last review: the boundary.
  expect(
    prPage1.data.repository.issueOrPullRequest.reviews.pageInfo.hasNextPage,
  ).toBe(true);
});

let home: string;
let ghDir: string;
let gh: string;
let graph: TaskGraphService;
let registry: FeaturePreviewRegistry;
let holder: TaskFollowUpStoreHolder;
let poller: TaskFollowUpPoller;

/** Answer every read the first poll of the Task makes. */
function answerFirstPoll() {
  answer(ghDir, { number: ISSUE }, issuePage1);
  answer(ghDir, { number: ISSUE, commentsAfter: ISSUE_C2 }, issuePage2);
  answer(ghDir, { number: PR }, prPage1);
  answer(
    ghDir,
    { number: PR, commentsAfter: PR_C1, reviewsAfter: PR_R2 },
    prPage2,
  );
}

/** A Task started from the issue at `createdAt`, the pull request kept on it. */
async function trackerTask(
  createdAt = '2026-10-01T09:00:00.000Z',
  options: { keepPullRequest?: boolean; ref?: string } = {},
): Promise<TaskRecord> {
  vi.setSystemTime(new Date(createdAt));
  const task = await graph.createTask(
    {
      projectId: 'project-alpha',
      title: 'Widgets jam',
      sourceProvider: 'github',
      workItemRef: options.ref ?? ISSUE_REF,
    },
    undefined,
    undefined,
    undefined,
    { workItemProvenance: 'project-board' },
  );
  if (options.keepPullRequest !== false)
    await graph.keepDeclaredPullRequest(
      {
        taskId: task.id,
        operationId: `op-keep-${task.id}`,
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'acme', name: 'widgets' },
        ref: String(PR),
        nativeId: 'PR_kwDOAcmeWidgets14804',
        provenance: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'call-1',
          declarationId: 'declaration-1',
          eventId: `event-${task.id}`,
        },
      },
      { expectedProjectId: 'project-alpha', isAuthorized: () => true },
    );
  return graph.readTask(task.id)!;
}

async function endTask(taskId: string, at: string) {
  vi.setSystemTime(new Date(at));
  await graph.updateTaskStatus(taskId, 'in_progress');
  await graph.updateTaskStatus(taskId, 'done');
}

const enable = () => registry.setEnabled(TASK_FOLLOW_UP_PREVIEW_ID, true);
const poll = (now = NOW) =>
  poller.poll({ now, signal: new AbortController().signal });

/** The brief a Session dispatched for the Task receives, through the runtime composition. */
async function brief(task: TaskRecord): Promise<string> {
  const source = composeTaskBriefSource({
    taskGraph: graph,
    eventStore: undefined,
    readAuthorityForUser: () => {
      throw new Error('no other Session is read');
    },
    localProjectIdFor: () => undefined,
    roomRuntime: () => ({
      readTaskDocumentForBrief: async () => ({
        kind: 'available',
        revision: 'doc-1',
        text: 'Fix the jam.',
      }),
    }),
    workItemObserver: {
      observeWorkItem: async () => ({
        status: 'unavailable',
        reason: 'not read in this test',
      }),
    },
    followUps: holder,
  });
  return (await source.forDispatch(task, 'session-brief', 'owner-1')).brief
    .text;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  home = temp('station-follow-ups-home-');
  ghDir = temp('station-follow-ups-gh-');
  gh = installFakeGhGraphql(ghDir);
  const workspace = temp('station-follow-ups-workspace-');
  graph = new TaskGraphService(home, {
    projectService: {
      getProject: (slug: string) => {
        if (slug !== 'project-alpha') throw new Error('missing project');
        return {
          id: slug,
          slug,
          name: 'Project alpha',
          workingDirectory: workspace,
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        };
      },
    },
  } as never);
  registry = new FeaturePreviewRegistry(home, {
    info: () => undefined,
    error: () => undefined,
  } as never);
  holder = new TaskFollowUpStoreHolder(() => taskFollowUpStorePath(home));
  poller = composeTaskFollowUpPoller(registry, false, {
    store: () => holder.forWrite(),
    tasks: graph,
    reader: new GhGitHubFollowUpReader({ command: gh }),
  })!;
});

afterEach(() => {
  holder.close();
  vi.useRealTimers();
});

describe.skipIf(process.platform === 'win32')('Task tracker follow-ups', () => {
  test("a member's review comment on a kept pull request appears in the Task brief", async () => {
    const task = await trackerTask();
    await enable();
    answerFirstPoll();

    const summary = await poll();
    expect(summary.tasks).toEqual([
      { taskId: task.id, items: 2, recorded: 11, outcome: 'ok' },
    ]);
    // gh ran on github.com, from an empty directory, never in the home.
    for (const call of calls(ghDir)) {
      expect(call.hostname).toBe('github.com');
      expect(call.cwd).toContain('station-git-tool-');
    }

    const text = await brief(graph.readTask(task.id)!);
    expect(text).toContain(
      [
        '## Tracker follow-ups (newest first)',
        "Recorded from the Task's followed GitHub items; last read 2026-11-04T12:00:00Z. Classes: member (owner, member or collaborator), bot (GitHub App or [bot] login), other (anyone else), ci (check run).",
        'Quoted, written by people outside Station (public tracker content):',
      ].join('\n'),
    );
    expect(text).toContain(
      '- Review comment on github:acme/widgets#14804 by member-reviewer (member, MEMBER) at 2026-10-23T18:41:21Z\n> Synthetic single-line text 4.',
    );
    // A failing check on the kept pull request is shown; passing ones counted.
    expect(text).toContain(
      '- Check run on github:acme/widgets#14804 by github-actions (ci) at 2026-10-23T19:29:36Z: FAILURE\n> Check: lint',
    );
    expect(text).toContain(
      '(2 passing, neutral or skipped check runs counted, not shown)',
    );
    // The issue's own comments, from a person outside the project.
    expect(text).toContain(
      '- Comment on github:acme/widgets#14882 by outside-reporter (other, NONE) at 2026-11-02T11:15:00Z\n> Synthetic',
    );
  });

  test('a [bot] comment is recorded and shown classified as bot', async () => {
    const task = await trackerTask();
    await enable();
    answerFirstPoll();
    await poll();

    const incarnation = { taskId: task.id, taskCreatedAt: task.createdAt };
    const bots = holder
      .forRead()!
      .list(incarnation)
      .filter((item) => item.kind === 'comment' && item.itemRef === PR_REF);
    // GraphQL names the App account `Bot`, login without the suffix.
    expect(bots).toEqual([
      expect.objectContaining({
        githubId: '6372019048',
        author: 'github-actions[bot]',
        actorClass: 'bot',
        association: 'CONTRIBUTOR',
      }),
    ]);
    const text = await brief(graph.readTask(task.id)!);
    expect(text).toContain(
      '- Comment on github:acme/widgets#14804 by github-actions[bot] (bot, CONTRIBUTOR) at 2026-10-23T18:32:16Z\n> Synthetic multi-line text 1.',
    );
    // A GitHub App's review is a bot's, whatever its association.
    expect(text).toContain(
      '- Review on github:acme/widgets#14804 by copilot-pull-request-reviewer[bot] (bot, CONTRIBUTOR) at 2026-10-23T18:16:40Z (COMMENTED)',
    );
  });

  test('with the preview off, nothing is polled and nothing is stored', async () => {
    await trackerTask();
    answerFirstPoll();

    // Off by default: no choice was ever saved.
    expect(
      registry.list().find((p) => p.id === TASK_FOLLOW_UP_PREVIEW_ID)?.enabled,
    ).toBe(false);
    await expect(poll()).resolves.toEqual({ outcome: 'disabled', tasks: [] });
    expect(calls(ghDir)).toEqual([]);
    expect(existsSync(taskFollowUpStorePath(home))).toBe(false);

    // The same Task is polled once the preview is on: the gate was the reason.
    await enable();
    expect((await poll()).tasks).toHaveLength(1);
    expect(calls(ghDir).length).toBeGreaterThan(0);
  });

  test('a Task ended more than 14 days ago is not polled; one ended 10 days ago is', async () => {
    const old = await trackerTask('2026-10-01T09:00:00.000Z', {
      keepPullRequest: false,
    });
    await endTask(old.id, new Date(NOW - 15 * DAY).toISOString());
    const recent = await trackerTask('2026-10-01T09:00:00.000Z', {
      keepPullRequest: false,
      ref: 'github:acme/widgets#14883',
    });
    await endTask(recent.id, new Date(NOW - 10 * DAY).toISOString());
    await enable();
    answerFirstPoll();
    answer(ghDir, { number: 14883 }, issuePage2);

    const summary = await poll();
    expect(summary.tasks.map((t) => t.taskId)).toEqual([recent.id]);
    expect(calls(ghDir).map((call) => call.number)).toEqual(['14883']);
    // Recorded and visible, and the ended Task keeps its status.
    expect(graph.readTask(recent.id)?.status).toBe('done');
  });

  test('an item at a pagination boundary is not lost, and the next poll resumes after the last item kept', async () => {
    const task = await trackerTask();
    await enable();
    answerFirstPoll();
    await poll();

    const store = holder.forRead()!;
    const incarnation = { taskId: task.id, taskCreatedAt: task.createdAt };
    // The review on page 2, after the page-1 boundary GitHub reported.
    expect(
      store.list(incarnation).filter((item) => item.kind === 'review'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          githubId: '5633437083',
          author: 'member-approver',
          actorClass: 'member',
          reviewState: 'APPROVED',
        }),
      ]),
    );
    expect(
      calls(ghDir).map((c) => [c.number, c.commentsAfter, c.reviewsAfter]),
    ).toEqual([
      ['14882', null, null],
      ['14882', ISSUE_C2, null],
      ['14804', null, null],
      ['14804', PR_C1, PR_R2],
    ]);
    const before = store.list(incarnation).length;

    // Not due again within five minutes.
    await poll(NOW + 60_000);
    expect(calls(ghDir)).toHaveLength(4);

    // A new review lands after the last one kept. Page 2's empty comments
    // connection reported `endCursor: null`; the saved cursor must survive it.
    const emptyIssue = structuredClone(issuePage2);
    emptyIssue.data.repository.issueOrPullRequest.comments = {
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [],
    };
    answer(ghDir, { number: ISSUE, commentsAfter: ISSUE_C3 }, emptyIssue);
    const next = structuredClone(prPage2);
    const review = next.data.repository.issueOrPullRequest.reviews.edges[0];
    review.cursor =
      'Y3Vyc29yOnYyOpO0MjAyNi0xMS0wNFQxMTowMDowMFq0MjAyNi0xMS0wNFQxMTowMDowMFrPAAAAAU_Hbpw=';
    review.node.databaseId = 5633437340;
    review.node.submittedAt = '2026-11-04T11:00:00Z';
    review.node.state = 'CHANGES_REQUESTED';
    next.data.repository.issueOrPullRequest.commits =
      prPage1.data.repository.issueOrPullRequest.commits;
    answer(
      ghDir,
      { number: PR, commentsAfter: PR_C1, reviewsAfter: PR_R3 },
      next,
    );

    const second = await poll(NOW + 6 * 60_000);
    expect(second.tasks).toEqual([
      { taskId: task.id, items: 2, recorded: 1, outcome: 'ok' },
    ]);
    expect(
      calls(ghDir)
        .slice(4)
        .map((c) => [c.number, c.commentsAfter, c.reviewsAfter]),
    ).toEqual([
      ['14882', ISSUE_C3, null],
      ['14804', PR_C1, PR_R3],
    ]);
    // Exactly one new observation: the re-read check runs are the same ids.
    expect(store.list(incarnation)).toHaveLength(before + 1);
  });
});
