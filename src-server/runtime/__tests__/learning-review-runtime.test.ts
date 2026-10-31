import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LearningReviewSourceSelection } from '@kontourai/station-contracts/learning-review';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FeaturePreviewRegistry } from '../../services/feature-previews/feature-preview-registry.js';
import { FeedbackService } from '../../services/feedback/feedback-service.js';
import { createFeedbackRatingTarget } from '../../services/feedback/feedback-target.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { createLogger } from '../../utils/logger.js';
import {
  composeLearningReviewRuntime,
  type LearningRuntimeOptions,
} from '../learning-review-runtime.js';

const temp = trackTempDirs();
const opened: EventStore[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});
function fixture() {
  const home = temp('learning-runtime-');
  mkdirSync(join(home, 'security'), { mode: 0o700 });
  const eventStore = new EventStore(join(home, 'events.sqlite'));
  opened.push(eventStore);
  const registry = new FeaturePreviewRegistry(
    home,
    createLogger({ name: 'learning-test' }),
  );
  let projectId = 'project-one';
  let allowed = true;
  const task: TaskRecord = {
    id: 'task-source',
    projectId,
    title: 'Source task',
    description: '',
    priority: 'normal',
    status: 'done',
    createdBy: 'person:operator',
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
  };
  const memory = eventStore.taskMemoryStore();
  const incarnation = { taskId: task.id, taskCreatedAt: task.createdAt };
  expect(
    memory.writeRecord({
      ...incarnation,
      projectId,
      author: { kind: 'person', principalId: 'person:operator' },
      write: {
        kind: 'decision',
        key: 'bounded-context',
        text: 'Retain evidence after a context reset.',
        importance: 'standing',
      },
    }).kind,
  ).toBe('recorded');
  const options: LearningRuntimeOptions = {
    home,
    authority: 'station:fixture',
    projects: () => [{ id: projectId, slug: 'demo' }],
    readTask: (id: string) => (id === task.id ? task : null),
    memory: () => memory,
    mayReadProject: () => allowed,
    mayReadTask: () => allowed,
    mayReadSession: () => allowed,
    contributions: () => [],
    captureRatingEvidence: () =>
      new FeedbackService(home).captureRatingEvidence(),
    messages: async () => [],
    projectForSession: () => undefined,
  };
  const runtime = composeLearningReviewRuntime(registry, options);
  return {
    home,
    task,
    incarnation,
    memory,
    registry,
    runtime,
    options,
    revoke: () => {
      allowed = false;
    },
    replaceProject: () => {
      projectId = 'project-replacement';
    },
  };
}
const source: LearningReviewSourceSelection = {
  kind: 'task-standing',
  taskId: 'task-source',
  taskCreatedAt: '2026-10-30T10:00:00.000Z',
  recordKind: 'decision',
  key: 'bounded-context',
  version: 1,
};

test('real owner activation contributes the exact revision after restart; retirement removes future contribution and retains receipts', async () => {
  const f = fixture();
  expect(await f.runtime.forTask(f.task, 'person:operator')).toBeUndefined();
  expect(existsSync(join(f.home, 'security', 'knowledge-learning'))).toBe(
    false,
  );
  await f.registry.setEnabled('learning-lifecycle-review', true);
  const access = f.runtime.forProject(
    'project-one',
    'person:operator',
    () => {},
    true,
  );
  const scope = { kind: 'project' as const, id: 'project-one' };
  const proposal = await access.service.propose(scope, {
    intentId: 'propose-one',
    learningId: 'learning-one',
    source,
    kind: 'guideline',
    title: 'Retain evidence',
    body: 'Attach immutable source references.',
    expectedEffect: 'Fewer lost receipts',
  });
  expect(proposal.detail.state).toBe('available');
  if (
    proposal.detail.state !== 'available' ||
    proposal.detail.projection.candidate.state !== 'available'
  )
    throw new Error('proposal missing');
  const reference =
    proposal.detail.projection.candidate.value.supportingRefs[0];
  expect(
    (await f.runtime.forTask(f.task, 'person:operator'))?.text,
  ).not.toContain('Attach immutable');
  await access.service.apply(scope, 'learning-one', {
    intentId: 'evaluate-one',
    expectedRevision: 1,
    action: 'evaluate',
    status: 'supported',
    evidence: [reference],
  });
  await access.service.apply(scope, 'learning-one', {
    intentId: 'approve-one',
    expectedRevision: 2,
    action: 'approve',
    rationale: 'Source and expected effect reviewed.',
  });
  await access.service.apply(scope, 'learning-one', {
    intentId: 'activate-one',
    expectedRevision: 3,
    action: 'activate',
  });
  const restarted = composeLearningReviewRuntime(
    new FeaturePreviewRegistry(
      f.home,
      createLogger({ name: 'learning-restart' }),
    ),
    f.options,
  );
  const contributed = (await restarted.forTask(f.task, 'person:operator'))
    ?.text;
  expect(contributed).toContain('Attach immutable source references.');
  expect(contributed).toMatch(/learning learning-one, revision [a-f0-9]{64}/);
  await access.service.apply(scope, 'learning-one', {
    intentId: 'retire-one',
    expectedRevision: 4,
    action: 'retire',
    reason: 'Replaced by an improved practice.',
  });
  expect(
    (await restarted.forTask(f.task, 'person:operator'))?.text,
  ).not.toContain('Attach immutable');
  const retained = await access.service.get(scope, 'learning-one');
  expect(retained.state).toBe('available');
  if (retained.state !== 'available')
    throw new Error('retained history missing');
  expect(retained.active).toBe(false);
  expect(retained.receipts.map((receipt) => receipt.action)).toEqual([
    'propose',
    'evaluate',
    'approve',
    'activate',
    'retire',
  ]);
});

