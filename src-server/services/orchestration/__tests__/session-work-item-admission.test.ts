import { parseSessionWorkItemAssociation } from '@kontourai/station-contracts/session-work-item';
import { describe, expect, test } from 'vitest';
import {
  createSessionWorkItemAdmissionRegistry,
  type SessionWorkItemCanonicalToolCompletion,
} from '../session-work-item-admission.js';
import type { SessionWorkItemCandidate } from '../session-work-item-candidate.js';
import {
  mintWorkItemResultProjectorProvenanceForReviewedLoader,
  WorkItemResultProjector,
} from '../work-item-result-projector.js';

function candidate(
  overrides: Partial<
    Pick<
      SessionWorkItemCandidate,
      | 'associationId'
      | 'sessionId'
      | 'conversationId'
      | 'turnId'
      | 'toolCallId'
      | 'nativeId'
    >
  > = {},
): SessionWorkItemCandidate {
  const values = {
    associationId: 'association-a',
    sessionId: 'session-a',
    conversationId: 'conversation-a',
    turnId: 'turn-a',
    toolCallId: 'call-a',
    nativeId: '1234567890',
    ...overrides,
  };
  const projected = new WorkItemResultProjector().project({
    ...values,
    terminalStatus: 'success',
    provenance: mintWorkItemResultProjectorProvenanceForReviewedLoader(),
    githubArguments: {
      owner: 'kontourai',
      repo: 'station',
      title: 'Capture issue work',
    },
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          id: values.nativeId,
          url: 'https://github.com/kontourai/station/issues/235',
        }),
      },
    ],
  });
  if (!projected) throw new Error('expected official candidate');
  return projected;
}

function completion(
  source: SessionWorkItemCandidate = candidate(),
  overrides: Partial<SessionWorkItemCanonicalToolCompletion> = {},
): SessionWorkItemCanonicalToolCompletion {
  return {
    eventId: 'event-a',
    threadId: source.sessionId,
    conversationId: source.conversationId,
    turnId: source.turnId,
    toolCallId: source.toolCallId,
    method: 'tool.completed',
    status: 'success',
    observedAt: '2026-08-28T12:00:00.000Z',
    ...overrides,
  };
}

function take(
  registry: ReturnType<typeof createSessionWorkItemAdmissionRegistry>,
  source = candidate(),
) {
  const result = registry.take(completion(source));
  if (result.kind !== 'taken')
    throw new Error(`expected take: ${result.reason}`);
  return result;
}

