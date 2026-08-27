import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  type OperationalEventEnvelope,
} from '@kontourai/station-contracts/operational-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATIONAL_EVENT_OUTBOX_MIGRATION } from '../../../domain/migrations/004-operational-events.js';
import { EventStore } from '../../orchestration/event-store.js';
import { createOperationalEventOutbox } from '../operational-event-outbox.js';
import {
  createSqliteOperationalEventCoordinator,
  OPERATIONAL_EVENT_RETENTION,
  type OperationalEventSqliteDatabase,
} from '../sqlite-operational-event-outbox.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: unknown[]): unknown;
      get(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
    };
    close(): void;
  };
};

const directories: string[] = [];
const children = new Set<ChildProcess>();

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'station-operational-events-'));
  directories.push(directory);
  return join(directory, 'events.sqlite');
}

function event(
  id: string,
  overrides: Partial<OperationalEventEnvelope> = {},
): OperationalEventEnvelope {
  return {
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
    id,
    type: 'station.runtime.lifecycle/v1',
    producer: { id: 'station-server', version: '1' },
    occurredAt: '2026-08-16T00:00:00.000Z',
    scopes: [],
    payload: {
      schema: 'station.runtime.lifecycle/v1',
      data: { phase: 'ready' },
    },
    privacy: 'private',
    delivery: 'durable',
    ...overrides,
  };
}

function outboxFor(
  store: EventStore,
  notification?: Parameters<EventStore['createOperationalEventPublisher']>[0],
) {
  const publisher = store.createOperationalEventPublisher(notification);
  const reader = store.operationalEventReader();
  return {
    append: (value: unknown) => publisher.append(value),
    readAfter: (input?: Parameters<typeof reader.readAfter>[0]) =>
      reader.readAfter(input),
  };
}

