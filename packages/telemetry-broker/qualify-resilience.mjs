import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION } from '@kontourai/station-shared/product-telemetry';

/** Real HTTP/PG regression owner; called by the existing bundled receiver harness. */
export async function qualifyResilience(
  createProductBroker,
  store,
  pool,
  operatorKey,
) {
  const key = `stp_${randomBytes(32).toString('base64url')}`;
  const source = randomUUID();
  await store.createSource(
    source,
    'anonymous flood control',
    createHash('sha256').update(key).digest('hex'),
  );
  const server = createServer(
    getRequestListener(createProductBroker(store, operatorKey).fetch),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (credential) => {
    const response = await fetch(`${base}/v1/product/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': credential },
      body: JSON.stringify({
        schema_version: 1,
        inventory_revision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
        distinct_id: 'a'.repeat(64),
        events: [
          {
            event_id: randomUUID(),
            event: 'engine_turn',
            occurred_at: new Date().toISOString(),
            observed_at: new Date().toISOString(),
            build: { version: '1.2.3', platform: 'linux', arch: 'x64' },
            properties: { engine: 'codex', outcome: 'completed' },
          },
        ],
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  let flooding = true;
  let badRequests = 0;
  const flood = Array.from({ length: 8 }, async () => {
    while (flooding) {
      await post(`stp_${randomBytes(32).toString('base64url')}`);
      badRequests++;
    }
  });
  try {
    const valid = [];
    for (let i = 0; i < 20; i++) valid.push(await post(key));
    assert.deepEqual(
      valid.map((r) => r.status),
      Array(20).fill(202),
      '8 concurrent random bad-key floods must not deny any of 20 valid PostgreSQL ingests',
    );
    assert.ok(
      badRequests >= 60,
      'anonymous pre-auth budget was exercised to exhaustion',
    );
    const publisher = `publisher:flood-${randomUUID()}`;
    const readKey = `stq_${randomBytes(32).toString('base64url')}`;
    await store.lite.setPublisherKey(
      publisher,
      createHash('sha256').update(readKey).digest('hex'),
    );
    for (let i = 0; i < 20; i++) {
      const response = await fetch(
        `${base}/v1/publishers/${encodeURIComponent(publisher)}/aggregates`,
        { headers: { authorization: `Bearer ${readKey}` } },
      );
      await response.json();
      assert.equal(
        response.status,
        200,
        'authenticated publisher reads use their post-auth budget during anonymous floods',
      );
    }
  } finally {
    flooding = false;
    await Promise.all(flood);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(
    JSON.stringify({
      control: 'real-postgres-bad-key-flood',
      workers: 8,
      badRequests,
      validAccepted: 20,
    }),
  );

  const scaleSource = `scale-${randomUUID()}`;
  const publisher = `publisher:scale-${randomUUID()}`;
  const today = (
    await pool.query(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
    )
  ).rows[0].day;
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  const day = d.toISOString().slice(0, 10);
  await store.lite.createSource({
    id: scaleSource,
    publisher,
    channel: 'stable',
    registryIds: ['public.plugin'],
    releaseVersions: ['1.2.3'],
  });
  // Obtain the exact validated/normalized production contribution shape from one real ingest.
  /** @type {import('@kontourai/station-contracts/product-telemetry').StationDailyPing} */
  const ping = {
    event: 'station_daily',
    event_id: randomUUID(),
    version: '1.2.3',
    channel: 'stable',
    platform: 'linux',
    arch: 'x64',
    surfaces_today: ['web', 'cli'],
    first_active_this_week: true,
    first_active_this_month: true,
    install_age_bucket: '8-30d',
    paired_devices_bucket: '2-3',
    engines_used_today: ['codex'],
    distribution: 'none',
    public_plugins_enabled: ['public.plugin'],
    private_plugins_bucket: '0',
    branding_overridden: false,
    home_replaced: false,
    layouts_customized: true,
    setup_abandoned_step: 'engine',
    engine_connect_failures: [{ engine: 'codex', bucket: '2-3' }],
    safe_mode_entered: 1,
    plugin_disabled_after_crash: 0,
  };
  await store.lite.ingest(scaleSource, ping, {
    day: today,
    hash: 'a'.repeat(64),
  });
  const template = (
    await pool.query(
      'SELECT ping,contributions FROM station_telemetry.lite_pings WHERE source_id=$1',
      [scaleSource],
    )
  ).rows[0];
  // Fixture loading is chunked, outside production transaction deadlines. No runtime limits are raised.
  for (let offset = 0; offset < 100000; offset += 5000)
    await pool.query(
      `INSERT INTO station_telemetry.lite_pings(source_id,event_id,ping,received_at,client_hash,contributions)
     SELECT $1,event_id,jsonb_set($2::jsonb,'{event_id}',to_jsonb(event_id::text)),$3::date::timestamp AT TIME ZONE 'UTC',decode(md5(i::text)||md5(i::text),'hex'),$4::jsonb
     FROM (SELECT i,gen_random_uuid() AS event_id FROM generate_series($5::int,$5::int+4999) i) fixture`,
      [
        scaleSource,
        JSON.stringify(template.ping),
        day,
        JSON.stringify(template.contributions),
        offset,
      ],
    );
  await pool.query(
    'UPDATE station_telemetry.lite_capacity SET pings=pings+100000 WHERE singleton',
  );
  await pool.query(
    `INSERT INTO station_telemetry.lite_finalization SELECT $1::date,$2,key FROM jsonb_object_keys($3::jsonb) key`,
    [day, publisher, JSON.stringify(template.contributions)],
  );
  const erasureSource = `erase-${randomUUID()}`;
  const erasurePublisher = `publisher:zz-erase-${randomUUID()}`;
  await store.lite.createSource({
    id: erasureSource,
    publisher: erasurePublisher,
    channel: 'stable',
    registryIds: ['public.plugin'],
    releaseVersions: ['1.2.3'],
  });
  await store.lite.ingest(
    erasureSource,
    { ...ping, event_id: randomUUID() },
    { day: today, hash: 'b'.repeat(64) },
  );
  await pool.query(
    'UPDATE station_telemetry.lite_finalization SET day=$1 WHERE publisher=$2',
    [day, erasurePublisher],
  );
  await pool.query(
    "UPDATE station_telemetry.lite_pings SET received_at=$1::date::timestamp AT TIME ZONE 'UTC' WHERE source_id=$2",
    [day, erasureSource],
  );
  const locker = await pool.connect();
  const started = performance.now();
  let lockConnectionError;
  const recordLockError = (error) => {
    lockConnectionError = error;
  };
  locker.on('error', recordLockError);
  let heartbeat = Promise.resolve();
  // Keep the fixture's held lock active under the real five-second idle limit.
  const keepalive = setInterval(() => {
    heartbeat = heartbeat
      .then(() => locker.query('SELECT 1'))
      .catch(recordLockError);
  }, 1000);
  try {
    await locker.query('BEGIN');
    await locker.query(
      "SELECT 1 FROM station_telemetry.lite_finalization WHERE day=$1 AND publisher=$2 AND dimension='version' FOR UPDATE",
      [day, publisher],
    );
    await store.lite.finalize();
    const diagnostics = (await store.lite.exact('daily'))
      .finalizationDiagnostics;
    assert.ok(
      diagnostics.failures.some(
        (f) =>
          f.publisher === publisher &&
          f.period === day &&
          (f.code === '57014' || f.code === 'storage_timeout'),
      ),
      'blocked final dimension is recorded without failing independent jobs or reads',
    );
    console.log(JSON.stringify({ control: 'scale-interruption', diagnostics }));
    const committed = await pool.query(
      'SELECT count(*) AS n FROM station_telemetry.lite_marginals WHERE day=$1 AND publisher=$2 AND finalized',
      [day, publisher],
    );
    assert.ok(
      Number(committed.rows[0].n) > 0,
      'completed scale dimensions must survive an interrupted finalizer',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM station_telemetry.lite_pings WHERE source_id=$1 AND (client_hash IS NOT NULL OR contributions IS NOT NULL)',
          [erasureSource],
        )
      ).rowCount,
      0,
      'blocked publisher dimension cannot prevent another publisher/day association erasure',
    );
    await pool.query(
      "UPDATE station_telemetry.events SET received_at=clock_timestamp()-interval '91 days' WHERE source_id=$1",
      [source],
    );
    await pool.query(
      "UPDATE station_telemetry.commits SET stored_at=clock_timestamp()-interval '8 days' WHERE source_id=$1",
      [source],
    );
    await store.retain();
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM station_telemetry.events WHERE source_id=$1 UNION ALL SELECT 1 FROM station_telemetry.commits WHERE source_id=$1',
          [source],
        )
      ).rowCount,
      0,
      'retention progresses independently of blocked finalization',
    );
  } finally {
    clearInterval(keepalive);
    await heartbeat;
    try {
      await locker.query('ROLLBACK');
    } finally {
      locker.off('error', recordLockError);
      locker.release(Boolean(lockConnectionError));
    }
  }
  if (lockConnectionError) throw lockConnectionError;
  const reopened = new store.constructor(pool);
  await reopened.migrate();
  await reopened.lite.finalize();
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM station_telemetry.lite_finalization WHERE day=$1 AND publisher=$2',
        [day, publisher],
      )
    ).rowCount,
    0,
    'all scale dimensions finalized',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM station_telemetry.lite_pings WHERE source_id=$1 AND received_at<$2::date::timestamp AT TIME ZONE 'UTC' AND (client_hash IS NOT NULL OR contributions IS NOT NULL) ORDER BY received_at LIMIT 1",
        [scaleSource, today],
      )
    ).rowCount,
    0,
    'all 100k closed-day contributor hashes and associations erased',
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT pings FROM station_telemetry.lite_marginals WHERE publisher=$1 AND day=$2 AND dimension='platform' AND value='linux'",
          [publisher, day],
        )
      ).rows[0].pings,
    ),
    100000,
    'set-based finalization counted every synthetic ping',
  );
  const first = await store.lite.aggregates(publisher);
  assert.deepEqual(
    (await reopened.lite.aggregates(publisher)).cells,
    first.cells,
    'repository reopen preserves the secret and estimates',
  );
  assert.deepEqual(
    (await store.lite.aggregates(publisher)).cells,
    first.cells,
    'uncached scale reads retain identical noise',
  );
  const errors = (
    await pool.query(
      `SELECT abs(p.estimate-m.clients)::float8 AS error
    FROM station_telemetry.lite_published p JOIN station_telemetry.lite_marginals m
    ON p.publisher=m.publisher AND p.week=m.day AND p.dimension=m.dimension AND p.value=m.value
    WHERE p.publisher=$1 AND p.week=$2`,
      [publisher, day],
    )
  ).rows.map((r) => r.error);
  console.log(
    JSON.stringify({
      control: 'real-postgres-scale',
      pings: 100000,
      elapsedMs,
      includesBlockedStatement: true,
      publishedCounts: errors.length,
      meanAbsoluteError: errors.reduce((a, b) => a + b, 0) / errors.length,
      maxAbsoluteError: Math.max(...errors),
      epsilonPerCount: 1 / 280,
      epsilonPerAddedPing: 1 / 7,
      countUnit: 'network-days',
    }),
  );
  // Real keys are known before a failed refresh. Expiry must be unavailable, not unauthorized.
  const readPublisher = `publisher:ttl-${randomUUID()}`;
  const readKey = `stq_${randomBytes(32).toString('base64url')}`;
  await store.lite.setPublisherKey(
    readPublisher,
    createHash('sha256').update(readKey).digest('hex'),
  );
  await store.refreshCredentials();
  assert.equal(store.hasCredential(key), true);
  assert.equal(store.lite.hasCredential(readPublisher, readKey), true);
  const realNow = Date.now;
  const expiryServer = createServer(
    getRequestListener(createProductBroker(store, operatorKey).fetch),
  );
  await new Promise((resolve) => expiryServer.listen(0, '127.0.0.1', resolve));
  try {
    await pool.query(
      'ALTER TABLE station_telemetry.sources ADD COLUMN qualification_refresh_failure text',
    );
    await assert.rejects(store.refreshCredentials());
    Date.now = () => realNow() + 61000;
    const staleBase = `http://127.0.0.1:${expiryServer.address().port}`;
    for (const [path, init] of [
      [
        '/v1/product/events',
        { method: 'POST', headers: { 'x-api-key': key }, body: '{}' },
      ],
      [
        `/v1/publishers/${encodeURIComponent(readPublisher)}/aggregates`,
        { headers: { authorization: `Bearer ${readKey}` } },
      ],
    ]) {
      const r = await fetch(staleBase + path, init);
      assert.equal(
        r.status,
        503,
        'valid keys with expired credential snapshot return 503',
      );
      assert.deepEqual(await r.json(), { error: 'credentials_stale' });
    }
  } finally {
    Date.now = realNow;
    await pool.query(
      'ALTER TABLE station_telemetry.sources DROP COLUMN qualification_refresh_failure',
    );
    await store.refreshCredentials();
    expiryServer.closeAllConnections();
    await new Promise((resolve) => expiryServer.close(resolve));
  }
  const admissionLock = await pool.connect();
  try {
    await admissionLock.query('BEGIN');
    await admissionLock.query(
      "SELECT pg_advisory_xact_lock(hashtext('station.product.telemetry.admission'))",
    );
    await store.lite.publicAggregates();
  } finally {
    await admissionLock.query('ROLLBACK');
    admissionLock.release();
  }
  return [
    'real PostgreSQL: eight concurrent random bad-key floods preserve all twenty valid commits',
    '100k closed-day pings: interrupted/resumed dimension finalization, independent publisher/day erasure and retention, complete hash erasure, no public-read ingest lock',
    'real valid Full/publisher keys: failed refresh beyond 60 seconds returns 503 credentials_stale',
  ];
}
