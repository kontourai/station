import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  type OperationalEventEnvelope,
  type OperationalEventScope,
} from '@kontourai/station-contracts/operational-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATIONAL_EVENT_OUTBOX_MIGRATION } from '../../../domain/migrations/004-operational-events.js';
import { EventStore } from '../../orchestration/event-store.js';
import {
  MAX_OPERATIONAL_EVENT_CONSUMERS,
  MAX_OPERATIONAL_EVENT_DEAD_LETTERS,
  type OperationalEventDeliveryCoordinator,
  type OperationalEventDeliveryOwner,
  openOperationalEventConsumer,
} from '../operational-event-delivery.js';
import {
  createOperationalEventOutbox,
  type OperationalEventPublisher,
} from '../operational-event-outbox.js';
import { createSqliteOperationalEventDeliveryCoordinator } from '../sqlite-operational-event-delivery.js';
import {
  createSqliteOperationalEventCoordinator,
  type OperationalEventSqliteDatabase,
} from '../sqlite-operational-event-outbox.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => OperationalEventSqliteDatabase & {
    close(): void;
  };
};

const directories: string[] = [];
const children = new Set<ChildProcess>();

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'station-event-delivery-'));
  directories.push(directory);
  return join(directory, 'events.sqlite');
}

function event(
  id: string,
  scopes: OperationalEventScope[] = [],
): OperationalEventEnvelope {
  return {
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
    id,
    type: 'station.runtime.lifecycle/v1',
    producer: { id: 'station-server', version: '1' },
    occurredAt: '2026-08-16T00:00:00.000Z',
    scopes,
    payload: {
      schema: 'station.runtime.lifecycle/v1',
      data: { phase: 'ready' },
    },
    privacy: 'private',
    delivery: 'durable',
  };
}

function directRuntime(input: {
  retention?: number;
  now?: () => string;
  afterClaimCommit?: () => void;
  afterAcknowledgeCommit?: () => void;
  afterGapCommit?: () => void;
  afterRetryCommit?: () => void;
  afterDeadLetterCommit?: () => void;
  beforeReceiptDiscard?: () => void;
}) {
  const database = new DatabaseSync(databasePath());
  database.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
  const publisher = createOperationalEventOutbox({
    coordinator: createSqliteOperationalEventCoordinator({
      database,
      ...(input.retention ? { retention: input.retention } : {}),
    }),
  });
  const owner: OperationalEventDeliveryOwner = {
    id: 'owner-1',
    pid: process.pid,
    birth: 'birth-1',
    identityKind: 'exact',
  };
  const opened = openOperationalEventConsumer({
    coordinator: createSqliteOperationalEventDeliveryCoordinator({
      database,
      afterClaimCommit: input.afterClaimCommit,
      afterAcknowledgeCommit: input.afterAcknowledgeCommit,
      afterGapCommit: input.afterGapCommit,
      afterRetryCommit: input.afterRetryCommit,
      afterDeadLetterCommit: input.afterDeadLetterCommit,
      beforeReceiptDiscard: input.beforeReceiptDiscard,
    }),
    config: {
      consumerId: 'consumer-1',
      eventTypes: ['station.runtime.lifecycle/v1'],
      requiredScopes: [],
    },
    owner,
    now: input.now,
    processIdentity: {
      exact: () => ({ pid: process.pid, start: 'birth-1' }),
      probe: () => ({
        state: 'exact',
        identity: { pid: process.pid, start: 'birth-1' },
      }),
    },
  });
  if (opened.kind !== 'opened') throw new Error(`open failed: ${opened.kind}`);
  return { database, publisher, consumer: opened.consumer };
}

