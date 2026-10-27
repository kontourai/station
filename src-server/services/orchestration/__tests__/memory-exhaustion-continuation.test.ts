/**
 * Station's continuation after an engine memory kill, against a real
 * EventStore (dead turns read from persisted events) and the real inbox
 * kernel store (the same-key idempotency the exactly-once claim rests on).
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ENGINE_MEMORY_EXHAUSTED_CODE,
  isStationMemoryContinuationTurn,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import {
  AUTO_CONTINUE_MAX,
  AUTO_CONTINUE_WINDOW_MS,
  MEMORY_CONTINUATION_TEXT,
  MemoryExhaustionContinuation,
  memoryContinuationKey,
} from '../memory-exhaustion-continuation.js';
import type {
  ThreadInboxPayload,
  ThreadInboxSubmission,
} from '../thread-inbox.js';

const makeTempDir = trackTempDirs();

describe('automatic continuation after a memory kill', () => {
  let store: EventStore;
  let clock: number;
  let owners: Map<string, string>;
  let current: Map<string, string>;
  /** Conversation lineage rows, as a reserved continuation records them. */
  let lineage: Map<
    string,
    { conversationId: string; predecessorSessionId?: string }
  >;
  let submissions: Array<{
    conversationId: string;
    clientTurnId: string;
    payload: ThreadInboxPayload;
    outcome: ThreadInboxSubmission['outcome'];
  }>;

  beforeEach(() => {
    store = new EventStore(join(makeTempDir('memory-continue-'), 'o.sqlite'));
    clock = Date.parse('2026-10-27T12:00:00Z');
    owners = new Map();
    current = new Map();
    lineage = new Map();
    submissions = [];
  });
  afterEach(() => store.close());

  function coordinator() {
    const inbox = store.threadInboxStore();
    return new MemoryExhaustionContinuation({
      eventStore: {
        conversationForSession: (sessionId) => {
          const row = lineage.get(sessionId);
          return row
            ? ({ ...row, sessionId, ordinal: 0, createdAt: '' } as never)
            : undefined;
        },
        listEventWindowByTurn: (threadId, options) =>
          store.listEventWindowByTurn(threadId, options),
        hasTurnFacts: (threadId) => store.hasTurnFacts(threadId),
      },
      service: {
        currentConversationSessionId: (conversationId) =>
          current.get(conversationId) ?? conversationId,
        sessionRecordedOwnerId: (threadId) => owners.get(threadId),
      },
      // The inbox kernel's own submit: same key and payload is the same
      // entry; the same key with another payload is a conflict.
      submit: (input) => {
        const result = inbox.submit({ ...input, now: clock });
        const outcome =
          result.kind === 'conflict'
            ? 'conflict'
            : result.kind === 'capacity'
              ? 'capacity'
              : 'queued';
        submissions.push({ ...input, outcome });
        return outcome === 'conflict'
          ? { outcome: 'conflict' }
          : outcome === 'capacity'
            ? { outcome: 'capacity', limit: 0 }
            : ({ outcome: 'queued' } as ThreadInboxSubmission);
      },
      logger: { warn: vi.fn() },
      now: () => clock,
    });
  }

  let sequence = 0;
  function append(threadId: string, event: Record<string, unknown>) {
    sequence += 1;
    store.appendEvent({
      eventId: `e-${sequence}`,
      provider: 'codex',
      threadId,
      createdAt: new Date(clock + sequence).toISOString(),
      ...event,
    } as unknown as CanonicalRuntimeEvent);
  }

  /** A turn that ran and was ended by a memory kill. */
  function killedTurn(
    threadId: string,
    options: { pendingRequest?: boolean; aborted?: boolean } = {},
  ) {
    const turnId = `${threadId}-turn`;
    append(threadId, { method: 'session.started', sessionId: threadId });
    append(threadId, { method: 'turn.started', turnId, prompt: 'Build it' });
    if (options.pendingRequest)
      append(threadId, {
        method: 'request.opened',
        turnId,
        requestId: 'approve-1',
        requestType: 'command',
      });
    if (options.aborted)
      append(threadId, { method: 'turn.aborted', turnId, reason: 'user' });
    append(threadId, {
      method: 'runtime.error',
      turnId,
      severity: 'error',
      code: ENGINE_MEMORY_EXHAUSTED_CODE,
      message: 'Codex ran out of memory and was stopped.',
    });
    append(threadId, {
      method: 'session.exited',
      sessionId: threadId,
      reason: 'memory-exhausted',
    });
    owners.set(threadId, 'person-1');
    return turnId;
  }

  const exited = (threadId: string) => ({
    method: 'session.exited',
    threadId,
    reason: 'memory-exhausted',
  });

  test('continues once, with the continuation text under the dead-turn key', () => {
    const continuation = coordinator();
    const turnId = killedTurn('thread-a');
    continuation.observe(exited('thread-a'));
    continuation.observe(exited('thread-a'));
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      conversationId: 'thread-a',
      clientTurnId: memoryContinuationKey('thread-a', turnId),
      payload: {
        message: MEMORY_CONTINUATION_TEXT,
        actor: { userId: 'person-1' },
        clientOrigin: { actor: { kind: 'internal' } },
      },
      outcome: 'queued',
    });
    // The UI recognises the turn the inbox will start as Station's.
    expect(
      isStationMemoryContinuationTurn({
        clientTurnId: submissions[0]!.clientTurnId,
        clientOrigin: submissions[0]!.payload.clientOrigin,
      }),
    ).toBe(true);
  });

  test('stops at the cap within the window, and resumes after it', () => {
    const continuation = coordinator();
    for (let index = 0; index <= AUTO_CONTINUE_MAX; index += 1) {
      const threadId = `conversation-c:session:${index}`;
      killedTurn(threadId);
      lineage.set(threadId, {
        conversationId: 'conversation-c',
        predecessorSessionId:
          index === 0
            ? 'conversation-c'
            : `conversation-c:session:${index - 1}`,
      });
      current.set('conversation-c', threadId);
      clock += 1000;
      expect(continuation.continueAutomatically(threadId).kind).toBe(
        index < AUTO_CONTINUE_MAX ? 'queued' : 'skipped',
      );
    }
    expect(
      continuation.continueAutomatically(
        `conversation-c:session:${AUTO_CONTINUE_MAX}`,
      ),
    ).toEqual({ kind: 'skipped', reason: 'capped' });
    clock += AUTO_CONTINUE_WINDOW_MS;
    expect(
      continuation.continueAutomatically(
        `conversation-c:session:${AUTO_CONTINUE_MAX}`,
      ).kind,
    ).toBe('queued');
    // Literal pins beside the constants: 3 per 5 minutes.
    expect([AUTO_CONTINUE_MAX, AUTO_CONTINUE_WINDOW_MS]).toEqual([3, 300_000]);
  });

  test('never continues an interrupted turn or one with an open request', () => {
    const continuation = coordinator();
    killedTurn('thread-aborted', { aborted: true });
    killedTurn('thread-pending', { pendingRequest: true });
    expect(continuation.continueAutomatically('thread-aborted')).toEqual({
      kind: 'skipped',
      reason: 'interrupted',
    });
    expect(continuation.continueAutomatically('thread-pending')).toEqual({
      kind: 'skipped',
      reason: 'request-pending',
    });
    // A session that exited for another reason is not observed at all.
    continuation.observe({
      method: 'session.exited',
      threadId: 'thread-pending',
      reason: 'process-exit',
    });
    expect(submissions).toEqual([]);
  });

  test('does not continue a conversation that has moved on', () => {
    const continuation = coordinator();
    killedTurn('thread-moved');
    current.set('thread-moved', `thread-moved:session:${randomUUID()}`);
    expect(continuation.continueAutomatically('thread-moved')).toEqual({
      kind: 'skipped',
      reason: 'superseded',
    });
  });

  test('two concurrent triggers start one continuation', async () => {
    const continuation = coordinator();
    killedTurn('thread-race');
    // Station's own trigger and a person's Continue from another device.
    const [automatic, person] = await Promise.all([
      Promise.resolve().then(() =>
        continuation.continueAutomatically('thread-race'),
      ),
      Promise.resolve().then(() =>
        continuation.continueOnRequest({
          conversationId: 'thread-race',
          actor: { userId: 'person-2' },
        }),
      ),
    ]);
    const outcomes = [automatic, person].map((outcome) =>
      outcome.kind === 'failed' ? outcome.reason : outcome.kind,
    );
    expect(outcomes.sort()).toEqual(['conflict', 'queued']);
    // Both named the same key; the inbox holds exactly one entry for it.
    expect(new Set(submissions.map((entry) => entry.clientTurnId)).size).toBe(
      1,
    );
    // The same person on two devices is one entry, not a conflict.
    const again = continuation.continueOnRequest({
      conversationId: 'thread-race',
      actor: { userId: 'person-1' },
    });
    expect(again.kind).toBe('queued');
  });

  test('a person can continue past the cap; an unrelated failure is refused', () => {
    const continuation = coordinator();
    killedTurn('thread-person', { pendingRequest: true });
    expect(
      continuation.continueOnRequest({
        conversationId: 'thread-person',
        actor: { userId: 'person-1' },
      }).kind,
    ).toBe('queued');
    append('thread-other', { method: 'session.started', sessionId: 'x' });
    append('thread-other', {
      method: 'turn.started',
      turnId: 'other-turn',
      prompt: 'x',
    });
    append('thread-other', {
      method: 'runtime.error',
      turnId: 'other-turn',
      severity: 'error',
      code: 'codex-turn-orphaned',
      message: 'exited',
    });
    expect(
      continuation.continueOnRequest({
        conversationId: 'thread-other',
        actor: { userId: 'person-1' },
      }),
    ).toEqual({ kind: 'skipped', reason: 'not-memory-exhausted' });
  });
});
