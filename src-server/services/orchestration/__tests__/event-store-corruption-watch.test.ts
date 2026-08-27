import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCorruptionMarker } from '@kontourai/station-shared/sqlite-corruption-marker';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventStore, EventStoreIntegrityError } from '../event-store.js';

const { corruptionObserved } = vi.hoisted(() => ({
  corruptionObserved: { add: vi.fn() },
}));

vi.mock('../../../telemetry/metrics.js', () => ({
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  turnDedupClaims: { add: vi.fn() },
  orchestrationStoreCorruptionObserved: corruptionObserved,
}));

/**
 * station#3215. These use REAL corrupt bytes on a real store rather than a
 * thrown fixture: the whole claim is that Station notices what SQLite actually
 * does to it, and a hand-authored error object cannot prove that. The one
 * previous corruption fixture in this tree was a mangled `errstr` that a
 * classifier keying on the wrong field passed anyway.
 */
describe('EventStore notices corruption that develops after boot', () => {
  let dir: string;
  let databasePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-store-corruption-'));
    databasePath = join(dir, 'orchestration.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    // Module-scope mock: without this, "not called" would only mean "not
    // called in the FIRST test that ran", which is not the claim.
    corruptionObserved.add.mockClear();
  });

  function seed(count: number): void {
    // The migration alone allocates ~91 pages before a single row exists, so
    // the ROWS live past page 91. Which pages a given test damages is what
    // decides which code path observes — see each test's own comment.
    const store = new EventStore(databasePath);
    for (let index = 0; index < count; index += 1) {
      store.appendEvent({
        eventId: `event-${index}`,
        provider: 'claude',
        threadId: 'corruption-thread',
        turnId: `turn-${index}`,
        createdAt: '2026-08-18T00:00:00.000Z',
        method: 'turn.started',
        prompt: `payload ${index} ${'x'.repeat(400)}`,
      });
    }
    store.close?.();
  }

  /**
   * Pages 3-10: the schema tables and their autoindexes
   * (`orchestration_event_store_backfills`, `orchestration_request_state`,
   * and friends). The header stays intact so the file still opens. This is
   * reached by the constructor's own ensure/backfill sequence.
   */
  function damageSchemaPages(): void {
    const bytes = readFileSync(databasePath);
    expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
    bytes.fill(0x5a, 8192, Math.min(bytes.byteLength, 8192 + 32 * 1024));
    writeFileSync(databasePath, bytes);
  }

  /**
   * The tail, where the seeded ROWS live. The schema pages stay intact, so
   * the store opens cleanly and the failure has to come from a real
   * `StatementSync` — which is the only thing that exercises the statement
   * half of the watch's proxy.
   */
  function damageRowPages(): void {
    const bytes = readFileSync(databasePath);
    const from = Math.floor(bytes.byteLength * 0.6);
    expect(from).toBeGreaterThan(91 * 4096);
    bytes.fill(0x5a, from);
    writeFileSync(databasePath, bytes);
  }

  test('damage to the schema pages is observed while the store opens', () => {
    seed(400);
    damageSchemaPages();
    expect(readCorruptionMarker(databasePath)).toBeNull();

    // No boot check stands in front of this any more (station#3219 removed
    // the per-boot `PRAGMA quick_check`): damage present before open reaches
    // the constructor's own migration/ensure/backfill sequence directly, and
    // the watch on the connection is what must observe it.
    let store: EventStore | undefined;
    try {
      store = new EventStore(databasePath);
      store.listEvents('corruption-thread');
    } catch {
      // Whether SQLite raises during the migration or during the read, the
      // requirement is the same: the observation must be recorded.
    } finally {
      try {
        store?.close?.();
      } catch {
        // Closing a corrupt handle is allowed to fail.
      }
    }

    const marker = readCorruptionMarker(databasePath);
    expect(marker).not.toBeNull();
    expect(realpathSync(marker?.databasePath ?? '')).toBe(
      realpathSync(databasePath),
    );
    expect([11, 26]).toContain(marker?.errcode);
    // The counter station#3219 will reason from. Unasserted, deleting the
    // increment leaves every suite green — and the standing lesson is that
    // the instrument a gate depends on is the one that turns out never to
    // have been readable. station#3218 adds `source`: both detection paths
    // dimension the counter, so it can answer which one found the damage.
    expect(corruptionObserved.add).toHaveBeenCalledWith(1, {
      errcode: marker?.errcode,
      source: 'query',
    });
  });

  test('a header-read failure at the first migration statement is observed and typed', () => {
    // station#3219's coverage proof for the migration block: the connection
    // is wrapped by `watchForSqliteCorruption` BEFORE the migration runs, and
    // the watch proxies `exec`, so the very first `CREATE TABLE IF NOT
    // EXISTS` dying on a `not a sqlite database` header (errcode 26 NOTADB)
    // is recorded through the same observer as every later query — no second
    // recording layer exists in the constructor, deliberately (two copies of
    // one mapping are two chances to record different truths). The
    // constructor's close/rethrow then translates the classified failure
    // into the typed error the boot path acts on.
    writeFileSync(databasePath, 'not a sqlite database');

    expect(() => new EventStore(databasePath)).toThrow(
      EventStoreIntegrityError,
    );

    const marker = readCorruptionMarker(databasePath);
    expect(marker).not.toBeNull();
    expect(marker?.errcode).toBe(26);
    // Marker FIRST, counter second, and the query-path dimension — the same
    // contract as every other observation through the watch.
    expect(corruptionObserved.add).toHaveBeenCalledWith(1, {
      errcode: 26,
      source: 'query',
    });
  });

  test('a failing counter never costs the marker', () => {
    // The observer's comment claims marker-FIRST is load-bearing; this is the
    // derivation behind it at the query site. Swapping the two statements in
    // `event-store.ts` makes the throw land before the marker write and reds
    // this — a test mock missing the instrument did exactly that, silently,
    // during station#3215 (the scheduled site has the same proof).
    corruptionObserved.add.mockImplementationOnce(() => {
      throw new Error('unregistered instrument');
    });
    // Open healthy, damage after: this claim is about the WATCH's observer
    // on a store that is already open, not about a failing open.
    seed(4000);
    const store = new EventStore(databasePath);
    expect(readCorruptionMarker(databasePath)).toBeNull();
    damageRowPages();
    expect(() => store.listEvents('corruption-thread')).toThrow();
    try {
      store.close?.();
    } catch {
      // Closing a corrupt handle is allowed to fail.
    }
    expect(readCorruptionMarker(databasePath)).not.toBeNull();
  });

  test('an undamaged store leaves no marker', () => {
    // The negative control. Without it, a watch that reported every error —
    // or every open — would pass the test above and look correct.
    seed(400);
    const store = new EventStore(databasePath);
    store.listEvents('corruption-thread');
    store.close?.();

    expect(readCorruptionMarker(databasePath)).toBeNull();
    expect(corruptionObserved.add).not.toHaveBeenCalled();
  });

  test('an ordinary query error is not recorded as corruption', () => {
    // A REAL failure from a healthy store. The previous version of this test
    // passed `"'"` as a bound parameter, which is a perfectly valid query
    // matching zero rows — it never produced an error at all, so it proved
    // nothing and was indistinguishable from the test above.
    seed(10);
    const store = new EventStore(databasePath);
    let threw = false;
    try {
      store.appendEvent({
        eventId: 'event-0',
        provider: 'claude',
        threadId: 'corruption-thread',
        turnId: 'turn-0',
        createdAt: '2026-08-18T00:00:00.000Z',
        method: 'turn.started',
        prompt: 'duplicate primary key',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The marker drives quarantine. A false one costs the user their history,
    // so a constraint violation must never reach it.
    expect(readCorruptionMarker(databasePath)).toBeNull();
    expect(corruptionObserved.add).not.toHaveBeenCalled();
    store.close?.();
  });

  test('damage arriving while the store is open is observed on the next read', () => {
    // The scenario the whole feature exists for, and the one the boot check
    // cannot see at all: the store opened on a HEALTHY file, so no stub is
    // needed anywhere here, and the damage appears afterwards. It also forces
    // the failure through a real `StatementSync`, which is the only thing
    // that exercises the statement half of the watch's proxy.
    seed(4000);
    const store = new EventStore(databasePath);
    expect(readCorruptionMarker(databasePath)).toBeNull();

    damageRowPages();

    expect(() => store.listEvents('corruption-thread')).toThrow();

    try {
      store.close?.();
    } catch {
      // Closing a corrupt handle is allowed to fail; leaving it open leaks
      // four module-scope owner registrations into every sibling test.
    }

    const marker = readCorruptionMarker(databasePath);
    expect(marker).not.toBeNull();
    expect([11, 26]).toContain(marker?.errcode);
    // The counter station#3219 will reason from. Unasserted, deleting the
    // increment leaves every suite green — and the standing lesson is that
    // the instrument a gate depends on is the one that turns out never to
    // have been readable.
    expect(corruptionObserved.add).toHaveBeenCalledWith(1, {
      errcode: marker?.errcode,
      source: 'query',
    });
  });
});
