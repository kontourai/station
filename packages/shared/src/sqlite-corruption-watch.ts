import { explicitCorruption } from './sqlite-integrity.js';

/**
 * Notice corruption where it actually surfaces, rather than only where we go
 * looking for it.
 *
 * Station used to run `PRAGMA quick_check` on every EventStore open. That
 * cost O(database size) on the boot path — measured at 587ms cold on a 61MB
 * store, growing with the user's history forever — and a database that
 * corrupts *after* boot was not noticed at all until the next start.
 * station#3219 removed that check; this watch is a detection path, beside
 * the scheduled probe (station#3218), which covers pages nothing reads.
 *
 * Chromium and Firefox both take the other approach: no check on open (Chromium
 * skips it entirely above 8MB even when corruption is already confirmed), and
 * instead classify the error SQLite itself raises during ordinary work.
 *
 * This is that classifier. It wraps the connection rather than each of the
 * ~67 call sites, because a per-site change is one somebody forgets to make at
 * the sixty-eighth site (station#3215).
 */
export interface SqliteCorruptionObserver {
  /** Called once per connection, on the first corruption error observed. */
  onCorruptionObserved(error: unknown): void;
}

interface WatchableDatabase {
  prepare(sql: string): unknown;
  exec(sql: string): unknown;
}

/**
 * Returns a proxy that reports corruption and rethrows, leaving behaviour
 * otherwise identical.
 *
 * Rethrowing is deliberate: this observes, it does not recover. The caller's
 * existing error handling is unchanged, so adopting the watch cannot alter
 * what any query does — only what Station knows afterwards.
 *
 * Known gap: only `prepare`'s result is wrapped, so a statement driven with
 * `.iterate()` yields an iterator whose `next()` is unobserved. There are
 * zero `.iterate(` call sites in src-server and packages today, but it is the
 * natural optimisation somebody will reach for on a large `listEvents`, and
 * it would silently leave this seam.
 */
export function watchForSqliteCorruption<T extends WatchableDatabase>(
  database: T,
  observer: SqliteCorruptionObserver,
): T {
  let reported = false;
  const report = (error: unknown): void => {
    // Once per connection. A corrupt page hit in a loop would otherwise write
    // the marker thousands of times, and the first observation is the one
    // that carries the truthful timestamp.
    if (reported || !explicitCorruption(error)) return;
    reported = true;
    try {
      observer.onCorruptionObserved(error);
    } catch {
      // The observer must never convert a query failure into a different
      // failure. A marker that could not be written is a lost diagnosis, not
      // a reason to change what the caller sees.
    }
  };

  const wrapStatement = (statement: unknown): unknown => {
    if (typeof statement !== 'object' || statement === null) return statement;
    return new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          try {
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (error) {
            report(error);
            throw error;
          }
        };
      },
    });
  };

  return new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
          // `prepare` returns a statement whose own methods are where the
          // read actually happens — corruption surfaces on `.all()`/`.run()`,
          // not on preparing the SQL.
          return property === 'prepare' ? wrapStatement(result) : result;
        } catch (error) {
          report(error);
          throw error;
        }
      };
    },
  }) as T;
}
