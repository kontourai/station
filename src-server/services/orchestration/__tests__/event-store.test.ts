import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES,
  CHAT_ATTACHMENT_MAX_STORE_ENCODED_BYTES,
} from '@kontourai/station-contracts/chat-attachment';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHAT_INPUT_MAX_CHARS } from '../../../../src-shared/chat-input-limits.js';
import {
  canonicalPersistedRequestId,
  ensureOrchestrationEventStoreColumns,
  ensureOrchestrationTurnDedupColumns,
  GLOBAL_SEQUENCE_BACKFILL_BATCH_SIZE,
  getOrchestrationDatabasePath,
  ORCHESTRATION_EVENT_STORE_MIGRATION,
  runOrchestrationEventMigration,
} from '../../../domain/migrations/003-orchestration-events.js';
import { SqliteVecIndexProvider } from '../../../knowledge-index/sqlite-vec-index-provider.js';
import {
  orchestrationEventPersistDuration,
  orchestrationEventsPersisted,
  orchestrationEventWindowElisions,
} from '../../../telemetry/metrics.js';
import type { PersistedRuntimeEvent } from '../event-store.js';
import {
  EventStore,
  EventStoreIntegrityError,
  MAX_EVENT_STORE_INGRESS_BYTES,
  MESSAGE_SEARCH_BACKFILL_EVENT_BATCH_SIZE,
} from '../event-store.js';
import {
  buildAgentRunSummary,
  buildOrchestrationSessionSummary,
} from '../orchestration-session-state.js';
import {
  activeTurnIdForEvents,
  interruptibleTurnIdForEvents,
  normalizeCanonicalRuntimeEventLifecycle,
  projectSessionLifecycle,
} from '../session-lifecycle-service.js';

function recoveryLedger(eventStore: EventStore) {
  return eventStore.createRecoveryLedger();
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get: (...args: unknown[]) => unknown;
      run: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
    close(): void;
  };
};

vi.mock('../../../telemetry/metrics.js', () => ({
  attachmentBlobBytesReclaimed: { add: vi.fn() },
  attachmentBlobBytesStored: { add: vi.fn() },
  attachmentBlobOperations: { add: vi.fn() },
  attachmentBytesStripped: { add: vi.fn() },
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventWindowElisions: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  orchestrationStoreCorruptionObserved: { add: vi.fn() },
  turnDedupClaims: { add: vi.fn() },
  knowledgeIndexOps: { add: vi.fn() },
  knowledgeIndexRebuildDuration: { record: vi.fn() },
}));

// archive#2895: a STATION_HOME can be open by more than one runtime (a desktop
// bundle and a managed service share one). In the default `delete` journal
// mode the constructor's migration died with a bare `database is locked` when
// another writer held the file, taking the whole boot with it.
describe('EventStore concurrent-home boot', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-store-wal-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips command receipt origin across an EventStore restart', () => {
    const receipt = {
      commandId: 'origin-receipt',
      threadId: 'thread-origin',
      commandType: 'respondToRequest' as const,
      status: 'accepted' as const,
      createdAt: '2026-08-23T00:00:00.000Z',
      clientOrigin: {
        version: 1 as const,
        actor: { kind: 'device' as const, deviceId: 'server-device-1' },
        reported: {
          version: 1 as const,
          surface: 'mobile' as const,
          build: '1.2.3',
        },
      },
    };
    const path = join(dir, 'orchestration.sqlite');
    const first = new EventStore(path);
    first.appendCommandReceipt(receipt);
    first.close();
    const reopened = new EventStore(path);
    try {
      expect(reopened.readCommandReceipt(receipt.commandId)).toEqual(receipt);
    } finally {
      reopened.close();
    }
  });

  test('opens WAL so a second runtime is not locked out', () => {
    const databasePath = join(dir, 'orchestration.sqlite');
    const store = new EventStore(databasePath);
    try {
      const mode = new DatabaseSync(databasePath)
        .prepare('PRAGMA journal_mode')
        .get() as { journal_mode?: string };
      expect(String(mode.journal_mode).toLowerCase()).toBe('wal');
    } finally {
      store.close?.();
    }
  });

  // archive#3321: the knowledge-index provider opens the same-class
  // shared-home SQLite file and immediately writes. The test lives in this
  // file (not the provider's own suite) because it needs the process-heavy
  // manifest classification this file already carries for its lock-holder
  // child processes.
  test('knowledge-index open waits through a peer writer instead of dying on SQLITE_BUSY', async () => {
    const databasePath = join(dir, 'knowledge-index', 'index.db');
    mkdirSync(join(dir, 'knowledge-index'), { recursive: true });
    // The hold must dominate everything the provider does before its first
    // write — it loads the vec0 extension from disk first, which on a loaded
    // host can outlast a short hold, and then the peer has already committed
    // and the open never had to wait at all. That version of this test passed
    // with or without the busy treatment it exists to prove.
    const holdMs = 1_000;
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${holdMs});`,
        databasePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.once('data', () => resolve());
    });
    const lockedAt = Date.now();
    const provider = new SqliteVecIndexProvider({ dbPath: databasePath });
    try {
      // search() opens the connection and executes the meta-table CREATE —
      // the exact write that died instantly on SQLITE_BUSY before archive#3321.
      await expect(provider.search([0.1, 0.2], { topK: 1 })).resolves.toEqual(
        [],
      );
      // Resolving is not enough on its own: it also resolves if the peer had
      // already let go. Returning no earlier than the hold is what says the
      // write waited for the lock rather than walking in after it.
      expect(Date.now() - lockedAt).toBeGreaterThanOrEqual(holdMs - 50);
    } finally {
      provider.close();
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)),
        );
      });
    }
  });

  // archive#3304 residual gap 1: the standalone boot migration opened the
  // database with no timeout at all, so a second instance booting while the
  // first held a write lock died instantly on SQLITE_BUSY.
  test('boot migration waits through a peer writer instead of dying on SQLITE_BUSY', async () => {
    const databasePath = getOrchestrationDatabasePath(dir);
    mkdirSync(join(dir, 'data'), { recursive: true });
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 120);`,
        databasePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.once('data', () => resolve());
    });
    expect(() => runOrchestrationEventMigration(dir)).not.toThrow();
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)),
      );
    });
    const probe = new DatabaseSync(databasePath);
    expect(
      probe
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_events'",
        )
        .get(),
    ).toMatchObject({ name: 'orchestration_events' });
    probe.close();
  });

  test('detects corrupt bytes before migrations and preserves them for restore', () => {
    const databasePath = join(dir, 'orchestration.sqlite');
    writeFileSync(databasePath, 'not a sqlite database');
    const before = readFileSync(databasePath);

    expect(() => new EventStore(databasePath)).toThrow(
      EventStoreIntegrityError,
    );
    expect(readFileSync(databasePath)).toEqual(before);
    expect(() => new EventStore(databasePath)).toThrow(
      /station home restore --from=<backup-dir> --confirm/,
    );
  });

  // The other way a concurrent first boot kills a constructor (archive#3145
  // class, distinct root cause): the one-time `event-facts-v3` backfill reads
  // its completion marker without holding a lock, so two runtimes can both
  // decide the work is theirs. `BEGIN IMMEDIATE` serializes them, and the
  // loser used to discover the truth only when its INSERT hit the marker's
  // primary key — which threw out of the migration and took the whole boot.
  test('yields the one-time backfill to a peer that won the writer lock', () => {
    const databasePath = join(dir, 'orchestration.sqlite');
    const loser = new DatabaseSync(databasePath);
    loser.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    const peer = new DatabaseSync(databasePath);
    let raced = false;
    const contended = {
      exec: (sql: string) => {
        // Commit the peer's backfill in the window between the loser's
        // unlocked marker read and the lock it is about to take.
        if (sql === 'BEGIN IMMEDIATE' && !raced) {
          raced = true;
          peer
            .prepare(
              'INSERT INTO orchestration_event_store_backfills (name, completed_at) VALUES (?, ?)',
            )
            .run('event-facts-v3', '2026-08-16T00:00:00.000Z');
        }
        loser.exec(sql);
      },
      prepare: (sql: string) => loser.prepare(sql),
    };
    try {
      expect(() =>
        ensureOrchestrationEventStoreColumns(contended),
      ).not.toThrow();
      expect(raced).toBe(true);
      // The peer's marker stands alone: the loser neither duplicated it nor
      // rewrote it, and the rest of the migration still ran.
      expect(
        peer
          .prepare(
            'SELECT COUNT(*) AS count FROM orchestration_event_store_backfills WHERE name = ?',
          )
          .get('event-facts-v3'),
      ).toMatchObject({ count: 1 });
      expect(
        peer
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_global_sequence'",
          )
          .get(),
      ).toMatchObject({ name: 'idx_events_global_sequence' });
    } finally {
      peer.close();
      loser.close();
    }
  });

  test('keeps WAL across reopen, so later boots inherit it', () => {
    const databasePath = join(dir, 'orchestration.sqlite');
    new EventStore(databasePath).close?.();
    // Journal mode lives in the database header, which is the entire reason a
    // best-effort pragma is sufficient: one uncontended open converts the file
    // and every later open — contended or not — inherits WAL.
    const reopened = new EventStore(databasePath);
    try {
      const mode = new DatabaseSync(databasePath)
        .prepare('PRAGMA journal_mode')
        .get() as { journal_mode?: string };
      expect(String(mode.journal_mode).toLowerCase()).toBe('wal');
    } finally {
      reopened.close?.();
    }
  });
});

