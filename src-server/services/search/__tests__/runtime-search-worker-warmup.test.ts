/**
 * station#1707 (second cause) — THE SPAWN IS NOT PART OF THE READ.
 *
 * The transcript reader is a `worker_threads` worker created on first use.
 * Three budgets bracket a search and every one of them starts before that
 * spawn: `UNIFIED_SEARCH_LIMITS.providerTimeoutMs`, `readAuthorized`'s own
 * deadline, and the worker's read deadline. So the FIRST search after a
 * runtime booted paid thread creation, entry-module load (transform
 * included, under a test runner) and database open out of a budget meant for
 * the query — and on a loaded host it exceeded it. The response was a 200
 * whose `station.messages` source was `unavailable` with
 * `provider-timeout-or-error`, which reads as "there are no messages".
 *
 * The property this pins is the ordering, not a duration: a slow start is
 * waited for OUTSIDE the provider budget, so the source stays `available`.
 * The transcript reader is stubbed rather than real precisely so the start
 * can be held open for longer than every one of those budgets without the
 * test depending on how slow a real worker happens to be today.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchOutcome,
} from '@kontourai/station-contracts/unified-search';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TaskGraphService } from '../../projects/task-graph-service.js';
import { createRuntimeSearch } from '../runtime-search.js';

const directories: string[] = [];
const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Longer than every budget that brackets a search, so no arm of the fix is a coincidence. */
const SLOW_START_MS = 3_000;

function fixture(whenReady: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'station-search-warmup-'));
  directories.push(home);
  const transcriptSearch = {
    whenReady,
    inspect: () => ({ phase: 'idle' as const }),
    close: async () => ({ state: 'closed' as const }),
    readMessagePage: async () => ({ state: 'unavailable' as const }),
    openSession: async () => ({ state: 'not-found' as const }),
    open: async () => ({ state: 'not-found' as const }),
    // Models the real reader: a worker that is not up yet cannot answer.
    // Without this the stub would resolve during the boot it is meant to be
    // blocked by, and the test would pass whether or not readiness is
    // awaited ahead of the budgets — verified by injection.
    search: async () => {
      await whenReady();
      return {
        state: 'available' as const,
        matches: [
          {
            conversationId: 'thread-warm',
            messageId: 'event-warm:user',
            role: 'user' as const,
            excerpt: 'cobalt receipt',
          },
        ],
      };
    },
  };
  const search = createRuntimeSearch({
    stationId: '22222222-2222-4222-8222-222222222222',
    tasks: new TaskGraphService(home, {
      resolveProjectWorkspace: async () => '',
    }),
    transcripts: {
      createIsolatedTranscriptSearch: () => transcriptSearch,
      retireIsolatedTranscriptSearchAfterFailedInitialization: async () => ({
        state: 'closed' as const,
      }),
    } as unknown as Parameters<typeof createRuntimeSearch>[0]['transcripts'],
  });
  closers.push(() => search.close());
  return search;
}

function messagesSource(
  outcome: Exclude<UnifiedSearchOutcome, { state: 'invalid' }>,
) {
  return outcome.sources?.find(
    (source) => source.providerId === 'station.messages',
  );
}

describe('transcript worker warm-up (station#1707)', () => {
  test('a start slower than every search budget still answers with the messages source available', async () => {
    vi.useFakeTimers();
    let start: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const search = fixture(() => started);

    const outcome = search.search(
      { version: UNIFIED_SEARCH_V1, query: 'cobalt' },
      {
        authority: sessionReadAuthorityFromRequest(
          'user',
          undefined,
          undefined,
        ),
        current: () => true,
      },
    );

    // The worker is still coming up for longer than `providerTimeoutMs`.
    // Nothing may be armed against it yet: if the provider budget had
    // started, this advance is what would trip it.
    await vi.advanceTimersByTimeAsync(SLOW_START_MS);
    start();

    const resolved = await outcome;
    // `invalid` is the other arm of the union, and it carries neither
    // `sources` nor `results` — reaching it would make every assertion below
    // unreachable rather than failing, so it is refused here by name.
    if (resolved.state === 'invalid')
      throw new Error(`search was refused as invalid: ${resolved.reason}`);
    expect(messagesSource(resolved)?.state).toBe('available');
    // An `available` source that returned nothing would satisfy the state
    // assertion alone, so the match has to arrive with it.
    expect(
      resolved.results.filter((result) => result.kind === 'message'),
    ).toHaveLength(1);
  });

  test('the reader is started at composition, not left for the first request', () => {
    vi.useFakeTimers();
    const whenReady = vi.fn(async () => {});
    fixture(whenReady);

    // Composition alone must have asked for the worker; a runtime that waits
    // for a request to start it has simply moved the cold start, not paid it.
    expect(whenReady).toHaveBeenCalledTimes(1);
  });
});
