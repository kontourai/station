/**
 * Shared long-session transcript fixture (archive#3307).
 *
 * One canonical builder for the 10,000-turn orchestration event corpus that
 * used to live inline in `tests/mobile-chat-composer.spec.ts`. Consumers:
 *
 * - `tests/mobile-chat-composer.spec.ts` — mobile virtualization journey
 *   (splices its own tool/approval events onto the returned turns).
 * - `tests/daily-driver-scenarios.spec.ts` — transcript-stability and
 *   performance-stress qualification scenarios.
 *
 * `src-ui/src/__tests__/TranscriptVirtualizer.test.tsx` deliberately keeps
 * its own four-line fixture: it feeds already-projected `{ id, kind }` row
 * view-models into a jsdom-mocked virtualizer, one layer below the
 * orchestration event shape this module builds. Reusing this fixture there
 * would drag the whole event→row projection into a component unit test for
 * no shared content.
 */

import type { Route } from '@playwright/test';

export const LONG_SESSION_TURN_COUNT = 10_000;

export interface LongSessionTurnOptions {
  threadId: string;
  provider?: string;
  turnCount?: number;
  baseTimestamp?: string;
  promptText?: (index: number) => string;
  replyText?: (index: number) => string;
}

export type LongSessionEvent = Record<string, unknown>;

/**
 * Builds `turnCount` completed turns as `[turn.started, turn.completed]`
 * event pairs, newest last, each stamped one millisecond apart.
 */
export function buildLongSessionTurns({
  threadId,
  provider = 'bedrock',
  turnCount = LONG_SESSION_TURN_COUNT,
  baseTimestamp = '2026-07-19T10:00:00Z',
  promptText = (index) => `Transcript fixture ${index}: prompt.`,
  replyText = (index) =>
    `Transcript fixture ${index}: retained content for selection.`,
}: LongSessionTurnOptions): LongSessionEvent[][] {
  const baseMs = Date.parse(baseTimestamp);
  return Array.from({ length: turnCount }, (_, index) => {
    const createdAt = new Date(baseMs + index).toISOString();
    return [
      {
        eventId: `turn-${index}-started`,
        method: 'turn.started',
        provider,
        threadId,
        turnId: `turn-${index}`,
        createdAt,
        prompt: promptText(index),
      },
      {
        eventId: `turn-${index}-completed`,
        method: 'turn.completed',
        provider,
        threadId,
        turnId: `turn-${index}`,
        createdAt,
        outputText: replyText(index),
      },
    ];
  });
}

export interface LongSessionEventWindowOptions {
  threadId: string;
  provider?: string;
  /**
   * Called per request so a spec can grow the corpus mid-test (e.g. after a
   * live turn persists). Defaults to the initial turns forever.
   */
  availableTurns: () => LongSessionEvent[][];
  onRequest?: (url: string) => void;
}

/**
 * Cursor-paged `/event-window` responder over a long-session corpus,
 * mirroring the server's newest-first `turnLimit`/`cursor` contract. Returns
 * a Playwright route handler.
 */
export function createLongSessionEventWindowHandler({
  threadId,
  provider = 'bedrock',
  availableTurns,
  onRequest,
}: LongSessionEventWindowOptions) {
  return (route: Route) => {
    const url = route.request().url();
    onRequest?.(url);
    const cursor = new URL(url).searchParams.get('cursor');
    const alreadyLoaded = cursor
      ? Number.parseInt(cursor.replace('older-turns-', ''), 10)
      : 0;
    const requestedLimit = Number(
      new URL(url).searchParams.get('turnLimit') ?? '10',
    );
    const turns = availableTurns();
    const sequenceByEventId = new Map(
      turns.flat().map((event, index) => [event.eventId, index + 1]),
    );
    const end = turns.length - alreadyLoaded;
    const start = Math.max(0, end - requestedLimit);
    const pageTurns = turns.slice(start, end);
    const totalLoaded = alreadyLoaded + pageTurns.length;
    const body = {
      success: true,
      data: {
        protocolVersion: 1,
        session: { threadId, provider, status: 'idle' },
        events: pageTurns.flat().map((event, index) => ({
          sequence: sequenceByEventId.get(event.eventId) ?? 20_000 + index,
          event,
        })),
        hasMore: start > 0,
        nextCursor: start > 0 ? `older-turns-${totalLoaded}` : undefined,
        // The corpus's own size, deliberately, where the inline builder this
        // module replaced hardcoded 10000: a caller that shrinks `turnCount`
        // (performance-stress uses 1,000) or grows the corpus mid-test would
        // otherwise be served a watermark describing a different transcript.
        watermark: turns.length,
      },
    };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  };
}
