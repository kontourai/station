import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { UsageAggregator } from '../../../analytics/usage-aggregator.js';
import type { UsageStats } from '../../../analytics/usage-aggregator-state.js';

// Without a registered meter provider every instrument is one shared no-op,
// so each is replaced to tell the two apart.
vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  usageProjectionPassDuration: { record: vi.fn() },
  usageProjectionRowsScanned: { record: vi.fn() },
}));

import {
  usageProjectionPassDuration,
  usageProjectionRowsScanned,
} from '../../../telemetry/metrics.js';
import { EventStore } from '../event-store.js';
import { SessionTranscriptReads } from '../session-transcript-reads.js';

/**
 * #373: lifetime usage refolds only threads whose events changed since the
 * stored watermark. Every case compares against the reference a full rescan
 * gives: the same reader with no projection store, which folds every thread
 * on every pass, exactly as lifetime usage did before.
 */

const makeHome = trackTempDirs();
const stores: EventStore[] = [];
beforeEach(() => {
  vi.mocked(usageProjectionPassDuration.record).mockClear();
  vi.mocked(usageProjectionRowsScanned.record).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

function openStore(path: string): EventStore {
  const store = new EventStore(path);
  stores.push(store);
  return store;
}

function readsFor(store: EventStore, cached: boolean) {
  return new SessionTranscriptReads({
    canReadSession: () => true,
    isEphemeralSession: () => false,
    sessionAttributionFor: (threadId) => {
      const configured = store.latestEventByMethod(
        threadId,
        'session.configured',
      )?.payload;
      if (configured?.method !== 'session.configured') return null;
      return {
        conversationId:
          typeof configured.metadata?.conversationId === 'string'
            ? configured.metadata.conversationId
            : threadId,
        ...(typeof configured.metadata?.agentSlug === 'string'
          ? { slug: configured.metadata.agentSlug }
          : {}),
      };
    },
    listEventPayloads: (threadId) => store.listEventPayloads(threadId),
    listResolvedEventPayloads: (threadId) => store.listEventPayloads(threadId),
    ...(cached ? { usageProjectionStore: store } : {}),
    listUsageEventPayloads: (threadId, clock) =>
      store.listUsageEventPayloads(threadId, clock),
    listUsageReceiptEvents: (input) => store.listUsageReceiptEvents(input),
    listUsageCoverageEvents: (input) => store.listUsageCoverageEvents(input),
    searchConversationMessages: (input) =>
      store.searchConversationMessages(input),
    readSessionThreadIds: () =>
      store.readSessions().map((session) => session.threadId),
    requireTenantExecutionContext: () => false,
    // These cases compare projections, not the drop contract.
    reportDroppedUsageFigure: () => {},
  });
}

function aggregatorFor(reads: SessionTranscriptReads): UsageAggregator {
  return new UsageAggregator(makeHome('usage-projection-home-'), {
    get: () => ({
      listSessionUsage: (options) =>
        reads.listSessionUsage(INTERNAL_SESSION_READ_SCOPE, options),
    }),
  });
}

/** The stats as a byte string, without the one field that is a wall clock. */
function comparable(stats: UsageStats): string {
  const { snapshot, ...rest } = stats;
  const { rescannedAt: _rescannedAt, ...stable } = snapshot ?? {};
  return JSON.stringify({ ...rest, snapshot: stable });
}

function harness() {
  const path = join(makeHome('usage-projection-store-'), 'events.sqlite');
  const store = openStore(path);
  const incremental = readsFor(store, true);
  const reference = readsFor(store, false);
  return {
    path,
    store,
    incremental,
    reference,
    incrementalStats: aggregatorFor(incremental),
    referenceStats: aggregatorFor(reference),
  };
}

let eventOrdinal = 0;
function append(
  store: EventStore,
  threadId: string,
  provider: CanonicalRuntimeEvent['provider'],
  event: Record<string, unknown> & { method: string },
  createdAt = '2026-08-03T10:00:00.000Z',
): void {
  store.appendEvent({
    eventId: `usage-projection-${eventOrdinal++}`,
    provider,
    threadId,
    createdAt,
    ...event,
  } as unknown as CanonicalRuntimeEvent);
}

function startThread(
  store: EventStore,
  threadId: string,
  provider: CanonicalRuntimeEvent['provider'],
): void {
  store.upsertSession({
    provider,
    threadId,
    status: 'ready',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  append(store, threadId, provider, {
    method: 'session.configured',
    sessionId: threadId,
    model: 'model-a',
    metadata: { agentSlug: `agent-${threadId}`, conversationId: threadId },
  });
}

function turn(
  store: EventStore,
  threadId: string,
  provider: CanonicalRuntimeEvent['provider'],
  turnId: string,
  promptTokens: number,
): void {
  append(store, threadId, provider, { method: 'turn.started', turnId });
  append(store, threadId, provider, {
    method: 'token-usage.updated',
    turnId,
    promptTokens,
    completionTokens: 3,
    reportedCostUsd: 0.01,
  });
  append(store, threadId, provider, {
    method: 'turn.completed',
    turnId,
    finishReason: 'stop',
  });
}

/** Deterministic, so a failing seed is a reproducible history. */
function prng(seed: number) {
  let state = seed;
  return (bound: number) => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state % bound;
  };
}

const PROVIDERS = ['claude', 'codex', 'station-agent'] as const;
const MODELS = ['model-a', 'model-b', 'model-c'];
const DAYS = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'];

/**
 * One random step of a Session history, including the edits a full rescan
 * exists to absorb: cumulative counters going down, late events stamped with
 * an earlier day, rows deleted out of the middle of a thread (#5078's
 * compaction, or a repair), a rewritten row, and a thread deleted and then
 * recreated under the same id with no events.
 *
 * `maintenance` keeps to those edits alone, as a compaction or repair runs
 * between appends: an append to the same thread in the same chunk would
 * otherwise mark it changed and hide a missed invalidation.
 */
function randomStep(
  store: EventStore,
  external: DatabaseSync,
  pick: (bound: number) => number,
  live: Map<string, { provider: (typeof PROVIDERS)[number]; turns: number }>,
  cumulative: Map<string, number>,
  maintenance: boolean,
): void {
  const threadId = `random-thread-${pick(6)}`;
  const thread = live.get(threadId);
  if (maintenance && !thread) return;
  if (!thread) {
    const provider = PROVIDERS[pick(PROVIDERS.length)]!;
    store.upsertSession({
      provider,
      threadId,
      status: 'ready',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    append(store, threadId, provider, {
      method: 'session.configured',
      sessionId: threadId,
      model: MODELS[pick(MODELS.length)],
      metadata: {
        agentSlug: `agent-${pick(3)}`,
        conversationId: `conversation-${threadId}`,
        ...(provider === 'station-agent' ? { agentId: 'relay-agent' } : {}),
      },
    });
    live.set(threadId, { provider, turns: 0 });
    return;
  }
  const { provider } = thread;
  const day = DAYS[pick(DAYS.length)]!;
  const createdAt = `${day}T${String(pick(24)).padStart(2, '0')}:00:00.000Z`;
  const turnId = `${threadId}-turn-${thread.turns}`;
  switch (maintenance ? 8 + pick(3) : pick(12)) {
    case 0:
      append(store, threadId, provider, {
        method: 'session.configured',
        sessionId: threadId,
        model: MODELS[pick(MODELS.length)],
        metadata: { agentSlug: `agent-${pick(3)}`, conversationId: threadId },
      });
      return;
    case 1:
      append(
        store,
        threadId,
        provider,
        {
          method: 'turn.started',
          turnId,
          principal: humanPrincipal('github', `person-${pick(2)}`, 'Person'),
        },
        createdAt,
      );
      return;
    case 2:
    case 3: {
      // Codex reports a running total; sometimes it is corrected downwards.
      const previous = cumulative.get(threadId) ?? 0;
      const next =
        provider === 'codex'
          ? pick(5) === 0
            ? Math.floor(previous / 2)
            : previous + pick(5_000)
          : pick(5_000);
      cumulative.set(threadId, next);
      append(
        store,
        threadId,
        provider,
        {
          method: 'token-usage.updated',
          turnId,
          promptTokens: next,
          completionTokens: pick(500),
          cacheReadTokens: pick(3) === 0 ? undefined : pick(900),
          ...(pick(2) === 0 ? { reportedCostUsd: pick(1_000) / 997 } : {}),
        },
        createdAt,
      );
      return;
    }
    case 4:
      append(
        store,
        threadId,
        provider,
        {
          method: 'turn.completed',
          turnId,
          finishReason: 'stop',
          metadata: { reportedModel: MODELS[pick(MODELS.length)] },
        },
        createdAt,
      );
      thread.turns += 1;
      return;
    case 5:
      append(
        store,
        threadId,
        provider,
        {
          method: 'tool.completed',
          turnId,
          toolCallId: `${turnId}-tool-${pick(1_000)}`,
          toolName: 'read',
          status: 'success',
          output: 'output',
        },
        createdAt,
      );
      return;
    case 6:
      append(store, threadId, provider, {
        method: 'tool.progress',
        turnId,
        toolCallId: `${turnId}-progress`,
        message: 'working',
      });
      return;
    case 7: {
      // A late event: an earlier day, appended after later ones.
      append(
        store,
        threadId,
        provider,
        {
          method: 'token-usage.updated',
          turnId: `${threadId}-turn-0`,
          promptTokens: pick(2_000),
        },
        `${DAYS[0]}T00:00:00.000Z`,
      );
      return;
    }
    case 8: {
      // Compaction or repair from another connection: rows leave the
      // middle of the thread and no new row arrives.
      const rows = external
        .prepare(
          'SELECT id FROM orchestration_events WHERE thread_id = ? ORDER BY sequence',
        )
        .all(threadId) as Array<{ id: string }>;
      const row = rows[pick(rows.length)];
      if (row)
        external
          .prepare('DELETE FROM orchestration_events WHERE id = ?')
          .run(row.id);
      return;
    }
    case 9: {
      // A repair that rewrites a usage figure in place.
      const row = external
        .prepare(
          `SELECT id, payload FROM orchestration_events
           WHERE thread_id = ? AND method = 'token-usage.updated' LIMIT 1`,
        )
        .get(threadId) as { id: string; payload: string } | undefined;
      if (row)
        external
          .prepare('UPDATE orchestration_events SET payload = ? WHERE id = ?')
          .run(
            JSON.stringify({
              ...JSON.parse(row.payload),
              promptTokens: pick(9_000),
            }),
            row.id,
          );
      return;
    }
    case 10:
      store.deleteThread(threadId);
      live.delete(threadId);
      cumulative.delete(threadId);
      // Recreated under the same id, with nothing appended yet.
      if (pick(2) === 0)
        store.upsertSession({
          provider,
          threadId,
          status: 'ready',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        });
      return;
    default:
      append(store, threadId, provider, {
        method: 'content.text-delta',
        turnId,
        delta: 'text',
      });
  }
}

describe('lifetime usage projection (#373)', () => {
  test.each([1, 7, 42, 1_001, 65_537])(
    'incremental passes over a random history equal a full rescan after every chunk (seed %i)',
    async (seed) => {
      const h = harness();
      const external = new DatabaseSync(h.path);
      try {
        const pick = prng(seed);
        const live = new Map<
          string,
          { provider: (typeof PROVIDERS)[number]; turns: number }
        >();
        const cumulative = new Map<string, number>();
        for (let chunk = 0; chunk < 25; chunk++) {
          const steps = 1 + pick(20);
          for (let step = 0; step < steps; step++)
            randomStep(
              h.store,
              external,
              pick,
              live,
              cumulative,
              chunk % 3 === 2,
            );
          const incremental = await h.incrementalStats.fullRescan();
          const reference = await h.referenceStats.fullRescan();
          expect(comparable(incremental)).toBe(comparable(reference));
          // The sessions themselves, not only their aggregate.
          expect(
            JSON.stringify(
              await h.incremental.listSessionUsage(INTERNAL_SESSION_READ_SCOPE),
            ),
          ).toBe(
            JSON.stringify(
              await h.reference.listSessionUsage(INTERNAL_SESSION_READ_SCOPE),
            ),
          );
        }
        // The history really exercised what the projection must absorb.
        expect(
          (
            (await h.reference.listSessionUsage(INTERNAL_SESSION_READ_SCOPE)) ??
            []
          ).length,
        ).toBeGreaterThan(0);
      } finally {
        external.close();
      }
    },
  );

  test('deleting a thread and recreating it with no events drops its usage, as a full rescan does', async () => {
    const h = harness();
    startThread(h.store, 'recreated', 'claude');
    turn(h.store, 'recreated', 'claude', 'turn-1', 100);
    expect(
      (await h.incrementalStats.fullRescan()).lifetime.totalInputTokens,
    ).toBe(100);
    h.store.deleteThread('recreated');
    h.store.upsertSession({
      provider: 'claude',
      threadId: 'recreated',
      status: 'ready',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const incremental = await h.incrementalStats.fullRescan();
    expect(incremental.lifetime.totalInputTokens).toBe(0);
    expect(comparable(incremental)).toBe(
      comparable(await h.referenceStats.fullRescan()),
    );
  });

  test('a timer pass reads only the rows appended since the last pass', async () => {
    const h = harness();
    for (const threadId of ['quiet-1', 'quiet-2', 'busy']) {
      startThread(h.store, threadId, 'claude');
      turn(h.store, threadId, 'claude', 'turn-1', 100);
    }
    await h.incremental.listSessionUsage(INTERNAL_SESSION_READ_SCOPE);

    const rows = vi.mocked(usageProjectionRowsScanned.record);
    rows.mockClear();
    const durations = vi.mocked(usageProjectionPassDuration.record);
    durations.mockClear();
    const refolds = vi.spyOn(h.store, 'listUsageEventPayloads');

    // An idle pass reads no event rows at all.
    await h.incremental.listSessionUsage(INTERNAL_SESSION_READ_SCOPE);
    expect(refolds).not.toHaveBeenCalled();
    expect(rows.mock.calls).toEqual([
      [0, { mode: 'incremental' }],
      [0, { mode: 'rebuild' }],
    ]);
    expect(durations.mock.calls).toEqual([
      [expect.any(Number), { mode: 'incremental' }],
    ]);

    rows.mockClear();
    turn(h.store, 'busy', 'claude', 'turn-2', 40);
    const sessions = await h.incremental.listSessionUsage(
      INTERNAL_SESSION_READ_SCOPE,
    );
    // Three new rows, all in one thread: only that thread is refolded.
    expect(rows.mock.calls[0]).toEqual([3, { mode: 'incremental' }]);
    expect(refolds.mock.calls.map(([threadId]) => threadId)).toEqual(['busy']);
    expect(rows.mock.calls[1]).toEqual([
      refolds.mock.results[0]!.value.length,
      { mode: 'rebuild' },
    ]);
    expect(
      sessions.find((session) => session.threadId === 'busy')?.usage
        .inputTokens,
    ).toBe(140);
    expect(JSON.stringify(sessions)).toBe(
      JSON.stringify(
        await h.reference.listSessionUsage(INTERNAL_SESSION_READ_SCOPE),
      ),
    );
  });

  test('a restart catches up from the stored watermark instead of refolding every thread', async () => {
    const first = harness();
    for (const threadId of ['kept-1', 'kept-2', 'changed']) {
      startThread(first.store, threadId, 'codex');
      turn(first.store, threadId, 'codex', 'turn-1', 500);
    }
    await first.incremental.listSessionUsage(INTERNAL_SESSION_READ_SCOPE);
    // Work that lands after the last pass, before the process exits.
    turn(first.store, 'changed', 'codex', 'turn-2', 300);
    first.store.close();
    stores.splice(stores.indexOf(first.store), 1);

    const store = openStore(first.path);
    const rebooted = readsFor(store, true);
    const rows = vi.mocked(usageProjectionRowsScanned.record);
    rows.mockClear();
    const durations = vi.mocked(usageProjectionPassDuration.record);
    durations.mockClear();
    const refolds = vi.spyOn(store, 'listUsageEventPayloads');
    const sessions = await rebooted.listSessionUsage(
      INTERNAL_SESSION_READ_SCOPE,
    );

    expect(durations.mock.calls[0]?.[1]).toEqual({ mode: 'incremental' });
    expect(rows.mock.calls[0]).toEqual([3, { mode: 'incremental' }]);
    expect(refolds.mock.calls.map(([threadId]) => threadId)).toEqual([
      'changed',
    ]);
    expect(JSON.stringify(sessions)).toBe(
      JSON.stringify(
        await readsFor(store, false).listSessionUsage(
          INTERNAL_SESSION_READ_SCOPE,
        ),
      ),
    );
  });

  test.each([
    ['missing', () => {}],
    [
      'written under another projection version',
      (db: DatabaseSync) =>
        db
          .prepare(
            "UPDATE orchestration_usage_projection_checkpoint SET version = 'usage-projection-v1'",
          )
          .run(),
    ],
    [
      'ahead of the store it describes',
      (db: DatabaseSync) =>
        db
          .prepare(
            'UPDATE orchestration_usage_projection_checkpoint SET watermark = watermark + 100',
          )
          .run(),
    ],
  ] as const)(
    'a watermark that is %s rebuilds every thread',
    async (_name, damage) => {
      const h = harness();
      for (const threadId of ['one', 'two'])
        startThread(h.store, threadId, 'claude');
      turn(h.store, 'one', 'claude', 'turn-1', 10);
      turn(h.store, 'two', 'claude', 'turn-1', 20);
      const external = new DatabaseSync(h.path);
      try {
        if (_name !== 'missing') {
          await h.incremental.listSessionUsage(INTERNAL_SESSION_READ_SCOPE);
          // A cached fold that no longer matches its events: only a rebuild
          // that really discards the cache gets rid of it.
          external
            .prepare(
              `UPDATE orchestration_usage_projection_cache
             SET projection = json_set(projection, '$.projection.usage.inputTokens', 999999)`,
            )
            .run();
        }
        damage(external);
      } finally {
        external.close();
      }

      const durations = vi.mocked(usageProjectionPassDuration.record);
      durations.mockClear();
      const refolds = vi.spyOn(h.store, 'listUsageEventPayloads');
      const sessions = await h.incremental.listSessionUsage(
        INTERNAL_SESSION_READ_SCOPE,
      );
      expect(durations.mock.calls[0]?.[1]).toEqual({ mode: 'full' });
      expect(refolds.mock.calls.map(([threadId]) => threadId).sort()).toEqual([
        'one',
        'two',
      ]);
      expect(sessions.map((session) => session.usage.inputTokens)).toEqual([
        10, 20,
      ]);
      expect(h.store.readUsageProjectionCheckpoint()).toEqual({
        version: 'usage-projection-v2',
        watermark: h.store.currentGlobalSequence(),
      });
    },
  );

  test('an unreadable cached fold costs that thread a refold, not the pass', async () => {
    const h = harness();
    startThread(h.store, 'damaged', 'claude');
    turn(h.store, 'damaged', 'claude', 'turn-1', 70);
    await h.incremental.listSessionUsage(INTERNAL_SESSION_READ_SCOPE);
    const external = new DatabaseSync(h.path);
    try {
      external
        .prepare(
          "UPDATE orchestration_usage_projection_cache SET projection = 'not json'",
        )
        .run();
    } finally {
      external.close();
    }
    const refolds = vi.spyOn(h.store, 'listUsageEventPayloads');
    const [session] = await h.incremental.listSessionUsage(
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(refolds).toHaveBeenCalledTimes(1);
    expect(session?.usage.inputTokens).toBe(70);
  });

  test('Rebuild usage discards cached folds and reads every thread again', async () => {
    const h = harness();
    startThread(h.store, 'rebuilt', 'claude');
    turn(h.store, 'rebuilt', 'claude', 'turn-1', 70);
    await h.incrementalStats.fullRescan();
    const durations = vi.mocked(usageProjectionPassDuration.record);
    durations.mockClear();
    const refolds = vi.spyOn(h.store, 'listUsageEventPayloads');
    await h.incrementalStats.fullRescan({ rebuild: true });
    expect(durations.mock.calls[0]?.[1]).toEqual({ mode: 'full' });
    expect(refolds).toHaveBeenCalledTimes(1);
  });

  test('the projection version changes whenever the shared usage fold does', async () => {
    // A cached fold is only as good as the code that computed it. Editing
    // packages/shared/src/usage-fold.ts must come with a new
    // USAGE_PROJECTION_VERSION in session-transcript-reads.ts (a one-time
    // rebuild for every Station) and a new pin here.
    const pins: Record<string, string> = {
      'usage-projection-v1':
        '355217afdcbc25a5e6e7fc769d5d9d3abb3e1c4a067469f6d8a84922e09465f4',
      'usage-projection-v2':
        '86b953f1e731909bfc038a3a84e4345aae85436491b797b330decd31b6202289',
    };
    const source = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../packages/shared/src/usage-fold.ts',
          import.meta.url,
        ),
      ),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const h = harness();
    await h.incremental.listSessionUsage(INTERNAL_SESSION_READ_SCOPE);
    const version = h.store.readUsageProjectionCheckpoint()?.version ?? '';
    expect(pins[version]).toBe(
      createHash('sha256').update(source).digest('hex'),
    );
  });
});
