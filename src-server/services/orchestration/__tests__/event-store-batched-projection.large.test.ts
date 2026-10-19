import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EventStore, type PersistedRuntimeEvent } from '../event-store.js';

describe('EventStore high-cardinality batched projection', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-store-batched-projection-'));
    store = new EventStore(join(dir, 'orchestration.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedProjectionThread(threadId: string): void {
    const base = '2026-08-20T00:00:00.000Z';
    store.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: base,
      updatedAt: base,
    });
    store.appendEvent({
      eventId: `${threadId}-started`,
      provider: 'claude',
      threadId,
      createdAt: base,
      method: 'session.started',
      sessionId: threadId,
      metadata: { agentSlug: 'claude', userId: 'owner-user' },
    });
    store.appendEvent({
      eventId: `${threadId}-configured`,
      provider: 'claude',
      threadId,
      createdAt: base,
      method: 'session.configured',
      sessionId: threadId,
      model: 'claude-sonnet-4-5',
    });
    store.appendEvent({
      eventId: `${threadId}-flow-attached`,
      provider: 'claude',
      threadId,
      createdAt: base,
      method: 'flow.run-attached',
      runId: `run-${threadId}`,
    } as any);
    store.appendEvent({
      eventId: `${threadId}-turn1-started`,
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: base,
      method: 'turn.started',
      prompt: `prompt for ${threadId}`,
    });
    store.appendEvent({
      eventId: `${threadId}-turn1-completed`,
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: base,
      method: 'turn.completed',
      finishReason: 'stop',
    } as any);
    store.appendEvent({
      eventId: `${threadId}-request-opened`,
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: base,
      method: 'request.opened',
      requestId: `${threadId}-req-1`,
      kind: 'approval',
    } as any);
    store.appendEvent({
      eventId: `${threadId}-turn2-started`,
      provider: 'claude',
      threadId,
      turnId: 'turn-2',
      createdAt: base,
      method: 'turn.started',
      prompt: `follow-up for ${threadId}`,
    });
  }

  function withoutObservedAt(
    events: readonly PersistedRuntimeEvent[],
  ): unknown[] {
    return events.map(({ observedAt: _observedAt, ...rest }) => rest);
  }

  function expectBatchedMatchesIndividual(threadId: string): void {
    const individual = store.listSessionProjectionEvents(threadId);
    const batched = store
      .listSessionProjectionEventsForThreads([threadId])
      .get(threadId);
    expect(withoutObservedAt(batched ?? [])).toEqual(
      withoutObservedAt(individual),
    );
  }

  // archive#4466 review remediation: id/thread/pair lists are chunked at 500.
  // The complete seed, batched read, and comparisons retain the original 10s
  // product-law bound; isolation moves no setup into a wider hook allowance.
  test('a population crossing the 500-id chunk boundary is folded completely and correctly', () => {
    type Operation = 'prepare' | 'exec' | 'run' | 'get' | 'all';
    type Metric = { calls: number; errors: number; elapsedMs: number };
    type Metrics = Record<Operation, Metric>;
    const emptyMetrics = (): Metrics => ({
      prepare: { calls: 0, errors: 0, elapsedMs: 0 },
      exec: { calls: 0, errors: 0, elapsedMs: 0 },
      run: { calls: 0, errors: 0, elapsedMs: 0 },
      get: { calls: 0, errors: 0, elapsedMs: 0 },
      all: { calls: 0, errors: 0, elapsedMs: 0 },
    });
    const sqlRows = new Map<
      string,
      { sha256: string; prefix: string; sqlBytes: number; metrics: Metrics }
    >();
    const overflow = emptyMetrics();
    let overflowIdentities = 0;
    const startedAt = performance.now();
    const db = store['db'];
    const originalPrepare = db.prepare;
    const originalExec = db.exec;
    const prepareDescriptor = Object.getOwnPropertyDescriptor(db, 'prepare');
    const execDescriptor = Object.getOwnPropertyDescriptor(db, 'exec');
    const rowFor = (sql: string): Metrics => {
      const existing = sqlRows.get(sql);
      if (existing) return existing.metrics;
      if (sqlRows.size === 512) {
        overflowIdentities++;
        return overflow;
      }
      const row = {
        sha256: createHash('sha256').update(sql).digest('hex'),
        prefix: sql.replace(/\s+/g, ' ').trim().slice(0, 192),
        sqlBytes: Buffer.byteLength(sql),
        metrics: emptyMetrics(),
      };
      sqlRows.set(sql, row);
      return row.metrics;
    };
    const measured = <T>(metric: Metric, forward: () => T): T => {
      metric.calls++;
      const began = performance.now();
      try {
        return forward();
      } catch (error) {
        metric.errors++;
        throw error;
      } finally {
        metric.elapsedMs += performance.now() - began;
      }
    };
    type Statement = ReturnType<typeof db.prepare>;
    const statementRestorations: Array<() => void> = [];
    const statementMethods: Array<'run' | 'get' | 'all'> = [
      'run',
      'get',
      'all',
    ];
    function observedPrepare(
      this: typeof db,
      ...args: Parameters<typeof db.prepare>
    ): Statement {
      const metrics = rowFor(args[0]);
      const statement = measured(metrics.prepare, () =>
        originalPrepare.apply(this, args),
      );
      const descriptors = {
        run: Object.getOwnPropertyDescriptor(statement, 'run'),
        get: Object.getOwnPropertyDescriptor(statement, 'get'),
        all: Object.getOwnPropertyDescriptor(statement, 'all'),
      };
      const originalRun = statement.run;
      const originalGet = statement.get;
      const originalAll = statement.all;
      statementRestorations.push(() => {
        for (const name of statementMethods) {
          const descriptor = descriptors[name];
          if (descriptor) Object.defineProperty(statement, name, descriptor);
          else if (!Reflect.deleteProperty(statement, name))
            throw new Error('SQL statement restoration failed.');
          const restored = Object.getOwnPropertyDescriptor(statement, name);
          for (const field of [
            'value',
            'get',
            'set',
            'writable',
            'enumerable',
            'configurable',
          ]) {
            if (
              Reflect.get(restored ?? {}, field) !==
              Reflect.get(descriptor ?? {}, field)
            ) {
              throw new Error('SQL statement descriptor restoration failed.');
            }
          }
        }
      });
      Object.defineProperties(statement, {
        run: {
          configurable: true,
          writable: true,
          value: function (
            this: Statement,
            ...values: Parameters<Statement['run']>
          ) {
            return measured(metrics.run, () => originalRun.apply(this, values));
          },
        },
        get: {
          configurable: true,
          writable: true,
          value: function (
            this: Statement,
            ...values: Parameters<Statement['get']>
          ) {
            return measured(metrics.get, () => originalGet.apply(this, values));
          },
        },
        all: {
          configurable: true,
          writable: true,
          value: function (
            this: Statement,
            ...values: Parameters<Statement['all']>
          ) {
            return measured(metrics.all, () => originalAll.apply(this, values));
          },
        },
      });
      return statement;
    }
    function observedExec(
      this: typeof db,
      ...args: Parameters<typeof db.exec>
    ) {
      return measured(rowFor(args[0]).exec, () =>
        originalExec.apply(this, args),
      );
    }
    const restoreMethod = (
      name: 'prepare' | 'exec',
      descriptor: PropertyDescriptor | undefined,
    ): void => {
      if (descriptor) Object.defineProperty(db, name, descriptor);
      else if (!Reflect.deleteProperty(db, name)) {
        throw new Error(`SQL diagnostic could not restore ${name}.`);
      }
      const restored = Object.getOwnPropertyDescriptor(db, name);
      for (const field of [
        'value',
        'get',
        'set',
        'writable',
        'enumerable',
        'configurable',
      ]) {
        if (
          Reflect.get(restored ?? {}, field) !==
          Reflect.get(descriptor ?? {}, field)
        ) {
          throw new Error(`SQL diagnostic ${name} descriptor changed.`);
        }
      }
    };
    const emit = (report: unknown): void => {
      const bytes = Buffer.from(JSON.stringify(report));
      if (bytes.length > 512 * 1024) {
        throw new Error('SQL diagnostic exceeded the 512 KiB retention bound.');
      }
      const receipt = {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const output = Buffer.from(
        `@@GRANULAR_SQL@@${bytes.toString()}@@END_GRANULAR_SQL@@\n` +
          `@@GRANULAR_SQL_RECEIPT@@${JSON.stringify(receipt)}@@END_GRANULAR_SQL_RECEIPT@@\n`,
      );
      let offset = 0;
      while (offset < output.length) {
        const written = writeSync(
          1,
          output,
          offset,
          Math.min(16384, output.length - offset),
        );
        if (written <= 0)
          throw new Error('SQL diagnostic stdout made no progress.');
        offset += written;
      }
    };
    let workFailed = false;
    let workError: unknown;
    let diagnosticFailed = false;
    let diagnosticError: unknown;
    let prepareRestored = false;
    let execRestored = false;
    let workElapsedMs = 0;
    try {
      Object.defineProperty(db, 'prepare', {
        configurable: true,
        writable: true,
        value: observedPrepare,
      });
      Object.defineProperty(db, 'exec', {
        configurable: true,
        writable: true,
        value: observedExec,
      });
      const totalThreads = 1200;
      const threadIds = Array.from(
        { length: totalThreads },
        (_, index) => `batch-equiv-chunk-${index}`,
      );
      threadIds.forEach((threadId) => {
        seedProjectionThread(threadId);
      });

      const batched = store.listSessionProjectionEventsForThreads(threadIds);
      expect(batched.size).toBe(totalThreads);
      for (const index of [0, 1, 250, 499, 500, 501, 750, 999, 1199]) {
        expectBatchedMatchesIndividual(threadIds[index]!);
      }
      workElapsedMs = performance.now() - startedAt;
    } catch (error) {
      workFailed = true;
      workError = error;
      workElapsedMs = performance.now() - startedAt;
    } finally {
      let restoredStatements = 0;
      for (const restore of statementRestorations) {
        try {
          restore();
          restoredStatements++;
        } catch (error) {
          diagnosticFailed = true;
          diagnosticError ??= error;
        }
      }
      try {
        restoreMethod('prepare', prepareDescriptor);
        prepareRestored = true;
      } catch (error) {
        diagnosticFailed = true;
        diagnosticError = error;
      }
      try {
        restoreMethod('exec', execDescriptor);
        execRestored = true;
      } catch (error) {
        diagnosticFailed = true;
        diagnosticError ??= error;
      }
      try {
        emit({
          version: 1,
          workElapsedMs,
          workFailed,
          prepareRestored,
          execRestored,
          diagnosticFailed,
          preparedStatementRestorations: statementRestorations.length,
          restoredStatements,
          sqlIdentityLimit: 512,
          overflowIdentities,
          overflow,
          rows: [...sqlRows.values()],
          limits:
            'Watched native-backed wall time; includes observer/proxy/clock and scheduler overhead. No bind values; no claim of unobserved timing.',
        });
      } catch (error) {
        diagnosticFailed = true;
        diagnosticError ??= error;
      }
    }
    if (workFailed) throw workError;
    if (diagnosticFailed) throw diagnosticError;
    if (overflowIdentities > 0)
      throw new Error('SQL diagnostic identity coverage overflowed.');
  }, 10_000);
});