describe('Session work-item admission registry', () => {
  test('stages a server-only candidate that cannot pass the published durable parser', () => {
    const source = candidate();
    expect(parseSessionWorkItemAssociation(source)).toBeNull();
    expect(source).not.toHaveProperty('eventId');
    expect(source).not.toHaveProperty('observedAt');

    const registry = createSessionWorkItemAdmissionRegistry();
    expect(
      registry.stage({
        candidate: { ...source } as unknown as SessionWorkItemCandidate,
        current: () => true,
      }),
    ).toEqual({ kind: 'refused', reason: 'invalid-candidate' });
    expect(
      registry.stage({
        candidate: {
          ...source,
          eventId: 'invented-event',
          observedAt: '2026-08-28T12:00:00.000Z',
        } as unknown as SessionWorkItemCandidate,
        current: () => true,
      }),
    ).toEqual({ kind: 'refused', reason: 'invalid-candidate' });
    expect(registry.stage({ candidate: source, current: () => true })).toEqual({
      kind: 'staged',
    });
    const claimed = take(registry, source);
    expect(claimed.association).toMatchObject({
      associationId: source.associationId,
      sessionId: source.sessionId,
      conversationId: source.conversationId,
      turnId: source.turnId,
      toolCallId: source.toolCallId,
      eventId: 'event-a',
      observedAt: '2026-08-28T12:00:00.000Z',
    });
  });

  test('takes a loader-projected official MinimalResponse candidate through rollback and commit', () => {
    const projected = new WorkItemResultProjector().project({
      associationId: 'association-loader',
      sessionId: 'session-loader',
      conversationId: 'conversation-loader',
      turnId: 'turn-loader',
      toolCallId: 'call-loader',
      terminalStatus: 'success',
      provenance: mintWorkItemResultProjectorProvenanceForReviewedLoader(),
      githubArguments: {
        owner: 'kontourai',
        repo: 'station',
        title: 'Capture issue work',
      },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: '1234567890',
            url: 'https://github.com/kontourai/station/issues/235',
          }),
        },
      ],
    });
    if (!projected) throw new Error('expected loader candidate');
    expect(projected).not.toHaveProperty('eventId');
    expect(projected).not.toHaveProperty('observedAt');

    const registry = createSessionWorkItemAdmissionRegistry();
    expect(
      registry.stage({ candidate: projected, current: () => true }),
    ).toEqual({
      kind: 'staged',
    });
    const first = registry.take(
      completion(projected, { eventId: 'event-loader' }),
    );
    if (first.kind !== 'taken')
      throw new Error(`expected take: ${first.reason}`);
    expect(first.association).toMatchObject({
      eventId: 'event-loader',
      observedAt: '2026-08-28T12:00:00.000Z',
      workItemRef: 'github:kontourai/station#235',
    });
    expect(registry.rollback(first.claim)).toEqual({ kind: 'rolled-back' });
    const retried = registry.take(
      completion(projected, { eventId: 'event-loader' }),
    );
    if (retried.kind !== 'taken')
      throw new Error(`expected retake: ${retried.reason}`);
    expect(registry.commit(retried.claim)).toEqual({ kind: 'committed' });
  });

  test('rolls an exact claim back after a database append failure and retakes it', () => {
    const registry = createSessionWorkItemAdmissionRegistry();
    const source = candidate();
    expect(registry.stage({ candidate: source, current: () => true })).toEqual({
      kind: 'staged',
    });
    const first = take(registry, source);
    expect(registry.take(completion(source))).toEqual({
      kind: 'refused',
      reason: 'claimed',
    });
    expect(registry.rollback(first.claim)).toEqual({ kind: 'rolled-back' });
    expect(registry.commit(first.claim)).toEqual({
      kind: 'refused',
      reason: 'invalid-claim',
    });
    const retried = take(registry, source);
    expect(registry.commit(retried.claim)).toEqual({ kind: 'committed' });
  });

  test('commits a taken association once and fences the exact terminal replay', () => {
    const registry = createSessionWorkItemAdmissionRegistry();
    const source = candidate();
    expect(registry.stage({ candidate: source, current: () => true })).toEqual({
      kind: 'staged',
    });
    const claimed = take(registry, source);
    expect(registry.commit(claimed.claim)).toEqual({ kind: 'committed' });
    expect(registry.take(completion(source))).toEqual({
      kind: 'refused',
      reason: 'replay',
    });
    expect(registry.stage({ candidate: source, current: () => true })).toEqual({
      kind: 'refused',
      reason: 'closed',
    });
  });

  test('refuses malformed/raw candidates, mismatch, and cross-session terminals without consuming the genuine candidate', () => {
    const registry = createSessionWorkItemAdmissionRegistry();
    expect(
      registry.stage({
        candidate: {
          ...candidate(),
          rawMcpResult: { content: [{ type: 'text', text: 'secret' }] },
        } as unknown as SessionWorkItemCandidate,
        current: () => true,
      }),
    ).toEqual({ kind: 'refused', reason: 'invalid-candidate' });
    const source = candidate();
    expect(registry.stage({ candidate: source, current: () => true })).toEqual({
      kind: 'staged',
    });
    expect(
      registry.take(
        completion(source, {
          method: 'turn.completed' as unknown as 'tool.completed',
        }),
      ),
    ).toEqual({ kind: 'refused', reason: 'mismatch' });
    expect(
      registry.take(completion(source, { threadId: 'session-other' })),
    ).toEqual({ kind: 'refused', reason: 'missing' });
    expect(
      registry.take(
        completion(source, { eventId: '', observedAt: 'caller prose' }),
      ),
    ).toEqual({ kind: 'refused', reason: 'mismatch' });
    expect(take(registry, source).association.eventId).toBe('event-a');
  });

  test.each([
    ['failed', { status: 'error' as const }, 'failed'],
    ['cancelled', { status: 'cancelled' as const }, 'cancelled'],
  ])(
    '%s terminal closes the tuple against restaging',
    (_label, terminal, reason) => {
      const registry = createSessionWorkItemAdmissionRegistry();
      const source = candidate();
      expect(
        registry.stage({ candidate: source, current: () => true }),
      ).toEqual({
        kind: 'staged',
      });
      const closed = registry.take(completion(source, terminal));
      expect(closed).toMatchObject({ kind: 'closed', reason });
      if (closed.kind !== 'closed') throw new Error('expected closure claim');
      expect(registry.commit(closed.claim)).toEqual({ kind: 'committed' });
      expect(
        registry.stage({ candidate: source, current: () => true }),
      ).toEqual({
        kind: 'refused',
        reason: 'closed',
      });
    },
  );

  test('authority loss closes the exact tuple against restaging', () => {
    let current = true;
    const registry = createSessionWorkItemAdmissionRegistry();
    const source = candidate();
    expect(
      registry.stage({ candidate: source, current: () => current }),
    ).toEqual({
      kind: 'staged',
    });
    current = false;
    const closed = registry.take(completion(source));
    expect(closed).toMatchObject({
      kind: 'closed',
      reason: 'authority-lost',
    });
    if (closed.kind !== 'closed') throw new Error('expected closure claim');
    expect(registry.commit(closed.claim)).toEqual({ kind: 'committed' });
    expect(registry.stage({ candidate: source, current: () => true })).toEqual({
      kind: 'refused',
      reason: 'closed',
    });
  });

  test('rolls an uncommitted failed-terminal closure back to its pending candidate', () => {
    const registry = createSessionWorkItemAdmissionRegistry();
    const source = candidate();
    expect(registry.stage({ candidate: source, current: () => true })).toEqual({
      kind: 'staged',
    });
    const closed = registry.take(completion(source, { status: 'error' }));
    if (closed.kind !== 'closed') throw new Error('expected closure claim');
    expect(registry.rollback(closed.claim)).toEqual({ kind: 'rolled-back' });
    expect(
      registry.take(completion(source, { status: 'cancelled' })),
    ).toMatchObject({ kind: 'closed', reason: 'cancelled' });
  });

  test('expires pending candidates and bounds total pending, claims, and closed replay fences', () => {
    let now = 100;
    const expiring = createSessionWorkItemAdmissionRegistry({
      now: () => now,
      ttlMs: 10,
    });
    const source = candidate();
    expect(expiring.stage({ candidate: source, current: () => true })).toEqual({
      kind: 'staged',
    });
    now += 10;
    expect(expiring.take(completion(source))).toEqual({
      kind: 'refused',
      reason: 'missing',
    });

    const active = createSessionWorkItemAdmissionRegistry({
      now: () => now,
      ttlMs: 10,
      maxEntries: 1,
    });
    expect(active.stage({ candidate: source, current: () => true })).toEqual({
      kind: 'staged',
    });
    const activeClaim = take(active, source);
    now += 10_000;
    expect(
      active.stage({
        candidate: candidate({
          associationId: 'association-active-other',
          sessionId: 'session-active-other',
          conversationId: 'conversation-active-other',
          turnId: 'turn-active-other',
          toolCallId: 'call-active-other',
        }),
        current: () => true,
      }),
    ).toEqual({ kind: 'refused', reason: 'global-capacity' });
    expect(active.commit(activeClaim.claim)).toEqual({ kind: 'committed' });

    const perSession = createSessionWorkItemAdmissionRegistry({
      maxEntries: 2,
      maxPerSession: 1,
    });
    expect(
      perSession.stage({ candidate: source, current: () => true }),
    ).toEqual({
      kind: 'staged',
    });
    expect(
      perSession.stage({
        candidate: candidate({
          associationId: 'association-b',
          turnId: 'turn-b',
          toolCallId: 'call-b',
        }),
        current: () => true,
      }),
    ).toEqual({ kind: 'refused', reason: 'session-capacity' });

    const bounded = createSessionWorkItemAdmissionRegistry({
      maxEntries: 8,
      maxPerSession: 1_000,
    });
    let committed = 0;
    for (let index = 0; index < 1_000; index += 1) {
      const item = candidate({
        associationId: `association-${index}`,
        sessionId: `session-${index}`,
        conversationId: `conversation-${index}`,
        turnId: `turn-${index}`,
        toolCallId: `call-${index}`,
      });
      const staged = bounded.stage({ candidate: item, current: () => true });
      if (staged.kind === 'staged') {
        committed += 1;
        expect(bounded.commit(take(bounded, item).claim)).toEqual({
          kind: 'committed',
        });
      } else {
        expect(staged).toEqual({ kind: 'refused', reason: 'global-capacity' });
      }
    }
    expect(committed).toBe(8);
  });
});