test('stale canonical source versions, revoked access and replacement Project identity cannot expose or promote guidance', async () => {
  const f = fixture();
  await f.registry.setEnabled('learning-lifecycle-review', true);
  const access = f.runtime.forProject(
    'project-one',
    'person:operator',
    () => {},
    false,
  );
  const scope = { kind: 'project' as const, id: 'project-one' };
  await access.service.propose(scope, {
    intentId: 'propose-one',
    learningId: 'learning-one',
    source,
    kind: 'guideline',
    title: 'Retain evidence',
    body: 'Protected guidance',
    expectedEffect: 'Fewer losses',
  });
  expect(
    f.memory.writeRecord({
      ...f.incarnation,
      projectId: 'project-one',
      author: { kind: 'person', principalId: 'person:operator' },
      write: {
        kind: 'decision',
        key: 'bounded-context',
        text: 'New standing source',
        importance: 'standing',
      },
    }).kind,
  ).toBe('recorded');
  expect(await access.service.get(scope, 'learning-one')).toEqual({
    state: 'restricted',
  });
  await expect(
    access.service.apply(scope, 'learning-one', {
      intentId: 'approve-one',
      expectedRevision: 1,
      action: 'approve',
      rationale: 'Not authorized.',
    }),
  ).rejects.toMatchObject({ code: 'restricted' });
  f.revoke();
  await expect(
    f.runtime.forTask(f.task, 'person:operator'),
  ).rejects.toMatchObject({ code: 'restricted' });
  f.replaceProject();
  expect(() => access.assertCurrent()).toThrow();
});

test('rated source uses the verified execution/content target across position changes and refuses stale prepared feedback', async () => {
  const f = fixture();
  const feedback = new FeedbackService(f.home);
  const response: ConversationMessage = {
    id: 'positional-row',
    role: 'assistant',
    parts: [{ type: 'text', text: 'The actual rated response' }],
    metadata: { sessionId: 'rated-session', turnId: 'rated-turn' },
  };
  let messages: ConversationMessage[] = [response];
  f.options.captureRatingEvidence = () => feedback.captureRatingEvidence();
  f.options.messages = async () => messages;
  f.options.projectForSession = (sessionId) =>
    sessionId === 'rated-session' ? 'project-one' : undefined;
  await f.registry.setEnabled('learning-lifecycle-review', true);
  const access = () =>
    f.runtime.forProject('project-one', 'person:operator', () => {}, true);
  const scope = { kind: 'project' as const, id: 'project-one' };
  const ratingInput = {
    agentSlug: 'station',
    conversationId: 'rated-conversation',
    messageIndex: 0,
    messagePreview: 'Not target authority',
    rating: 'thumbs_down' as const,
    reason: 'Keep the evidence',
  };
  const legacy = feedback.rateMessage(ratingInput);
  const selection: LearningReviewSourceSelection = {
    kind: 'rated-feedback',
    conversationId: ratingInput.conversationId,
    turnId: 'rated-turn',
    ratingId: legacy.id,
  };
  expect(await access().service.prepare(scope, selection)).toEqual({
    state: 'restricted',
  });
  const target = createFeedbackRatingTarget(
    ratingInput.conversationId,
    response,
  );
  if (!target) throw new Error('Canonical fixture target missing');
  feedback.rateMessage(ratingInput, target);
  const prepared = await access().service.prepare(scope, selection);
  expect(prepared.state).toBe('available');
  if (prepared.state !== 'available')
    throw new Error('Prepared rated source missing');
  messages = [
    {
      ...response,
      id: 'unrelated-new-row',
      metadata: { sessionId: 'other-session', turnId: 'other-turn' },
    },
    { ...response, id: 'changed-positional-id' },
  ];
  const moved = await access().service.prepare(scope, selection);
  expect(moved.state).toBe('available');
  if (moved.state !== 'available')
    throw new Error('Verified source lost after row movement');
  expect(moved.ref).toEqual(prepared.ref);
  feedback.rateMessage(
    { ...ratingInput, reason: 'A newer explicit assessment' },
    target,
  );
  await expect(
    access().service.propose(scope, {
      intentId: 'rated-proposal',
      learningId: 'rated-learning',
      source: selection,
      expectedSourceRef: prepared.ref,
      kind: 'guideline',
      title: 'Retain sources',
      body: 'Edited after review',
      expectedEffect: 'Fewer lost sources',
    }),
  ).rejects.toMatchObject({ code: 'stale' });
  expect((await access().owner.list(scope)).records).toEqual([]);
  feedback.rateMessage(ratingInput);
  expect(await access().service.prepare(scope, selection)).toEqual({
    state: 'restricted',
  });
});
