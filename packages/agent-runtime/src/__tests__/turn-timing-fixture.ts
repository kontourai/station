import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';

type Measurement = {
  syncMs: number;
  commitMs: number;
  preCommitMs: number;
  transactions: number;
  depth: number;
  entered: number;
  began?: number;
  done: boolean;
};

/** Count complete main-thread execution spans, excluding waits and native COMMIT. */
export function timeAgentTransactions(database: DatabaseSync) {
  const storage = new AsyncLocalStorage<Measurement>();
  const resources = new Map<number, Measurement>();
  const enter = (scope: Measurement) => {
    if (scope.depth++ === 0) scope.entered = performance.now();
  };
  const leave = (scope: Measurement) => {
    if (--scope.depth === 0) scope.syncMs += performance.now() - scope.entered;
  };
  const hook = createHook({
    init(id) {
      const scope = storage.getStore();
      if (scope && !scope.done) resources.set(id, scope);
    },
    before(id) {
      const scope = resources.get(id);
      if (scope && !scope.done) enter(scope);
    },
    after(id) {
      const scope = resources.get(id);
      if (scope && !scope.done) leave(scope);
    },
    destroy(id) {
      resources.delete(id);
    },
  }).enable();
  const execute = database.exec.bind(database);
  const spy = vi.spyOn(database, 'exec').mockImplementation((sql) => {
    const scope = storage.getStore();
    if (!scope || scope.done) return execute(sql);
    if (/^BEGIN(?: IMMEDIATE)?$/.test(sql)) scope.began = performance.now();
    if (sql !== 'COMMIT') return execute(sql);
    if (scope.began === undefined)
      throw new Error('Transaction timing requires BEGIN');
    const atCommit = performance.now();
    scope.preCommitMs += atCommit - scope.began;
    try {
      return execute(sql);
    } finally {
      scope.commitMs += performance.now() - atCommit;
      scope.transactions++;
      scope.began = undefined;
    }
  });
  return {
    async measure<T>(work: () => Promise<T>) {
      const scope: Measurement = {
        syncMs: 0,
        commitMs: 0,
        preCommitMs: 0,
        transactions: 0,
        depth: 0,
        entered: 0,
        done: false,
      };
      const started = performance.now();
      try {
        const pending = storage.run(scope, () => {
          enter(scope);
          try {
            return work();
          } finally {
            leave(scope);
          }
        });
        const result = await pending;
        if (!scope.transactions)
          throw new Error('No native transactions observed');
        if (scope.depth !== 0 || scope.syncMs < scope.commitMs)
          throw new Error('Incomplete execution-span measurement');
        return {
          result,
          rawMs: performance.now() - started,
          workMs: scope.syncMs - scope.commitMs,
          commitMs: scope.commitMs,
          preCommitMs: scope.preCommitMs,
        };
      } finally {
        scope.done = true;
      }
    },
    restore() {
      hook.disable();
      storage.disable();
      resources.clear();
      spy.mockRestore();
    },
  };
}
