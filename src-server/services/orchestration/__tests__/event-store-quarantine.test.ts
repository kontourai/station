import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  orchestrationStorePath,
  quarantineOrchestrationStore,
} from '@kontourai/station-shared/orchestration-store-quarantine';
import { readCorruptionMarker } from '@kontourai/station-shared/sqlite-corruption-marker';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getOrchestrationDatabasePath } from '../../../domain/migrations/003-orchestration-events.js';
import { getChatTurnDedupStore } from '../../../routes/chat/chat-turn-dedup.js';
import { EventStore } from '../event-store.js';
import {
  damageSqliteTablePage,
  locateSqliteTablePage,
} from './helpers/sqlite-page-corruption.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  turnDedupClaims: { add: vi.fn() },
  // This mock MISSING the corruption counter is what found the observer's
  // ordering bug: `.add` on undefined threw before the marker write, the
  // watch swallowed it, and the whole end-to-end loop silently lost its
  // marker. The observer now writes the marker first; the key stays complete
  // here so this file tests the loop rather than the mock.
  orchestrationStoreCorruptionObserved: { add: vi.fn() },
  orchestrationStoreQuarantineDispositions: { add: vi.fn() },
}));

/**
 * station#3217, end to end and with no stubs in the corruption path: a real
 * store, real damaged bytes, the real boot that fails on them, the real marker
 * that failure leaves behind, and the real quarantine that acts on it.
 *
 * The claim being proved is the whole loop, because each half already looked
 * fine on its own: station#3215 shipped a marker with no consumer, and a
 * quarantine tested against a hand-written marker proves only that it can read
 * its own JSON.
 */
describe('a store recorded as corrupt is replaced on the next start', () => {
  let homeDir: string;
  let root: string;
  let databasePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'event-store-quarantine-'));
    homeDir = join(root, 'home');
    mkdirSync(join(homeDir, 'data'), { recursive: true });
    databasePath = getOrchestrationDatabasePath(homeDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(count: number): void {
    const store = new EventStore(databasePath);
    for (let index = 0; index < count; index += 1) {
      store.appendEvent({
        eventId: `event-${index}`,
        provider: 'claude',
        threadId: 'quarantine-thread',
        turnId: `turn-${index}`,
        createdAt: '2026-08-18T00:00:00.000Z',
        method: 'turn.started',
        prompt: `payload ${index} ${'x'.repeat(400)}`,
      });
    }
    store.close?.();
  }

  test('the marker a failed boot leaves is what the next boot acts on', () => {
    seed(400);
    // The root page is resolved while healthy and the inspector is closed
    // before damage. This makes the constructor's cursor-key read, rather
    // than an allocator-dependent byte range, the corruption trigger.
    damageSqliteTablePage(
      locateSqliteTablePage(databasePath, 'orchestration_cursor_keys'),
    );
    const bytes = readFileSync(databasePath);

    // The status quo this exists to end: the store is unopenable, and it is
    // unopenable on every subsequent start too.
    expect(() => new EventStore(databasePath)).toThrow();
    const marker = readCorruptionMarker(databasePath);
    // Canonical, not the raw spelling — on macOS the temp root is itself a
    // symlink, which is exactly the case the canonical form exists for.
    expect(marker?.databasePath).toBe(
      join(realpathSync(dirname(databasePath)), basename(databasePath)),
    );
    expect([11, 26]).toContain(marker?.errcode);

    const outcome = quarantineOrchestrationStore(homeDir);
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind !== 'quarantined') return;

    // The user's bytes are preserved exactly, not deleted and not rewritten.
    expect(
      readFileSync(join(outcome.quarantineDir, 'orchestration.sqlite')).equals(
        bytes,
      ),
    ).toBe(true);
    expect(existsSync(databasePath)).toBe(false);

    // And Station starts.
    const replacement = new EventStore(databasePath);
    replacement.appendEvent({
      eventId: 'after-quarantine',
      provider: 'claude',
      threadId: 'fresh-thread',
      turnId: 'turn-1',
      createdAt: '2026-08-18T01:00:00.000Z',
      method: 'turn.started',
      prompt: 'the store works',
    });
    expect(
      replacement.listEvents('fresh-thread').map((event) => event.id),
    ).toEqual(['after-quarantine']);
    // The replacement is genuinely fresh, not the old store reopened.
    expect(replacement.listEvents('quarantine-thread')).toEqual([]);
    replacement.close?.();

    // A second start must not quarantine the replacement it just created.
    expect(quarantineOrchestrationStore(homeDir)).toEqual({
      kind: 'no-marker',
    });
  });

  test('a healthy store is never quarantined, however many times it boots', () => {
    // The negative control for the whole loop. A quarantine that fired on an
    // ordinary boot would take the user's history on every start.
    seed(50);

    const store = new EventStore(databasePath);
    store.listEvents('quarantine-thread');
    store.close?.();

    expect(quarantineOrchestrationStore(homeDir)).toEqual({
      kind: 'no-marker',
    });
    expect(existsSync(join(homeDir, 'quarantine'))).toBe(false);
    // The history is still there and still readable, which is the property a
    // false quarantine would destroy.
    const reopened = new EventStore(databasePath);
    expect(reopened.listEvents('quarantine-thread')).toHaveLength(50);
    reopened.close?.();
  });

  test('every consumer opens the store the quarantine moves', () => {
    // Not `expect(a(home)).toBe(b(home))` where `b` now returns `a` — that
    // compares an expression to itself and cannot fail. Each consumer is
    // driven until it puts a real file somewhere, and the assertion is that
    // the file lands where the quarantine will look.
    // `/chat`'s turn-dedup facade resolves the same home to a store; it used
    // to hand-assemble the path, which is a spelling the quarantine silently
    // stops matching the day either side moves. Driven until it creates a real
    // file, because that is the only thing that can disagree.
    const expected = orchestrationStorePath(homeDir);
    expect(existsSync(expected)).toBe(false);
    getChatTurnDedupStore(homeDir).claim('probe-turn');
    expect(existsSync(expected)).toBe(true);
  });
});
