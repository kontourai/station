import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  AnswerShareService,
  NO_CHANNEL_LOG_OBSERVER,
} from '../../share/answer-share-service.js';
import { AnswerShareStore } from '../../share/answer-share-store.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

/**
 * #5078 (docs/decisions/tool-progress-compaction.md): compaction of
 * superseded `tool.progress` rows, through a real SQLite EventStore and the
 * OrchestrationService readers that consume it. Every reader is read before
 * and after one pass; each kept row below is kept by exactly one rule, so
 * dropping that rule from the selection fails the case that names it.
 */

const OWNER = 'owner-user';
const MAIN = 'thread-main';
const OLD_TIME = '2026-08-01T00:00:00.000Z';
const RECENT_TIME = '2026-11-10T00:00:00.000Z';
const CUTOFF = '2026-10-01T00:00:00.000Z';
/** Spilled `tool.progress` outputs: only BIG_ONE is referenced by one row. */
const BIG_ONE = 'first progress output '.repeat(1_000);
const BIG_SHARED = 'shared progress output '.repeat(1_000);
const authority = sessionReadAuthorityFromRequest(OWNER, undefined, undefined);

/** Progress rows the pass must delete; every other row is kept. */
const SUPERSEDED = ['a1', 'a2', 'b2', 'e1', 'e2'];

