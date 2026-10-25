import { createHash, randomUUID } from 'node:crypto';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import type {
  PrivateUsageCommit,
  PrivateUsageInvalidationCommit,
} from '@kontourai/station-contracts/usage-export';
import type { QueryResultRow } from 'pg';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createProductBroker } from '../app.js';
import {
  migratePrivateUsage,
  PrivateUsageRepository,
} from '../private-usage-store.js';
import type { ProductRepository } from '../store.js';

const operator = `sto_${'o'.repeat(43)}`;
const key = `stai_${'a'.repeat(43)}`;
const otherKey = `stai_${'b'.repeat(43)}`;
const sqlClient = (connection: Pick<PGliteInterface, 'query' | 'exec'>) => ({
  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) {
    if (text.includes(';')) {
      await connection.exec(text);
      return { rows: [], rowCount: 0 };
    }
    const result = await connection.query<Row>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  },
});
let receiverEpoch: string;
let db: PGlite,
  store: PrivateUsageRepository,
  app: ReturnType<typeof createProductBroker>;
const product = (privateUsage: PrivateUsageRepository): ProductRepository => ({
  privateUsage,
  hasCredential: () => false,
  authenticate: vi.fn(),
  ingest: vi.fn(),
  probe: vi.fn(),
  createSource: vi.fn(),
  revokeSource: vi.fn(),
  receipt: vi.fn(),
  trends: vi.fn(),
  incidents: vi.fn(),
  ready: vi.fn(),
});
function repository(maxObservations = 1_000_000) {
  return new PrivateUsageRepository(
    (operation) =>
      db.transaction(async (tx) => {
        await tx.exec('SET LOCAL search_path=pg_catalog');
        return operation(sqlClient(tx));
      }),
    maxObservations,
  );
}
beforeEach(async () => {
  receiverEpoch = randomUUID();
  db = new PGlite();
  await db.transaction((tx) => migratePrivateUsage(sqlClient(tx)));
  store = repository();
  app = createProductBroker(product(store), operator);
});
afterEach(async () => {
  await db.close();
});
const send = (path: string, body: unknown, token = key) =>
  app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
const read = (path: string, token = key) =>
  app.request(path, { headers: { authorization: `Bearer ${token}` } });
async function provision(token = key) {
  const response = await send(
    '/v1/operator/private-usage-vaults',
    { credentialHash: createHash('sha256').update(token).digest('hex') },
    operator,
  );
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    !('receiverEpoch' in body) ||
    typeof body.receiverEpoch !== 'string'
  )
    throw new Error('Missing storage epoch');
  receiverEpoch = body.receiverEpoch;
}
function batch(): PrivateUsageCommit {
  const time = new Date().toISOString(),
    day = time.slice(0, 10);
  return {
    protocol: 'station-private-usage-commit/v1',
    expectedReceiverEpoch: receiverEpoch,
    operationId: randomUUID(),
    expectedCheckpoint: 0,
    binding: {
      sourceStationId: 'source-a',
      sourceApprovalId: randomUUID(),
      recipientId: randomUUID(),
      scope: 'individual',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      retention: { mode: 'retained-copy', days: 7 },
    },
    query: {
      from: day,
      to: day,
      scope: 'individual',
      expectedStationId: 'source-a',
      pageSize: 2,
    },
    sourceRevision: 0,
    page: {
      schemaVersion: 1,
      stationId: 'source-a',
      streamEpoch: 'epoch-a',
      highWater: 3,
      scope: 'individual',
      window: { from: day, to: day, clock: 'station-observed-utc' },
      nextCursor: 'next_2',
      observations: [1, 2].map((index) => ({
        globalSequence: index,
        receipts: [
          {
            id: `receipt:${index}`,
            sourceEventId: `event:${index}`,
            sourceSequence: index,
            stationId: 'source-a',
            provider: 'claude',
            threadId: 'thread-a',
            observedAt: time,
            inputTokens: index,
            pricing: { status: 'unpriced' },
          },
        ],
      })),
      coverage: {
        state: 'unknown',
        reason:
          'retained-observations-do-not-prove-provider-or-deletion-coverage',
      },
    },
  };
}
test('only a provisioned private capability binds and reads its namespace; operator and product credentials cannot read it', async () => {
  const input = batch();
  expect((await send('/v1/private-usage/pages', input)).status).toBe(401);
  expect(
    (
      await send(
        '/v1/operator/private-usage-vaults',
        { credentialHash: createHash('sha256').update(key).digest('hex') },
        key,
      )
    ).status,
  ).toBe(401);
  await provision();
  input.expectedReceiverEpoch = receiverEpoch;
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  for (const token of [
    operator,
    `stp_${'p'.repeat(43)}`,
    `stax_${'x'.repeat(43)}`,
    otherKey,
  ])
    expect((await read('/v1/private-usage/observations', token)).status).toBe(
      401,
    );
  const response = await read('/v1/private-usage/observations');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    sourceAuthority: 'not-verified-by-storage',
    observations: [{ globalSequence: 1 }, { globalSequence: 2 }],
  });
  await provision(otherKey);
  const independent = batch();
  independent.binding.sourceStationId = 'source-b';
  independent.query.expectedStationId = 'source-b';
  independent.page.stationId = 'source-b';
  independent.page.streamEpoch = 'epoch-b';
  for (const observation of independent.page.observations)
    for (const receipt of observation.receipts) receipt.stationId = 'source-b';
  expect(
    (await send('/v1/private-usage/pages', independent, otherKey)).status,
  ).toBe(201);
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('4');
  const own = await read('/v1/private-usage/observations');
  expect(JSON.stringify(await own.json())).not.toContain('source-b');
});

