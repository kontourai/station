import { expect, test } from 'vitest';
import type { ConversationContextBoundaryMarker } from '../conversation-context-boundary-module.js';
import type { ConversationSessionLineage } from '../conversation-session-lineage.js';
import {
  captureNativeMemoryContinuity,
  isNativeMemoryContinuityBinding,
  type NativeMemoryContinuityOwner,
  type NativeMemoryScope,
  type NativeMemorySessionIdentity,
} from '../native-memory-continuity.js';

function fixture() {
  const scope: NativeMemoryScope = {
    provider: 'station-agent',
    agentId: 'agent-a',
    userId: 'user-a',
    tenantId: 'tenant-a',
    projectId: 'project-a',
  };
  const lineage: ConversationSessionLineage[] = ['a', 'b', 'c'].map(
    (sessionId, ordinal) => ({
      conversationId: 'conversation',
      sessionId,
      ordinal,
      ...(ordinal ? { predecessorSessionId: ['a', 'b'][ordinal - 1] } : {}),
      createdAt: `2026-09-06T00:00:0${ordinal}Z`,
    }),
  );
  const sessions = new Map<string, NativeMemorySessionIdentity>(
    lineage.map((row) => [
      row.sessionId,
      { sessionId: row.sessionId, ...scope },
    ]),
  );
  const boundaries = new Map<string, ConversationContextBoundaryMarker>();
  const denied = new Set<string>();
  let authorized = true;
  const owner: NativeMemoryContinuityOwner = {
    conversationForSession: (id) => lineage.find((row) => row.sessionId === id),
    conversationSessions: () => lineage,
    contextBoundaryForSuccessor: (id) => boundaries.get(id),
    readSession: async (id) =>
      denied.has(id) ? null : (sessions.get(id) ?? null),
    isAuthorityCurrent: () => authorized,
  };
  const boundary = (
    policy: ConversationContextBoundaryMarker['policy'],
  ): ConversationContextBoundaryMarker => ({
    boundaryId: 'boundary-b',
    conversationId: 'conversation',
    predecessorSessionId: 'a',
    successorSessionId: 'b',
    idempotencyKey: 'key',
    policy,
    status: 'claimed',
    actorId: 'owner',
    createdAt: '2026-09-06T00:00:00Z',
  });
  return {
    scope,
    owner,
    lineage,
    sessions,
    boundaries,
    denied,
    boundary,
    revoke: () => {
      authorized = false;
    },
  };
}

test('same-engine native history preserves every chronological segment and current child once', async () => {
  const f = fixture();
  const binding = await captureNativeMemoryContinuity(
    { currentSessionId: 'c', scope: f.scope },
    f.owner,
  );
  expect(binding.sessionIds).toEqual(['a', 'b', 'c']);
  expect(binding.currentSessionId).toBe('c');
  expect(binding.cutReason).toBe('start');
  expect(await binding.isCurrent()).toBe(true);
  expect(Object.isFrozen(binding)).toBe(true);
  expect(Object.isFrozen(binding.sessionIds)).toBe(true);
  expect(isNativeMemoryContinuityBinding(binding)).toBe(true);
  expect(
    isNativeMemoryContinuityBinding(JSON.parse(JSON.stringify(binding))),
  ).toBe(false);
  expect(isNativeMemoryContinuityBinding({ ...binding })).toBe(false);
});

test('empty reset cuts before its successor while continuation keeps full native history', async () => {
  const f = fixture();
  f.boundaries.set('b', f.boundary('empty-next-cold-start'));
  const reset = await captureNativeMemoryContinuity(
    { currentSessionId: 'c', scope: f.scope },
    f.owner,
  );
  expect(reset.sessionIds).toEqual(['b', 'c']);
  expect(reset.cutReason).toBe('empty-context');
  f.boundaries.get('b')!.status = 'consumed';
  expect(await reset.isCurrent()).toBe(true);
  f.boundaries.get('b')!.policy = 'continue-from-history';
  expect(await reset.isCurrent()).toBe(false);
  const continued = await captureNativeMemoryContinuity(
    { currentSessionId: 'c', scope: f.scope },
    f.owner,
  );
  expect(continued.sessionIds).toEqual(['a', 'b', 'c']);
});

