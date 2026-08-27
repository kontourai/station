import { describe, expect, test, vi } from 'vitest';
import { watchForSqliteCorruption } from '../sqlite-corruption-watch.js';

/**
 * station#3215. The boot-path `quick_check` costs O(database size) and its
 * only product is an error nothing catches. This watch is the replacement's
 * first half: notice corruption where SQLite itself raises it, during
 * ordinary work, so detection no longer depends on a check we are about to
 * stop running on every open.
 */
function corruptError() {
  return Object.assign(new Error('database disk image is malformed'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 11,
    errstr: 'database disk image is malformed',
  });
}

function fakeDb(onAll: () => unknown) {
  return {
    exec: vi.fn((_sql: string) => undefined),
    prepare: vi.fn((_sql: string) => ({ all: onAll, run: onAll })),
  };
}

describe('corruption is observed where it surfaces', () => {
  test('a corrupt read reports, and still throws', () => {
    const onCorruptionObserved = vi.fn();
    const db = watchForSqliteCorruption(
      fakeDb(() => {
        throw corruptError();
      }),
      { onCorruptionObserved },
    );

    // Behaviour must be unchanged: this observes, it does not recover.
    expect(() => db.prepare('SELECT 1').all()).toThrow('malformed');
    expect(onCorruptionObserved).toHaveBeenCalledTimes(1);
  });

  test('it reports once per connection, not once per failing query', () => {
    // A corrupt page hit inside a loop would otherwise write the marker
    // thousands of times, and the FIRST observation carries the truthful
    // timestamp.
    const onCorruptionObserved = vi.fn();
    const db = watchForSqliteCorruption(
      fakeDb(() => {
        throw corruptError();
      }),
      { onCorruptionObserved },
    );

    for (let i = 0; i < 5; i += 1) {
      expect(() => db.prepare('SELECT 1').all()).toThrow();
    }
    expect(onCorruptionObserved).toHaveBeenCalledTimes(1);
  });

  test('an ordinary failure is not reported as corruption', () => {
    // The negative control. Claiming corruption for a constraint violation
    // would quarantine a healthy database — strictly worse than the cost this
    // change removes.
    const onCorruptionObserved = vi.fn();
    const db = watchForSqliteCorruption(
      fakeDb(() => {
        throw Object.assign(new Error('UNIQUE constraint failed'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 19,
        });
      }),
      { onCorruptionObserved },
    );

    expect(() => db.prepare('INSERT …').run()).toThrow('UNIQUE');
    expect(onCorruptionObserved).not.toHaveBeenCalled();
  });

  test('a failing observer cannot change what the caller sees', () => {
    // A marker that could not be written is a lost diagnosis, not a reason to
    // turn a query failure into a different failure.
    const db = watchForSqliteCorruption(
      fakeDb(() => {
        throw corruptError();
      }),
      {
        onCorruptionObserved() {
          throw new Error('marker write failed');
        },
      },
    );

    expect(() => db.prepare('SELECT 1').all()).toThrow('malformed');
  });

  test('a healthy read passes through untouched', () => {
    const onCorruptionObserved = vi.fn();
    const db = watchForSqliteCorruption(
      fakeDb(() => [{ ok: 1 }]),
      {
        onCorruptionObserved,
      },
    );

    expect(db.prepare('SELECT 1').all()).toEqual([{ ok: 1 }]);
    expect(onCorruptionObserved).not.toHaveBeenCalled();
  });

  test('corruption raised by exec is observed too', () => {
    // Migrations and PRAGMAs go through exec, not prepare.
    const onCorruptionObserved = vi.fn();
    const db = watchForSqliteCorruption(
      {
        prepare: vi.fn((_sql: string) => ({})),
        exec: vi.fn((_sql: string) => {
          throw corruptError();
        }),
      },
      { onCorruptionObserved },
    );

    expect(() => db.exec('CREATE INDEX …')).toThrow('malformed');
    expect(onCorruptionObserved).toHaveBeenCalledTimes(1);
  });
});
