import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { Pool } from 'pg';
import { execFileSyncBounded } from '../../scripts/lib/bounded-capture.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../scripts/lib/owned-process.mjs';
import { readReceiverArtifactManifest } from './artifact-manifest.mjs';

async function qualifyArtifactManifest(manifest, outdir, repoRoot) {
  const fixture = await mkdtemp(join(tmpdir(), 'station-telemetry-artifact-'));
  const manifestFile = join(fixture, 'artifact-manifest.json');
  try {
    for (const artifact of manifest.artifacts)
      await writeFile(
        join(fixture, artifact.path),
        await readFile(join(outdir, artifact.path)),
      );
    const baseline = `${JSON.stringify(manifest)}\n`;
    await writeFile(manifestFile, baseline);
    await readReceiverArtifactManifest(fixture, repoRoot);
    for (const [label, mutate, expected] of [
      [
        'stale source',
        (m) => {
          m.provenance.head = '0'.repeat(40);
        },
        /source revision is stale/,
      ],
      [
        'changed source input',
        (m) => {
          m.inputs[0].sha256 = '0'.repeat(64);
        },
        /build inputs differ/,
      ],
      [
        'missing dependency input record',
        (m) => {
          const index = m.inputs.findIndex((input) =>
            input.path.startsWith('node_modules/'),
          );
          assert(
            index >= 0,
            'bundled dependency input required for inventory control',
          );
          m.inputs.splice(index, 1);
        },
        /input inventory differs/,
      ],
      [
        'missing required input record',
        (m) => {
          m.inputs = m.inputs.filter(
            (input) => input.path !== 'packages/telemetry-broker/src/main.ts',
          );
          m.inputInventory.count = m.inputs.length;
          m.inputInventory.sha256 = createHash('sha256')
            .update(JSON.stringify(m.inputs))
            .digest('hex');
        },
        /Invalid receiver build input inventory/,
      ],
      [
        'missing artifact record',
        (m) => {
          m.artifacts.pop();
        },
        /Invalid receiver artifact manifest/,
      ],
    ]) {
      const changed = JSON.parse(baseline);
      mutate(changed);
      await writeFile(manifestFile, JSON.stringify(changed));
      await assert.rejects(
        readReceiverArtifactManifest(fixture, repoRoot),
        expected,
        label,
      );
      await writeFile(manifestFile, baseline);
      await readReceiverArtifactManifest(fixture, repoRoot);
    }
    const mainFile = join(fixture, 'main.mjs');
    const original = await readFile(mainFile);
    try {
      await writeFile(
        mainFile,
        Buffer.concat([original, Buffer.from('\n// changed fixture bytes\n')]),
      );
      await assert.rejects(
        readReceiverArtifactManifest(fixture, repoRoot),
        /bundle differs/,
        'changed bundle',
      );
    } finally {
      await writeFile(mainFile, original);
    }
    await readReceiverArtifactManifest(fixture, repoRoot);
    await rm(mainFile);
    try {
      execFileSyncBounded('mkfifo', [mainFile], {
        windowsHide: true,
        timeout: 3000,
      });
      let timer;
      try {
        await assert.rejects(
          Promise.race([
            readReceiverArtifactManifest(fixture, repoRoot),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error('FIFO bundle refusal exceeded its deadline'),
                  ),
                3000,
              );
            }),
          ]),
          /must be regular/,
          'nonblocking FIFO bundle refusal',
        );
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await rm(mainFile);
      await writeFile(mainFile, original);
    }
    await readReceiverArtifactManifest(fixture, repoRoot);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function assertEntrypointRefusal(execution, label) {
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label}: no bounded startup refusal`)),
        6000,
      );
    });
    const result = await Promise.race([execution.completion, deadline]);
    assert.equal(result.error, undefined, label);
    assert.equal(result.status, 1, label);
  } finally {
    clearTimeout(timer);
  }
}

async function assertEntrypointProbe(
  execution,
  port,
  sourceKey,
  sourceId,
  label,
) {
  const base = `http://127.0.0.1:${port}`;
  const deadline = performance.now() + 6000;
  let inventory;
  while (true) {
    try {
      const response = await fetch(`${base}/health/live`, {
        signal: AbortSignal.timeout(500),
      });
      assert.equal(response.status, 200, label);
      inventory = await response.json();
      break;
    } catch (error) {
      if (
        error.cause?.code !== 'ECONNREFUSED' ||
        !execution.isAlive() ||
        performance.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const response = await fetch(`${base}/v1/product/probes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': sourceKey },
    body: JSON.stringify({
      protocol: 'station-product-probe/v1',
      inventoryRevision: inventory.inventoryRevision,
    }),
    signal: AbortSignal.timeout(6000),
  });
  assert.equal(response.status, 200, label);
  assert.equal((await response.json()).probe.sourceId, sourceId, label);
}

async function exerciseEntrypoint({
  label,
  credential,
  expected,
  operatorFile,
  databaseFile,
  sourceKey,
  sourceId,
  entrypoint,
  activeEntrypoints,
}) {
  const reservation = createTcpServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const execution = executeOwnedProcess(
    process.execPath,
    [entrypoint],
    undefined,
    'telemetry receiver entrypoint',
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        STATION_TELEMETRY_BROKER_DATABASE_URL_FILE: databaseFile,
        STATION_TELEMETRY_BROKER_OPERATOR_KEY_FILE: operatorFile,
        STATION_TELEMETRY_BROKER_HOST: '127.0.0.1',
        STATION_TELEMETRY_BROKER_PORT: String(port),
        ...credential,
      },
    },
  );
  activeEntrypoints.add(execution);
  const output = captureOwnedProcessOutput(execution, { maxBytes: 65536 });
  try {
    if (expected) await assertEntrypointRefusal(execution, label);
    else
      await assertEntrypointProbe(execution, port, sourceKey, sourceId, label);
  } finally {
    const cleanup = await terminateSuiteExecution(execution, {
      terminationGraceMs: 7000,
      terminationForceMs: 1000,
      waitForSuiteSettlement,
    });
    if (cleanup.settled) activeEntrypoints.delete(execution);
    assert(
      cleanup.settled && !cleanup.escalated && cleanup.errors.length === 0,
      `${label}: owned process cleanup failed`,
    );
  }
  const result = await execution.completion;
  assert.equal(result.status, expected ? 1 : 0, label);
  const captured = output.finish();
  assert(
    !captured.truncated && !captured.invalidUtf8,
    `${label}: incomplete process evidence`,
  );
  if (expected) assert.match(captured.stderr.text, expected, label);
  return captured;
}

async function qualifyEntrypoint(
  databaseUrl,
  operatorKey,
  sourceKey,
  sourceId,
  entrypoint,
  activeEntrypoints,
) {
  const root = await mkdtemp(join(tmpdir(), 'station-telemetry-entrypoint-'));
  const operatorFile = join(root, 'operator-key');
  const databaseFile = join(root, 'database-url');
  const publicFile = join(root, 'public-url');
  const oversizedFile = join(root, 'oversized-url');
  const malformedFile = join(root, 'malformed-url');
  const symlinkFile = join(root, 'linked-url');
  const privateSentinel = 'private-url-value-not-for-diagnostics';
  try {
    await writeFile(operatorFile, operatorKey, { mode: 0o400 });
    await writeFile(databaseFile, databaseUrl, { mode: 0o400 });
    await writeFile(publicFile, databaseUrl, { mode: 0o644 });
    await chmod(publicFile, 0o644);
    assert.equal((await stat(publicFile)).mode & 0o077, 0o044);
    await writeFile(oversizedFile, 'x'.repeat(4097), { mode: 0o400 });
    await writeFile(malformedFile, privateSentinel, { mode: 0o400 });
    await symlink(databaseFile, symlinkFile);
    for (const [label, credential, expected] of [
      [
        'both database sources',
        { STATION_TELEMETRY_BROKER_DATABASE_URL: databaseUrl },
        /Select one database credential source/,
      ],
      [
        'public database file',
        { STATION_TELEMETRY_BROKER_DATABASE_URL_FILE: publicFile },
        /Credential must be a private, owned regular file/,
      ],
      [
        'oversized database file',
        { STATION_TELEMETRY_BROKER_DATABASE_URL_FILE: oversizedFile },
        /Credential must be a private, owned regular file/,
      ],
      [
        'symlink database file',
        { STATION_TELEMETRY_BROKER_DATABASE_URL_FILE: symlinkFile },
        /ELOOP/,
      ],
      [
        'malformed database URL',
        { STATION_TELEMETRY_BROKER_DATABASE_URL_FILE: malformedFile },
        /A valid PostgreSQL connection URL file is required/,
      ],
      ['private database file', {}, null],
      [
        'legacy database environment',
        {
          STATION_TELEMETRY_BROKER_DATABASE_URL: databaseUrl,
          STATION_TELEMETRY_BROKER_DATABASE_URL_FILE: undefined,
        },
        null,
      ],
    ]) {
      const captured = await exerciseEntrypoint({
        label,
        credential,
        expected,
        operatorFile,
        databaseFile,
        sourceKey,
        sourceId,
        entrypoint,
        activeEntrypoints,
      });
      assert(
        !captured.stderr.text.includes(privateSentinel) &&
          !captured.stdout.text.includes(privateSentinel),
        `${label}: private input leaked`,
      );
    }
  } finally {
    if (activeEntrypoints.size === 0)
      await rm(root, { recursive: true, force: true });
    else
      console.error(
        `Unsettled entrypoint; private credential fixture retained: ${root}`,
      );
  }
}

// Requires a separate PostgreSQL administrative connection with CREATEDB.
// Every destructive probe runs in a uniquely named, runner-owned database.
async function qualifyReceiver(snapshot, buildManifest, activeEntrypoints) {
  const { createProductBroker, PgProductRepository } = await import(
    pathToFileURL(join(snapshot, 'index.mjs')).href
  );
  await qualifyArtifactManifest(
    buildManifest,
    snapshot,
    fileURLToPath(new URL('../..', import.meta.url)),
  );
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
  checks.push(
    'artifact manifest: clean source/input inventory/bundle binding, seven rejected mutations and exact restoration',
  );
  const artifactSha256 = buildManifest.artifacts.find(
    (artifact) => artifact.path === 'index.mjs',
  ).sha256;
  const entrypointSha256 = buildManifest.artifacts.find(
    (artifact) => artifact.path === 'main.mjs',
  ).sha256;
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
    await qualifyEntrypoint(
      url.href,
      operatorKey,
      sourceKey,
      sourceId,
      join(snapshot, 'main.mjs'),
      activeEntrypoints,
    );
    checks.push(
      'real bundled entrypoint: seven private-file/environment startup controls, source-scoped PostgreSQL probe and owned process cleanup',
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
    const probe = async (key = sourceKey) => {
      const response = await fetch(`${base}/v1/product/probes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          protocol: 'station-product-probe/v1',
          inventoryRevision: inventory.inventoryRevision,
        }),
        signal: AbortSignal.timeout(6000),
      });
      return { status: response.status, body: await response.json() };
    };
    const beforeProbe = (
      await pool.query(`SELECT
    (SELECT count(*)::integer FROM station_telemetry.events) AS events,
    (SELECT count(*)::integer FROM station_telemetry.commits) AS commits,
    (SELECT count(*)::integer FROM station_telemetry.sources) AS sources`)
    ).rows[0];
    assert.equal(beforeProbe.events, 0);
    assert.equal(beforeProbe.commits, 0);
    const checked = await probe();
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.body.probe, {
      protocol: 'station-product-probe/v1',
      sourceId,
      inventoryRevision: inventory.inventoryRevision,
      checkedAt: checked.body.probe.checkedAt,
      storage: 'postgres-schema-v1',
    });
    assert.equal(
      new Date(checked.body.probe.checkedAt).toISOString(),
      checked.body.probe.checkedAt,
    );
    assert.equal((await probe(operatorKey)).status, 401);
    assert.equal(
      (await probe(`stp_${randomBytes(32).toString('base64url')}`)).status,
      401,
    );
    assert.deepEqual(
      (
        await pool.query(`SELECT
    (SELECT count(*)::integer FROM station_telemetry.events) AS events,
    (SELECT count(*)::integer FROM station_telemetry.commits) AS commits,
    (SELECT count(*)::integer FROM station_telemetry.sources) AS sources`)
      ).rows[0],
      beforeProbe,
    );
    checks.push(
      'HTTP source probe verifies schema/query, refuses foreign credentials and inserts no source, observation or commit',
    );
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
        await assert.rejects(store.probe(sourceKey), incompatible);
        assert.equal((await probe()).status, 503);
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
        (await store.trends(from, to)).rows.reduce(
          (n, row) => n + row.count,
          0,
        ),
        1,
      );
      checks.push(
        `${name}: all nine repository entrypoints and HTTP probe refused; restored readiness/data`,
      );
    }
    assert.equal(await store.revokeSource(sourceId), true);
    assert.equal((await send(batch)).status, 401);
    assert.equal((await probe()).status, 401);
    checks.push(
      'committed source revocation fences ingestion and connection probes',
    );

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
      entrypointSha256,
      buildManifest,
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
}

if (process.platform === 'win32')
  throw new Error('Entrypoint qualification requires the Unix file profile');
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const captured = await readReceiverArtifactManifest(
  fileURLToPath(new URL('./dist', import.meta.url)),
  repoRoot,
);
const snapshot = await mkdtemp(join(tmpdir(), 'station-telemetry-execution-'));
const activeEntrypoints = new Set();
try {
  for (const [name, bytes] of captured.bundles)
    await writeFile(join(snapshot, name), bytes, { mode: 0o400, flag: 'wx' });
  await writeFile(
    join(snapshot, 'artifact-manifest.json'),
    JSON.stringify(captured.manifest),
    { mode: 0o400, flag: 'wx' },
  );
  const checked = await readReceiverArtifactManifest(snapshot, repoRoot);
  await qualifyReceiver(snapshot, checked.manifest, activeEntrypoints);
} finally {
  if (activeEntrypoints.size === 0)
    await rm(snapshot, { recursive: true, force: true });
  else
    console.error(
      `Unsettled entrypoint; frozen execution snapshot retained: ${snapshot}; child PIDs: ${[...activeEntrypoints].map((execution) => execution.child.pid).join(',')}`,
    );
}
