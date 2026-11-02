import type { DatabaseSync, StatementSync } from 'node:sqlite';

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
/** SQLite recompiles a prepared statement when its schema or authorizer changes. */
export function agentStatement(
  database: DatabaseSync,
  sql: string,
): StatementSync {
  let cache = statements.get(database);
  if (!cache) {
    cache = new Map();
    statements.set(database, cache);
  }
  const known = cache.get(sql);
  if (known) return known;
  const statement = database.prepare(sql);
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(sql, statement);
  return statement;
}
