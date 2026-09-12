/**
 * The structural shape of the one open SQLite connection `EventStore` owns,
 * as its composed persistence modules see it. Three modules had each declared
 * this identically; the extraction plan would have made it ten.
 *
 * Deliberately structural rather than an import of the driver's own type:
 * `node:sqlite`'s `DatabaseSync` is loaded through a `require` seam in
 * `event-store.ts`, and a persistence module needs `exec` and `prepare` and
 * nothing else — not `close`, which stays the store's to call.
 */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: unknown[]): unknown;
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
  };
}
