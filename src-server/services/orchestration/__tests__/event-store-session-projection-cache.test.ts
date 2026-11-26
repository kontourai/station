import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore, type PersistedRuntimeEvent } from '../event-store.js';

/**
 * #4992: the session read model folds every readable thread's projection
 * facts and event count on each list, and it is listed several times a second
 * while any session streams. The store keeps each thread's fold keyed by the
 * thread's highest global sequence, so a list folds again only the threads
 * that moved. Every case compares against a second connection to the same
 * database with caches disabled, so a stale entry shows up as a difference
 * from what a fresh read returns.
 */

const pixels = Buffer.alloc(2 * 1024, 7);
const dataUrl = `data:image/png;base64,${pixels.toString('base64')}`;
const createdAt = '2026-11-15T00:00:00.000Z';

describe('EventStore session projection cache (#4992)', () => {
  // Created before the hook that closes the stores, so it removes the
  // directory after they are closed.
  const makeTempDir = trackTempDirs();
  let path: string;
  let store: EventStore;
  let reference: EventStore;

  beforeEach(() => {
    path = join(
      makeTempDir('session-projection-cache-'),
      'orchestration.sqlite',
    );
    store = new EventStore(path);
    vi.stubEnv('STATION_DISABLE_EVENT_STORE_CACHES', '1');
    reference = new EventStore(path);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    reference.close();
    store.close();
  });

  function append(event: Record<string, unknown>): void {
    store.appendEvent({
      provider: 'claude',
      createdAt,
      ...event,
    } as unknown as CanonicalRuntimeEvent);
  }

  function seedThread(threadId: string): void {
    store.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt,
      updatedAt: createdAt,
    });
    append({
      eventId: `${threadId}-started`,
      threadId,
      method: 'session.started',
      sessionId: threadId,
      metadata: { agentSlug: 'claude', userId: 'owner-user' },
    });
    append({
      eventId: `${threadId}-turn1-started`,
      threadId,
      turnId: 'turn-1',
      method: 'turn.started',
      prompt: `prompt for ${threadId}`,
    });
    append({
      eventId: `${threadId}-turn1-completed`,
      threadId,
      turnId: 'turn-1',
      method: 'turn.completed',
      finishReason: 'stop',
    });
  }

  const ids = (events: readonly PersistedRuntimeEvent[] | undefined) =>
    (events ?? []).map((event) => event.id);

  function expectMatchesFreshRead(threadIds: readonly string[]): void {
    const cached = store.listSessionProjectionEventsForThreads(threadIds);
    const fresh = reference.listSessionProjectionEventsForThreads(threadIds);
    expect([...cached.keys()]).toEqual([...fresh.keys()]);
    for (const threadId of threadIds)
      expect(cached.get(threadId)).toEqual(fresh.get(threadId));
    const counts = store.countEventsByThreads(threadIds);
    const freshCounts = reference.countEventsByThreads(threadIds);
    expect(new Map([...counts].sort())).toEqual(
      new Map([...freshCounts].sort()),
    );
  }

  /** The thread ids each fold and count query was run for, in call order. */
  function observeRefolds() {
    const folds: string[][] = [];
    const counts: string[][] = [];
    const internals = store as unknown as {
      foldSessionProjectionEvents(ids: readonly string[]): unknown;
      queryEventCountsByThreads(ids: readonly string[]): unknown;
    };
    const fold = internals.foldSessionProjectionEvents.bind(store);
    const count = internals.queryEventCountsByThreads.bind(store);
    internals.foldSessionProjectionEvents = (threadIds) => {
      folds.push([...threadIds]);
      return fold(threadIds);
    };
    internals.queryEventCountsByThreads = (threadIds) => {
      if (threadIds.length > 0) counts.push([...threadIds]);
      return count(threadIds);
    };
    return { folds, counts };
  }

  test('a repeated read folds again only the thread whose events moved', () => {
    const threads = ['thread-a', 'thread-b', 'thread-c'];
    for (const threadId of threads) seedThread(threadId);
    const observed = observeRefolds();

    expectMatchesFreshRead(threads);
    expect(observed.folds).toEqual([threads]);
    expect(observed.counts).toEqual([threads]);

    expectMatchesFreshRead(threads);
    expect(observed.folds).toHaveLength(1);
    expect(observed.counts).toHaveLength(1);

    append({
      eventId: 'thread-b-turn2-started',
      threadId: 'thread-b',
      turnId: 'turn-2',
      method: 'turn.started',
      prompt: 'follow-up',
    });
    expectMatchesFreshRead(threads);
    expect(observed.folds.slice(1)).toEqual([['thread-b']]);
    expect(observed.counts.slice(1)).toEqual([['thread-b']]);
    expect(
      ids(
        store
          .listSessionProjectionEventsForThreads(['thread-b'])
          .get('thread-b'),
      ),
    ).toContain('thread-b-turn2-started');
  });

  test('a scan larger than the cache returns every projection and keeps the same warm set', () => {
    const threads = Array.from({ length: 2050 }, (_, index) => `scan-${index}`);
    for (const threadId of threads)
      append({
        eventId: `${threadId}-started`,
        threadId,
        method: 'session.started',
        sessionId: threadId,
        metadata: { agentSlug: 'claude', userId: 'owner-user' },
      });
    const read = () => {
      const observeEvents = vi.fn();
      const observeCounts = vi.fn();
      const projections = store.listSessionProjectionEventsForThreads(
        threads,
        observeEvents,
      );
      const counts = store.countEventsByThreads(threads, observeCounts);
      expect([...projections.keys()]).toEqual(threads);
      for (const threadId of threads) {
        expect(ids(projections.get(threadId))).toEqual([`${threadId}-started`]);
        expect(counts.get(threadId)).toBe(1);
      }
      return [observeEvents, observeCounts];
    };
    store.listSessionProjectionEventsForThreads(threads.slice(0, 2048));
    read();
    for (const observe of read())
      expect(observe).toHaveBeenCalledWith({ refreshed: 2, reused: 2048 });
    for (const observe of read())
      expect(observe).toHaveBeenCalledWith({ refreshed: 2, reused: 2048 });
  });

  test('a fact that changes without a new prompt (a request opening and resolving) is folded again', () => {
    seedThread('thread-r');
    expectMatchesFreshRead(['thread-r']);
    append({
      eventId: 'thread-r-request-opened',
      threadId: 'thread-r',
      turnId: 'turn-1',
      method: 'request.opened',
      requestId: 'request-1',
      requestType: 'approval',
    });
    expectMatchesFreshRead(['thread-r']);
    append({
      eventId: 'thread-r-request-resolved',
      threadId: 'thread-r',
      turnId: 'turn-1',
      method: 'request.resolved',
      requestId: 'request-1',
      decision: 'accept',
    });
    expectMatchesFreshRead(['thread-r']);
  });

  test('a deleted thread started again under the same id never serves the deleted fold', () => {
    seedThread('thread-d');
    expectMatchesFreshRead(['thread-d']);
    store.deleteThread('thread-d');
    expectMatchesFreshRead(['thread-d']);
    expect(store.countEventsByThreads(['thread-d']).has('thread-d')).toBe(
      false,
    );

    store.upsertSession({
      provider: 'claude',
      threadId: 'thread-d',
      status: 'ready',
      createdAt,
      updatedAt: createdAt,
    });
    append({
      eventId: 'thread-d-restarted',
      threadId: 'thread-d',
      method: 'session.started',
      sessionId: 'thread-d',
      metadata: { agentSlug: 'claude', userId: 'owner-user' },
    });
    expectMatchesFreshRead(['thread-d']);
    expect(
      ids(
        store
          .listSessionProjectionEventsForThreads(['thread-d'])
          .get('thread-d'),
      ),
    ).toEqual(['thread-d-restarted']);
  });

  test('a read inside a transaction that rolls back leaves nothing a later event could be mistaken for', () => {
    seedThread('thread-t');
    expectMatchesFreshRead(['thread-t']);
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;

    db.exec('BEGIN');
    append({
      eventId: 'thread-t-rolled-back',
      threadId: 'thread-t',
      turnId: 'turn-2',
      method: 'turn.started',
      prompt: 'never committed',
    });
    expect(
      ids(
        store
          .listSessionProjectionEventsForThreads(['thread-t'])
          .get('thread-t'),
      ),
    ).toContain('thread-t-rolled-back');
    db.exec('ROLLBACK');

    // The rolled-back event's global sequence is free again; this event
    // takes it, so a fold cached during the transaction would match.
    append({
      eventId: 'thread-t-committed',
      threadId: 'thread-t',
      turnId: 'turn-3',
      method: 'turn.started',
      prompt: 'committed',
    });
    const events = ids(
      store.listSessionProjectionEventsForThreads(['thread-t']).get('thread-t'),
    );
    expect(events).toContain('thread-t-committed');
    expect(events).not.toContain('thread-t-rolled-back');
    expectMatchesFreshRead(['thread-t']);
  });

  test('attachment data is read on every return and is not held in the cache', () => {
    store.upsertSession({
      provider: 'claude',
      threadId: 'thread-img',
      status: 'ready',
      createdAt,
      updatedAt: createdAt,
    });
    append({
      eventId: 'thread-img-turn',
      threadId: 'thread-img',
      turnId: 'turn-1',
      method: 'turn.started',
      prompt: 'what is this?',
      metadata: { userId: 'owner-user' },
      attachments: [
        {
          kind: 'image',
          name: 'screenshot.png',
          mimeType: 'image/png',
          size: pixels.length,
          dataUrl,
        },
      ],
    });
    const attachmentOf = (events: readonly PersistedRuntimeEvent[] = []) =>
      (
        events.find((event) => event.id === 'thread-img-turn')?.payload as {
          attachments?: Array<{ dataUrl?: string }>;
        }
      )?.attachments?.[0];

    for (let read = 0; read < 2; read += 1) {
      const events = store
        .listSessionProjectionEventsForThreads(['thread-img'])
        .get('thread-img');
      expect(attachmentOf(events)?.dataUrl).toBe(dataUrl);
    }
    const cache = (
      store as unknown as {
        sessionProjectionCache: Map<
          string,
          { events?: readonly PersistedRuntimeEvent[] }
        >;
      }
    ).sessionProjectionCache;
    const held = attachmentOf(cache.get('thread-img')?.events);
    expect(held).toBeDefined();
    expect(held?.dataUrl).toBeUndefined();
    expectMatchesFreshRead(['thread-img']);
  });

  test('returned rows are frozen, so one caller cannot change what the next read returns', () => {
    seedThread('thread-f');
    const [first] =
      store
        .listSessionProjectionEventsForThreads(['thread-f'])
        .get('thread-f') ?? [];
    expect(first).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first!.payload)).toBe(true);
    expect(() => {
      (first!.payload as { method: string }).method = 'tampered';
    }).toThrow(TypeError);
    expectMatchesFreshRead(['thread-f']);
  });

  test('with caches disabled every read folds every thread', () => {
    seedThread('thread-x');
    const internals = reference as unknown as {
      foldSessionProjectionEvents(ids: readonly string[]): unknown;
    };
    const fold = internals.foldSessionProjectionEvents.bind(reference);
    let folds = 0;
    internals.foldSessionProjectionEvents = (threadIds) => {
      folds += 1;
      return fold(threadIds);
    };
    reference.listSessionProjectionEventsForThreads(['thread-x']);
    reference.listSessionProjectionEventsForThreads(['thread-x']);
    expect(folds).toBe(2);
  });
});