test.each([
  { provider: 'codex' },
  { agentId: 'agent-other' },
  { connectionId: 'connection-other' },
  { userId: 'user-other' },
  { tenantId: 'tenant-other' },
  { projectId: 'project-other' },
])(
  'identity transition %j cannot borrow predecessor native memory',
  async (change) => {
    const f = fixture();
    f.sessions.set('b', { ...f.sessions.get('b')!, ...change });
    const binding = await captureNativeMemoryContinuity(
      { currentSessionId: 'c', scope: f.scope },
      f.owner,
    );
    expect(binding.sessionIds).toEqual(['c']);
    expect(binding.cutReason).toBe('identity-change');
  },
);

test('denied predecessor, mismatched current identity and foreign lineage refuse without disclosing identities', async () => {
  const f = fixture();
  f.denied.add('b');
  await expect(
    captureNativeMemoryContinuity(
      { currentSessionId: 'c', scope: f.scope },
      f.owner,
    ),
  ).rejects.toThrow('authorized native conversation history is unavailable');
  f.denied.clear();
  f.sessions.set('c', {
    ...f.sessions.get('c')!,
    tenantId: 'foreign-tenant-private',
  });
  await expect(
    captureNativeMemoryContinuity(
      { currentSessionId: 'c', scope: f.scope },
      f.owner,
    ),
  ).rejects.not.toThrow('foreign-tenant-private');
  f.sessions.set('c', { sessionId: 'c', ...f.scope });
  f.lineage[1].conversationId = 'foreign-conversation';
  await expect(
    captureNativeMemoryContinuity(
      { currentSessionId: 'c', scope: f.scope },
      f.owner,
    ),
  ).rejects.toThrow('authorized native conversation history is unavailable');
});

test('authority, lineage-tail and prior-scope changes invalidate an issued capability', async () => {
  const f = fixture();
  const binding = await captureNativeMemoryContinuity(
    { currentSessionId: 'c', scope: f.scope },
    f.owner,
  );
  f.sessions.set('a', { ...f.sessions.get('a')!, userId: 'changed' });
  expect(await binding.isCurrent()).toBe(false);
  f.sessions.set('a', { sessionId: 'a', ...f.scope });
  f.lineage.push({
    conversationId: 'conversation',
    sessionId: 'd',
    ordinal: 3,
    predecessorSessionId: 'c',
    createdAt: 'later',
  });
  expect(await binding.isCurrent()).toBe(false);
  f.lineage.pop();
  f.revoke();
  expect(await binding.isCurrent()).toBe(false);
});

test('a context boundary changing during an awaited authorized read cannot issue a stale binding', async () => {
  const f = fixture();
  let reads = 0;
  f.owner.readSession = async (id) => {
    if (++reads === 3)
      f.boundaries.set('b', f.boundary('empty-next-cold-start'));
    return f.sessions.get(id)!;
  };
  await expect(
    captureNativeMemoryContinuity(
      { currentSessionId: 'c', scope: f.scope },
      f.owner,
    ),
  ).rejects.toThrow('authorized native conversation history is unavailable');
});

test('request identity is captured before the first await and malformed predecessor structure refuses', async () => {
  const f = fixture();
  const input = { currentSessionId: 'c', scope: { ...f.scope } };
  const pending = captureNativeMemoryContinuity(input, f.owner);
  input.currentSessionId = 'other';
  input.scope.agentId = 'other';
  const binding = await pending;
  expect(binding.currentSessionId).toBe('c');
  expect(binding.scope.agentId).toBe('agent-a');
  f.lineage[2].predecessorSessionId = 'a';
  expect(await binding.isCurrent()).toBe(false);
});
