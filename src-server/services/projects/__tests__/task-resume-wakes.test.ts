/**
 * #4554: after a resume, no automatic wake reaches the earlier lead.
 *
 * Real pieces: `TaskGraphService` (resume and a seeded dispatch through the
 * real dispatcher composition), the real `TaskQuestionWake` over a real
 * EventStore's Task memory outbox with the production placement rule
 * (`taskLeadPlacementCurrent`), and the real `TaskFollowUpWake` over a real
 * follow-up store. The stand-ins are the Session layer (each lead is live,
 * its conversation is its own id) and the inbox, which records what it is
 * handed.
 */
import { join } from 'node:path';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type { TaskMemoryRecord } from '@kontourai/station-contracts/task-memory';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../orchestration/event-store.js';
import {
  TaskQuestionWake,
  taskLeadPlacementCurrent,
} from '../../orchestration/task-question-wake.js';
import type { ThreadInboxSubmission } from '../../orchestration/thread-inbox.js';
import { TaskFollowUpStore } from '../../work-item-providers/task-follow-up-store.js';
import { TaskFollowUpWake } from '../../work-item-providers/task-follow-up-wake.js';
import { composeTaskDispatcher } from '../task-dispatch-composition.js';
import { TaskGraphService } from '../task-graph-service.js';

const makeTempDir = trackTempDirs();
const PROJECT = 'project-alpha';
const REF = 'github:kontourai/station#7';
const OWNER = 'human:local:operator';
const OBSERVED = '2026-11-01T00:00:00.000Z';
const closers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function world() {
  const homeDir = makeTempDir('task-resume-wakes-');
  const graph = new TaskGraphService(homeDir, {
    projectService: {
      getProject: () => ({
        id: PROJECT,
        slug: PROJECT,
        name: 'Project alpha',
        createdAt: OBSERVED,
        updatedAt: OBSERVED,
      }),
    } as never,
    resolveProjectWorkspace: () => homeDir,
    assignmentClaimService: {
      claim: async () => ({
        outcome: 'claimed',
        record: { claimed_at: OBSERVED },
      }),
      release: async () => ({ outcome: 'released' }),
      status: async () => ({ outcome: 'unclaimed' }),
    } as never,
  });
  const events = new EventStore(join(homeDir, 'orchestration.sqlite'));
  closers.push(() => events.close());
  const followUps = new TaskFollowUpStore(join(homeDir, 'follow-ups.sqlite'));
  closers.push(() => followUps.close());
  const sent: { conversationId: string; clientTurnId: string }[] = [];
  const submit = (input: { conversationId: string; clientTurnId: string }) => {
    sent.push({
      conversationId: input.conversationId,
      clientTurnId: input.clientTurnId,
    });
    return { outcome: 'queued' } as unknown as ThreadInboxSubmission;
  };
  const readLead = async (sessionId: string) => ({
    conversationId: sessionId,
    lifecycleState: 'idle' as const,
    ownerUserId: OWNER,
  });
  const questions = new TaskQuestionWake({
    outbox: events.taskMemoryStore(),
    mayReadTask: () => true,
    placementCurrent: (task, _owner, conversationId) =>
      taskLeadPlacementCurrent(task, conversationId, (id) => id),
    readTask: (taskId) => graph.readTaskView(taskId),
    readLead,
    conversationOf: (id) => id,
    submit,
    logger: { warn() {} },
  });
  const tracker = new TaskFollowUpWake({
    store: () => followUps,
    enabled: () => true,
    readTask: (taskId) => graph.readTaskView(taskId),
    readLead,
    conversationOf: (id) => id,
    mayReadTask: () => true,
    submit,
    logger: { warn() {} },
  });
  const dispatch = async (taskId: string) => {
    const outcome = await composeTaskDispatcher(graph).dispatch(taskId, {
      ownerUserId: OWNER,
    });
    expect(outcome.kind).toBe('dispatched');
    return graph.readTask(taskId)!;
  };
  return { graph, followUps, sent, questions, tracker, dispatch };
}

let questionVersion = 0;
function question(task: TaskRecord, key: string): TaskMemoryRecord {
  questionVersion += 1;
  return {
    taskId: task.id,
    kind: 'question',
    key,
    version: 1,
    action: 'set',
    state: 'open',
    importance: 'standing',
    text: 'Which branch should the fix land on?',
    author: { kind: 'session', sessionId: `helper-${questionVersion}` },
    createdAt: new Date().toISOString(),
  } as TaskMemoryRecord;
}

