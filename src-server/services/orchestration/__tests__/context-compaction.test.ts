import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { CONVERSATION_CONTEXT_BOUNDARY_MIGRATION } from '../../../domain/migrations/012-conversation-context-boundaries.js';
import { migrateContextSummaryBoundaries } from '../../../domain/migrations/026-context-summary-boundaries.js';
import {
  type ContextCompactionObservation,
  type ContextCompactionPorts,
  ContextCompactionService,
} from '../context-compaction.js';
import { projectConversationContextBoundary } from '../conversation-context-boundary-module.js';
import { EventStore } from '../event-store.js';

const temp = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = new EventStore(
    join(temp('context-compaction-'), 'events.sqlite'),
  );
  stores.push(store);
  store.upsertSession({
    threadId: 'conversation',
    provider: 'station-agent',
    status: 'ready',
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:00:00Z',
  });
  store.appendEvent({
    eventId: 'source-start',
    threadId: 'conversation',
    turnId: 'turn-1',
    provider: 'station-agent',
    createdAt: '2026-10-30T00:00:00Z',
    method: 'turn.started',
    prompt: 'RAW HISTORY SENTINEL',
  });
  store.appendEvent({
    eventId: 'source-end',
    threadId: 'conversation',
    turnId: 'turn-1',
    provider: 'station-agent',
    createdAt: '2026-10-30T00:00:01Z',
    method: 'turn.completed',
  });
  let now = 1000,
    current = true;
  let observation: ContextCompactionObservation = {
    conversationId: 'conversation',
    sessionId: 'conversation',
    turnId: 'turn-1',
    sourceEventId: 'source-end',
    sourceRevision: 'source-revision',
    atRest: true,
    approvalPending: false,
    compactionOwner: 'station',
    usage: {
      confirmed: true,
      sessionId: 'conversation',
      turnId: 'turn-1',
      contextTokens: 900,
      contextWindowTokens: 1000,
    },
  };
  const generate = vi
    .fn<ContextCompactionPorts['generate']>()
    .mockResolvedValue({
      kind: 'generated',
      text: 'Retain the agreed decision and evidence pointer.',
      model: 'summary-model',
      usage: { state: 'observed', inputTokens: 100, outputTokens: 20 },
    });
  const reserve = vi.fn<ContextCompactionPorts['reserveBoundary']>(
    async (input) =>
      projectConversationContextBoundary(
        store.reserveConversationContextBoundary({
          boundaryId: `boundary:${input.idempotencyKey}`,
          conversationId: input.conversationId,
          predecessorSessionId: input.expectedCurrentSessionId,
          successorSessionId: `successor:${input.idempotencyKey}`,
          idempotencyKey: input.idempotencyKey,
          actorId: input.actorId,
          policy: input.policy,
          seed: input.seed,
          status: 'reserved',
          createdAt: '2026-10-30T00:00:02Z',
        }).marker,
      ),
  );
  const ports: ContextCompactionPorts = {
    store: store.contextCompactionStore(),
    now: () => now,
    enabled: () => true,
    observe: async () => structuredClone(observation),
    isCurrent: async () => current,
    generate,
    reserveBoundary: reserve,
    readBoundary: async (id, key) => {
      const marker = store.conversationContextBoundaryByKey(id, key);
      return marker ? projectConversationContextBoundary(marker) : undefined;
    },
  };
  return {
    store,
    ports,
    generate,
    reserve,
    service: new ContextCompactionService(ports),
    observe: (next: Partial<ContextCompactionObservation>) => {
      observation = { ...observation, ...next };
    },
    advance: () => {
      now += 61_000;
    },
    revoke: () => {
      current = false;
    },
  };
}
const request = {
  conversationId: 'conversation',
  expectedSessionId: 'conversation',
  operationId: 'operation-1',
  actorId: 'owner',
  mode: 'manual' as const,
};

test('manual races coalesce a real semantic generation and one persisted boundary without rewriting raw history', async () => {
  const f = fixture();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.generate.mockImplementation(async () => {
    await gate;
    return {
      kind: 'generated',
      text: 'The selected Task decision remains authoritative.',
      model: 'summary-model',
      usage: { state: 'observed', inputTokens: 120, outputTokens: 25 },
    };
  });
  const first = f.service.request(request);
  await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
  const second = await f.service.request({
    ...request,
    operationId: 'operation-2',
  });
  expect(second).toMatchObject({
    kind: 'record',
    record: { state: 'generating', operationId: 'operation-1' },
  });
  finish();
  const result = await first;
  expect(result).toMatchObject({
    kind: 'record',
    record: {
      state: 'reserved',
      seed: {
        model: 'summary-model',
        generationUsage: { inputTokens: 120, outputTokens: 25 },
      },
    },
  });
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.reserve).toHaveBeenCalledTimes(1);
  const marker = f.store.conversationContextBoundaryByKey(
    'conversation',
    'compact:operation-1',
  )!;
  expect(marker.seed?.digest).toBe(
    createHash('sha256').update(marker.seed!.text).digest('hex'),
  );
  expect(
    f.store
      .listEvents('conversation')
      .some(
        (event) =>
          event.payload.method === 'turn.started' &&
          event.payload.prompt === 'RAW HISTORY SENTINEL',
      ),
  ).toBe(true);
  const reopened = new ContextCompactionService({
    ...f.ports,
    store: f.store.contextCompactionStore(),
  });
  await reopened.reconcile();
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.reserve).toHaveBeenCalledTimes(1);
});

