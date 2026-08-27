import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  type LiveWorkAuthorization,
  type LiveWorkBounds,
  type LiveWorkCapability,
  type LiveWorkDependencies,
  type LiveWorkHistoryIntent,
  type LiveWorkIdentity,
  type LiveWorkPorts,
  type LiveWorkRecoveryAuthorization,
  LiveWorkSession,
} from '../live-work-session.js';
import type {
  CommittedRevision,
  EvidenceRevisionId,
} from '../revision-bound-evidence.js';

const scope = {
  projectId: 'project',
  taskId: 'task',
  surfaceId: 'surface',
  sessionId: 'session',
  channelId: 'channel',
} as const;
const grant = (
  actorId: string,
  capabilities: readonly LiveWorkCapability[] = [
    'join',
    'read',
    'write',
    'watch',
    'follow',
    'announce',
    'history-read',
  ],
): LiveWorkAuthorization => ({
  actorId,
  scope,
  capabilities: new Set(capabilities),
});
const recoveryGrant: LiveWorkRecoveryAuthorization = {
  kind: 'system',
  recoveryId: 'recovery',
  scope,
};
const identity = (
  actorId: string,
  occurrenceId = `occurrence-${actorId}`,
): LiveWorkIdentity => ({
  actor: {
    actorId,
    kind: actorId.startsWith('agent') ? 'agent' : 'human',
    label: `Server ${actorId}`,
  },
  occurrenceId,
  sessionId: 'session',
  runId: `run-${actorId}`,
  workName: `Implement ${actorId}`,
  workState: 'working',
  startedAt: 0,
  ttlClosureRequestId: `ttl-${actorId}`,
});
const dependencies = (
  identityFor: (actorId: string) => LiveWorkIdentity = identity,
): LiveWorkDependencies => ({
  identityAuthority: {
    resolve: ({ actorId }) => ({
      state: 'AVAILABLE',
      identity: identityFor(actorId),
    }),
  },
  recoveryAuthority: { authorize: () => true },
});
const join = (
  room: LiveWorkSession,
  actorId: string,
  now = 0,
  requestId = `join-${actorId}`,
) => room.join({ actorId, requestId }, grant(actorId), now);
const available = (room: LiveWorkSession, actorId: string, now: number) => {
  const result = room.snapshot(grant(actorId, ['read']), now);
  expect(result.outcome).toBe('available');
  return (result as Extract<typeof result, { outcome: 'available' }>).snapshot;
};
const historyPort = (
  intents: LiveWorkHistoryIntent[],
  outcomes: readonly ('committed' | 'refused' | 'indeterminate')[] = [
    'committed',
  ],
): NonNullable<LiveWorkPorts['history']> => ({
  commit: (intent) => {
    intents.push(intent);
    const state = outcomes[Math.min(intents.length - 1, outcomes.length - 1)]!;
    return state === 'refused' ? { state, reason: 'policy' } : { state };
  },
});
const recomputeIntentId = (intent: Record<string, any>): string => {
  const values: readonly (string | number)[] = [
    6,
    intent.scope.projectId,
    intent.scope.taskId,
    intent.scope.surfaceId,
    intent.scope.sessionId,
    intent.scope.channelId,
    intent.actor.actorId,
    intent.actor.kind,
    intent.actor.label,
    intent.kind,
    intent.requestId,
    intent.occurrenceId,
    intent.ordinal,
    intent.work.sessionId,
    intent.work.runId ?? '',
    intent.work.workName,
    intent.work.workState,
    intent.work.startedAt,
    intent.occurredAt,
    intent.kind === 'revision-reference' ? intent.revisionId : '',
  ];
  const canonical = values
    .map((value) => {
      const text = String(value);
      return `${Buffer.byteLength(text, 'utf8')}:${text}`;
    })
    .join('|');
  return `live-work-v6:${createHash('sha256').update(canonical).digest('hex')}`;
};
const revisionId =
  `revision-evidence-v1:${'a'.repeat(64)}` as EvidenceRevisionId;
const committedRevision = (
  id = revisionId,
  overrides: Partial<CommittedRevision> = {},
): CommittedRevision =>
  ({
    revisionId: id,
    scope: { projectId: 'project', taskId: 'task', documentId: 'doc' },
    correlation: {
      projectId: 'project',
      taskId: 'task',
      agentSessionId: 'session',
      runId: 'run-a',
    },
    ...overrides,
  }) as CommittedRevision;
const revisionDependencies = (
  resolve: () => unknown = () => ({
    state: 'AVAILABLE',
    revision: committedRevision(),
  }),
): LiveWorkDependencies => ({
  ...dependencies(),
  revisionAuthority: { resolveEvidence: resolve as never },
});