describe('tool.progress compaction (#5078)', () => {
  const makeTempDir = trackTempDirs();
  let directory: string;
  let store: EventStore;
  let reference: EventStore;
  let service: OrchestrationService;

  beforeEach(() => {
    directory = makeTempDir('tool-progress-compaction-');
    const path = join(directory, 'orchestration.sqlite');
    store = new EventStore(path);
    vi.stubEnv('STATION_DISABLE_EVENT_STORE_CACHES', '1');
    reference = new EventStore(path);
    vi.unstubAllEnvs();
    service = new OrchestrationService({
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    service.initialize();
    // Station receipt time (`observed_at`) follows the clock.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await service.shutdown();
    reference.close();
    store.close();
  });

  function append(event: Record<string, unknown>): void {
    store.appendEvent({
      provider: 'claude',
      createdAt: new Date().toISOString(),
      ...event,
    } as unknown as CanonicalRuntimeEvent);
  }

  function seedSession(
    threadId: string,
    controlMode?: 'read-only-attached',
  ): void {
    vi.setSystemTime(new Date(OLD_TIME));
    store.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      ...(controlMode ? { controlMode } : {}),
      createdAt: OLD_TIME,
      updatedAt: OLD_TIME,
    });
    append({
      eventId: `${threadId}-session`,
      threadId,
      method: 'session.started',
      sessionId: threadId,
      metadata: { agentSlug: 'claude', userId: OWNER },
    });
  }

  /** `tool.started`, the given progress rows (or other events), then optionally `tool.completed`. */
  function call(
    threadId: string,
    turnId: string,
    callId: string,
    steps: Array<string | Record<string, unknown>>,
    completed = true,
  ): void {
    append({
      eventId: `${threadId}-${callId}-started`,
      threadId,
      turnId,
      method: 'tool.started',
      itemId: callId,
      toolCallId: callId,
      toolName: 'shell',
      arguments: { command: callId },
    });
    for (const step of steps) {
      if (typeof step === 'string')
        append({
          eventId: step,
          threadId,
          turnId,
          method: 'tool.progress',
          itemId: callId,
          toolCallId: callId,
          message: `progress ${step}`,
        });
      else append({ threadId, turnId, ...step });
    }
    if (completed)
      append({
        eventId: `${threadId}-${callId}-completed`,
        threadId,
        turnId,
        method: 'tool.completed',
        itemId: callId,
        toolCallId: callId,
        toolName: 'shell',
        status: 'success',
        output: `output of ${callId}`,
      });
  }

  function progress(
    eventId: string,
    callId: string,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      eventId,
      method: 'tool.progress',
      itemId: callId,
      toolCallId: callId,
      message: `progress ${eventId}`,
      ...extra,
    };
  }

  function turn(
    threadId: string,
    turnId: string,
    body: () => void,
    terminal = true,
  ): void {
    append({
      eventId: `${threadId}-${turnId}-started`,
      threadId,
      turnId,
      method: 'turn.started',
      prompt: `prompt for ${turnId}`,
    });
    body();
    append({
      eventId: `${threadId}-${turnId}-delta`,
      threadId,
      turnId,
      method: 'content.text-delta',
      itemId: 'text',
      delta: `Answer for ${turnId}.`,
    });
    if (terminal)
      append({
        eventId: `${threadId}-${turnId}-completed`,
        threadId,
        turnId,
        method: 'turn.completed',
        finishReason: 'stop',
        outputText: `Answer for ${turnId}.`,
      });
  }

  /**
   * One settled old turn whose calls exercise each rule, an old turn without
   * a terminal, and a recent settled turn.
   */
  function seedMainThread(): void {
    seedSession(MAIN);
    turn(MAIN, 'turn-old', () => {
      // a1, a2 superseded by a3 across a text delta: deleted.
      call(MAIN, 'turn-old', 'call-a', [
        'a1',
        {
          eventId: 'a-delta',
          method: 'content.text-delta',
          itemId: 'text',
          delta: 'Working. ',
        },
        'a2',
        'a3',
      ]);
      // b1 carries a truncated-output receipt: kept. b2 superseded: deleted.
      call(MAIN, 'turn-old', 'call-b', [
        progress('b1', 'call-b', {
          outputReceipt: { truncated: true, reasons: ['bytes'] },
        }),
        'b2',
        'b3',
      ]);
      // No tool.completed for call-c: both kept.
      call(MAIN, 'turn-old', 'call-c', ['c1', 'c2'], false);
      // A runtime warning between d1 and d2 could move the call: d1 kept.
      call(MAIN, 'turn-old', 'call-d', [
        'd1',
        {
          eventId: 'd-warning',
          method: 'runtime.warning',
          message: 'slow tool',
        },
        'd2',
      ]);
      // Spilled outputs: e1's body is its own, e2 and e3 share theirs.
      call(MAIN, 'turn-old', 'call-e', [
        progress('e1', 'call-e', { output: BIG_ONE }),
        progress('e2', 'call-e', { output: BIG_SHARED }),
        progress('e3', 'call-e', { output: BIG_SHARED }),
      ]);
    });
    // Old, but the turn never settled: kept.
    turn(
      MAIN,
      'turn-unsettled',
      () => call(MAIN, 'turn-unsettled', 'call-f', ['f1', 'f2']),
      false,
    );
    vi.setSystemTime(new Date(RECENT_TIME));
    // Settled, but recent: kept.
    turn(MAIN, 'turn-recent', () =>
      call(MAIN, 'turn-recent', 'call-g', ['g1', 'g2']),
    );
  }

  const compact = (maxRows = 10_000) =>
    store.compactSettledToolProgress({ cutoff: CUTOFF, maxRows });

  function progressIds(threadId: string): string[] {
    return store
      .listEventPayloads(threadId, ['tool.progress'])
      .map((event) => event.eventId);
  }

  function contentDigests(threadId: string): string[] {
    return (
      store['db']
        .prepare(
          'SELECT digest FROM orchestration_event_content WHERE thread_id = ? ORDER BY digest',
        )
        .all(threadId) as Array<{ digest: string }>
    ).map((row) => row.digest);
  }

  function spilledDigest(eventId: string): string {
    const event = store
      .listEventPayloads(MAIN, ['tool.progress'])
      .find((item) => item.eventId === eventId) as unknown as {
      output: { ref: string };
    };
    return event.output.ref;
  }

  function head(threadId: string) {
    return store['db']
      .prepare(
        'SELECT id, sequence, global_sequence FROM orchestration_events WHERE thread_id = ? ORDER BY sequence DESC LIMIT 1',
      )
      .get(threadId);
  }

  async function pageAll(threadId: string) {
    const seen: Array<{ sequence: number; eventId: string }> = [];
    let afterSequence = 0;
    const highWater: number[] = [];
    for (let pages = 0; pages < 50; pages += 1) {
      const page = await service.readSessionEventPage(threadId, {
        afterSequence,
        limit: 4,
        authority,
      });
      if (!page) throw new Error('no event page');
      seen.push(
        ...page.events.map(({ sequence, event }) => ({
          sequence,
          eventId: event.eventId,
        })),
      );
      highWater.push(page.highWaterSequence ?? -1);
      afterSequence = page.nextSequence;
      if (!page.hasMore) return { seen, last: afterSequence, highWater };
    }
    throw new Error('paging did not finish');
  }

  test('deletes only superseded rows of settled calls in old settled turns', async () => {
    seedMainThread();
    const before = progressIds(MAIN);
    const pass = await compact();
    expect(pass.rowsDeleted).toBe(SUPERSEDED.length);
    expect(pass.threads).toBe(1);
    expect(pass.cycleCompleted).toBe(true);
    expect(progressIds(MAIN)).toEqual(
      before.filter((id) => !SUPERSEDED.includes(id)),
    );
    // A second pass finds nothing more.
    expect((await compact()).rowsDeleted).toBe(0);
  });

  test('keeps the last progress row of every call', async () => {
    seedMainThread();
    await compact();
    for (const last of ['a3', 'b3', 'c2', 'd2', 'e3', 'f2', 'g2'])
      expect(progressIds(MAIN)).toContain(last);
  });

  test('keeps a row carrying a truncated-output receipt', async () => {
    seedMainThread();
    await compact();
    expect(progressIds(MAIN)).toContain('b1');
  });

  test('keeps progress of a call with no tool.completed', async () => {
    seedMainThread();
    await compact();
    expect(progressIds(MAIN)).toEqual(expect.arrayContaining(['c1', 'c2']));
  });

  test('keeps progress of a turn without turn.completed or turn.aborted', async () => {
    seedMainThread();
    await compact();
    expect(progressIds(MAIN)).toEqual(expect.arrayContaining(['f1', 'f2']));
  });

  test('keeps progress of a settled turn younger than the cutoff', async () => {
    seedMainThread();
    await compact();
    expect(progressIds(MAIN)).toEqual(expect.arrayContaining(['g1', 'g2']));
  });

  test('keeps a row when a non-transparent event lies before its successor', async () => {
    seedMainThread();
    await compact();
    expect(progressIds(MAIN)).toContain('d1');
  });

  test('keeps a row a side table names', async () => {
    seedMainThread();
    store['db']
      .prepare(
        `INSERT INTO orchestration_session_projection_facts (thread_id, fact_key, event_id)
         VALUES (?, 'test-fact', 'a1')`,
      )
      .run(MAIN);
    await compact();
    expect(progressIds(MAIN)).toContain('a1');
    expect(progressIds(MAIN)).not.toContain('a2');
  });

  test('never deletes the thread head, and the next append continues from it', async () => {
    seedMainThread();
    const before = head(MAIN) as { sequence: number };
    await compact();
    expect(head(MAIN)).toEqual(before);
    append({
      eventId: 'after-compaction',
      threadId: MAIN,
      turnId: 'turn-next',
      method: 'turn.started',
      prompt: 'next',
    });
    expect(head(MAIN)).toMatchObject({
      id: 'after-compaction',
      sequence: before.sequence + 1,
    });
  });

  test('the transcript projection is identical before and after', async () => {
    seedMainThread();
    const before = service.readSessionMessages(MAIN, authority);
    // The fixture reaches what the rules protect.
    const parts = before.flatMap((message) => message.parts) as Array<{
      toolCallId?: string;
      progressMessage?: string;
      outputTruncated?: boolean;
    }>;
    expect(parts.find((part) => part.toolCallId === 'call-a')).toMatchObject({
      progressMessage: 'progress a3',
    });
    expect(parts.find((part) => part.toolCallId === 'call-b')).toMatchObject({
      progressMessage: 'progress b3',
      outputTruncated: true,
    });
    await compact();
    expect(service.readSessionMessages(MAIN, authority)).toEqual(before);
  });

  test('the answer-share digest minted before compaction still verifies', async () => {
    seedMainThread();
    const homeDir = makeTempDir('tool-progress-share-');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const shares = new AnswerShareService({
      store: new AnswerShareStore({ homeDir }),
      sessions: {
        readSessionMessages: (threadId, readAuthority) =>
          service.readSessionMessages(threadId, readAuthority),
      },
      channelObserver: NO_CHANNEL_LOG_OBSERVER,
    });
    const minted = await shares.mint(
      { sessionId: MAIN, turnId: 'turn-old', ownerUserId: OWNER },
      authority,
    );
    if (!('token' in minted)) throw new Error('mint failed');
    const before = shares.view(minted.token, authority);
    expect(before.state).toBe('ok');
    await compact();
    expect(shares.view(minted.token, authority)).toEqual(before);
  });

  test('readAnswerBasis is identical before and after', async () => {
    seedMainThread();
    const read = () =>
      service.sessionQueries.readAnswerBasis?.(
        { type: 'answer-basis', threadId: MAIN, turnId: 'turn-old' },
        authority,
      );
    const before = await read();
    expect(before?.status).toBe('found');
    await compact();
    expect(await read()).toEqual(before);
  });

  test('event paging returns every kept row with its sequence and the same high water', async () => {
    seedMainThread();
    const before = await pageAll(MAIN);
    await compact();
    const after = await pageAll(MAIN);
    expect(after.seen).toEqual(
      before.seen.filter(({ eventId }) => !SUPERSEDED.includes(eventId)),
    );
    expect(after.last).toBe(before.last);
    expect(new Set(after.highWater)).toEqual(new Set([before.last]));
  });

  test('cached projection events and counts match a fresh read after compaction', async () => {
    seedMainThread();
    const projectionBefore = store.listSessionProjectionEventsForThreads([
      MAIN,
    ]);
    const countBefore = store.countEventsByThreads([MAIN]).get(MAIN)!;
    await compact();
    // Same projection facts: no fold method is ever compacted.
    expect(store.listSessionProjectionEventsForThreads([MAIN])).toEqual(
      projectionBefore,
    );
    expect(store.listSessionProjectionEventsForThreads([MAIN])).toEqual(
      reference.listSessionProjectionEventsForThreads([MAIN]),
    );
    expect(store.countEventsByThreads([MAIN]).get(MAIN)).toBe(
      countBefore - SUPERSEDED.length,
    );
    expect(store.countEventsByThreads([MAIN])).toEqual(
      reference.countEventsByThreads([MAIN]),
    );
  });

  test('deletes a spilled body only it referenced and keeps a shared one', async () => {
    seedMainThread();
    const own = spilledDigest('e1');
    const shared = spilledDigest('e3');
    expect(spilledDigest('e2')).toBe(shared);
    expect(contentDigests(MAIN)).toEqual(expect.arrayContaining([own, shared]));
    const pass = await compact();
    expect(contentDigests(MAIN)).not.toContain(own);
    expect(contentDigests(MAIN)).toContain(shared);
    expect(pass.contentRowsDeleted).toBe(1);
    expect(pass.contentBytes).toBe(Buffer.byteLength(BIG_ONE));
    expect(store.readEventContent(MAIN, [shared]).get(shared)?.body).toContain(
      'shared progress output',
    );
  });

  test('leaves read-only attached threads untouched', async () => {
    const attached = 'thread-attached';
    seedSession(attached, 'read-only-attached');
    turn(attached, 'turn-old', () =>
      call(attached, 'turn-old', 'call-a', [
        'attached-1',
        'attached-2',
        'attached-3',
      ]),
    );
    const pass = await compact();
    expect(pass.rowsDeleted).toBe(0);
    expect(progressIds(attached)).toEqual([
      'attached-1',
      'attached-2',
      'attached-3',
    ]);
  });

  test('stops at the row budget and resumes on the next pass', async () => {
    seedMainThread();
    const first = await compact(2);
    expect(first.rowsDeleted).toBe(2);
    expect(first.budgetExhausted).toBe(true);
    const second = await compact();
    expect(second.rowsDeleted).toBe(SUPERSEDED.length - 2);
    expect(second.budgetExhausted).toBe(false);
    for (const id of SUPERSEDED) expect(progressIds(MAIN)).not.toContain(id);
  });
});