test('page observations, checkpoint and operation receipt commit together; lost replies recover without advancing twice', async () => {
  await provision();
  const input = batch();
  await db.exec(
    'ALTER TABLE station_private_usage.checkpoints ADD CONSTRAINT fixture_failure CHECK(revision<0)',
  );
  expect((await send('/v1/private-usage/pages', input)).status).toBe(503);
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('0');
  expect(
    (
      await db.query<{ observations: string }>(
        'SELECT observations::text FROM station_private_usage.capacity',
      )
    ).rows[0].observations,
  ).toBe('0');
  expect(
    (
      await db.query<{ binding: unknown }>(
        'SELECT binding FROM station_private_usage.vaults',
      )
    ).rows[0].binding,
  ).toBeNull();
  expect(
    (await read(`/v1/private-usage/commits/${input.operationId}`)).status,
  ).toBe(404);
  await db.exec(
    'ALTER TABLE station_private_usage.checkpoints DROP CONSTRAINT fixture_failure',
  );
  const first = await send('/v1/private-usage/pages', input);
  expect(first.status).toBe(201);
  await first.body?.cancel(); // The client loses the reply after the database transaction completed.
  store = repository();
  app = createProductBroker(product(store), operator);
  const recovered = await read(
    `/v1/private-usage/commits/${input.operationId}`,
  );
  expect(recovered.status).toBe(200);
  const receipt = await recovered.json();
  const replay = await send('/v1/private-usage/pages', input);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(receipt);
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('2');
  expect(
    (
      await send('/v1/private-usage/pages', {
        ...input,
        operationId: randomUUID(),
      })
    ).status,
  ).toBe(409);
  const next: PrivateUsageCommit = {
    ...input,
    operationId: randomUUID(),
    expectedCheckpoint: 1,
    query: {
      ...input.query,
      cursor: 'next_2',
      snapshot: {
        streamEpoch: 'epoch-a',
        highWater: 3,
        afterGlobalSequence: 2,
      },
    },
    page: {
      ...input.page,
      nextCursor: undefined,
      observations: [
        {
          ...input.page.observations[1],
          globalSequence: 3,
          receipts: input.page.observations[1].receipts.map((r) => ({
            ...r,
            id: 'receipt:3',
            sourceEventId: 'event:3',
            sourceSequence: 3,
          })),
        },
      ],
    },
  };
  expect(
    (await send('/v1/private-usage/pages', { ...next, expectedCheckpoint: 0 }))
      .status,
  ).toBe(409);
  expect((await send('/v1/private-usage/pages', next)).status).toBe(201);
  const checkpoint = await read(
    `/v1/private-usage/checkpoint?from=${input.query.from}&to=${input.query.to}`,
  );
  expect(await checkpoint.json()).toMatchObject({
    checkpoint: {
      revision: 2,
      afterGlobalSequence: 3,
      completeThroughHighWater: true,
    },
  });
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('3');
});

