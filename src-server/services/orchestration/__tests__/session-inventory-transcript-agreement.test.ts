import { join } from 'node:path';
import * as projection from '@kontourai/station-shared/runtime-event-projection';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

// A pass-through, counted: the listing must ask the transcript projection,
// and only once per read however many pages and unresolved rows it meets.
const projected = vi.hoisted(() => ({ calls: 0 }));
vi.mock(
  '@kontourai/station-shared/runtime-event-projection',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/runtime-event-projection')
      >();
    return {
      ...actual,
      projectRuntimeEventsToMessages: (
        ...args: Parameters<typeof actual.projectRuntimeEventsToMessages>
      ) => {
        projected.calls += 1;
        return actual.projectRuntimeEventsToMessages(...args);
      },
    };
  },
);

const tempRoot = trackTempDirs();

/** Seeded PRNG, so a failure names one reproducible case. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Event = Record<string, unknown> & { eventId: string; method: string };

/**
 * One session: turns with text, tool calls that settle, and the ways a call
 * is left open — the Claude session-end settle (turnId omitted when the
 * tracked call had none), a late result after it, a turn-end settle (Muse),
 * a stop that leaves a turn without turn.completed, and a call id a later
 * turn reuses (a provider that recycles ids).
 */
function generateSession(random: () => number, threadId: string): Event[] {
  const events: Event[] = [];
  let serial = 0;
  const id = (prefix: string) => `${threadId}:${prefix}-${++serial}`;
  const base = (method: string, extra: Record<string, unknown>) =>
    ({
      provider: 'claude',
      threadId,
      createdAt: '2026-10-24T16:00:00.000Z',
      eventId: id(method.replace('.', '-')),
      method,
      ...extra,
    }) as Event;
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)]!;
  const open = new Map<string, { turnId?: string; toolName: string }>();
  const settled = new Map<string, { turnId?: string; toolName: string }>();
  const usedIds: string[] = [];
  const turns = 1 + Math.floor(random() * 4);
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = `turn-${turn}`;
    events.push(
      base('turn.started', {
        turnId,
        prompt: `Prompt ${turn}`,
        attachments: [],
      }),
    );
    // Some turns write no assistant text at all.
    if (random() < 0.55)
      events.push(base('content.text-delta', { turnId, delta: 'Working.' }));
    const calls = Math.floor(random() * 4);
    for (let call = 0; call < calls; call += 1) {
      const reuse = usedIds.length > 0 && random() < 0.1;
      const toolCallId = reuse ? pick(usedIds) : `call-${turn}-${call}`;
      if (!reuse) usedIds.push(toolCallId);
      const toolName = pick(['Bash', 'Read', 'Task']);
      // Claude tracks the issuing turn; a few writers do not know it.
      const tracked = random() < 0.85 ? turnId : undefined;
      const started = base('tool.started', {
        ...(tracked ? { turnId: tracked } : {}),
        itemId: toolCallId,
        toolCallId,
        toolName,
      });
      events.push(started);
      // A user steer opens the same turn again mid-call.
      if (random() < 0.25)
        events.push(
          base('turn.started', {
            turnId,
            inputKind: 'steer',
            prompt: 'Also check the tests',
            attachments: [],
          }),
        );
      // A retried call is started again before it settles.
      if (random() < 0.25)
        events.push({ ...started, eventId: id('tool-started') });
      const outcome = random();
      if (outcome < 0.55) {
        events.push(
          base('tool.completed', {
            ...(tracked ? { turnId: tracked } : {}),
            itemId: toolCallId,
            toolCallId,
            toolName,
            status: random() < 0.85 ? 'success' : 'error',
            output: 'ok',
          }),
        );
      } else if (outcome < 0.65) {
        // Muse settles open calls when its one-turn process ends.
        events.push(
          base('tool.completed', {
            turnId,
            itemId: toolCallId,
            toolCallId,
            toolName,
            status: 'unresolved',
            output:
              'No result was reported before the turn ended; whether the tool ran is unknown.',
          }),
        );
      } else {
        open.set(toolCallId, { turnId: tracked, toolName });
      }
    }
    if (random() < 0.75)
      events.push(base('turn.completed', { turnId, finishReason: 'stop' }));
    // The session sometimes ends here: everything still open is settled.
    if (random() < 0.35 || turn === turns - 1) {
      for (const [toolCallId, tracked] of open) {
        // The Claude settle names the call's turn only when it tracked one.
        const settleTurn = random() < 0.7 ? tracked.turnId : undefined;
        events.push(
          base('tool.completed', {
            ...(settleTurn ? { turnId: settleTurn } : {}),
            itemId: toolCallId,
            toolCallId,
            toolName: tracked.toolName,
            status: 'unresolved',
            output:
              'No result was reported before the session ended; whether the tool ran is unknown.',
          }),
        );
        settled.set(toolCallId, tracked);
      }
      open.clear();
      // A result the SDK still held arrives after the settle.
      for (const [toolCallId, tracked] of settled) {
        if (random() < 0.4) {
          events.push(
            base('tool.completed', {
              ...(tracked.turnId ? { turnId: tracked.turnId } : {}),
              itemId: toolCallId,
              toolCallId,
              toolName: tracked.toolName,
              status: random() < 0.8 ? 'success' : 'error',
              output: 'late',
            }),
          );
          settled.delete(toolCallId);
        }
      }
    }
  }
  return events;
}

