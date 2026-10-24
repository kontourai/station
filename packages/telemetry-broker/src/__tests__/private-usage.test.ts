import { createHash, randomUUID } from 'node:crypto';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import type { PrivateUsageCommit } from '@kontourai/station-contracts/usage-export';
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
