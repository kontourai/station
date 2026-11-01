import { vi } from 'vitest';
import type { EventStore } from '../../event-store.js';
import type { SqliteDatabase } from '../../sqlite-database.js';

/** Observe or fault an actual recovery statement without replacing its results. */
function observeStatement(
  store: EventStore,
  match: (sql: string) => boolean,
  operation: 'all' | 'get',
) {
  const database = (store as unknown as { db: SqliteDatabase }).db;
  const prepare = database.prepare.bind(database);
  const before = vi.fn<(...args: unknown[]) => void>();
  vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!match(sql)) return statement;
    return {
      all: (...args) => {
        if (operation === 'all') before(...args);
        return statement.all(...args);
      },
      get: (...args) => {
        if (operation === 'get') before(...args);
        return statement.get(...args);
      },
      run: (...args) => statement.run(...args),
    };
  });
  return before;
}

export function observeRecoveryScans(store: EventStore) {
  return observeStatement(
    store,
    (sql) =>
      sql.includes('dispatch_owner_identity_kind, credential_attempt_id') &&
      sql.includes('ORDER BY updated_at ASC, created_at ASC'),
    'all',
  );
}

export function observeRecoveryFences(store: EventStore) {
  return observeStatement(
    store,
    (sql) =>
      sql.includes("SET outcome = 'indeterminate', updated_at = ?") &&
      sql.includes('dispatch_owner_id IS ?'),
    'get',
  );
}
