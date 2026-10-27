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
  AUTO_CONTINUE_CHAIN_MAX,
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
        listEventsByMethods: (threadId, methods) =>
          store.listEventsByMethods(threadId, methods),
        firstEventByMethod: (threadId, method) =>
          store.firstEventByMethod(threadId, method),
      },
      service: {
        currentConversationSessionId: (conversationId) =>
          current.get(conversationId) ?? conversationId,
        sessionRecordedOwnerId: (threadId) => owners.get(threadId),
      },
      // The inbox kernel's own submit: same key and payload is the same
      // entry; the same key with another payload is a conflict.
      entryExists: (conversationId, key) =>
        inbox.read(conversationId, key) !== undefined,
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
  const HUMAN = {
    version: 1,
    actor: { kind: 'human' },
    reported: { surface: 'unknown' },
  };
  const INTERNAL = { ...HUMAN, actor: { kind: 'internal' } };

  function killedTurn(
    threadId: string,
    options: {
      pendingRequest?: boolean;
      aborted?: boolean;
      /** The killed turn was itself Station's automatic continuation. */
      continuation?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ) {
    const turnId = `${threadId}-turn`;
    append(threadId, {
      method: 'session.started',
      sessionId: threadId,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
    append(threadId, {
      method: 'turn.started',
      turnId,
      prompt: options.continuation ? MEMORY_CONTINUATION_TEXT : 'Build it',
      ...(options.continuation
        ? { clientTurnId: options.continuation, clientOrigin: INTERNAL }
        : { clientOrigin: HUMAN }),
    });
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
    // Exactly: the first continues, the second is told it already did.
    expect(outcomes).toEqual(['queued', 'skipped']);
    expect(person).toEqual({ kind: 'skipped', reason: 'already-claimed' });
    // Both named the same key; the inbox holds exactly one entry for it.
    expect(new Set(submissions.map((entry) => entry.clientTurnId)).size).toBe(
      1,
    );
    // The owner's own click, too, finds Station's entry.
    expect(
      continuation.continueOnRequest({
        conversationId: 'thread-race',
        actor: { userId: 'person-1' },
      }),
    ).toEqual({ kind: 'skipped', reason: 'already-claimed' });
  });

  test("stops after AUTO_CONTINUE_CHAIN_MAX automatic continuations in a row; a person's turn resets the chain", () => {
    const continuation = coordinator();
    const conversation = 'conversation-chain';
    const link = (threadId: string, predecessor?: string) => {
      lineage.set(threadId, {
        conversationId: conversation,
        ...(predecessor ? { predecessorSessionId: predecessor } : {}),
      });
      current.set(conversation, threadId);
    };
    // The person's turn is killed; Station continues (chain 0 → 1).
    killedTurn(conversation);
    link(conversation);
    const first = continuation.continueAutomatically(conversation);
    expect(first.kind).toBe('queued');
    // That continuation is killed too; Station continues again (1 → 2).
    const b = `${conversation}:session:b`;
    killedTurn(b, {
      continuation: (first as { clientTurnId: string }).clientTurnId,
    });
    link(b, conversation);
    clock += 1000;
    const second = continuation.continueAutomatically(b);
    expect(second.kind).toBe('queued');
    // The second continuation is killed: the chain is full.
    const c = `${conversation}:session:c`;
    killedTurn(c, {
      continuation: (second as { clientTurnId: string }).clientTurnId,
    });
    link(c, b);
    clock += 1000;
    expect(continuation.continueAutomatically(c)).toEqual({
      kind: 'skipped',
      reason: 'chain-limit',
    });
    // A person sends a turn in the next Session; when that is killed,
    // Station may continue again.
    const d = `${conversation}:session:d`;
    killedTurn(d);
    link(d, c);
    clock += 1000;
    expect(continuation.continueAutomatically(d).kind).toBe('queued');
    // Literal pin beside the constant.
    expect(AUTO_CONTINUE_CHAIN_MAX).toBe(2);
  });

  test('never continues a delegated child on its own: its parent decides', () => {
    const continuation = coordinator();
    killedTurn('thread-child', {
      metadata: { delegation: { parentConversationId: 'parent-conversation' } },
    });
    expect(continuation.continueAutomatically('thread-child')).toEqual({
      kind: 'skipped',
      reason: 'delegated',
    });
    killedTurn('thread-task-child', { metadata: { parentTaskId: 'task-1' } });
    expect(continuation.continueAutomatically('thread-task-child')).toEqual({
      kind: 'skipped',
      reason: 'delegated',
    });
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