test('persisted threshold policy admits only confirmed exact-turn usage and refuses stale policy revisions, busy approvals and engine ownership', async () => {
  const f = fixture();
  await f.service.updatePolicy({
    conversationId: 'conversation',
    actorId: 'owner',
    expectedCurrentSessionId: 'conversation',
    expectedRevision: 0,
    threshold: 85,
    autoEnabled: true,
  });
  await expect(
    f.service.updatePolicy({
      conversationId: 'conversation',
      actorId: 'owner',
      expectedCurrentSessionId: 'conversation',
      expectedRevision: 0,
      threshold: 80,
      autoEnabled: true,
    }),
  ).rejects.toThrow('revision');
  for (const next of [
    { approvalPending: true },
    { approvalPending: false, atRest: false },
    { atRest: true, compactionOwner: 'engine' as const },
    {
      compactionOwner: 'station' as const,
      usage: {
        confirmed: true as const,
        sessionId: 'old',
        turnId: 'turn-1',
        contextTokens: 999,
        contextWindowTokens: 1000,
      },
    },
    {
      usage: {
        confirmed: true as const,
        sessionId: 'conversation',
        turnId: 'old',
        contextTokens: 999,
        contextWindowTokens: 1000,
      },
    },
    { usage: undefined },
  ]) {
    f.observe(next);
    expect((await f.service.request({ ...request, mode: 'auto' })).kind).toBe(
      'held',
    );
  }
  expect(f.generate).not.toHaveBeenCalled();
  f.observe({
    usage: {
      confirmed: true,
      sessionId: 'conversation',
      turnId: 'turn-1',
      contextTokens: 860,
      contextWindowTokens: 1000,
    },
  });
  expect(await f.service.request({ ...request, mode: 'auto' })).toMatchObject({
    kind: 'record',
    record: { state: 'reserved', policyRevision: 1 },
  });
});

test('observed refused generation usage survives retries, and unknown outcomes cannot be regenerated under another identity', async () => {
  const f = fixture();
  f.generate.mockResolvedValue({
    kind: 'failed',
    definite: true,
    reason: 'No structure model',
    model: 'summary-model',
    usage: { state: 'observed', inputTokens: 90, outputTokens: 180 },
  });
  expect(await f.service.request(request)).toMatchObject({
    kind: 'record',
    record: { state: 'failed' },
  });
  expect(await f.service.request(request)).toMatchObject({
    kind: 'held',
    reason: 'backoff',
  });
  expect(f.generate).toHaveBeenCalledTimes(1);
  f.advance();
  f.generate.mockResolvedValue({
    kind: 'failed',
    definite: false,
    reason: 'Provider result unknown',
  });
  await f.service.request(request);
  const restored = new ContextCompactionService({
    ...f.ports,
    store: f.store.contextCompactionStore(),
  });
  await restored.reconcile();
  f.observe({ sourceRevision: 'later-source' });
  await restored.request({ ...request, operationId: 'another-operation' });
  expect(f.generate).toHaveBeenCalledTimes(2);
  expect(f.reserve).not.toHaveBeenCalled();
  expect(
    restored.status(request.operationId, request.actorId)?.generationAttempts,
  ).toEqual([
    {
      attempt: 1,
      model: 'summary-model',
      usage: { state: 'observed', inputTokens: 90, outputTokens: 180 },
      outcome: 'refused',
    },
    { attempt: 2, usage: { state: 'unknown' }, outcome: 'unknown' },
  ]);
});

test('manual Task-state refresh before the first turn needs no model usage and persists trusted provenance', async () => {
  const f = fixture();
  f.observe({
    contextKind: 'task-state',
    turnId: '',
    usage: undefined,
    taskStateRevision: 'task-revision',
  });
  f.generate.mockResolvedValue({
    kind: 'task-state',
    text: 'Current bounded Task brief.',
    task: { taskId: 'task', taskCreatedAt: 'created', projectId: 'project' },
    taskStateRevision: 'task-revision',
    taskBriefDigest: 'a'.repeat(64),
    mandatoryContextDigest: 'b'.repeat(64),
    learningContributions: [],
  });
  expect(await f.service.request(request)).toMatchObject({
    kind: 'record',
    record: {
      state: 'reserved',
      seed: { kind: 'task-state', mandatoryContextDigest: 'b'.repeat(64) },
    },
  });
  expect(f.reserve.mock.calls[0][0].policy).toBe('task-state-next-cold-start');
});

test('forward boundary migration preserves old audit rows and refuses missing or malformed new seed shape', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(CONVERSATION_CONTEXT_BOUNDARY_MIGRATION);
    db.prepare(
      'INSERT INTO orchestration_conversation_context_boundaries(boundary_id,conversation_id,predecessor_session_id,successor_session_id,idempotency_key,policy,status,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      'old',
      'conversation',
      'a',
      'b',
      'key',
      'empty-next-cold-start',
      'consumed',
      'owner',
      '2026-10-30T00:00:00Z',
    );
    const before = db
      .prepare('SELECT * FROM orchestration_conversation_context_boundaries')
      .get();
    migrateContextSummaryBoundaries(db);
    const after = db
      .prepare('SELECT * FROM orchestration_conversation_context_boundaries')
      .get()!;
    expect(after).toMatchObject(before!);
    expect(after.seed_json).toBeNull();
    const insert = db.prepare(
      'INSERT INTO orchestration_conversation_context_boundaries(boundary_id,conversation_id,predecessor_session_id,successor_session_id,idempotency_key,policy,status,actor_id,created_at,seed_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
    );
    for (const seed of [null, '{}', '{"text":"summary"}'])
      expect(() =>
        insert.run(
          'new',
          'other',
          'x',
          'y',
          'new-key',
          'summary-next-cold-start',
          'reserved',
          'owner',
          'now',
          seed,
        ),
      ).toThrow();
    migrateContextSummaryBoundaries(db);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM orchestration_conversation_context_boundaries',
        )
        .get(),
    ).toMatchObject({ count: 1 });
  } finally {
    db.close();
  }
});