/** Every tool completion the listing reports, across all of its pages. */
function listedCompletions(store: EventStore, threadId: string, limit: number) {
  const ids: string[] = [];
  let continuation: { sequence: number; eventId: string } | undefined;
  let highWater: number | undefined;
  for (let page = 0; page < 10_000; page += 1) {
    const read = store.listSessionInventoryEvents(threadId, {
      group: 'execution',
      limit,
      frozenHighWater: highWater,
      continuation,
    });
    highWater = read.highWater;
    for (const event of read.events)
      if (event.method === 'tool.completed') ids.push(event.id);
    continuation = read.continuation;
    if (!continuation) return ids;
  }
  throw new Error('the listing did not end');
}

/** The settled tool rows of the transcript, as its read path builds it. */
function transcriptCompletions(store: EventStore, threadId: string) {
  return projection
    .projectRuntimeEventsToMessages(store.listEventPayloads(threadId))
    .flatMap((message) => message.parts)
    .filter(
      (part) =>
        part.type === 'tool-invocation' &&
        typeof part.sourceEventId === 'string',
    )
    .map((part) => part.sourceEventId as string);
}

describe('the Session inventory lists tool results exactly as the transcript shows them (#4178)', () => {
  test('agrees with the transcript on 1,000 seeded sessions in the shapes real writers emit', () => {
    const store = new EventStore(
      join(tempRoot('station-inventory-differential-'), 'orchestration.sqlite'),
    );
    try {
      const random = mulberry32(4178);
      const mismatches: string[] = [];
      let unresolvedListed = 0;
      let unresolvedReplaced = 0;
      for (let index = 0; index < 1000; index += 1) {
        const threadId = `station:1:session:differential-${index}`;
        const events = generateSession(random, threadId);
        for (const event of events) store.appendEvent(event as never);
        // Pages of three exercise continuations and the per-read cache.
        const listed = listedCompletions(store, threadId, 3).sort();
        const shown = transcriptCompletions(store, threadId).sort();
        if (JSON.stringify(listed) !== JSON.stringify(shown))
          mismatches.push(
            `${threadId}: listed ${listed.join(',')} / transcript ${shown.join(',')}`,
          );
        for (const event of events)
          if (
            event.method === 'tool.completed' &&
            event.status === 'unresolved'
          )
            if (listed.includes(event.eventId)) unresolvedListed += 1;
            else unresolvedReplaced += 1;
      }
      expect(mismatches.length, mismatches.slice(0, 3).join('\n')).toBe(0);
      // Reached: both outcomes occur often, not by luck of the seed.
      expect(unresolvedListed).toBeGreaterThan(100);
      expect(unresolvedReplaced).toBeGreaterThan(100);
    } finally {
      store.close?.();
    }
  });

  test('one call id carrying 10k events costs one projection and one cursor, however many pages', () => {
    const store = new EventStore(
      join(tempRoot('station-inventory-differential-'), 'orchestration.sqlite'),
    );
    try {
      const threadId = 'station:1:session:one-call-id';
      store.appendEvent({
        provider: 'claude',
        threadId,
        createdAt: '2026-10-24T16:00:00.000Z',
        eventId: 'start',
        turnId: 'turn-1',
        method: 'turn.started',
        prompt: 'Run it',
        attachments: [],
      } as never);
      for (let index = 0; index < 10_000; index += 1)
        store.appendEvent({
          provider: 'claude',
          threadId,
          createdAt: '2026-10-24T16:00:01.000Z',
          eventId: `same-${index}`,
          turnId: 'turn-1',
          itemId: 'same',
          method: index % 2 ? 'tool.completed' : 'tool.started',
          toolCallId: 'same',
          toolName: 'Bash',
          ...(index % 2
            ? {
                status: index % 4 === 1 ? 'unresolved' : 'success',
                output: 'x',
              }
            : {}),
        } as never);

      // The listing's own statement, as it ran: orchestration_events is read
      // through one cursor, with no correlated subquery over later events.
      const db = (
        store as unknown as {
          db: {
            prepare(sql: string): { all(...args: unknown[]): unknown[] };
          };
        }
      ).db;
      let captured: { sql: string; args: unknown[] } | undefined;
      const prepare = db.prepare.bind(db);
      db.prepare = (sql: string) => {
        const statement = prepare(sql);
        if (!sql.includes('station_unresolved_completion_stands'))
          return statement;
        return {
          all: (...args: unknown[]) => {
            captured ??= { sql, args };
            return statement.all(...args);
          },
        };
      };
      projected.calls = 0;
      const listed = listedCompletions(store, threadId, 20);
      db.prepare = prepare;
      if (!captured) throw new Error('the listing statement was not observed');
      const plan = prepare(`EXPLAIN QUERY PLAN ${captured.sql}`)
        .all(...captured.args)
        .map((row) => (row as { detail: string }).detail);
      expect(
        plan.filter((detail) => /\borchestration_events\b/.test(detail)),
      ).toHaveLength(1);
      // 250 pages of 20, one projection for the whole read.
      expect(projected.calls).toBe(1);
      expect(listed.sort()).toEqual(
        transcriptCompletions(store, threadId).sort(),
      );
    } finally {
      store.close?.();
    }
  });
});
