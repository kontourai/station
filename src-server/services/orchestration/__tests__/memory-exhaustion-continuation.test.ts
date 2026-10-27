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
  inboxEntryDelivery,
  MEMORY_CONTINUATION_TEXT,
  MemoryExhaustionContinuation,
  memoryContinuationKey,
} from '../memory-exhaustion-continuation.js';
import {
  type ThreadInboxPayload,
  type ThreadInboxSubmission,
  threadInboxRecordNonDelivery,
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
      // The production adapter and the inbox's own non-delivery rule, over
      // the real kernel record.
      entryDelivery: inboxEntryDelivery({
        entry: (conversationId, key) => inbox.read(conversationId, key),
        nonDeliveryReason: (conversationId, key) =>
          threadInboxRecordNonDelivery(inbox.read(conversationId, key)),
      }),
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
  // Real ClientOrigin actor kinds: operator, device, internal, unknown.
  const PERSON = {
    version: 1,
    actor: { kind: 'operator' },
    reported: { surface: 'unknown' },
  };
  const INTERNAL = { ...PERSON, actor: { kind: 'internal' } };
  const UNKNOWN = { ...PERSON, actor: { kind: 'unknown' } };

  function killedTurn(
    threadId: string,
    options: {
      pendingRequest?: boolean;
      aborted?: boolean;
      /** The killed turn was itself a continuation, under this key. */
      continuation?: string;
      /** The killed turn's origin when it is not a continuation. */
      origin?: Record<string, unknown>;
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
        : { clientOrigin: options.origin ?? PERSON }),
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

  test("an unknown origin does not reset the chain; a person's Continue does", () => {
    const continuation = coordinator();
    const conversation = 'conversation-origin';
    const link = (threadId: string, predecessor?: string) => {
      lineage.set(threadId, {
        conversationId: conversation,
        ...(predecessor ? { predecessorSessionId: predecessor } : {}),
      });
      current.set(conversation, threadId);
    };
    const chainOfTwo = () => {
      killedTurn(conversation);
      link(conversation);
      const first = continuation.continueAutomatically(conversation) as {
        clientTurnId: string;
      };
      const b = `${conversation}:b`;
      killedTurn(b, { continuation: first.clientTurnId });
      link(b, conversation);
      clock += 1000;
      const second = continuation.continueAutomatically(b) as {
        clientTurnId: string;
      };
      return { b, second };
    };
    const { b, second } = chainOfTwo();
    // A project-room agent run (unknown origin) between kills: no reset.
    const c = `${conversation}:c`;
    killedTurn(c, { continuation: second.clientTurnId });
    link(c, b);
    const d = `${conversation}:d`;
    killedTurn(d, { origin: UNKNOWN });
    link(d, c);
    clock += 1000;
    expect(continuation.continueAutomatically(d)).toEqual({
      kind: 'skipped',
      reason: 'chain-limit',
    });
    // A person's Continue on the full chain resets it.
    const person = continuation.continueOnRequest({
      conversationId: conversation,
      actor: { userId: 'person-1' },
    }) as { kind: string; clientTurnId: string };
    expect(person.kind).toBe('queued');
    expect(person.clientTurnId).toMatch(/^memory-continue-[0-9a-f]{40}-p$/);
    const e = `${conversation}:e`;
    killedTurn(e, { continuation: person.clientTurnId });
    link(e, d);
    clock += 1000;
    expect(continuation.continueAutomatically(e).kind).toBe('queued');
  });

  test("after the owner cancels Station's continuation, Station respects it and a person's Continue proceeds once", () => {
    const continuation = coordinator();
    killedTurn('thread-cancel');
    const automatic = continuation.continueAutomatically('thread-cancel') as {
      kind: string;
      clientTurnId: string;
    };
    expect(automatic.kind).toBe('queued');
    expect(
      store
        .threadInboxStore()
        .cancel('thread-cancel', automatic.clientTurnId, clock).kind,
    ).toBe('cancelled');
    // A cancelled entry sent nothing, but it was the owner's decision.
    expect(
      continuation.continueOnRequest({
        conversationId: 'thread-cancel',
        actor: { userId: 'person-1' },
      }),
    ).toMatchObject({
      kind: 'queued',
      clientTurnId: `${automatic.clientTurnId}-p`,
    });
    // The same person's second device, and anyone after: already continued.
    expect(
      continuation.continueOnRequest({
        conversationId: 'thread-cancel',
        actor: { userId: 'person-1' },
      }),
    ).toEqual({ kind: 'skipped', reason: 'already-claimed' });
  });

  test("a continuation the inbox refused sent nothing: a person's Continue proceeds", () => {
    const continuation = coordinator();
    killedTurn('thread-refused');
    const automatic = continuation.continueAutomatically('thread-refused') as {
      clientTurnId: string;
    };
    const inbox = store.threadInboxStore();
    // Placement refused the start before any effect (the session had ended).
    const claimed = inbox.claimNext('thread-refused', 'placement-1', clock);
    expect(claimed.kind).toBe('claimed');
    inbox.settle(
      (claimed as { entry: never }).entry,
      'refused',
      { reasonCode: 'session_ended', reason: 'ended' } as never,
      clock,
    );
    expect(inbox.read('thread-refused', automatic.clientTurnId)).toMatchObject({
      state: 'refused',
    });
    expect(
      continuation.continueOnRequest({
        conversationId: 'thread-refused',
        actor: { userId: 'person-1' },
      }),
    ).toMatchObject({
      kind: 'queued',
      clientTurnId: `${automatic.clientTurnId}-p`,
    });
  });

  test('a dismissed unconfirmed continuation may have started a turn: a person cannot send a second', () => {
    const continuation = coordinator();
    killedTurn('thread-unconfirmed');
    const automatic = continuation.continueAutomatically(
      'thread-unconfirmed',
    ) as { clientTurnId: string };
    const inbox = store.threadInboxStore();
    // Placement started and its outcome was never confirmed; then a person
    // dismissed it. It keeps its placement: a turn may exist.
    const claimed = inbox.claimNext('thread-unconfirmed', 'placement-1', clock);
    expect(claimed.kind).toBe('claimed');
    inbox.settle(
      (claimed as { entry: never }).entry,
      'unconfirmed',
      { reasonCode: 'unconfirmed', reason: 'no answer' } as never,
      clock,
    );
    inbox.cancel('thread-unconfirmed', automatic.clientTurnId, clock);
    expect(
      continuation.continueOnRequest({
        conversationId: 'thread-unconfirmed',
        actor: { userId: 'person-1' },
      }),
    ).toEqual({ kind: 'skipped', reason: 'already-claimed' });
  });

  test('after every person key was cancelled unsent, Continue reports retries exhausted', () => {
    const continuation = coordinator();
    killedTurn('thread-exhausted');
    const base = memoryContinuationKey(
      'thread-exhausted',
      'thread-exhausted-turn',
    );
    const inbox = store.threadInboxStore();
    for (const key of [
      base,
      `${base}-p`,
      ...[2, 3, 4, 5].map((n) => `${base}-p${n}`),
    ]) {
      inbox.submit({
        conversationId: 'thread-exhausted',
        clientTurnId: key,
        payload: {
          message: MEMORY_CONTINUATION_TEXT,
          actor: { userId: 'person-1' },
        },
        now: clock,
      });
      inbox.cancel('thread-exhausted', key, clock);
    }
    expect(
      continuation.continueOnRequest({
        conversationId: 'thread-exhausted',
        actor: { userId: 'person-1' },
      }),
    ).toEqual({ kind: 'skipped', reason: 'withdrawn' });
  });

  test('Station does not retry on its own after its continuation was withdrawn', () => {
    const continuation = coordinator();
    killedTurn('thread-withdrawn');
    const key = memoryContinuationKey(
      'thread-withdrawn',
      'thread-withdrawn-turn',
    );
    const inbox = store.threadInboxStore();
    inbox.submit({
      conversationId: 'thread-withdrawn',
      clientTurnId: key,
      payload: {
        message: MEMORY_CONTINUATION_TEXT,
        actor: { userId: 'person-1' },
      },
      now: clock,
    });
    inbox.cancel('thread-withdrawn', key, clock);
    expect(continuation.continueAutomatically('thread-withdrawn')).toEqual({
      kind: 'skipped',
      reason: 'withdrawn',
    });
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