test('changed replays, source epochs and content-bearing fields refuse without mutating retained facts', async () => {
  await provision();
  const input = batch();
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  expect(
    (await send('/v1/private-usage/pages', { ...input, sourceRevision: 1 }))
      .status,
  ).toBe(409);
  const foreign = structuredClone(input);
  foreign.operationId = randomUUID();
  foreign.expectedCheckpoint = 1;
  foreign.page.streamEpoch = 'foreign';
  expect((await send('/v1/private-usage/pages', foreign)).status).toBe(409);
  const content = JSON.parse(JSON.stringify(input));
  content.page.observations[0].receipts[0].prompt = 'must never persist';
  expect((await send('/v1/private-usage/pages', content)).status).toBe(400);
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('2');
  await db.exec(
    'ALTER TABLE station_private_usage.observations DROP CONSTRAINT observations_pkey',
  );
  expect((await read('/v1/private-usage/observations')).status).toBe(503);
});

test('private owner erasure is idempotent, physically removes facts and cannot reactivate through operator provisioning', async () => {
  await provision();
  const input = batch();
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  const remove = () =>
    app.request('/v1/private-usage/vault', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${key}` },
    });
  expect((await remove()).status).toBe(200);
  expect((await remove()).status).toBe(200);
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('0');
  expect((await send('/v1/private-usage/pages', input)).status).toBe(401);
  expect(
    (
      await send(
        '/v1/operator/private-usage-vaults',
        { credentialHash: createHash('sha256').update(key).digest('hex') },
        operator,
      )
    ).status,
  ).toBe(409);
});

test('a recreated store rejects an operation prepared for its earlier incarnation', async () => {
  await provision();
  const input = batch();
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  const oldEpoch = receiverEpoch;
  await db.exec('DROP SCHEMA station_private_usage CASCADE');
  await db.transaction((tx) => migratePrivateUsage(sqlClient(tx)));
  store = repository();
  app = createProductBroker(product(store), operator);
  await provision();
  expect(receiverEpoch).not.toBe(oldEpoch);
  expect((await send('/v1/private-usage/pages', input)).status).toBe(409);
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('0');
});

test('lost checkpoint or retained row evidence cannot become an empty successful restart', async () => {
  await provision();
  const input = batch();
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  await db.exec('DELETE FROM station_private_usage.checkpoints');
  expect(
    (
      await read(
        `/v1/private-usage/checkpoint?from=${input.query.from}&to=${input.query.to}`,
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await send('/v1/private-usage/pages', {
        ...input,
        operationId: randomUUID(),
      })
    ).status,
  ).toBe(503);
  await db.exec(
    'DELETE FROM station_private_usage.observations WHERE global_sequence=1',
  );
  expect((await read('/v1/private-usage/observations')).status).toBe(503);
});

test('retained-copy expiry filters and physically prunes old rows without renewing age on replay', async () => {
  await provision();
  const input = batch();
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  await db.exec(
    "UPDATE station_private_usage.observations SET stored_at=clock_timestamp()-interval '8 days'",
  );
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  const response = await read('/v1/private-usage/observations');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ observations: [] });
  expect(await store.prune()).toBe(2);
  expect(
    (
      await db.query<{ observations: string }>(
        'SELECT observations::text FROM station_private_usage.capacity',
      )
    ).rows[0].observations,
  ).toBe('0');
});

test('capacity rejection rolls page rows and metadata back instead of accepting a partial import', async () => {
  store = repository(1);
  app = createProductBroker(product(store), operator);
  await provision();
  const input = batch();
  expect((await send('/v1/private-usage/pages', input)).status).toBe(507);
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('0');
  expect(
    (
      await db.query<{ binding: unknown }>(
        'SELECT binding FROM station_private_usage.vaults',
      )
    ).rows[0].binding,
  ).toBeNull();
  expect(
    (await read(`/v1/private-usage/commits/${input.operationId}`)).status,
  ).toBe(404);
});

test('restating a committed observation with different content is a conflict, not a latest-clock winner', async () => {
  await provision();
  const input = batch();
  delete input.page.nextCursor;
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  const changed = structuredClone(input);
  changed.operationId = randomUUID();
  changed.expectedCheckpoint = 1;
  changed.page.observations[0].receipts[0].inputTokens = 999;
  expect((await send('/v1/private-usage/pages', changed)).status).toBe(409);
  const checkpoint = await read(
    `/v1/private-usage/checkpoint?from=${input.query.from}&to=${input.query.to}`,
  );
  expect(await checkpoint.json()).toMatchObject({
    checkpoint: { revision: 1, afterGlobalSequence: 3 },
  });
});

function invalidation(
  input: PrivateUsageCommit,
): PrivateUsageInvalidationCommit {
  return {
    protocol: 'station-private-usage-invalidations/v1',
    operationId: randomUUID(),
    expectedReceiverEpoch: receiverEpoch,
    expectedAfter: 0,
    page: {
      protocol: 'station-usage-invalidations/v1',
      stationId: input.binding.sourceStationId,
      scope: input.binding.scope,
      streamEpoch: input.page.streamEpoch,
      highWater: 3,
      retainedAfter: 0,
      nextAfter: 3,
      invalidations: [
        {
          revision: 3,
          threadId: 'thread-a',
          reason: 'thread-deleted',
          observedAt: new Date().toISOString(),
        },
      ],
      coverage: 'retained-invalidations-only',
    },
  };
}

test('invalidation withdrawal preserves newer captures and fences delayed writes from another window', async () => {
  await provision();
  const input = batch();
  input.page.observations[1].receipts = [];
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  const newer: PrivateUsageCommit = {
    ...input,
    operationId: randomUUID(),
    expectedCheckpoint: 1,
    restartSnapshot: true,
    sourceRevision: 3,
    page: {
      ...input.page,
      highWater: 4,
      nextCursor: undefined,
      observations: [
        {
          globalSequence: 4,
          receipts: input.page.observations[0].receipts.map((r) => ({
            ...r,
            id: 'receipt:new',
            sourceEventId: 'event:new',
            sourceSequence: 4,
          })),
        },
      ],
    },
  };
  expect((await send('/v1/private-usage/pages', newer)).status).toBe(201);
  const changes = invalidation(input);
  const applied = await send('/v1/private-usage/invalidations', changes);
  expect(applied.status).toBe(201);
  const receipt = await applied.json();
  expect(receipt).toMatchObject({
    receipt: { removed: 2, checkpoint: { after: 3, highWater: 3 } },
  });
  const replay = await send('/v1/private-usage/invalidations', changes);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(receipt);
  const recovered = await read(
    `/v1/private-usage/invalidation-commits/${changes.operationId}`,
  );
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual(receipt);
  const retained = await read('/v1/private-usage/observations');
  expect(await retained.json()).toMatchObject({
    observations: [{ globalSequence: 4, sourceRevision: 3 }],
  });
  const yesterday = new Date(Date.parse(input.query.from) - 86400000)
    .toISOString()
    .slice(0, 10);
  const delayed: PrivateUsageCommit = {
    ...input,
    operationId: randomUUID(),
    expectedCheckpoint: 0,
    query: { ...input.query, from: yesterday },
    page: {
      ...input.page,
      nextCursor: undefined,
      window: { ...input.page.window, from: yesterday },
    },
  };
  expect((await send('/v1/private-usage/pages', delayed)).status).toBe(409);
  const checkpoint = await read(
    `/v1/private-usage/checkpoint?from=${input.query.from}&to=${input.query.to}`,
  );
  expect(await checkpoint.json()).toMatchObject({
    journal: { after: 3, streamEpoch: 'epoch-a', highWater: 3 },
  });
});

test('withdrawal, capacity and journal receipt roll back together if checkpoint persistence fails', async () => {
  await provision();
  const input = batch();
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  const changes = invalidation(input);
  await db.exec(
    "ALTER TABLE station_private_usage.vaults ADD CONSTRAINT fixture_journal_failure CHECK((journal->>'after')::bigint<0) NOT VALID",
  );
  expect((await send('/v1/private-usage/invalidations', changes)).status).toBe(
    503,
  );
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('2');
  expect(
    (
      await db.query<{ observations: string }>(
        'SELECT observations::text FROM station_private_usage.capacity',
      )
    ).rows[0].observations,
  ).toBe('2');
  expect(
    (
      await read(
        `/v1/private-usage/invalidation-commits/${changes.operationId}`,
      )
    ).status,
  ).toBe(404);
  await db.exec(
    'ALTER TABLE station_private_usage.vaults DROP CONSTRAINT fixture_journal_failure',
  );
  expect((await send('/v1/private-usage/invalidations', changes)).status).toBe(
    201,
  );
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('0');
  expect(
    (
      await send('/v1/private-usage/invalidations', {
        ...changes,
        operationId: randomUUID(),
      })
    ).status,
  ).toBe(409);
  await db.exec('DELETE FROM station_private_usage.invalidation_commits');
  expect(
    (
      await read(
        `/v1/private-usage/checkpoint?from=${input.query.from}&to=${input.query.to}`,
      )
    ).status,
  ).toBe(503);
});

test('scope entry requests refresh, foreign snapshots and content fields never advance the journal', async () => {
  await provision();
  const input = batch();
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  const changes = invalidation(input);
  changes.page.invalidations[0].reason = 'scope-entered';
  const foreign = structuredClone(changes);
  foreign.page.stationId = 'foreign';
  expect((await send('/v1/private-usage/invalidations', foreign)).status).toBe(
    409,
  );
  const content = JSON.parse(JSON.stringify(changes));
  content.page.invalidations[0].prompt = 'not an invalidation field';
  expect((await send('/v1/private-usage/invalidations', content)).status).toBe(
    400,
  );
  const gap = structuredClone(changes);
  gap.page.retainedAfter = 1;
  expect((await send('/v1/private-usage/invalidations', gap)).status).toBe(400);
  const result = await send('/v1/private-usage/invalidations', changes);
  expect(result.status).toBe(201);
  expect(await result.json()).toMatchObject({
    receipt: { removed: 0, refreshThreads: ['thread-a'] },
  });
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('2');
});

test('version-one data upgrades without changing its receiver epoch or treating its deletion history as applied', async () => {
  await provision();
  const input = batch();
  input.sourceRevision = 7;
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  const originalEpoch = receiverEpoch;
  await db.exec(`DROP TABLE station_private_usage.receipt_summaries; DELETE FROM station_private_usage.migrations WHERE version=4; DROP TABLE station_private_usage.current_receipts; DROP TABLE station_private_usage.receipt_indexes; ALTER TABLE station_private_usage.vaults DROP COLUMN data_revision; DELETE FROM station_private_usage.migrations WHERE version=3; DROP TABLE station_private_usage.invalidation_commits;
    ALTER TABLE station_private_usage.vaults DROP COLUMN journal;
    ALTER TABLE station_private_usage.vaults DROP COLUMN invalidation_baseline;
    DELETE FROM station_private_usage.migrations WHERE version=2;`);
  await db.transaction((tx) => migratePrivateUsage(sqlClient(tx)));
  await db.transaction((tx) => migratePrivateUsage(sqlClient(tx)));
  const state = await read(
    `/v1/private-usage/checkpoint?from=${input.query.from}&to=${input.query.to}`,
  );
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({
    receiverEpoch: originalEpoch,
    checkpoint: { revision: 1, sourceRevision: 7 },
    journal: { after: 0, highWater: 0 },
  });
  expect(
    (
      await db.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.observations',
      )
    ).rows[0].total,
  ).toBe('2');
});

test('current receipt index reconciles sparse cumulative facts, pins its checkpoint and refuses missing derived evidence', async () => {
  await provision();
  const input = batch();
  delete input.page.nextCursor;
  input.page.highWater = 2;
  input.page.observations[0].receipts[0] = {
    ...input.page.observations[0].receipts[0],
    id: 'cumulative',
    provider: 'codex',
    inputTokens: 20,
    outputTokens: 2,
  };
  input.page.observations[1].receipts[0] = {
    ...input.page.observations[1].receipts[0],
    id: 'cumulative',
    provider: 'codex',
    inputTokens: undefined,
    outputTokens: 4,
  };
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  const query = {
    protocol: 'station-private-usage-receipt-query/v1',
    expectedReceiverEpoch: receiverEpoch,
    expectedCheckpoint: 1,
    expectedSourceRevision: 0,
    expectedHighWater: 2,
    from: input.query.from,
    to: input.query.to,
  };
  const result = await send('/v1/private-usage/receipts/query', query);
  expect(result.status, await result.clone().text()).toBe(200);
  const body = await result.json();
  expect(body).toMatchObject({
    phase: 'ready',
    receipts: [
      {
        id: 'cumulative',
        inputTokens: 20,
        outputTokens: 4,
        pricing: { status: 'unpriced' },
      },
    ],
  });
  expect(
    (
      await send('/v1/private-usage/receipts/query', {
        ...query,
        expectedHighWater: 3,
      })
    ).status,
  ).toBe(409);
  expect(
    (await send('/v1/private-usage/receipts/query', query, operator)).status,
  ).toBe(401);
  await db.exec('DELETE FROM station_private_usage.current_receipts');
  expect((await send('/v1/private-usage/receipts/query', query)).status).toBe(
    503,
  );
});

test('retention expiry invalidates a cached current receipt view and maintenance removes its derived copies', async () => {
  await provision();
  const input = batch();
  delete input.page.nextCursor;
  input.page.highWater = 2;
  expect((await send('/v1/private-usage/pages', input)).status).toBe(201);
  const query = {
    protocol: 'station-private-usage-receipt-query/v1',
    expectedReceiverEpoch: receiverEpoch,
    expectedCheckpoint: 1,
    expectedSourceRevision: 0,
    expectedHighWater: 2,
    from: input.query.from,
    to: input.query.to,
  };
  const first = await send('/v1/private-usage/receipts/query', query);
  expect(first.status).toBe(200);
  const page = await first.json();
  expect(page.receipts).toHaveLength(2);
  await db.exec(
    "UPDATE station_private_usage.observations SET stored_at=clock_timestamp()-interval '8 days'; UPDATE station_private_usage.receipt_indexes SET expires_at=clock_timestamp()-interval '1 second'",
  );
  expect(
    (
      await send('/v1/private-usage/receipts/query', {
        ...query,
        indexId: page.indexId,
      })
    ).status,
  ).toBe(409);
  const expired = await send('/v1/private-usage/receipts/query', query);
  expect(expired.status).toBe(200);
  expect(await expired.json()).toMatchObject({ phase: 'ready', receipts: [] });
  expect(await store.prune()).toBe(2);
  expect(
    (
      await db.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM station_private_usage.current_receipts',
      )
    ).rows[0].count,
  ).toBe('0');
  expect(
    (
      await db.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM station_private_usage.receipt_indexes',
      )
    ).rows[0].count,
  ).toBe('0');
});

test('resumable indexed totals include over 1000 observations, retain money provenance and do not change with drilldown paging', async () => {
  await provision();
  const first = batch();
  const time = first.page.observations[0].receipts[0].observedAt!;
  let revision = 0,
    after = 0,
    cursor: string | undefined;
  for (let offset = 0; offset < 1001; offset += 100) {
    const end = Math.min(offset + 100, 1001);
    const input: PrivateUsageCommit = {
      ...first,
      operationId: randomUUID(),
      expectedCheckpoint: revision,
      query: {
        ...first.query,
        pageSize: 100,
        ...(cursor
          ? {
              cursor,
              snapshot: {
                streamEpoch: first.page.streamEpoch,
                highWater: 1001,
                afterGlobalSequence: after,
              },
            }
          : {}),
      },
      page: {
        ...first.page,
        highWater: 1001,
        nextCursor: end < 1001 ? `page_${end}` : undefined,
        observations: Array.from({ length: end - offset }, (_, j) => {
          const i = offset + j + 1;
          const snapshot = i % 2 ? 'price-one' : 'price-two';
          const common = {
            stationId: 'source-a',
            provider: 'bedrock',
            threadId: 'thread-a',
            observedAt: time,
            sourceSequence: i,
            sourceEventId: `event:${i}`,
            model: i % 2 ? 'one' : 'two',
          };
          return {
            globalSequence: i,
            receipts: [
              {
                ...common,
                id: `tokens:${i}`,
                inputTokens: 1,
                pricing: {
                  status: 'priced' as const,
                  pricingSnapshotId: snapshot,
                  pricingSnapshotCapturedAt: time,
                  pricingSnapshotSource: 'fixture-catalog',
                  provider: 'bedrock',
                  model: common.model,
                  currency: 'USD',
                },
                estimatedCost: {
                  amount: 0.1,
                  currency: 'USD',
                  pricingSnapshotId: snapshot,
                  pricingSnapshotObservedAt: time,
                  pricingSnapshotSource: 'fixture-catalog',
                },
              },
              {
                ...common,
                id: `cost:${i}`,
                pricing: { status: 'unpriced' as const },
                reportedCost: { amount: 1, currency: i % 2 ? 'USD' : 'EUR' },
              },
            ],
          };
        }),
      },
    };
    const receipt = await store.commit(key, input);
    revision = receipt.checkpoint.revision;
    after = receipt.checkpoint.afterGlobalSequence;
    cursor = receipt.checkpoint.nextCursor;
  }
  const query = {
    protocol: 'station-private-usage-receipt-query/v1',
    expectedReceiverEpoch: receiverEpoch,
    expectedCheckpoint: revision,
    expectedSourceRevision: 0,
    expectedHighWater: 1001,
    from: first.query.from,
    to: first.query.to,
  };
  let indexId: string | undefined;
  for (let i = 0; i < 11; i++) {
    const page = await store.queryReceipts(key, {
      ...query,
      ...(indexId ? { indexId } : {}),
    });
    indexId = page.indexId;
  }
  await db.exec(
    'ALTER TABLE station_private_usage.receipt_summaries ADD CONSTRAINT fixture_summary_atomic CHECK(false)',
  );
  expect(
    (
      await send('/v1/private-usage/receipts/query', {
        ...query,
        indexId,
        mode: 'summary',
        groupBy: 'provider',
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await db.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM station_private_usage.receipt_summaries',
      )
    ).rows[0].count,
  ).toBe('0');
  await db.exec(
    'ALTER TABLE station_private_usage.receipt_summaries DROP CONSTRAINT fixture_summary_atomic',
  );
  const actionMs: number[] = [];
  const measured = async (input: unknown) => {
    const start = performance.now();
    const page = await store.queryReceipts(key, input);
    actionMs.push(performance.now() - start);
    return page;
  };
  const initial = await measured({
    ...query,
    indexId,
    mode: 'summary',
    groupBy: 'provider',
  });
  expect(initial.summary).toMatchObject({ phase: 'aggregating', rows: [] });
  expect(initial.summary!.scanned).toBeGreaterThan(0);
  expect(initial.summary!.scanned).toBeLessThanOrEqual(1000);
  expect(initial.receipts).toEqual([]);
  const summaryId = initial.summary!.id;
  let completed = initial;
  for (
    let step = 0;
    step < 20 && completed.summary!.phase !== 'ready';
    step++
  ) {
    const before = completed.summary!.scanned;
    const next = await measured({
      ...query,
      indexId,
      mode: 'summary',
      groupBy: 'provider',
      summaryId,
    });
    expect(next.summary!.scanned - before).toBeGreaterThan(0);
    expect(next.summary!.scanned - before).toBeLessThanOrEqual(1000);
    if (next.summary!.phase !== 'ready') expect(next.summary!.rows).toEqual([]);
    completed = next;
  }
  expect(completed.summary).toMatchObject({
    phase: 'ready',
    scanned: 2002,
    rows: [
      {
        key: 'provider:bedrock',
        inputTokens: 1001,
        receiptCount: 2002,
        pricingStatus: 'priced',
      },
    ],
  });
  const row = completed.summary!.rows[0];
  expect(row.reportedCost).toBeUndefined();
  expect(row.estimatedCost).toBeUndefined();
  expect(row.reportedCostBuckets).toEqual(
    expect.arrayContaining([
      { amount: 501, currency: 'USD' },
      { amount: 500, currency: 'EUR' },
    ]),
  );
  expect(row.estimatedCostBuckets).toHaveLength(2);
  expect(
    row.estimatedCostBuckets!.find((b) => b.pricingSnapshotId === 'price-one')!
      .amount,
  ).toBeCloseTo(50.1);
  expect(
    row.estimatedCostBuckets!.find((b) => b.pricingSnapshotId === 'price-two')!
      .amount,
  ).toBeCloseTo(50);
  const drill = await store.queryReceipts(key, { ...query, indexId });
  expect(drill.receipts).toHaveLength(100);
  await store.queryReceipts(key, { ...query, indexId, after: drill.nextAfter });
  const repeated = await store.queryReceipts(key, {
    ...query,
    indexId,
    mode: 'summary',
    groupBy: 'provider',
    summaryId,
  });
  expect(repeated.summary).toEqual(completed.summary);
  expect(
    (
      await send('/v1/private-usage/receipts/query', {
        ...query,
        indexId,
        mode: 'summary',
        groupBy: 'model',
        summaryId,
      })
    ).status,
  ).toBe(409);
  for (const filter of [
    { provider: 'claude' },
    { model: 'one' },
    { provider: 'bedrock', accountKey: 'other' },
  ]) {
    expect(
      (
        await send('/v1/private-usage/receipts/query', {
          ...query,
          indexId,
          mode: 'summary',
          groupBy: 'provider',
          summaryId,
          ...filter,
        })
      ).status,
    ).toBe(409);
  }
  const filtered = await store.queryReceipts(key, {
    ...query,
    indexId,
    mode: 'summary',
    groupBy: 'provider',
    provider: 'bedrock',
    model: 'one',
  });
  expect(filtered.summary).toMatchObject({ phase: 'aggregating', rows: [] });
  let filteredReady = filtered;
  for (
    let step = 0;
    step < 20 && filteredReady.summary!.phase !== 'ready';
    step++
  )
    filteredReady = await store.queryReceipts(key, {
      ...query,
      indexId,
      mode: 'summary',
      groupBy: 'provider',
      provider: 'bedrock',
      model: 'one',
      summaryId: filtered.summary!.id,
    });
  expect(filteredReady.summary).toMatchObject({
    phase: 'ready',
    scanned: 1002,
    rows: [
      {
        inputTokens: 501,
        reportedCost: { amount: 501, currency: 'USD' },
        receiptCount: 1002,
      },
    ],
  });
  for (const ms of actionMs)
    expect(
      ms,
      JSON.stringify({ backend: 'PGlite', aggregationActionMs: actionMs }),
    ).toBeLessThan(5000);
  console.info(
    'telemetry-summary-profile',
    JSON.stringify({
      backend: 'PGlite',
      observations: 1001,
      normalizedReceipts: 2002,
      aggregationActionMs: actionMs,
    }),
  );
});

test('comparison windows keep independent derived indexes and refuse a cursor from the other window', async () => {
  await provision();
  const first = batch();
  delete first.page.nextCursor;
  first.page.highWater = 2;
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const oldDay = yesterday.slice(0, 10);
  first.query = { ...first.query, from: oldDay, to: oldDay };
  first.page.window = { ...first.page.window, from: oldDay, to: oldDay };
  first.page.observations = [
    {
      globalSequence: 1,
      receipts: [
        { ...first.page.observations[0].receipts[0], observedAt: yesterday },
      ],
    },
  ];
  await store.commit(key, first);
  const second = batch();
  second.binding = first.binding;
  delete second.page.nextCursor;
  second.page.highWater = 2;
  second.page.observations = [second.page.observations[1]];
  await store.commit(key, second);
  const query = {
    protocol: 'station-private-usage-receipt-query/v1',
    expectedReceiverEpoch: receiverEpoch,
    expectedCheckpoint: 1,
    expectedSourceRevision: 0,
    expectedHighWater: 2,
  };
  const a = await store.queryReceipts(key, {
    ...query,
    from: oldDay,
    to: oldDay,
  });
  const b = await store.queryReceipts(key, {
    ...query,
    from: second.query.from,
    to: second.query.to,
  });
  expect(a.indexId).not.toBe(b.indexId);
  expect(a.receipts[0].inputTokens).toBe(1);
  expect(b.receipts[0].inputTokens).toBe(2);
  const again = await store.queryReceipts(key, {
    ...query,
    from: oldDay,
    to: oldDay,
    indexId: a.indexId,
  });
  expect(again.receipts).toEqual(a.receipts);
  expect(
    (
      await send('/v1/private-usage/receipts/query', {
        ...query,
        from: second.query.from,
        to: second.query.to,
        indexId: a.indexId,
      })
    ).status,
  ).toBe(409);
});
