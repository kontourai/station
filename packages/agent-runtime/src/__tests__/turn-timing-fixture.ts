import type { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';

/** Observe the real SQLite barrier; neither replace nor batch any writes. */
export function timeAgentTransactions(database: DatabaseSync) {
  const execute = database.exec.bind(database);
  const transactions: { workMs: number; commitMs: number }[] = [];
  let started: number | undefined;
  const spy = vi.spyOn(database, 'exec').mockImplementation((sql) => {
    if (/^BEGIN(?: IMMEDIATE)?$/.test(sql)) started = performance.now();
    if (sql !== 'COMMIT') return execute(sql);
    if (started === undefined)
      throw new Error('Transaction timing requires BEGIN');
    const atCommit = performance.now();
    const workMs = atCommit - started;
    try {
      return execute(sql);
    } finally {
      transactions.push({ workMs, commitMs: performance.now() - atCommit });
      started = undefined;
    }
  });
  return {
    async measure<T>(work: () => Promise<T>) {
      const offset = transactions.length;
      const started = performance.now();
      const result = await work();
      const rawMs = performance.now() - started;
      const selected = transactions.slice(offset);
      if (selected.length === 0)
        throw new Error('No native transactions observed');
      return {
        result,
        rawMs,
        workMs: selected.reduce((sum, row) => sum + row.workMs, 0),
        commitMs: selected.reduce((sum, row) => sum + row.commitMs, 0),
      };
    },
    restore: () => spy.mockRestore(),
  };
}
