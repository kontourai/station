import type { KnowledgeLearningReceipt } from '@kontourai/flow-agents/knowledge-learning-contract';
import { expect, test, vi } from 'vitest';
import {
  evidence,
  proposal,
  scope,
} from '../../../__test-utils__/learning-review-fixture.js';
import { createProjectLearningReviewRoutes } from '../../../routes/projects/learning-review-routes.js';
import {
  type LearningLifecycleOwnerPort,
  LearningReviewService,
} from '../learning-review-service.js';

function fixture() {
  let current = true;
  const apply = vi.fn(
    async (): Promise<KnowledgeLearningReceipt> => ({
      id: 'receipt-activation',
      intentId: 'intent-activation',
      requestDigest: 'e'.repeat(64),
      learningId: 'learning-one',
      revision: 2,
      action: 'activate',
      actorId: 'person:reviewer',
      at: '2026-10-30T10:01:00.000Z',
    }),
  );
  const owner: LearningLifecycleOwnerPort = {
    version: 'knowledge.learning/v1',
    authority: 'knowledge-kit',
    get: vi.fn(async () => structuredClone(proposal)),
    list: async () => ({
      records: [structuredClone(proposal)],
      coverage: 'partial',
    }),
    apply,
  };
  const source = vi.fn(async () => ({
    scope,
    supporting: [evidence],
    counter: [],
    conflicts: [],
    targets: proposal.record.proposal.targets,
  }));
  const service = new LearningReviewService(owner, source);
  const app = createProjectLearningReviewRoutes({
    enabled: () => true,
    authorize: async () => ({ scope, service, isCurrent: () => current }),
  });
  return {
    app,
    service,
    owner,
    apply,
    source,
    revoke: () => {
      current = false;
    },
  };
}
const post = (path: string, value: unknown) =>
  new Request(`http://station.test/demo/learning/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-station-learning-project-id': scope.id,
    },
    body: JSON.stringify(value),
  });

test('Project route forwards typed intent under trusted scope; an activation receipt does not become active guidance', async () => {
  const { app, apply } = fixture();
  const response = await app.request(
    post('learning-one/intents', {
      intentId: 'intent-activation',
      expectedRevision: 1,
      action: 'activate',
    }),
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(apply).toHaveBeenCalledWith({
    intentId: 'intent-activation',
    expectedRevision: 1,
    action: 'activate',
    learningId: 'learning-one',
    scope,
  });
  expect(result).toHaveProperty('data.receipt.ref.id', 'receipt-activation');
  expect(result).toHaveProperty('data.detail.active', false);
  expect(result).toHaveProperty(
    'data.detail.projection.activation.value.status',
    'inactive',
  );
  expect(result).toHaveProperty(
    'data.detail.projection.effect.value.observations',
    [],
  );
});

test('request actor, scope and decision capability are refused before the owner is called', async () => {
  const { app, apply } = fixture();
  for (const authority of [
    { actorId: 'person:operator' },
    { mayDecide: true },
    { scope: { kind: 'global', id: '*' } },
  ]) {
    expect(
      (
        await app.request(
          post('learning-one/intents', {
            intentId: 'intent',
            expectedRevision: 1,
            action: 'activate',
            ...authority,
          }),
        )
      ).status,
    ).toBe(400);
  }
  const replacement = post('learning-one/intents', {
    intentId: 'intent',
    expectedRevision: 1,
    action: 'activate',
  });
  replacement.headers.set(
    'x-station-learning-project-id',
    'replacement-project',
  );
  expect((await app.request(replacement)).status).toBe(409);
  expect(apply).not.toHaveBeenCalled();
});

test('proposal sources are resolved at the host seam, and restricted comparisons and absent source times remain explicit', async () => {
  const { app, owner, source, apply } = fixture();
  const selection = {
    kind: 'task-standing',
    taskCreatedAt: '2026-10-30T09:00:00.000Z',
    taskId: 'task-one',
    recordKind: 'decision',
    key: 'key',
    version: 3,
  };
  const response = await app.request(
    post('proposals', {
      intentId: 'intent-proposal',
      learningId: 'learning-one',
      source: selection,
      kind: 'guideline',
      title: 'Keep evidence',
      body: 'Edited by reviewer',
      expectedEffect: 'Fewer lost receipts',
    }),
  );
  expect(response.status).toBe(200);
  expect(source).toHaveBeenCalledWith(selection, scope);
  expect(apply).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'propose',
      scope,
      proposal: expect.objectContaining({
        supporting: [evidence],
        body: 'Edited by reviewer',
      }),
    }),
  );
  owner.get = async (_scope, id) =>
    id === 'comparison' ? { state: 'restricted' } : structuredClone(proposal);
  const detail = await app.request(
    'http://station.test/demo/learning/learning-one?compareId=comparison',
    { headers: { 'x-station-learning-project-id': scope.id } },
  );
  const body = await detail.json();
  expect(body).toHaveProperty('data.projection.source', {
    state: 'not-captured',
  });
  expect(body).toHaveProperty('data.comparison', { state: 'restricted' });
});

test('changed Project authority and corrupt activation proof cannot release source content', async () => {
  const fixtureState = fixture();
  fixtureState.owner.get = async () => {
    fixtureState.revoke();
    return structuredClone(proposal);
  };
  const response = await fixtureState.app.request(
    'http://station.test/demo/learning/learning-one',
    { headers: { 'x-station-learning-project-id': scope.id } },
  );
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('Proposed guidance');
  const corrupt = fixture();
  corrupt.owner.get = async () => ({
    ...structuredClone(proposal),
    active: true,
  });
  expect(await corrupt.service.get(scope, 'learning-one')).toEqual({
    state: 'corrupt',
  });
});

test('unsupported owner versions and stale owner intents remain exact gaps/refusals', async () => {
  const { app, owner } = fixture();
  owner.version = 'knowledge.learning/v2';
  expect(
    await (
      await app.request('http://station.test/demo/learning', {
        headers: { 'x-station-learning-project-id': scope.id },
      })
    ).json(),
  ).toHaveProperty('data', { state: 'unsupported-version' });
  owner.version = 'knowledge.learning/v1';
  owner.apply = async () => {
    throw Object.assign(new Error('private owner detail'), { code: 'stale' });
  };
  const response = await app.request(
    post('learning-one/intents', {
      intentId: 'intent',
      expectedRevision: 1,
      action: 'activate',
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain('private owner detail');
});

test('only exact references in the current owner record can reach the source inspector, with authority rechecked after reading', async () => {
  const state = fixture();
  let readable = true;
  state.owner.get = async () =>
    readable ? structuredClone(proposal) : { state: 'restricted' };
  const inspect = vi.fn(async () => ({
    title: 'Standing decision',
    text: 'Exact canonical text',
    capturedAt: '2026-10-30T09:00:00.000Z',
  }));
  const service = new LearningReviewService(state.owner, state.source, inspect);
  expect(
    await service.inspect(scope, 'learning-one', {
      ...evidence,
      revision: 'other',
    }),
  ).toEqual({ state: 'restricted' });
  expect(inspect).not.toHaveBeenCalled();
  expect(await service.inspect(scope, 'learning-one', evidence)).toEqual({
    state: 'available',
    ref: evidence,
    title: 'Standing decision',
    text: 'Exact canonical text',
    capturedAt: '2026-10-30T09:00:00.000Z',
  });
  inspect.mockImplementation(async () => {
    readable = false;
    return {
      title: 'Private',
      text: 'must not release',
      capturedAt: '2026-10-30T09:00:00.000Z',
    };
  });
  expect(await service.inspect(scope, 'learning-one', evidence)).toEqual({
    state: 'restricted',
  });
});

test('a later effect source resolves canonically into the typed owner intent', async () => {
  const state = fixture();
  const source = {
    kind: 'task-standing' as const,
    taskCreatedAt: '2026-10-30T09:00:00.000Z',
    taskId: 'later-task',
    recordKind: 'decision' as const,
    key: 'result',
    version: 2,
  };
  const response = await state.app.request(
    post('learning-one/intents', {
      intentId: 'later-effect',
      expectedRevision: 1,
      action: 'observe-effect',
      assessment: 'unresolved',
      source,
    }),
  );
  expect(response.status).toBe(200);
  expect(state.source).toHaveBeenCalledWith(source, scope);
  expect(state.apply).toHaveBeenCalledWith({
    intentId: 'later-effect',
    expectedRevision: 1,
    learningId: 'learning-one',
    scope,
    action: 'observe-effect',
    assessment: 'unresolved',
    evidence,
  });
});

test('preparing a real source is read-only and a changed prepared rating revision cannot be proposed', async () => {
  const state = fixture();
  let revision = evidence.revision;
  const service = new LearningReviewService(
    state.owner,
    async () => ({
      scope,
      supporting: [{ ...evidence, revision }],
      counter: [],
      conflicts: [],
      targets: proposal.record.proposal.targets,
    }),
    async () => ({
      title: 'Rated response',
      text: 'Canonical source excerpt',
      truncated: true,
    }),
  );
  const selection = {
    kind: 'rated-feedback' as const,
    conversationId: 'conversation',
    turnId: 'turn',
    ratingId: 'rating',
  };
  const prepared = await service.prepare(scope, selection);
  expect(prepared).toMatchObject({
    state: 'available',
    projectId: scope.id,
    title: 'Rated response',
    body: 'Canonical source excerpt',
    truncated: true,
  });
  expect(state.apply).not.toHaveBeenCalled();
  if (prepared.state !== 'available') throw new Error('Preparation missing');
  revision = 'changed';
  await expect(
    service.propose(scope, {
      intentId: 'proposal',
      learningId: 'new-learning',
      source: selection,
      kind: 'guideline',
      title: 'Guidance',
      body: 'Edited proposal',
      expectedEffect: 'Expected effect',
      expectedSourceRef: prepared.ref,
    }),
  ).rejects.toMatchObject({ code: 'stale' });
  expect(state.apply).not.toHaveBeenCalled();
});

test('retirement preserves exact activation and canonical contribution receipts without claiming active guidance or complete coverage', async () => {
  const state = fixture();
  const active = structuredClone(proposal);
  active.record.revision = 5;
  active.record.evaluation = {
    status: 'supported',
    evidence: [evidence],
    receiptId: 'receipt-evaluate',
  };
  active.record.decision = {
    status: 'approved',
    rationale: 'Reviewed',
    receiptId: 'receipt-approve',
  };
  active.record.activation = {
    revision: active.record.contentRevision,
    targets: active.record.proposal.targets,
    receiptId: 'receipt-activate',
  };
  active.record.retirement = {
    reason: 'Superseded practice',
    receiptId: 'receipt-retire',
  };
  active.receipts = (
    ['propose', 'evaluate', 'approve', 'activate', 'retire'] as const
  ).map((action, index) => ({
    ...proposal.receipts[0]!,
    id: `receipt-${action}`,
    intentId: `intent-${action}`,
    revision: index + 1,
    action,
  }));
  state.owner.get = async () => structuredClone(active);
  const service = new LearningReviewService(
    state.owner,
    state.source,
    undefined,
    async (_scope, ref) => [
      {
        turnRef: {
          authority: 'station',
          kind: 'turn',
          id: 'turn-one',
          revision: 'event-one',
        },
        activeRevisionRef: ref,
        coordinate: {
          conversationId: 'conversation',
          sessionId: 'session',
          turnId: 'turn-one',
        },
      },
    ],
  );
  const detail = await service.get(scope, active.record.id);
  expect(detail).toMatchObject({
    state: 'available',
    active: false,
    contributionCoverage: 'up-to-100-recent-task-turns',
    projection: {
      activation: {
        state: 'available',
        value: {
          status: 'retired',
          activeRevisionRef: { revision: active.record.contentRevision },
          contributionDisclosures: [
            {
              turnRef: { id: 'turn-one', revision: 'event-one' },
              coordinate: { conversationId: 'conversation' },
            },
          ],
        },
      },
      retirement: { value: { status: 'retired' } },
    },
  });
  const corrupt = new LearningReviewService(
    state.owner,
    state.source,
    undefined,
    async (_scope, ref) => [
      {
        turnRef: {
          authority: 'station',
          kind: 'turn',
          id: 'turn',
          revision: 'event',
        },
        activeRevisionRef: { ...ref, revision: 'wrong' },
      },
    ],
  );
  expect(await corrupt.get(scope, active.record.id)).toEqual({
    state: 'corrupt',
  });
});
