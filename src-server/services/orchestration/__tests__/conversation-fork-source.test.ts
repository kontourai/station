/**
 * The fork source read (`ConversationLineage.readConversationForkSource`):
 * all-or-nothing across the conversation's Sessions, and bounded from SQL
 * before any payload loads. The footprint itself is read from a real
 * EventStore.
 */
import { join } from 'node:path';
import { CONVERSATION_FORK_REFUSAL_CODES } from '@kontourai/station-contracts/orchestration';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  ConversationLineage,
  FORK_SOURCE_MAX_BYTES,
  FORK_SOURCE_MAX_EVENTS,
} from '../conversation-lineage.js';
import { EventStore } from '../event-store.js';

const CONVERSATION = 'conversation-fork-source';
const SESSIONS = [
  CONVERSATION,
  `${CONVERSATION}:session:middle`,
  `${CONVERSATION}:session:latest`,
];

/**
 * One readability predicate drives both the Session read and the seed read,
 * as in the service: an unreadable Session's seed read answers nothing.
 */
function lineageFor(options: {
  unreadable?: string;
  footprint?: { events: number; bytes: number };
}) {
  const readable = (id: string) => id !== options.unreadable;
  const readSessionSeedMessages = vi.fn((id: string): ConversationMessage[] =>
    readable(id)
      ? [
          {
            id: `${id}:user`,
            role: 'user',
            parts: [{ type: 'text', text: `TEXT-OF-${id}` }],
          },
        ]
      : [],
  );
  const readSessionsHistoryFootprint = vi.fn(
    () => options.footprint ?? { events: 10, bytes: 1_000 },
  );
  const lineage = new ConversationLineage({
    eventStore: {
      conversationSessions: () =>
        SESSIONS.map((sessionId, ordinal) => ({
          conversationId: CONVERSATION,
          sessionId,
          ordinal,
          createdAt: '2026-11-22T00:00:00.000Z',
        })),
      conversationForSession: () => undefined,
      readSessionByThread: () => ({ threadId: 'materialized' }),
      readSessionsHistoryFootprint,
      conversationTitle: () => undefined,
      readLatestAcceptedConversationModel: () => undefined,
    } as any,
    logger: { warn: vi.fn() },
    readSession: async (id: string) =>
      readable(id) ? ({ session: { threadId: id } } as any) : null,
    readSessionMessages: () => [],
    readSessionSeedMessages,
    listSessionReadModel: async () => [],
    canReadSession: readable,
  });
  return { lineage, readSessionSeedMessages, readSessionsHistoryFootprint };
}

describe('fork source read', () => {
  test('reads every Session of the conversation in lineage order', async () => {
    const { lineage } = lineageFor({});
    const read = await lineage.readConversationForkSource(
      CONVERSATION,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(read?.messages.map((message) => message.parts[0]?.text)).toEqual(
      SESSIONS.map((id) => `TEXT-OF-${id}`),
    );
  });

  test('a conversation with an unreadable middle Session is refused, never forked without it', async () => {
    const { lineage, readSessionsHistoryFootprint } = lineageFor({
      unreadable: SESSIONS[1],
    });
    expect(
      await lineage.readConversationForkSource(
        CONVERSATION,
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ).toBeNull();
    // Refused before its size is even looked at, so nothing is disclosed.
    expect(readSessionsHistoryFootprint).not.toHaveBeenCalled();
  });

  test.each([
    ['events', { events: FORK_SOURCE_MAX_EVENTS + 1, bytes: 1_000 }],
    ['bytes', { events: 10, bytes: FORK_SOURCE_MAX_BYTES + 1 }],
  ])(
    'a history past the %s bound is refused before any payload loads',
    async (_bound, footprint) => {
      const { lineage, readSessionSeedMessages } = lineageFor({ footprint });
      await expect(
        lineage.readConversationForkSource(
          CONVERSATION,
          INTERNAL_SESSION_READ_SCOPE,
        ),
      ).rejects.toMatchObject({
        code: CONVERSATION_FORK_REFUSAL_CODES.historyTooLarge,
      });
      expect(readSessionSeedMessages).not.toHaveBeenCalled();
    },
  );

  test('a history exactly at both bounds is read', async () => {
    const { lineage } = lineageFor({
      footprint: {
        events: FORK_SOURCE_MAX_EVENTS,
        bytes: FORK_SOURCE_MAX_BYTES,
      },
    });
    const read = await lineage.readConversationForkSource(
      CONVERSATION,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(read?.messages).toHaveLength(SESSIONS.length);
  });

  test('the bounds are the measured limits', () => {
    expect(FORK_SOURCE_MAX_EVENTS).toBe(32_000);
    expect(FORK_SOURCE_MAX_BYTES).toBe(16_777_216);
  });
});

describe('history footprint', () => {
  const makeTempDir = trackTempDirs();
  const stores: EventStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  test('counts the stored events and bytes of the named Sessions only, out-of-line content included', () => {
    const store = new EventStore(
      join(makeTempDir('station-fork-footprint-'), 'orchestration.sqlite'),
    );
    stores.push(store);
    const append = (threadId: string, index: number, outputText: string) =>
      store.appendEvent({
        eventId: `${threadId}:${index}`,
        provider: 'codex',
        threadId,
        turnId: `${threadId}:turn-${index}`,
        createdAt: new Date(Date.UTC(2026, 10, 22, 0, 0, index)).toISOString(),
        method: 'turn.completed',
        outputText,
      } as never);
    for (let index = 0; index < 5; index++)
      append('first', index, `answer ${index}`);
    for (let index = 0; index < 3; index++)
      append('second', index, `reply ${index}`);
    append('other', 0, 'not counted');
    // Large enough to be stored out of line.
    const long = 'x'.repeat(200_000);
    append('second', 3, long);
    const storedPayloadBytes = (threadIds: string[]) =>
      (
        store['db']
          .prepare(
            `SELECT payload FROM orchestration_events WHERE thread_id IN (${threadIds.map(() => '?').join(', ')})`,
          )
          .all(...threadIds) as { payload: string }[]
      ).reduce((sum, row) => sum + Buffer.byteLength(row.payload, 'utf8'), 0);
    const footprint = store.readSessionsHistoryFootprint(['first', 'second']);
    expect(footprint.events).toBe(9);
    // The spilled body counts, though the stored event holds only its reference.
    expect(storedPayloadBytes(['second'])).toBeLessThan(long.length);
    expect(footprint.bytes).toBeGreaterThanOrEqual(
      storedPayloadBytes(['first', 'second']) + long.length,
    );
    expect(store.readSessionsHistoryFootprint(['first'])).toEqual({
      events: 5,
      bytes: storedPayloadBytes(['first']),
    });
  });
});