let githubId = 1000;
function memberComment(w: ReturnType<typeof world>, task: TaskRecord): void {
  githubId += 1;
  w.followUps.recordPage(
    { taskId: task.id, taskCreatedAt: task.createdAt },
    REF,
    {
      items: [
        {
          kind: 'comment',
          githubId: String(githubId),
          author: 'reviewer',
          actorClass: 'member',
          association: 'MEMBER',
          occurredAt: new Date().toISOString(),
          excerpt: 'One more test, please.',
          truncated: false,
        },
      ],
      cursors: {},
      wakeable: () => true,
    },
    new Date().toISOString(),
  );
}

async function resumed(w: ReturnType<typeof world>) {
  const { task: created } = await w.graph.createTaskForWorkItem(
    { projectId: PROJECT, title: 'Fix it', workItemRef: REF },
    OBSERVED,
  );
  const live = await w.dispatch(created.id);
  await w.graph.updateTaskStatus(live.id, 'in_progress');
  const earlierLead = w.graph.readTask(live.id)!.sessionId!;
  // Both wakes reach the earlier lead while the Task is live.
  const asked = question(live, 'branch');
  const queuedQuestion = await w.questions.wake({
    incarnation: { taskId: live.id, taskCreatedAt: live.createdAt },
    record: asked,
  });
  expect(queuedQuestion).toMatchObject({
    kind: 'queued',
    conversationId: earlierLead,
  });
  memberComment(w, live);
  const queuedFollowUp = await w.tracker.deliver({
    taskId: live.id,
    taskCreatedAt: live.createdAt,
  });
  expect(queuedFollowUp).toMatchObject({
    kind: 'queued',
    conversationId: earlierLead,
  });
  await w.graph.updateTaskStatus(live.id, 'done');
  const done = w.graph.readTask(live.id)!;
  await w.graph.resumeTask({
    taskId: done.id,
    request: {
      resumeId: 'resume-1',
      expectedCreatedAt: done.createdAt,
      expectedEndedAt: done.endedAt!,
      reason: 'Follow-up review',
    },
    principalId: OWNER,
    authorize: () => true,
    isTaskSessionTurnActive: () => false,
  });
  return {
    task: w.graph.readTask(done.id)!,
    earlierLead,
    queuedQuestion: queuedQuestion as { clientTurnId: string },
    queuedFollowUp: queuedFollowUp as { clientTurnId: string },
  };
}

describe('after a resume, automatic wakes never reach the earlier lead (#4554)', () => {
  test('entries queued before the resume are refused at placement', async () => {
    const w = world();
    const { earlierLead, queuedQuestion, queuedFollowUp } = await resumed(w);
    expect(
      w.questions.placementRefusal({
        clientTurnId: queuedQuestion.clientTurnId,
        conversationId: earlierLead,
        userId: OWNER,
      }),
    ).toMatchObject({ reasonCode: 'task_question_source_changed' });
    expect(
      w.tracker.placementRefusal({
        clientTurnId: queuedFollowUp.clientTurnId,
        conversationId: earlierLead,
        userId: OWNER,
      }),
    ).toMatchObject({ reasonCode: 'task_follow_up_source_changed' });
  });

  test('a question after the resume is held, and reaches only the newly dispatched lead', async () => {
    const w = world();
    const { task, earlierLead } = await resumed(w);
    const sentBefore = w.sent.length;
    const asked = question(task, 'after-resume');
    const incarnation = { taskId: task.id, taskCreatedAt: task.createdAt };
    expect(await w.questions.wake({ incarnation, record: asked })).toEqual({
      kind: 'skipped',
      reason: 'no-live-lead',
    });
    expect(w.sent.length).toBe(sentBefore);

    const redispatched = await w.dispatch(task.id);
    expect(redispatched.sessionId).not.toBe(earlierLead);
    const delivered = await w.questions.wake({ incarnation, record: asked });
    expect(delivered).toMatchObject({
      kind: 'queued',
      conversationId: redispatched.sessionId,
    });
    expect(w.sent.at(-1)?.conversationId).toBe(redispatched.sessionId);
  });

  test('a tracker comment after the resume stays recorded and wakes no one until a new lead exists', async () => {
    const w = world();
    const { task, earlierLead } = await resumed(w);
    const sentBefore = w.sent.length;
    memberComment(w, task);
    const incarnation = { taskId: task.id, taskCreatedAt: task.createdAt };
    expect(await w.tracker.deliver(incarnation)).toMatchObject({
      kind: 'skipped',
      reason: 'no-live-lead',
    });
    expect(w.sent.length).toBe(sentBefore);
    expect(w.followUps.list(incarnation)).toHaveLength(2);

    const redispatched = await w.dispatch(task.id);
    memberComment(w, task);
    const delivered = await w.tracker.deliver(incarnation);
    expect(delivered).toMatchObject({
      kind: 'queued',
      conversationId: redispatched.sessionId,
    });
    expect(
      w.sent.every(
        (entry, index) =>
          index < sentBefore || entry.conversationId !== earlierLead,
      ),
    ).toBe(true);
  });
});
