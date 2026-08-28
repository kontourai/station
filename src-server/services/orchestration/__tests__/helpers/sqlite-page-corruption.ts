import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): {
      get(
        ...values: unknown[]
      ): { page_size?: number; rootpage?: number } | undefined;
    };
    close(): void;
  };
};

export interface SqliteTablePage {
  readonly databasePath: string;
  readonly table: string;
  readonly pageSize: number;
  readonly rootPage: number;
}

/**
 * Resolves an actual b-tree page while the database is healthy, then closes
 * the inspector before any bytes are changed. Fixture corruption must target
 * the table the EventStore will read, not a host-dependent byte range.
 */
export function locateSqliteTablePage(
  databasePath: string,
  table: string,
): SqliteTablePage {
  const inspector = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const pageSize = inspector.prepare('PRAGMA page_size').get()?.page_size;
    const rootPage = inspector
      .prepare(
        "SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(table)?.rootpage;
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize === undefined ||
      pageSize < 512 ||
      !Number.isSafeInteger(rootPage) ||
      rootPage === undefined ||
      rootPage < 2
    )
      throw new Error(`Could not locate SQLite table page for ${table}`);
    return { databasePath, table, pageSize, rootPage };
  } finally {
    inspector.close();
  }
}

/** Damages the exact root b-tree page captured by `locateSqliteTablePage`. */
export function damageSqliteTablePage(page: SqliteTablePage): void {
  const bytes = readFileSync(page.databasePath);
  const offset = (page.rootPage - 1) * page.pageSize;
  if (offset < page.pageSize || offset + page.pageSize > bytes.byteLength)
    throw new Error(`SQLite table page is outside ${page.databasePath}`);
  // A b-tree page's type byte and cell-pointer array are both in this prefix.
  // Leave the file header untouched so the observer reaches a real table read.
  bytes.fill(0x5a, offset, offset + Math.min(page.pageSize, 256));
  writeFileSync(page.databasePath, bytes);
}
