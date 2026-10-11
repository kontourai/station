import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { Pool } from 'pg';
import {
  createProductBroker,
  PgProductRepository,
} from '../packages/telemetry-broker/dist/index.mjs';

// Requires a separate PostgreSQL administrative connection with CREATEDB.
// Every destructive probe runs in a uniquely named, runner-owned database.
const connectionString =
  process.env.STATION_TELEMETRY_QUALIFICATION_DATABASE_URL;
if (!connectionString)
  throw new Error('A qualification PostgreSQL connection is required');
const database = `station_telemetry_qa_${randomUUID().replaceAll('-', '')}`;
const config = {
  connectionString,
  max: 4,
  connectionTimeoutMillis: 1500,
  statement_timeout: 3000,
  query_timeout: 3500,
  idle_in_transaction_session_timeout: 5000,
};
const admin = new Pool(config);
const url = new URL(connectionString);
url.pathname = `/${database}`;
let pool;
let server;
let created = false;
let passed = false;
let report;
const checks = [];
const artifactSha256 = createHash('sha256')
  .update(
    readFileSync(
      new URL('../packages/telemetry-broker/dist/index.mjs', import.meta.url),
    ),
  )
  .digest('hex');
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  pool = new Pool({ ...config, connectionString: url.href });
  const store = new PgProductRepository(pool);
  await store.migrate();
  await store.ready();
  const postgresVersion = (await pool.query('SHOW server_version')).rows[0]
    .server_version;
  const operatorKey = `sto_${randomBytes(32).toString('base64url')}`;
  const sourceKey = `stp_${randomBytes(32).toString('base64url')}`;
  const otherKey = `stp_${randomBytes(32).toString('base64url')}`;
  const sourceId = randomUUID();
  const otherId = randomUUID();
  for (const [id, key] of [
    [sourceId, sourceKey],
    [otherId, otherKey],
  ])
    await store.createSource(
      id,
      'qualification',
      createHash('sha256').update(key).digest('hex'),
    );
  const app = createProductBroker(store, operatorKey);
  server = createServer(getRequestListener(app.fetch));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const from = new Date(Date.now() - 86400000).toISOString();
  const to = new Date(Date.now() + 86400000).toISOString();
  const inventory = await (await fetch(`${base}/health/live`)).json();
  const time = new Date().toISOString();
  const batch = {
    schema_version: 1,
    inventory_revision: inventory.inventoryRevision,
    distinct_id: 'a'.repeat(64),
    events: [
      {
        event_id: randomUUID(),
        event: 'engine_turn',
        occurred_at: time,
        observed_at: time,
        build: { version: '9.8.7', platform: 'linux', arch: 'x64' },
        properties: { engine: 'codex', outcome: 'completed' },
      },
    ],
  };
  const send = async (body) => {
    const response = await fetch(`${base}/v1/product/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': sourceKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    return { status: response.status, body: await response.json() };
  };
  const first = await send(batch);
  assert.equal(first.status, 202);
  assert.equal(first.body.receipt.inserted, 1);
  const retry = await send(batch);
  assert.equal(retry.status, 202);
  assert.equal(retry.body.receipt.inserted, 0);
  assert.equal(retry.body.receipt.alreadyPresent, 1);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer AS n FROM station_telemetry.events',
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    await store.receipt(otherKey, first.body.receipt.receiptId),
    null,
  );
  const changed = structuredClone(batch);
  changed.events[0].properties.outcome = 'failed';
  assert.equal((await send(changed)).status, 409);
  assert.equal((await store.trends(from, to)).deliveryCoverage, 'unknown');
  checks.push(
    'HTTP commit, replay dedupe, conflicting identity and source-scoped receipt',
  );

  const probes = [
    [
      'unlogged event storage',
      'ALTER TABLE station_telemetry.events SET UNLOGGED',
      'ALTER TABLE station_telemetry.events SET LOGGED',
    ],
    [
      'unlogged commit receipts',
      'ALTER TABLE station_telemetry.commits SET UNLOGGED',
      'ALTER TABLE station_telemetry.commits SET LOGGED',
    ],
    [
      'unlogged migration marker',
      'ALTER TABLE station_telemetry.migrations SET UNLOGGED',
      'ALTER TABLE station_telemetry.migrations SET LOGGED',
    ],
    [
      'missing sources table',
      'ALTER TABLE station_telemetry.sources RENAME TO hidden_sources',
      'ALTER TABLE station_telemetry.hidden_sources RENAME TO sources',
    ],
    [
      'missing commits table',
      'ALTER TABLE station_telemetry.commits RENAME TO hidden_commits',
      'ALTER TABLE station_telemetry.hidden_commits RENAME TO commits',
    ],
    [
      'missing dedupe key',
      'ALTER TABLE station_telemetry.events DROP CONSTRAINT events_pkey',
      'ALTER TABLE station_telemetry.events ADD PRIMARY KEY(source_id,event_id)',
    ],
    [
      'missing credential uniqueness',
      'ALTER TABLE station_telemetry.sources DROP CONSTRAINT sources_credential_hash_key',
      'ALTER TABLE station_telemetry.sources ADD UNIQUE(credential_hash)',
    ],
    [
      'nullable observation',
      'ALTER TABLE station_telemetry.events ALTER COLUMN observation DROP NOT NULL',
      'ALTER TABLE station_telemetry.events ALTER COLUMN observation SET NOT NULL',
    ],
    [
      'missing event index',
      'DROP INDEX station_telemetry.event_time',
      'CREATE INDEX event_time ON station_telemetry.events(occurred_at)',
    ],
    [
      'incompatible migration',
      "INSERT INTO station_telemetry.migrations VALUES(2,'qualification-unsupported')",
      'DELETE FROM station_telemetry.migrations WHERE version=2',
    ],
  ];
  for (const [name, inject, restore] of probes) {
    await pool.query(inject);
    try {
      const incompatible = (error) =>
        error.code === 'schema_incompatible' ||
        (name.startsWith('missing ') &&
          name.endsWith(' table') &&
          error.code === '42P01');
      await assert.rejects(store.ready(), incompatible);
      await assert.rejects(store.migrate(), incompatible);
      await assert.rejects(store.trends(from, to), incompatible);
      await assert.rejects(store.retain(), incompatible);
      await assert.rejects(store.ingest(sourceKey, batch), incompatible);
      await assert.rejects(
        store.receipt(sourceKey, first.body.receipt.receiptId),
        incompatible,
      );
      await assert.rejects(
        store.createSource(
          randomUUID(),
          'denied',
          createHash('sha256').update(randomBytes(32)).digest('hex'),
        ),
        incompatible,
      );
      await assert.rejects(store.revokeSource(sourceId), incompatible);
    } finally {
      await pool.query(restore);
    }
    await store.ready();
    assert.equal(
      (await store.trends(from, to)).rows.reduce((n, row) => n + row.count, 0),
      1,
    );
    checks.push(
      `${name}: all eight repository entrypoints refused; restored readiness/data`,
    );
  }
  assert.equal(await store.revokeSource(sourceId), true);
  assert.equal((await send(batch)).status, 401);
  checks.push('committed source revocation fences ingestion');

  const bounded = new PgProductRepository(pool, 0);
  await assert.rejects(
    bounded.ingest(otherKey, {
      ...batch,
      events: [{ ...batch.events[0], event_id: randomUUID() }],
    }),
    /storage_limit/,
  );
  checks.push('storage saturation does not acknowledge admission');
  let stalled = false;
  const sockets = new Set();
  const transport = createTcpServer((downstream) => {
    const upstream = connect(Number(url.port || 5432), url.hostname);
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.on('data', (bytes) => upstream.write(bytes));
    upstream.on('data', (bytes) => {
      if (!stalled) downstream.write(bytes);
    });
    for (const [socket, peer] of [
      [downstream, upstream],
      [upstream, downstream],
    ]) {
      socket.on('error', () => peer.destroy());
      socket.on('close', () => {
        sockets.delete(socket);
        peer.destroy();
      });
    }
  });
  await new Promise((resolve) => transport.listen(0, '127.0.0.1', resolve));
  const transportedUrl = new URL(url);
  transportedUrl.hostname = '127.0.0.1';
  transportedUrl.port = String(transport.address().port);
  const transportedPool = new Pool({
    ...config,
    connectionString: transportedUrl.href,
    query_timeout: 0,
  });
  try {
    const transportedStore = new PgProductRepository(transportedPool);
    await transportedStore.ready();
    stalled = true;
    const started = performance.now();
    await assert.rejects(
      transportedStore.ready(),
      (error) => error.code === 'storage_timeout',
    );
    const elapsedMs = performance.now() - started;
    assert(
      elapsedMs < 6000,
      `Transport refusal exceeded its bound: ${elapsedMs}`,
    );
    stalled = false;
    await transportedStore.ready();
    checks.push(
      `stalled PostgreSQL transport refused in ${Math.round(elapsedMs)}ms; discarded connection and recovered`,
    );
  } finally {
    stalled = false;
    await transportedPool.end();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => transport.close(resolve));
  }
  passed = true;
  report = {
    state: 'PASS',
    artifactSha256,
    postgresVersion,
    database,
    checks,
    scope:
      'receiver HTTP and live PostgreSQL; not Station execution, persistent deployment, restore or native qualification',
  };
} finally {
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (created && passed) await admin.query(`DROP DATABASE "${database}"`);
    if (created && !passed)
      console.error(
        `Qualification failed; owned database retained for diagnosis: ${database}`,
      );
  } finally {
    await admin.end();
  }
}
console.log(JSON.stringify(report, null, 2));