describe('LiveWorkSession v6', () => {
  test('derives actor and named work facts from server authority and publishes them honestly', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const room = new LiveWorkSession(
      scope,
      {},
      { history: historyPort(intents) },
      dependencies(),
    );
    expect(
      room.join(
        {
          actorId: 'agent-a',
          requestId: 'join-a',
          actor: { actorId: 'agent-a', kind: 'human', label: 'Spoof' },
        } as never,
        grant('agent-a'),
        0,
      ),
    ).toEqual({ outcome: 'invalid' });
    expect(join(room, 'agent-a', 0, 'join-a')).toEqual({ outcome: 'joined' });
    expect(available(room, 'other', 0).participants).toEqual([]);
    expect(
      room.announce(
        { actorId: 'agent-a', requestId: 'announce-a' },
        grant('agent-a'),
        1,
      ),
    ).toEqual({ outcome: 'updated' });
    expect(intents[0]).toMatchObject({
      actor: { actorId: 'agent-a', kind: 'agent', label: 'Server agent-a' },
      occurrenceId: 'occurrence-agent-a',
      requestId: 'announce-a',
      work: {
        sessionId: 'session',
        runId: 'run-agent-a',
        workName: 'Implement agent-a',
        workState: 'working',
        startedAt: 0,
      },
    });
  });

  test('uses one frozen closure for repeated departure while announcement commits', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const room = new LiveWorkSession(
      scope,
      {},
      {
        history: historyPort(intents, [
          'indeterminate',
          'committed',
          'indeterminate',
          'committed',
        ]),
      },
      dependencies(),
    );
    join(room, 'a');
    const announcement = room.announce(
      { actorId: 'a', requestId: 'announce' },
      grant('a'),
      1,
    ) as { intentId: string };
    const first = room.depart(
      { actorId: 'a', requestId: 'depart-one' },
      grant('a'),
      2,
    ) as { intentId: string };
    const second = room.depart(
      { actorId: 'a', requestId: 'depart-two' },
      grant('a'),
      3,
    );
    expect(second).toMatchObject({ intentId: first.intentId });
    expect(intents).toHaveLength(1);
    expect(room.reconcile(announcement.intentId, grant('a'), 4)).toMatchObject({
      intentId: first.intentId,
      state: 'indeterminate',
    });
    expect(intents.map((intent) => intent.requestId)).toEqual([
      'announce',
      'announce',
      'depart-one',
    ]);
    expect(room.reconcile(first.intentId, grant('a', ['join']), 5)).toEqual({
      outcome: 'updated',
    });
    expect(intents[3]).toMatchObject({
      intentId: first.intentId,
      occurredAt: 2,
      requestId: 'depart-one',
    });
  });

  test('terminalizes one closure without emitting it when ambiguous announcement refuses', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const room = new LiveWorkSession(
      scope,
      {},
      { history: historyPort(intents, ['indeterminate', 'refused']) },
      dependencies(),
    );
    join(room, 'a');
    const announcement = room.announce(
      { actorId: 'a', requestId: 'announce' },
      grant('a'),
      1,
    ) as { intentId: string };
    const closure = room.withdrawAnnouncement(
      { actorId: 'a', requestId: 'withdraw-one' },
      grant('a'),
      2,
    ) as { intentId: string };
    expect(
      room.withdrawAnnouncement(
        { actorId: 'a', requestId: 'withdraw-two' },
        grant('a'),
        3,
      ),
    ).toMatchObject({ intentId: closure.intentId });
    expect(room.reconcile(announcement.intentId, grant('a'), 4)).toMatchObject({
      state: 'refused',
    });
    expect(intents).toHaveLength(2);
    expect(room.reconcile(closure.intentId, grant('a'), 5)).toMatchObject({
      outcome: 'degraded',
      state: 'refused',
      intentId: closure.intentId,
    });
    expect(room.replay(grant('a', ['history-read']), 5)).toMatchObject({
      outcome: 'available',
      events: [],
    });
  });

  test('removes explicit departure from presence and pauses followers before durable closure settles', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const room = new LiveWorkSession(
      scope,
      {},
      { history: historyPort(intents, ['committed', 'indeterminate']) },
      dependencies(),
    );
    join(room, 'target');
    room.announce(
      { actorId: 'target', requestId: 'announce' },
      grant('target'),
      1,
    );
    room.follow(
      { actorId: 'viewer', paneId: 'pane', targetActorId: 'target' },
      grant('viewer'),
      2,
    );
    const closure = room.depart(
      { actorId: 'target', requestId: 'depart' },
      grant('target'),
      3,
    );
    expect(closure).toMatchObject({ state: 'indeterminate' });
    const view = available(room, 'viewer', 3);
    expect(view.participants).toEqual([]);
    expect(view.panes).toEqual([
      {
        actorId: 'viewer',
        paneId: 'pane',
        state: 'paused',
        reason: 'target_departed',
      },
    ]);
    expect(
      room.depart(
        { actorId: 'target', requestId: 'different' },
        grant('target'),
        4,
      ),
    ).toMatchObject(closure);
  });

  test('withdraw hides published work and follow edges immediately while retaining private join', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const room = new LiveWorkSession(
      scope,
      {},
      { history: historyPort(intents, ['committed', 'indeterminate']) },
      dependencies(),
    );
    join(room, 'target');
    room.announce(
      { actorId: 'target', requestId: 'announce' },
      grant('target'),
      1,
    );
    room.watch(
      { actorId: 'viewer', paneId: 'pane', targetActorId: 'target' },
      grant('viewer'),
      2,
    );
    room.withdrawAnnouncement(
      { actorId: 'target', requestId: 'withdraw' },
      grant('target'),
      3,
    );
    expect(available(room, 'viewer', 3).participants).toEqual([]);
    expect(available(room, 'target', 3).participants).toMatchObject([
      { publication: 'private' },
    ]);
    expect(available(room, 'viewer', 3).panes[0]).toMatchObject({
      state: 'paused',
    });
  });

  test('rejects foreign reconciliation before prune, clock mutation, or port call', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const room = new LiveWorkSession(
      scope,
      {},
      { history: historyPort(intents, ['indeterminate', 'committed']) },
      dependencies(),
    );
    join(room, 'a');
    const pending = room.announce(
      { actorId: 'a', requestId: 'announce' },
      grant('a'),
      1,
    ) as { intentId: string };
    expect(room.reconcile(pending.intentId, grant('foreign'), 99)).toEqual({
      outcome: 'forbidden',
    });
    expect(intents).toHaveLength(1);
    expect(available(room, 'a', 2).participants).toHaveLength(1);
  });

  test('rejects invalid snapshot, replay, and reconcile times without poisoning safe clock', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const room = new LiveWorkSession(
      scope,
      {},
      { history: historyPort(intents, ['indeterminate', 'committed']) },
      dependencies(),
    );
    join(room, 'a');
    const pending = room.announce(
      { actorId: 'a', requestId: 'announce' },
      grant('a'),
      1,
    ) as { intentId: string };
    expect(room.snapshot(grant('a', ['read']), Number.NaN)).toEqual({
      outcome: 'invalid',
    });
    expect(room.replay(grant('a', ['history-read']), -1)).toEqual({
      outcome: 'invalid',
    });
    expect(
      room.reconcile(pending.intentId, grant('a'), Number.MAX_SAFE_INTEGER),
    ).toEqual({ outcome: 'invalid' });
    expect(room.reconcile(pending.intentId, grant('a'), 2)).toEqual({
      outcome: 'updated',
    });
    expect(
      room.setTyping({ actorId: 'a', active: 'yes' } as never, grant('a'), 99),
    ).toEqual({ outcome: 'invalid' });
    expect(room.snapshot(grant('a', ['read']), 2).outcome).toBe('available');
    expect(room.snapshot(grant('a', ['read']), 1)).toEqual({
      outcome: 'invalid',
    });
  });

  test('reserves mandatory closure count and bytes before calling history port', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const countBounded = new LiveWorkSession(
      scope,
      { maxPendingIntents: 1 },
      { history: historyPort(intents, ['indeterminate']) },
      dependencies(),
    );
    join(countBounded, 'a');
    expect(
      countBounded.announce(
        { actorId: 'a', requestId: 'announce' },
        grant('a'),
        1,
      ),
    ).toEqual({ outcome: 'capacity_exceeded' });
    const byteBounded = new LiveWorkSession(
      scope,
      { maxPendingBytes: 64 },
      { history: historyPort(intents, ['indeterminate']) },
      dependencies(),
    );
    join(byteBounded, 'b');
    expect(
      byteBounded.announce(
        { actorId: 'b', requestId: 'announce' },
        grant('b'),
        1,
      ),
    ).toEqual({ outcome: 'capacity_exceeded' });
    expect(intents).toEqual([]);
  });

  test('requires exact server identity and rejects unavailable or malformed identity authority', () => {
    const unavailable = new LiveWorkSession(
      scope,
      {},
      {},
      dependencies(() => ({
        ...identity('other'),
        actor: { ...identity('other').actor, actorId: 'other' },
      })),
    );
    expect(join(unavailable, 'a')).toEqual({ outcome: 'unavailable' });
    const malformed = new LiveWorkSession(
      scope,
      {},
      {},
      {
        identityAuthority: {
          resolve: () => ({
            state: 'AVAILABLE',
            identity: { actor: {} } as never,
          }),
        },
      },
    );
    expect(join(malformed, 'a')).toEqual({ outcome: 'unavailable' });
  });

  test('requires exact requested revision and session/run correlation', () => {
    const revisionCalls: unknown[] = [];
    const mismatchedId = new LiveWorkSession(
      scope,
      {},
      {
        history: { commit: () => ({ state: 'committed' }) },
        revision: {
          commit: (intent) => {
            revisionCalls.push(intent);
            return { state: 'committed' };
          },
        },
      },
      revisionDependencies(() => ({
        state: 'AVAILABLE',
        revision: committedRevision(
          `revision-evidence-v1:${'b'.repeat(64)}` as EvidenceRevisionId,
        ),
      })),
    );
    join(mismatchedId, 'a');
    mismatchedId.announce(
      { actorId: 'a', requestId: 'announce' },
      grant('a'),
      1,
    );
    expect(
      mismatchedId.referenceRevision(
        {
          actorId: 'a',
          requestId: 'revision',
          reference: { revisionId, verification: 'verified' },
        },
        grant('a'),
        2,
      ),
    ).toEqual({ outcome: 'invalid' });
    const malformed = new LiveWorkSession(
      scope,
      {},
      {
        history: { commit: () => ({ state: 'committed' }) },
        revision: { commit: () => ({ state: 'committed' }) },
      },
      revisionDependencies(() => ({
        state: 'AVAILABLE',
        revision: { revisionId },
      })),
    );
    join(malformed, 'a');
    malformed.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    expect(
      malformed.referenceRevision(
        {
          actorId: 'a',
          requestId: 'revision',
          reference: { revisionId, verification: 'verified' },
        },
        grant('a'),
        2,
      ),
    ).toEqual({ outcome: 'invalid' });
    expect(revisionCalls).toEqual([]);
  });

  test('recovers frozen pending chain after restart without a current actor grant', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = {
      history: historyPort(intents, [
        'indeterminate',
        'committed',
        'committed',
      ]),
    };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    join(room, 'a');
    const announcement = room.announce(
      { actorId: 'a', requestId: 'announce' },
      grant('a'),
      1,
    ) as { intentId: string };
    room.depart({ actorId: 'a', requestId: 'depart' }, grant('a'), 2);
    const exported = room.exportRecovery(recoveryGrant, 3);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const restored = LiveWorkSession.restore(
      scope,
      exported.state,
      recoveryGrant,
      4,
      {},
      ports,
      dependencies(),
    );
    expect(restored.outcome).toBe('available');
    if (restored.outcome !== 'available') return;
    expect(
      restored.session.reconcile(announcement.intentId, grant('a', []), 5),
    ).toEqual({ outcome: 'forbidden' });
    expect(
      restored.session.recover(announcement.intentId, recoveryGrant, 5),
    ).toEqual({ outcome: 'updated' });
    expect(intents.map((intent) => intent.requestId)).toEqual([
      'announce',
      'announce',
      'depart',
    ]);
    expect(
      restored.session.replay(grant('reader', ['history-read']), 5),
    ).toMatchObject({
      events: [{ kind: 'announce' }, { kind: 'departure' }],
    });
  });

  test('exports a restart closure for committed publication and rejects missing recovery port', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents) };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    const exported = room.exportRecovery(recoveryGrant, 2);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const closure = exported.state.pending.find(
      (pending) => pending.intent.kind === 'departure',
    );
    expect(closure).toBeDefined();
    const tampered = structuredClone(exported.state) as unknown as {
      pending: { intent: { requestId: string } }[];
    };
    tampered.pending[0]!.intent.requestId = 'tampered';
    expect(
      LiveWorkSession.restore(
        scope,
        tampered,
        recoveryGrant,
        4,
        {},
        ports,
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
    const repeated = room.exportRecovery(recoveryGrant, 3);
    expect(repeated.outcome).toBe('available');
    if (repeated.outcome === 'available')
      expect(
        repeated.state.pending.find(
          (pending) => pending.intent.kind === 'departure',
        )?.intent.intentId,
      ).toBe(closure?.intent.intentId);
    expect(
      LiveWorkSession.restore(
        scope,
        exported.state,
        recoveryGrant,
        4,
        {},
        {},
        dependencies(),
      ),
    ).toEqual({ outcome: 'unavailable' });
    const restored = LiveWorkSession.restore(
      scope,
      exported.state,
      recoveryGrant,
      4,
      {},
      ports,
      dependencies(),
    );
    expect(restored.outcome).toBe('available');
    if (restored.outcome === 'available')
      expect(
        restored.session.recover(closure!.intent.intentId, recoveryGrant, 4),
      ).toEqual({ outcome: 'updated' });
  });

  test('bounds actor reconciliation and system recovery with separate rate budgets', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const bounds: Partial<LiveWorkBounds> = {
      rateWindowMs: 10,
      maxTransitionsPerWindow: 2,
      maxTransitionTimestamps: 2,
      maxRecoveriesPerWindow: 1,
      maxRecoveryTimestamps: 1,
    };
    const room = new LiveWorkSession(
      scope,
      bounds,
      { history: historyPort(intents, ['indeterminate', 'committed']) },
      dependencies(),
    );
    join(room, 'a'); // actor budget 1
    const pending = room.announce(
      { actorId: 'a', requestId: 'announce' },
      grant('a'),
      1,
    ) as { intentId: string }; // actor budget 2
    expect(room.reconcile(pending.intentId, grant('a'), 2)).toEqual({
      outcome: 'rate_limited',
    });
    const exported = room.exportRecovery(recoveryGrant, 2);
    expect(exported.outcome).toBe('available');
    expect(room.exportRecovery(recoveryGrant, 3)).toEqual({
      outcome: 'rate_limited',
    });
    expect(room.reconcile(pending.intentId, grant('a'), 11)).toEqual({
      outcome: 'updated',
    });
  });

  test('keeps private joins/departures out of material replay and never reconstructs presence', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const room = new LiveWorkSession(
      scope,
      {},
      { history: historyPort(intents) },
      dependencies(),
    );
    join(room, 'private');
    room.depart(
      { actorId: 'private', requestId: 'depart-private' },
      grant('private'),
      1,
    );
    expect(intents).toEqual([]);
    expect(room.replay(grant('reader', ['history-read']), 1)).toMatchObject({
      events: [],
    });
    const exported = room.exportRecovery(recoveryGrant, 1);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const restored = LiveWorkSession.restore(
      scope,
      exported.state,
      recoveryGrant,
      2,
      {},
      { history: historyPort(intents) },
      dependencies(),
    );
    expect(restored.outcome).toBe('available');
    if (restored.outcome === 'available')
      expect(available(restored.session, 'private', 2).participants).toEqual(
        [],
      );
  });

  test('canonical scalar order is stable while server occurrence makes independent IDs unique', () => {
    const capture = (
      identityFor: (actorId: string) => LiveWorkIdentity,
    ): string => {
      const intents: LiveWorkHistoryIntent[] = [];
      const room = new LiveWorkSession(
        scope,
        {},
        { history: historyPort(intents) },
        dependencies(identityFor),
      );
      join(room, 'a', 0, 'join');
      room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
      return intents[0]!.intentId;
    };
    const ordered = capture(() => identity('a', 'same-occurrence'));
    const reversed = capture(() => {
      const source = identity('a', 'same-occurrence');
      return {
        ttlClosureRequestId: source.ttlClosureRequestId,
        startedAt: source.startedAt,
        workState: source.workState,
        workName: source.workName,
        runId: source.runId,
        sessionId: source.sessionId,
        occurrenceId: source.occurrenceId,
        actor: source.actor,
      };
    });
    const independent = capture(() => identity('a', 'different-occurrence'));
    expect(reversed).toBe(ordered);
    expect(independent).not.toBe(ordered);
    expect(ordered).toMatch(/^live-work-v6:[a-f0-9]{64}$/);
  });

  test('supports write-only revision reconciliation and totalizes malformed ports', () => {
    const revisionIntents: { intentId: string }[] = [];
    let revisionCalls = 0;
    const room = new LiveWorkSession(
      scope,
      {},
      {
        history: { commit: () => ({ state: 'committed' }) },
        revision: {
          commit: (intent) => {
            revisionIntents.push(intent);
            revisionCalls++;
            return revisionCalls === 1
              ? { state: 'indeterminate' }
              : { state: 'committed' };
          },
        },
      },
      revisionDependencies(),
    );
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    const pending = room.referenceRevision(
      {
        actorId: 'a',
        requestId: 'revision',
        reference: { revisionId, verification: 'verified' },
      },
      grant('a'),
      2,
    ) as { intentId: string };
    expect(room.reconcile(pending.intentId, grant('a', ['write']), 3)).toEqual({
      outcome: 'updated',
    });
    expect(revisionIntents[0]!.intentId).toBe(revisionIntents[1]!.intentId);
    const malformed = new LiveWorkSession(
      scope,
      {},
      { history: { commit: () => ({ state: 'other' }) as never } },
      dependencies(),
    );
    join(malformed, 'b');
    expect(
      malformed.announce(
        { actorId: 'b', requestId: 'announce' },
        grant('b'),
        1,
      ),
    ).toMatchObject({ state: 'indeterminate' });
  });

  test('keeps follow local-exit, pane switching, paused expiry, typing TTL, and cloning', () => {
    const room = new LiveWorkSession(
      scope,
      { ttlMs: 20, pausedTtlMs: 2, typingTtlMs: 2, maxViewerPanes: 1 },
      { history: { commit: () => ({ state: 'committed' }) } },
      dependencies(),
    );
    for (const actorId of ['a', 'b']) {
      join(room, actorId, 0);
      room.announce(
        { actorId, requestId: `announce-${actorId}` },
        grant(actorId),
        1,
      );
    }
    room.watch(
      { actorId: 'viewer', paneId: 'pane', targetActorId: 'a' },
      grant('viewer'),
      2,
    );
    room.follow(
      { actorId: 'viewer', paneId: 'pane', targetActorId: 'b' },
      grant('viewer'),
      3,
    );
    expect(
      room.localInput(
        { actorId: 'viewer', paneId: 'pane' },
        grant('viewer', []),
        4,
      ),
    ).toEqual({ outcome: 'cleared' });
    expect(
      room.follow(
        { actorId: 'viewer', paneId: 'pane', targetActorId: 'a' },
        grant('viewer'),
        4,
      ),
    ).toEqual({ outcome: 'updated' });
    expect(available(room, 'viewer', 4).panes).toHaveLength(1);
    room.setTyping({ actorId: 'a', active: true }, grant('a'), 4);
    room.depart({ actorId: 'a', requestId: 'depart-a' }, grant('a'), 5);
    const snapshot = available(room, 'viewer', 5);
    expect(snapshot.panes[0]).toMatchObject({ state: 'paused' });
    (snapshot.panes as unknown as { state: string }[])[0]!.state = 'mutated';
    expect(available(room, 'viewer', 5).panes[0]).toMatchObject({
      state: 'paused',
    });
    expect(available(room, 'viewer', 7).panes).toEqual([]);
  });

  test('expires published presence only after retaining a durable closure obligation', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const room = new LiveWorkSession(
      scope,
      { ttlMs: 2 },
      { history: historyPort(intents) },
      dependencies(),
    );
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    expect(available(room, 'reader', 2).participants).toEqual([]);
    const exported = room.exportRecovery(recoveryGrant, 2);
    expect(exported.outcome).toBe('available');
    if (exported.outcome === 'available')
      expect(
        exported.state.pending.some(
          (pending) => pending.intent.kind === 'departure',
        ),
      ).toBe(true);
  });

  test('fails absent configured ports before creating unrecoverable obligations', () => {
    const room = new LiveWorkSession(scope, {}, {}, dependencies());
    join(room, 'a');
    expect(
      room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1),
    ).toEqual({ outcome: 'unavailable' });
    const exported = room.exportRecovery(recoveryGrant, 2);
    expect(exported).toMatchObject({
      outcome: 'available',
      state: { pending: [] },
    });
  });

  test('rejects orphan, self-cyclic, missing, and terminal-refused dependency graphs', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents, ['indeterminate']) };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    room.depart({ actorId: 'a', requestId: 'depart' }, grant('a'), 2);
    const exported = room.exportRecovery(recoveryGrant, 3);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const restore = (state: unknown) =>
      LiveWorkSession.restore(
        scope,
        state,
        recoveryGrant,
        4,
        {},
        ports,
        dependencies(),
      );
    const orphan = structuredClone(exported.state) as any;
    orphan.lifecycles = [];
    expect(restore(orphan)).toEqual({ outcome: 'invalid' });
    const cyclic = structuredClone(exported.state) as any;
    const closure = cyclic.pending.find(
      (pending: any) => pending.intent.kind === 'departure',
    );
    closure.afterIntentId = closure.intent.intentId;
    expect(restore(cyclic)).toEqual({ outcome: 'invalid' });
    const missing = structuredClone(exported.state) as any;
    missing.pending.find(
      (pending: any) => pending.intent.kind === 'departure',
    ).afterIntentId = `live-work-v6:${'f'.repeat(64)}`;
    expect(restore(missing)).toEqual({ outcome: 'invalid' });
    const refused = structuredClone(exported.state) as any;
    const announcementIndex = refused.pending.findIndex(
      (pending: any) => pending.intent.kind === 'announce',
    );
    const [announcement] = refused.pending.splice(announcementIndex, 1);
    refused.terminal.push({
      intent: announcement.intent,
      port: announcement.port,
      capability: announcement.capability,
      actorId: announcement.actorId,
      lifecycleId: announcement.lifecycleId,
      result: 'refused',
    });
    expect(restore(refused)).toEqual({ outcome: 'invalid' });
    expect(intents).toHaveLength(1);
  });

  test('rejects replay duplicates, digest mismatches, ghosts, and missing open closure truth', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents) };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    const exported = room.exportRecovery(recoveryGrant, 2);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const restore = (state: unknown) =>
      LiveWorkSession.restore(
        scope,
        state,
        recoveryGrant,
        3,
        {},
        ports,
        dependencies(),
      );
    const duplicate = structuredClone(exported.state) as any;
    duplicate.replay.push(structuredClone(duplicate.replay[0]));
    expect(restore(duplicate)).toEqual({ outcome: 'invalid' });
    const mismatch = structuredClone(exported.state) as any;
    mismatch.replay[0].requestId = 'different';
    expect(restore(mismatch)).toEqual({ outcome: 'invalid' });
    const ghost = structuredClone(exported.state) as any;
    ghost.terminal = [];
    expect(restore(ghost)).toEqual({ outcome: 'invalid' });
    const noClosure = structuredClone(exported.state) as any;
    noClosure.pending = noClosure.pending.filter(
      (pending: any) => pending.intent.kind !== 'departure',
    );
    noClosure.lifecycles[0].closureId = undefined;
    noClosure.lifecycles[0].state = 'published';
    noClosure.lifecycles[0].reservedClosureBytes = 0;
    expect(restore(noClosure)).toEqual({ outcome: 'invalid' });
  });

  test('persists transition and recovery rate ledgers and rejects ledger tampering', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const bounds: Partial<LiveWorkBounds> = {
      rateWindowMs: 10,
      maxTransitionsPerWindow: 2,
      maxTransitionTimestamps: 2,
      maxRecoveriesPerWindow: 2,
      maxRecoveryTimestamps: 2,
    };
    const ports = { history: historyPort(intents, ['indeterminate']) };
    const room = new LiveWorkSession(scope, bounds, ports, dependencies());
    join(room, 'a', 0);
    const pending = room.announce(
      { actorId: 'a', requestId: 'announce' },
      grant('a'),
      1,
    ) as { intentId: string };
    const exported = room.exportRecovery(recoveryGrant, 1);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const restored = LiveWorkSession.restore(
      scope,
      exported.state,
      recoveryGrant,
      1,
      bounds,
      ports,
      dependencies(),
    );
    expect(restored.outcome).toBe('available');
    if (restored.outcome === 'available') {
      expect(
        restored.session.reconcile(pending.intentId, grant('a'), 1),
      ).toEqual({ outcome: 'rate_limited' });
      expect(
        restored.session.recover(pending.intentId, recoveryGrant, 1),
      ).toEqual({ outcome: 'rate_limited' });
    }
    const unsorted = structuredClone(exported.state) as any;
    unsorted.transitionTimes = [
      { principalId: 'a', at: 1 },
      { principalId: 'a', at: 0 },
    ];
    expect(
      LiveWorkSession.restore(
        scope,
        unsorted,
        recoveryGrant,
        2,
        bounds,
        ports,
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
    const invalidPrincipal = structuredClone(exported.state) as any;
    invalidPrincipal.recoveryTimes[0].principalId = '';
    expect(
      LiveWorkSession.restore(
        scope,
        invalidPrincipal,
        recoveryGrant,
        2,
        bounds,
        ports,
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
  });

  test('totalizes hostile proxies, accessors, cyclic recovery, and malformed port outcomes', () => {
    const throwing = new Proxy(
      { actorId: 'a', requestId: 'join' },
      {
        get: () => {
          throw new Error('hostile');
        },
      },
    );
    const room = new LiveWorkSession(scope, {}, {}, dependencies());
    expect(room.join(throwing, grant('a'), 0)).toEqual({ outcome: 'invalid' });
    let getterCalls = 0;
    const accessor = { requestId: 'join' } as {
      actorId?: string;
      requestId: string;
    };
    Object.defineProperty(accessor, 'actorId', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'a';
      },
    });
    expect(room.join(accessor as never, grant('a'), 0)).toEqual({
      outcome: 'invalid',
    });
    expect(getterCalls).toBe(0);
    const hostileIdentity = new LiveWorkSession(
      scope,
      {},
      {},
      {
        identityAuthority: {
          resolve: () =>
            new Proxy(
              { state: 'AVAILABLE', identity: identity('a') } as const,
              {
                get: () => {
                  throw new Error('identity');
                },
              },
            ),
        },
      },
    );
    expect(join(hostileIdentity, 'a')).toEqual({ outcome: 'unavailable' });
    const intents: LiveWorkHistoryIntent[] = [];
    const hostileRevision = new LiveWorkSession(
      scope,
      {},
      {
        history: historyPort(intents),
        revision: { commit: () => ({ state: 'committed' }) },
      },
      {
        ...dependencies(),
        revisionAuthority: {
          resolveEvidence: () =>
            new Proxy(
              { state: 'AVAILABLE', revision: committedRevision() } as const,
              {
                get: () => {
                  throw new Error('revision');
                },
              },
            ),
        },
      },
    );
    join(hostileRevision, 'a');
    hostileRevision.announce(
      { actorId: 'a', requestId: 'announce' },
      grant('a'),
      1,
    );
    expect(
      hostileRevision.referenceRevision(
        {
          actorId: 'a',
          requestId: 'revision',
          reference: { revisionId, verification: 'verified' },
        },
        grant('a'),
        2,
      ),
    ).toEqual({ outcome: 'invalid' });
    expect(
      LiveWorkSession.restore(
        scope,
        new Proxy(
          {},
          {
            get: () => {
              throw new Error('restore');
            },
          },
        ),
        recoveryGrant,
        1,
        {},
        { history: historyPort(intents) },
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
    const cyclic: any = {};
    cyclic.schemaVersion = 'station.live-work-recovery/v3';
    cyclic.scope = cyclic;
    expect(
      LiveWorkSession.restore(
        scope,
        cyclic,
        recoveryGrant,
        1,
        {},
        { history: historyPort(intents) },
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
    const hostilePort = new LiveWorkSession(
      scope,
      {},
      {
        history: {
          commit: () =>
            new Proxy({ state: 'committed' } as const, {
              get: () => {
                throw new Error('port');
              },
            }),
        },
      },
      dependencies(),
    );
    join(hostilePort, 'b');
    expect(
      hostilePort.announce(
        { actorId: 'b', requestId: 'announce' },
        grant('b'),
        1,
      ),
    ).toMatchObject({ state: 'indeterminate' });
  });

  test('rejects ordinal exhaustion before any next event can overflow', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents) };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    const exported = room.exportRecovery(recoveryGrant, 2);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const exhausted = structuredClone(exported.state) as any;
    exhausted.nextOrdinal = Number.MAX_SAFE_INTEGER - 1;
    expect(
      LiveWorkSession.restore(
        scope,
        exhausted,
        recoveryGrant,
        3,
        {},
        ports,
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
  });

  test('replays committed and refused terminal closure outcomes without another port call', () => {
    const committedIntents: LiveWorkHistoryIntent[] = [];
    const committed = new LiveWorkSession(
      scope,
      {},
      { history: historyPort(committedIntents) },
      dependencies(),
    );
    join(committed, 'a');
    expect(
      committed.announce(
        { actorId: 'a', requestId: 'announce' },
        grant('a'),
        1,
      ),
    ).toEqual({ outcome: 'updated' });
    const committedState = committed.exportRecovery(recoveryGrant, 1);
    expect(committedState).toMatchObject({
      outcome: 'available',
      state: {
        pending: [{ intent: { kind: 'departure' } }],
        terminal: [{ intent: { kind: 'announce' }, result: 'committed' }],
      },
    });
    if (committedState.outcome === 'available')
      expect(committedState.state.pending[0]!.intent.intentId).not.toBe(
        committedState.state.terminal[0]!.intent.intentId,
      );
    const committedDeparture = committed.depart(
      { actorId: 'a', requestId: 'depart' },
      grant('a'),
      2,
    );
    expect(committedDeparture).toEqual({ outcome: 'updated' });
    expect(committedIntents).toHaveLength(2);
    const committedClosureId = committedIntents[1]!.intentId;
    expect(
      committed.depart({ actorId: 'a', requestId: 'different' }, grant('a'), 3),
    ).toEqual({ outcome: 'departed' });
    expect(committed.recover(committedClosureId, recoveryGrant, 4)).toEqual({
      outcome: 'departed',
    });
    expect(committedIntents).toHaveLength(2);

    const refusedIntents: LiveWorkHistoryIntent[] = [];
    const refused = new LiveWorkSession(
      scope,
      {},
      { history: historyPort(refusedIntents, ['committed', 'refused']) },
      dependencies(),
    );
    join(refused, 'b');
    refused.announce({ actorId: 'b', requestId: 'announce' }, grant('b'), 1);
    const first = refused.depart(
      { actorId: 'b', requestId: 'depart' },
      grant('b'),
      2,
    );
    expect(first).toMatchObject({ state: 'refused' });
    expect(
      refused.depart({ actorId: 'b', requestId: 'different' }, grant('b'), 3),
    ).toMatchObject(first);
    expect(
      refused.recover(refusedIntents[1]!.intentId, recoveryGrant, 4),
    ).toMatchObject(first);
    expect(refusedIntents).toHaveLength(2);
  });

  test('requires exact optional run equality in both directions', () => {
    const reference = { revisionId, verification: 'verified' as const };
    const makeRoom = (
      liveRunId: string | undefined,
      revisionRunId: string | undefined,
    ) => {
      let writes = 0;
      const room = new LiveWorkSession(
        scope,
        {},
        {
          history: { commit: () => ({ state: 'committed' }) },
          revision: {
            commit: () => {
              writes += 1;
              return { state: 'committed' };
            },
          },
        },
        {
          ...dependencies((actorId) => ({
            ...identity(actorId),
            runId: liveRunId,
          })),
          revisionAuthority: {
            resolveEvidence: () => ({
              state: 'AVAILABLE',
              revision: committedRevision(revisionId, {
                correlation: {
                  projectId: 'project',
                  taskId: 'task',
                  agentSessionId: 'session',
                  ...(revisionRunId ? { runId: revisionRunId } : {}),
                },
              }),
            }),
          },
        },
      );
      join(room, 'a');
      room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
      const outcome = room.referenceRevision(
        { actorId: 'a', requestId: 'revision', reference },
        grant('a'),
        2,
      );
      return { outcome, writes };
    };
    expect(makeRoom(undefined, undefined)).toMatchObject({
      outcome: { outcome: 'updated' },
      writes: 1,
    });
    expect(makeRoom(undefined, 'run-a')).toMatchObject({
      outcome: { outcome: 'invalid' },
      writes: 0,
    });
    expect(makeRoom('run-a', undefined)).toMatchObject({
      outcome: { outcome: 'invalid' },
      writes: 0,
    });
    expect(makeRoom('run-a', 'run-a')).toMatchObject({
      outcome: { outcome: 'updated' },
      writes: 1,
    });
  });

  test('rejects refresh identity drift without extending original TTL', () => {
    let resolution = 0;
    const room = new LiveWorkSession(
      scope,
      { ttlMs: 2 },
      {},
      {
        ...dependencies(),
        identityAuthority: {
          resolve: ({ actorId }) => {
            resolution += 1;
            return {
              state: 'AVAILABLE',
              identity: {
                ...identity(actorId),
                actor: {
                  ...identity(actorId).actor,
                  label: resolution === 1 ? 'Original' : 'Drifted',
                },
              },
            };
          },
        },
      },
    );
    expect(join(room, 'a', 0, 'join')).toEqual({ outcome: 'joined' });
    expect(join(room, 'a', 1, 'join')).toEqual({
      outcome: 'identity_changed',
    });
    expect(available(room, 'a', 2).participants).toEqual([]);
  });

  test('restores a self-contained replay suffix after terminal history rolls over', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const bounds: Partial<LiveWorkBounds> = {
      maxTransitionsPerWindow: 512,
      maxTransitionTimestamps: 512,
    };
    const ports = { history: historyPort(intents) };
    const room = new LiveWorkSession(scope, bounds, ports, dependencies());
    for (let index = 0; index < 65; index += 1) {
      const actorId = `actor-${index}`;
      const at = index * 3;
      join(room, actorId, at);
      room.announce(
        { actorId, requestId: `announce-${index}` },
        grant(actorId),
        at + 1,
      );
      room.depart(
        { actorId, requestId: `depart-${index}` },
        grant(actorId),
        at + 2,
      );
    }
    expect(intents).toHaveLength(130);
    const exported = room.exportRecovery(recoveryGrant, 196);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    expect(exported.state.terminal).toHaveLength(128);
    expect(exported.state.replay).toHaveLength(128);
    expect(exported.state.replay[0]).toMatchObject({ kind: 'announce' });
    const restored = LiveWorkSession.restore(
      scope,
      exported.state,
      recoveryGrant,
      197,
      bounds,
      ports,
      dependencies(),
    );
    expect(restored.outcome).toBe('available');
    if (restored.outcome === 'available')
      expect(
        restored.session.replay(grant('reader', ['history-read']), 197),
      ).toEqual({
        outcome: 'available',
        events: exported.state.replay,
      });
  });

  test('reserves the exact UTF-8 closure ceiling before removing presence', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const room = new LiveWorkSession(
      scope,
      { maxIdLength: 128 },
      { history: historyPort(intents) },
      dependencies(),
    );
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    expect(
      room.depart(
        { actorId: 'a', requestId: '\u0800'.repeat(128) },
        grant('a'),
        2,
      ),
    ).toEqual({ outcome: 'updated' });
    expect(intents).toHaveLength(2);
    expect(available(room, 'reader', 2).participants).toEqual([]);
  });

  test('rejects a recomputed foreign closure bound to another announcement actor', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents) };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    room.depart({ actorId: 'a', requestId: 'depart' }, grant('a'), 2);
    const exported = room.exportRecovery(recoveryGrant, 3);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const forged = structuredClone(exported.state) as any;
    const closure = forged.terminal.find(
      (record: any) => record.intent.kind === 'departure',
    );
    closure.actorId = 'mallory';
    closure.intent.actor = {
      actorId: 'mallory',
      kind: 'human',
      label: 'Server mallory',
    };
    closure.intent.occurrenceId = 'occurrence-mallory';
    closure.intent.intentId = recomputeIntentId(closure.intent);
    const replayClosure = forged.replay.find(
      (event: any) => event.kind === 'departure',
    );
    Object.assign(replayClosure, closure.intent);
    expect(
      LiveWorkSession.restore(
        scope,
        forged,
        recoveryGrant,
        4,
        {},
        ports,
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
  });

  test('rejects near-exhausted recovery state with three dormant closures', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents) };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    for (const [index, actorId] of ['a', 'b', 'c'].entries()) {
      const at = index * 2;
      join(room, actorId, at);
      room.announce(
        { actorId, requestId: `announce-${actorId}` },
        grant(actorId),
        at + 1,
      );
    }
    const exported = room.exportRecovery(recoveryGrant, 6);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const exhausted = structuredClone(exported.state) as any;
    exhausted.nextOrdinal = Number.MAX_SAFE_INTEGER - 3;
    exhausted.pending = exhausted.pending.filter(
      (pending: any) => pending.intent.kind !== 'departure',
    );
    for (const lifecycle of exhausted.lifecycles) {
      const closure = exported.state.pending.find(
        (pending) => pending.intent.intentId === lifecycle.closureId,
      )!;
      lifecycle.closureId = undefined;
      lifecycle.state = 'published';
      const worstCase = {
        ...closure.intent,
        requestId: '\u0800'.repeat(128),
        ordinal: Number.MAX_SAFE_INTEGER,
      };
      worstCase.intentId = recomputeIntentId(worstCase);
      lifecycle.reservedClosureBytes = Buffer.byteLength(
        JSON.stringify(worstCase),
        'utf8',
      );
    }
    expect(
      LiveWorkSession.restore(
        scope,
        exhausted,
        recoveryGrant,
        7,
        {},
        ports,
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
  });

  test('rejects foreign intent-union keys and unpaired UTF-16 surrogates', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents) };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    const exported = room.exportRecovery(recoveryGrant, 2);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const smuggled = structuredClone(exported.state) as any;
    smuggled.terminal[0].intent.revisionId = revisionId;
    expect(
      LiveWorkSession.restore(
        scope,
        smuggled,
        recoveryGrant,
        3,
        {},
        ports,
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
    for (const surrogate of ['\ud800', '\udfff']) {
      const hostile = new LiveWorkSession(scope, {}, {}, dependencies());
      expect(
        hostile.join(
          { actorId: 'a', requestId: `request-${surrogate}` },
          grant('a'),
          0,
        ),
      ).toEqual({ outcome: 'invalid' });
    }
    const validPair = new LiveWorkSession(
      scope,
      {},
      { history: historyPort(intents) },
      {
        ...dependencies(),
        identityAuthority: {
          resolve: ({ actorId }) => ({
            state: 'AVAILABLE' as const,
            identity: {
              ...identity(actorId),
              actor: {
                ...identity(actorId).actor,
                label: 'Valid \ud83d\ude00',
              },
            },
          }),
        },
      },
    );
    expect(join(validPair, 'valid')).toEqual({ outcome: 'joined' });
    expect(
      validPair.announce(
        { actorId: 'valid', requestId: 'announce-valid' },
        grant('valid'),
        1,
      ),
    ).toEqual({ outcome: 'updated' });
  });

  test('evicts complete terminal/replay lifecycle blocks at the default capacity', () => {
    let commits = 0;
    const ports: LiveWorkPorts = {
      history: {
        commit: () => {
          commits += 1;
          return commits === 514
            ? { state: 'indeterminate' as const }
            : { state: 'committed' as const };
        },
      },
    };
    const room = new LiveWorkSession(
      scope,
      { rateWindowMs: 1 },
      ports,
      dependencies(),
    );
    for (let index = 0; index < 256; index += 1) {
      const actorId = `actor-${index}`;
      const at = index * 3;
      join(room, actorId, at);
      room.announce(
        { actorId, requestId: `announce-${index}` },
        grant(actorId),
        at + 1,
      );
      room.depart(
        { actorId, requestId: `depart-${index}` },
        grant(actorId),
        at + 2,
      );
    }
    const completed = room.exportRecovery(recoveryGrant, 768);
    expect(completed.outcome).toBe('available');
    if (completed.outcome !== 'available') return;
    expect(completed.state.terminal).toHaveLength(128);
    expect(completed.state.replay).toHaveLength(128);
    expect(
      LiveWorkSession.restore(
        scope,
        completed.state,
        recoveryGrant,
        769,
        { rateWindowMs: 1 },
        ports,
        dependencies(),
      ).outcome,
    ).toBe('available');

    join(room, 'actor-256', 769);
    expect(
      room.announce(
        { actorId: 'actor-256', requestId: 'announce-256' },
        grant('actor-256'),
        770,
      ),
    ).toEqual({ outcome: 'updated' });
    expect(
      room.depart(
        { actorId: 'actor-256', requestId: 'depart-256' },
        grant('actor-256'),
        771,
      ),
    ).toMatchObject({ outcome: 'degraded', state: 'indeterminate' });
    const pending = room.exportRecovery(recoveryGrant, 772);
    expect(pending.outcome).toBe('available');
    if (pending.outcome !== 'available') return;
    expect(
      pending.state.pending.filter(
        (record) => record.intent.kind === 'departure',
      ),
    ).toHaveLength(1);
    expect(
      LiveWorkSession.restore(
        scope,
        pending.state,
        recoveryGrant,
        773,
        { rateWindowMs: 1 },
        ports,
        dependencies(),
      ).outcome,
    ).toBe('available');
  });

  test('rejects replay lifecycle blocks that are valid but out of ordinal order', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents) };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    for (const [index, actorId] of ['a', 'b'].entries()) {
      const at = index * 3;
      join(room, actorId, at);
      room.announce(
        { actorId, requestId: `announce-${actorId}` },
        grant(actorId),
        at + 1,
      );
      room.depart(
        { actorId, requestId: `depart-${actorId}` },
        grant(actorId),
        at + 2,
      );
    }
    const exported = room.exportRecovery(recoveryGrant, 6);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const reordered = structuredClone(exported.state) as any;
    reordered.replay = [
      ...reordered.replay.slice(2),
      ...reordered.replay.slice(0, 2),
    ];
    expect(reordered.replay.map((event: any) => event.ordinal)).toEqual([
      3, 4, 1, 2,
    ]);
    expect(
      LiveWorkSession.restore(
        scope,
        reordered,
        recoveryGrant,
        7,
        {},
        ports,
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
  });

  test('keeps MAX_SAFE-2 recovery ordinal state exportable and restorable', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents) };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    const exported = room.exportRecovery(recoveryGrant, 2);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const boundary = structuredClone(exported.state) as any;
    boundary.nextOrdinal = Number.MAX_SAFE_INTEGER - 2;
    const restored = LiveWorkSession.restore(
      scope,
      boundary,
      recoveryGrant,
      3,
      {},
      ports,
      dependencies(),
    );
    expect(restored.outcome).toBe('available');
    if (restored.outcome !== 'available') return;
    const reexported = restored.session.exportRecovery(recoveryGrant, 4);
    expect(reexported.outcome).toBe('available');
    if (reexported.outcome === 'available')
      expect(
        LiveWorkSession.restore(
          scope,
          reexported.state,
          recoveryGrant,
          5,
          {},
          ports,
          dependencies(),
        ).outcome,
      ).toBe('available');
  });

  test('accepts terminal relation fields only on exact closure wrappers', () => {
    const ports: LiveWorkPorts = {
      history: historyPort([]),
      revision: { commit: () => ({ state: 'committed' }) },
    };
    const room = new LiveWorkSession(scope, {}, ports, revisionDependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    room.referenceRevision(
      {
        actorId: 'a',
        requestId: 'revision',
        reference: { revisionId, verification: 'verified' },
      },
      grant('a'),
      2,
    );
    room.depart({ actorId: 'a', requestId: 'depart' }, grant('a'), 3);
    const exported = room.exportRecovery(recoveryGrant, 4);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const announceSelfReference = structuredClone(exported.state) as any;
    const announcement = announceSelfReference.terminal.find(
      (record: any) => record.intent.kind === 'announce',
    );
    announcement.afterIntentId = announcement.intent.intentId;
    expect(
      LiveWorkSession.restore(
        scope,
        announceSelfReference,
        recoveryGrant,
        5,
        {},
        ports,
        revisionDependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
    const revisionRelation = structuredClone(exported.state) as any;
    revisionRelation.terminal.find(
      (record: any) => record.intent.kind === 'revision-reference',
    ).afterIntentId = exported.state.terminal[0]!.intent.intentId;
    expect(
      LiveWorkSession.restore(
        scope,
        revisionRelation,
        recoveryGrant,
        5,
        {},
        ports,
        revisionDependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
    const missingClosureRelation = structuredClone(exported.state) as any;
    delete missingClosureRelation.terminal.find(
      (record: any) => record.intent.kind === 'departure',
    ).afterIntentId;
    expect(
      LiveWorkSession.restore(
        scope,
        missingClosureRelation,
        recoveryGrant,
        5,
        {},
        ports,
        revisionDependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
  });

  test('requires replay capacity for every open published lifecycle', () => {
    expect(
      () =>
        new LiveWorkSession(
          scope,
          { maxParticipants: 2, maxReplayEvents: 1 },
          {},
          dependencies(),
        ),
    ).toThrow('invalid live-work configuration');
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents) };
    const room = new LiveWorkSession(
      scope,
      { maxParticipants: 2, maxReplayEvents: 2 },
      ports,
      dependencies(),
    );
    for (const [index, actorId] of ['a', 'b'].entries()) {
      join(room, actorId, index * 2);
      expect(
        room.announce(
          { actorId, requestId: `announce-${actorId}` },
          grant(actorId),
          index * 2 + 1,
        ),
      ).toEqual({ outcome: 'updated' });
    }
    const exported = room.exportRecovery(recoveryGrant, 4);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    expect(exported.state.replay).toHaveLength(2);
    expect(
      LiveWorkSession.restore(
        scope,
        exported.state,
        recoveryGrant,
        5,
        { maxParticipants: 2, maxReplayEvents: 2 },
        ports,
        dependencies(),
      ).outcome,
    ).toBe('available');
  });

  test('rejects a second valid pending closure for one lifecycle', () => {
    const intents: LiveWorkHistoryIntent[] = [];
    const ports = { history: historyPort(intents, ['indeterminate']) };
    const room = new LiveWorkSession(scope, {}, ports, dependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce' }, grant('a'), 1);
    room.depart({ actorId: 'a', requestId: 'depart' }, grant('a'), 2);
    const exported = room.exportRecovery(recoveryGrant, 3);
    expect(exported.outcome).toBe('available');
    if (exported.outcome !== 'available') return;
    const forged = structuredClone(exported.state) as any;
    const closure = forged.pending.find(
      (record: any) => record.intent.kind === 'departure',
    );
    const duplicate = structuredClone(closure);
    duplicate.intent.requestId = 'depart-duplicate';
    duplicate.intent.intentId = recomputeIntentId(duplicate.intent);
    forged.pending.push(duplicate);
    expect(
      LiveWorkSession.restore(
        scope,
        forged,
        recoveryGrant,
        4,
        {},
        ports,
        dependencies(),
      ),
    ).toEqual({ outcome: 'invalid' });
  });

  test('reserves replay capacity for an indeterminate departed lifecycle before a new announcement', () => {
    let calls = 0;
    const ports: LiveWorkPorts = {
      history: {
        commit: () => {
          calls += 1;
          return calls === 2
            ? { state: 'indeterminate' as const }
            : { state: 'committed' as const };
        },
      },
    };
    const bounds: Partial<LiveWorkBounds> = {
      maxParticipants: 1,
      maxReplayEvents: 1,
    };
    const room = new LiveWorkSession(scope, bounds, ports, dependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce-a' }, grant('a'), 1);
    const closure = room.depart(
      { actorId: 'a', requestId: 'depart-a' },
      grant('a'),
      2,
    ) as { intentId: string };
    join(room, 'b', 3);
    expect(
      room.announce({ actorId: 'b', requestId: 'announce-b' }, grant('b'), 4),
    ).toEqual({ outcome: 'capacity_exceeded' });
    expect(calls).toBe(2);
    expect(available(room, 'b', 4).participants).toEqual([
      expect.objectContaining({
        actor: { actorId: 'b', kind: 'human', label: 'Server b' },
        publication: 'private',
      }),
    ]);
    const blocked = room.exportRecovery(recoveryGrant, 4);
    expect(blocked.outcome).toBe('available');
    if (blocked.outcome !== 'available') return;
    expect(blocked.state.replay).toHaveLength(1);
    expect(
      blocked.state.pending.filter(
        (pending) => pending.intent.intentId === closure.intentId,
      ),
    ).toHaveLength(1);
    expect(
      LiveWorkSession.restore(
        scope,
        blocked.state,
        recoveryGrant,
        5,
        bounds,
        ports,
        dependencies(),
      ).outcome,
    ).toBe('available');
    expect(room.reconcile(closure.intentId, grant('a', ['join']), 6)).toEqual({
      outcome: 'updated',
    });
    expect(
      room.announce({ actorId: 'b', requestId: 'announce-b' }, grant('b'), 7),
    ).toEqual({ outcome: 'updated' });
    const recovered = room.exportRecovery(recoveryGrant, 8);
    expect(recovered).toMatchObject({
      outcome: 'available',
      state: { replay: [{ kind: 'announce' }] },
    });
    if (recovered.outcome === 'available')
      expect(
        LiveWorkSession.restore(
          scope,
          recovered.state,
          recoveryGrant,
          9,
          bounds,
          ports,
          dependencies(),
        ).outcome,
      ).toBe('available');
  });

  test('evicts refused closure replay blocks without losing refused idempotency', () => {
    let calls = 0;
    const ports: LiveWorkPorts = {
      history: {
        commit: () => {
          calls += 1;
          return calls === 2
            ? { state: 'refused' as const, reason: 'policy' }
            : { state: 'committed' as const };
        },
      },
    };
    const bounds: Partial<LiveWorkBounds> = {
      maxParticipants: 1,
      maxReplayEvents: 1,
    };
    const room = new LiveWorkSession(scope, bounds, ports, dependencies());
    join(room, 'a');
    room.announce({ actorId: 'a', requestId: 'announce-a' }, grant('a'), 1);
    const closure = room.depart(
      { actorId: 'a', requestId: 'depart-a' },
      grant('a'),
      2,
    ) as { intentId: string };
    join(room, 'b', 3);
    expect(
      room.announce({ actorId: 'b', requestId: 'announce-b' }, grant('b'), 4),
    ).toEqual({ outcome: 'updated' });
    expect(calls).toBe(3);
    expect(room.replay(grant('reader', ['history-read']), 4)).toMatchObject({
      events: [{ kind: 'announce', actor: { actorId: 'b' } }],
    });
    expect(
      room.depart({ actorId: 'a', requestId: 'again' }, grant('a'), 5),
    ).toMatchObject({ outcome: 'degraded', state: 'refused' });
    expect(room.recover(closure.intentId, recoveryGrant, 6)).toMatchObject({
      outcome: 'degraded',
      state: 'refused',
    });
    expect(calls).toBe(3);
    const exported = room.exportRecovery(recoveryGrant, 7);
    expect(exported.outcome).toBe('available');
    if (exported.outcome === 'available')
      expect(
        LiveWorkSession.restore(
          scope,
          exported.state,
          recoveryGrant,
          8,
          bounds,
          ports,
          dependencies(),
        ).outcome,
      ).toBe('available');
  });
});