describe('EventStore', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orchestration-store-'));
    store = new EventStore(join(dir, 'orchestration.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('appends canonical events with monotonically increasing per-thread sequence numbers', () => {
    const event1 = {
      eventId: 'evt-1',
      provider: 'claude' as const,
      threadId: 'thread-1',
      createdAt: '2026-03-28T00:00:00.000Z',
      method: 'session.started' as const,
      sessionId: 'thread-1',
      initialState: 'created' as const,
    };
    const event2 = {
      eventId: 'evt-2',
      provider: 'claude' as const,
      threadId: 'thread-1',
      createdAt: '2026-03-28T00:00:01.000Z',
      method: 'session.configured' as const,
      sessionId: 'thread-1',
      model: 'claude-sonnet-4-5',
    };

    expect(store.appendEvent(event1)).toBe(1);
    expect(store.appendEvent(event2)).toBe(2);

    expect(store.listEvents('thread-1')).toEqual([
      expect.objectContaining({ id: 'evt-1', sequence: 1, payload: event1 }),
      expect.objectContaining({ id: 'evt-2', sequence: 2, payload: event2 }),
    ]);
    expect(store.listEvents('thread-1')[0]?.observedAt).toEqual(
      expect.any(String),
    );
  });

  test('reads complete Session inventory descriptors in bounded stable pages', () => {
    const threadId = 'inventory-paging';
    for (let index = 0; index < 45; index += 1) {
      store.appendEvent({
        eventId: `inventory-${String(index).padStart(2, '0')}`,
        provider: 'claude',
        threadId,
        turnId: `turn-${index}`,
        createdAt: `2026-08-26T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        method: 'turn.started',
        prompt: `body-${index}-must-not-cross-the-descriptor-seam`,
        metadata: { secret: `metadata-${index}` },
      });
    }
    const first = store.listSessionInventoryEvents(threadId);
    expect(first.events).toHaveLength(20);
    expect(first.continuation).toBeDefined();
    expect(first.events.map((event) => event.id)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `inventory-${String(index).padStart(2, '0')}`,
      ),
    );
    expect(JSON.stringify(first)).not.toContain('must-not-cross');
    expect(JSON.stringify(first)).not.toContain('metadata-');
    const second = store.listSessionInventoryEvents(threadId, {
      frozenHighWater: first.highWater,
      continuation: first.continuation,
    });
    const third = store.listSessionInventoryEvents(threadId, {
      frozenHighWater: first.highWater,
      continuation: second.continuation,
    });
    expect([second.events.length, third.events.length]).toEqual([20, 5]);
    expect(third.continuation).toBeUndefined();
    expect([...first.events, ...second.events, ...third.events]).toHaveLength(
      45,
    );
  });

  test('usage session ids are SQL-narrowed by owner and tenant, making other tenants indistinguishable from empty', () => {
    const add = (threadId: string, tenantId: string) => {
      store.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        tenantExecutionContext: {
          tenantId: tenantId as any,
          source: 'request',
        },
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      });
      store.appendEvent({
        eventId: `ownership-${threadId}`,
        provider: 'claude',
        threadId,
        sessionId: threadId,
        createdAt: '2026-08-20T00:00:00.000Z',
        method: 'session.configured',
        model: 'claude-sonnet-4-5',
        metadata: { userId: 'same-user' },
      } as any);
    };
    add('tenant-alpha-session', 'alpha');
    add('tenant-beta-session', 'beta');

    expect(
      store.readUsageSessionThreadIds({
        ownerUserId: 'same-user',
        tenantId: 'alpha',
      }),
    ).toEqual(['tenant-alpha-session']);
    expect(
      store.readUsageSessionThreadIds({
        ownerUserId: 'same-user',
        tenantId: 'missing',
      }),
    ).toEqual([]);
  });

  test('selects bounded coverage evidence by owner and tenant without replaying other sessions', () => {
    const add = (threadId: string, tenantId: string, owner: string) => {
      store.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        tenantExecutionContext: {
          tenantId: tenantId as any,
          source: 'request',
        },
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      });
      store.appendEvent({
        eventId: `${threadId}-configured`,
        provider: 'claude',
        threadId,
        sessionId: threadId,
        createdAt: '2026-08-20T00:00:00.000Z',
        method: 'session.configured',
        metadata: { userId: owner },
      } as any);
      store.appendEvent({
        eventId: `${threadId}-terminal`,
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: '2026-08-20T00:00:01.000Z',
        method: 'turn.completed',
        finishReason: 'stop',
      } as any);
      store.appendEvent({
        eventId: `${threadId}-usage`,
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: '2026-08-20T00:00:02.000Z',
        method: 'token-usage.updated',
        promptTokens: 1,
      } as any);
    };
    // Coverage is deliberately bounded by the immutable host observation
    // (`observed_at`), not the provider-supplied event timestamp. Freeze that
    // host clock so this fixture names the persisted date it queries.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
      add('usage-alpha', 'alpha', 'reader');
      add('usage-beta', 'beta', 'reader');
      add('usage-alpha-foreign-owner', 'alpha', 'other-reader');

      vi.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));
      add('usage-alpha-outside-window', 'alpha', 'reader');

      const rows = store.listUsageCoverageEvents({
        ownerUserId: 'reader',
        tenantId: 'alpha',
        from: '2026-08-01',
        to: '2026-08-30',
      });
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((event) => event.threadId))).toEqual(
        new Set(['usage-alpha']),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * archive#4075 stage 2: append-time ownership immutability guard.
   * `appendEvent`/`appendEventIfAbsent` were bare INSERTs before this stage
   * — the only thing preventing a rewritten owner was command-side gating,
   * which a store-level writer (recovery, replay, a future internal caller)
   * could bypass entirely. These tests exercise the STORE directly, below
   * any command gate, so they prove the guard exists at the layer the
   * stage-2 probe named, not merely that the existing command gate still
   * works.
   */
  describe('ownership immutability at append time (station#4075 stage 2)', () => {
    function ownershipEvent(
      overrides: Partial<CanonicalRuntimeEvent> & {
        threadId: string;
        eventId: string;
        userId?: string;
        method?: 'session.started' | 'session.configured';
      },
    ): CanonicalRuntimeEvent {
      const { userId, method, ...rest } = overrides;
      return {
        provider: 'claude',
        createdAt: '2026-08-24T00:00:00.000Z',
        sessionId: overrides.threadId,
        initialState: 'created',
        method: method ?? 'session.started',
        ...(userId !== undefined ? { metadata: { userId } } : {}),
        ...rest,
      } as unknown as CanonicalRuntimeEvent;
    }

    test('the FIRST ownership-shaped event establishing an owner is always accepted', () => {
      expect(
        store.appendEvent(
          ownershipEvent({
            eventId: 'evt-owner-first',
            threadId: 'thread-owner',
            userId: 'human:local:operator',
          }),
        ),
      ).toBe(1);
      expect(store.findSessionOwnerUserId('thread-owner')).toBe(
        'human:local:operator',
      );
    });

    test('a REPEAT of the SAME owner (reconnect session.configured) is accepted', () => {
      store.appendEvent(
        ownershipEvent({
          eventId: 'evt-owner-first',
          threadId: 'thread-repeat',
          userId: 'human:local:operator',
        }),
      );
      expect(() =>
        store.appendEvent(
          ownershipEvent({
            eventId: 'evt-owner-repeat',
            threadId: 'thread-repeat',
            method: 'session.configured',
            userId: 'human:local:operator',
          }),
        ),
      ).not.toThrow();
    });

    test('an ownership-shaped event with NO metadata.userId makes no ownership claim and is never compared', () => {
      store.appendEvent(
        ownershipEvent({
          eventId: 'evt-owner-first',
          threadId: 'thread-ownerless',
          userId: 'human:local:operator',
        }),
      );
      expect(() =>
        store.appendEvent(
          ownershipEvent({
            eventId: 'evt-no-owner-claim',
            threadId: 'thread-ownerless',
            method: 'session.configured',
          }),
        ),
      ).not.toThrow();
    });

    test('a SECOND ownership-shaped event disagreeing with the thread first owner is REJECTED', () => {
      store.appendEvent(
        ownershipEvent({
          eventId: 'evt-owner-first',
          threadId: 'thread-conflict',
          userId: 'human:local:operator',
        }),
      );
      expect(() =>
        store.appendEvent(
          ownershipEvent({
            eventId: 'evt-owner-rewrite',
            threadId: 'thread-conflict',
            method: 'session.configured',
            userId: 'human:tailscale-serve:mallory',
          }),
        ),
      ).toThrow(/already owned by "human:local:operator"/);
      // The rejected event must never have been persisted.
      expect(store.listEvents('thread-conflict').map((e) => e.id)).toEqual([
        'evt-owner-first',
      ]);
    });

    test('appendEventIfAbsent rejects the same conflict before ever attempting the INSERT OR IGNORE', () => {
      store.appendEvent(
        ownershipEvent({
          eventId: 'evt-owner-first',
          threadId: 'thread-conflict-absent',
          userId: 'human:local:operator',
        }),
      );
      expect(() =>
        store.appendEventIfAbsent(
          ownershipEvent({
            eventId: 'evt-owner-rewrite-absent',
            threadId: 'thread-conflict-absent',
            method: 'session.configured',
            userId: 'human:tailscale-serve:mallory',
          }),
        ),
      ).toThrow(/already owned by "human:local:operator"/);
      expect(
        store.listEvents('thread-conflict-absent').map((e) => e.id),
      ).toEqual(['evt-owner-first']);
    });

    /**
     * archive#4075 stage 2 review round 1 (F3, regression-test gap): the
     * reviewer traced no LIVE code path that re-derives or rewrites an
     * existing owner on a legitimate re-append, but asked for it pinned
     * explicitly rather than left to the guard's own docblock claim. A
     * session whose owner was recorded BEFORE this stage — a bare
     * OS-alias string, never a `human:`/`service:`/`agent:`-prefixed
     * PrincipalRef id — must keep accepting every legitimate re-append
     * shape: a reconnect's `session.configured` carrying no `userId` at
     * all, a recovery replay's exact re-append of the SAME owner value,
     * and an unrelated `session.state-changed` (the archive#4080 restart-recovery
     * banner's event, a method this guard never inspects at all).
     */
    describe('legitimate re-appends against a PRE-STAGE-2 (old-format) owner never trip the guard', () => {
      const oldFormatOwner = 'brian'; // a bare OS-alias string, not a PrincipalRef id.

      test('a reconnect session.configured with no metadata.userId at all is accepted', () => {
        store.appendEvent(
          ownershipEvent({
            eventId: 'evt-old-owner-first',
            threadId: 'thread-old-format-reconnect',
            userId: oldFormatOwner,
          }),
        );
        expect(() =>
          store.appendEvent(
            ownershipEvent({
              eventId: 'evt-old-owner-reconnect',
              threadId: 'thread-old-format-reconnect',
              method: 'session.configured',
              // No `userId` — this constructs an event with NO
              // `metadata` key at all, matching a reconnect that makes no
              // ownership claim.
            }),
          ),
        ).not.toThrow();
        expect(
          store.findSessionOwnerUserId('thread-old-format-reconnect'),
        ).toBe(oldFormatOwner);
      });

      test('a recovery replay re-appending the SAME old-format owner is accepted', () => {
        store.appendEvent(
          ownershipEvent({
            eventId: 'evt-old-owner-first',
            threadId: 'thread-old-format-replay',
            userId: oldFormatOwner,
          }),
        );
        // A replay through appendEventIfAbsent (the idempotent path) with
        // a DIFFERENT eventId but the identical owner — the shape a
        // recovery-ledger-driven re-materialization produces when it
        // reissues an ownership-shaped fact rather than skipping it.
        expect(() =>
          store.appendEventIfAbsent(
            ownershipEvent({
              eventId: 'evt-old-owner-replay',
              threadId: 'thread-old-format-replay',
              method: 'session.configured',
              userId: oldFormatOwner,
            }),
          ),
        ).not.toThrow();
        expect(store.findSessionOwnerUserId('thread-old-format-replay')).toBe(
          oldFormatOwner,
        );
      });

      test('an unrelated session.state-changed event (the #4080 restart-recovery banner) is never inspected by the guard', () => {
        store.appendEvent(
          ownershipEvent({
            eventId: 'evt-old-owner-first',
            threadId: 'thread-old-format-state-changed',
            userId: oldFormatOwner,
          }),
        );
        expect(() =>
          store.appendEvent({
            eventId: 'evt-restart-banner',
            provider: 'claude',
            threadId: 'thread-old-format-state-changed',
            createdAt: '2026-08-24T00:00:01.000Z',
            method: 'session.state-changed',
            sessionId: 'thread-old-format-state-changed',
            from: 'running',
            to: 'idle',
            reason: 'turn interrupted by restart — resumption requested',
          } as unknown as CanonicalRuntimeEvent),
        ).not.toThrow();
        expect(
          store.findSessionOwnerUserId('thread-old-format-state-changed'),
        ).toBe(oldFormatOwner);
      });
    });
  });

  /**
   * archive#3433. `orchestrationEventsPersisted`/`orchestrationEventPersistDuration`
   * used to be recorded inside `appendEvent`'s savepoint try, whose catch runs
   * `ROLLBACK TO SAVEPOINT ...; RELEASE SAVEPOINT ...`. A throwing instrument
   * was caught by that same catch, which then tried to roll back a savepoint
   * that `RELEASE` had already closed — replacing the real (non-)error with
   * `no such savepoint` and reporting a committed insert as a thrown append.
   *
   * Round 2 (independent review): moving the instruments outside the
   * savepoint try stopped THAT masking, but left them able to fail the call
   * directly — a committed, successful append still threw if the exporter
   * was unreachable, and no caller of `appendEvent`/`appendEventIfAbsent`
   * catches. `attachment-blob-store.ts`'s stated rule for this same file's
   * sibling persistence path applies here too: "Telemetry observes
   * persistence; it never decides it." These tests now hold the opposite of
   * what round 1 pinned — a throwing instrument must be invisible to the
   * caller, not merely non-corrupting.
   */
  describe('a throwing OTel instrument cannot fail a committed append (station#3433)', () => {
    afterEach(() => {
      vi.mocked(orchestrationEventsPersisted.add).mockReset();
      vi.mocked(orchestrationEventPersistDuration.record).mockReset();
    });

    test('appendEvent: the row survives and the caller never sees the instrument error', () => {
      const boom = new Error('otel exporter unreachable');
      vi.mocked(orchestrationEventsPersisted.add).mockImplementationOnce(() => {
        throw boom;
      });

      const event = {
        eventId: 'evt-instrument-throws',
        provider: 'claude' as const,
        threadId: 'thread-instrument',
        createdAt: '2026-08-19T00:00:00.000Z',
        method: 'session.started' as const,
        sessionId: 'thread-instrument',
        initialState: 'created' as const,
      };

      // A throwing counter does not fail a committed, successful append.
      expect(() => store.appendEvent(event)).not.toThrow();

      expect(store.listEvents('thread-instrument')).toEqual([
        expect.objectContaining({ id: 'evt-instrument-throws', sequence: 1 }),
      ]);
    });

    test('appendEventIfAbsent: the row survives and the caller never sees the instrument error', () => {
      const boom = new Error('otel exporter unreachable');
      vi.mocked(
        orchestrationEventPersistDuration.record,
      ).mockImplementationOnce(() => {
        throw boom;
      });

      const event = {
        eventId: 'evt-if-absent-instrument-throws',
        provider: 'claude' as const,
        threadId: 'thread-instrument-2',
        createdAt: '2026-08-19T00:00:00.000Z',
        method: 'session.started' as const,
        sessionId: 'thread-instrument-2',
        initialState: 'created' as const,
      };

      let result: number | undefined;
      expect(() => {
        result = store.appendEventIfAbsent(event);
      }).not.toThrow();
      // The call still reports success (the sequence it committed), not just
      // "did not throw".
      expect(result).toBe(1);

      expect(store.listEvents('thread-instrument-2')).toEqual([
        expect.objectContaining({
          id: 'evt-if-absent-instrument-throws',
          sequence: 1,
        }),
      ]);
    });

    test('a genuine store failure still rolls back and surfaces its own error (negative control)', () => {
      const event = {
        eventId: 'evt-real-failure',
        provider: 'claude' as const,
        threadId: 'thread-instrument-3',
        createdAt: '2026-08-19T00:00:00.000Z',
        method: 'session.started' as const,
        sessionId: 'thread-instrument-3',
        initialState: 'created' as const,
      };

      // Duplicate primary key: fails inside the transaction, before any
      // instrument runs, and must still roll back cleanly and surface its
      // own error identity — the guard above must not become a blanket
      // "appendEvent never throws".
      store.appendEvent(event);
      expect(() => store.appendEvent(event)).toThrow(/UNIQUE/i);
      expect(store.listEvents('thread-instrument-3')).toHaveLength(1);
    });

    /**
     * Independent-review finding 4: `if (absent) return undefined;` sits
     * BEFORE the instrument call specifically so a deduplicated no-op insert
     * is never counted as a persist. Reachable three times over in this file
     * (turn-boundary replay, native-invocation readback, voice-turn
     * readback) — an over-count here would inflate
     * `station.orchestration.events_persisted` on every replay of an
     * already-persisted event.
     */
    test('a duplicate insert is not counted as a persist', () => {
      const event = {
        eventId: 'evt-dedup-count',
        provider: 'claude' as const,
        threadId: 'thread-dedup-count',
        createdAt: '2026-08-19T00:00:00.000Z',
        method: 'session.started' as const,
        sessionId: 'thread-dedup-count',
        initialState: 'created' as const,
      };

      expect(store.appendEventIfAbsent(event)).toBe(1);
      expect(vi.mocked(orchestrationEventsPersisted.add)).toHaveBeenCalledTimes(
        1,
      );

      // Same eventId again: INSERT OR IGNORE no-ops. The row count and the
      // persisted-count instrument must both stay exactly where the first
      // call left them.
      expect(store.appendEventIfAbsent(event)).toBeUndefined();
      expect(vi.mocked(orchestrationEventsPersisted.add)).toHaveBeenCalledTimes(
        1,
      );
      expect(store.listEvents('thread-dedup-count')).toHaveLength(1);
    });

    /**
     * Review round 2, LOW-3: `observeEventPersisted` takes `counter`/`duration`
     * as thunks (`() => orchestrationEventsPersisted`) rather than the
     * instruments themselves, specifically so a broken *reference* — not just
     * a throwing `.add`/`.record()` call — is read inside the try, the same
     * savepoint-adjacent try this file already documents at line ~1151 as
     * deliberately outside the transaction. Every other test here mocks the
     * metrics module with plain objects, so `orchestrationEventsPersisted` is
     * always a valid reference and only its methods are made to throw — that
     * proves the `.add()`/`.record()` calls are swallowed, but says nothing
     * about the thunk indirection itself, because moving the `counter()` /
     * `duration()` invocations outside the try changes nothing when reading
     * the reference can never throw. This test makes the reference itself
     * throw (a getter on the mocked export, reproducing a genuinely broken
     * metrics export rather than a merely-throwing method) via an isolated
     * `vi.doMock` + dynamic re-import, so it alone can tell the two designs
     * apart.
     */
    test('a throw while reading the instrument reference itself (not just calling it) is still swallowed', async () => {
      vi.resetModules();
      // Review round 3, LOW-2: a getter that only throws has no positive
      // control — swapping it for a getter that RETURNS a valid instrument
      // (`{ add: () => {} }`) passes the same 96/96 as this test, and a
      // read-counter incremented before the throw does NOT catch that
      // mutation either, because `observeEventPersisted` calls `counter()`
      // exactly once whether or not it throws — the count is identical
      // either way. Two separate instruments are needed: a positive control,
      // asserted immediately below, that proves the fixture itself is wired
      // to throw (this fails if the getter is ever changed to return
      // instead); and a read-counter, asserted after the append, that
      // proves the SUT actually dereferences THIS mocked module rather than
      // a real, un-mocked one that would never touch the counter at all.
      let getterReadCount = 0;
      vi.doMock('../../../telemetry/metrics.js', () => ({
        attachmentBlobBytesReclaimed: { add: vi.fn() },
        attachmentBlobBytesStored: { add: vi.fn() },
        attachmentBlobOperations: { add: vi.fn() },
        attachmentBytesStripped: { add: vi.fn() },
        get orchestrationEventsPersisted(): { add: () => void } {
          getterReadCount += 1;
          throw new Error('metrics export is broken, not just unreachable');
        },
        orchestrationEventWindowElisions: { add: vi.fn() },
        orchestrationEventPersistDuration: { record: vi.fn() },
        orchestrationStoreCorruptionObserved: { add: vi.fn() },
        turnDedupClaims: { add: vi.fn() },
        knowledgeIndexOps: { add: vi.fn() },
        knowledgeIndexRebuildDuration: { record: vi.fn() },
      }));

      const mockedMetrics = await import('../../../telemetry/metrics.js');
      expect(
        () => mockedMetrics.orchestrationEventsPersisted,
        'positive control: the fixture must actually throw when read',
      ).toThrow('metrics export is broken, not just unreachable');
      // The positive control above is itself a read; reset so the count
      // asserted after the append reflects only the SUT's own access.
      getterReadCount = 0;

      const isolatedDir = mkdtempSync(
        join(tmpdir(), 'orchestration-store-isolated-'),
      );
      try {
        const { EventStore: IsolatedEventStore } = await import(
          '../event-store.js'
        );
        const isolatedStore = new IsolatedEventStore(
          join(isolatedDir, 'orchestration.sqlite'),
        );
        try {
          const event = {
            eventId: 'evt-broken-export-reference',
            provider: 'claude' as const,
            threadId: 'thread-broken-export-reference',
            createdAt: '2026-08-19T00:00:00.000Z',
            method: 'session.started' as const,
            sessionId: 'thread-broken-export-reference',
            initialState: 'created' as const,
          };

          expect(() => isolatedStore.appendEvent(event)).not.toThrow();
          expect(
            isolatedStore.listEvents('thread-broken-export-reference'),
          ).toEqual([
            expect.objectContaining({
              id: 'evt-broken-export-reference',
              sequence: 1,
            }),
          ]);
          expect(getterReadCount).toBeGreaterThanOrEqual(1);
        } finally {
          isolatedStore.close?.();
        }
      } finally {
        rmSync(isolatedDir, { recursive: true, force: true });
        // `vi.doUnmock` only unregisters this module path going forward — it
        // does not restore anything already resolved this file's static
        // imports, and it leaves the path unmocked for any LATER dynamic
        // `import()` in this file too. Harmless today because no later test
        // here dynamically imports metrics.js again, but a future test that
        // does would load the real module rather than a mock unless it
        // registers its own.
        vi.doUnmock('../../../telemetry/metrics.js');
        vi.resetModules();
      }
    });
  });

  test('indexes only chat messages and scopes body search by the persisted owner', () => {
    store.appendEvent({
      eventId: 'search-session',
      provider: 'claude',
      threadId: 'search-thread',
      createdAt: '2026-08-01T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'search-thread',
      metadata: { userId: 'allowed-user', agentSlug: 'claude' },
    });
    store.appendEvent({
      eventId: 'search-user',
      provider: 'claude',
      threadId: 'search-thread',
      turnId: 'search-turn',
      createdAt: '2026-08-01T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'find the cobalt albatross',
    });
    store.appendEvent({
      eventId: 'search-agent',
      provider: 'claude',
      threadId: 'search-thread',
      turnId: 'search-turn',
      createdAt: '2026-08-01T00:00:02.000Z',
      method: 'turn.completed',
      outputText: 'The cobalt albatross is in the older session.',
    });

    expect(
      store.searchConversationMessages({
        query: 'cobalt albatross',
        ownerUserId: 'allowed-user',
        limit: 20,
      }),
    ).toEqual([
      expect.objectContaining({
        eventId: 'search-user',
        role: 'user',
        content: 'find the cobalt albatross',
      }),
      expect.objectContaining({
        eventId: 'search-agent',
        role: 'assistant',
        content: 'The cobalt albatross is in the older session.',
        turnAnchorId: 'search-user',
      }),
    ]);
    // The index query itself is owner-constrained; this is not a response
    // filter over body text from another user's thread.
    expect(
      store.searchConversationMessages({
        query: 'cobalt albatross',
        ownerUserId: 'unentitled-user',
        limit: 20,
      }),
    ).toEqual([]);
  });

  test('finds a CJK phrase through the indexed owner and tenant scope', () => {
    for (const [threadId, tenantId, eventId] of [
      ['cjk-alpha', 'alpha', 'cjk-alpha-message'],
      ['cjk-bravo', 'bravo', 'cjk-bravo-message'],
    ] as const) {
      store.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        tenantExecutionContext: {
          tenantId: tenantId as any,
          source: 'session',
        },
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      });
      store.appendEvent({
        eventId: `${threadId}-session`,
        provider: 'claude',
        threadId,
        createdAt: '2026-08-02T00:00:00.000Z',
        method: 'session.started',
        sessionId: threadId,
        metadata: { userId: 'cjk-owner', agentSlug: 'claude' },
      });
      store.appendEvent({
        eventId,
        provider: 'claude',
        threadId,
        turnId: `${threadId}-turn`,
        createdAt: '2026-08-02T00:00:01.000Z',
        method: 'turn.started',
        prompt: '東京都の天気を確認したい',
      });
    }

    expect(
      store.searchConversationMessages({
        query: '東京都',
        ownerUserId: 'cjk-owner',
        tenantId: 'alpha',
        limit: 20,
      }),
    ).toEqual([expect.objectContaining({ eventId: 'cjk-alpha-message' })]);
    expect(
      store.searchConversationMessages({
        query: '東京都',
        ownerUserId: 'cjk-owner',
        tenantId: 'bravo',
        limit: 20,
      }),
    ).toEqual([expect.objectContaining({ eventId: 'cjk-bravo-message' })]);
    expect(
      store.searchConversationMessages({
        query: '東京都',
        ownerUserId: 'other-owner',
        limit: 20,
      }),
    ).toEqual([]);
  });

  test('uses recency only to settle equally scoring text matches', () => {
    for (const [threadId, eventId, createdAt] of [
      ['ranking-old', 'ranking-old-message', '2025-08-02T00:00:00.000Z'],
      ['ranking-new', 'ranking-new-message', '2026-08-02T00:00:00.000Z'],
    ] as const) {
      store.appendEvent({
        eventId: `${threadId}-session`,
        provider: 'claude',
        threadId,
        createdAt,
        method: 'session.started',
        sessionId: threadId,
        metadata: { userId: 'ranking-owner', agentSlug: 'claude' },
      });
      store.appendEvent({
        eventId,
        provider: 'claude',
        threadId,
        turnId: `${threadId}-turn`,
        createdAt,
        method: 'turn.started',
        prompt: 'cobalt albatross',
      });
    }

    expect(
      store
        .searchConversationMessages({
          query: 'cobalt albatross',
          ownerUserId: 'ranking-owner',
          limit: 20,
        })
        .map((row) => row.eventId),
    ).toEqual(['ranking-new-message', 'ranking-old-message']);
  });

  test('keeps a more relevant non-CJK match ahead of a newer padded match', () => {
    for (const [threadId, eventId, createdAt, prompt] of [
      [
        'non-cjk-relevant',
        'non-cjk-relevant-message',
        '2025-08-02T00:00:00.000Z',
        'cobalt albatross',
      ],
      [
        'non-cjk-padded',
        'non-cjk-padded-message',
        '2026-08-02T00:00:00.000Z',
        `cobalt albatross ${'incidental '.repeat(120)}`,
      ],
    ] as const) {
      store.appendEvent({
        eventId: `${threadId}-session`,
        provider: 'claude',
        threadId,
        createdAt,
        method: 'session.started',
        sessionId: threadId,
        metadata: { userId: 'non-cjk-owner', agentSlug: 'claude' },
      });
      store.appendEvent({
        eventId,
        provider: 'claude',
        threadId,
        turnId: `${threadId}-turn`,
        createdAt,
        method: 'turn.started',
        prompt,
      });
    }

    expect(
      store
        .searchConversationMessages({
          query: 'cobalt albatross',
          ownerUserId: 'non-cjk-owner',
          limit: 20,
        })
        .map((row) => row.eventId),
    ).toEqual(['non-cjk-relevant-message', 'non-cjk-padded-message']);
  });

  test('migrates a pre-FTS database in bounded idempotent event windows', () => {
    store.close();
    const databasePath = join(dir, 'pre-message-search.sqlite');
    const database = new DatabaseSync(databasePath);
    // This is the production schema immediately before message search: every
    // durable event is present, while none of the FTS projections exists.
    database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    database.exec(`
      DROP TABLE orchestration_message_search;
      DROP TABLE orchestration_message_search_v2;
      DROP TABLE orchestration_message_search_v3;
      DELETE FROM orchestration_message_search_projection;
      DELETE FROM orchestration_message_search_backfill;
      DELETE FROM orchestration_message_search_projection_v3;
      DELETE FROM orchestration_message_search_backfill_v3;
    `);
    database
      .prepare(
        `INSERT INTO provider_session_state
          (thread_id, provider, status, created_at, updated_at)
         VALUES (?, 'claude', 'ready', ?, ?)`,
      )
      .run(
        'legacy-search-thread',
        '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:02.000Z',
      );
    const insert = database.prepare(
      `INSERT INTO orchestration_events
        (id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence)
       VALUES (?, 'claude', 'legacy-search-thread', ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'legacy-session-start',
      null,
      'session.started',
      JSON.stringify({
        eventId: 'legacy-session-start',
        method: 'session.started',
        metadata: {
          userId: 'legacy-owner',
          agentSlug: 'claude',
          projectSlug: 'legacy-project',
        },
      }),
      '2026-08-01T00:00:00.000Z',
      1,
      1,
    );
    insert.run(
      'legacy-message',
      'legacy-turn',
      'turn.started',
      JSON.stringify({
        eventId: 'legacy-message',
        method: 'turn.started',
        prompt: 'the phrase typed three sessions ago',
      }),
      '2026-08-01T00:00:01.000Z',
      2,
      2,
    );
    // The fixed startup window makes the migration's maximum read explicit.
    for (
      let index = 0;
      index < MESSAGE_SEARCH_BACKFILL_EVENT_BATCH_SIZE;
      index += 1
    ) {
      insert.run(
        `legacy-noise-${index}`,
        null,
        'content.text-delta',
        JSON.stringify({
          method: 'content.text-delta',
          delta: 'not searchable',
        }),
        `2026-08-01T00:01:${String(index % 60).padStart(2, '0')}.000Z`,
        index + 3,
        index + 3,
      );
    }
    database.close();

    store = new EventStore(databasePath);
    const firstV3Window = new DatabaseSync(databasePath);
    try {
      expect(
        firstV3Window
          .prepare(
            `SELECT last_global_sequence
             FROM orchestration_message_search_backfill_v3 WHERE id = 1`,
          )
          .get(),
      ).toEqual({ last_global_sequence: 500 });
      expect(
        firstV3Window
          .prepare(
            'SELECT COUNT(*) AS count FROM orchestration_message_search_v3',
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      firstV3Window.close();
    }
    expect(
      store.searchConversationMessages({
        query: 'phrase typed three sessions ago',
        ownerUserId: 'legacy-owner',
        limit: 20,
      }),
    ).toEqual([
      expect.objectContaining({
        eventId: 'legacy-message',
        projectSlug: 'legacy-project',
      }),
    ]);

    // A second boot resumes from its persisted cursor and cannot duplicate
    // the same FTS row, even though it advances into the remaining noise.
    store.close();
    store = new EventStore(databasePath);
    expect(
      store.searchConversationMessages({
        query: 'phrase typed three sessions ago',
        ownerUserId: 'legacy-owner',
        limit: 20,
      }),
    ).toHaveLength(1);
  });

  test('retains a forced requested-stop fact through the production bounded projection', () => {
    const threadId = 'forced-stop-terminal-attribution-projection';
    store.appendEvent({
      eventId: 'stop-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-16T00:00:00.000Z',
      method: 'turn.started',
      prompt: 'cancel me',
    });
    // This is the real forced-stop order: the durable settlement is emitted
    // before `turn.aborted`, which otherwise wins the shared lifecycle slot.
    store.appendEvent({
      eventId: 'stop-settled',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-16T00:00:01.000Z',
      method: 'session.stop-settled',
      outcome: 'forced',
      initiatedBy: 'user',
    });
    store.appendEvent({
      eventId: 'stop-aborted',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-16T00:00:02.000Z',
      method: 'turn.aborted',
      reason: 'interrupted',
    });

    const projection = store.listSessionProjectionEvents(threadId);
    expect(projection.map((event) => event.method)).toEqual([
      'turn.started',
      'session.stop-settled',
      'turn.aborted',
    ]);
    const summary = buildOrchestrationSessionSummary({
      persisted: {
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:02.000Z',
      },
      answerability: {
        threadAttachment: 'detached',
        providerRegistered: true,
        observedBy: 'test',
        observedAt: '2026-08-16T00:00:02.000Z',
      },
      events: projection.map((event) => event.payload),
    });
    expect(summary.hasActiveTurn).toBe(false);
    expect(summary.terminalAttribution).toEqual({
      kind: 'requested_stop',
      detail: 'Stopped by request.',
    });
  });

  test('upgrades a v3-settled home so an earlier requested stop becomes attributable', () => {
    const databasePath = join(dir, 'orchestration-v3-stop.sqlite');
    const threadId = 'v3-stop-attribution';
    const legacy = new EventStore(databasePath);
    legacy.appendEvent({
      eventId: 'v3-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-16T00:00:00.000Z',
      method: 'turn.started',
    });
    legacy.appendEvent({
      eventId: 'v3-model-launch-plan',
      provider: 'claude',
      threadId,
      createdAt: '2026-08-16T00:00:00.500Z',
      method: 'session.configured',
      sessionId: threadId,
      metadata: {
        modelLaunchPlan: {
          kind: 'station-resolved',
          modelConnectionId: 'connection-a',
          modelId: 'model-a',
          evidence: 'catalog-accepted',
        },
      },
    });
    legacy.appendEvent({
      eventId: 'v3-stop-settled',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-16T00:00:01.000Z',
      method: 'session.stop-settled',
      outcome: 'forced',
      initiatedBy: 'user',
    });
    legacy.appendEvent({
      eventId: 'v3-aborted',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-16T00:00:02.000Z',
      method: 'turn.aborted',
      reason: 'stopped',
    });
    legacy.close();

    let nonStopFactsBeforeUpgrade: Array<{
      fact_key?: unknown;
      event_id?: unknown;
    }>;
    const v3 = new DatabaseSync(databasePath);
    try {
      v3.exec(
        "DELETE FROM orchestration_session_projection_facts WHERE fact_key LIKE 'settled-stop:%'",
      );
      nonStopFactsBeforeUpgrade = v3
        .prepare(
          "SELECT fact_key, event_id FROM orchestration_session_projection_facts WHERE fact_key NOT LIKE 'settled-stop:%' ORDER BY fact_key",
        )
        .all() as Array<{ fact_key?: unknown; event_id?: unknown }>;
      v3.prepare(
        'DELETE FROM orchestration_event_store_backfills WHERE name = ?',
      ).run('event-facts-v4');
      v3.prepare(
        'DELETE FROM orchestration_event_store_backfills WHERE name = ?',
      ).run('event-facts-v3');
      v3.prepare(
        'INSERT INTO orchestration_event_store_backfills (name, completed_at) VALUES (?, ?)',
      ).run('event-facts-v3', '2026-08-16T00:00:03.000Z');
    } finally {
      v3.close();
    }

    const upgraded = new EventStore(databasePath);
    try {
      const projection = upgraded.listSessionProjectionEvents(threadId);
      expect(projection.map((event) => event.method)).toContain(
        'session.stop-settled',
      );
      expect(
        buildOrchestrationSessionSummary({
          persisted: {
            provider: 'claude',
            threadId,
            status: 'ready',
            createdAt: '2026-08-16T00:00:00.000Z',
            updatedAt: '2026-08-16T00:00:02.000Z',
          },
          answerability: {
            threadAttachment: 'detached',
            providerRegistered: true,
            observedBy: 'test',
            observedAt: '2026-08-16T00:00:03.000Z',
          },
          events: projection.map((event) => event.payload),
        }).terminalAttribution,
      ).toEqual({ kind: 'requested_stop', detail: 'Stopped by request.' });
    } finally {
      upgraded.close();
    }
    const afterUpgrade = new DatabaseSync(databasePath);
    try {
      expect(
        afterUpgrade
          .prepare(
            "SELECT fact_key, event_id FROM orchestration_session_projection_facts WHERE fact_key NOT LIKE 'settled-stop:%' ORDER BY fact_key",
          )
          .all(),
      ).toEqual(nonStopFactsBeforeUpgrade!);
    } finally {
      afterUpgrade.close();
    }
  });

  test('backfills turn-origin diversity facts for an existing event store', () => {
    const databasePath = join(dir, 'orchestration-pre-origin-facts.sqlite');
    const threadId = 'pre-origin-facts';
    const legacy = new EventStore(databasePath);
    for (const [index, clientOrigin] of [
      {
        version: 1 as const,
        actor: { kind: 'device' as const, deviceId: 'phone-1' },
        reported: {
          version: 1 as const,
          surface: 'mobile' as const,
          build: null,
        },
      },
      {
        version: 1 as const,
        actor: { kind: 'operator' as const },
        reported: {
          version: 1 as const,
          surface: 'desktop' as const,
          build: null,
        },
      },
    ].entries()) {
      legacy.appendEvent({
        eventId: `legacy-origin-${index}`,
        provider: 'claude',
        threadId,
        turnId: `turn-${index}`,
        createdAt: `2026-08-30T00:00:0${index}.000Z`,
        method: 'turn.started',
        clientOrigin,
      } as CanonicalRuntimeEvent);
    }
    legacy.close();

    const beforeUpgrade = new DatabaseSync(databasePath);
    try {
      beforeUpgrade.exec(
        "DELETE FROM orchestration_session_projection_facts WHERE fact_key LIKE 'turn-origin:%'",
      );
      beforeUpgrade
        .prepare(
          'DELETE FROM orchestration_event_store_backfills WHERE name = ?',
        )
        .run('event-facts-v5-turn-origin');
    } finally {
      beforeUpgrade.close();
    }

    const upgraded = new EventStore(databasePath);
    try {
      const projection = upgraded
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload);
      const summary = buildOrchestrationSessionSummary({
        persisted: {
          provider: 'claude',
          threadId,
          status: 'ready',
          createdAt: '2026-08-30T00:00:00.000Z',
          updatedAt: '2026-08-30T00:00:01.000Z',
        },
        answerability: {
          threadAttachment: 'detached',
          providerRegistered: true,
          observedBy: 'test',
          observedAt: '2026-08-30T00:00:02.000Z',
        },
        events: projection,
      });
      expect(summary.turnOrigin).toMatchObject({
        latest: { actor: { kind: 'operator' } },
        hasOtherOrigins: true,
      });
    } finally {
      upgraded.close();
    }
  });

  test('retains only the latest settled-stop fact per initiator across two restarts', () => {
    const threadId = 'settled-stop-fact-bound';
    const append = (event: CanonicalRuntimeEvent) => store.appendEvent(event);
    const event = (eventId: string, createdAt: string) => ({
      eventId,
      provider: 'claude' as const,
      threadId,
      createdAt,
    });

    append({
      ...event('turn-1-started', '2026-08-16T00:00:00.000Z'),
      method: 'turn.started',
      turnId: 'turn-1',
    });
    append({
      ...event('turn-1-stop', '2026-08-16T00:00:01.000Z'),
      method: 'session.stop-settled',
      turnId: 'turn-1',
      outcome: 'forced',
      initiatedBy: 'user',
    });
    append({
      ...event('turn-1-aborted', '2026-08-16T00:00:02.000Z'),
      method: 'turn.aborted',
      turnId: 'turn-1',
      reason: 'stopped',
    });
    append({
      ...event('turn-2-started', '2026-08-16T00:00:03.000Z'),
      method: 'turn.started',
      turnId: 'turn-2',
    });
    append({
      ...event('turn-2-stop', '2026-08-16T00:00:04.000Z'),
      method: 'session.stop-settled',
      turnId: 'turn-2',
      outcome: 'forced',
      initiatedBy: 'user',
    });
    append({
      ...event('turn-2-aborted', '2026-08-16T00:00:05.000Z'),
      method: 'turn.aborted',
      turnId: 'turn-2',
      reason: 'stopped',
    });
    append({
      ...event('turn-3-started', '2026-08-16T00:00:06.000Z'),
      method: 'turn.started',
      turnId: 'turn-3',
    });
    append({
      ...event('turn-3-stop', '2026-08-16T00:00:07.000Z'),
      method: 'session.stop-settled',
      turnId: 'turn-3',
      outcome: 'forced',
      initiatedBy: 'stall',
    });
    append({
      ...event('turn-3-aborted', '2026-08-16T00:00:08.000Z'),
      method: 'turn.aborted',
      turnId: 'turn-3',
      reason: 'stopped',
    });
    append({
      ...event('turn-4-started', '2026-08-16T00:00:09.000Z'),
      method: 'turn.started',
      turnId: 'turn-4',
    });
    append({
      ...event('turn-4-error', '2026-08-16T00:00:10.000Z'),
      method: 'runtime.error',
      turnId: 'turn-4',
      severity: 'error',
      message: 'The current turn failed.',
    });

    const projection = store.listSessionProjectionEvents(threadId);
    const settledStops = projection.filter(
      (event) => event.payload.method === 'session.stop-settled',
    );
    expect(settledStops).toHaveLength(2);
    expect(settledStops.length).toBeLessThanOrEqual(3);
    expect(settledStops.map((event) => event.payload.turnId).sort()).toEqual([
      'turn-2',
      'turn-3',
    ]);
    expect(
      buildOrchestrationSessionSummary({
        persisted: {
          provider: 'claude',
          threadId,
          status: 'ready',
          createdAt: '2026-08-16T00:00:00.000Z',
          updatedAt: '2026-08-16T00:00:10.000Z',
        },
        answerability: {
          threadAttachment: 'detached',
          providerRegistered: true,
          observedBy: 'test',
          observedAt: '2026-08-16T00:00:10.000Z',
        },
        events: projection.map((event) => event.payload),
      }).terminalAttribution,
    ).toEqual({
      kind: 'runtime_error',
      detail: 'The engine reported an error: The current turn failed.',
    });
  });

  // archive#3442 review HIGH-1. archive#3442 made an engine-reported turn failure
  // publish `runtime.error` beside the terminal `turn.completed` so the fold
  // records `failed`. This fact set retains only ONE lifecycle event, and
  // every adapter publishes `session.state-changed -> idle` right after
  // `turn.completed`, so a later successful completion always loses that slot
  // — while an unconditionally force-retained `runtime.error` survived
  // forever. That made `failed` one-way: usage limit -> retry -> success and
  // the session STILL read failed, with the stale blockedReason pinned, so
  // the contract's `failed -> queued | running` retry path was unreachable in
  // practice. This drives the real store through the real ingest path
  // (project current state -> normalize -> append), exactly as
  // `OrchestrationService.consumeAdapterEvents` does.
  test('a successful retry clears a previous turn failure', () => {
    const threadId = 'failed-turn-then-retry';
    let session: ProviderSession = {
      provider: 'codex',
      threadId,
      status: 'ready',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    const ingest = (raw: CanonicalRuntimeEvent) => {
      const stored = store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload);
      store.appendEvent(
        normalizeCanonicalRuntimeEventLifecycle(
          raw,
          projectSessionLifecycle({ session, events: stored }).lifecycleState,
          activeTurnIdForEvents(stored),
        ),
      );
    };
    const project = () =>
      projectSessionLifecycle({
        session,
        events: store
          .listSessionProjectionEvents(threadId)
          .map((event) => event.payload),
      });
    const base = { provider: 'codex' as const, threadId };

    ingest({
      ...base,
      eventId: 'retry-started',
      createdAt: '2026-08-01T10:00:00.000Z',
      method: 'session.started',
      sessionId: threadId,
      initialState: 'created',
    });
    ingest({
      ...base,
      eventId: 'retry-turn-1-started',
      createdAt: '2026-08-01T10:00:01.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'go',
    });
    session = { ...session, status: 'running' };
    // The archive#3442 emission shape: the terminal turn event, then the failure.
    ingest({
      ...base,
      eventId: 'retry-turn-1-completed',
      createdAt: '2026-08-01T10:00:02.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'other',
    });
    ingest({
      ...base,
      eventId: 'retry-turn-1-error',
      createdAt: '2026-08-01T10:00:02.000Z',
      method: 'runtime.error',
      turnId: 'turn-1',
      severity: 'error',
      message: 'usage limit reached',
      retriable: false,
    });
    session = { ...session, status: 'error' };
    ingest({
      ...base,
      eventId: 'retry-idle-1',
      createdAt: '2026-08-01T10:00:03.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'errored',
      to: 'idle',
    });

    const afterFailure = project();
    expect(afterFailure.lifecycleState).toBe('failed');
    expect(afterFailure.blockedReason).toBe('usage limit reached');

    ingest({
      ...base,
      eventId: 'retry-turn-2-started',
      createdAt: '2026-08-01T10:00:10.000Z',
      method: 'turn.started',
      turnId: 'turn-2',
      prompt: 'retry',
    });
    session = { ...session, status: 'running' };
    ingest({
      ...base,
      eventId: 'retry-turn-2-completed',
      createdAt: '2026-08-01T10:00:11.000Z',
      method: 'turn.completed',
      turnId: 'turn-2',
      finishReason: 'stop',
      outputText: 'Done.',
    });
    session = { ...session, status: 'ready' };
    ingest({
      ...base,
      eventId: 'retry-idle-2',
      createdAt: '2026-08-01T10:00:11.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });

    // The retained fact set no longer carries turn-1's failure at all: it
    // describes a turn the session has moved past.
    expect(
      store
        .listSessionProjectionEvents(threadId)
        .some((event) => event.method === 'runtime.error'),
    ).toBe(false);
    const afterRetry = project();
    expect(afterRetry.lifecycleState).not.toBe('failed');
    expect(afterRetry.blockedReason).toBeUndefined();
  });

  // The other direction: an error naming the CURRENT turn is the session's
  // present state and must survive, or the scoping above would simply have
  // deleted archive#3442's fix.
  test('retains a runtime.error that names the current turn', () => {
    const threadId = 'failed-current-turn';
    store.appendEvent({
      eventId: 'current-turn-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T11:00:00.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    store.appendEvent({
      eventId: 'current-turn-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T11:00:01.000Z',
      method: 'turn.completed',
      finishReason: 'other',
    });
    store.appendEvent({
      eventId: 'current-turn-error',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T11:00:01.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'usage limit reached',
      retriable: false,
    });
    // The trailing idle is what gives this test power. Every adapter publishes
    // it right after the terminal turn event, and it takes both the
    // latest-event and the latest-lifecycle slot — so the error can only
    // survive through the dedicated current-turn slot under test.
    store.appendEvent({
      eventId: 'current-turn-idle',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-01T11:00:02.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'errored',
      to: 'idle',
    });

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload.eventId),
    ).toContain('current-turn-error');
  });

  // One turn can be announced more than once. `claude-adapter.ts`'s steer path
  // (`sendInput`) publishes a SECOND `turn.started` carrying the SAME turn id
  // and `inputKind: 'steer'` when the user sends mid-turn input. So the latest
  // `turn.started` on the thread can be a re-announcement of the erroring turn
  // itself — the session has NOT moved past it, and comparing sequences
  // against the turn's FIRST announcement would drop the failure of the
  // current turn.
  test('retains a runtime.error whose turn was re-announced by a steer', () => {
    const threadId = 'steered-turn-error';
    store.appendEvent({
      eventId: 'steer-turn-1-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T15:00:00.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    store.appendEvent({
      eventId: 'steer-turn-1-restarted',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T15:00:05.000Z',
      method: 'turn.started',
      prompt: 'actually, do this instead',
      inputKind: 'steer',
    });
    store.appendEvent({
      eventId: 'steer-turn-1-completed',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T15:00:06.000Z',
      method: 'turn.completed',
      finishReason: 'other',
    });
    store.appendEvent({
      eventId: 'steer-turn-1-error',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T15:00:06.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'usage limit reached',
      retriable: false,
    });
    store.appendEvent({
      eventId: 'steer-turn-1-idle',
      provider: 'claude',
      threadId,
      createdAt: '2026-08-01T15:00:07.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'errored',
      to: 'idle',
    });

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload.eventId),
    ).toContain('steer-turn-1-error');
  });

  // archive#3524: the bounded fact set must retain a SECOND-OR-LATER turn's
  // own `turn.started`, not just the session's first (`firstTurnStartedWithPrompt`
  // is pinned to turn 1) or whichever event happens to win the single
  // LIFECYCLE_METHODS slot. Before this fix, turn-2's deferred-retriable
  // `runtime.error` evicted `turn.started(turn-2)` from that one slot — the
  // real fact set genuinely read `{ turn.started(turn-1), runtime.error(turn-2) }`
  // — so `interruptibleTurnIdForEvents` (archive#3473's Stop-path fold) fell
  // through the fail-closed identity guard (archive#3451 B1/D1) to
  // `undefined`: Stop silently did nothing for any turn after the first. This
  // drives the REAL store through the same bounded read Stop uses.
  test('retains the CURRENT (second) turn`s own turn.started so Stop can target it (station#3524)', () => {
    const threadId = 'thread-3524-second-turn-retry';
    store.appendEvent({
      eventId: 'turn-1-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:00.000Z',
      method: 'turn.started',
      prompt: 'first turn',
    });
    store.appendEvent({
      eventId: 'turn-1-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:01.000Z',
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'Done.',
    });
    store.appendEvent({
      eventId: 'turn-2-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-18T00:00:02.000Z',
      method: 'turn.started',
      prompt: 'second turn, please retry',
    });
    // The archive#3524 shape: a codex deferred-retriable (willRetry) error naming
    // turn-2, with NO trailing terminal/idle event — the turn is still live,
    // mid-retry, exactly the window a user reaches for Stop.
    store.appendEvent({
      eventId: 'turn-2-retriable-error',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-18T00:00:03.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Codex runtime error',
      retriable: true,
    });

    const projection = store.listSessionProjectionEvents(threadId);
    expect(projection.map((event) => event.payload.eventId)).toContain(
      'turn-2-started',
    );

    const payloads = projection.map((event) => event.payload);
    // The fix: Stop's fold now resolves the CURRENT turn, not the stale
    // first one and not undefined.
    expect(interruptibleTurnIdForEvents(payloads)).toBe('turn-2');
    // Unaffected FOR THIS SPECIFIC SHAPE (a deferred-retriable error on the
    // current turn, nothing since): `activeTurnIdForEvents` (feeding the
    // DISPLAY-only `hasOpenTurn`/`hasActiveTurn`) still under-reports through
    // it — that pinned tradeoff does not move. This is NOT a general claim
    // that `activeTurnIdForEvents` is unaffected by this fix — see the next
    // test, where the same slot changes its answer (correctly) for a
    // different real shape.
    expect(activeTurnIdForEvents(payloads)).toBeUndefined();
  });

  // archive#3524 fix-round finding: `activeTurnIdForEvents` (the DISPLAY fold
  // behind `hasOpenTurn`/`hasActiveTurn`) is NOT blanket-unaffected by the new
  // slot — only the specific deferred-retriable-error shape above is. This
  // real-store shape changes its answer: an ORPHAN terminal event that names
  // an OLDER turn, arriving (in sequence) after a NEWER turn has already
  // started. Before this fix, the bounded set only ever saw
  // `{ turn.started(turn-1), turn.completed(turn-1) }` (turn-2's own start
  // was evicted from the single LIFECYCLE_METHODS slot by the very same
  // orphan `turn.completed`), so the fold's exact-identity match accepted the
  // orphan against turn-1 and closed it — `hasActiveTurn: false`. With
  // turn-2's start now always visible, the SAME orphan event no longer
  // matches the (now correctly turn-2) active id, so it is correctly refused
  // and the fold reports turn-2 still open — `hasActiveTurn: true`. The
  // branch's answer is the more accurate one (turn-2 genuinely has no
  // completion on record), but it IS a behavior change and needs its own
  // coverage rather than being asserted away as "unaffected". On MAIN this
  // fixture reads `activeTurnIdForEvents === undefined` (the orphan matches
  // turn-1's stale evicted id and closes it) — the assertion below only
  // covers the branch's new value, so that main-side value is recorded here
  // rather than left for a reader to reconstruct.
  //
  // The fixture is honestly ambiguous about which turn the orphan actually
  // describes: if an adapter mis-stamped a turn-2 completion with turn-1's
  // id, the branch's "turn-2 still open" answer over-reports. Failing OPEN
  // on an identity mismatch (rather than guessing which turn a misnamed
  // terminal meant) is the pre-existing documented policy this fold already
  // carries (`acceptsTurnTerminalEvent`'s exact-match requirement), not a new
  // decision introduced by this fix.
  test('an orphan terminal for an OLDER turn now correctly leaves the NEWER turn open (station#3524 fix-round finding)', () => {
    const threadId = 'thread-3524-orphan-terminal';
    store.appendEvent({
      eventId: 'orphan-turn-1-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:00.000Z',
      method: 'turn.started',
      prompt: 'first turn',
    });
    store.appendEvent({
      eventId: 'orphan-turn-2-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-18T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'second turn',
    });
    // The orphan: a completion for turn-1, arriving (in sequence) AFTER
    // turn-2 has already started.
    store.appendEvent({
      eventId: 'orphan-turn-1-completed-late',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:02.000Z',
      method: 'turn.completed',
      finishReason: 'other',
    });

    const payloads = store
      .listSessionProjectionEvents(threadId)
      .map((event) => event.payload);
    expect(activeTurnIdForEvents(payloads)).toBe('turn-2');
  });

  // archive#3557: bedrock publishes `session.state-changed -> idle`
  // IMMEDIATELY after `turn.completed` (`bedrock-adapter.ts`'s
  // `publishCompletion`, replicated here — station fix-round review NIT: an
  // earlier version of this comment claimed EVERY adapter does this and that
  // the shared `completedAt` timestamp both events carry was load-bearing;
  // neither is true. Only bedrock and ollama publish it inline (codex,
  // claude, and station-agent reach idle through other paths — see
  // `event-store.ts`'s `listSessionProjectionEvents` comment), and the
  // projection sorts strictly on `sequence` — `latestEventByMethods` compares
  // `event.sequence`, never `createdAt` — so a shared timestamp exercises
  // nothing; this test's power comes entirely from `turn.completed` and
  // `session.state-changed` sharing one `LIFECYCLE_METHODS` slot with
  // `session.state-changed` at the higher sequence). Before this fix, that
  // trailing state change won the single `LIFECYCLE_METHODS` slot and
  // evicted the completion from the bounded fact set entirely — the turn's
  // OWN start survived (archive#3524's dedicated slot), so the fold read
  // "turn-1 started, nothing closed it" and reported `hasActiveTurn: true`
  // for a session with nothing running. This drives the real `EventStore`,
  // not a hand-built array — every existing `hasActiveTurn` assertion in
  // orchestration-session-state.test.ts feeds `buildOrchestrationSessionSummary`
  // a hand-built array directly, which is why the eviction was invisible to
  // the suite that tests the exact function it breaks.
  test('hasActiveTurn reads false for a session with nothing running, through the real store (station#3557)', () => {
    const threadId = 'thread-3557-nothing-running';
    store.appendEvent({
      eventId: 'evt-session-started',
      provider: 'bedrock',
      threadId,
      createdAt: '2026-08-18T00:00:00.000Z',
      method: 'session.started',
      sessionId: threadId,
      initialState: 'created',
    });
    store.appendEvent({
      eventId: 'evt-turn-1-started',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'do the thing',
    });
    // bedrock-adapter.ts `publishCompletion`: turn.completed, THEN
    // session.state-changed(idle), same createdAt.
    store.appendEvent({
      eventId: 'evt-turn-1-completed',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:02.000Z',
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'Done.',
    });
    store.appendEvent({
      eventId: 'evt-idle',
      provider: 'bedrock',
      threadId,
      createdAt: '2026-08-18T00:00:02.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });

    const projection = store.listSessionProjectionEvents(threadId);
    // Ground truth for the bounded set: the completion now has its own
    // slot, so it survives beside the trailing idle rather than being
    // evicted by it.
    expect(projection.map((event) => event.method)).toEqual([
      'session.started',
      'turn.started',
      'turn.completed',
      'session.state-changed',
    ]);

    const payloads = projection.map((event) => event.payload);
    expect(activeTurnIdForEvents(payloads)).toBeUndefined();

    const summary = buildOrchestrationSessionSummary({
      answerability: {
        threadAttachment: 'detached',
        providerRegistered: true,
        observedBy: 'test',
        observedAt: '2026-08-18T00:00:02.000Z',
      },
      persisted: {
        provider: 'bedrock',
        threadId,
        status: 'ready',
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:02.000Z',
      },
      events: payloads,
    });
    expect(summary.hasActiveTurn).toBe(false);
    expect(summary.lifecycleState).toBe('completed');
  });

  // archive#3557/#3558 fix-round review BLOCK 1 (independent review's exact
  // sequence, driven through the real `EventStore` rather than a hand-built
  // array — the reviewer settled this by code reading and could not execute
  // it live). Before turn-scoping, the dedicated terminal slot
  // (`latestEventByMethods(threadId, ['turn.completed', 'turn.aborted'])`)
  // retained the latest terminal ACROSS THE WHOLE THREAD, not the current
  // turn's own terminal:
  //
  //   1 turn.started(turn-1)
  //   2 turn.started(turn-2)
  //   3 runtime.error(turn-2, "usage limit reached", retriable:false)
  //   4 turn.completed(turn-1)   <- codex's own late notification, no
  //                                 serialization guard on
  //                                 `record.activeTurnId`
  //                                 (`codex-adapter.ts:1412`)
  //   5 session.state-changed -> idle
  //
  // Pre-fix, event 4 entered the bounded fact set (its own dedicated slot,
  // unscoped to any turn) and sorted AFTER event 3's `runtime.error` —
  // `findTerminalFailureEvent`'s unguarded reverse scan
  // (`orchestration-session-state.ts`) hit it first and returned `undefined`,
  // so a run that died on a usage-limit failure read `completed` with no
  // `failureKind`, no `failureMessage`, and `retryEligible: false`, and
  // `projectSessionLifecycle`'s separate ungated reverse `find` for
  // `blockedReason` still set it from event 3 — a `completed` summary
  // carrying a `blockedReason`. Turn-scoping the terminal slot to the
  // CURRENT turn (`latestTerminalEventForTurn`, keyed off `turn-2` here)
  // makes event 4 fail to match at all, so it never enters the bounded set.
  test('a stale thread-wide turn.completed for an earlier turn does not blind failure reporting for the current turn (station#3557/#3558 review BLOCK 1)', () => {
    const threadId = 'thread-3558-review-block-1';
    store.appendEvent({
      eventId: 'evt-session-started',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-19T00:00:00.000Z',
      method: 'session.started',
      sessionId: threadId,
      initialState: 'created',
    });
    store.appendEvent({
      eventId: 'evt-turn-1-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-19T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'first turn',
    });
    store.appendEvent({
      eventId: 'evt-turn-2-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-19T00:00:02.000Z',
      method: 'turn.started',
      prompt: 'second turn, please retry',
    });
    store.appendEvent({
      eventId: 'evt-turn-2-usage-limit',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-19T00:00:03.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'usage limit reached',
      retriable: false,
    });
    // codex's own late `turn/completed(turn-1)` notification — arrives after
    // turn-2 is already the current turn (codex's own protocol timing, not
    // something Station controls; see `codex-adapter-notifications.ts`'s
    // `'turn/completed'` case, which only guards its in-memory
    // `record.activeTurnId` bookkeeping, not the publish itself).
    store.appendEvent({
      eventId: 'evt-turn-1-stale-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-19T00:00:04.000Z',
      method: 'turn.completed',
      finishReason: 'other',
    });
    store.appendEvent({
      eventId: 'evt-idle',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-19T00:00:05.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });

    const projection = store.listSessionProjectionEvents(threadId);
    // Ground truth for the bounded set: the stale turn-1 completion does not
    // survive turn-scoping — it is absent, not merely out-ranked.
    expect(
      projection.some((event) => event.id === 'evt-turn-1-stale-completed'),
    ).toBe(false);
    expect(projection.map((event) => event.method)).toEqual([
      'session.started',
      'turn.started',
      'turn.started',
      'runtime.error',
      'session.state-changed',
    ]);

    const payloads = projection.map((event) => event.payload);
    const persisted: ProviderSession = {
      provider: 'codex',
      threadId,
      status: 'ready',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:05.000Z',
    };
    const answerability = {
      threadAttachment: 'detached' as const,
      providerRegistered: true,
      observedBy: 'test',
      observedAt: '2026-08-19T00:00:05.000Z',
    };

    const summary = buildOrchestrationSessionSummary({
      answerability,
      persisted,
      events: payloads,
    });
    // The failure survives, unmasked by the stale completion: `failed`, with
    // the real `blockedReason` still attached — never `completed` carrying a
    // `blockedReason`, the contradictory shape event 4 produced pre-fix.
    expect(summary.lifecycleState).toBe('failed');
    expect(summary.blockedReason).toBe('usage limit reached');

    const run = buildAgentRunSummary({
      answerability,
      persisted,
      events: payloads,
    });
    expect(run.status).toBe('failed');
    // Pre-fix, `status` was `completed` with NO `failureKind` at all (the
    // reverse scan hit event 4 first and returned `undefined` from
    // `findTerminalFailureEvent`) — this is the concrete manifestation of
    // "no failure detail and no retry affordance" the review named.
    expect(run.failureKind).toBeDefined();
    expect(run.failureMessage).toBe('usage limit reached');
    expect(run.retryEligible).toBe(false);
  });

  // archive#3557/#3558 fix-round: the non-regression the brief's own
  // "Important" note called out — turn-scoping must not break the SAME-turn
  // case that already worked correctly on this branch before the review:
  // `turn.started(t1) -> runtime.error(t1, retriable: true) ->
  // turn.completed(t1) -> idle` must still read `completed`, not `failed`.
  // Both `deriveLifecycleTransition`'s `runtime.error` case and
  // `deriveAgentRunStatus`'s are UNCONDITIONAL (no identity guard at all —
  // only the two TERMINAL cases, `turn.completed`/`turn.aborted`, gate on
  // `acceptsTurnTerminalEvent`).
  //
  // archive#3581 review LOW 1: this comment used to say acceptance here
  // relied on "the SAME permissive `activeTurnId === undefined` default"
  // as review BLOCK 2's gap. That was true pre-#3581 and is FALSE now —
  // archive#3581 replaced that fold with `nextTurnIdentityAnchor`, which sets the
  // anchor to `t1` at `turn.started(t1)` and RETAINS it straight through
  // `runtime.error(t1)` (no clearing at all). The later `turn.completed(t1)`
  // is accepted by an EXACT identity match against a DEFINED anchor (`t1`
  // === `t1`), not by falling through to a permissive `undefined` default —
  // same outcome, different (now correct-by-construction) mechanism. This
  // test still proves the same-turn-retry contract must keep holding; it
  // no longer proves anything about a permissive default, because that
  // default no longer participates in this scenario. Turn-scoping does not
  // disturb any of this: `latestTerminalEventForTurn(threadId, 'turn-1')`
  // still retains this turn's own `turn.completed`, same as pre-review.
  test('a same-turn retry-then-complete still reports completed after turn-scoping (station#3557/#3558 non-regression)', () => {
    const threadId = 'thread-3558-same-turn-retry-then-complete';
    store.appendEvent({
      eventId: 'evt-turn-1-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-19T00:00:00.000Z',
      method: 'turn.started',
      prompt: 'do the thing',
    });
    store.appendEvent({
      eventId: 'evt-turn-1-deferred-error',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-19T00:00:01.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'transient hiccup, retrying',
      retriable: true,
    });
    store.appendEvent({
      eventId: 'evt-turn-1-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-19T00:00:02.000Z',
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'Done, after a retry.',
    });
    store.appendEvent({
      eventId: 'evt-idle',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-19T00:00:02.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });

    const projection = store.listSessionProjectionEvents(threadId);
    const payloads = projection.map((event) => event.payload);
    const persisted: ProviderSession = {
      provider: 'codex',
      threadId,
      status: 'ready',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:02.000Z',
    };
    const answerability = {
      threadAttachment: 'detached' as const,
      providerRegistered: true,
      observedBy: 'test',
      observedAt: '2026-08-19T00:00:02.000Z',
    };

    const summary = buildOrchestrationSessionSummary({
      answerability,
      persisted,
      events: payloads,
    });
    expect(summary.lifecycleState).toBe('completed');

    const run = buildAgentRunSummary({
      answerability,
      persisted,
      events: payloads,
    });
    expect(run.status).toBe('completed');
  });

  // archive#3581: the cross-turn companion to the non-regression test above,
  // driven through the REAL `EventStore` and specifically through the FULL,
  // unbounded `listEvents(threadId)` path `orchestration-service.ts`'s
  // `readSession` (and `sessionQueries.projectConversation`) actually feed
  // `buildOrchestrationSessionSummary`/`buildAgentRunSummary` — NOT the
  // turn-scoped `listSessionProjectionEvents` bounded projection, which
  // archive#3557 already protects and which proves nothing about this gap (the
  // non-regression test immediately above reads the bounded projection on
  // purpose). `conversation-history-read-service.ts`'s reader is a
  // DIFFERENT, narrower bypass — `listRecentEventsByThread(threadId, 1_000)`,
  // a bounded 1,000-event TAIL, not the full log — safe from this specific
  // two-event-cross-turn scenario either way (1,000 events comfortably
  // covers it) but not exercised by this test; not claimed here as "full
  // log" (archive#3581 review LOW 2). A codex session runs turn-1, then
  // turn-2; turn-2 fails for real; turn-1's late `turn/completed` (codex's
  // own protocol timing, archive#3572) then arrives naming a turn the session has
  // already moved past.
  test('a stale turn.completed for a superseded turn does not overwrite a real failure, read through the FULL unbounded event log (station#3581)', () => {
    const threadId = 'thread-3581-full-log-cross-turn';
    store.appendEvent({
      eventId: 'evt-turn-1-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-19T00:00:00.000Z',
      method: 'turn.started',
      prompt: 'first turn',
    });
    store.appendEvent({
      eventId: 'evt-turn-2-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-19T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'second turn',
    });
    // Closes turn-2 with a REAL failure, clearing `activeTurnId` — the
    // event that used to erase which turn the identity guard was protecting.
    store.appendEvent({
      eventId: 'evt-turn-2-failed',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-19T00:00:02.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'usage limit reached',
      retriable: false,
    });
    // The stale/orphaned terminal for turn-1, arriving after turn-2's real
    // failure — same shape as codex's `'turn/completed'` late notification.
    store.appendEvent({
      eventId: 'evt-turn-1-stale-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-19T00:00:03.000Z',
      method: 'turn.completed',
      finishReason: 'other',
    });

    // Deliberately `listEvents`, not `listSessionProjectionEvents` — the
    // FULL, unbounded log `readSession` reads.
    const fullLog = store.listEvents(threadId).map((event) => event.payload);
    expect(fullLog.map((event) => event.method)).toEqual([
      'turn.started',
      'turn.started',
      'runtime.error',
      'turn.completed',
    ]);

    const persisted: ProviderSession = {
      provider: 'codex',
      threadId,
      status: 'error',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:03.000Z',
    };
    const answerability = {
      threadAttachment: 'detached' as const,
      providerRegistered: true,
      observedBy: 'test',
      observedAt: '2026-08-19T00:00:03.000Z',
    };

    const summary = buildOrchestrationSessionSummary({
      answerability,
      persisted,
      events: fullLog,
    });
    expect(summary.lifecycleState).toBe('failed');
    expect(summary.blockedReason).toBe('usage limit reached');

    const run = buildAgentRunSummary({
      answerability,
      persisted,
      events: fullLog,
    });
    expect(run.status).toBe('failed');
    expect(run.failureKind).toBe('agent_error');
    expect(run.failureMessage).toBe('usage limit reached');
    expect(run.retryEligible).toBe(false);
  });

  // archive#3524 fix-round finding (consumeAdapterEvents write path): a
  // WRITE consequence of the same eviction, not just a read/display one.
  // `OrchestrationService.consumeAdapterEvents` resolves `activeTurnId` from
  // this exact bounded read and hands it to
  // `normalizeCanonicalRuntimeEventLifecycle`, which stamps
  // `sessionState`/`previousState`/`transitionReason`/`transitionSource` onto
  // the event BEFORE it is persisted — `deriveLifecycleTransition` returns
  // `null` (no stamp at all) when `acceptsTurnTerminalEvent` refuses the
  // terminal event's identity against a STALE `activeTurnId`. Any
  // LIFECYCLE_METHODS event between a turn's start and its own terminal can
  // evict that start from the single slot on main — an ordinary in-turn
  // approval (`request.resolved`) is enough, no error required — so a
  // routine approval on turn 2 silently strips the eventual genuine
  // `turn.completed(turn-2)` of its entire lifecycle stamp when persisted.
  // This drives the real `ingest` pattern `consumeAdapterEvents` itself uses:
  // read the bounded projection, normalize, append — SIMPLIFIED on one axis:
  // it passes `previousState: undefined` where production passes
  // `readCurrentLifecycleState(threadId)`'s result. Harmless here because
  // `deriveLifecycleTransition` returns `null` (no stamp at all) from the
  // `acceptsTurnTerminalEvent` identity check BEFORE `from`/`previousState`
  // is ever consumed — the defect this test proves does not depend on what
  // `previousState` is.
  test('a genuine turn.completed keeps its lifecycle stamp through an in-turn approval on the SECOND turn (station#3524 fix-round finding)', () => {
    const threadId = 'thread-3524-write-path-stamp';
    const ingest = (raw: CanonicalRuntimeEvent) => {
      const stored = store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload);
      store.appendEvent(
        normalizeCanonicalRuntimeEventLifecycle(
          raw,
          undefined,
          activeTurnIdForEvents(stored),
        ),
      );
    };
    const base = { provider: 'claude' as const, threadId };

    ingest({
      ...base,
      eventId: 'stamp-turn-1-started',
      createdAt: '2026-08-18T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'first turn',
    });
    ingest({
      ...base,
      eventId: 'stamp-turn-1-completed',
      createdAt: '2026-08-18T00:00:01.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
      outputText: 'Done.',
    });
    ingest({
      ...base,
      eventId: 'stamp-turn-2-started',
      createdAt: '2026-08-18T00:00:02.000Z',
      method: 'turn.started',
      turnId: 'turn-2',
      prompt: 'second turn, needs approval',
    });
    ingest({
      ...base,
      eventId: 'stamp-turn-2-approval-opened',
      createdAt: '2026-08-18T00:00:03.000Z',
      method: 'request.opened',
      requestId: 'req-2',
      requestType: 'approval',
      title: 'Run this tool?',
    });
    // `request.resolved` is a LIFECYCLE_METHODS event with a HIGHER sequence
    // than turn-2's own start — on main this is exactly what evicts
    // turn.started(turn-2) from the single LIFECYCLE_METHODS slot, no error
    // required.
    ingest({
      ...base,
      eventId: 'stamp-turn-2-approval-resolved',
      createdAt: '2026-08-18T00:00:04.000Z',
      method: 'request.resolved',
      requestId: 'req-2',
      status: 'approved',
    });
    ingest({
      ...base,
      eventId: 'stamp-turn-2-completed',
      createdAt: '2026-08-18T00:00:05.000Z',
      method: 'turn.completed',
      turnId: 'turn-2',
      finishReason: 'stop',
      outputText: 'Done, again.',
    });

    const persisted = store
      .listEvents(threadId)
      .find((event) => event.payload.eventId === 'stamp-turn-2-completed');
    expect(persisted?.payload.method).toBe('turn.completed');
    expect(persisted?.payload.sessionState).toBe('completed');
  });

  // archive#3524 fix-round: re-pins archive#3451 B1/D1's fail-closed identity
  // guard (`event.turnId === activeTurnId` in `nextActiveTurnId`) against
  // shapes the REAL store still produces today, now that archive#3524 closed the
  // ONE shape (a bare second-turn eviction) the guard's original hand-built
  // test used. Both scenarios below still leave the guard doing real work.
  describe('the fail-closed identity guard still discriminates (station#3451 B1/D1, re-pinned post-#3524)', () => {
    test('a deferred-retriable error naming a turn that was NEVER announced, while turn-2 is current', () => {
      const threadId = 'thread-3524-guard-unannounced-turn';
      store.appendEvent({
        eventId: 'guard-turn-1-started',
        provider: 'codex',
        threadId,
        turnId: 'turn-1',
        createdAt: '2026-08-18T00:00:00.000Z',
        method: 'turn.started',
        prompt: 'first turn',
      });
      store.appendEvent({
        eventId: 'guard-turn-1-completed',
        provider: 'codex',
        threadId,
        turnId: 'turn-1',
        createdAt: '2026-08-18T00:00:01.000Z',
        method: 'turn.completed',
        finishReason: 'stop',
        outputText: 'Done.',
      });
      store.appendEvent({
        eventId: 'guard-turn-2-started',
        provider: 'codex',
        threadId,
        turnId: 'turn-2',
        createdAt: '2026-08-18T00:00:02.000Z',
        method: 'turn.started',
        prompt: 'second turn',
      });
      // Names turn-3, which never got its own `turn.started` — an id
      // allocated but never announced (the same "ghost turn" shape covered
      // elsewhere in this file, here arriving while turn-2 is genuinely
      // current).
      store.appendEvent({
        eventId: 'guard-turn-3-ghost-error',
        provider: 'codex',
        threadId,
        turnId: 'turn-3',
        createdAt: '2026-08-18T00:00:03.000Z',
        method: 'runtime.error',
        severity: 'error',
        message: 'Codex runtime error',
        retriable: true,
      });

      const payloads = store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload);
      expect(interruptibleTurnIdForEvents(payloads)).toBeUndefined();
    });

    test('a deferred-retriable error naming a STALE earlier turn, while turn-2 is current', () => {
      const threadId = 'thread-3524-guard-stale-earlier-turn';
      store.appendEvent({
        eventId: 'guard-stale-turn-1-started',
        provider: 'codex',
        threadId,
        turnId: 'turn-1',
        createdAt: '2026-08-18T00:00:00.000Z',
        method: 'turn.started',
        prompt: 'first turn',
      });
      store.appendEvent({
        eventId: 'guard-stale-turn-2-started',
        provider: 'codex',
        threadId,
        turnId: 'turn-2',
        createdAt: '2026-08-18T00:00:01.000Z',
        method: 'turn.started',
        prompt: 'second turn',
      });
      // A retriable error for turn-1, arriving (in sequence) AFTER turn-2
      // has already started — a late/mis-attributed report for a turn the
      // session has already moved past.
      store.appendEvent({
        eventId: 'guard-stale-turn-1-late-error',
        provider: 'codex',
        threadId,
        turnId: 'turn-1',
        createdAt: '2026-08-18T00:00:02.000Z',
        method: 'runtime.error',
        severity: 'error',
        message: 'Codex runtime error',
        retriable: true,
      });

      const payloads = store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload);
      expect(interruptibleTurnIdForEvents(payloads)).toBeUndefined();
    });
  });

  // archive#3442 review HIGH-1. An adapter can stamp a turn id onto a failure
  // before that turn is ever announced: `claude-adapter.ts` assigns
  // `record.activeTurnId` at the top of `sendTurn` and publishes
  // `turn.started` ~165 lines later, while the terminal-result branch in
  // `claude-adapter-events.ts` publishes `runtime.error` with that id and no
  // dispatched-turn guard. Such an error names a turn with NO `turn.started`
  // row — it is not the latest turn, but nothing superseded it either, and
  // dropping it leaves a session marked failed with no `blockedReason`, no
  // `failureKind`, and `retryEligible: false`.
  test('retains a runtime.error naming a turn that never started', () => {
    const threadId = 'ghost-turn-error';
    store.appendEvent({
      eventId: 'ghost-turn-1-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T13:00:00.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    store.appendEvent({
      eventId: 'ghost-turn-1-completed',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T13:00:01.000Z',
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'Done.',
    });
    // turn-2's id was allocated, but the failure arrived before its
    // `turn.started` was ever published.
    store.appendEvent({
      eventId: 'ghost-turn-2-error',
      provider: 'claude',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-01T13:00:10.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'engine session binding is dead',
      retriable: false,
    });
    store.appendEvent({
      eventId: 'ghost-turn-2-idle',
      provider: 'claude',
      threadId,
      createdAt: '2026-08-01T13:00:11.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'errored',
      to: 'idle',
    });

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload.eventId),
    ).toContain('ghost-turn-2-error');
  });

  // archive#3442 delta review HIGH-1. The retention above is asserted at the
  // MECHANISM level (the error id is in the fact set); this asserts the
  // OUTCOME retention exists to produce. A ghost-turn error must stay the
  // session's account of the failure while nothing has happened since — and
  // must stop being it once a later turn is announced, or the retention
  // recreates archive#3442's one-way `failed` from the other side. Both directions
  // are driven through the real ingest path.
  test('a ghost-turn failure reads failed, and a later turn clears it', () => {
    const threadId = 'ghost-turn-then-retry';
    let session: ProviderSession = {
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: '2026-08-01T14:00:00.000Z',
      updatedAt: '2026-08-01T14:00:00.000Z',
    };
    const ingest = (raw: CanonicalRuntimeEvent) => {
      const stored = store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload);
      store.appendEvent(
        normalizeCanonicalRuntimeEventLifecycle(
          raw,
          projectSessionLifecycle({ session, events: stored }).lifecycleState,
          activeTurnIdForEvents(stored),
        ),
      );
    };
    const project = () =>
      projectSessionLifecycle({
        session,
        events: store
          .listSessionProjectionEvents(threadId)
          .map((event) => event.payload),
      });
    const base = { provider: 'claude' as const, threadId };

    ingest({
      ...base,
      eventId: 'ghost-retry-started',
      createdAt: '2026-08-01T14:00:00.000Z',
      method: 'session.started',
      sessionId: threadId,
      initialState: 'created',
    });
    ingest({
      ...base,
      eventId: 'ghost-retry-turn-1-started',
      createdAt: '2026-08-01T14:00:01.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'go',
    });
    session = { ...session, status: 'running' };
    ingest({
      ...base,
      eventId: 'ghost-retry-turn-1-completed',
      createdAt: '2026-08-01T14:00:02.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
      outputText: 'Done.',
    });
    session = { ...session, status: 'ready' };
    ingest({
      ...base,
      eventId: 'ghost-retry-idle-1',
      createdAt: '2026-08-01T14:00:03.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });

    // turn-2's id was allocated, but the failure arrived before any
    // `turn.started` for it was published.
    ingest({
      ...base,
      eventId: 'ghost-retry-turn-2-error',
      createdAt: '2026-08-01T14:00:10.000Z',
      method: 'runtime.error',
      turnId: 'turn-2',
      severity: 'error',
      message: 'engine session binding is dead',
      retriable: false,
    });
    session = { ...session, status: 'error' };
    ingest({
      ...base,
      eventId: 'ghost-retry-idle-2',
      createdAt: '2026-08-01T14:00:11.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'errored',
      to: 'idle',
    });

    // Direction one: nothing has happened since, so the ghost error is still
    // the session's only account of the failure and must carry its reason.
    const afterGhost = project();
    expect(afterGhost.lifecycleState).toBe('failed');
    expect(afterGhost.blockedReason).toBe('engine session binding is dead');

    // Direction two: a fully successful retry. turn-3's `turn.completed`
    // cannot reach the fold — the trailing idle takes the single lifecycle
    // slot — so if the ghost error is still retained here it is the last word
    // forever and `failed` is one-way again.
    ingest({
      ...base,
      eventId: 'ghost-retry-turn-3-started',
      createdAt: '2026-08-01T14:00:20.000Z',
      method: 'turn.started',
      turnId: 'turn-3',
      prompt: 'retry',
    });
    session = { ...session, status: 'running' };
    ingest({
      ...base,
      eventId: 'ghost-retry-turn-3-completed',
      createdAt: '2026-08-01T14:00:21.000Z',
      method: 'turn.completed',
      turnId: 'turn-3',
      finishReason: 'stop',
      outputText: 'Done.',
    });
    session = { ...session, status: 'ready' };
    ingest({
      ...base,
      eventId: 'ghost-retry-idle-3',
      createdAt: '2026-08-01T14:00:22.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .some((event) => event.method === 'runtime.error'),
    ).toBe(false);
    const afterRetry = project();
    expect(afterRetry.lifecycleState).not.toBe('failed');
    expect(afterRetry.blockedReason).toBeUndefined();
  });

  // A runtime.error that names no turn is session-scoped — a transport or
  // process failure, not a fact about one unit of work. Turn scoping keys off
  // the error's own turn, so it does not reach these. archive#3485: what
  // supersedes a session-scoped error is a strictly later GENUINE
  // `turn.completed` (proof an engine ran a whole turn end-to-end through
  // the transport the error indicted) — and nothing weaker. This test pins
  // the boundary of that rule: a later `turn.started` alone is only an
  // announcement, announcing costs nothing, and a dead transport may still
  // describe the session at that moment. The error must survive it.
  test('retains a session-scoped runtime.error that names no turn', () => {
    const threadId = 'session-scoped-error';
    store.appendEvent({
      eventId: 'scoped-turn-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T12:00:00.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    store.appendEvent({
      eventId: 'scoped-error',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-01T12:00:01.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'transport closed',
      retriable: false,
    });
    store.appendEvent({
      eventId: 'scoped-turn-2-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-01T12:00:02.000Z',
      method: 'turn.started',
      prompt: 'again',
    });

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload.eventId),
    ).toContain('scoped-error');
  });

  // archive#3485, the outcome the rule exists to produce, driven through the
  // real ingest path like the ghost-turn test above: a transport-level
  // failure must stop being the session's present state once a fully
  // successful later turn proves recovery. Probe-measured on the pre-fix
  // tree this exact sequence projected
  // `{"lifecycleState":"failed","blockedReason":"transport closed"}` forever.
  test('a session-scoped failure reads failed, and a later completed turn clears it', () => {
    const threadId = 'session-scoped-then-recovery';
    let session: ProviderSession = {
      provider: 'codex',
      threadId,
      status: 'ready',
      createdAt: '2026-08-01T15:00:00.000Z',
      updatedAt: '2026-08-01T15:00:00.000Z',
    };
    const ingest = (raw: CanonicalRuntimeEvent) => {
      const stored = store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload);
      store.appendEvent(
        normalizeCanonicalRuntimeEventLifecycle(
          raw,
          projectSessionLifecycle({ session, events: stored }).lifecycleState,
          activeTurnIdForEvents(stored),
        ),
      );
    };
    const project = () =>
      projectSessionLifecycle({
        session,
        events: store
          .listSessionProjectionEvents(threadId)
          .map((event) => event.payload),
      });
    const base = { provider: 'codex' as const, threadId };

    ingest({
      ...base,
      eventId: 'recovery-session-started',
      createdAt: '2026-08-01T15:00:00.000Z',
      method: 'session.started',
      sessionId: threadId,
      initialState: 'created',
    });
    ingest({
      ...base,
      eventId: 'recovery-transport-error',
      createdAt: '2026-08-01T15:00:01.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'transport closed',
      retriable: false,
    });
    session = { ...session, status: 'error' };

    // Direction one: nothing has proved recovery, so the session-scoped
    // error is the session's present state and must carry its reason.
    const afterError = project();
    expect(afterError.lifecycleState).toBe('failed');
    expect(afterError.blockedReason).toBe('transport closed');

    // Direction two: a fully successful later turn. Its completion is proof
    // an engine ran end-to-end through the transport the error indicted.
    ingest({
      ...base,
      eventId: 'recovery-turn-1-started',
      createdAt: '2026-08-01T15:00:10.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'retry',
    });
    session = { ...session, status: 'running' };
    ingest({
      ...base,
      eventId: 'recovery-turn-1-completed',
      createdAt: '2026-08-01T15:00:11.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
      outputText: 'Done.',
    });
    session = { ...session, status: 'ready' };
    ingest({
      ...base,
      eventId: 'recovery-idle',
      createdAt: '2026-08-01T15:00:12.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .some((event) => event.method === 'runtime.error'),
    ).toBe(false);
    const afterRecovery = project();
    expect(afterRecovery.lifecycleState).not.toBe('failed');
    expect(afterRecovery.blockedReason).toBeUndefined();
  });

  // archive#3485 boundary: a Stop confirmation is not recovery. codex's
  // interrupt path publishes `turn.completed(finishReason: 'cancelled')`
  // (`mapTurnFinishReason('interrupted')`), which proves a stop was
  // processed, not that the session can run work — the turn may have been
  // cancelled precisely BECAUSE the session is broken. The error stays.
  test('a session-scoped runtime.error survives a later cancelled turn.completed', () => {
    const threadId = 'session-scoped-then-cancelled';
    store.appendEvent({
      eventId: 'cancel-transport-error',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-01T16:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'transport closed',
      retriable: false,
    });
    store.appendEvent({
      eventId: 'cancel-turn-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T16:00:01.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    store.appendEvent({
      eventId: 'cancel-turn-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T16:00:02.000Z',
      method: 'turn.completed',
      finishReason: 'cancelled',
    });

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload.eventId),
    ).toContain('cancel-transport-error');
  });

  // archive#3485 verification MEDIUM: every PROVEN member must supersede,
  // proven per-member on THIS consumer (the auth monitor already tests its
  // own stake per-member) — otherwise dropping 'tool-calls'/'max-tokens'
  // from the shared set, or this file drifting to a stale copy of it, reds
  // only the auth suite and the docblock's cross-consumer coupling claim
  // goes test-unproven here. Measured: removing 'tool-calls' from
  // PROVEN_MEMBERS left this file fully green before these cases existed.
  test.each(['tool-calls', 'max-tokens'] as const)(
    "a session-scoped runtime.error is superseded by a later turn.completed with finishReason '%s'",
    (finishReason) => {
      const threadId = `session-scoped-proven-${finishReason}`;
      store.appendEvent({
        eventId: `${threadId}-error`,
        provider: 'codex',
        threadId,
        createdAt: '2026-08-01T21:00:00.000Z',
        method: 'runtime.error',
        severity: 'error',
        message: 'transport closed',
        retriable: false,
      });
      store.appendEvent({
        eventId: `${threadId}-turn-started`,
        provider: 'codex',
        threadId,
        turnId: 'turn-1',
        createdAt: '2026-08-01T21:00:01.000Z',
        method: 'turn.started',
        prompt: 'retry',
      });
      store.appendEvent({
        eventId: `${threadId}-turn-completed`,
        provider: 'codex',
        threadId,
        turnId: 'turn-1',
        createdAt: '2026-08-01T21:00:02.000Z',
        method: 'turn.completed',
        finishReason,
      });

      expect(
        store
          .listSessionProjectionEvents(threadId)
          .map((event) => event.payload.eventId),
      ).not.toContain(`${threadId}-error`);
    },
  );

  // archive#3485 review HIGH 2: supersession is an ALLOWLIST
  // (PROVIDER_PROVEN_FINISH_REASONS — the same set, and deliberately the
  // same single decision point, as auth-health clearing; archive#3509
  // rejected the exclusion-list shape for this question as fail-open).
  // `'other'` means "we do not know" (archive#3545) and an ABSENT
  // finishReason asserts nothing — neither positively proves the session
  // works, so both fail closed and the error stays. These two tests are
  // what forces the next person who widens the allowlist to see this
  // consumer's stake in the decision.
  test("a session-scoped runtime.error survives a later turn.completed with finishReason 'other'", () => {
    const threadId = 'session-scoped-then-other';
    store.appendEvent({
      eventId: 'other-transport-error',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-01T19:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'transport closed',
      retriable: false,
    });
    store.appendEvent({
      eventId: 'other-turn-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T19:00:01.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    store.appendEvent({
      eventId: 'other-turn-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T19:00:02.000Z',
      method: 'turn.completed',
      finishReason: 'other',
    });

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload.eventId),
    ).toContain('other-transport-error');
  });

  test('a session-scoped runtime.error survives a later turn.completed with no finishReason', () => {
    const threadId = 'session-scoped-then-reasonless';
    store.appendEvent({
      eventId: 'reasonless-transport-error',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-01T20:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'transport closed',
      retriable: false,
    });
    store.appendEvent({
      eventId: 'reasonless-turn-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T20:00:01.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    store.appendEvent({
      eventId: 'reasonless-turn-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T20:00:02.000Z',
      method: 'turn.completed',
    } as any);

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload.eventId),
    ).toContain('reasonless-transport-error');
  });

  // archive#3485 boundary: `turn.aborted` proves only that a stop was
  // processed. The error stays.
  test('a session-scoped runtime.error survives a later turn.aborted', () => {
    const threadId = 'session-scoped-then-aborted';
    store.appendEvent({
      eventId: 'abort-transport-error',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-01T17:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'transport closed',
      retriable: false,
    });
    store.appendEvent({
      eventId: 'abort-turn-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T17:00:01.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    store.appendEvent({
      eventId: 'abort-turn-aborted',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T17:00:02.000Z',
      method: 'turn.aborted',
      reason: 'user-stop',
    });

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload.eventId),
    ).toContain('abort-transport-error');
  });

  // archive#3485 ordering boundary: supersession is strictly sequenced. An
  // error arriving AFTER the session's last completed turn describes the
  // session NOW; the earlier completion proves nothing about it.
  test('a session-scoped runtime.error after the last completed turn is retained', () => {
    const threadId = 'completed-then-session-scoped';
    store.appendEvent({
      eventId: 'late-turn-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T18:00:00.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    store.appendEvent({
      eventId: 'late-turn-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-01T18:00:01.000Z',
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'Done.',
    });
    store.appendEvent({
      eventId: 'late-transport-error',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-01T18:00:02.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'transport closed',
      retriable: false,
    });
    // A trailing lifecycle event, so the single `LIFECYCLE_METHODS` slot
    // holds THIS row rather than the error — without it the error is the
    // thread's newest lifecycle event and that slot retains it no matter
    // what the supersession rule decides, and this test proves nothing
    // about the ordering clause (measured: neutralizing `sequence > ?`
    // left the un-trailed variant green).
    store.appendEvent({
      eventId: 'late-errored-idle',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-01T18:00:03.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'errored',
      to: 'idle',
    });

    expect(
      store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload.eventId),
    ).toContain('late-transport-error');
  });

  test('folds immutable fork facts in both directions without writing', () => {
    store.appendEvent({
      eventId: 'fork-1',
      provider: 'station',
      threadId: 'file-source',
      createdAt: '2026-08-11T00:00:00.000Z',
      method: 'conversation.forked',
      sourceConversationId: 'file-source',
      targetConversationId: 'native-target',
      targetAgent: 'codex',
      forkedAt: '2026-08-11T00:00:00.000Z',
    });
    const rowsBeforeRead = store.listEvents('file-source').length;

    expect(store.readConversationForkProvenance('native-target')).toEqual({
      forkedFrom: {
        sourceConversationId: 'file-source',
        targetConversationId: 'native-target',
        targetAgent: 'codex',
        forkedAt: '2026-08-11T00:00:00.000Z',
      },
      forkedTo: [],
    });
    expect(
      store.readConversationForkProvenance('file-source').forkedTo,
    ).toHaveLength(1);
    expect(store.listEvents('file-source')).toHaveLength(rowsBeforeRead);
  });

  test('batches fork provenance for an inventory page with one query and matches individual folds', () => {
    for (const [eventId, sourceConversationId, targetConversationId] of [
      ['fork-1', 'source', 'target-a'],
      ['fork-2', 'source', 'target-b'],
      ['fork-3', 'other', 'target-a'],
    ] as const) {
      store.appendEvent({
        eventId,
        provider: 'station',
        threadId: sourceConversationId,
        createdAt: '2026-08-11T00:00:00.000Z',
        method: 'conversation.forked',
        sourceConversationId,
        targetConversationId,
        targetAgent: 'codex',
        forkedAt: '2026-08-11T00:00:00.000Z',
      });
    }
    const ids = ['source', 'target-a', 'target-b'];
    const expected = new Map(
      ids.map((id) => [id, store.readConversationForkProvenance(id)]),
    );
    const prepare = vi.spyOn((store as any).db, 'prepare');

    const actual = store.readConversationForkProvenanceBatch(ids);

    expect(actual).toEqual(expected);
    expect(prepare).toHaveBeenCalledOnce();
  });

  test('idempotently ignores an existing event when requested', () => {
    const event = {
      eventId: 'evt-idempotent',
      provider: 'claude' as const,
      threadId: 'thread-idempotent',
      createdAt: '2026-03-28T00:00:00.000Z',
      method: 'content.text-delta' as const,
      itemId: 'item-1',
      delta: 'hello',
    };

    expect(store.appendEventIfAbsent(event)).toBe(1);
    expect(store.appendEventIfAbsent(event)).toBeUndefined();
    expect(store.listEvents(event.threadId)).toHaveLength(1);
  });

  test('reads a stable, bounded owner, tenant, and agent history page without materializing global session or event state', () => {
    const base = '2026-08-08T12:00:00.000Z';
    const sessions = [
      ['thread-newest', '2026-08-08T12:03:00.000Z'],
      ['thread-middle', '2026-08-08T12:02:00.000Z'],
      ['thread-oldest', '2026-08-08T12:01:00.000Z'],
    ] as const;
    for (const [threadId, updatedAt] of sessions) {
      store.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        tenantExecutionContext: { tenantId: 'alpha' as any, source: 'session' },
        createdAt: base,
        updatedAt,
      });
      store.appendEvent({
        eventId: `${threadId}-started`,
        provider: 'claude',
        threadId,
        createdAt: updatedAt,
        method: 'session.started',
        sessionId: threadId,
        metadata: { userId: 'owner-alpha', agentSlug: 'claude' },
      });
    }
    store.upsertSession({
      provider: 'claude',
      threadId: 'thread-bravo',
      status: 'ready',
      tenantExecutionContext: { tenantId: 'bravo' as any, source: 'session' },
      createdAt: base,
      updatedAt: '2026-08-08T12:04:00.000Z',
    });
    store.appendEvent({
      eventId: 'thread-bravo-started',
      provider: 'claude',
      threadId: 'thread-bravo',
      createdAt: '2026-08-08T12:04:00.000Z',
      method: 'session.started',
      sessionId: 'thread-bravo',
      metadata: { userId: 'owner-alpha', agentSlug: 'claude' },
    });

    const readSessions = vi.spyOn(store, 'readSessions');
    const listEvents = vi.spyOn(store, 'listEvents');
    const first = store.listConversationHistoryPage({
      ownerUserId: 'owner-alpha',
      tenantId: 'alpha',
      agentSlug: 'claude',
      limit: 2,
    });

    expect(first.records.map((record) => record.threadId)).toEqual([
      'thread-newest',
      'thread-middle',
    ]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({
      updatedAt: '2026-08-08T12:02:00.000Z',
      threadId: 'thread-middle',
    });
    expect(readSessions).not.toHaveBeenCalled();
    expect(listEvents).not.toHaveBeenCalled();

    const second = store.listConversationHistoryPage({
      ownerUserId: 'owner-alpha',
      tenantId: 'alpha',
      agentSlug: 'claude',
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.records.map((record) => record.threadId)).toEqual([
      'thread-oldest',
    ]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();

    const database = new DatabaseSync(join(dir, 'orchestration.sqlite'));
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT thread_id FROM orchestration_conversation_history
         WHERE tenant_id = ? AND owner_user_id = ? AND agent_slug = ?
           AND agent_slug IS NOT NULL
         ORDER BY updated_at DESC, thread_id DESC LIMIT ?`,
      )
      .all('alpha', 'owner-alpha', 'claude', 3) as Array<{ detail: string }>;
    const ownerlessPlan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT thread_id FROM orchestration_conversation_history
         WHERE owner_user_id IS NULL AND agent_slug = ?
         ORDER BY updated_at DESC, thread_id DESC LIMIT ?`,
      )
      .all('claude', 3) as Array<{ detail: string }>;
    database.close();
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toContain(
      'idx_conversation_history_bound_tenant_owner_agent_recency',
    );
    expect(detail).not.toContain('TEMP B-TREE');
    const ownerlessDetail = ownerlessPlan.map((row) => row.detail).join(' | ');
    expect(ownerlessDetail).toContain(
      'idx_conversation_history_ownerless_agent_recency',
    );
    expect(ownerlessDetail).not.toContain('TEMP B-TREE');
  });

  /**
   * archive#3386. `snapshotEvent` has two budgets and both used to fire
   * silently: an oversized payload came back as identity fields alone, and a
   * tool result came back cut to 84 characters. A client that receives a
   * `turn.started` with no prompt cannot tell it from a turn that never had
   * one, or from a blob retention reclaimed — which is why a pasted image
   * over ~3 KB lost its prompt AND its chip on restore (archive#3374).
   */
  describe('bounded-read elision labels (station#3386)', () => {
    const threadId = 'thread-elision';
    const startedAt = '2026-08-19T03:00:00.000Z';
    const startTurn = (turnId: string, prompt: string) => {
      store.appendEvent({
        eventId: `${turnId}-start`,
        provider: 'codex',
        threadId,
        turnId,
        createdAt: startedAt,
        method: 'turn.started',
        prompt,
      });
    };
    const completeTool = (turnId: string, output: string) => {
      store.appendEvent({
        eventId: `${turnId}-complete`,
        provider: 'codex',
        threadId,
        turnId,
        createdAt: '2026-08-19T03:00:01.000Z',
        method: 'tool.completed',
        toolCallId: 'tool-1',
        output,
      } as any);
    };
    const windowEvent = (eventId: string) => {
      const found = store
        .listEventWindowByTurn(threadId, { turnLimit: 1 })
        .events.find((item) => item.id === eventId);
      if (!found) throw new Error(`window omitted ${eventId}`);
      return found;
    };

    test('labels a payload stripped by the serialized ceiling byte_limit', () => {
      // Comfortably past the 4 KB per-event ceiling, and nothing else about
      // it is unusual — this is the shape a long prompt or an inline
      // attachment produces.
      startTurn('turn-big', 'p'.repeat(8_000));
      const started = windowEvent('turn-big-start');

      expect(started.elided).toBe('byte_limit');
      // The label is not decoration: the fields it accounts for really are
      // gone from this read.
      expect((started.payload as { prompt?: string }).prompt).toBeUndefined();
      expect(started.payload.eventId).toBe('turn-big-start');
    });

    test('labels a cut tool result output_limit and leaves the rest of the payload alone', () => {
      startTurn('turn-tool', 'small');
      completeTool('turn-tool', 'o'.repeat(500));
      const completed = windowEvent('turn-tool-complete');

      expect(completed.elided).toBe('output_limit');
      expect((completed.payload as { output?: string }).output).toHaveLength(
        84,
      );
      // Narrower than byte_limit, and the difference is observable: the
      // identity-strip would have taken `toolCallId` with everything else.
      expect((completed.payload as { toolCallId?: string }).toolCallId).toBe(
        'tool-1',
      );
    });

    test('says nothing about an event it returned whole', () => {
      startTurn('turn-small', 'small');
      completeTool('turn-small', 'short output');

      // The negative control the label depends on. If `elided` were present
      // here, its presence elsewhere would mean nothing.
      expect(windowEvent('turn-small-start').elided).toBeUndefined();
      expect(windowEvent('turn-small-complete').elided).toBeUndefined();
    });

    /**
     * archive#3427. `error` used a truthiness guard while `output` checked
     * `=== undefined`, so a tool that failed with an empty-string error
     * silently lost it from the snapshot while an empty-string output
     * survived. An empty error is a fact about the run (it failed, with no
     * message) — the same meaningful-absence-of-text case an empty output
     * already preserves — so both fields must round-trip it identically.
     */
    test('preserves an empty-string error the same way it preserves an empty-string output', () => {
      startTurn('turn-empty-error', 'small');
      store.appendEvent({
        eventId: 'turn-empty-error-complete',
        provider: 'codex',
        threadId,
        turnId: 'turn-empty-error',
        createdAt: '2026-08-19T03:00:01.000Z',
        method: 'tool.completed',
        toolCallId: 'tool-1',
        error: '',
      } as any);

      const completed = windowEvent('turn-empty-error-complete');

      expect(completed.elided).toBeUndefined();
      expect((completed.payload as { error?: string }).error).toBe('');
    });

    test('preserves an empty-string output (the existing, unchanged behavior)', () => {
      startTurn('turn-empty-output', 'small');
      completeTool('turn-empty-output', '');

      const completed = windowEvent('turn-empty-output-complete');

      expect(completed.elided).toBeUndefined();
      expect((completed.payload as { output?: string }).output).toBe('');
    });

    /**
     * Independent-review finding 1 (round 2): the `=== undefined` guard the
     * fix above lands on FIXES the empty-string case, but a straight
     * `sliceSnapshotText(payload.error)` — `String(value)` — COERCES any
     * other non-undefined falsy value. Read as `Record<string, unknown>`
     * (this is persisted JSON, not the `string | undefined` contract type),
     * `error` can genuinely be `null`. Coercing it would fabricate the
     * four-character string `"null"` — a non-empty error message where the
     * producer sent none — the exact regression this fix must not
     * reintroduce. The intended answer: a non-string `error` passes through
     * completely unchanged, exactly as it was sent.
     */
    test('does not coerce a non-string error (null) into the text "null"', () => {
      startTurn('turn-null-error', 'small');
      store.appendEvent({
        eventId: 'turn-null-error-complete',
        provider: 'codex',
        threadId,
        turnId: 'turn-null-error',
        createdAt: '2026-08-19T03:00:01.000Z',
        method: 'tool.completed',
        toolCallId: 'tool-1',
        error: null,
      } as any);

      const completed = windowEvent('turn-null-error-complete');

      expect(completed.elided).toBeUndefined();
      expect((completed.payload as { error?: unknown }).error).toBeNull();
    });

    /**
     * The marker tells ONE reader about ONE event. Without this counter the
     * only honest answer to "is the 4 KB ceiling a rare edge or a routine
     * amputation of restored transcripts?" is that nobody knows — and a
     * counter no test exercises is the same as no counter.
     */
    test('counts what it withheld, by reason', () => {
      vi.mocked(orchestrationEventWindowElisions.add).mockClear();
      startTurn('turn-counted', 'p'.repeat(8_000));

      store.listEventWindowByTurn(threadId, { turnLimit: 1 });

      expect(orchestrationEventWindowElisions.add).toHaveBeenCalledWith(1, {
        reason: 'byte_limit',
      });
    });

    test('counts nothing for a window it returned whole', () => {
      vi.mocked(orchestrationEventWindowElisions.add).mockClear();
      startTurn('turn-uncounted', 'small');

      store.listEventWindowByTurn(threadId, { turnLimit: 1 });

      expect(orchestrationEventWindowElisions.add).not.toHaveBeenCalled();
    });

    test('reports byte_limit, not output_limit, when both budgets fire on one event', () => {
      // A tool result whose output is cut to 84 chars AND whose remaining
      // payload still blows the ceiling. Naming the narrower budget would
      // understate what the read withheld — the cut field is gone with
      // everything else.
      store.appendEvent({
        eventId: 'turn-both-start',
        provider: 'codex',
        threadId,
        turnId: 'turn-both',
        createdAt: startedAt,
        method: 'turn.started',
        prompt: 'small',
      });
      store.appendEvent({
        eventId: 'turn-both-complete',
        provider: 'codex',
        threadId,
        turnId: 'turn-both',
        createdAt: '2026-08-19T03:00:01.000Z',
        method: 'tool.completed',
        toolCallId: 'tool-1',
        output: 'o'.repeat(500),
        args: { padding: 'z'.repeat(8_000) },
      } as any);
      const completed = windowEvent('turn-both-complete');

      expect(completed.elided).toBe('byte_limit');
      expect(
        (completed.payload as { toolCallId?: string }).toolCallId,
      ).toBeUndefined();
    });
  });

  /**
   * archive#3462. `snapshotEvent`'s `output` handling used a bare
   * `String(value)` coercion, so a persisted `output: null` read back as the
   * four-character string `"null"` and a structured result read back as
   * `"[object Object]"` — the same fabrication archive#3427 fixed for `error`, left
   * out of that fix's scope because `output` is contract-typed `unknown` and
   * real producers legitimately send non-strings
   * (`claude-transcript-session-source.ts`'s `output: raw.content`). Every
   * shape is pinned here through the real persist-and-read-back path
   * (`appendEvent` → `listEventWindowByTurn`), not just the write side —
   * that's exactly what made the `error` case reachable in the first place.
   */
  describe('tool.completed output shape preservation through the window read (station#3462)', () => {
    const threadId = 'thread-output-shapes';
    const startTurn = (turnId: string) => {
      store.appendEvent({
        eventId: `${turnId}-start`,
        provider: 'codex',
        threadId,
        turnId,
        createdAt: '2026-08-19T04:00:00.000Z',
        method: 'turn.started',
        prompt: 'small',
      });
    };
    const completeWithOutput = (turnId: string, output: unknown) => {
      store.appendEvent({
        eventId: `${turnId}-complete`,
        provider: 'codex',
        threadId,
        turnId,
        createdAt: '2026-08-19T04:00:01.000Z',
        method: 'tool.completed',
        toolCallId: 'tool-1',
        output,
      } as any);
    };
    const windowEvent = (eventId: string) => {
      const found = store
        .listEventWindowByTurn(threadId, { turnLimit: 1 })
        .events.find((item) => item.id === eventId);
      if (!found) throw new Error(`window omitted ${eventId}`);
      return found;
    };

    test('omits output entirely when it was never sent (undefined)', () => {
      startTurn('turn-undefined');
      store.appendEvent({
        eventId: 'turn-undefined-complete',
        provider: 'codex',
        threadId,
        turnId: 'turn-undefined',
        createdAt: '2026-08-19T04:00:01.000Z',
        method: 'tool.completed',
        toolCallId: 'tool-1',
      } as any);

      const completed = windowEvent('turn-undefined-complete');

      expect(completed.elided).toBeUndefined();
      expect('output' in (completed.payload as object)).toBe(false);
    });

    test('preserves a null output as null, not the fabricated text "null"', () => {
      startTurn('turn-null');
      completeWithOutput('turn-null', null);

      const completed = windowEvent('turn-null-complete');

      expect(completed.elided).toBeUndefined();
      expect((completed.payload as { output?: unknown }).output).toBeNull();
    });

    test('renders a number output as its JSON text', () => {
      startTurn('turn-number');
      completeWithOutput('turn-number', 42);

      const completed = windowEvent('turn-number-complete');

      expect(completed.elided).toBeUndefined();
      expect((completed.payload as { output?: unknown }).output).toBe('42');
    });

    test('renders a boolean output as its JSON text', () => {
      startTurn('turn-boolean');
      completeWithOutput('turn-boolean', false);

      const completed = windowEvent('turn-boolean-complete');

      expect(completed.elided).toBeUndefined();
      expect((completed.payload as { output?: unknown }).output).toBe('false');
    });

    test('passes a string output through unchanged, without JSON-quoting it', () => {
      startTurn('turn-string');
      completeWithOutput('turn-string', 'plain text result');

      const completed = windowEvent('turn-string-complete');

      expect(completed.elided).toBeUndefined();
      expect((completed.payload as { output?: unknown }).output).toBe(
        'plain text result',
      );
    });

    test('JSON-serialises an array output instead of coercing it to a fixed string', () => {
      startTurn('turn-array');
      completeWithOutput('turn-array', [1, 'two', null]);

      const completed = windowEvent('turn-array-complete');

      expect(completed.elided).toBeUndefined();
      expect((completed.payload as { output?: unknown }).output).toBe(
        JSON.stringify([1, 'two', null]),
      );
    });

    test('JSON-serialises a nested object output instead of "[object Object]"', () => {
      startTurn('turn-object');
      const structured = {
        status: 'ok',
        detail: { code: 7, tags: ['a', 'b'] },
      };
      completeWithOutput('turn-object', structured);

      const completed = windowEvent('turn-object-complete');

      expect(completed.elided).toBeUndefined();
      expect((completed.payload as { output?: unknown }).output).toBe(
        JSON.stringify(structured),
      );
      expect((completed.payload as { output?: unknown }).output).not.toBe(
        '[object Object]',
      );
    });

    test('cuts a serialised object past the 84-char ceiling and labels output_limit', () => {
      startTurn('turn-object-big');
      const structured = { data: 'x'.repeat(500) };
      completeWithOutput('turn-object-big', structured);

      const completed = windowEvent('turn-object-big-complete');

      expect(completed.elided).toBe('output_limit');
      const output = (completed.payload as { output?: string }).output;
      expect(output).toHaveLength(84);
      expect(output).toBe(JSON.stringify(structured).slice(0, 84));
    });
  });

  test('reads newest user-turn windows with a tied timestamp cursor and prunes retained tool output', () => {
    const threadId = 'thread-window';
    const at = '2026-08-09T02:00:00.000Z';
    store.appendEvent({
      eventId: 'turn-a-start',
      provider: 'codex',
      threadId,
      turnId: 'turn-a',
      createdAt: at,
      method: 'turn.started',
      prompt: 'older',
    });
    store.appendEvent({
      eventId: 'turn-b-start',
      provider: 'codex',
      threadId,
      turnId: 'turn-b',
      createdAt: at,
      method: 'turn.started',
      prompt: 'newer',
    });
    store.appendEvent({
      eventId: 'turn-b-progress',
      provider: 'codex',
      threadId,
      turnId: 'turn-b',
      createdAt: '2026-08-09T02:00:01.000Z',
      method: 'tool.progress',
      toolCallId: 'tool-1',
    } as any);
    store.appendEvent({
      eventId: 'turn-b-complete',
      provider: 'codex',
      threadId,
      turnId: 'turn-b',
      createdAt: '2026-08-09T02:00:02.000Z',
      method: 'tool.completed',
      toolCallId: 'tool-1',
      // The ACP ingress ceiling rejects a megabyte before this read-side
      // window can project it. This remains far above the 84-char window
      // output limit while staying below that ingress boundary.
      output: 'x'.repeat(60_000),
    } as any);

    const newest = store.listEventWindowByTurn(threadId, { turnLimit: 1 });
    expect(newest.hasMore).toBe(true);
    expect(newest.nextCursor).toBeDefined();
    expect(newest.watermark).toBe(4);
    expect(newest.events.map((item) => item.id)).toContain('turn-b-complete');
    expect(newest.events.map((item) => item.id)).not.toContain(
      'turn-b-progress',
    );
    const completed = newest.events.find(
      (item) => item.id === 'turn-b-complete',
    );
    if (!completed) throw new Error('window omitted completed tool event');
    expect((completed.payload as { output?: string }).output).toHaveLength(84);
    const httpEnvelopeBytes = Buffer.byteLength(
      JSON.stringify({ success: true, data: newest }),
    );
    const streamFrameBytes = Buffer.byteLength(
      JSON.stringify({ event: 'orchestration:snapshot', data: newest }),
    );
    expect(httpEnvelopeBytes).toBeLessThan(64_000);
    expect(streamFrameBytes).toBeLessThan(64_000);

    const older = store.listEventWindowByTurn(threadId, {
      cursor: newest.nextCursor,
      turnLimit: 1,
    });
    expect(older.events.map((item) => item.id)).toContain('turn-a-start');
    expect(older.events.map((item) => item.id)).not.toContain('turn-b-start');

    const malformed = store.listEventWindowByTurn(threadId, {
      cursor: 'not-a-window-cursor',
      turnLimit: 1,
    });
    const foreign = store.listEventWindowByTurn(threadId, {
      cursor: Buffer.from(
        JSON.stringify({
          threadId: 'other-thread',
          createdAt: at,
          turnId: 'turn-b',
        }),
      ).toString('base64url'),
      turnLimit: 1,
    });
    expect(malformed.events.map((item) => item.id)).toEqual(
      newest.events.map((item) => item.id),
    );
    expect(foreign.events.map((item) => item.id)).toEqual(
      newest.events.map((item) => item.id),
    );
  });

  test('pages a three-session conversation by global order without child-sequence collisions or duplicates', () => {
    const sessionIds = [
      'conversation-root',
      'conversation-child-1',
      'conversation-child-2',
    ];
    for (const [index, threadId] of sessionIds.entries()) {
      const turnId = `turn-${index}`;
      store.appendEvent({
        eventId: `${turnId}-started`,
        provider: 'codex',
        threadId,
        turnId,
        createdAt: `2026-08-24T00:00:0${index}.000Z`,
        method: 'turn.started',
        prompt: `question ${index}`,
      });
      store.appendEvent({
        eventId: `${turnId}-completed`,
        provider: 'codex',
        threadId,
        turnId,
        createdAt: `2026-08-24T00:00:1${index}.000Z`,
        method: 'turn.completed',
        outputText: `answer ${index}`,
      });
    }

    const first = store.listConversationEventWindowByTurn(sessionIds, {
      turnLimit: 1,
    });
    const second = store.listConversationEventWindowByTurn(sessionIds, {
      cursor: first.nextCursor,
      turnLimit: 1,
    });
    const third = store.listConversationEventWindowByTurn(sessionIds, {
      cursor: second.nextCursor,
      turnLimit: 1,
    });
    const received = [...first.events, ...second.events, ...third.events];

    expect(first.watermark).toBe(second.watermark);
    expect(second.watermark).toBe(third.watermark);
    expect(received.map((event) => event.threadId)).toEqual([
      'conversation-child-2',
      'conversation-child-2',
      'conversation-child-1',
      'conversation-child-1',
      'conversation-root',
      'conversation-root',
    ]);
    expect(new Set(received.map((event) => event.id)).size).toBe(
      received.length,
    );
    const merged = [...received].sort(
      (left, right) => left.globalSequence - right.globalSequence,
    );
    expect(merged.map((event) => event.globalSequence)).toEqual(
      [...merged.map((event) => event.globalSequence)].sort((a, b) => a - b),
    );
  });

  test('continues inside an oversized selected turn instead of skipping truncated events', () => {
    const threadId = 'conversation-oversized-turn';
    store.appendEvent({
      eventId: 'older-start',
      provider: 'codex',
      threadId,
      turnId: 'older-turn',
      createdAt: '2026-08-24T00:00:59.000Z',
      method: 'turn.started',
      prompt: 'older turn',
    });
    store.appendEvent({
      eventId: 'oversized-start',
      provider: 'codex',
      threadId,
      turnId: 'oversized-turn',
      createdAt: '2026-08-24T00:01:00.000Z',
      method: 'turn.started',
      prompt: 'one large turn',
    });
    for (let index = 0; index < 151; index += 1) {
      store.appendEvent({
        eventId: `oversized-delta-${index}`,
        provider: 'codex',
        threadId,
        turnId: 'oversized-turn',
        createdAt: '2026-08-24T00:01:01.000Z',
        method: 'content.text-delta',
        itemId: `item-${index}`,
        delta: String(index),
      });
    }

    const first = store.listConversationEventWindowByTurn([threadId], {
      turnLimit: 1,
    });
    const second = store.listConversationEventWindowByTurn([threadId], {
      cursor: first.nextCursor,
      turnLimit: 1,
    });
    const third = store.listConversationEventWindowByTurn([threadId], {
      cursor: second.nextCursor,
      turnLimit: 1,
    });
    const all = [...first.events, ...second.events, ...third.events];

    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
    expect(all).toHaveLength(153);
    expect(new Set(all.map((event) => event.id)).size).toBe(153);
    expect(third.events.map((event) => event.id)).toEqual(['older-start']);
  });

  test('keeps paging the original lineage prefix when a later child is appended', () => {
    const root = 'conversation-late-root';
    const child = 'conversation-late-child';
    for (const threadId of [root, child]) {
      store.appendEvent({
        eventId: `${threadId}-start`,
        provider: 'codex',
        threadId,
        turnId: `${threadId}-turn`,
        createdAt: '2026-08-24T00:02:00.000Z',
        method: 'turn.started',
        prompt: threadId,
      });
    }
    const first = store.listConversationEventWindowByTurn([root, child], {
      turnLimit: 1,
    });
    // New head work is deliberately not injected into this old cursor's
    // history page; a normal head reload will observe it separately.
    store.appendEvent({
      eventId: 'conversation-late-new-child-start',
      provider: 'codex',
      threadId: 'conversation-late-new-child',
      turnId: 'late-child-turn',
      createdAt: '2026-08-24T00:02:01.000Z',
      method: 'turn.started',
      prompt: 'new child',
    });
    const older = store.listConversationEventWindowByTurn(
      [root, child, 'conversation-late-new-child'],
      { cursor: first.nextCursor, turnLimit: 1 },
    );

    expect(older.events.map((event) => event.threadId)).toEqual([root]);
    expect(older.events.map((event) => event.id)).not.toContain(
      'conversation-late-new-child-start',
    );
  });

  test('preflights the exact UTF-8 replay frame with a persisted provenance sidecar without reading payloads', () => {
    const threadId = 'thread-replay-sidecar-bytes';
    const event = {
      eventId: 'sidecar-completed',
      provider: 'claude',
      threadId,
      turnId: 'turn-sidecar-bytes',
      createdAt: '2026-08-09T03:00:00.000Z',
      method: 'turn.completed',
    } as any;
    store.appendEvent(event);
    const provenance = {
      envelopeVersion: 1,
      sessionId: threadId,
      turnId: 'turn-sidecar-bytes',
      // The emoji makes character-count accounting observably wrong.
      note: '😀'.repeat(16_000),
    } as any;
    store.upsertTurnProvenance(provenance);

    const db = (store as any).db;
    const prepare = vi.spyOn(db, 'prepare');
    const [descriptor] = store.listEventReplayDescriptors(0, {
      threadId,
      limit: 1,
    });
    expect(descriptor?.serializedFrameBytes).toBe(
      Buffer.byteLength(JSON.stringify({ event, provenance })),
    );
    expect(descriptor?.serializedFrameBytes).toBeGreaterThan(64_000);
    expect(prepare.mock.calls.map(([sql]) => String(sql)).join('\n')).toContain(
      'LENGTH(CAST(e.payload AS BLOB))',
    );
    expect(
      prepare.mock.calls.map(([sql]) => String(sql)).join('\n'),
    ).not.toContain('SELECT id, provider, thread_id, turn_id, method, payload');
  });

  test('uses one transaction, a has-more probe, and a capped turn fan-out', () => {
    const threadId = 'thread-fan-out';
    store.appendEvent({
      eventId: 'fan-out-start',
      provider: 'codex',
      threadId,
      turnId: 'turn-new',
      createdAt: '2026-08-09T03:00:00.000Z',
      method: 'turn.started',
    } as any);
    for (let index = 0; index < 200; index += 1) {
      store.appendEvent({
        eventId: `fan-out-${index}`,
        provider: 'codex',
        threadId,
        turnId: 'turn-new',
        createdAt: `2026-08-09T03:00:${String(index % 60).padStart(2, '0')}.000Z`,
        method: 'content.text-delta',
        delta: String(index),
      } as any);
    }
    store.appendEvent({
      eventId: 'fan-out-older-start',
      provider: 'codex',
      threadId,
      turnId: 'turn-old',
      createdAt: '2026-08-09T02:00:00.000Z',
      method: 'turn.started',
    } as any);
    const db = (store as any).db;
    const exec = vi.spyOn(db, 'exec');

    const first = store.listEventWindowByTurn(threadId, { turnLimit: 1 });
    const second = store.listEventWindowByTurn(threadId, {
      cursor: first.nextCursor,
      turnLimit: 1,
    });
    const third = store.listEventWindowByTurn(threadId, {
      cursor: second.nextCursor,
      turnLimit: 1,
    });
    const ids = [...first.events, ...second.events, ...third.events].map(
      (item) => item.id,
    );

    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();
    expect(first.events).toHaveLength(150);
    expect(second.events).toHaveLength(51);
    expect(third.events.map((item) => item.id)).toEqual([
      'fan-out-older-start',
    ]);
    expect(new Set(ids)).toHaveLength(ids.length);
    expect(ids).toContain('fan-out-199');
    expect(ids).toContain('fan-out-older-start');
    expect(exec.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'COMMIT',
      'BEGIN',
      'COMMIT',
      'BEGIN',
      'COMMIT',
    ]);
  });

  test('orders tied user turns by turn id instead of append sequence', () => {
    const threadId = 'thread-tie-order';
    for (const turnId of ['turn-z', 'turn-a']) {
      store.appendEvent({
        eventId: `${turnId}-start`,
        provider: 'codex',
        threadId,
        turnId,
        createdAt: '2026-08-09T03:00:00.000Z',
        method: 'turn.started',
      } as any);
    }

    const page = store.listEventWindowByTurn(threadId, { turnLimit: 1 });

    expect(page.events.map((item) => item.turnId)).toEqual(['turn-z']);
    expect(page.hasMore).toBe(true);
  });

  test('caps aggregate window bytes while every retained event remains traversable', () => {
    const threadId = 'thread-window-bytes';
    for (let turn = 0; turn < 20; turn += 1) {
      const turnId = `turn-${String(turn).padStart(2, '0')}`;
      store.appendEvent({
        eventId: `${turnId}-start`,
        provider: 'codex',
        threadId,
        turnId,
        createdAt: `2026-08-09T03:${String(turn).padStart(2, '0')}:00.000Z`,
        method: 'turn.started',
      } as any);
      for (let event = 0; event < 50; event += 1) {
        store.appendEvent({
          eventId: `${turnId}-${event}`,
          provider: 'codex',
          threadId,
          turnId,
          createdAt: `2026-08-09T03:${String(turn).padStart(2, '0')}:${String(event % 60).padStart(2, '0')}.000Z`,
          method: 'content.text-delta',
          delta: 'x'.repeat(2_048),
        } as any);
      }
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = store.listEventWindowByTurn(threadId, {
        cursor,
        turnLimit: 20,
      });
      expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThan(
        64_000,
      );
      ids.push(...page.events.map((item) => item.id));
      cursor = page.nextCursor;
      if (cursor) expect(cursor.length).toBeLessThanOrEqual(512);
    } while (cursor);

    expect(new Set(ids)).toHaveLength(1_020);
  });

  test('backfills bounded history title and message count from persisted events', () => {
    store.close();
    const databasePath = join(dir, 'pre-ownership-history.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    database
      .prepare(
        `INSERT INTO provider_session_state
          (thread_id, provider, status, tenant_execution_context, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'thread-backfilled',
        'claude',
        'ready',
        JSON.stringify({ tenantId: 'alpha', source: 'session' }),
        '2026-08-08T11:00:00.000Z',
        '2026-08-08T12:00:00.000Z',
      );
    const insertEvent = database.prepare(
      `INSERT INTO orchestration_events
        (id, provider, thread_id, method, payload, created_at, sequence, global_sequence)
       VALUES (?, 'claude', 'thread-backfilled', ?, ?, ?, ?, ?)`,
    );
    insertEvent.run(
      'backfilled-start',
      'session.started',
      JSON.stringify({
        method: 'session.started',
        metadata: { userId: 'owner-alpha', agentSlug: 'claude' },
      }),
      '2026-08-08T11:00:00.000Z',
      1,
      1,
    );
    insertEvent.run(
      'backfilled-turn-start',
      'turn.started',
      JSON.stringify({
        method: 'turn.started',
        prompt: 'Accurate history title',
      }),
      '2026-08-08T11:01:00.000Z',
      2,
      2,
    );
    insertEvent.run(
      'backfilled-turn-complete',
      'turn.completed',
      JSON.stringify({ method: 'turn.completed' }),
      '2026-08-08T12:00:00.000Z',
      3,
      3,
    );
    database.close();

    store = new EventStore(databasePath);

    expect(
      store.listConversationHistoryPage({
        ownerUserId: 'owner-alpha',
        tenantId: 'alpha',
        limit: 1,
      }).records,
    ).toEqual([
      expect.objectContaining({
        threadId: 'thread-backfilled',
        title: 'Accurate history title',
        messageCount: 2,
      }),
    ]);
    expect(store.readConversationHistoryUpgrade()).toMatchObject({
      status: 'complete',
      quarantinedCount: 0,
    });
  });

  test('hosted history remains bounded when newer quarantined rows outnumber accepted rows', () => {
    const validAt = '2026-08-08T12:00:00.000Z';
    store.upsertSession({
      provider: 'claude',
      threadId: 'thread-bound',
      status: 'ready',
      tenantExecutionContext: { tenantId: 'alpha' as any, source: 'session' },
      createdAt: validAt,
      updatedAt: validAt,
    });
    store.appendEvent({
      eventId: 'thread-bound-started',
      provider: 'claude',
      threadId: 'thread-bound',
      createdAt: validAt,
      method: 'session.started',
      sessionId: 'thread-bound',
      metadata: { userId: 'owner-alpha', agentSlug: 'claude' },
    });
    for (let index = 0; index < 150; index += 1) {
      const threadId = `thread-quarantined-${index}`;
      const createdAt = new Date(1_754_654_401_000 + index).toISOString();
      store.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        tenantExecutionContext: { tenantId: 'alpha' as any, source: 'session' },
        createdAt,
        updatedAt: createdAt,
      });
      store.appendEvent({
        eventId: `${threadId}-started`,
        provider: 'claude',
        threadId,
        createdAt,
        method: 'session.started',
        sessionId: threadId,
        metadata: { userId: 'owner-alpha' },
      });
    }

    expect(
      store.listConversationHistoryPage({
        ownerUserId: 'owner-alpha',
        tenantId: 'alpha',
        requireBound: true,
        limit: 1,
      }).records,
    ).toEqual([expect.objectContaining({ threadId: 'thread-bound' })]);
  });

  test('upgrades a high-volume thread with bounded payload lookups', () => {
    store.close();
    const databasePath = join(dir, 'high-volume-history.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    database
      .prepare(
        `INSERT INTO provider_session_state
          (thread_id, provider, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'thread-high-volume',
        'claude',
        'ready',
        '2026-08-08T11:00:00.000Z',
        '2026-08-08T12:00:00.000Z',
      );
    const insertEvent = database.prepare(
      `INSERT INTO orchestration_events
        (id, provider, thread_id, method, payload, created_at, sequence, global_sequence)
       VALUES (?, 'claude', 'thread-high-volume', ?, ?, ?, ?, ?)`,
    );
    insertEvent.run(
      'high-volume-owner',
      'session.started',
      JSON.stringify({
        method: 'session.started',
        metadata: { userId: 'owner-alpha', agentSlug: 'claude' },
      }),
      '2026-08-08T11:00:00.000Z',
      1,
      1,
    );
    insertEvent.run(
      'high-volume-title',
      'turn.started',
      JSON.stringify({ method: 'turn.started', prompt: 'Bounded title' }),
      '2026-08-08T11:00:01.000Z',
      2,
      2,
    );
    for (let index = 0; index < 500; index += 1) {
      insertEvent.run(
        `high-volume-noise-${index}`,
        'content.text-delta',
        JSON.stringify({
          method: 'content.text-delta',
          itemId: `item-${index}`,
          delta: 'x'.repeat(2_000),
        }),
        new Date(1_754_654_402_000 + index).toISOString(),
        index + 3,
        index + 3,
      );
    }
    database.close();

    const prepare = vi.spyOn(DatabaseSync.prototype as any, 'prepare');
    store = new EventStore(databasePath);
    const payloadQueries = prepare.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) =>
        sql.includes('SELECT payload FROM orchestration_events'),
      );
    prepare.mockRestore();

    // The bounded project-label upgrade adds its latest metadata lookup and
    // one no-op legacy-label probe. Every projection read remains capped.
    expect(payloadQueries).toHaveLength(5);
    expect(payloadQueries.every((sql) => sql.includes('LIMIT'))).toBe(true);
    expect(payloadQueries.join('\n')).not.toContain("'turn.completed'");
    expect(
      store.listConversationHistoryPage({
        ownerUserId: 'owner-alpha',
        limit: 1,
      }).records,
    ).toEqual([
      expect.objectContaining({
        threadId: 'thread-high-volume',
        title: 'Bounded title',
        messageCount: 1,
      }),
    ]);
  });

  test('keeps the pre-upgrade project repair SQL bind shape fixed across multiple history batches', () => {
    store.close();
    const databasePath = join(dir, 'multi-batch-history.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    const insertSession = database.prepare(
      `INSERT INTO provider_session_state
        (thread_id, provider, status, created_at, updated_at)
       VALUES (?, 'claude', 'ready', ?, ?)`,
    );
    for (let index = 0; index <= 500; index += 1) {
      const createdAt = new Date(1_754_654_400_000 + index).toISOString();
      insertSession.run(`thread-batch-${index}`, createdAt, createdAt);
    }
    database.close();

    const prepare = vi.spyOn(DatabaseSync.prototype as any, 'prepare');
    store = new EventStore(databasePath);
    const repairQueries = prepare.mock.calls
      .map(([sql]) => String(sql))
      .filter(
        (sql) =>
          sql.includes(
            'SELECT thread_id FROM orchestration_conversation_history',
          ) && !sql.includes('FROM provider_session_state'),
      );
    prepare.mockRestore();

    expect(repairQueries).toEqual([
      expect.stringContaining('WHERE project_slug IS NULL'),
    ]);
    expect(repairQueries[0]).toContain('LIMIT ?');
    expect(repairQueries[0]).not.toContain('NOT IN');
  });

  test('backfill retains ownership metadata when later configuration events carry neither field', () => {
    store.close();
    const databasePath = join(dir, 'ownership-history.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    database
      .prepare(
        `INSERT INTO provider_session_state
          (thread_id, provider, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'thread-ownership',
        'claude',
        'ready',
        '2026-08-08T11:00:00.000Z',
        '2026-08-08T12:00:00.000Z',
      );
    const insertEvent = database.prepare(
      `INSERT INTO orchestration_events
        (id, provider, thread_id, method, payload, created_at, sequence, global_sequence)
       VALUES (?, 'claude', 'thread-ownership', ?, ?, ?, ?, ?)`,
    );
    insertEvent.run(
      'ownership-start',
      'session.started',
      JSON.stringify({
        method: 'session.started',
        metadata: { userId: 'owner-alpha', agentSlug: 'claude' },
      }),
      '2026-08-08T11:00:00.000Z',
      1,
      1,
    );
    for (let sequence = 2; sequence <= 4; sequence += 1) {
      insertEvent.run(
        `ownership-configured-${sequence}`,
        'session.configured',
        JSON.stringify({ method: 'session.configured' }),
        `2026-08-08T11:00:0${sequence}.000Z`,
        sequence,
        sequence,
      );
    }
    database.close();

    store = new EventStore(databasePath);
    expect(
      store.listConversationHistoryPage({
        ownerUserId: 'owner-alpha',
        agentSlug: 'claude',
        limit: 1,
      }).records,
    ).toEqual([
      expect.objectContaining({
        threadId: 'thread-ownership',
        ownerUserId: 'owner-alpha',
        agentSlug: 'claude',
      }),
    ]);
  });

  // A cursor consumer may choose a recent window, but that must stay a
  // presentation query. Authoritative projections use the complete,
  // method-targeted query below rather than treating a tail as state.
  test('returns an ordered recent window and an accurate count', () => {
    const threadId = 'thread-1867-wedge';
    const total = 50;
    for (let i = 0; i < total; i += 1) {
      store.appendEvent({
        eventId: `evt-1867-${i}`,
        provider: 'claude',
        threadId,
        createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        method: 'content.text-delta',
        itemId: `item-${i}`,
        delta: `chunk-${i}`,
      });
    }

    // COUNT is accurate without materializing payloads.
    expect(store.countEventsByThread(threadId)).toBe(total);
    expect(store.countEventsByThread('absent-thread')).toBe(0);

    // The tail is bounded and preserves ascending sequence order, and the
    // returned tail is the MOST RECENT events (the ones a snapshot card
    // actually shows), not the oldest.
    const tail = store.listRecentEventsByThread(threadId, 10);
    expect(tail).toHaveLength(10);
    expect(tail.map((event) => event.sequence)).toEqual(
      Array.from({ length: 10 }, (_, index) => total - 10 + index + 1),
    );
    expect(tail.at(-1)?.id).toBe(`evt-1867-${total - 1}`);

    // A limit at least as large as the thread returns every event in the
    // same order as `listEvents`, so realistic sessions are byte-identical.
    const fullTail = store.listRecentEventsByThread(threadId, total + 100);
    expect(fullTail).toHaveLength(total);
    expect(fullTail).toEqual(store.listEvents(threadId));
  });

  test('keeps old governance facts while excluding a 50k transcript from the session projection (station#1867)', () => {
    const threadId = 'thread-1867-projection';
    // Seed the high-volume persisted shape in ONE explicit SQLite
    // transaction. Individual EventStore appends intentionally perform their
    // own durable projection work; using them 50k times here measures writes,
    // not the bounded projection read this regression protects.
    store.close();
    const databasePath = join(dir, 'projection-50k.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    const insert = database.prepare(
      `INSERT INTO orchestration_events
        (id, provider, thread_id, method, payload, created_at, sequence, global_sequence)
       VALUES (?, 'claude', ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = (
      id: string,
      method: string,
      payload: Record<string, unknown>,
      sequence: number,
      createdAt: string,
    ) =>
      insert.run(
        id,
        threadId,
        method,
        JSON.stringify(payload),
        createdAt,
        sequence,
        sequence,
      );
    database.exec('BEGIN IMMEDIATE');
    try {
      insertEvent(
        'flow-at-zero',
        'flow.run-attached',
        {
          eventId: 'flow-at-zero',
          provider: 'claude',
          threadId,
          createdAt: new Date(1_700_000_000_000).toISOString(),
          method: 'flow.run-attached',
          runId: 'run-old-but-load-bearing',
          cwd: '/workspace',
        },
        1,
        new Date(1_700_000_000_000).toISOString(),
      );
      for (let i = 0; i < 50_000; i += 1) {
        const createdAt = new Date(1_700_000_001_000 + i).toISOString();
        insertEvent(
          `delta-${i}`,
          'content.text-delta',
          {
            eventId: `delta-${i}`,
            provider: 'claude',
            threadId,
            createdAt,
            method: 'content.text-delta',
            itemId: `item-${i}`,
            delta: 'x',
          },
          i + 2,
          createdAt,
        );
      }
      insertEvent(
        'policy-at-end',
        'policy.hooks-attached',
        {
          eventId: 'policy-at-end',
          provider: 'claude',
          threadId,
          createdAt: new Date(1_700_000_060_000).toISOString(),
          method: 'policy.hooks-attached',
          cwd: '/workspace',
        },
        50_002,
        new Date(1_700_000_060_000).toISOString(),
      );
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database.close();
    store = new EventStore(databasePath);

    const projection = store.listSessionProjectionEvents(threadId);
    expect(projection.map((event) => event.method)).toEqual([
      'flow.run-attached',
      'policy.hooks-attached',
    ]);
    expect(projection[0]?.payload).toMatchObject({
      method: 'flow.run-attached',
      runId: 'run-old-but-load-bearing',
    });
    expect(store.countEventsByThread(threadId)).toBe(50_002);
  });

  test('bounds authoritative facts when lifecycle, turn, and request classes also grow (station#1867)', () => {
    const threadId = 'thread-1867-bounded-facts';
    store.close();
    const databasePath = join(dir, 'bounded-facts.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    const insert = database.prepare(
      `INSERT INTO orchestration_events
        (id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence)
       VALUES (?, 'claude', ?, ?, ?, ?, ?, ?, ?)`,
    );
    let sequence = 0;
    const insertEvent = (
      id: string,
      method: string,
      payload: Record<string, unknown>,
      createdAt: string,
      turnId?: string,
    ) => {
      sequence += 1;
      insert.run(
        id,
        threadId,
        turnId ?? null,
        method,
        JSON.stringify(payload),
        createdAt,
        sequence,
        sequence,
      );
    };
    database.exec('BEGIN IMMEDIATE');
    try {
      insertEvent(
        'flow-old',
        'flow.run-attached',
        {
          eventId: 'flow-old',
          provider: 'claude',
          threadId,
          createdAt: '2026-08-01T00:00:00.000Z',
          method: 'flow.run-attached',
          runId: 'run-old',
          definitionId: 'delivery',
          cwd: '/workspace',
          resumed: false,
        },
        '2026-08-01T00:00:00.000Z',
      );
      for (let i = 0; i < 500; i += 1) {
        const base = 1_780_000_000_000 + i * 10;
        const stateAt = new Date(base).toISOString();
        insertEvent(
          `state-${i}`,
          'session.state-changed',
          {
            eventId: `state-${i}`,
            provider: 'claude',
            threadId,
            createdAt: stateAt,
            method: 'session.state-changed',
            sessionId: threadId,
            from: 'running',
            to: 'running',
            sessionState: 'running',
          },
          stateAt,
        );
        const turnAt = new Date(base + 1).toISOString();
        insertEvent(
          `turn-${i}`,
          'turn.started',
          {
            eventId: `turn-${i}`,
            provider: 'claude',
            threadId,
            turnId: `turn-${i}`,
            createdAt: turnAt,
            method: 'turn.started',
            prompt: i === 0 ? 'first load-bearing prompt' : `later prompt ${i}`,
          },
          turnAt,
          `turn-${i}`,
        );
        const openedAt = new Date(base + 2).toISOString();
        insertEvent(
          `request-open-${i}`,
          'request.opened',
          {
            eventId: `request-open-${i}`,
            provider: 'claude',
            threadId,
            createdAt: openedAt,
            method: 'request.opened',
            requestId: `request-${i}`,
            requestType: 'approval',
          },
          openedAt,
        );
        const resolvedAt = new Date(base + 3).toISOString();
        insertEvent(
          `request-resolved-${i}`,
          'request.resolved',
          {
            eventId: `request-resolved-${i}`,
            provider: 'claude',
            threadId,
            createdAt: resolvedAt,
            method: 'request.resolved',
            requestId: `request-${i}`,
            decision: 'accept',
          },
          resolvedAt,
        );
      }
      insertEvent(
        'latest-recency',
        'policy.hooks-attached',
        {
          eventId: 'latest-recency',
          provider: 'claude',
          threadId,
          createdAt: '2026-08-02T00:00:00.000Z',
          method: 'policy.hooks-attached',
          cwd: '/workspace',
        },
        '2026-08-02T00:00:00.000Z',
      );
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database.close();
    store = new EventStore(databasePath);

    const projection = store.listSessionProjectionEvents(threadId);
    expect(projection.map((event) => event.id)).toEqual(
      expect.arrayContaining([
        'flow-old',
        'turn-0',
        // archive#3524: the CURRENT turn's own `turn.started` now holds a
        // dedicated slot, so `turn-499` — the latest of the 500 turns seeded
        // above, and NOT the same row as `turn-0` — survives even though the
        // `request.resolved-499` right after it wins the single
        // LIFECYCLE_METHODS slot.
        'turn-499',
        'request-resolved-499',
        'latest-recency',
      ]),
    );
    expect(projection).toHaveLength(5);
    expect(store.latestEvent(threadId)?.id).toBe('latest-recency');
    expect(store.listUnresolvedRequestEvents(threadId)).toEqual([]);

    const planDb = new DatabaseSync(databasePath);
    const turnPlan = planDb
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM orchestration_events
         WHERE thread_id = ? AND turn_id = ?
         ORDER BY sequence ASC`,
      )
      .all(threadId, 'turn-499') as Array<{ detail: string }>;
    const requestPlan = planDb
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM orchestration_events
         WHERE thread_id = ? AND request_id = ?
         ORDER BY sequence ASC`,
      )
      .all(threadId, 'request-499') as Array<{ detail: string }>;
    const statePlan = planDb
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM orchestration_events
         WHERE thread_id = ? AND session_state = ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .all(threadId, 'running') as Array<{ detail: string }>;
    planDb.close();
    expect(turnPlan.map((row) => row.detail).join(' | ')).toContain(
      'idx_events_thread_turn_sequence',
    );
    expect(requestPlan.map((row) => row.detail).join(' | ')).toContain(
      'idx_events_thread_request_sequence',
    );
    expect(statePlan.map((row) => row.detail).join(' | ')).toContain(
      'idx_events_thread_session_state_sequence',
    );
  });

  test('uses point/range queries for one request and recovery source event (station#1867)', () => {
    const threadId = 'thread-1867-facts';
    store.appendEvent({
      eventId: 'unrelated',
      provider: 'claude',
      threadId,
      createdAt: new Date().toISOString(),
      method: 'content.text-delta',
      itemId: 'i',
      delta: 'x',
    });
    store.appendEvent({
      eventId: 'opened',
      provider: 'claude',
      threadId,
      createdAt: new Date(Date.now() + 1).toISOString(),
      method: 'request.opened',
      requestId: 'request-a',
      requestType: 'approval',
    } as never);
    store.appendEvent({
      eventId: 'started',
      provider: 'claude',
      threadId,
      turnId: 'turn-a',
      createdAt: new Date(Date.now() + 2).toISOString(),
      method: 'turn.started',
      prompt: 'hello',
    } as never);
    store.appendEvent({
      eventId: 'opened-resolved',
      provider: 'claude',
      threadId,
      createdAt: new Date(Date.now() + 3).toISOString(),
      method: 'request.opened',
      requestId: 'request-resolved',
      requestType: 'approval',
    } as never);
    store.appendEvent({
      eventId: 'resolved',
      provider: 'claude',
      threadId,
      createdAt: new Date(Date.now() + 4).toISOString(),
      method: 'request.resolved',
      requestId: 'request-resolved',
      decision: 'accept',
    } as never);
    store.appendEvent({
      eventId: 'reopened',
      provider: 'claude',
      threadId,
      createdAt: new Date(Date.now() + 5).toISOString(),
      method: 'request.opened',
      requestId: 'request-resolved',
      requestType: 'approval',
    } as never);

    expect(store.listEventsForRequest(threadId, 'request-a')).toHaveLength(1);
    expect(store.listEventsForRequest(threadId, 'missing')).toEqual([]);
    expect(store.listUnresolvedRequestEvents(threadId)).toMatchObject([
      { id: 'opened', payload: { requestId: 'request-a' } },
      { id: 'reopened', payload: { requestId: 'request-resolved' } },
    ]);
    expect(
      store.listSessionProjectionEvents(threadId).map((event) => event.id),
    ).toEqual(expect.arrayContaining(['opened', 'resolved']));
    expect(
      store.listSessionProjectionEvents(threadId).map((event) => event.id),
    ).toContain('reopened');
    expect(store.eventById(threadId, 'started')?.payload).toMatchObject({
      method: 'turn.started',
      turnId: 'turn-a',
    });
    expect(store.latestEventByMethod(threadId, 'turn.started')?.id).toBe(
      'started',
    );
    expect(() => store.listEventsByMethods(threadId, [])).toThrow(
      'requires at least one method',
    );
    expect(() =>
      store.appendEvent({
        eventId: 'malformed-request',
        provider: 'claude',
        threadId,
        createdAt: new Date().toISOString(),
        method: 'request.opened',
      } as never),
    ).toThrow(
      'Cannot persist request.opened without a non-empty request identity',
    );
  });

  test('reads finite lifecycle facts with one method-specific indexed query per method', () => {
    const threadId = 'thread-finite-lifecycle-facts';
    store.appendEvent({
      eventId: 'running-old',
      provider: 'claude',
      threadId,
      createdAt: '2026-08-01T00:00:00.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'idle',
      to: 'running',
      sessionState: 'running',
    });
    store.appendEvent({
      eventId: 'idle-new',
      provider: 'claude',
      threadId,
      createdAt: '2026-08-01T00:00:01.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'completed',
      sessionState: 'completed',
    });
    store.appendEvent({
      eventId: 'turn-started-newest',
      provider: 'claude',
      threadId,
      turnId: 'turn-current',
      createdAt: '2026-08-01T00:00:02.000Z',
      method: 'turn.started',
      prompt: 'latest finite method',
    } as never);

    expect(
      store.latestEventByMethods(threadId, [
        'session.state-changed',
        'turn.started',
      ])?.id,
    ).toBe('turn-started-newest');
    expect(store.latestEventForSessionState(threadId, 'running')?.id).toBe(
      'running-old',
    );

    const database = new DatabaseSync(join(dir, 'orchestration.sqlite'));
    const lifecyclePlan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM orchestration_events
         WHERE thread_id = ? AND method = ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .all(threadId, 'turn.started') as Array<{ detail: string }>;
    const statePlan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM orchestration_events
         WHERE thread_id = ? AND method = ? AND session_state = ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .all(threadId, 'session.state-changed', 'running') as Array<{
      detail: string;
    }>;
    database.close();

    expect(lifecyclePlan.map((row) => row.detail).join(' | ')).toContain(
      'idx_events_history_projection',
    );
    expect(lifecyclePlan.map((row) => row.detail).join(' | ')).not.toContain(
      'TEMP B-TREE',
    );
    expect(statePlan.map((row) => row.detail).join(' | ')).toContain(
      'idx_events_thread_method_session_state_sequence',
    );
    expect(statePlan.map((row) => row.detail).join(' | ')).not.toContain(
      'TEMP B-TREE',
    );
  });

  test('refuses a persisted malformed request identity while upgrading an old event table (station#1867)', () => {
    const legacyDbPath = join(dir, 'legacy-malformed-request.sqlite');
    const legacyDb = new DatabaseSync(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE orchestration_events (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        method TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL
      )
    `);
    legacyDb
      .prepare(
        `INSERT INTO orchestration_events
         (id, provider, thread_id, turn_id, method, payload, created_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'bad-request',
        'claude',
        'thread-bad-request',
        null,
        'request.opened',
        JSON.stringify({
          eventId: 'bad-request',
          provider: 'claude',
          threadId: 'thread-bad-request',
          createdAt: '2026-08-01T00:00:00.000Z',
          method: 'request.opened',
        }),
        '2026-08-01T00:00:00.000Z',
        1,
      );
    legacyDb.close();

    expect(() => new EventStore(legacyDbPath)).toThrow(
      'Malformed persisted request identity: bad-request',
    );
    const movedPath = `${legacyDbPath}.moved`;
    expect(() => renameSync(legacyDbPath, movedPath)).not.toThrow();
    rmSync(movedPath);
  });

  test('shares the exact Unicode and UTF-8 request identity contract between appends and upgrades', () => {
    expect(canonicalPersistedRequestId('request-1')).toBe('request-1');
    expect(() => canonicalPersistedRequestId('\u00a0request-1')).toThrow(
      'canonical UTF-8',
    );
    expect(() => canonicalPersistedRequestId('x'.repeat(513))).toThrow(
      'canonical UTF-8',
    );
    // 256 astral characters occupy exactly 512 UTF-8 bytes; one more must
    // fail under the same byte contract used by persisted upgrades.
    expect(canonicalPersistedRequestId('😀'.repeat(128))).toHaveLength(256);
    expect(() => canonicalPersistedRequestId('😀'.repeat(129))).toThrow(
      'canonical UTF-8',
    );
  });

  test('rejects the same NBSP and astral request identities on live append and persisted upgrade', () => {
    for (const [name, requestId] of [
      ['nbsp', '\u00a0request-id'],
      ['astral-overflow', '😀'.repeat(129)],
    ]) {
      expect(() =>
        store.appendEvent({
          eventId: `live-${name}`,
          provider: 'claude',
          threadId: `thread-live-${name}`,
          createdAt: '2026-08-02T00:00:00.000Z',
          method: 'request.opened',
          requestId,
          requestType: 'approval',
        } as never),
      ).toThrow(
        'Cannot persist request.opened without a non-empty request identity',
      );

      const legacyPath = join(dir, `legacy-${name}.sqlite`);
      const legacyDb = new DatabaseSync(legacyPath);
      legacyDb.exec(`
        CREATE TABLE orchestration_events (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          method TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sequence INTEGER NOT NULL
        )
      `);
      legacyDb
        .prepare(
          `INSERT INTO orchestration_events
           (id, provider, thread_id, turn_id, method, payload, created_at, sequence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `persisted-${name}`,
          'claude',
          `thread-persisted-${name}`,
          null,
          'request.opened',
          JSON.stringify({
            eventId: `persisted-${name}`,
            provider: 'claude',
            threadId: `thread-persisted-${name}`,
            createdAt: '2026-08-02T00:00:00.000Z',
            method: 'request.opened',
            requestId,
            requestType: 'approval',
          }),
          '2026-08-02T00:00:00.000Z',
          1,
        );
      legacyDb.close();
      expect(() => new EventStore(legacyPath)).toThrow(
        `Malformed persisted request identity: persisted-${name}`,
      );
      const movedPath = `${legacyPath}.moved`;
      expect(() => renameSync(legacyPath, movedPath)).not.toThrow();
      rmSync(movedPath);
    }
  });

  test('projects the same reducer facts as a full event fold across model, delegation, and attribution generations', () => {
    const threadId = 'thread-projection-fact-parity';
    const append = (event: Record<string, unknown>) =>
      store.appendEvent({
        provider: 'claude',
        threadId,
        createdAt: `2026-08-02T00:00:${String(
          store.listEvents(threadId).length,
        ).padStart(2, '0')}.000Z`,
        ...event,
      } as never);
    append({
      eventId: 'malformed-plan',
      method: 'session.configured',
      sessionId: threadId,
      metadata: { modelLaunchPlan: { kind: 'station-resolved' } },
    });
    append({
      eventId: 'valid-plan-and-old-model',
      method: 'session.configured',
      sessionId: threadId,
      metadata: {
        modelLaunchPlan: {
          kind: 'station-resolved',
          modelConnectionId: 'connection-a',
          modelId: 'model-a',
          evidence: 'catalog-accepted',
        },
        effectiveModel: 'model-a',
        reportedModel: 'model-a',
        taskId: 'task-a',
        projectSlug: 'project-a',
        modelSelectionReceipt: { requestedModel: 'model-a' },
      },
    });
    append({
      eventId: 'meaningless-later-values',
      method: 'session.configured',
      sessionId: threadId,
      metadata: {
        taskId: '   ',
        projectSlug: '   ',
        modelSelectionReceipt: { requestedModel: '   ' },
      },
    });
    append({
      eventId: 'model-b-request',
      method: 'turn.started',
      turnId: 'turn-b',
      prompt: 'continue',
      metadata: {
        effectiveModel: 'model-b',
        modelSelectionReceipt: { requestedModel: 'model-b' },
      },
    });
    append({
      eventId: 'model-b-applied',
      method: 'turn.completed',
      turnId: 'turn-b',
      metadata: {
        reportedModel: 'model-b',
        modelSelectionReceipt: { appliedModel: 'model-b' },
      },
    });

    const summaryOptions = {
      persisted: {
        provider: 'claude' as const,
        threadId,
        status: 'ready' as const,
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:04.000Z',
      },
      answerability: {
        threadAttachment: 'detached' as const,
        providerRegistered: true,
        observedBy: 'test',
        observedAt: '2026-08-02T00:00:05.000Z',
      },
    };
    const fromFullFold = buildOrchestrationSessionSummary({
      ...summaryOptions,
      events: store.listEvents(threadId).map((event) => event.payload),
    });
    const fromProjection = buildOrchestrationSessionSummary({
      ...summaryOptions,
      events: store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload),
    });

    expect(fromProjection).toMatchObject({
      modelLaunchPlan: {
        kind: 'station-resolved',
        modelConnectionId: 'connection-a',
        modelId: 'model-a',
      },
      delegation: { taskId: 'task-a', projectSlug: 'project-a' },
      projectSlug: 'project-a',
      effectiveModel: 'model-b',
      reportedModel: 'model-b',
      requestedModel: 'model-b',
      appliedModel: 'model-b',
    });
    expect(fromProjection).toMatchObject({
      modelLaunchPlan: fromFullFold.modelLaunchPlan,
      delegation: fromFullFold.delegation,
      projectSlug: fromFullFold.projectSlug,
      effectiveModel: fromFullFold.effectiveModel,
      reportedModel: fromFullFold.reportedModel,
      requestedModel: fromFullFold.requestedModel,
      appliedModel: fromFullFold.appliedModel,
    });
  });

  test('treats valid options-only metadata as a generation boundary, but ignores malformed options and unrelated lifecycle', () => {
    const threadId = 'thread-options-only-boundary';
    const append = (event: Record<string, unknown>) =>
      store.appendEvent({
        provider: 'claude',
        threadId,
        createdAt: `2026-08-03T00:00:${String(
          store.listEvents(threadId).length,
        ).padStart(2, '0')}.000Z`,
        ...event,
      } as never);
    append({
      eventId: 'model-a',
      method: 'session.configured',
      sessionId: threadId,
      metadata: { effectiveModel: 'model-a', reportedModel: 'model-a' },
    });
    append({
      eventId: 'options-only',
      method: 'turn.started',
      turnId: 'turn-options',
      prompt: 'continue',
      metadata: { effectiveModelOptions: { effort: 'high' } },
    });
    append({
      eventId: 'malformed-options',
      method: 'turn.started',
      turnId: 'turn-options',
      prompt: 'continue',
      metadata: { effectiveModelOptions: ['not-an-options-object'] },
    });
    append({
      eventId: 'unrelated-lifecycle',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'completed',
      sessionState: 'completed',
    });
    const options = {
      persisted: {
        provider: 'claude' as const,
        threadId,
        status: 'ready' as const,
        createdAt: '2026-08-03T00:00:00.000Z',
        updatedAt: '2026-08-03T00:00:04.000Z',
      },
      answerability: {
        threadAttachment: 'detached' as const,
        providerRegistered: true,
        observedBy: 'test',
        observedAt: '2026-08-03T00:00:05.000Z',
      },
    };
    const full = buildOrchestrationSessionSummary({
      ...options,
      events: store.listEvents(threadId).map((event) => event.payload),
    });
    const projected = buildOrchestrationSessionSummary({
      ...options,
      events: store
        .listSessionProjectionEvents(threadId)
        .map((event) => event.payload),
    });
    expect(full.effectiveModel).toBeUndefined();
    expect(full.reportedModel).toBeUndefined();
    expect(projected.effectiveModel).toBeUndefined();
    expect(projected.reportedModel).toBeUndefined();
  });

  // archive#4466: `listSessionReadModel` folded every visible thread by
  // calling `listSessionProjectionEvents(threadId)` in a `.map`, one SQL
  // round trip per fact per thread. `listSessionProjectionEventsForThreads`
  // batches the same fold over many threads in a fixed number of round
  // trips. This is the equivalence proof the batching cannot be trusted
  // without: build a realistic multi-thread corpus (varied event shapes —
  // multiple turns, an orphaned lifecycle race, a flow/policy binding, an
  // unresolved request, a projection fact), then assert the batched read's
  // per-thread slice deep-equals calling the single-thread method for that
  // same thread id. The two exercise genuinely different SQL (one
  // `WHERE thread_id = ?` call per fact vs. three `WHERE thread_id IN (...)`
  // superset queries grouped in memory), so agreement here is real evidence,
  // not tautology.
  describe('listSessionProjectionEventsForThreads (station#4466 batched read)', () => {
    function seedProjectionThread(
      threadId: string,
      variant:
        | 'ordinary'
        | 'orphan-terminal'
        | 'runtime-error'
        | 'session-scoped-recovered'
        | 'session-scoped-retained'
        | 'empty',
    ): void {
      const base = '2026-08-20T00:00:00.000Z';
      store.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: base,
        updatedAt: base,
      });
      if (variant === 'empty') return;
      store.appendEvent({
        eventId: `${threadId}-started`,
        provider: 'claude',
        threadId,
        createdAt: base,
        method: 'session.started',
        sessionId: threadId,
        metadata: { agentSlug: 'claude', userId: 'owner-user' },
      });
      store.appendEvent({
        eventId: `${threadId}-configured`,
        provider: 'claude',
        threadId,
        createdAt: base,
        method: 'session.configured',
        sessionId: threadId,
        model: 'claude-sonnet-4-5',
      });
      store.appendEvent({
        eventId: `${threadId}-flow-attached`,
        provider: 'claude',
        threadId,
        createdAt: base,
        method: 'flow.run-attached',
        runId: `run-${threadId}`,
      } as any);
      store.appendEvent({
        eventId: `${threadId}-turn1-started`,
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: base,
        method: 'turn.started',
        prompt: `prompt for ${threadId}`,
      });
      store.appendEvent({
        eventId: `${threadId}-turn1-completed`,
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: base,
        method: 'turn.completed',
        finishReason: 'stop',
      } as any);
      store.appendEvent({
        eventId: `${threadId}-request-opened`,
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: base,
        method: 'request.opened',
        requestId: `${threadId}-req-1`,
        kind: 'approval',
      } as any);
      if (variant === 'runtime-error') {
        store.appendEvent({
          eventId: `${threadId}-turn2-started`,
          provider: 'claude',
          threadId,
          turnId: 'turn-2',
          createdAt: base,
          method: 'turn.started',
          prompt: `follow-up for ${threadId}`,
        });
        store.appendEvent({
          eventId: `${threadId}-runtime-error`,
          provider: 'claude',
          threadId,
          turnId: 'turn-2',
          createdAt: base,
          method: 'runtime.error',
          message: 'synthetic failure',
        } as any);
        return;
      }
      if (variant === 'session-scoped-recovered') {
        // archive#3485 review BLOCK 1: the shape on which the batched
        // mirror carried the pre-fix unconditional retention while the
        // single-thread fold had been fixed — the ONLY variant here that
        // discriminated the two implementations, and precisely the one this
        // harness lacked (its 'runtime-error' variant is turn-scoped). A
        // session-scoped error followed by a strictly later proven
        // completion: both folds must drop the error. The base seed's
        // turn-1 completion PRECEDES the error, so it also proves the
        // ordering clause batches identically.
        store.appendEvent({
          eventId: `${threadId}-session-scoped-error`,
          provider: 'claude',
          threadId,
          createdAt: base,
          method: 'runtime.error',
          severity: 'error',
          message: 'transport closed',
          retriable: false,
        } as any);
        store.appendEvent({
          eventId: `${threadId}-turn2-started`,
          provider: 'claude',
          threadId,
          turnId: 'turn-2',
          createdAt: base,
          method: 'turn.started',
          prompt: `retry for ${threadId}`,
        });
        store.appendEvent({
          eventId: `${threadId}-turn2-completed`,
          provider: 'claude',
          threadId,
          turnId: 'turn-2',
          createdAt: base,
          method: 'turn.completed',
          finishReason: 'stop',
        } as any);
        store.appendEvent({
          eventId: `${threadId}-recovered-idle`,
          provider: 'claude',
          threadId,
          createdAt: base,
          method: 'session.state-changed',
          sessionId: threadId,
          from: 'running',
          to: 'idle',
        } as any);
        return;
      }
      if (variant === 'session-scoped-retained') {
        // archive#3485 boundary, batched: a session-scoped error with a
        // later turn ANNOUNCED but never provenly completed, plus a
        // trailing lifecycle event so retention depends on the error slot
        // itself rather than the generic lifecycle slot. Both folds must
        // retain the error.
        store.appendEvent({
          eventId: `${threadId}-turn2-started`,
          provider: 'claude',
          threadId,
          turnId: 'turn-2',
          createdAt: base,
          method: 'turn.started',
          prompt: `follow-up for ${threadId}`,
        });
        store.appendEvent({
          eventId: `${threadId}-session-scoped-error`,
          provider: 'claude',
          threadId,
          createdAt: base,
          method: 'runtime.error',
          severity: 'error',
          message: 'transport closed',
          retriable: false,
        } as any);
        store.appendEvent({
          eventId: `${threadId}-errored-idle`,
          provider: 'claude',
          threadId,
          createdAt: base,
          method: 'session.state-changed',
          sessionId: threadId,
          from: 'errored',
          to: 'idle',
        } as any);
        return;
      }
      if (variant === 'orphan-terminal') {
        // archive#3557/#3558: turn 2 starts and completes, but turn 2's own
        // `turn.started` is evicted from the `LIFECYCLE_METHODS` slot by a
        // later unrelated lifecycle event, exercising the dedicated
        // turn-scoped terminal slot rather than the thread-wide one.
        store.appendEvent({
          eventId: `${threadId}-turn2-started`,
          provider: 'claude',
          threadId,
          turnId: 'turn-2',
          createdAt: base,
          method: 'turn.started',
          prompt: `follow-up for ${threadId}`,
        });
        store.appendEvent({
          eventId: `${threadId}-turn2-completed`,
          provider: 'claude',
          threadId,
          turnId: 'turn-2',
          createdAt: base,
          method: 'turn.completed',
          finishReason: 'stop',
        } as any);
        store.appendEvent({
          eventId: `${threadId}-request-resolved`,
          provider: 'claude',
          threadId,
          turnId: 'turn-2',
          createdAt: base,
          method: 'request.resolved',
          requestId: `${threadId}-req-2`,
          outcome: 'approved',
        } as any);
        return;
      }
      // 'ordinary': a second, ongoing turn with no terminal yet.
      store.appendEvent({
        eventId: `${threadId}-turn2-started`,
        provider: 'claude',
        threadId,
        turnId: 'turn-2',
        createdAt: base,
        method: 'turn.started',
        prompt: `follow-up for ${threadId}`,
      });
    }

    // archive#4466 review remediation: `listSessionProjectionEvents` is the
    // REAL single-thread production code path (restored verbatim to
    // origin/main — a dozen separate `WHERE thread_id = ?` SQL calls), and
    // `listSessionProjectionEventsForThreads` is a genuinely different
    // implementation (two-phase ranked-window batched SQL). Comparing them
    // is real evidence, not the self-comparison an earlier version of this
    // test had (both sides briefly ran through the SAME batched code after
    // `listSessionProjectionEvents` was made to delegate to it — a defect an
    // independent review caught before merge).
    //
    // `observedAt` is stripped before comparing: the ORIGINAL per-fact SQL
    // methods are already inconsistent about selecting it (`latestEventByMethod`/
    // `firstEventByMethod` do, `latestEvent`/`latestEventByMethods`/
    // `firstTurnStartedWithPrompt`/the turn-scoped-terminal query do not) —
    // a pre-existing shape quirk this batching work did not introduce and
    // does not fix. The only real consumers of both methods
    // (`listSessionReadModel`, `listAgentRuns`, and every single-thread
    // caller) read `.payload` only and never `.observedAt`, so normalizing
    // it away here compares what callers can actually observe.
    function withoutObservedAt(
      events: readonly PersistedRuntimeEvent[],
    ): unknown[] {
      return events.map(({ observedAt: _observedAt, ...rest }) => rest);
    }

    function expectBatchedMatchesIndividual(threadId: string): void {
      const individual = store.listSessionProjectionEvents(threadId);
      const batched = store
        .listSessionProjectionEventsForThreads([threadId])
        .get(threadId);
      expect(withoutObservedAt(batched ?? [])).toEqual(
        withoutObservedAt(individual),
      );
    }

    test('a large varied-shape population: batched matches single-thread, thread by thread', () => {
      const variants: Array<Parameters<typeof seedProjectionThread>[1]> = [
        'ordinary',
        'orphan-terminal',
        'runtime-error',
        'session-scoped-recovered',
        'session-scoped-retained',
        'empty',
      ];
      const threadIds = Array.from(
        { length: 120 },
        (_, index) => `batch-equiv-thread-${index}`,
      );
      threadIds.forEach((threadId, index) => {
        seedProjectionThread(threadId, variants[index % variants.length]!);
      });

      const batched = store.listSessionProjectionEventsForThreads(threadIds);
      expect(batched.size).toBe(threadIds.length);
      for (const threadId of threadIds) {
        const individual = store.listSessionProjectionEvents(threadId);
        expect(withoutObservedAt(batched.get(threadId) ?? [])).toEqual(
          withoutObservedAt(individual),
        );
        // Never empty for a seeded (non-'empty'-variant) thread — a silent
        // grouping bug that dropped every row into the wrong bucket would
        // otherwise still pass an `undefined`-vs-`undefined` comparison for
        // threads it emptied.
        if (individual.length > 0) {
          expect(batched.get(threadId)?.length).toBeGreaterThan(0);
        }
      }
    });

    // archive#4466 review remediation: an earlier JS-side mirror of
    // `firstTurnStartedWithPrompt`'s predicate used `.trim()`/`typeof`,
    // which diverges from SQLite's `trim()` (strips ONLY ASCII 0x20, not
    // `\n`/`\t`/NBSP) and `typeof(json_extract(...))` (an object/number/null
    // JSON value is not `'text'`). The predicate now lives entirely in SQL
    // (both the single-thread and batched queries), so this proves the two
    // AGREE with each other on the hostile inputs that used to discriminate
    // JS from SQL — and that the chosen fact is the SQL-authoritative one
    // (turn-1's lone LF), not whatever a naive JS reimplementation would
    // pick.
    test('firstTurnStartedWithPrompt: SQL trim/typeof semantics on hostile prompts, batched agrees with individual', () => {
      const threadId = 'batch-equiv-hostile-prompts';
      const base = '2026-08-20T00:00:00.000Z';
      store.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: base,
        updatedAt: base,
      });
      const turn = (turnId: string, eventId: string, prompt: unknown) =>
        store.appendEvent({
          eventId,
          provider: 'claude',
          threadId,
          turnId,
          createdAt: base,
          method: 'turn.started',
          prompt,
        } as never);
      // turn-1: a lone LF. ASCII-space-only under JS `.trim()` semantics —
      // JS would call it empty and skip it. SQLite's default `trim()` only
      // strips 0x20, so this is NOT trimmed to empty and IS the fact SQL
      // picks.
      turn('turn-1', 'hostile-turn1', '\n');
      turn('turn-2', 'hostile-turn2', '\t');
      turn('turn-3', 'hostile-turn3', ' ');
      turn('turn-4', 'hostile-turn4', { nested: true });
      turn('turn-5', 'hostile-turn5', 42);
      turn('turn-6', 'hostile-turn6', null);
      // turn-7: real ASCII spaces only — trimmed to empty by BOTH SQLite and
      // JS, so this one is genuinely excluded either way.
      turn('turn-7', 'hostile-turn7', '   ');

      expectBatchedMatchesIndividual(threadId);
      const individual = store.listSessionProjectionEvents(threadId);
      const firstPrompted = individual.find(
        (event) => event.method === 'turn.started' && event.turnId === 'turn-1',
      );
      expect(firstPrompted).toBeDefined();
      expect(firstPrompted?.id).toBe('hostile-turn1');
    });

    // archive#4466 review remediation: proves a method with exactly ONE row
    // resolves BOTH the "first" and "latest" slot to that same row (the
    // window-function ranking's `rn_desc = 1 OR rn_asc = 1` filter matches
    // it once, not twice) — the degenerate case of the "same-sequence tie"
    // the review named. `appendEvent` assigns a strictly increasing
    // per-thread `sequence`, so a literal two-row tie is not producible
    // through the public write path; this is the tie that IS reachable.
    test('a method with exactly one row is both its own first and latest fact', () => {
      const threadId = 'batch-equiv-single-row-method';
      const base = '2026-08-20T00:00:00.000Z';
      store.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: base,
        updatedAt: base,
      });
      store.appendEvent({
        eventId: 'single-row-configured',
        provider: 'claude',
        threadId,
        createdAt: base,
        method: 'session.configured',
        sessionId: threadId,
        model: 'claude-sonnet-4-5',
      });
      expectBatchedMatchesIndividual(threadId);
      const batched = store
        .listSessionProjectionEventsForThreads([threadId])
        .get(threadId);
      expect(
        batched?.filter((event) => event.id === 'single-row-configured'),
      ).toHaveLength(1);
    });

    test('an unrequested thread id never appears in the batched result', () => {
      seedProjectionThread('batch-equiv-present', 'ordinary');
      seedProjectionThread('batch-equiv-absent', 'ordinary');
      const batched = store.listSessionProjectionEventsForThreads([
        'batch-equiv-present',
      ]);
      expect(batched.has('batch-equiv-present')).toBe(true);
      expect(batched.has('batch-equiv-absent')).toBe(false);
    });

    test('duplicate thread ids in the request are not double-counted', () => {
      seedProjectionThread('batch-equiv-dup', 'ordinary');
      const batched = store.listSessionProjectionEventsForThreads([
        'batch-equiv-dup',
        'batch-equiv-dup',
      ]);
      expect(batched.size).toBe(1);
      expect(withoutObservedAt(batched.get('batch-equiv-dup') ?? [])).toEqual(
        withoutObservedAt(store.listSessionProjectionEvents('batch-equiv-dup')),
      );
    });

    test('an empty thread id list returns an empty map without querying', () => {
      expect(store.listSessionProjectionEventsForThreads([])).toEqual(
        new Map(),
      );
    });

    test('a thread with zero events returns an empty array from both paths', () => {
      seedProjectionThread('batch-equiv-empty', 'empty');
      expect(
        store
          .listSessionProjectionEventsForThreads(['batch-equiv-empty'])
          .get('batch-equiv-empty'),
      ).toEqual([]);
      expect(store.listSessionProjectionEvents('batch-equiv-empty')).toEqual(
        [],
      );
    });
  });

  // archive#1867/#3495: `sessionOwnerUserId()` is the /events SSE route's
  // per-event authorization gate and deliberately never caches a negative
  // result, so on a read-only-attached thread (no `metadata.userId`) EVERY
  // event re-ran an unbounded read of every ownership-shaped row and
  // `JSON.parse`d every payload — 517,718 rows / 2.8 s / 1.2 GB on the live
  // store, to return `undefined`. The SQL replacement must answer exactly what
  // that scan answered.
  describe('resolves a session owner without materializing the thread (station#3495)', () => {
    /**
     * The scan `findSessionOwnerUserId` replaces, written out. Anything this
     * returns, the SQL must return; anything it refuses, the SQL must refuse.
     */
    function scanForOwner(threadId: string): string | undefined {
      const newestFirst = [...store.listEvents(threadId)].reverse();
      for (const entry of newestFirst) {
        const event = entry.payload as unknown as {
          method: string;
          metadata?: { userId?: unknown };
        };
        if (
          event.method !== 'session.configured' &&
          event.method !== 'session.started'
        ) {
          continue;
        }
        if (typeof event.metadata?.userId === 'string') {
          return event.metadata.userId;
        }
      }
      return undefined;
    }

    // archive#4075 stage 2: writes rows DIRECTLY, bypassing `appendEvent`'s
    // ownership-immutability guard — deliberately, and only here. This
    // describe block is about `findSessionOwnerUserId`'s READ predicate
    // (matching a hand-rolled JS scan over arbitrary existing rows, per its
    // own docblock: "anything this returns, the SQL must return"), including
    // fixtures the guard now correctly refuses to let a NEW write produce
    // (two disagreeing owners on one thread) — exactly the shape a
    // pre-stage-2 database, or any future direct-SQL writer, can still
    // contain. Going through `store.appendEvent` here would make this
    // block indistinguishable from a guard test and throw
    // `SessionOwnershipConflictError` on the very fixtures it needs.
    function seed(
      threadId: string,
      events: { method: string; metadata?: Record<string, unknown> }[],
    ): void {
      const insert = (
        store as unknown as { db: InstanceType<typeof DatabaseSync> }
      ).db.prepare(
        `INSERT INTO orchestration_events
          (id, provider, thread_id, method, payload, created_at, sequence, global_sequence)
         VALUES (?, 'claude', ?, ?, ?, ?, ?, ?)`,
      );
      events.forEach((event, index) => {
        const payload = {
          eventId: `evt-${threadId}-${index}`,
          provider: 'claude',
          threadId,
          createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
          ...(event.method === 'content.text-delta' ? { delta: 'x' } : {}),
          ...event,
        };
        insert.run(
          `evt-${threadId}-${index}`,
          threadId,
          event.method,
          JSON.stringify(payload),
          payload.createdAt,
          index + 1,
          index + 1,
        );
      });
    }

    test('returns the newest ownership-shaped event carrying a string userId, ignoring every other method', () => {
      const threadId = 'thread-3495-owned';
      seed(threadId, [
        { method: 'session.started', metadata: { userId: 'owner-old' } },
        { method: 'content.text-delta' },
        { method: 'session.configured', metadata: { userId: 'owner-new' } },
        // NEWEST, and it carries a userId — but it is not an ownership-shaped
        // method, so it must not win. It has to sit last: placed anywhere
        // else, dropping the method restriction entirely still returns the
        // right answer and the restriction goes untested (found by injection).
        { method: 'tool.started', metadata: { userId: 'not-an-owner' } },
      ]);

      expect(store.findSessionOwnerUserId(threadId)).toBe('owner-new');
      expect(store.findSessionOwnerUserId(threadId)).toBe(
        scanForOwner(threadId),
      );
    });

    test('skips a non-string userId and keeps scanning, exactly as the loop did', () => {
      const threadId = 'thread-3495-nonstring';
      seed(threadId, [
        { method: 'session.started', metadata: { userId: 'owner-real' } },
        // Newest ownership-shaped event, but `typeof !== 'string'`. A bare
        // `IS NOT NULL` predicate would return 42 here; the loop skipped it.
        { method: 'session.configured', metadata: { userId: 42 } },
      ]);

      expect(store.findSessionOwnerUserId(threadId)).toBe('owner-real');
      expect(store.findSessionOwnerUserId(threadId)).toBe(
        scanForOwner(threadId),
      );
    });

    // `metadata` is `Record<string, unknown>` (`runtime-events.ts`) and caller
    // metadata is spread verbatim at the dispatch boundary, so `userId` can
    // hold any JSON shape. The predicate's first cut was
    // `typeof(json_extract(payload,'$.metadata.userId')) = 'text'`, which
    // looks like the JS `typeof x === 'string'` and is not: `json_extract`
    // returns an object or array as its SERIALIZED JSON TEXT, so `typeof`
    // reads `'text'` for both and the read resolves the literal string
    // `'{"a":1}'` as the owner. That value is then CACHED by
    // `cacheSessionOwner` and matched by `canReadSession` against no real
    // user — the genuine owner locked out of their own session, where the
    // loop skipped the row and kept scanning to the one that names them.
    // `json_type(payload, path)` reports the JSON type and discriminates all
    // of these.
    test.each([
      ['object', { a: 1 }],
      ['array', [1, 2]],
      ['boolean', true],
      ['number', 42],
      ['null', null],
    ])(
      'skips a %s userId and keeps scanning, exactly as the loop did',
      (label, userId) => {
        const threadId = `thread-3495-shape-${label}`;
        seed(threadId, [
          { method: 'session.started', metadata: { userId: 'owner-real' } },
          // Newest ownership-shaped event, carrying a non-string `userId`.
          { method: 'session.configured', metadata: { userId } },
        ]);

        expect(store.findSessionOwnerUserId(threadId)).toBe('owner-real');
        expect(store.findSessionOwnerUserId(threadId)).toBe(
          scanForOwner(threadId),
        );
      },
    );
    // Both shapes get an UNMASKED case, because these are the only two the
    // fix actually changed: `json_extract` returns the SERIALIZED JSON text
    // for an object and for an array, so `typeof(...)` reported `'text'` for
    // both. The boolean/number/null rows in the `test.each` above are
    // regression coverage only — an older `session.started` masks them, so
    // they pass against the pre-fix predicate too.
    test.each([
      ['object', { a: 1 }, '{"a":1}'],
      ['array', [1, 2], '[1,2]'],
    ])(
      'a %s userId on the ONLY ownership-shaped event resolves undefined, not its serialization',
      (label, userId, serialization) => {
        // No older row to fall back to, so the answer is the predicate's
        // alone. Under `typeof(json_extract(...))` this returned
        // `serialization`, which `cacheSessionOwner` then cached as the
        // owner — matching no real user, locking the true owner out.
        const threadId = `thread-3495-shape-only-${label}`;
        seed(threadId, [
          { method: 'session.configured', metadata: { userId } },
        ]);

        expect(store.findSessionOwnerUserId(threadId)).toBeUndefined();
        expect(store.findSessionOwnerUserId(threadId)).not.toBe(serialization);
        expect(store.findSessionOwnerUserId(threadId)).toBe(
          scanForOwner(threadId),
        );
      },
    );

    test('returns undefined for an ownerless thread and for an absent one', () => {
      const threadId = 'thread-3495-attached';
      seed(threadId, [
        {
          method: 'session.started',
          metadata: { controlMode: 'read-only-attached' },
        },
        {
          method: 'session.configured',
          metadata: { controlMode: 'read-only-attached' },
        },
      ]);

      // This is the case that caused the outage: it must stay `undefined`,
      // and it must cost one row, not the whole thread.
      expect(store.findSessionOwnerUserId(threadId)).toBeUndefined();
      expect(scanForOwner(threadId)).toBeUndefined();
      expect(store.findSessionOwnerUserId('absent-thread')).toBeUndefined();
    });

    test('reads at most one row, whatever the thread holds', () => {
      const threadId = 'thread-3495-bounded';
      seed(
        threadId,
        Array.from({ length: 200 }, (_, index) => ({
          method: index % 2 === 0 ? 'session.started' : 'session.configured',
          metadata: { controlMode: 'read-only-attached' },
        })),
      );

      // `EXPLAIN QUERY PLAN` is what proves the predicate is in SQL rather
      // than in a JS filter over a materialized scan: the plan must name the
      // partial owner-recency index, and must NOT sort (a temp b-tree here
      // is a sort of every matching row, payload column included, which is
      // what took 2.1 s and 850 MB on the live store).
      const inspector = new DatabaseSync(join(dir, 'orchestration.sqlite'));
      try {
        const plan = (
          inspector
            .prepare(
              `EXPLAIN QUERY PLAN
               SELECT json_extract(payload, '$.metadata.userId') AS user_id
               FROM orchestration_events
               WHERE thread_id = ?
                 AND json_valid(payload)
                 AND json_extract(payload, '$.metadata.userId') IS NOT NULL
                 AND json_type(payload, '$.metadata.userId') = 'text'
                 AND method IN ('session.started', 'session.configured')
               ORDER BY created_at DESC, sequence DESC
               LIMIT 1`,
            )
            .all(threadId) as { detail: string }[]
        )
          .map((row) => row.detail)
          .join('\n');

        expect(plan).toContain('idx_events_thread_owner_recency');
        expect(plan).not.toContain('TEMP B-TREE');
      } finally {
        inspector.close();
      }
    });

    test('a payload that is not JSON cannot break the read or the index', () => {
      // `json_extract` RAISES on malformed JSON, and the partial index
      // evaluates its WHERE clause against every row in the table — so one
      // unparseable payload would abort the migration and fail boot without
      // the `json_valid(payload)` guard. Write one directly, bypassing the
      // JSON-producing append path.
      const writer = new DatabaseSync(join(dir, 'orchestration.sqlite'));
      try {
        writer
          .prepare(
            `INSERT INTO orchestration_events
               (id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence)
             VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            'evt-3495-malformed',
            'claude',
            'thread-3495-malformed',
            'session.started',
            'not json at all',
            '2026-08-19T00:00:00.000Z',
            1,
            9_999_999,
          );

        // DIVERGENCE FROM THE SCAN, disclosed rather than absorbed: the old
        // path reached this row through `mapPersistedEventRow`, whose
        // `JSON.parse(row.payload)` is unguarded, so a malformed payload made
        // `sessionOwnerUserId` THROW — fail-closed, no owner resolved and no
        // read served. The SQL path skips the row instead and can resolve
        // `undefined`, which under `ownerlessSessionAccess:
        // 'single-user-compat'` makes the session READABLE. That is the
        // WIDENING direction, and it is the one divergence in this branch
        // that is not restrictive.
        //
        // Accepted, with the reasons stated. Reachability is LOW, not nil:
        // every append serializes with `JSON.stringify`, but SQLite's JSON
        // parser caps nesting at 1000 levels, and `json_valid` returns 0 from
        // ~998 levels down — a payload of only ~6 KB. Nothing in `src-server`
        // guards depth (`persistedForm` strips attachments only), so a
        // sufficiently nested runtime-authored `metadata` reaches this branch
        // without a direct write to the database file. Ownership-event
        // metadata is nowhere near that deep in practice, so the realistic
        // path remains a direct write — as this test does. And an
        // authorization gate that throws on one corrupt row
        // anywhere on a thread is worse behaviour than one that ignores it,
        // because it takes down the read for every event on that thread. The
        // assertion below is the divergence, not just the value.
        expect(
          store.findSessionOwnerUserId('thread-3495-malformed'),
        ).toBeUndefined();
        // And the index the query depends on still BUILDS over that row.
        // Without `json_valid(payload)` this throws `malformed JSON`, which
        // in the migration means boot fails on an existing database.
        expect(() =>
          writer.exec(
            `CREATE INDEX IF NOT EXISTS idx_events_thread_owner_recency_probe
               ON orchestration_events(thread_id, created_at, sequence)
               WHERE json_valid(payload)
                 AND json_extract(payload, '$.metadata.userId') IS NOT NULL`,
          ),
        ).not.toThrow();
        // The unguarded form — the one an audit would prescribe — does not.
        expect(() =>
          writer.exec(
            `CREATE INDEX IF NOT EXISTS idx_events_owner_unguarded_probe
               ON orchestration_events(thread_id, sequence)
               WHERE json_extract(payload, '$.metadata.userId') IS NOT NULL`,
          ),
        ).toThrow(/malformed JSON/i);
      } finally {
        writer.close();
      }

      // The migration runs on every open, so the guard has to hold THERE, not
      // just in an ad-hoc probe: reopening a store whose table already holds
      // that row must not throw. This is the assertion that fails if the
      // migration's index predicate loses its `json_valid(payload)` term.
      store.close();
      let reopened: EventStore | undefined;
      expect(() => {
        reopened = new EventStore(join(dir, 'orchestration.sqlite'));
      }).not.toThrow();
      reopened?.close();
      store = new EventStore(join(dir, 'orchestration.sqlite'));
    });
  });

  // archive#3495: the follow service's cold path needs ONE fact from the log
  // (the attribution its newest `session.configured` expresses) and used to
  // read every ownership-shaped row on the thread to get it.
  test('lists the newest session.configured events for a thread, bounded (station#3495)', () => {
    const threadId = 'thread-3495-configured';
    const methods = [
      'session.configured',
      'content.text-delta',
      'session.started',
      'session.configured',
      'tool.completed',
      'session.configured',
    ];
    methods.forEach((method, index) => {
      store.appendEvent({
        eventId: `evt-cfg-${index}`,
        provider: 'claude',
        threadId,
        createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
        method,
        ...(method === 'content.text-delta' ? { delta: 'x' } : {}),
      } as never);
    });

    const recent = store.listRecentConfiguredEventsByThread(threadId, 64);
    expect(recent.map((event) => event.id)).toEqual([
      'evt-cfg-5',
      'evt-cfg-3',
      'evt-cfg-0',
    ]);

    // Same rows, same order as the scan it replaces — restricted to the one
    // method the caller reads.
    const fullReverseScan = [...store.listEvents(threadId)]
      .reverse()
      .filter((event) => event.method === 'session.configured');
    expect(recent).toEqual(fullReverseScan);

    // The bound is honoured, newest-first.
    expect(
      store
        .listRecentConfiguredEventsByThread(threadId, 2)
        .map((event) => event.id),
    ).toEqual(['evt-cfg-5', 'evt-cfg-3']);
    expect(
      store.listRecentConfiguredEventsByThread('absent-thread', 64),
    ).toEqual([]);
  });

  test('persists only bounded recovery intent state and atomically claims a due intent once', () => {
    const intent = recoveryLedger(store).arm({
      fingerprint: 'thread-1:turn-1:rate-limit:server',
      threadId: 'thread-1',
      provider: 'claude',
      sourceEventId: 'evt-started',
      sourceTurnId: 'turn-1',
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'wait-until-reset',
      dueAt: '2026-07-29T12:00:00.000Z',
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: '2026-07-29T11:59:00.000Z',
      updatedAt: '2026-07-29T11:59:00.000Z',
    });
    expect(intent).not.toHaveProperty('prompt');
    expect(intent).not.toHaveProperty('message');
    expect(recoveryLedger(store).latestProjection('thread-1')).toEqual({
      failureKind: 'rate-limit',
      scope: 'server',
      decision: 'wait-until-reset',
      outcome: 'armed',
      dueAt: '2026-07-29T12:00:00.000Z',
      attempts: 0,
      maxAttempts: 1,
      updatedAt: '2026-07-29T11:59:00.000Z',
    });
    const settlement = recoveryLedger(store);
    expect(
      settlement.claim({
        fingerprint: intent.fingerprint,
        kind: 'due',
        now: '2026-07-29T11:59:59.000Z',
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(
      settlement.claim({
        fingerprint: intent.fingerprint,
        kind: 'due',
        now: '2026-07-29T12:00:00.000Z',
      }),
    ).toMatchObject({ kind: 'owner' });
    expect(recoveryLedger(store).find(intent.fingerprint)).toMatchObject({
      outcome: 'resumed',
      attempts: 1,
      dispatchSettlement: 'prepared',
    });
    expect(
      settlement.claim({
        fingerprint: intent.fingerprint,
        kind: 'due',
        now: '2026-07-29T12:00:01.000Z',
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  test.each(['manual', 'armed'] as const)(
    'atomically claims a staged credential-profile recovery from %s without waiting for reset timing',
    (outcome) => {
      const intent = recoveryLedger(store).arm({
        fingerprint: `thread-profile:turn-profile:capacity:account:${outcome}`,
        threadId: `thread-profile-${outcome}`,
        provider: 'codex',
        sourceEventId: 'evt-profile-started',
        sourceTurnId: 'turn-profile',
        failureKind: 'capacity',
        scope: 'account',
        decision: outcome === 'manual' ? 'manual' : 'wait-until-reset',
        ...(outcome === 'armed' ? { dueAt: '2026-07-29T13:00:00.000Z' } : {}),
        maxAttempts: 1,
        outcome,
        createdAt: '2026-07-29T12:00:00.000Z',
        updatedAt: '2026-07-29T12:00:00.000Z',
      });

      const claim = recoveryLedger(store).claim({
        fingerprint: intent.fingerprint,
        kind: 'profile',
        now: '2026-07-29T12:00:00.000Z',
      });
      expect(claim).toMatchObject({ kind: 'owner' });
      expect(recoveryLedger(store).find(intent.fingerprint)).toMatchObject({
        outcome: 'resumed',
        attempts: 1,
        dispatchKind: 'profile',
      });
      expect(
        recoveryLedger(store).claim({
          fingerprint: intent.fingerprint,
          kind: 'profile',
          now: '2026-07-29T12:00:01.000Z',
        }),
      ).toEqual({ kind: 'unavailable' });
    },
  );

  test('migrates a legacy resumed dispatch to durable indeterminate while retaining its observed turn', () => {
    const path = join(dir, 'legacy-recovery-settlement.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE orchestration_recovery_intents (
        fingerprint TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        failure_kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        decision TEXT NOT NULL,
        due_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        resumed_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO orchestration_recovery_intents
        (fingerprint, thread_id, provider, source_event_id, source_turn_id,
         failure_kind, scope, decision, attempts, max_attempts, outcome,
         resumed_turn_id, created_at, updated_at)
      VALUES
        ('legacy:turn:capacity:account', 'legacy-thread', 'claude', 'event', 'turn',
         'capacity', 'account', 'retry-now', 1, 1, 'resumed', 'observed-turn',
         '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = new EventStore(path);
    expect(
      recoveryLedger(migrated).find('legacy:turn:capacity:account'),
    ).toMatchObject({
      outcome: 'indeterminate',
      resumedTurnId: 'observed-turn',
    });
    migrated.close();
  });

  test('waits through writer contention before recovery-settlement migration', async () => {
    const path = join(dir, 'concurrent-recovery-settlement.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE orchestration_recovery_intents (
        fingerprint TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL,
        source_event_id TEXT NOT NULL, source_turn_id TEXT NOT NULL,
        failure_kind TEXT NOT NULL, scope TEXT NOT NULL, decision TEXT NOT NULL,
        due_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
        outcome TEXT NOT NULL, resumed_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    legacy.close();
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 120);`,
        path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.once('data', () => resolve());
    });
    const first = new EventStore(path);
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)),
      );
    });
    const second = new EventStore(path);
    recoveryLedger(first).arm({
      fingerprint: 'after-migration:turn:capacity:account',
      threadId: 'after-migration',
      provider: 'codex',
      sourceEventId: 'event',
      sourceTurnId: 'turn',
      failureKind: 'capacity',
      scope: 'account',
      decision: 'retry-now',
      dueAt: '2026-08-13T00:00:00.000Z',
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    });
    expect(
      recoveryLedger(second).find('after-migration:turn:capacity:account'),
    ).toBeTruthy();
    first.close();
    second.close();
  });

  test('reads bounded event pages after a stable per-thread sequence', () => {
    for (let index = 1; index <= 4; index += 1) {
      store.appendEvent({
        eventId: `evt-${index}`,
        provider: 'claude',
        threadId: 'thread-page',
        createdAt: `2026-03-28T00:00:0${index}.000Z`,
        method: 'content.text-delta',
        itemId: 'item-1',
        delta: String(index),
      });
    }
    store.appendEvent({
      eventId: 'other-thread',
      provider: 'claude',
      threadId: 'thread-other',
      createdAt: '2026-03-28T00:00:05.000Z',
      method: 'session.started',
      sessionId: 'thread-other',
    });

    expect(
      store.listEventPage('thread-page', { afterSequence: 1, limit: 2 }),
    ).toEqual({
      events: [
        expect.objectContaining({ id: 'evt-2', sequence: 2 }),
        expect.objectContaining({ id: 'evt-3', sequence: 3 }),
      ],
      hasMore: true,
      nextSequence: 3,
    });
    expect(
      store.listEventPage('thread-page', { afterSequence: 3, limit: 2 }),
    ).toEqual({
      events: [expect.objectContaining({ id: 'evt-4', sequence: 4 })],
      hasMore: false,
      nextSequence: 4,
    });
  });

  describe('global_sequence resume cursor (station#1092)', () => {
    test('assigns a monotonic global_sequence across threads, independent of per-thread sequence', () => {
      store.appendEvent({
        eventId: 'evt-a1',
        provider: 'claude',
        threadId: 'thread-a',
        createdAt: '2026-03-28T00:00:00.000Z',
        method: 'session.started',
        sessionId: 'thread-a',
      });
      store.appendEvent({
        eventId: 'evt-b1',
        provider: 'claude',
        threadId: 'thread-b',
        createdAt: '2026-03-28T00:00:01.000Z',
        method: 'session.started',
        sessionId: 'thread-b',
      });
      store.appendEvent({
        eventId: 'evt-a2',
        provider: 'claude',
        threadId: 'thread-a',
        createdAt: '2026-03-28T00:00:02.000Z',
        method: 'session.configured',
        sessionId: 'thread-a',
        model: 'claude-sonnet-4-5',
      });

      expect(store.listEvents('thread-a')).toEqual([
        expect.objectContaining({
          id: 'evt-a1',
          sequence: 1,
          globalSequence: 1,
        }),
        expect.objectContaining({
          id: 'evt-a2',
          sequence: 2,
          globalSequence: 3,
        }),
      ]);
      expect(store.headGlobalSequence()).toBe(3);
      expect(store.readGlobalSequence('evt-b1')).toBe(2);
      expect(store.readGlobalSequence('does-not-exist')).toBeUndefined();
    });

    test('listEventsAfterGlobalSequence replays in cross-thread order, optionally scoped to one thread', () => {
      for (const [eventId, threadId] of [
        ['evt-1', 'thread-x'],
        ['evt-2', 'thread-y'],
        ['evt-3', 'thread-x'],
        ['evt-4', 'thread-y'],
      ] as const) {
        store.appendEvent({
          eventId,
          provider: 'claude',
          threadId,
          createdAt: `2026-03-28T00:00:0${eventId.slice(-1)}.000Z`,
          method: 'content.text-delta',
          itemId: 'item-1',
          delta: eventId,
        });
      }

      expect(
        store.listEventsAfterGlobalSequence(0, { limit: 10 }).map((e) => e.id),
      ).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4']);
      expect(
        store.listEventsAfterGlobalSequence(2, { limit: 10 }).map((e) => e.id),
      ).toEqual(['evt-3', 'evt-4']);
      expect(
        store
          .listEventsAfterGlobalSequence(0, { threadId: 'thread-x', limit: 10 })
          .map((e) => e.id),
      ).toEqual(['evt-1', 'evt-3']);
      expect(store.listEventsAfterGlobalSequence(4, { limit: 10 })).toEqual([]);
    });

    test('appendEventIfAbsent leaves no gap in global_sequence when the insert is ignored', () => {
      const event = {
        eventId: 'evt-idem-global',
        provider: 'claude' as const,
        threadId: 'thread-idem',
        createdAt: '2026-03-28T00:00:00.000Z',
        method: 'content.text-delta' as const,
        itemId: 'item-1',
        delta: 'hello',
      };
      store.appendEventIfAbsent(event);
      store.appendEventIfAbsent(event); // ignored — already exists
      store.appendEvent({
        eventId: 'evt-after-idem',
        provider: 'claude',
        threadId: 'thread-idem',
        createdAt: '2026-03-28T00:00:01.000Z',
        method: 'content.text-delta',
        itemId: 'item-1',
        delta: 'world',
      });

      expect(store.headGlobalSequence()).toBe(2);
      expect(store.readGlobalSequence('evt-after-idem')).toBe(2);
    });

    test('a pre-#1092 database (no global_sequence column) self-heals via the migration backfill', () => {
      // Build the table with the exact pre-#1092 schema — no global_sequence
      // column at all — and pre-existing rows in a known created_at/sequence
      // order, so opening it through EventStore must both add the column
      // AND backfill it in that same order (not just default every row to 0).
      store.close();
      const legacyDbPath = join(dir, 'legacy-orchestration.sqlite');
      const legacyDb = new DatabaseSync(legacyDbPath);
      legacyDb.exec(`
        CREATE TABLE orchestration_events (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          method TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sequence INTEGER NOT NULL
        );
      `);
      const insert = legacyDb.prepare(
        `INSERT INTO orchestration_events (id, provider, thread_id, method, payload, created_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        'evt-legacy-1',
        'claude',
        'thread-legacy',
        'session.started',
        '{}',
        '2026-01-01T00:00:00.000Z',
        1,
      );
      insert.run(
        'evt-legacy-2',
        'claude',
        'thread-legacy',
        'session.configured',
        '{}',
        '2026-01-01T00:00:01.000Z',
        2,
      );
      legacyDb.close();

      store = new EventStore(legacyDbPath);
      expect(store.readGlobalSequence('evt-legacy-1')).toBe(1);
      expect(store.readGlobalSequence('evt-legacy-2')).toBe(2);
      expect(store.headGlobalSequence()).toBe(2);

      // A fresh append after the backfill continues the sequence, not a
      // brand-new count from 0.
      store.appendEvent({
        eventId: 'evt-fresh',
        provider: 'claude',
        threadId: 'thread-legacy',
        createdAt: '2026-01-01T00:00:02.000Z',
        method: 'session.state-changed',
        sessionId: 'thread-legacy',
        from: 'idle',
        to: 'running',
      });
      expect(store.readGlobalSequence('evt-fresh')).toBe(3);
    });

    test('review fix (MEDIUM): the per-thread replay query plan uses the composite (thread_id, global_sequence) index, no temp b-tree sort', () => {
      // A separate read-only-in-practice connection onto the same file
      // EventStore already migrated — EXPLAIN QUERY PLAN isn't part of the
      // EventStore's own public surface.
      const planDb = new DatabaseSync(join(dir, 'orchestration.sqlite'));
      const plan = planDb
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
           FROM orchestration_events
           WHERE thread_id = ? AND global_sequence > ?
           ORDER BY global_sequence ASC
           LIMIT ?`,
        )
        .all('thread-a', 0, 10) as Array<{ detail: string }>;
      planDb.close();

      const detail = plan.map((row) => row.detail).join(' | ');
      expect(detail).toContain('idx_events_thread_global_sequence');
      // Without the composite index, this query plans as a SEARCH on
      // idx_events_thread (sorted by `sequence`, not `global_sequence`)
      // followed by exactly this line — reproduced live before adding the
      // index, see the PR body's pasted plan.
      expect(detail).not.toContain('TEMP B-TREE');
    });

    test('review fix (MEDIUM): a legacy backlog larger than one backfill batch preserves ordering across batches', {
      timeout: 15_000,
    }, () => {
      // Row count deliberately crosses TWO batch boundaries (> 2x the batch
      // size) so this cannot pass by accident if a bug only manifests on
      // the second batch's starting-cursor arithmetic.
      const rowCount = GLOBAL_SEQUENCE_BACKFILL_BATCH_SIZE * 2 + 50;
      store.close();
      const legacyDbPath = join(dir, 'legacy-multi-batch.sqlite');
      const legacyDb = new DatabaseSync(legacyDbPath);
      legacyDb.exec(`
        CREATE TABLE orchestration_events (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          method TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sequence INTEGER NOT NULL
        );
      `);
      const insert = legacyDb.prepare(
        `INSERT INTO orchestration_events (id, provider, thread_id, method, payload, created_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const baseMs = Date.parse('2026-01-01T00:00:00.000Z');
      for (let index = 0; index < rowCount; index += 1) {
        insert.run(
          `evt-legacy-${index}`,
          'claude',
          'thread-legacy',
          'content.text-delta',
          '{}',
          new Date(baseMs + index).toISOString(),
          index + 1,
        );
      }
      legacyDb.close();

      store = new EventStore(legacyDbPath);

      expect(store.headGlobalSequence()).toBe(rowCount);
      // Spot-check across all three batches: start, a row inside the
      // second batch (past the first boundary), and the very last row.
      expect(store.readGlobalSequence('evt-legacy-0')).toBe(1);
      expect(
        store.readGlobalSequence(
          `evt-legacy-${GLOBAL_SEQUENCE_BACKFILL_BATCH_SIZE + 10}`,
        ),
      ).toBe(GLOBAL_SEQUENCE_BACKFILL_BATCH_SIZE + 11);
      expect(store.readGlobalSequence(`evt-legacy-${rowCount - 1}`)).toBe(
        rowCount,
      );

      // Full-order check: every row's global_sequence matches its
      // created_at-ascending position exactly (no batch-boundary
      // duplication, skip, or reordering).
      const ordered = store.listEvents();
      expect(ordered).toHaveLength(rowCount);
      for (let index = 0; index < rowCount; index += 1) {
        expect(ordered[index]).toMatchObject({
          id: `evt-legacy-${index}`,
          globalSequence: index + 1,
        });
      }
    });
  });

  describe('attachment bytes (station#3374)', () => {
    const pixels = Buffer.alloc(6 * 1024, 7);
    const base64 = pixels.toString('base64');
    const dataUrl = `data:image/png;base64,${base64}`;

    const attachmentTurn = (eventId: string, threadId: string) =>
      ({
        eventId,
        provider: 'claude' as const,
        threadId,
        createdAt: '2026-08-19T00:00:00.000Z',
        method: 'turn.started' as const,
        turnId: `turn-${eventId}`,
        prompt: 'what is in this screenshot?',
        attachments: [
          {
            kind: 'image' as const,
            name: 'screenshot.png',
            mimeType: 'image/png' as const,
            size: pixels.length,
            dataUrl,
          },
        ],
      }) as any;

    const attachmentTurnWithBytes = (
      eventId: string,
      threadId: string,
      attachmentBytes: number,
    ) => {
      const bytes = Buffer.alloc(attachmentBytes, 4);
      return {
        ...attachmentTurn(eventId, threadId),
        attachments: [
          {
            kind: 'image' as const,
            name: 'large.png',
            mimeType: 'image/png' as const,
            size: bytes.length,
            dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
          },
        ],
      } as any;
    };

    const withDatabase = <T>(
      run: (db: InstanceType<typeof DatabaseSync>) => T,
    ): T => {
      const db = new DatabaseSync(join(dir, 'orchestration.sqlite'));
      try {
        return run(db);
      } finally {
        db.close();
      }
    };

    const persistedRow = (threadId: string) =>
      withDatabase((db) =>
        JSON.parse(
          (
            db
              .prepare(
                `SELECT payload FROM orchestration_events
                 WHERE thread_id = ? AND method = 'turn.started'`,
              )
              .get(threadId) as { payload: string }
          ).payload,
        ),
      );

    test('the persisted row carries a reference, not the bytes', () => {
      store.appendEvent(attachmentTurn('evt-blob', 'thread-blob'));

      const payload = persistedRow('thread-blob');

      expect(payload.attachments[0].blobRef).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(payload.attachments[0].dataUrl).toBeUndefined();
      expect(payload.attachments[0]).toMatchObject({
        kind: 'image',
        name: 'screenshot.png',
        mimeType: 'image/png',
        size: pixels.length,
      });
      // The point of the change: the row itself no longer grows with the
      // attachment. Assert the row, not merely the absence of a field.
      expect(JSON.stringify(payload).length).toBeLessThan(base64.length);
    });

    test.each([
      [
        'appendEvent with a 100 KiB data URL',
        100 * 1024,
        (event: CanonicalRuntimeEvent) => store.appendEvent(event),
      ],
      [
        'appendEventIfAbsent with a 5 MiB data URL',
        CHAT_ATTACHMENT_MAX_BYTES,
        (event: CanonicalRuntimeEvent) => store.appendEventIfAbsent(event),
      ],
    ])('%s stores a bounded blob reference', (_label, byteLength, append) => {
      const eventId = `evt-large-${byteLength}`;
      const threadId = `thread-large-${byteLength}`;

      append(attachmentTurnWithBytes(eventId, threadId, byteLength));

      const payload = persistedRow(threadId);
      expect(payload.attachments[0]).toMatchObject({
        name: 'large.png',
        size: byteLength,
      });
      expect(payload.attachments[0].blobRef).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(payload.attachments[0].dataUrl).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('data:image/png;base64,');
    });

    test('projectLiveEvent applies the same attachment ingress seam', () => {
      const event = attachmentTurnWithBytes(
        'evt-live-large',
        'thread-live-large',
        100 * 1024,
      );

      const projected = store.projectLiveEvent(event);
      expect(projected.method).toBe('turn.started');
      const [attachment] =
        (
          projected as Extract<
            CanonicalRuntimeEvent,
            { method: 'turn.started' }
          >
        ).attachments ?? [];
      expect(attachment).toMatchObject({
        name: 'large.png',
        size: 100 * 1024,
      });
      expect(attachment?.dataUrl).toBeUndefined();
      expect(attachment?.blobRef).toMatch(/^sha256-[0-9a-f]{64}$/);

      store.appendEvent(projected);
      expect(
        persistedRow('thread-live-large').attachments[0].dataUrl,
      ).toBeUndefined();
    });

    test('refuses attachment count, per-file, and combined-byte overages before blob writes', () => {
      const before = existsSync(join(dir, 'attachments'))
        ? readdirSync(join(dir, 'attachments')).length
        : 0;
      const overage = attachmentTurnWithBytes(
        'evt-attachment-overage',
        'thread-attachment-overage',
        CHAT_ATTACHMENT_MAX_BYTES + 1,
      );
      expect(() => store.appendEvent(overage)).toThrow('attachment exceeds');

      const combined = Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES, 5);
      const combinedDataUrl = `data:image/png;base64,${combined.toString('base64')}`;
      expect(() =>
        store.appendEvent({
          ...attachmentTurn(
            'evt-attachment-combined',
            'thread-attachment-combined',
          ),
          attachments: Array.from({ length: 4 }, (_, index) => ({
            kind: 'image' as const,
            name: `combined-${index}.png`,
            mimeType: 'image/png' as const,
            size: combined.length,
            dataUrl: combinedDataUrl,
          })),
        }),
      ).toThrow('combined limit');

      expect(() =>
        store.appendEvent({
          ...attachmentTurn('evt-attachment-count', 'thread-attachment-count'),
          attachments: Array.from({ length: 6 }, () => ({
            kind: 'image' as const,
            name: 'count.png',
            mimeType: 'image/png' as const,
            size: pixels.length,
            dataUrl,
          })),
        }),
      ).toThrow('more than 5 attachments');
      expect(store.listEvents('thread-attachment-overage')).toEqual([]);
      expect(store.listEvents('thread-attachment-combined')).toEqual([]);
      expect(store.listEvents('thread-attachment-count')).toEqual([]);
      const after = existsSync(join(dir, 'attachments'))
        ? readdirSync(join(dir, 'attachments')).length
        : 0;
      expect(after).toBe(before);
    });

    test('does not grant another event or a nested dataUrl the attachment allowance', () => {
      const largeDataUrl = `data:image/png;base64,${Buffer.alloc(100 * 1024, 3).toString('base64')}`;
      const fake = {
        ...attachmentTurn('evt-nested-data-url', 'thread-nested-data-url'),
        metadata: { attachments: [{ dataUrl: largeDataUrl }] },
      };
      delete (fake as { attachments?: unknown }).attachments;
      expect(() => store.appendEvent(fake as CanonicalRuntimeEvent)).toThrow(
        'ingress ceiling',
      );
      expect(() =>
        store.appendEvent({
          ...fake,
          eventId: 'evt-other-method-data-url',
          method: 'turn.completed',
          attachments: [{ dataUrl: largeDataUrl }],
        } as any),
      ).toThrow('ingress ceiling');
    });

    test('projectLiveEvent refuses a hostile canonical attachment without reading it', () => {
      let dataUrlReads = 0;
      const attachment = Object.defineProperty(
        {
          kind: 'image',
          name: 'getter.png',
          mimeType: 'image/png',
          size: pixels.length,
        },
        'dataUrl',
        {
          enumerable: true,
          get: () => {
            dataUrlReads += 1;
            throw new Error('the data URL getter must never execute');
          },
        },
      );
      expect(() =>
        store.projectLiveEvent({
          ...attachmentTurn('evt-hostile-live', 'thread-hostile-live'),
          attachments: [attachment],
        }),
      ).toThrow('cannot be safely persisted');
      expect(dataUrlReads).toBe(0);
      expect(store.listEvents('thread-hostile-live')).toEqual([]);
    });

    test('reads an exact user-input descriptor without hydrating attachment bytes', () => {
      store.appendEvent(attachmentTurn('evt-input-descriptor', 'thread-input'));
      const read = vi.spyOn((store as any).attachmentBlobs, 'read');
      const descriptor = store.userInputEventById('evt-input-descriptor');
      expect(descriptor).toEqual({
        eventId: 'evt-input-descriptor',
        threadId: 'thread-input',
        turnId: 'turn-evt-input-descriptor',
        method: 'turn.started',
        inputKind: 'initial',
        prompt: 'what is in this screenshot?',
        attachments: [
          {
            name: 'screenshot.png',
            mimeType: 'image/png',
            size: pixels.length,
          },
        ],
      });
      expect(read).not.toHaveBeenCalled();
    });

    test('reads an exact Basis descriptor window without payload mapping or blob hydration', () => {
      store.appendEvent(attachmentTurn('basis-start', 'basis-thread'));
      store.appendEvent({
        eventId: 'basis-tool',
        provider: 'claude',
        threadId: 'basis-thread',
        turnId: 'turn-basis-start',
        itemId: 'i',
        createdAt: '2026-08-19T00:00:01.000Z',
        method: 'tool.completed',
        toolCallId: 'call',
        toolName: 'shell',
        status: 'success',
        output: { url: 'https://private.invalid', bytes: 'never' },
      } as any);
      store.appendEvent({
        eventId: 'basis-text',
        provider: 'claude',
        threadId: 'basis-thread',
        turnId: 'turn-basis-start',
        createdAt: '2026-08-19T00:00:02.000Z',
        method: 'content.text-delta',
        delta: 'answer',
      } as any);
      store.appendEvent({
        eventId: 'basis-done',
        provider: 'claude',
        threadId: 'basis-thread',
        turnId: 'turn-basis-start',
        createdAt: '2026-08-19T00:00:03.000Z',
        method: 'turn.completed',
      } as any);
      const map = vi.spyOn(store as any, 'mapEventRow');
      const blobs = vi.spyOn((store as any).attachmentBlobs, 'read');
      const result = store.listBasisEventsForTurn(
        'basis-thread',
        'turn-basis-start',
      );
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(
          result.events.find((event) => event.eventId === 'basis-start'),
        ).toMatchObject({
          input: { attachments: [{ name: 'screenshot.png' }] },
        });
        expect(
          result.events.find((event) => event.eventId === 'basis-tool'),
        ).toMatchObject({ tool: { eventId: 'basis-tool' } });
        expect(
          result.events.find((event) => event.eventId === 'basis-text'),
        ).toMatchObject({ textDelta: true });
      }
      expect(JSON.stringify(result)).not.toContain('private.invalid');
      expect(JSON.stringify(result)).not.toContain('never');
      expect(map).not.toHaveBeenCalled();
      expect(blobs).not.toHaveBeenCalled();
    });

    test('Basis derives answer facts only from text deltas or bounded terminal outputText, with a complete indexed window', () => {
      const threadId = 'basis-facts-thread';
      const turnId = 'basis-facts-turn';
      const append = (eventId: string, method: string, extra = {}) =>
        store.appendEvent({
          eventId,
          provider: 'claude',
          threadId,
          turnId,
          createdAt: '2026-08-19T00:00:00.000Z',
          method,
          ...extra,
        } as any);
      append('basis-facts-start', 'turn.started', { prompt: 'ask' });
      append('basis-reasoning', 'content.reasoning-delta', {
        delta: 'private reasoning',
      });
      append('basis-output', 'turn.completed', { outputText: 'public answer' });

      const prepared = vi.spyOn((store as any).db, 'prepare');
      const result = store.listBasisEventsForTurn(threadId, turnId);
      expect(result).toMatchObject({ status: 'found' });
      if (result.status === 'found') {
        expect(
          result.events.find((event) => event.eventId === 'basis-reasoning'),
        ).not.toHaveProperty('textDelta');
        expect(
          result.events.find((event) => event.eventId === 'basis-output'),
        ).toMatchObject({ outputText: true });
        expect(JSON.stringify(result)).not.toContain('public answer');
        expect(JSON.stringify(result)).not.toContain('private reasoning');
      }

      const sql = prepared.mock.calls.map(([statement]) => String(statement));
      prepared.mockRestore();
      const preflight = sql.find(
        (statement) =>
          statement.includes('SELECT id') &&
          statement.includes('idx_events_thread_turn_sequence'),
      );
      const descriptor = sql.find((statement) =>
        statement.includes('WITH candidate AS'),
      );
      expect(preflight).toBeDefined();
      expect(descriptor).toBeDefined();
      expect(descriptor).not.toContain('COUNT(*) OVER()');
      const planFor = (statement: string, values: unknown[]) =>
        withDatabase((db) =>
          (
            db
              .prepare(`EXPLAIN QUERY PLAN ${statement}`)
              .all(...values) as Array<{ detail: string }>
          )
            .map((row) => row.detail)
            .join('\n'),
        );
      const preflightPlan = planFor(preflight!, [threadId, turnId, 1_001]);
      const descriptorPlan = planFor(descriptor!, [
        threadId,
        turnId,
        1_000,
        ...Array.from({ length: 13 }, () => 1),
      ]);
      for (const plan of [preflightPlan, descriptorPlan]) {
        expect(plan).toContain('idx_events_thread_turn_sequence');
        expect(plan).not.toContain('SCAN orchestration_events');
        expect(plan).not.toContain('TEMP B-TREE');
      }
    });

    test('Basis fails closed for noncanonical input kinds, oversized descriptor metadata, and attachment expansion', () => {
      const insert = (
        id: string,
        turnId: string,
        method: string,
        payload: unknown,
      ) =>
        withDatabase((db) =>
          db
            .prepare(
              `INSERT INTO orchestration_events
                 (id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence)
               VALUES (?, 'claude', 'basis-corrupt-thread', ?, ?, ?, '2026-08-19T00:00:00.000Z', ?, ?)`,
            )
            .run(
              id,
              turnId,
              method,
              JSON.stringify(payload),
              id.length,
              id.length,
            ),
        );
      insert('input-kind', 'input-kind', 'turn.started', {
        prompt: 'ask',
        inputKind: 'initial',
      });
      insert('over-tool', 'over-tool', 'tool.completed', {
        toolCallId: '😀'.repeat(2_000),
        toolName: 'shell',
        status: 'success',
      });
      insert('attachment-over', 'attachment-over', 'turn.started', {
        prompt: 'ask',
        attachments: Array.from({ length: 6 }, () => ({
          kind: 'image',
          name: 'safe.png',
          mimeType: 'image/png',
          size: 1,
        })),
      });
      for (const turnId of ['input-kind', 'over-tool', 'attachment-over']) {
        expect(
          store.listBasisEventsForTurn('basis-corrupt-thread', turnId),
        ).toEqual({ status: 'corrupt' });
      }
    });

    test('uses the indexed identity preflight to refuse a descriptor window over its row budget', () => {
      const threadId = 'basis-over-budget-thread';
      const turnId = 'basis-over-budget-turn';
      const insert = (store as any).db.prepare(
        `INSERT INTO orchestration_events
           (id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence)
         VALUES (?, 'claude', ?, ?, 'runtime.note', '{}', '2026-08-19T00:00:00.000Z', ?, ?)`,
      );
      for (let index = 0; index <= 1_000; index += 1) {
        insert.run(
          `basis-over-budget-${index}`,
          threadId,
          turnId,
          index,
          100_000 + index,
        );
      }
      expect(store.listBasisEventsForTurn(threadId, turnId)).toEqual({
        status: 'over-budget',
      });
    });

    test('reads one exact terminal tool-result descriptor without replaying the Session', () => {
      store.appendEvent({
        eventId: 'evt-tool-result-descriptor',
        provider: 'claude',
        threadId: 'thread-tool-result',
        turnId: 'turn-tool-result',
        itemId: 'item-tool-result',
        createdAt: '2026-08-19T00:00:00.000Z',
        method: 'tool.completed',
        toolCallId: 'reused-call-id',
        toolName: 'shell',
        status: 'error',
        error: 'failed safely',
        policyDenied: true,
      });
      expect(
        store.toolCompletedEventById(
          'thread-tool-result',
          'evt-tool-result-descriptor',
        ),
      ).toEqual({
        eventId: 'evt-tool-result-descriptor',
        threadId: 'thread-tool-result',
        turnId: 'turn-tool-result',
        method: 'tool.completed',
        toolCallId: 'reused-call-id',
        toolName: 'shell',
        status: 'error',
        error: 'failed safely',
        policyDenied: true,
      });
      expect(
        store.toolCompletedEventById(
          'thread-tool-result',
          'missing-tool-result',
        ),
      ).toBeUndefined();
      // Source ownership belongs in the SQL predicate. A foreign event id
      // cannot trigger descriptor parsing or disclose a shape to this caller.
      expect(
        store.toolCompletedEventById(
          'foreign-thread',
          'evt-tool-result-descriptor',
        ),
      ).toBeUndefined();
      const restarted = new EventStore(join(dir, 'orchestration.sqlite'));
      try {
        expect(
          restarted.toolCompletedEventById(
            'thread-tool-result',
            'evt-tool-result-descriptor',
          ),
        ).toMatchObject({ eventId: 'evt-tool-result-descriptor' });
      } finally {
        restarted.close();
      }
    });

    test('uses UTF-8 byte limits and rejects an oversized descriptor at ingress', () => {
      // Four-byte UTF-8 glyphs leave room for the event envelope below the
      // new 64 KiB ingress ceiling.
      const exact = '😀'.repeat(15_000);
      store.appendEvent({
        eventId: 'evt-tool-result-utf8-boundary',
        provider: 'claude',
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'item',
        createdAt: '2026-08-19T00:00:00.000Z',
        method: 'tool.completed',
        toolCallId: 'call',
        toolName: 'shell',
        status: 'success',
        output: exact,
      });
      expect(
        store.toolCompletedEventById('thread', 'evt-tool-result-utf8-boundary'),
      ).toMatchObject({ output: exact });
      expect(() =>
        store.appendEvent({
          eventId: 'evt-tool-result-overflow',
          provider: 'claude',
          threadId: 'thread',
          turnId: 'turn',
          itemId: 'item',
          createdAt: '2026-08-19T00:00:00.000Z',
          method: 'tool.completed',
          toolCallId: 'call',
          toolName: 'shell',
          status: 'success',
          output: '😀'.repeat(16_384),
        }),
      ).toThrow('ingress ceiling');
      expect(
        store.toolCompletedEventById('thread', 'evt-tool-result-overflow'),
      ).toBeUndefined();
    });

    test('bounds both event insert paths before JSON serialization', () => {
      const stringify = vi.spyOn(JSON, 'stringify');
      const oversized = '😀'.repeat(MAX_EVENT_STORE_INGRESS_BYTES);
      const appenders = [
        (event: CanonicalRuntimeEvent) => store.appendEvent(event),
        (event: CanonicalRuntimeEvent) => store.appendEventIfAbsent(event),
      ];
      try {
        for (const [index, append] of appenders.entries()) {
          expect(() =>
            append({
              eventId: `evt-unserialized-overflow-${index}`,
              provider: 'claude',
              threadId: 'thread',
              turnId: 'turn',
              itemId: 'item',
              createdAt: '2026-08-25T00:00:00.000Z',
              method: 'tool.completed',
              toolCallId: 'call',
              toolName: 'shell',
              status: 'success',
              output: oversized,
            }),
          ).toThrow('ingress ceiling');
        }
        expect(stringify).not.toHaveBeenCalled();
      } finally {
        stringify.mockRestore();
      }
    });

    test('rejects cyclic, deep, and hostile structures through both event insert paths', () => {
      const appenders = [
        (event: CanonicalRuntimeEvent) => store.appendEvent(event),
        (event: CanonicalRuntimeEvent) => store.appendEventIfAbsent(event),
      ];
      const nested: { child?: unknown } = {};
      let cursor = nested;
      for (let index = 0; index < 32; index += 1) {
        cursor.child = {};
        cursor = cursor.child as { child?: unknown };
      }
      const cycle: { self?: unknown } = {};
      cycle.self = cycle;
      const tooManyProperties = Object.fromEntries(
        Array.from({ length: 513 }, (_, index) => [`property-${index}`, index]),
      );
      const hostileValues: Array<[string, unknown]> = [
        ['cycle', cycle],
        ['depth', nested],
        ['properties', tooManyProperties],
        ['array', Array.from({ length: 513 }, () => 'item')],
        [
          'ownKeys',
          new Proxy(
            {},
            {
              ownKeys: () => {
                throw new Error('ownKeys must not run through stringify');
              },
            },
          ),
        ],
        [
          'descriptor',
          new Proxy(
            { safe: 'value' },
            {
              getOwnPropertyDescriptor: () => {
                throw new Error('descriptor must not run through stringify');
              },
            },
          ),
        ],
        [
          'getter',
          Object.defineProperty({}, 'value', {
            enumerable: true,
            get: () => {
              throw new Error('getter must not run through stringify');
            },
          }),
        ],
      ];

      for (const [appendIndex, append] of appenders.entries()) {
        for (const [label, output] of hostileValues) {
          expect(() =>
            append({
              eventId: `evt-ingress-${appendIndex}-${label}`,
              provider: 'claude',
              threadId: 'thread',
              turnId: 'turn',
              itemId: 'item',
              createdAt: '2026-08-25T00:00:00.000Z',
              method: 'tool.completed',
              toolCallId: 'call',
              toolName: 'shell',
              status: 'success',
              output,
            } as CanonicalRuntimeEvent),
          ).toThrow('cannot be safely persisted');
        }
      }
    });

    test('does not parse or expose structured tool output through the descriptor', () => {
      store.appendEvent({
        eventId: 'evt-tool-result-structured',
        provider: 'claude',
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'item',
        createdAt: '2026-08-19T00:00:00.000Z',
        method: 'tool.completed',
        toolCallId: 'call',
        toolName: 'shell',
        status: 'success',
        output: { url: 'https://private.invalid', data: 'embedded-content' },
      });
      const descriptor = store.toolCompletedEventById(
        'thread',
        'evt-tool-result-structured',
      );
      expect(descriptor).not.toHaveProperty('output');
      expect(JSON.stringify(descriptor)).not.toContain('private.invalid');
      expect(JSON.stringify(descriptor)).not.toContain('embedded-content');
    });

    test('collapses object-valued textual descriptor fields without coercion', () => {
      for (const [eventId, malformed] of [
        ['object-call', { toolCallId: { private: 'call' } }],
        ['object-name', { toolName: { private: 'name' } }],
        ['object-error', { error: { private: 'error' } }],
      ] as const) {
        store.appendEvent(
          Object.assign(
            {
              eventId,
              provider: 'claude',
              threadId: 'thread',
              turnId: 'turn',
              itemId: 'item',
              createdAt: '2026-08-19T00:00:00.000Z',
              method: 'tool.completed',
              toolCallId: 'call',
              toolName: 'shell',
              status: 'error',
            },
            malformed,
          ) as any,
        );
        expect(store.toolCompletedEventById('thread', eventId)).toBeUndefined();
      }
    });

    test('treats malformed persisted tool JSON as absent instead of a resolver outage', () => {
      withDatabase((db) =>
        db
          .prepare(
            `INSERT INTO orchestration_events
             (id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence)
             VALUES ('malformed-tool-json', 'claude', 'thread', 'turn', 'tool.completed', '{', '2026-08-19T00:00:00.000Z', 9999, 9999)`,
          )
          .run(),
      );
      expect(
        store.toolCompletedEventById('thread', 'malformed-tool-json'),
      ).toBeUndefined();
    });

    test('fails closed for malformed descriptor JSON and every invalid persisted descriptor shape without blob reads', () => {
      const insert = (id: string, payload: string) =>
        withDatabase((db) =>
          db
            .prepare(
              `INSERT INTO orchestration_events
             (id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence)
             VALUES (?, 'claude', 'descriptor-thread', 'turn', 'turn.started', ?, '2026-08-19T00:00:00.000Z', 1, 1)`,
            )
            .run(id, payload),
        );
      const valid = {
        eventId: 'x',
        threadId: 'descriptor-thread',
        turnId: 'turn',
        method: 'turn.started',
        prompt: 'ok',
        attachments: [],
      };
      const attachment = {
        kind: 'image',
        name: 'safe.png',
        mimeType: 'image/png',
        size: 1,
      };
      const cases: Array<[string, string]> = [
        ['bad-json', '{'],
        ['nonarray', JSON.stringify({ ...valid, attachments: {} })],
        ['null-element', JSON.stringify({ ...valid, attachments: [null] })],
        ['primitive-element', JSON.stringify({ ...valid, attachments: [42] })],
        [
          'object-missing-name-kind',
          JSON.stringify({
            ...valid,
            attachments: [{ mimeType: 'image/png', size: 1 }],
          }),
        ],
        [
          'partial',
          JSON.stringify({
            ...valid,
            attachments: [{ ...attachment }, { name: 'missing-fields' }],
          }),
        ],
        [
          'absolute',
          JSON.stringify({
            ...valid,
            attachments: [{ ...attachment, name: '/private.png' }],
          }),
        ],
        [
          'traversal',
          JSON.stringify({
            ...valid,
            attachments: [{ ...attachment, name: '../private.png' }],
          }),
        ],
        [
          'mime',
          JSON.stringify({
            ...valid,
            attachments: [
              { ...attachment, mimeType: `image/${'x'.repeat(300)}` },
            ],
          }),
        ],
        [
          'kind',
          JSON.stringify({
            ...valid,
            attachments: [{ ...attachment, kind: 'file' }],
          }),
        ],
        [
          'size',
          JSON.stringify({
            ...valid,
            attachments: [{ ...attachment, size: 0 }],
          }),
        ],
        [
          'count',
          JSON.stringify({
            ...valid,
            attachments: Array.from({ length: 6 }, () => attachment),
          }),
        ],
        [
          'prompt-over',
          JSON.stringify({
            ...valid,
            prompt: 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1),
          }),
        ],
      ];
      for (const [id, payload] of cases) insert(id, payload);
      const read = vi.spyOn((store as any).attachmentBlobs, 'read');
      for (const [id] of cases) {
        try {
          store.userInputEventById(id);
          throw new Error(`accepted ${id}`);
        } catch (error) {
          expect(String(error)).not.toContain(`accepted ${id}`);
        }
      }
      expect(read).not.toHaveBeenCalled();
    });

    test('allows empty prompt only with a valid attachment and allows an empty array with a nonempty prompt', () => {
      const insert = (id: string, payload: unknown) =>
        withDatabase((db) =>
          db
            .prepare(
              `INSERT INTO orchestration_events (id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence)
           VALUES (?, 'claude', 'shape-thread', 'turn', 'turn.started', ?, '2026-08-19T00:00:00.000Z', 1, 1)`,
            )
            .run(id, JSON.stringify(payload)),
        );
      const attachment = {
        kind: 'image',
        name: 'safe.png',
        mimeType: 'image/png',
        size: 1,
      };
      insert('empty-with-file', { prompt: '   ', attachments: [attachment] });
      insert('prompt-empty-array', { prompt: 'present', attachments: [] });
      expect(store.userInputEventById('empty-with-file')).toMatchObject({
        attachments: [{ name: 'safe.png', mimeType: 'image/png', size: 1 }],
      });
      expect(store.userInputEventById('prompt-empty-array')).toMatchObject({
        prompt: 'present',
        attachments: [],
      });
    });

    test.each(['turn.failed', 'turn.aborted', 'turn.cancelled'])(
      'keeps an authored turn.started descriptor after %s',
      (terminalMethod) => {
        store.appendEvent(
          attachmentTurn(
            `started-${terminalMethod}`,
            `thread-${terminalMethod}`,
          ),
        );
        store.appendEvent({
          eventId: `terminal-${terminalMethod}`,
          provider: 'claude',
          threadId: `thread-${terminalMethod}`,
          turnId: `turn-started-${terminalMethod}`,
          createdAt: '2026-08-19T00:01:00.000Z',
          method: terminalMethod,
        } as any);
        expect(
          store.userInputEventById(`started-${terminalMethod}`),
        ).toMatchObject({
          eventId: `started-${terminalMethod}`,
          method: 'turn.started',
        });
      },
    );

    test('the event handed to the rest of the dispatch keeps its real bytes', () => {
      const event = attachmentTurn('evt-dispatch', 'thread-dispatch');

      store.appendEvent(event);

      // `appendEvent` runs before this same object reaches the event bus, and
      // the adapter already sent these bytes to the model. Persistence must
      // narrow the ROW, never the event.
      expect(event.attachments[0].dataUrl).toBe(dataUrl);
      expect(event.attachments[0].blobRef).toBeUndefined();
    });

    test('a full read resolves the reference back to the original bytes', () => {
      store.appendEvent(attachmentTurn('evt-restore', 'thread-restore'));

      const [event] = store
        .listEvents('thread-restore')
        .filter((entry) => entry.method === 'turn.started');
      const attachment = (event.payload as any).attachments[0];

      expect(attachment.dataUrl).toBe(dataUrl);
      expect(attachment.blobRef).toMatch(/^sha256-[0-9a-f]{64}$/);
    });

    test('an event written before blob storage still reads its inline bytes', () => {
      const legacy = {
        eventId: 'evt-legacy',
        provider: 'claude',
        threadId: 'thread-legacy',
        createdAt: '2026-08-19T00:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-legacy',
        prompt: 'an old row',
        attachments: [
          {
            kind: 'image',
            name: 'old.png',
            mimeType: 'image/png',
            size: pixels.length,
            dataUrl,
          },
        ],
      };
      withDatabase((db) =>
        db
          .prepare(
            `INSERT INTO orchestration_events
               (id, provider, thread_id, turn_id, method, request_id, session_state, payload, created_at, sequence, global_sequence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'evt-legacy',
            'claude',
            'thread-legacy',
            'turn-legacy',
            'turn.started',
            null,
            null,
            JSON.stringify(legacy),
            '2026-08-19T00:00:00.000Z',
            1,
            9_000_001,
          ),
      );

      const [event] = store.listEvents('thread-legacy');

      expect((event.payload as any).attachments[0].dataUrl).toBe(dataUrl);
      expect((event.payload as any).attachments[0].blobRef).toBeUndefined();
    });

    test('a reclaimed blob leaves the attachment visible instead of leaving a hole', () => {
      store.appendEvent(attachmentTurn('evt-reclaimed', 'thread-reclaimed'));
      rmSync(join(dir, 'attachments'), { recursive: true, force: true });

      const [event] = store
        .listEvents('thread-reclaimed')
        .filter((entry) => entry.method === 'turn.started');
      const attachment = (event.payload as any).attachments[0];

      expect(attachment.dataUrl).toBeUndefined();
      expect(attachment.blobRef).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(attachment.name).toBe('screenshot.png');
      expect(attachment.mimeType).toBe('image/png');
    });

    test('the byte-budgeted window keeps the whole turn instead of guillotining it', () => {
      store.appendEvent(attachmentTurn('evt-window', 'thread-window'));

      const window = store.listEventWindowByTurn('thread-window', {
        turnLimit: 1,
      });
      const started = window.events.find(
        (entry) => entry.method === 'turn.started',
      );
      const payload = started?.payload as any;

      // Inline bytes put this payload past `snapshotEvent`'s 4 KB ceiling,
      // which strips it to its identity fields — prompt and attachment both.
      expect(payload.prompt).toBe('what is in this screenshot?');
      expect(payload.attachments[0].name).toBe('screenshot.png');
      // The window hands on the reference; it must not re-inflate the bytes
      // it exists to keep out.
      expect(payload.attachments[0].dataUrl).toBeUndefined();
      expect(payload.attachments[0].blobRef).toMatch(/^sha256-[0-9a-f]{64}$/);
    });

    test('a blob write failure refuses the event rather than persisting raw bytes', () => {
      // Occupy the shard directory's path with a FILE so `mkdirSync` cannot
      // create it. A current turn must fail closed: inline bytes can never
      // become an SSE or persistence fallback when projection cannot bind a
      // server-only blob.
      const digest = createHash('sha256').update(pixels).digest('hex');
      mkdirSync(join(dir, 'attachments'), { recursive: true });
      writeFileSync(join(dir, 'attachments', digest.slice(0, 2)), 'occupied');

      expect(() =>
        store.appendEvent(attachmentTurn('evt-fallback', 'thread-fallback')),
      ).toThrow('could not store');
      expect(store.listEvents('thread-fallback')).toEqual([]);
    });

    test('one attachment projection failure refuses the whole turn atomically', () => {
      const other = Buffer.alloc(6 * 1024, 9);
      const otherDataUrl = `data:image/png;base64,${other.toString('base64')}`;
      const otherDigest = createHash('sha256').update(other).digest('hex');
      mkdirSync(join(dir, 'attachments'), { recursive: true });
      writeFileSync(
        join(dir, 'attachments', otherDigest.slice(0, 2)),
        'occupied',
      );

      expect(() =>
        store.appendEvent({
          eventId: 'evt-mixed',
          provider: 'claude',
          threadId: 'thread-mixed',
          createdAt: '2026-08-19T00:00:00.000Z',
          method: 'turn.started',
          turnId: 'turn-mixed',
          prompt: 'two screenshots, one shard occupied',
          attachments: [
            {
              kind: 'image',
              name: 'stored.png',
              mimeType: 'image/png',
              size: pixels.length,
              dataUrl,
            },
            {
              kind: 'image',
              name: 'unstorable.png',
              mimeType: 'image/png',
              size: other.length,
              dataUrl: otherDataUrl,
            },
          ],
        } as any),
      ).toThrow('could not store');
      expect(store.listEvents('thread-mixed')).toEqual([]);
    });

    test('binds the blob to the thread that referenced it (#3385)', () => {
      store.appendEvent(attachmentTurn('evt-bind', 'thread-bind'));

      const payload = persistedRow('thread-bind');
      expect(
        store.listAttachmentThreads(payload.attachments[0].blobRef),
      ).toEqual(['thread-bind']);
    });

    test('a deduped blob binds to every thread that referenced it', () => {
      // Content addressing means two conversations share one blob. The route
      // authorizes by "any thread the caller can read", so both bindings must
      // exist or one owner loses access to their own attachment.
      store.appendEvent(attachmentTurn('evt-dedup-1', 'thread-one'));
      store.appendEvent(attachmentTurn('evt-dedup-2', 'thread-two'));

      const payload = persistedRow('thread-one');
      expect(
        store.listAttachmentThreads(payload.attachments[0].blobRef).sort(),
      ).toEqual(['thread-one', 'thread-two']);
    });

    test('refuses to resolve threads for anything that is not a digest', () => {
      expect(store.listAttachmentThreads('../secret')).toEqual([]);
      expect(store.listAttachmentThreads('sha256-nope')).toEqual([]);
    });

    test('deleting a thread stops it authorizing the blob', () => {
      store.appendEvent(attachmentTurn('evt-del-1', 'thread-keep'));
      store.appendEvent(attachmentTurn('evt-del-2', 'thread-drop'));
      const blobRef = persistedRow('thread-keep').attachments[0].blobRef;

      store.deleteThread('thread-drop');

      // The surviving thread keeps its access; the deleted one grants none.
      expect(store.listAttachmentThreads(blobRef)).toEqual(['thread-keep']);
    });

    /**
     * Ownership comes from `session.started`, which is the only place both the
     * owner fold and the conversation-history projection read it from — that
     * agreement by construction is what makes the SQL narrowing a narrowing
     * rather than a second derivation.
     */
    const ownedTurn = (eventId: string, threadId: string, userId: string) => {
      store.appendEvent({
        eventId: `${eventId}-session`,
        provider: 'claude',
        threadId,
        createdAt: '2026-08-19T00:00:00.000Z',
        method: 'session.started',
        sessionId: threadId,
        metadata: { userId },
      } as any);
      return attachmentTurn(eventId, threadId);
    };

    test('candidate threads are narrowed to the asking owner, in SQL (#3385 review)', () => {
      store.appendEvent(ownedTurn('evt-mine', 'thread-mine', 'me'));
      store.appendEvent(ownedTurn('evt-theirs', 'thread-theirs', 'someone'));
      const blobRef = persistedRow('thread-mine').attachments[0].blobRef;

      // Both threads are bound to the one deduped blob...
      expect(store.listAttachmentThreads(blobRef).sort()).toEqual([
        'thread-mine',
        'thread-theirs',
      ]);
      // ...but a foreign owner sees ZERO candidates, so the route makes zero
      // predicate calls and an unreadable digest costs exactly what an unbound
      // one does. That equality is the fix: response time must not answer
      // "does anyone on this Station hold these bytes".
      expect(store.listAttachmentCandidateThreads(blobRef, 'someone')).toEqual([
        'thread-theirs',
      ]);
      expect(store.listAttachmentCandidateThreads(blobRef, 'me')).toEqual([
        'thread-mine',
      ]);
      expect(store.listAttachmentCandidateThreads(blobRef, 'stranger')).toEqual(
        [],
      );
      const unbound = `sha256-${'b'.repeat(64)}`;
      expect(store.listAttachmentCandidateThreads(unbound, 'me')).toEqual([]);
    });

    test('the candidate set is capped however many threads reference the blob', () => {
      for (let index = 0; index < 12; index += 1) {
        store.appendEvent(
          ownedTurn(`evt-many-${index}`, `thread-${index}`, 'me'),
        );
      }
      const blobRef = persistedRow('thread-0').attachments[0].blobRef;

      expect(store.listAttachmentThreads(blobRef)).toHaveLength(12);
      // Authorized reads must not be O(bindings) either.
      expect(
        store.listAttachmentCandidateThreads(blobRef, 'me').length,
      ).toBeLessThanOrEqual(4);
    });

    test('an ownerless thread stays a candidate for the real predicate to judge', () => {
      // `single-user-compat` is the predicate's decision, not this query's.
      store.appendEvent(attachmentTurn('evt-ownerless', 'thread-ownerless'));
      const blobRef = persistedRow('thread-ownerless').attachments[0].blobRef;

      expect(store.listAttachmentCandidateThreads(blobRef, 'anyone')).toEqual([
        'thread-ownerless',
      ]);
    });

    test('deleting the last thread holding a blob reclaims the bytes', () => {
      store.appendEvent(attachmentTurn('evt-shared-a', 'thread-a'));
      store.appendEvent(attachmentTurn('evt-shared-b', 'thread-b'));
      const blobRef = persistedRow('thread-a').attachments[0].blobRef;
      const digest = blobRef.slice('sha256-'.length);
      const blobPath = join(dir, 'attachments', digest.slice(0, 2), digest);
      expect(existsSync(blobPath)).toBe(true);

      // Still shared: deleting one conversation must not take the other's
      // image with it.
      store.deleteThread('thread-a');
      expect(existsSync(blobPath)).toBe(true);

      // Last binding gone: deleting a conversation to remove a pasted
      // screenshot has to remove the screenshot, not just its reachability.
      store.deleteThread('thread-b');
      expect(existsSync(blobPath)).toBe(false);
      expect(store.listAttachmentThreads(blobRef)).toEqual([]);
    });

    test('the replay append path binds the blob too (#3385 review)', () => {
      // `appendEventIfAbsent` is the other INSERT site; an unbound blob is an
      // unreadable one, so a replayed turn that skipped its binding would
      // render as a permanently broken chip.
      store.appendEventIfAbsent(attachmentTurn('evt-replay', 'thread-replay'));

      const payload = persistedRow('thread-replay');
      expect(payload.attachments[0].blobRef).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(
        store.listAttachmentThreads(payload.attachments[0].blobRef),
      ).toEqual(['thread-replay']);
    });

    test('a duplicate replay does not bind a second time', () => {
      store.appendEventIfAbsent(attachmentTurn('evt-dup', 'thread-dup'));
      store.appendEventIfAbsent(attachmentTurn('evt-dup', 'thread-dup'));

      const blobRef = persistedRow('thread-dup').attachments[0].blobRef;
      expect(store.listAttachmentThreads(blobRef)).toEqual(['thread-dup']);
    });

    test('a rolled-back append leaves no binding behind', () => {
      // The binding is written inside the event's savepoint. Hoisting it out
      // would leave a blob authorized by a thread whose event never landed.
      const conflicting = attachmentTurn('evt-rollback', 'thread-rollback');
      store.appendEvent(conflicting);
      const blobRef = persistedRow('thread-rollback').attachments[0].blobRef;
      expect(store.listAttachmentThreads(blobRef)).toEqual(['thread-rollback']);

      // Same eventId on a DIFFERENT thread: the INSERT violates the primary
      // key, the savepoint rolls back, and no `thread-rollback-2` binding may
      // survive it.
      expect(() =>
        store.appendEvent(attachmentTurn('evt-rollback', 'thread-rollback-2')),
      ).toThrow();

      expect(store.listAttachmentThreads(blobRef)).toEqual(['thread-rollback']);
    });

    test('identical attachments across turns are stored once', () => {
      store.appendEvent(attachmentTurn('evt-dedup-a', 'thread-dedup'));
      store.appendEvent(attachmentTurn('evt-dedup-b', 'thread-dedup'));

      const shards = readdirSync(join(dir, 'attachments'), {
        withFileTypes: true,
      }).filter((entry) => entry.isDirectory());
      const blobs = shards.flatMap((shard) =>
        readdirSync(join(dir, 'attachments', shard.name)),
      );

      expect(blobs).toHaveLength(1);
    });
  });

  test('accounts only reserved attachment bytes and releases rejected dispatches', () => {
    store.appendEvent({
      eventId: 'large-text-turn',
      provider: 'claude',
      threadId: 'thread-quota',
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-text',
      prompt: 'text-only history does not consume attachment quota',
    });
    store.reserveAttachmentCapacity(
      'thread-quota',
      CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES,
    );
    expect(() => store.reserveAttachmentCapacity('thread-quota', 1)).toThrow(
      'attachment history limit',
    );

    store.releaseAttachmentCapacity(
      'thread-quota',
      CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES,
    );
    expect(() =>
      store.reserveAttachmentCapacity('thread-quota', 1),
    ).not.toThrow();
  });

  test('atomically rejects reservations that would exceed the global quota', () => {
    const reservation = CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES;
    const threadCount = CHAT_ATTACHMENT_MAX_STORE_ENCODED_BYTES / reservation;
    for (let index = 0; index < threadCount; index += 1) {
      store.reserveAttachmentCapacity(`thread-${index}`, reservation);
    }

    expect(() =>
      store.reserveAttachmentCapacity('thread-over-global-limit', 1),
    ).toThrow('attachment storage is full');
  });

  test('round-trips provider session state with resume cursors', () => {
    store.upsertSession({
      provider: 'codex',
      threadId: 'thread-2',
      status: 'running',
      model: 'gpt-5-codex',
      cwd: '/workspace/project',
      continuationSourceThreadId: 'external:codex:source',
      persistSession: true,
      resumeCursor: { codexThreadId: 'codex-thread-9' },
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:10.000Z',
    });

    expect(store.readSessions()).toEqual([
      {
        provider: 'codex',
        threadId: 'thread-2',
        status: 'running',
        model: 'gpt-5-codex',
        cwd: '/workspace/project',
        continuationSourceThreadId: 'external:codex:source',
        persistSession: true,
        resumeCursor: { codexThreadId: 'codex-thread-9' },
        controlMode: 'station-owned',
        createdAt: '2026-03-28T00:00:00.000Z',
        updatedAt: '2026-03-28T00:00:10.000Z',
      },
    ]);
  });

  test('restores only strictly valid persisted tenant execution context', () => {
    store.upsertSession({
      provider: 'codex',
      threadId: 'tenant-context',
      status: 'running',
      tenantExecutionContext: {
        tenantId: 'alpha' as any,
        source: 'request',
      },
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:10.000Z',
    });
    store.upsertSession({
      provider: 'codex',
      threadId: 'invalid-tenant-context',
      status: 'running',
      tenantExecutionContext: { tenantId: 'alpha', source: 'forged' } as any,
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:10.000Z',
    });

    expect(store.readSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: 'tenant-context',
          tenantExecutionContext: { tenantId: 'alpha', source: 'request' },
        }),
        expect.not.objectContaining({
          threadId: 'invalid-tenant-context',
          tenantExecutionContext: expect.anything(),
        }),
      ]),
    );
  });

  test('round-trips attached-session control metadata', () => {
    store.upsertSession({
      provider: 'claude',
      threadId: 'external:claude:session-1',
      status: 'running',
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'session-1',
        revision: '42',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
    });

    expect(store.readSessions()).toEqual([
      expect.objectContaining({
        threadId: 'external:claude:session-1',
        controlMode: 'read-only-attached',
        attachedSource: {
          kind: 'claude-transcript',
          externalSessionId: 'session-1',
          revision: '42',
        },
      }),
    ]);
  });

  test('waits through a real writer overlap, then migrates and reclaims a legacy row', async () => {
    const path = join(dir, 'legacy-adoption.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE provider_session_adoptions (
        source_thread_id TEXT PRIMARY KEY,
        target_thread_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        provider TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        cwd TEXT NOT NULL,
        project_root TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_resume_cursor TEXT,
        provider_cleanup_complete INTEGER NOT NULL DEFAULT 0,
        flow_run_id TEXT,
        flow_run_resumed INTEGER,
        flow_cleanup_complete INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO provider_session_adoptions
        (source_thread_id, target_thread_id, owner_id, owner_pid, provider,
         source_session_id, source_kind, cwd, project_root, status,
         provider_cleanup_complete, flow_cleanup_complete, created_at, updated_at)
      VALUES
        ('legacy-source', 'legacy-target', 'legacy-owner', -1, 'claude',
         'legacy-session', 'claude-transcript', '/workspace', '/workspace', 'pending',
         0, 1, '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z');
    `);
    legacy.close();

    const holder = spawn(
      process.execPath,
      [
        '-e',
        `
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(process.argv[1]);
          db.exec('BEGIN IMMEDIATE');
          process.stdout.write('locked\\n');
          setTimeout(() => { db.exec('COMMIT'); db.close(); }, 120);
        `,
        path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.once('data', () => resolve());
    });

    // This constructor is a second independent connection while the child
    // holds the write lock. EventStore's bounded SQLite timeout waits for the
    // release, then the atomic migration makes a later constructor a no-op.
    const startedAt = Date.now();
    const first = new EventStore(path);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75);
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)),
      );
    });
    const second = new EventStore(path);
    const ledger = second.createAdoptionLedger();
    const reservation = ledger.reservations()[0]!;
    expect(reservation.ownerToken).toBe('legacy-unfenced');
    expect(
      ledger.reclaim({
        reservation,
        ownerId: 'replacement',
        ownerPid: 202,
      }),
    ).toMatchObject({ kind: 'owner' });
    first.close();
    second.close();
  });

  test('lists mixed canonical event categories across threads in created order', () => {
    store.appendEvent({
      eventId: 'evt-session',
      provider: 'bedrock',
      threadId: 'thread-a',
      createdAt: '2026-03-28T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'thread-a',
      initialState: 'created',
    });
    store.appendEvent({
      eventId: 'evt-request',
      provider: 'claude',
      threadId: 'thread-b',
      createdAt: '2026-03-28T00:00:01.000Z',
      method: 'request.opened',
      requestId: 'req-1',
      requestType: 'approval',
      title: 'Allow Read',
    });
    store.appendEvent({
      eventId: 'evt-turn',
      provider: 'codex',
      threadId: 'thread-c',
      createdAt: '2026-03-28T00:00:02.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
      outputText: 'done',
    });

    expect(store.listEvents().map((event) => event.id)).toEqual([
      'evt-session',
      'evt-request',
      'evt-turn',
    ]);
  });

  test('marks sessions closed while preserving their provider identity', () => {
    store.upsertSession({
      provider: 'claude',
      threadId: 'thread-close',
      status: 'running',
      model: 'claude-sonnet',
      resumeCursor: { cursor: 'resume-1' },
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:10.000Z',
    });

    store.markSessionClosed('thread-close');

    expect(store.readSessions()).toEqual([
      expect.objectContaining({
        provider: 'claude',
        threadId: 'thread-close',
        status: 'closed',
      }),
    ]);
  });

  test('leaves no transaction open when closing an unknown session without a provider', () => {
    store.markSessionClosed('unknown-close');
    store.upsertSession({
      provider: 'codex',
      threadId: 'write-after-unknown-close',
      status: 'ready',
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:01.000Z',
    });
    expect(
      store.readSessionByThread('write-after-unknown-close'),
    ).toMatchObject({ status: 'ready' });
  });

  test('persists and reads command receipts by command and thread', () => {
    store.appendCommandReceipt({
      commandId: 'cmd-1',
      threadId: 'thread-receipts',
      commandType: 'startSession',
      status: 'accepted',
      createdAt: '2026-03-28T00:00:00.000Z',
    });
    store.appendCommandReceipt({
      commandId: 'cmd-2',
      threadId: 'thread-receipts',
      commandType: 'sendTurn',
      status: 'failed',
      createdAt: '2026-03-28T00:00:01.000Z',
    });
    store.appendCommandReceipt({
      commandId: 'cmd-3',
      threadId: 'other-thread',
      commandType: 'interruptTurn',
      status: 'accepted',
      createdAt: '2026-03-28T00:00:02.000Z',
    });

    expect(store.readCommandReceipt('cmd-2')).toEqual({
      commandId: 'cmd-2',
      threadId: 'thread-receipts',
      commandType: 'sendTurn',
      status: 'failed',
      createdAt: '2026-03-28T00:00:01.000Z',
    });
    expect(store.listCommandReceipts('thread-receipts')).toEqual([
      expect.objectContaining({ commandId: 'cmd-1' }),
      expect.objectContaining({ commandId: 'cmd-2' }),
    ]);
    expect(
      store.listCommandReceipts().map((receipt) => receipt.commandId),
    ).toEqual(['cmd-1', 'cmd-2', 'cmd-3']);
  });

  test('deletes every artifact for an ephemeral diagnostic thread', () => {
    store.upsertSession({
      provider: 'claude',
      threadId: 'station-smoke-1',
      status: 'ready',
      createdAt: '2026-07-13T20:00:00.000Z',
      updatedAt: '2026-07-13T20:00:00.000Z',
    });
    store.appendEvent({
      eventId: 'smoke-event',
      provider: 'claude',
      threadId: 'station-smoke-1',
      createdAt: '2026-07-13T20:00:00.000Z',
      method: 'turn.completed',
      turnId: 'smoke-turn',
      outputText: 'STATION_SMOKE_OK',
    });
    store.appendCommandReceipt({
      commandId: 'smoke-command',
      threadId: 'station-smoke-1',
      commandType: 'sendTurn',
      status: 'accepted',
      createdAt: '2026-07-13T20:00:00.000Z',
    });
    store.upsertTurnProvenance({
      envelopeVersion: 1,
      sessionId: 'station-smoke-1',
      turnId: 'smoke-turn',
    } as any);

    store.deleteThread('station-smoke-1');

    expect(store.readSessions()).toEqual([]);
    expect(store.listEvents('station-smoke-1')).toEqual([]);
    expect(store.listCommandReceipts('station-smoke-1')).toEqual([]);
    expect(
      store.readTurnProvenance('station-smoke-1', 'smoke-turn'),
    ).toBeUndefined();
    const database = new DatabaseSync(join(dir, 'orchestration.sqlite'));
    try {
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM orchestration_message_search_v2
             WHERE thread_id = ?`,
          )
          .get('station-smoke-1'),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  test('persists one idempotently updatable provenance sidecar across a database reopen', () => {
    const databasePath = join(dir, 'orchestration.sqlite');
    const first = {
      envelopeVersion: 1,
      sessionId: 'thread-reopen-provenance',
      turnId: 'turn-reopen-provenance',
      marker: 'first',
    } as any;
    const second = { ...first, marker: 'second' } as any;
    store.upsertTurnProvenance(first);
    store.upsertTurnProvenance(second);
    store.close();
    store = new EventStore(databasePath);

    expect(
      store.readTurnProvenance(
        'thread-reopen-provenance',
        'turn-reopen-provenance',
      ),
    ).toEqual(second);
  });
});

describe('orchestration turn-dedup migration', () => {
  test('keeps a legacy unresolved row without owner_json', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'orchestration-dedup-legacy-'),
    );
    const databasePath = join(directory, 'orchestration.sqlite');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`CREATE TABLE orchestration_turn_dedup (
        dedup_key TEXT PRIMARY KEY, value TEXT, created_at INTEGER NOT NULL
      )`);
      database
        .prepare('INSERT INTO orchestration_turn_dedup VALUES (?, ?, ?)')
        .run('legacy-unresolved', null, 0);

      ensureOrchestrationTurnDedupColumns(database);

      expect(
        database
          .prepare('SELECT count(*) AS count FROM orchestration_turn_dedup')
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('overflow leaves unresolved claims intact without probing owners', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'orchestration-dedup-overflow-'),
    );
    const databasePath = join(directory, 'orchestration.sqlite');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
      const insert = database.prepare(`INSERT INTO orchestration_turn_dedup
        (dedup_key, value, created_at, owner_json) VALUES (?, NULL, ?, ?)`);
      const owner = JSON.stringify({
        pid: 4242,
        birth: 'live-birth',
        token: 'shared-live-owner',
        identityKind: 'exact',
      });
      for (let index = 0; index < 40; index += 1) {
        insert.run(`live-${index}`, index, owner);
      }
    } finally {
      database.close();
    }

    const probe = vi.fn((pid: number) => ({
      state: 'exact' as const,
      identity: {
        pid,
        start: pid === process.pid ? 'new-owner-birth' : 'live-birth',
      },
    }));
    const store = new EventStore(databasePath, 2, {
      exact: () => ({ pid: process.pid, start: 'new-owner-birth' }),
      probe,
    });
    try {
      expect(store.claimChatTurn('overflow-trigger')).toEqual({
        claimed: true,
      });
      expect(probe).not.toHaveBeenCalled();
    } finally {
      store.close();
    }

    const after = new DatabaseSync(databasePath);
    try {
      expect(
        after
          .prepare('SELECT count(*) AS count FROM orchestration_turn_dedup')
          .get(),
      ).toEqual({ count: 41 });
    } finally {
      after.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