async function spawnOperationalEventAppender(
  path: string,
  worker: number,
): Promise<{ child: ChildProcess; output: () => string }> {
  const eventStorePath = new URL(
    '../../orchestration/event-store.ts',
    import.meta.url,
  ).pathname;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { EventStore } from ${JSON.stringify(eventStorePath)};
       const store = new EventStore(process.argv[1]);
       const publisher = store.createOperationalEventPublisher();
       const event = (id) => ({
         schemaVersion: 'station.operational-event/v1',
         id,
         type: 'station.runtime.lifecycle/v1',
         producer: { id: 'station-server', version: '1' },
         occurredAt: '2026-08-16T00:00:00.000Z',
         scopes: [],
         payload: { schema: 'station.runtime.lifecycle/v1', data: { phase: 'ready' } },
         privacy: 'private',
         delivery: 'durable',
       });
       process.stdout.write('ready\\n');
       process.stdin.once('data', () => {
         const shared = publisher.append(event('shared-event'));
         const unique = [];
         for (let index = 0; index < 8; index += 1)
           unique.push(publisher.append(event('worker-${worker}-' + index)));
         process.stdout.write(JSON.stringify({ shared, unique }) + '\\n');
         store.close();
         process.exit(0);
       });`,
      path,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  children.add(child);
  let output = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
  });
  await once(child.stdout!, 'data');
  if (!output.includes('ready\n'))
    throw new Error(`Appender did not become ready: ${stderr}`);
  return { child, output: () => output };
}

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('OperationalEventOutbox', () => {
  it('validates before persistence and rejects ephemeral delivery', () => {
    const store = new EventStore(databasePath());
    const outbox = outboxFor(store);

    expect(outbox.append({ id: 'not-an-envelope' })).toMatchObject({
      kind: 'rejected',
    });
    expect(
      outbox.append(event('ephemeral-1', { delivery: 'ephemeral' })),
    ).toEqual({
      kind: 'rejected',
      diagnostics: [
        expect.objectContaining({
          code: 'invalid-delivery',
          path: 'delivery',
        }),
      ],
    });
    expect(outbox.readAfter()).toEqual({
      kind: 'available',
      events: [],
      hasMore: false,
      latestJournalSequence: 0,
    });
    store.close();
  });

  it('appends before notification, rejects duplicate ids, and pages in stable order', () => {
    const store = new EventStore(databasePath());
    const notifications: number[] = [];
    const outbox = outboxFor(store, {
      appended: ({ journalSequence }) => notifications.push(journalSequence),
    });

    expect(outbox.append(event('event-1'))).toMatchObject({
      kind: 'appended',
      journalSequence: 1,
    });
    expect(outbox.append(event('event-2'))).toMatchObject({
      kind: 'appended',
      journalSequence: 2,
    });
    expect(
      outbox.append(
        event('event-1', {
          payload: {
            schema: 'station.runtime.lifecycle/v1',
            data: { phase: 'different' },
          },
        }),
      ),
    ).toEqual({ kind: 'duplicate', journalSequence: 1 });
    expect(notifications).toEqual([1, 2]);
    expect(outbox.readAfter({ limit: 1 })).toMatchObject({
      kind: 'available',
      events: [{ journalSequence: 1, event: { id: 'event-1' } }],
      hasMore: true,
      latestJournalSequence: 2,
    });
    expect(
      outbox.readAfter({ afterJournalSequence: 1, limit: 10 }),
    ).toMatchObject({
      kind: 'available',
      events: [{ journalSequence: 2, event: { id: 'event-2' } }],
      hasMore: false,
      latestJournalSequence: 2,
    });
    store.close();
  });

  it('serializes real concurrent constructors and appends into one exact sequence', async () => {
    const path = databasePath();
    new EventStore(path).close();
    const appenders = await Promise.all(
      Array.from({ length: 4 }, (_, worker) =>
        spawnOperationalEventAppender(path, worker),
      ),
    );
    for (const { child } of appenders) child.stdin!.write('go\n');
    const exitCodes = await Promise.all(
      appenders.map(async ({ child }) => {
        const [code] = await once(child, 'exit');
        children.delete(child);
        return code;
      }),
    );
    expect(exitCodes).toEqual([0, 0, 0, 0]);

    const results = appenders.map(({ output }) =>
      JSON.parse(output().trim().split('\n').at(-1)!),
    ) as Array<{
      shared: { kind: string };
      unique: Array<{ kind: string }>;
    }>;
    expect(
      results.filter(({ shared }) => shared.kind === 'appended'),
    ).toHaveLength(1);
    expect(
      results.filter(({ shared }) => shared.kind === 'duplicate'),
    ).toHaveLength(3);
    expect(results.flatMap(({ unique }) => unique)).toHaveLength(32);
    expect(
      results
        .flatMap(({ unique }) => unique)
        .every(({ kind }) => kind === 'appended'),
    ).toBe(true);

    const store = new EventStore(path);
    const page = store.operationalEventReader().readAfter({ limit: 100 });
    expect(page.kind).toBe('available');
    if (page.kind !== 'available') throw new Error('expected concurrent page');
    expect(page.events).toHaveLength(33);
    expect(page.events.map(({ journalSequence }) => journalSequence)).toEqual(
      Array.from({ length: 33 }, (_, index) => index + 1),
    );
    expect(new Set(page.events.map(({ event }) => event.id)).size).toBe(33);
    store.close();
  });

  it('keeps the durable append receipt when notification throws', () => {
    const store = new EventStore(databasePath());
    const outbox = outboxFor(store, {
      appended: () => {
        throw new Error('observer unavailable');
      },
    });

    expect(outbox.append(event('event-1'))).toMatchObject({
      kind: 'appended',
      journalSequence: 1,
    });
    expect(outbox.readAfter()).toMatchObject({
      kind: 'available',
      events: [{ journalSequence: 1 }],
    });
    store.close();
  });

  it('uses exact readback after a commit-then-throw append boundary', () => {
    const fault = vi.fn(() => {
      throw new Error('after commit');
    });
    const database = new DatabaseSync(
      databasePath(),
    ) as OperationalEventSqliteDatabase & { close(): void };
    database.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const outbox = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({
        database,
        afterAppendCommit: fault,
      }),
    });

    expect(outbox.append(event('event-1'))).toMatchObject({
      kind: 'appended',
      journalSequence: 1,
    });
    expect(fault).toHaveBeenCalledOnce();
    expect(outbox.append(event('event-1'))).toEqual({
      kind: 'duplicate',
      journalSequence: 1,
    });
    database.close();
  });

  it('retains appended truth when a concurrent writer prunes the payload after commit', () => {
    const path = databasePath();
    const firstDatabase = new DatabaseSync(
      path,
    ) as OperationalEventSqliteDatabase & { close(): void };
    firstDatabase.exec('PRAGMA journal_mode = WAL');
    firstDatabase.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const secondDatabase = new DatabaseSync(
      path,
    ) as OperationalEventSqliteDatabase & { close(): void };
    secondDatabase.exec('PRAGMA journal_mode = WAL');
    secondDatabase.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const second = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({
        database: secondDatabase,
        retention: 1,
      }),
    });
    const notifications: number[] = [];
    const first = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({
        database: firstDatabase,
        retention: 1,
        afterAppendCommit: () => {
          expect(second.append(event('event-2'))).toMatchObject({
            kind: 'appended',
            journalSequence: 2,
          });
          throw new Error('after concurrent prune');
        },
      }),
      notification: {
        appended: ({ journalSequence }) => notifications.push(journalSequence),
      },
    });

    expect(first.append(event('event-1'))).toMatchObject({
      kind: 'appended',
      journalSequence: 1,
    });
    expect(notifications).toEqual([1]);
    expect(first.readAfter()).toMatchObject({
      kind: 'available',
      events: [{ journalSequence: 2, event: { id: 'event-2' } }],
      gap: { earliestAvailableJournalSequence: 2 },
    });
    expect(first.append(event('event-1'))).toEqual({
      kind: 'duplicate',
      journalSequence: 1,
    });
    secondDatabase.close();
    firstDatabase.close();
  });

  it('distinguishes producer-local sequence from SQLite journal sequence', () => {
    const store = new EventStore(databasePath());
    const outbox = outboxFor(store);
    const sequenced = event('producer-sequenced', { sequence: 999 });

    expect(outbox.append(sequenced)).toMatchObject({
      kind: 'appended',
      journalSequence: 1,
      event: { sequence: 999 },
    });
    expect(outbox.readAfter()).toMatchObject({
      kind: 'available',
      latestJournalSequence: 1,
      events: [
        {
          journalSequence: 1,
          event: { id: 'producer-sequenced', sequence: 999 },
        },
      ],
    });
    store.close();
  });

  it('reads bounds and rows from one snapshot during concurrent retention', () => {
    const path = databasePath();
    const readerDatabase = new DatabaseSync(
      path,
    ) as OperationalEventSqliteDatabase & {
      close(): void;
    };
    readerDatabase.exec('PRAGMA journal_mode = WAL');
    readerDatabase.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const writerDatabase = new DatabaseSync(
      path,
    ) as OperationalEventSqliteDatabase & {
      close(): void;
    };
    writerDatabase.exec('PRAGMA journal_mode = WAL');
    writerDatabase.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const writer = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({
        database: writerDatabase,
        retention: 2,
      }),
    });
    expect(writer.append(event('event-1'))).toMatchObject({ kind: 'appended' });
    expect(writer.append(event('event-2'))).toMatchObject({ kind: 'appended' });

    const reader = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({
        database: readerDatabase,
        retention: 2,
        afterReadBounds: () => {
          expect(writer.append(event('event-3'))).toMatchObject({
            kind: 'appended',
            journalSequence: 3,
          });
        },
      }),
    });
    expect(reader.readAfter({ limit: 10 })).toMatchObject({
      kind: 'available',
      latestJournalSequence: 2,
      events: [{ journalSequence: 1 }, { journalSequence: 2 }],
    });
    expect(
      createOperationalEventOutbox({
        coordinator: createSqliteOperationalEventCoordinator({
          database: readerDatabase,
          retention: 2,
        }),
      }).readAfter({ afterJournalSequence: 2, limit: 10 }),
    ).toMatchObject({
      kind: 'available',
      latestJournalSequence: 3,
      events: [{ journalSequence: 3 }],
    });
    writerDatabase.close();
    readerDatabase.close();
  });

  it('bounds retained history and exposes a replay gap without inventing continuity', () => {
    const path = databasePath();
    const store = new EventStore(path);
    const outbox = outboxFor(store);
    const total = OPERATIONAL_EVENT_RETENTION + 2;
    for (let index = 1; index <= total; index += 1) {
      expect(outbox.append(event(`event-${index}`))).toMatchObject({
        kind: 'appended',
        journalSequence: index,
      });
    }

    const page = outbox.readAfter({ limit: OPERATIONAL_EVENT_RETENTION });
    expect(page).toMatchObject({
      kind: 'available',
      hasMore: false,
      latestJournalSequence: total,
      gap: {
        requestedAfterJournalSequence: 0,
        earliestAvailableJournalSequence: 3,
      },
    });
    if (page.kind !== 'available') throw new Error('expected available page');
    expect(page.events).toHaveLength(OPERATIONAL_EVENT_RETENTION);
    expect(page.events[0]).toMatchObject({
      journalSequence: 3,
      event: { id: 'event-3' },
    });
    expect(page.events.at(-1)).toMatchObject({
      journalSequence: total,
      event: { id: `event-${total}` },
    });
    expect(outbox.append(event('event-1'))).toEqual({
      kind: 'duplicate',
      journalSequence: 1,
    });
    store.close();

    const reopened = new EventStore(path);
    expect(
      reopened
        .createOperationalEventPublisher()
        .append(event('event-1', { sequence: 700 })),
    ).toEqual({ kind: 'duplicate', journalSequence: 1 });
    reopened.close();
  });

  it('fails closed when retained bytes are corrupt', () => {
    const path = databasePath();
    const store = new EventStore(path);
    expect(outboxFor(store).append(event('event-1'))).toMatchObject({
      kind: 'appended',
    });
    store.close();

    const database = new DatabaseSync(path);
    database
      .prepare(
        'UPDATE operational_events SET envelope_json = ? WHERE event_id = ?',
      )
      .run('{', 'event-1');
    database.close();

    const reopened = new EventStore(path);
    expect(outboxFor(reopened).readAfter()).toEqual({
      kind: 'unavailable',
    });
    reopened.close();
  });

  it('revalidates a well-formed but invalid persisted envelope', () => {
    const path = databasePath();
    const store = new EventStore(path);
    expect(
      store.createOperationalEventPublisher().append(event('event-1')),
    ).toMatchObject({ kind: 'appended' });
    store.close();

    const database = new DatabaseSync(path);
    database
      .prepare(
        'UPDATE operational_events SET envelope_json = ? WHERE event_id = ?',
      )
      .run(
        JSON.stringify({
          ...event('event-1'),
          schemaVersion: 'station.operational-event/v999',
        }),
        'event-1',
      );
    database.close();

    const reopened = new EventStore(path);
    expect(outboxFor(reopened).readAfter()).toEqual({
      kind: 'unavailable',
    });
    reopened.close();
  });

  it('rejects unbounded replay inputs before storage access', () => {
    const store = new EventStore(databasePath());
    const outbox = outboxFor(store);
    expect(outbox.readAfter({ afterJournalSequence: -1 })).toEqual({
      kind: 'rejected',
      code: 'invalid-cursor',
    });
    expect(outbox.readAfter({ limit: 1_001 })).toEqual({
      kind: 'rejected',
      code: 'invalid-limit',
    });
    expect(outbox.readAfter({ afterJournalSequence: 1 })).toEqual({
      kind: 'rejected',
      code: 'invalid-cursor',
    });
    store.close();
  });
});
