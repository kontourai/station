import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Pool } from 'pg';
import { invokedDirectly } from '../../scripts/lib/module-entry.mjs';

const digest = (key) => createHash('sha256').update(key).digest('hex');
/** @returns {import('@kontourai/station-contracts/product-telemetry').StationDailyPing} */
const dailyPing = () => ({
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
});

async function checkLiteReceiver(store, pool, base, operatorKey) {
  const source = `qa-${randomUUID()}`;
  const other = `qa-${randomUUID()}`;
  const publisher = `publisher:@qa/plugin-${randomUUID()}`;
  const key = `stq_${randomBytes(32).toString('base64url')}`;
  const agent = 'private-user-agent-must-never-persist';
  const forwarded = '198.51.100.73';
  const logs = [];
  const stdoutWrite = process.stdout.write,
    stderrWrite = process.stderr.write;
  process.stdout.write = function (chunk, ...args) {
    logs.push(String(chunk));
    return stdoutWrite.call(this, chunk, ...args);
  };
  process.stderr.write = function (chunk, ...args) {
    logs.push(String(chunk));
    return stderrWrite.call(this, chunk, ...args);
  };
  const request = async (path, body, auth) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': agent,
        'x-forwarded-for': forwarded,
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const send = (ping, id = source) => request(`/v1/lite/${id}`, ping);
  const assertPrivateStorage = async () => {
    const names = (
      await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='station_telemetry'",
      )
    ).rows;
    const rows = [];
    for (const { tablename } of names)
      rows.push(
        (
          await pool.query(
            `SELECT row_to_json(t) AS row FROM station_telemetry."${tablename.replaceAll('"', '""')}" t`,
          )
        ).rows,
      );
    const persisted = JSON.stringify(rows);
    for (const sentinel of [
      '127.0.0.1',
      forwarded,
      agent,
      'private-rejected-content',
    ]) {
      assert.equal(
        (persisted + logs.join('')).includes(sentinel),
        false,
        'IP, user agent and rejected content never persist in rows or logs',
      );
    }
  };
  try {
    for (const [id, pub] of [
      [source, 'kontour'],
      [other, publisher],
    ]) {
      assert.equal(
        (
          await request(
            '/v1/operator/lite/sources',
            {
              id,
              publisher: pub,
              channel: 'stable',
              registryIds: [
                'public.plugin',
                ...Array.from({ length: 21 }, (_, i) => `public.${i}`),
              ],
              releaseVersions: ['1.2.3'],
            },
            operatorKey,
          )
        ).status,
        201,
        'operator provisions public source',
      );
    }
    assert.equal(
      (await request('/v1/operator/lite/sources', { id: 'unauthorized' }, key))
        .status,
      401,
    );
    assert.equal(
      (
        await request(
          '/v1/operator/lite/publishers',
          { publisher, credentialHash: digest(key) },
          operatorKey,
        )
      ).status,
      201,
    );
    const ping = dailyPing();
    assert.deepEqual(
      await send(ping),
      { status: 202, body: { inserted: 1 } },
      'lite ingest without per-install secret',
    );
    await assertPrivateStorage();
    assert.deepEqual(
      await send({
        ...ping,
        event_id: ping.event_id.toUpperCase(),
        surfaces_today: ['cli', 'web'],
      }),
      { status: 202, body: { inserted: 0 } },
      'event replay dedupe',
    );
    assert.equal(
      (await send({ ...ping, platform: 'darwin' })).status,
      409,
      'conflicting event',
    );
    for (const bad of [
      { ...dailyPing(), private_note: 'private-rejected-content' },
      { ...dailyPing(), surfaces_today: Array(6).fill('web') },
      {
        ...dailyPing(),
        public_plugins_enabled: Array.from(
          { length: 21 },
          (_, i) => `public.${i}`,
        ),
      },
      {
        ...dailyPing(),
        engine_connect_failures: [
          {
            engine: 'codex',
            bucket: '1',
            private_note: 'private-rejected-content',
          },
        ],
      },
      { ...dailyPing(), distribution: 'not.in.registry' },
      { ...dailyPing(), version: 'private-branch-version' },
      { ...dailyPing(), channel: 'nightly' },
    ]) {
      const response = await send(bad);
      assert.equal(response.status, 400, 'strict station_daily rejection');
      assert.equal(JSON.stringify(response.body).includes('private-'), false);
    }
    assert.equal(
      (await send({ ...dailyPing(), padding: 'x'.repeat(17000) })).status,
      413,
      'lite body size cap',
    );
    const oversized = await fetch(`${base}/v1/lite/${source}`, {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('x'.repeat(17000)));
          c.close();
        },
      }),
    });
    assert.equal(oversized.status, 413, 'streaming body cap');
    assert.equal((await send(dailyPing(), 'unknown')).status, 401);
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) FROM station_telemetry.lite_pings WHERE source_id=$1',
            [source],
          )
        ).rows[0].count,
      ),
      1,
      'rejections have no rows',
    );
    assert.equal(
      (
        await send({
          ...dailyPing(),
          public_plugins_enabled: Array.from(
            { length: 20 },
            (_, i) => `public.${i}`,
          ),
        })
      ).status,
      202,
      'twenty catalog-valid plugins accepted; twenty-one above refused only for the bound',
    );
    for (let i = 1; i < 10; i++) {
      const fresh = dailyPing();
      if (i === 1)
        fresh.engine_connect_failures = [{ bucket: '2-3', engine: 'codex' }];
      assert.equal(
        (
          await send(
            i === 1
              ? Object.fromEntries(Object.entries(fresh).reverse())
              : fresh,
          )
        ).status,
        202,
      );
    }
    for (let i = 0; i < 9; i++)
      assert.equal(
        (
          await send({
            ...dailyPing(),
            platform: 'darwin',
            home_replaced: true,
            public_plugins_enabled: [],
          })
        ).status,
        202,
      );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await send(
            {
              ...dailyPing(),
              distribution: 'custom',
              version: 'custom',
              first_active_this_week: false,
              first_active_this_month: false,
            },
            other,
          )
        ).status,
        202,
      );

    const today = (
      await pool.query(
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
      )
    ).rows[0].day;
    // Repository fixtures supply distinct daily network hashes; HTTP above stays on one socket IP.
    for (let i = 0; i < 9; i++)
      await store.lite.ingest(source, dailyPing(), {
        day: today,
        hash: digest(`qa-network-${i}`),
      });
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    const closedDay = date.toISOString().slice(0, 10);
    // Fixture-only time travel: production always assigns the locked receiver day.
    await pool.query(
      'UPDATE station_telemetry.lite_marginals SET day=$1 WHERE day=$2',
      [closedDay, today],
    );
    await pool.query(
      'UPDATE station_telemetry.lite_clients SET day=$1 WHERE day=$2',
      [closedDay, today],
    );
    await store.retain();
    assert.equal(
      (await pool.query('SELECT * FROM station_telemetry.lite_clients'))
        .rowCount,
      0,
      'finalization drops contributor hashes',
    );
    const publicRead = await request('/v1/public/aggregates');
    assert.equal(publicRead.status, 200);
    const day = publicRead.body.days.find((d) => d.day === closedDay);
    assert.equal(publicRead.body.minimumDistinctDailyClients, 10);
    assert.equal('representedPings' in day, false, 'no joint-derived total');
    assert.deepEqual(
      day.distributions.platform,
      { linux: 20 },
      'nine macOS pings from one network suppressed',
    );
    assert.deepEqual(day.distributions.home_replaced, { false: 20 });
    assert.deepEqual(day.distributions.public_plugins_enabled, {
      'public.plugin': 19,
    });
    assert.equal(day.distributions.engine_connect_failures['codex:2-3'], 29);
    assert.deepEqual(day.distributions.safe_mode_entered, { 1: 29 });
    assert.deepEqual(day.distributions.first_active_this_week, { true: 29 });
    assert.equal(JSON.stringify(publicRead.body).includes(publisher), false);
    assert.equal(
      (await request('/v1/public/aggregates?platform=linux')).status,
      400,
    );
    assert.equal(
      (await request('/v1/public/aggregates?from=2020-01-01')).status,
      400,
    );
    const own = await request(
      `/v1/publishers/${encodeURIComponent(publisher)}/aggregates`,
      undefined,
      key,
    );
    assert.equal(own.status, 200);
    assert.deepEqual(
      own.body.days,
      [],
      'publisher reads also suppress sub-k contributors',
    );
    assert.equal(
      (await request('/v1/publishers/kontour/aggregates', undefined, key))
        .status,
      401,
      'publisher cannot read another publisher',
    );
    assert.equal(
      (
        await request(
          `/v1/publishers/${encodeURIComponent(publisher)}/aggregates`,
          undefined,
          operatorKey,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          `/v1/publishers/${encodeURIComponent(publisher)}/aggregates`,
        )
      ).status,
      401,
    );
    await store.lite.revokePublisherKey(publisher);
    assert.equal(
      (
        await request(
          `/v1/publishers/${encodeURIComponent(publisher)}/aggregates`,
          undefined,
          key,
        )
      ).status,
      401,
    );
    assert.equal((await request('/v1/public/aggregates')).status, 200);
    const dashboard = await fetch(`${base}/public/`);
    assert.equal(dashboard.status, 200);
    assert.match(
      dashboard.headers.get('content-security-policy'),
      /default-src 'none'/,
    );
    assert.match(await dashboard.text(), /script src="\/public\/dashboard.js"/);
    assert.equal((await fetch(`${base}/public/dashboard.js`)).status, 200);

    await pool.query(
      'ALTER TABLE station_telemetry.lite_pings ADD COLUMN forbidden_ip text',
    );
    try {
      const unavailable = await send(dailyPing());
      assert.deepEqual(
        unavailable,
        { status: 503, body: { error: 'schema_incompatible' } },
        'incompatible storage errors disclose no request context',
      );
      await assert.rejects(
        store.migrate(),
        (error) => error.code === 'schema_incompatible',
      );
    } finally {
      await pool.query(
        'ALTER TABLE station_telemetry.lite_pings DROP COLUMN forbidden_ip',
      );
    }
    await store.ready();

    const before = (
      await pool.query(
        'SELECT sum(pings)::text AS count FROM station_telemetry.lite_marginals',
      )
    ).rows[0].count;
    await pool.query(
      "UPDATE station_telemetry.lite_pings SET received_at=clock_timestamp()-interval '91 days'",
    );
    await store.retain();
    assert.equal(
      Number(
        (await pool.query('SELECT count(*) FROM station_telemetry.lite_pings'))
          .rows[0].count,
      ),
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT sum(pings)::text AS count FROM station_telemetry.lite_marginals',
        )
      ).rows[0].count,
      before,
      'finalized marginals survive raw retention',
    );
    assert.deepEqual(
      (await request('/v1/public/aggregates')).body,
      publicRead.body,
      'closed-day publication unchanged by raw deletion',
    );
    await store.lite.revokeSource(source);
    assert.equal((await send(dailyPing())).status, 401);
    assert.equal((await send(dailyPing(), other)).status, 202);
    await assertPrivateStorage();
    return [
      'lite HTTP/PostgreSQL: public sources, strict unknown/nested/array/catalog rejection, bounded streaming bodies, commit/dedupe/conflict',
      'lite daily rollups: all dimensions, first-active flags, 90-day raw retention with persistent rollups',
      'public marginal suppression; scoped publisher keys, revocation, static same-origin dashboard',
      'IP/user-agent privacy: captured stdout/stderr plus every database table, accepted/rejected/error paths',
    ];
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

