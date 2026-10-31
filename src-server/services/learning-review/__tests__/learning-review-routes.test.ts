import type { KnowledgeLearningReceipt } from '@kontourai/flow-agents/knowledge-learning-contract';
import { expect, test, vi } from 'vitest';
import { createProjectLearningReviewRoutes } from '../../../routes/projects/learning-review-routes.js';
import { LearningReviewService, type LearningLifecycleOwnerPort } from '../learning-review-service.js';

import { scope, evidence, proposal } from '../../../__test-utils__/learning-review-fixture.js';

function fixture() {
  let current = true;
  const apply = vi.fn(async (): Promise<KnowledgeLearningReceipt> => ({ id: 'receipt-activation', intentId: 'intent-activation',
    requestDigest: 'e'.repeat(64), learningId: 'learning-one', revision: 2, action: 'activate', actorId: 'person:reviewer', at: '2026-10-30T10:01:00.000Z' }));
  const owner: LearningLifecycleOwnerPort = { version: 'knowledge.learning/v1', authority: 'knowledge-kit',
    get: vi.fn(async () => structuredClone(proposal)), list: async () => ({ records: [structuredClone(proposal)], coverage: 'partial' }), apply };
  const source = vi.fn(async () => ({ scope, supporting: [evidence], counter: [], conflicts: [], targets: proposal.record.proposal.targets }));
  const service = new LearningReviewService(owner, source);
  const app = createProjectLearningReviewRoutes({ enabled: () => true,
    authorize: async () => ({ scope, service, isCurrent: () => current }) });
  return { app, service, owner, apply, source, revoke: () => { current = false; } };
}
const post = (path: string, value: unknown) => new Request(`http://station.test/demo/learning/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-station-learning-project-id': scope.id }, body: JSON.stringify(value),
});

test('Project route forwards typed intent under trusted scope; an activation receipt does not become active guidance', async () => {
  const { app, apply } = fixture();
  const response = await app.request(post('learning-one/intents', { intentId: 'intent-activation', expectedRevision: 1, action: 'activate' }));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(apply).toHaveBeenCalledWith({ intentId: 'intent-activation', expectedRevision: 1, action: 'activate', learningId: 'learning-one', scope });
  expect(result.data.receipt.ref.id).toBe('receipt-activation');
  expect(result.data.detail.active).toBe(false);
  expect(result.data.detail.projection.activation.value.status).toBe('inactive');
  expect(result.data.detail.projection.effect.value.observations).toEqual([]);
});

test('request actor, scope and decision capability are refused before the owner is called', async () => {
  const { app, apply } = fixture();
  for (const authority of [{ actorId: 'person:operator' }, { mayDecide: true }, { scope: { kind: 'global', id: '*' } }]) {
    expect((await app.request(post('learning-one/intents', { intentId: 'intent', expectedRevision: 1, action: 'activate', ...authority }))).status).toBe(400);
  }
  expect(apply).not.toHaveBeenCalled();
});

test('proposal sources are resolved at the host seam, and restricted comparisons and absent source times remain explicit', async () => {
  const { app, owner, source, apply } = fixture();
  const selection = { kind: 'task-standing', taskId: 'task-one', recordKind: 'decision', key: 'key', version: 3 };
  const response = await app.request(post('proposals', { intentId: 'intent-proposal', learningId: 'learning-one', source: selection,
    kind: 'guideline', title: 'Keep evidence', body: 'Edited by reviewer', expectedEffect: 'Fewer lost receipts' }));
  expect(response.status).toBe(200);
  expect(source).toHaveBeenCalledWith(selection, scope);
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ action: 'propose', scope,
    proposal: expect.objectContaining({ supporting: [evidence], body: 'Edited by reviewer' }) }));
  owner.get = async (_scope, id) => id === 'comparison' ? { state: 'restricted' } : structuredClone(proposal);
  const detail = await app.request('http://station.test/demo/learning/learning-one?compareId=comparison', { headers: { 'x-station-learning-project-id': scope.id } });
  const body = await detail.json();
  expect(body.data.projection.source).toEqual({ state: 'not-captured' });
  expect(body.data.comparison).toEqual({ state: 'restricted' });
});

test('changed Project authority and corrupt activation proof cannot release source content', async () => {
  const fixtureState = fixture();
  fixtureState.owner.get = async () => { fixtureState.revoke(); return structuredClone(proposal); };
  const response = await fixtureState.app.request('http://station.test/demo/learning/learning-one', { headers: { 'x-station-learning-project-id': scope.id } });
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('Proposed guidance');
  const corrupt = fixture();
  corrupt.owner.get = async () => ({ ...structuredClone(proposal), active: true });
  expect(await corrupt.service.get(scope, 'learning-one')).toEqual({ state: 'corrupt' });
});

test('unsupported owner versions and stale owner intents remain exact gaps/refusals', async () => {
  const { app, owner } = fixture();
  owner.version = 'knowledge.learning/v2';
  expect((await (await app.request('http://station.test/demo/learning', { headers: { 'x-station-learning-project-id': scope.id } })).json()).data).toEqual({ state: 'unsupported-version' });
  owner.version = 'knowledge.learning/v1';
  owner.apply = async () => { throw Object.assign(new Error('private owner detail'), { code: 'stale' }); };
  const response = await app.request(post('learning-one/intents', { intentId: 'intent', expectedRevision: 1, action: 'activate' }));
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain('private owner detail');
});
