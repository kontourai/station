import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationTurnActivityProjection } from '../conversation-turn-activity.js';
import { EventStore } from '../event-store.js';
import { activeTurnIdForEvents } from '../session-lifecycle-service.js';

/**
 * #2309: the conversation activity projection, driven through a REAL event
 * store so every path under test is the production one — the post-commit
 * observer, both seeding paths, lineage — and never a hand-fed fold.
 */

const ROOT = 'activity-root';
const CHILD_1 = `${ROOT}:session:child-1`;
const CHILD_2 = `${ROOT}:session:child-2`;

let clock = Date.parse('2026-09-22T10:00:00.000Z');
function at(): string {
  clock += 1_000;
  return new Date(clock).toISOString();
}

let eventCounter = 0;
function event(
  threadId: string,
  fields: Record<string, unknown> & { method: string },
): CanonicalRuntimeEvent {
  eventCounter += 1;
  return {
    eventId: `event-${eventCounter}`,
    provider: 'claude',
    threadId,
    createdAt: at(),
    ...fields,
  } as unknown as CanonicalRuntimeEvent;
}

const logger = { warn: vi.fn() };

describe('ConversationTurnActivityProjection (#2309)', () => {
  let directory: string;
  let store: EventStore;
  let projection: ConversationTurnActivityProjection;
  const extraProjections: ConversationTurnActivityProjection[] = [];

  function freshProjection(): ConversationTurnActivityProjection {
    const created = new ConversationTurnActivityProjection({
      eventStore: store,
      readTurnProgress: () => undefined,
      logger,
    });
    extraProjections.push(created);
    return created;
  }

  function session(threadId: string): void {
    store.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: at(),
      updatedAt: at(),
    } as never);
  }

  function append(threadId: string, fields: Parameters<typeof event>[1]) {
    const built = event(threadId, fields);
    store.appendEvent(built);
    return built;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'conversation-turn-activity-'));
    store = new EventStore(join(directory, 'orchestration.sqlite'));
    projection = freshProjection();
    session(ROOT);
  });

  afterEach(() => {
    for (const created of extraProjections.splice(0)) created.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('the open turn is exactly the hasOpenTurn fold, live and freshly seeded, over random sequences', () => {
    // A deterministic generator over every fold-relevant method, including
    // the identity-guard cases: a stale terminal for an earlier turn, a
    // terminal with no turnId, deferred-retriable errors, steer re-starts.
    let seed = 2309;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const turnIds = ['t1', 't2', 't3'];
    const pick = <T>(values: readonly T[]): T =>
      values[Math.floor(random() * values.length)]!;
    const threadId = ROOT;
    // Warm the live projection first so every later event is folded
    // incrementally rather than read back by a seed.
    expect(projection.readForThread(threadId)?.openTurn).toBeUndefined();
    for (let step = 0; step < 400; step += 1) {
      const roll = random();
      const turnId = pick(turnIds);
      if (roll < 0.25)
        append(threadId, {
          method: 'turn.started',
          turnId,
          ...(random() < 0.3 ? { inputKind: 'steer' } : {}),
        });
      else if (roll < 0.4)
        append(threadId, { method: 'turn.completed', turnId });
      else if (roll < 0.5)
        append(threadId, {
          method: 'turn.aborted',
          turnId,
          reason: 'interrupted',
        });
      else if (roll < 0.58)
        append(threadId, {
          method: 'runtime.error',
          severity: 'error',
          message: 'boom',
          ...(random() < 0.5 ? { turnId } : {}),
          ...(random() < 0.5 ? { retriable: true } : {}),
        });
      else if (roll < 0.62)
        append(threadId, { method: 'session.exited', reason: 'exited' });
      else if (roll < 0.8)
        append(threadId, {
          method: 'tool.started',
          itemId: `call-${step}`,
          toolCallId: `call-${step}`,
          toolName: 'Bash',
        });
      else
        append(threadId, {
          method: 'content.text-delta',
          turnId,
          itemId: 'item',
          delta: 'x',
        });

      const expected = activeTurnIdForEvents(
        store.listEvents(threadId).map((persisted) => persisted.payload),
      );
      expect(projection.readForThread(threadId)?.openTurn?.turnId).toBe(
        expected,
      );
      if (step % 40 === 0) {
        // A new process seeds from the bounded projection read, not the
        // live fold — it must reach the same answer.
        expect(
          freshProjection().readForThread(threadId)?.openTurn?.turnId,
        ).toBe(expected);
      }
    }
  });

  test('a steer keeps the turn start; parallel tools list in start order; a call left open at close is dropped, not settled', () => {
    const started = append(ROOT, {
      method: 'turn.started',
      turnId: 'turn-a',
      prompt: 'go',
    });
    expect(projection.readForThread(ROOT)?.openTurn).toEqual({
      turnId: 'turn-a',
      threadId: ROOT,
      startedAt: started.createdAt,
    });
    append(ROOT, {
      method: 'turn.started',
      turnId: 'turn-a',
      prompt: 'also this',
      inputKind: 'steer',
    });
    const readA = append(ROOT, {
      method: 'tool.started',
      itemId: 'read-a',
      toolCallId: 'read-a',
      toolName: 'Read',
    });
    const grepB = append(ROOT, {
      method: 'tool.started',
      itemId: 'grep-b',
      toolCallId: 'grep-b',
      toolName: 'Grep',
    });
    let activity = projection.readForThread(ROOT)!;
    expect(activity.openTurn?.startedAt).toBe(started.createdAt);
    expect(activity.runningTools).toEqual([
      { name: 'Read', callId: 'read-a', startedAt: readA.createdAt },
      { name: 'Grep', callId: 'grep-b', startedAt: grepB.createdAt },
    ]);
    const done = append(ROOT, {
      method: 'tool.completed',
      itemId: 'read-a',
      toolCallId: 'read-a',
      toolName: 'Read',
      status: 'success',
    });
    activity = projection.readForThread(ROOT)!;
    expect(activity.runningTools).toEqual([
      { name: 'Grep', callId: 'grep-b', startedAt: grepB.createdAt },
    ]);
    expect(activity.lastTool).toEqual({
      name: 'Read',
      callId: 'read-a',
      outcome: 'success',
      completedAt: done.createdAt,
    });
    // The same state reached by a fresh seed (steer start, open tools).
    expect(freshProjection().readForThread(ROOT)).toEqual(activity);

    const closed = append(ROOT, { method: 'turn.completed', turnId: 'turn-a' });
    activity = projection.readForThread(ROOT)!;
    expect(activity.openTurn).toBeUndefined();
    expect(activity.runningTools).toBeUndefined();
    // Grep never reported: no outcome is invented for it.
    expect(activity.lastTool?.callId).toBe('read-a');
    expect(activity.lastActivityAt).toBe(closed.createdAt);
    expect(freshProjection().readForThread(ROOT)).toEqual(activity);
  });

  test('closes on a deferred-retriable runtime.error and on an interrupt abort, as hasActiveTurn does', () => {
    expect(projection.readForThread(ROOT)?.openTurn).toBeUndefined();
    append(ROOT, { method: 'turn.started', turnId: 'turn-r' });
    append(ROOT, {
      method: 'runtime.error',
      severity: 'error',
      message: 'retrying',
      turnId: 'turn-r',
      retriable: true,
    });
    expect(projection.readForThread(ROOT)?.openTurn).toBeUndefined();

    append(ROOT, { method: 'turn.started', turnId: 'turn-s' });
    expect(projection.readForThread(ROOT)?.openTurn?.turnId).toBe('turn-s');
    append(ROOT, {
      method: 'turn.aborted',
      turnId: 'turn-s',
      reason: 'interrupted',
    });
    expect(projection.readForThread(ROOT)?.openTurn).toBeUndefined();
  });

  test('a stale terminal for an earlier turn does not close the current one', () => {
    // Warm first, so the LIVE fold (not a seed) meets the stale terminal.
    expect(projection.readForThread(ROOT)?.openTurn).toBeUndefined();
    append(ROOT, { method: 'turn.started', turnId: 't1' });
    append(ROOT, { method: 'turn.started', turnId: 't2' });
    append(ROOT, { method: 'turn.completed', turnId: 't1' });
    expect(projection.readForThread(ROOT)?.openTurn?.turnId).toBe('t2');
  });

  test('sees writers that bypass the service publish path: appendEventIfAbsent closes the turn', () => {
    append(ROOT, { method: 'turn.started', turnId: 'turn-b' });
    expect(projection.readForThread(ROOT)?.openTurn?.turnId).toBe('turn-b');
    // The boot-recovery `runtime.error` and attached-follow both write
    // through `appendEventIfAbsent`, never `publishCanonicalEvent`.
    store.appendEventIfAbsent(
      event(ROOT, {
        method: 'runtime.error',
        severity: 'error',
        message: 'session recovery failed',
        turnId: 'turn-b',
      }),
    );
    expect(projection.readForThread(ROOT)?.openTurn).toBeUndefined();
  });

  test('an append inside a still-open outer transaction is re-read, not folded', () => {
    append(ROOT, { method: 'turn.started', turnId: 'turn-c' });
    expect(projection.readForThread(ROOT)?.openTurn?.turnId).toBe('turn-c');
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    db.exec('BEGIN');
    append(ROOT, { method: 'turn.completed', turnId: 'turn-c' });
    db.exec('ROLLBACK');
    // The rolled-back completion never happened.
    expect(projection.readForThread(ROOT)?.openTurn?.turnId).toBe('turn-c');
  });

  test("a conversation reports its current child's open turn, read from any child's thread", () => {
    append(ROOT, { method: 'turn.started', turnId: 'root-turn' });
    append(ROOT, { method: 'turn.completed', turnId: 'root-turn' });
    for (const [predecessor, child] of [
      [ROOT, CHILD_1],
      [CHILD_1, CHILD_2],
    ] as const) {
      store.reserveNextConversationSession({
        conversationId: ROOT,
        predecessorSessionId: predecessor,
        proposedSessionId: child,
        createdAt: at(),
      });
      session(child);
    }
    // Warm before the child starts, so the lineage change must invalidate.
    expect(projection.readConversation(ROOT).openTurn).toBeUndefined();
    const started = append(CHILD_2, {
      method: 'turn.started',
      turnId: 'child-turn',
    });
    const expected = {
      turnId: 'child-turn',
      threadId: CHILD_2,
      startedAt: started.createdAt,
    };
    expect(projection.readConversation(ROOT).openTurn).toEqual(expected);
    // Read from the ROOT's thread (a snapshot row for the root session).
    expect(projection.readForThread(ROOT)?.openTurn).toEqual(expected);
    expect(projection.readForThread(CHILD_1)?.openTurn).toEqual(expected);
    expect(projection.currentSessionId(ROOT)).toBe(CHILD_2);
    expect(freshProjection().readForThread(ROOT)?.openTurn).toEqual(expected);
  });

  test('a stuck open turn on a retired child never reads running; it is counted once', () => {
    // The no-op OTel meter shares one counter instance across every metric,
    // so the count is read from the breach's own log line, which the same
    // once-per-(thread, turn) guard emits beside the counter increment.
    logger.warn.mockClear();
    const breaches = () =>
      logger.warn.mock.calls.filter(
        ([message]) =>
          message ===
          'Conversation activity ignored an open turn on a non-current child',
      );
    // The root crashed mid-turn with no boundary row: its turn.started is its
    // last turn fact, so the root's own fold reads that turn open forever.
    append(ROOT, { method: 'turn.started', turnId: 'stuck-turn' });
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: CHILD_1,
      createdAt: at(),
    });
    session(CHILD_1);
    append(CHILD_1, { method: 'turn.started', turnId: 'current-turn' });
    append(CHILD_1, { method: 'turn.completed', turnId: 'current-turn' });

    for (let read = 0; read < 5; read += 1) {
      expect(projection.readConversation(ROOT).openTurn).toBeUndefined();
      expect(projection.readForThread(ROOT)?.openTurn).toBeUndefined();
      expect(
        projection.streamBinding({
          threadId: CHILD_1,
          method: 'turn.completed',
        })?.activity?.openTurn,
      ).toBeUndefined();
    }
    expect(freshProjection().readConversation(ROOT).openTurn).toBeUndefined();
    // Once per (thread, turn) per projection: the live one and the fresh one.
    expect(breaches()).toEqual([
      [
        'Conversation activity ignored an open turn on a non-current child',
        { threadId: ROOT, turnId: 'stuck-turn' },
      ],
      [
        'Conversation activity ignored an open turn on a non-current child',
        { threadId: ROOT, turnId: 'stuck-turn' },
      ],
    ]);
  });

  test('background activity outside a turn moves lastActivityAt and lastTool, never opens a turn', () => {
    expect(projection.readForThread(ROOT)?.openTurn).toBeUndefined();
    append(ROOT, {
      method: 'tool.progress',
      itemId: 'task-1',
      toolCallId: 'task-1',
      message: 'Reading a file',
    });
    append(ROOT, {
      method: 'tool.started',
      itemId: 'bg-1',
      toolCallId: 'bg-1',
      toolName: 'Task',
    });
    const settled = append(ROOT, {
      method: 'tool.completed',
      itemId: 'bg-1',
      toolCallId: 'bg-1',
      toolName: 'Task',
      status: 'error',
    });
    const activity = projection.readForThread(ROOT)!;
    expect(activity.openTurn).toBeUndefined();
    expect(activity.runningTools).toBeUndefined();
    expect(activity.lastTool).toEqual({
      name: 'Task',
      callId: 'bg-1',
      outcome: 'error',
      completedAt: settled.createdAt,
    });
    expect(activity.lastActivityAt).toBe(settled.createdAt);
  });

  test('a durable thread delete drops the record', () => {
    append(ROOT, { method: 'turn.started', turnId: 'turn-d' });
    expect(projection.readForThread(ROOT)?.openTurn?.turnId).toBe('turn-d');
    store.deleteThread(ROOT);
    expect(projection.readConversation(ROOT)).toEqual({
      conversationId: ROOT,
      asOfSequence: 0,
    });
  });

  test('a batched snapshot seed equals the per-thread seed and the live fold', () => {
    append(ROOT, { method: 'turn.started', turnId: 'turn-e' });
    append(ROOT, {
      method: 'tool.started',
      itemId: 'call-e',
      toolCallId: 'call-e',
      toolName: 'Edit',
    });
    append(ROOT, {
      method: 'content.text-delta',
      turnId: 'turn-e',
      itemId: 'item',
      delta: 'x',
    });
    const live = projection.readForThread(ROOT);
    const primed = freshProjection();
    primed.primeThreads(store.listSessionProjectionEventsForThreads([ROOT]));
    const single = freshProjection();
    expect(primed.readForThread(ROOT)).toEqual(live);
    expect(single.readForThread(ROOT)).toEqual(live);
    expect(live?.asOfSequence).toBe(store.headGlobalSequence());
  });

  test('stream frames: activity frames always carry it; coalesced frames at most once a second per child, the same answer for every subscriber', () => {
    let now = 1_000_000;
    const timed = new ConversationTurnActivityProjection({
      eventStore: store,
      readTurnProgress: () => undefined,
      logger,
      now: () => now,
    });
    extraProjections.push(timed);
    // Seed before the events so they fold live.
    timed.readForThread(ROOT);
    const started = append(ROOT, { method: 'turn.started', turnId: 'turn-f' });
    const subscribers = 3;
    const bind = (built: CanonicalRuntimeEvent) =>
      Array.from({ length: subscribers }, () =>
        timed.streamBinding({ threadId: built.threadId, method: built.method }),
      );
    for (const binding of bind(started))
      expect(binding?.activity?.openTurn?.turnId).toBe('turn-f');

    const delta = () =>
      append(ROOT, {
        method: 'content.text-delta',
        turnId: 'turn-f',
        itemId: 'item',
        delta: 'x',
      });
    const first = bind(delta());
    expect(first.every((binding) => binding?.activity)).toBe(true);
    now += 400;
    expect(bind(delta()).every((binding) => binding === undefined)).toBe(true);
    now += 700;
    const third = bind(delta());
    expect(third.every((binding) => binding?.activity)).toBe(true);
    expect(third[0]?.activity?.asOfSequence).toBe(store.headGlobalSequence());
  });

  test('warm frames cost no store reads, however many subscribers and deltas', () => {
    append(ROOT, { method: 'turn.started', turnId: 'turn-g' });
    projection.readForThread(ROOT);
    const reads = [
      vi.spyOn(store, 'conversationForSession'),
      vi.spyOn(store, 'conversationSessions'),
      vi.spyOn(store, 'listSessionProjectionEvents'),
      vi.spyOn(store, 'readTurnActivitySeed'),
    ];
    const deltas: CanonicalRuntimeEvent[] = [];
    for (let index = 0; index < 1_000; index += 1)
      deltas.push(
        event(ROOT, {
          method: 'content.text-delta',
          turnId: 'turn-g',
          itemId: 'item',
          delta: 'x',
        }),
      );
    for (const built of deltas) {
      store.appendEvent(built);
      for (let subscriber = 0; subscriber < 3; subscriber += 1)
        projection.streamBinding({
          threadId: built.threadId,
          method: built.method,
        });
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
  });

  test('a call left open when its turn closes does not show running in the next turn', () => {
    projection.readForThread(ROOT);
    append(ROOT, { method: 'turn.started', turnId: 'turn-1' });
    append(ROOT, {
      method: 'tool.started',
      itemId: 'grep-x',
      toolCallId: 'grep-x',
      toolName: 'Grep',
    });
    append(ROOT, { method: 'turn.completed', turnId: 'turn-1' });
    append(ROOT, { method: 'turn.started', turnId: 'turn-2' });
    const live = projection.readForThread(ROOT);
    expect(live?.openTurn?.turnId).toBe('turn-2');
    expect(live?.runningTools).toBeUndefined();
    expect(freshProjection().readForThread(ROOT)).toEqual(live);
  });

  test('the watchdog silence marker passes through only for the matching open turn', () => {
    const silence = { windowMs: 1000, detectedAt: '2026-09-22T10:00:00.000Z' };
    let progressTurn = 'turn-s';
    const withProgress = new ConversationTurnActivityProjection({
      eventStore: store,
      readTurnProgress: () =>
        ({ turnId: progressTurn, progressSilence: silence }) as never,
      logger,
    });
    extraProjections.push(withProgress);
    append(ROOT, { method: 'turn.started', turnId: 'turn-s' });
    expect(withProgress.readForThread(ROOT)?.progressSilence).toEqual(silence);
    progressTurn = 'other-turn';
    expect(withProgress.readForThread(ROOT)?.progressSilence).toBeUndefined();
    progressTurn = 'turn-s';
    append(ROOT, { method: 'turn.completed', turnId: 'turn-s' });
    expect(withProgress.readForThread(ROOT)?.progressSilence).toBeUndefined();
  });

  test('a tool.started frame inside a coalescing window still carries the running tool', () => {
    const timed = new ConversationTurnActivityProjection({
      eventStore: store,
      readTurnProgress: () => undefined,
      logger,
      now: () => 5_000_000,
    });
    extraProjections.push(timed);
    timed.readForThread(ROOT);
    append(ROOT, { method: 'turn.started', turnId: 'turn-t' });
    const delta = append(ROOT, {
      method: 'content.text-delta',
      turnId: 'turn-t',
      itemId: 'i',
      delta: 'x',
    });
    expect(timed.streamBinding(delta)?.activity).toBeDefined();
    const tool = append(ROOT, {
      method: 'tool.started',
      turnId: 'turn-t',
      itemId: 'c',
      toolCallId: 'c',
      toolName: 'Bash',
    });
    expect(timed.streamBinding(tool)?.activity?.runningTools).toEqual([
      expect.objectContaining({ callId: 'c', name: 'Bash' }),
    ]);
  });

  test('a child reserved after the conversation was first read is folded in (lineage invalidation)', () => {
    expect(projection.readForThread(ROOT)?.openTurn).toBeUndefined();
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: CHILD_1,
      createdAt: at(),
    });
    session(CHILD_1);
    append(CHILD_1, { method: 'turn.started', turnId: 'child-turn' });
    expect(projection.readForThread(ROOT)?.openTurn).toMatchObject({
      turnId: 'child-turn',
      threadId: CHILD_1,
    });
    expect(projection.currentSessionId(ROOT)).toBe(CHILD_1);
  });

  test('with a stuck open turn on the root and an open current child, the CURRENT child is reported even when the stuck turn started later', () => {
    store.reserveNextConversationSession({
      conversationId: ROOT,
      predecessorSessionId: ROOT,
      proposedSessionId: CHILD_1,
      createdAt: at(),
    });
    session(CHILD_1);
    append(CHILD_1, { method: 'turn.started', turnId: 'child-open' });
    // A later-started open turn on the retired root: "latest wins" would pick
    // it; the current-child rule must not.
    append(ROOT, { method: 'turn.started', turnId: 'root-stuck' });
    expect(projection.readForThread(ROOT)?.openTurn).toMatchObject({
      turnId: 'child-open',
      threadId: CHILD_1,
    });
    expect(freshProjection().readForThread(CHILD_1)?.openTurn).toMatchObject({
      turnId: 'child-open',
      threadId: CHILD_1,
    });
  });
});