function append(
  publisher: OperationalEventPublisher,
  value: OperationalEventEnvelope,
) {
  expect(publisher.append(value)).toMatchObject({ kind: 'appended' });
}

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function spawnClaimingConsumer(path: string): Promise<{
  child: ChildProcess;
  claim: { attempt: number; idempotencyKey: string };
}> {
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
       const opened = store.openOperationalEventConsumer({
         consumerId: 'process-consumer',
         eventTypes: ['station.runtime.lifecycle/v1'],
         requiredScopes: [],
       });
       if (opened.kind !== 'opened') throw new Error('consumer open failed');
       const result = opened.consumer.claim();
       if (result.kind !== 'delivery') throw new Error('claim failed: ' + result.kind);
       process.stdout.write(JSON.stringify({
         attempt: result.claim.attempt,
         idempotencyKey: result.claim.idempotencyKey,
       }) + '\\n');
       setInterval(() => {}, 60_000);`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  children.add(child);
  child.stdout!.setEncoding('utf8');
  const [chunk] = (await once(child.stdout!, 'data')) as [string];
  return {
    child,
    claim: JSON.parse(chunk.trim()) as {
      attempt: number;
      idempotencyKey: string;
    },
  };
}

describe('OperationalEventDelivery', () => {
  it('filters by type and scope, serializes consumers, and advances only on exact settlement', () => {
    const path = databasePath();
    const first = new EventStore(path);
    const publisher = first.createOperationalEventPublisher();
    append(
      publisher,
      event('project-a-1', [{ kind: 'project', projectId: 'a' }]),
    );
    append(
      publisher,
      event('project-b-1', [{ kind: 'project', projectId: 'b' }]),
    );
    append(
      publisher,
      event('project-a-2', [{ kind: 'project', projectId: 'a' }]),
    );
    const config = {
      consumerId: 'project-a-consumer',
      eventTypes: ['station.runtime.lifecycle/v1'],
      requiredScopes: [{ kind: 'project', projectId: 'a' }] as const,
    };
    const opened = first.openOperationalEventConsumer(config);
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') throw new Error('consumer did not open');
    const claimed = opened.consumer.claim();
    expect(claimed.kind).toBe('delivery');
    if (claimed.kind !== 'delivery') throw new Error('delivery not claimed');
    expect(claimed.claim.event.id).toBe('project-a-1');
    expect(claimed.claim.attempt).toBe(1);

    const second = new EventStore(path);
    const competing = second.openOperationalEventConsumer(config);
    expect(competing.kind).toBe('opened');
    if (competing.kind !== 'opened') throw new Error('competitor did not open');
    expect(competing.consumer.claim()).toEqual({ kind: 'busy' });
    expect(claimed.claim.acknowledge()).toEqual({ kind: 'applied' });
    const next = opened.consumer.claim();
    expect(next.kind).toBe('delivery');
    if (next.kind !== 'delivery') throw new Error('next delivery absent');
    expect(next.claim.event.id).toBe('project-a-2');
    expect(next.claim.deadLetter('consumer_rejected')).toEqual({
      kind: 'applied',
    });
    expect(opened.consumer.claim()).toEqual({ kind: 'empty' });
    expect(opened.consumer.deadLetters()).toMatchObject({
      kind: 'available',
      entries: [
        {
          journalSequence: 3,
          eventId: 'project-a-2',
          failureCode: 'consumer_rejected',
        },
      ],
    });
    second.close();
    first.close();
  });

  it('reclaims a released owner with the same idempotency key and a new attempt', () => {
    const path = databasePath();
    const first = new EventStore(path);
    append(first.createOperationalEventPublisher(), event('event-1'));
    const config = {
      consumerId: 'restart-consumer',
      eventTypes: ['station.runtime.lifecycle/v1'],
      requiredScopes: [],
    };
    const opened = first.openOperationalEventConsumer(config);
    if (opened.kind !== 'opened') throw new Error('consumer did not open');
    const initial = opened.consumer.claim();
    if (initial.kind !== 'delivery') throw new Error('delivery not claimed');
    const idempotencyKey = initial.claim.idempotencyKey;
    first.close();

    const restarted = new EventStore(path);
    const reopened = restarted.openOperationalEventConsumer(config);
    if (reopened.kind !== 'opened') throw new Error('consumer did not reopen');
    const retry = reopened.consumer.claim();
    expect(retry.kind).toBe('delivery');
    if (retry.kind !== 'delivery') throw new Error('delivery not reclaimed');
    expect(retry.claim).toMatchObject({
      attempt: 2,
      idempotencyKey,
      event: { id: 'event-1' },
    });
    expect(retry.claim.acknowledge()).toEqual({ kind: 'applied' });
    restarted.close();
  });

  it('gives duplicate handles distinct ownership and only one live claim', () => {
    const store = new EventStore(databasePath());
    append(store.createOperationalEventPublisher(), event('event-1'));
    const config = {
      consumerId: 'duplicate-handle-consumer',
      eventTypes: ['station.runtime.lifecycle/v1'],
      requiredScopes: [],
    };
    const first = store.openOperationalEventConsumer(config);
    const second = store.openOperationalEventConsumer(config);
    if (first.kind !== 'opened' || second.kind !== 'opened')
      throw new Error('consumers did not open');
    const claimed = first.consumer.claim();
    if (claimed.kind !== 'delivery') throw new Error('delivery not claimed');
    expect(second.consumer.claim()).toEqual({ kind: 'busy' });
    first.consumer.close();
    const reclaimed = second.consumer.claim();
    expect(reclaimed.kind).toBe('delivery');
    if (reclaimed.kind !== 'delivery')
      throw new Error('delivery not reclaimed');
    expect(reclaimed.claim).toMatchObject({
      attempt: 2,
      idempotencyKey: claimed.claim.idempotencyKey,
    });
    expect(reclaimed.claim.deadLetter('consumer_rejected')).toEqual({
      kind: 'applied',
    });
    expect(claimed.claim.acknowledge()).toEqual({ kind: 'stale' });
    store.close();
  });

  it('reclaims one exact delivery after its real owner process is killed', async () => {
    const path = databasePath();
    const store = new EventStore(path);
    append(store.createOperationalEventPublisher(), event('event-1'));
    const foreign = await spawnClaimingConsumer(path);
    expect(foreign.claim.attempt).toBe(1);

    const opened = store.openOperationalEventConsumer({
      consumerId: 'process-consumer',
      eventTypes: ['station.runtime.lifecycle/v1'],
      requiredScopes: [],
    });
    if (opened.kind !== 'opened') throw new Error('consumer did not open');
    expect(opened.consumer.claim()).toEqual({ kind: 'busy' });

    foreign.child.kill('SIGKILL');
    await once(foreign.child, 'exit');
    children.delete(foreign.child);
    const reclaimed = opened.consumer.claim();
    expect(reclaimed.kind).toBe('delivery');
    if (reclaimed.kind !== 'delivery')
      throw new Error('delivery not reclaimed');
    expect(reclaimed.claim).toMatchObject({
      attempt: 2,
      idempotencyKey: foreign.claim.idempotencyKey,
    });
    expect(reclaimed.claim.acknowledge()).toEqual({ kind: 'applied' });
    store.close();
  });

  it('applies bounded retry backoff and dead-letters exhausted delivery', () => {
    let now = Date.parse('2026-08-16T00:00:00.000Z');
    const runtime = directRuntime({ now: () => new Date(now).toISOString() });
    append(runtime.publisher, event('event-1'));

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = runtime.consumer.claim();
      expect(claimed.kind).toBe('delivery');
      if (claimed.kind !== 'delivery') throw new Error('delivery not claimed');
      expect(claimed.claim.attempt).toBe(attempt);
      expect(claimed.claim.retry('temporary_failure')).toEqual({
        kind: 'applied',
      });
      expect(runtime.consumer.claim().kind).toBe('waiting');
      now += 60_001;
    }
    expect(runtime.consumer.claim()).toEqual({
      kind: 'dead-lettered',
      journalSequence: 1,
    });
    expect(runtime.consumer.deadLetters()).toMatchObject({
      kind: 'available',
      entries: [
        {
          eventId: 'event-1',
          attempt: 5,
          failureCode: 'attempts_exhausted',
        },
      ],
    });
    runtime.database.close();
  });

  it('requires explicit gap acknowledgement before delivering retained events', () => {
    const runtime = directRuntime({ retention: 2 });
    append(runtime.publisher, event('event-1'));
    append(runtime.publisher, event('event-2'));
    append(runtime.publisher, event('event-3'));

    const gap = runtime.consumer.claim();
    expect(gap.kind).toBe('gap');
    if (gap.kind !== 'gap') throw new Error('gap not exposed');
    expect(gap.gap).toMatchObject({
      requestedAfterJournalSequence: 0,
      earliestAvailableJournalSequence: 2,
    });
    expect(gap.gap.acknowledge()).toEqual({ kind: 'applied' });
    const claimed = runtime.consumer.claim();
    expect(claimed.kind).toBe('delivery');
    if (claimed.kind !== 'delivery') throw new Error('delivery absent');
    expect(claimed.claim.event.id).toBe('event-2');
    runtime.database.close();
  });

  it('advances past nonmatching events without manufacturing a retention gap', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const publisher = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({
        database,
        retention: 2,
      }),
    });
    const opened = openOperationalEventConsumer({
      coordinator: createSqliteOperationalEventDeliveryCoordinator({
        database,
      }),
      config: {
        consumerId: 'project-a-consumer',
        eventTypes: ['station.runtime.lifecycle/v1'],
        requiredScopes: [{ kind: 'project', projectId: 'a' }],
      },
      owner: {
        id: 'owner-1',
        pid: process.pid,
        birth: 'birth-1',
        identityKind: 'exact',
      },
      processIdentity: {
        exact: () => ({ pid: process.pid, start: 'birth-1' }),
        probe: () => ({
          state: 'exact',
          identity: { pid: process.pid, start: 'birth-1' },
        }),
      },
    });
    if (opened.kind !== 'opened') throw new Error('consumer did not open');

    append(
      publisher,
      event('project-b-1', [{ kind: 'project', projectId: 'b' }]),
    );
    append(
      publisher,
      event('project-b-2', [{ kind: 'project', projectId: 'b' }]),
    );
    expect(opened.consumer.claim()).toEqual({ kind: 'empty' });
    append(
      publisher,
      event('project-b-3', [{ kind: 'project', projectId: 'b' }]),
    );
    append(
      publisher,
      event('project-a-1', [{ kind: 'project', projectId: 'a' }]),
    );

    const claimed = opened.consumer.claim();
    expect(claimed.kind).toBe('delivery');
    if (claimed.kind !== 'delivery') throw new Error('delivery absent');
    expect(claimed.claim.event.id).toBe('project-a-1');
    database.close();
  });

  it('does not expose an offline gap caused only by pruned nonmatching events', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const publisher = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({
        database,
        retention: 2,
      }),
    });
    const opened = openOperationalEventConsumer({
      coordinator: createSqliteOperationalEventDeliveryCoordinator({
        database,
      }),
      config: {
        consumerId: 'offline-project-a-consumer',
        eventTypes: ['station.runtime.lifecycle/v1'],
        requiredScopes: [{ kind: 'project', projectId: 'a' }],
      },
      owner: {
        id: 'owner-1',
        pid: process.pid,
        birth: 'birth-1',
        identityKind: 'exact',
      },
      processIdentity: {
        exact: () => ({ pid: process.pid, start: 'birth-1' }),
        probe: () => ({
          state: 'exact',
          identity: { pid: process.pid, start: 'birth-1' },
        }),
      },
    });
    if (opened.kind !== 'opened') throw new Error('consumer did not open');
    for (let index = 1; index <= 3; index += 1)
      append(
        publisher,
        event(`project-b-${index}`, [{ kind: 'project', projectId: 'b' }]),
      );
    expect(opened.consumer.claim()).toEqual({ kind: 'empty' });
    append(
      publisher,
      event('project-a-1', [{ kind: 'project', projectId: 'a' }]),
    );
    const claimed = opened.consumer.claim();
    expect(claimed.kind).toBe('delivery');
    if (claimed.kind !== 'delivery') throw new Error('delivery absent');
    expect(claimed.claim.event.id).toBe('project-a-1');
    database.close();
  });

  it('fails closed before pruning divergent scope authority', () => {
    const runtime = directRuntime({ retention: 2 });
    append(
      runtime.publisher,
      event('project-a-1', [{ kind: 'project', projectId: 'a' }]),
    );
    append(
      runtime.publisher,
      event('project-b-1', [{ kind: 'project', projectId: 'b' }]),
    );
    runtime.database
      .prepare(`DELETE FROM operational_event_scopes WHERE event_id = ?`)
      .run('project-a-1');
    runtime.database
      .prepare(
        `INSERT INTO operational_event_scopes (event_id, scope_key)
         VALUES (?, ?)`,
      )
      .run('project-a-1', JSON.stringify({ kind: 'project', projectId: 'b' }));

    expect(
      runtime.publisher.append(
        event('project-b-2', [{ kind: 'project', projectId: 'b' }]),
      ),
    ).toEqual({ kind: 'unavailable' });
    const retained = runtime.database
      .prepare(`SELECT event_id FROM operational_events ORDER BY sequence`)
      .all() as Array<{ event_id: string }>;
    expect(retained.map((row) => row.event_id)).toEqual([
      'project-a-1',
      'project-b-1',
    ]);
    runtime.database.close();
  });

  it.each(['type', 'scopes'] as const)(
    'fails closed before pruning an envelope missing %s',
    (field) => {
      const runtime = directRuntime({ retention: 2 });
      append(
        runtime.publisher,
        event('project-a-1', [{ kind: 'project', projectId: 'a' }]),
      );
      append(runtime.publisher, event('event-2'));
      runtime.database
        .prepare(
          `UPDATE operational_events
           SET envelope_json = json_remove(envelope_json, ?)
           WHERE event_id = ?`,
        )
        .run(`$.${field}`, 'project-a-1');
      expect(runtime.publisher.append(event('event-3'))).toEqual({
        kind: 'unavailable',
      });
      const count = runtime.database
        .prepare(`SELECT COUNT(*) AS count FROM operational_events`)
        .get() as { count: number };
      expect(count.count).toBe(2);
      runtime.database.close();
    },
  );

  it('returns exact applied truth after claim and gap commits throw', () => {
    const claimFault = vi.fn(() => {
      throw new Error('claim response lost after commit');
    });
    const claimRuntime = directRuntime({ afterClaimCommit: claimFault });
    append(claimRuntime.publisher, event('event-1'));
    const claimed = claimRuntime.consumer.claim();
    expect(claimed.kind).toBe('delivery');
    expect(claimFault).toHaveBeenCalledOnce();
    claimRuntime.database.close();

    const acknowledgeFault = vi.fn(() => {
      throw new Error('acknowledgement response lost after commit');
    });
    const acknowledgeRuntime = directRuntime({
      afterAcknowledgeCommit: acknowledgeFault,
    });
    append(acknowledgeRuntime.publisher, event('event-1'));
    const acknowledgeClaim = acknowledgeRuntime.consumer.claim();
    if (acknowledgeClaim.kind !== 'delivery')
      throw new Error('delivery not claimed');
    expect(acknowledgeClaim.claim.acknowledge()).toEqual({ kind: 'applied' });
    expect(acknowledgeFault).toHaveBeenCalledOnce();
    acknowledgeRuntime.database.close();

    const gapFault = vi.fn(() => {
      throw new Error('gap response lost after commit');
    });
    const gapRuntime = directRuntime({
      retention: 1,
      afterGapCommit: gapFault,
    });
    append(gapRuntime.publisher, event('event-1'));
    append(gapRuntime.publisher, event('event-2'));
    const gap = gapRuntime.consumer.claim();
    expect(gap.kind).toBe('gap');
    if (gap.kind !== 'gap') throw new Error('gap not exposed');
    expect(gap.gap.acknowledge()).toEqual({ kind: 'applied' });
    expect(gapFault).toHaveBeenCalledOnce();
    const retained = gapRuntime.consumer.claim();
    expect(retained.kind).toBe('delivery');
    gapRuntime.database.close();
  });

  it('latches one exact retry intent across transient unavailability', () => {
    let now = Date.parse('2026-08-16T00:00:00.000Z');
    const database = new DatabaseSync(databasePath());
    database.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const publisher = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({ database }),
    });
    const base = createSqliteOperationalEventDeliveryCoordinator({ database });
    const retryRequests: Array<
      Parameters<OperationalEventDeliveryCoordinator['retry']>[0]
    > = [];
    const coordinator: OperationalEventDeliveryCoordinator = {
      ...base,
      retry: (request) => {
        retryRequests.push(request);
        if (retryRequests.length === 1) return { kind: 'unavailable' };
        return base.retry(request);
      },
    };
    const opened = openOperationalEventConsumer({
      coordinator,
      config: {
        consumerId: 'latched-retry-consumer',
        eventTypes: ['station.runtime.lifecycle/v1'],
        requiredScopes: [],
      },
      owner: {
        id: 'owner-1',
        pid: process.pid,
        birth: 'birth-1',
        identityKind: 'exact',
      },
      now: () => new Date(now).toISOString(),
      processIdentity: {
        exact: () => ({ pid: process.pid, start: 'birth-1' }),
        probe: () => ({
          state: 'exact',
          identity: { pid: process.pid, start: 'birth-1' },
        }),
      },
    });
    if (opened.kind !== 'opened') throw new Error('consumer did not open');
    append(publisher, event('event-1'));
    const claimed = opened.consumer.claim();
    if (claimed.kind !== 'delivery') throw new Error('delivery not claimed');
    expect(claimed.claim.retry('temporary_failure')).toEqual({
      kind: 'unavailable',
    });
    now += 500;
    expect(claimed.claim.retry('temporary_failure')).toEqual({
      kind: 'applied',
    });
    expect(retryRequests).toHaveLength(2);
    expect(retryRequests[1]).toEqual(retryRequests[0]);
    expect(claimed.claim.deadLetter('different_intent')).toEqual({
      kind: 'stale',
    });
    database.close();
  });

  it('reads back exact retry and dead-letter truth after commit faults', () => {
    const retryFault = vi.fn(() => {
      throw new Error('retry response lost after commit');
    });
    const retryRuntime = directRuntime({ afterRetryCommit: retryFault });
    append(retryRuntime.publisher, event('retry-event'));
    const retryClaim = retryRuntime.consumer.claim();
    if (retryClaim.kind !== 'delivery') throw new Error('delivery not claimed');
    expect(retryClaim.claim.retry('temporary_failure')).toEqual({
      kind: 'applied',
    });
    expect(retryFault).toHaveBeenCalledOnce();
    retryRuntime.database.close();

    const deadLetterFault = vi.fn(() => {
      throw new Error('dead-letter response lost after commit');
    });
    const deadLetterRuntime = directRuntime({
      afterDeadLetterCommit: deadLetterFault,
    });
    append(deadLetterRuntime.publisher, event('dead-letter-event'));
    const deadLetterClaim = deadLetterRuntime.consumer.claim();
    if (deadLetterClaim.kind !== 'delivery')
      throw new Error('delivery not claimed');
    expect(deadLetterClaim.claim.deadLetter('consumer_rejected')).toEqual({
      kind: 'applied',
    });
    expect(deadLetterFault).toHaveBeenCalledOnce();
    deadLetterRuntime.database.close();
  });

  it('clears one orphaned settlement fence before later delivery', () => {
    const runtime = directRuntime({});
    append(runtime.publisher, event('event-1'));
    runtime.database
      .prepare(
        `INSERT INTO operational_event_delivery_receipts
          (settlement_id, consumer_id, journal_sequence, attempt, owner_id,
           owner_pid, owner_birth, owner_identity_kind, settlement_kind,
           failure_code, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'orphaned-settlement',
        'consumer-1',
        1,
        1,
        'dead-owner',
        999_999,
        'dead-birth',
        'exact',
        'acknowledged',
        null,
        '2026-08-16T00:00:00.000Z',
      );
    const claimed = runtime.consumer.claim();
    expect(claimed.kind).toBe('delivery');
    runtime.database.close();
  });

  it('cleans its own committed settlement fence on the next claim', () => {
    let shouldFailDiscard = true;
    const runtime = directRuntime({
      beforeReceiptDiscard: () => {
        if (!shouldFailDiscard) return;
        shouldFailDiscard = false;
        throw new Error('simulated transient receipt cleanup failure');
      },
    });
    append(runtime.publisher, event('event-1'));
    append(runtime.publisher, event('event-2'));

    const first = runtime.consumer.claim();
    if (first.kind !== 'delivery') throw new Error('delivery not claimed');
    expect(first.claim.acknowledge()).toEqual({ kind: 'applied' });
    expect(
      runtime.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM operational_event_delivery_receipts`,
        )
        .get(),
    ).toEqual({ count: 1 });

    const second = runtime.consumer.claim();
    expect(second.kind).toBe('delivery');
    if (second.kind !== 'delivery') throw new Error('delivery not claimed');
    expect(second.claim.event.id).toBe('event-2');
    expect(
      runtime.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM operational_event_delivery_receipts`,
        )
        .get(),
    ).toEqual({ count: 0 });
    runtime.database.close();
  });

  it('keeps known acknowledgement and gap commits applied across later progress', () => {
    const path = databasePath();
    const firstDatabase = new DatabaseSync(path);
    firstDatabase.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const secondDatabase = new DatabaseSync(path);
    secondDatabase.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const publisher = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({
        database: firstDatabase,
        retention: 1,
      }),
    });
    const processIdentity = {
      exact: () => ({ pid: process.pid, start: 'birth-1' }),
      probe: () =>
        ({
          state: 'exact',
          identity: { pid: process.pid, start: 'birth-1' },
        }) as const,
    };
    const config = {
      consumerId: 'commit-race-consumer',
      eventTypes: ['station.runtime.lifecycle/v1'],
      requiredScopes: [],
    };
    let laterConsumer: ReturnType<typeof openOperationalEventConsumer>;
    let mode: 'acknowledge' | 'gap' = 'acknowledge';
    const firstCoordinator = createSqliteOperationalEventDeliveryCoordinator({
      database: firstDatabase,
      afterAcknowledgeCommit: () => {
        if (mode !== 'acknowledge') return;
        if (laterConsumer.kind !== 'opened')
          throw new Error('later consumer unavailable');
        const later = laterConsumer.consumer.claim();
        if (later.kind !== 'delivery')
          throw new Error(`later delivery unavailable: ${later.kind}`);
        expect(later.claim.acknowledge()).toEqual({ kind: 'applied' });
        throw new Error('first acknowledgement response lost');
      },
      afterGapCommit: () => {
        if (mode !== 'gap') return;
        if (laterConsumer.kind !== 'opened')
          throw new Error('later consumer unavailable');
        const later = laterConsumer.consumer.claim();
        if (later.kind !== 'delivery')
          throw new Error(`later delivery unavailable: ${later.kind}`);
        expect(later.claim.acknowledge()).toEqual({ kind: 'applied' });
        throw new Error('gap acknowledgement response lost');
      },
    });
    const first = openOperationalEventConsumer({
      coordinator: firstCoordinator,
      config,
      owner: {
        id: 'owner-1',
        pid: process.pid,
        birth: 'birth-1',
        identityKind: 'exact',
      },
      processIdentity,
    });
    laterConsumer = openOperationalEventConsumer({
      coordinator: createSqliteOperationalEventDeliveryCoordinator({
        database: secondDatabase,
      }),
      config,
      owner: {
        id: 'owner-2',
        pid: process.pid,
        birth: 'birth-1',
        identityKind: 'exact',
      },
      processIdentity,
    });
    if (first.kind !== 'opened') throw new Error('first consumer unavailable');
    append(publisher, event('event-1'));
    append(publisher, event('event-2'));
    const gap = first.consumer.claim();
    if (gap.kind !== 'gap') throw new Error('gap unavailable');
    mode = 'gap';
    expect(gap.gap.acknowledge()).toEqual({ kind: 'applied' });

    // Reopen from a new retained floor for the acknowledgement race.
    first.consumer.close();
    laterConsumer.kind === 'opened' && laterConsumer.consumer.close();
    const ackConfig = { ...config, consumerId: 'ack-race-consumer' };
    let secondAckConsumer: ReturnType<typeof openOperationalEventConsumer>;
    const ackCoordinator = createSqliteOperationalEventDeliveryCoordinator({
      database: firstDatabase,
      afterAcknowledgeCommit: () => {
        if (secondAckConsumer.kind !== 'opened')
          throw new Error('second ack consumer unavailable');
        const later = secondAckConsumer.consumer.claim();
        if (later.kind !== 'delivery')
          throw new Error(`later ack unavailable: ${later.kind}`);
        expect(later.claim.acknowledge()).toEqual({ kind: 'applied' });
        throw new Error('ack response lost after later progress');
      },
    });
    const firstAckConsumer = openOperationalEventConsumer({
      coordinator: ackCoordinator,
      config: ackConfig,
      owner: {
        id: 'owner-3',
        pid: process.pid,
        birth: 'birth-1',
        identityKind: 'exact',
      },
      processIdentity,
    });
    secondAckConsumer = openOperationalEventConsumer({
      coordinator: createSqliteOperationalEventDeliveryCoordinator({
        database: secondDatabase,
      }),
      config: ackConfig,
      owner: {
        id: 'owner-4',
        pid: process.pid,
        birth: 'birth-1',
        identityKind: 'exact',
      },
      processIdentity,
    });
    const acknowledgementPublisher = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({
        database: firstDatabase,
        retention: 2,
      }),
    });
    append(acknowledgementPublisher, event('event-3'));
    append(acknowledgementPublisher, event('event-4'));
    if (firstAckConsumer.kind !== 'opened')
      throw new Error('ack consumer unavailable');
    const firstAck = firstAckConsumer.consumer.claim();
    if (firstAck.kind !== 'gap') throw new Error('ack setup gap unavailable');
    expect(firstAck.gap.acknowledge()).toEqual({ kind: 'applied' });
    const firstDelivery = firstAckConsumer.consumer.claim();
    if (firstDelivery.kind !== 'delivery')
      throw new Error('first ack delivery unavailable');
    expect(firstDelivery.claim.acknowledge()).toEqual({ kind: 'applied' });
    firstDatabase.close();
    secondDatabase.close();
  });

  it.each(['acknowledgement', 'gap', 'retry', 'dead-letter'] as const)(
    'retains exact %s evidence when COMMIT applies, advances, then throws',
    (settlement) => {
      const path = databasePath();
      const firstDatabase = new DatabaseSync(path);
      firstDatabase.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
      const secondDatabase = new DatabaseSync(path);
      secondDatabase.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
      let armed = false;
      let afterCommit = () => {};
      const ambiguousDatabase: OperationalEventSqliteDatabase = {
        prepare: (sql) => firstDatabase.prepare(sql),
        exec: (sql) => {
          firstDatabase.exec(sql);
          if (armed && sql.trim().toUpperCase() === 'COMMIT') {
            armed = false;
            afterCommit();
            throw new Error('COMMIT response lost after durable apply');
          }
        },
      };
      const config = {
        consumerId: `ambiguous-${settlement}`,
        eventTypes: ['station.runtime.lifecycle/v1'],
        requiredScopes: [],
      };
      const processIdentity = {
        exact: () => ({ pid: process.pid, start: 'birth-1' }),
        probe: () =>
          ({
            state: 'exact',
            identity: { pid: process.pid, start: 'birth-1' },
          }) as const,
      };
      const first = openOperationalEventConsumer({
        coordinator: createSqliteOperationalEventDeliveryCoordinator({
          database: ambiguousDatabase,
        }),
        config,
        owner: {
          id: 'owner-1',
          pid: process.pid,
          birth: 'birth-1',
          identityKind: 'exact',
        },
        processIdentity,
      });
      const second = openOperationalEventConsumer({
        coordinator: createSqliteOperationalEventDeliveryCoordinator({
          database: secondDatabase,
        }),
        config,
        owner: {
          id: 'owner-2',
          pid: process.pid,
          birth: 'birth-1',
          identityKind: 'exact',
        },
        processIdentity,
      });
      if (first.kind !== 'opened' || second.kind !== 'opened')
        throw new Error('consumers unavailable');
      const publisher = createOperationalEventOutbox({
        coordinator: createSqliteOperationalEventCoordinator({
          database: firstDatabase,
          retention: settlement === 'gap' ? 1 : 2,
        }),
      });
      append(publisher, event('event-1'));
      append(publisher, event('event-2'));
      afterCommit = () => {
        expect(second.consumer.claim()).toEqual({ kind: 'busy' });
      };
      const initial = first.consumer.claim();
      armed = true;
      if (settlement === 'gap') {
        if (initial.kind !== 'gap') throw new Error('gap unavailable');
        expect(initial.gap.acknowledge()).toEqual({ kind: 'applied' });
      } else {
        if (initial.kind !== 'delivery')
          throw new Error('delivery unavailable');
        const result =
          settlement === 'retry'
            ? initial.claim.retry('temporary_failure')
            : settlement === 'dead-letter'
              ? initial.claim.deadLetter('consumer_rejected')
              : initial.claim.acknowledge();
        expect(result).toEqual({ kind: 'applied' });
      }
      const later = second.consumer.claim();
      if (settlement === 'retry') expect(later.kind).toBe('waiting');
      else {
        if (later.kind !== 'delivery')
          throw new Error(`later delivery unavailable: ${later.kind}`);
        expect(later.claim.acknowledge()).toEqual({ kind: 'applied' });
      }
      const receipts = firstDatabase
        .prepare(
          `SELECT COUNT(*) AS count
           FROM operational_event_delivery_receipts`,
        )
        .get() as { count: number };
      expect(receipts.count).toBe(0);
      firstDatabase.close();
      secondDatabase.close();
    },
  );

  it('rejects invalid or conflicting consumer registrations', () => {
    const path = databasePath();
    const store = new EventStore(path);
    expect(
      store.openOperationalEventConsumer({
        consumerId: 'Bad ID',
        eventTypes: ['station.runtime.lifecycle/v1'],
        requiredScopes: [],
      }),
    ).toEqual({ kind: 'invalid' });
    expect(
      store.openOperationalEventConsumer({
        consumerId: 'stable-consumer',
        eventTypes: ['station.runtime.lifecycle/v1'],
        requiredScopes: [],
      }).kind,
    ).toBe('opened');
    expect(
      store.openOperationalEventConsumer({
        consumerId: 'stable-consumer',
        eventTypes: ['station.runtime.lifecycle/v1'],
        requiredScopes: [{ kind: 'project', projectId: 'different' }],
      }),
    ).toEqual({ kind: 'conflict' });
    store.close();
  });

  it('fails closed when persisted consumer filters diverge and ignores forged scope indexes', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const publisher = createOperationalEventOutbox({
      coordinator: createSqliteOperationalEventCoordinator({ database }),
    });
    const coordinator = createSqliteOperationalEventDeliveryCoordinator({
      database,
    });
    const config = {
      consumerId: 'project-a-consumer',
      eventTypes: ['station.runtime.lifecycle/v1'],
      requiredScopes: [{ kind: 'project', projectId: 'a' }] as const,
    };
    const first = openOperationalEventConsumer({ coordinator, config });
    if (first.kind !== 'opened') throw new Error('consumer did not open');
    first.consumer.close();
    database
      .prepare(
        `DELETE FROM operational_event_consumer_scopes
         WHERE consumer_id = ?`,
      )
      .run(config.consumerId);
    expect(openOperationalEventConsumer({ coordinator, config })).toEqual({
      kind: 'unavailable',
    });

    database
      .prepare(
        `INSERT INTO operational_event_consumer_scopes
          (consumer_id, scope_key) VALUES (?, ?)`,
      )
      .run(config.consumerId, JSON.stringify(config.requiredScopes[0]));
    append(
      publisher,
      event('project-b-1', [{ kind: 'project', projectId: 'b' }]),
    );
    database
      .prepare(
        `INSERT INTO operational_event_scopes (event_id, scope_key)
         VALUES (?, ?)`,
      )
      .run('project-b-1', JSON.stringify(config.requiredScopes[0]));
    const reopened = openOperationalEventConsumer({ coordinator, config });
    if (reopened.kind !== 'opened') throw new Error('consumer did not reopen');
    expect(reopened.consumer.claim()).toEqual({ kind: 'empty' });
    database.close();
  });

  it('bounds consumer admission and retained dead-letter diagnostics', () => {
    const path = databasePath();
    const store = new EventStore(path);
    for (let index = 0; index < MAX_OPERATIONAL_EVENT_CONSUMERS; index += 1)
      expect(
        store.openOperationalEventConsumer({
          consumerId: `consumer-${index}`,
          eventTypes: ['station.runtime.lifecycle/v1'],
          requiredScopes: [],
        }).kind,
      ).toBe('opened');
    expect(
      store.openOperationalEventConsumer({
        consumerId: 'consumer-over-cap',
        eventTypes: ['station.runtime.lifecycle/v1'],
        requiredScopes: [],
      }),
    ).toEqual({ kind: 'capacity' });
    store.close();

    const runtime = directRuntime({});
    for (
      let index = 0;
      index < MAX_OPERATIONAL_EVENT_DEAD_LETTERS + 3;
      index += 1
    ) {
      append(runtime.publisher, event(`dead-letter-${index}`));
      const claimed = runtime.consumer.claim();
      if (claimed.kind !== 'delivery') throw new Error('delivery not claimed');
      expect(claimed.claim.deadLetter('consumer_rejected')).toEqual({
        kind: 'applied',
      });
    }
    const deadLetters = runtime.consumer.deadLetters();
    expect(deadLetters.kind).toBe('available');
    if (deadLetters.kind !== 'available')
      throw new Error('dead letters unavailable');
    expect(deadLetters.entries).toHaveLength(
      MAX_OPERATIONAL_EVENT_DEAD_LETTERS,
    );
    expect(deadLetters.entries[0]?.eventId).toBe('dead-letter-102');
    expect(deadLetters.entries.at(-1)?.eventId).toBe('dead-letter-3');
    const count = runtime.database
      .prepare(
        `SELECT COUNT(*) AS count FROM operational_event_deliveries
         WHERE consumer_id = 'consumer-1' AND state = 'dead-letter'`,
      )
      .get() as { count: number };
    expect(count.count).toBe(MAX_OPERATIONAL_EVENT_DEAD_LETTERS);
    runtime.database.close();
  });

  it('upgrades the payload-only outbox and backfills delivery scopes', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE operational_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        delivery TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL,
        persisted_at TEXT NOT NULL
      );
    `);
    const legacyEvent = event('legacy-project-a', [
      { kind: 'project', projectId: 'a' },
    ]);
    database
      .prepare(
        `INSERT INTO operational_events
          (event_id, event_type, occurred_at, delivery, envelope_json,
           payload_bytes, persisted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyEvent.id,
        legacyEvent.type,
        legacyEvent.occurredAt,
        legacyEvent.delivery,
        JSON.stringify(legacyEvent),
        Buffer.byteLength(JSON.stringify(legacyEvent)),
        legacyEvent.occurredAt,
      );
    database.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
    const opened = openOperationalEventConsumer({
      coordinator: createSqliteOperationalEventDeliveryCoordinator({
        database,
      }),
      config: {
        consumerId: 'legacy-project-a-consumer',
        eventTypes: ['station.runtime.lifecycle/v1'],
        requiredScopes: [{ kind: 'project', projectId: 'a' }],
      },
      owner: {
        id: 'owner-1',
        pid: process.pid,
        birth: 'birth-1',
        identityKind: 'exact',
      },
      processIdentity: {
        exact: () => ({ pid: process.pid, start: 'birth-1' }),
        probe: () => ({
          state: 'exact',
          identity: { pid: process.pid, start: 'birth-1' },
        }),
      },
    });
    if (opened.kind !== 'opened')
      throw new Error('legacy consumer unavailable');
    const claimed = opened.consumer.claim();
    expect(claimed.kind).toBe('delivery');
    if (claimed.kind !== 'delivery')
      throw new Error('legacy event not claimed');
    expect(claimed.claim.event.id).toBe('legacy-project-a');
    database.close();
  });
});

import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