export async function qualifyLiteReceiver(
  createProductBroker,
  store,
  pool,
  operatorKey,
) {
  const server = createServer(
    getRequestListener(createProductBroker(store, operatorKey).fetch),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await checkLiteReceiver(
      store,
      pool,
      `http://127.0.0.1:${server.address().port}`,
      operatorKey,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const connectionString =
    process.env.STATION_TELEMETRY_QUALIFICATION_DATABASE_URL;
  if (!connectionString)
    throw new Error('A qualification PostgreSQL connection is required');
  const { createProductBroker, PgProductRepository } = await import(
    './dist/index.mjs'
  );
  const database = `station_lite_qa_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  let pool,
    passed = false,
    created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    pool = new Pool({
      connectionString: url.href,
      max: 4,
      connectionTimeoutMillis: 1500,
      statement_timeout: 3000,
      query_timeout: 3500,
    });
    const store = new PgProductRepository(pool);
    await store.migrate();
    await store.ready();
    const key = `sto_${randomBytes(32).toString('base64url')}`;
    const checks = await qualifyLiteReceiver(
      createProductBroker,
      store,
      pool,
      key,
    );
    passed = true;
    console.log(
      JSON.stringify({ scope: 'lite-diagnostic-only', checks }, null, 2),
    );
  } finally {
    await pool?.end();
    if (created && passed) await admin.query(`DROP DATABASE "${database}"`);
    else if (created)
      console.error(`Failed diagnostic database retained: ${database}`);
    await admin.end();
  }
}
if (invokedDirectly(import.meta.url)) await main();
