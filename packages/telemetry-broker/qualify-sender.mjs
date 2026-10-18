import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { execFileSyncBounded } from '../../scripts/lib/bounded-capture.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../scripts/lib/owned-process.mjs';

// This diagnostic deliberately requires a built Station server with a custom
// version fixture. It never replaces the clean-source receiver qualifier.
const connectionString =
  process.env.STATION_TELEMETRY_QUALIFICATION_DATABASE_URL;
assert.ok(
  connectionString,
  'An isolated PostgreSQL administrative connection is required',
);
assert.equal(
  process.platform,
  'darwin',
  'This diagnostic uses macOS sandbox-exec to prohibit production calls',
);
const receiver = resolve(
  process.env.STATION_TELEMETRY_RECEIVER_DIST ??
    'packages/telemetry-broker/dist',
);
const station = resolve(
  process.env.STATION_TELEMETRY_SENDER_SERVER ??
    'dist-server/command-station.js',
);
const root = await mkdtemp(join(tmpdir(), 'station-sender-interop-'));
const home = join(root, 'station-home');
const database = `station_sender_qa_${randomUUID().replaceAll('-', '')}`;
const operatorKey = `sto_${randomBytes(32).toString('base64url')}`;
const admin = new Pool({ connectionString });
const url = new URL(connectionString);
url.pathname = `/${database}`;
const children = [];
const exchanges = [];
let pool,
  relay,
  created = false,
  passed = false;
const sha256 = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const listen = (server) =>
  new Promise((yes, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', yes);
  });
const close = (server) =>
  new Promise((yes) => {
    server.closeAllConnections();
    server.close(yes);
  });
async function reservePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}
function launch(label, args, env) {
  const execution = executeOwnedProcess(
    args[0],
    args.slice(1),
    undefined,
    label,
    {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  children.push({
    label,
    execution,
    capture: captureOwnedProcessOutput(execution, {
      maxBytes: 3 * 1024 * 1024,
    }),
  });
  return execution;
}
async function until(label, operation, timeout = 120_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const result = await operation();
    if (result) return result;
    for (const child of children)
      assert.ok(
        child.expectedStop || child.execution.isAlive(),
        `${child.label} exited while waiting for ${label}`,
      );
    await new Promise((yes) => setTimeout(yes, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  pool = new Pool({ connectionString: url.href });
  const { PgProductRepository } = await import(
    pathToFileURL(join(receiver, 'index.mjs')).href
  );
  const store = new PgProductRepository(pool);
  await store.migrate();
  const source = 'sender-unknown';
  await store.lite.createSource({
    id: source,
    publisher: 'operator',
    channel: 'unknown',
    registryIds: [],
    releaseVersions: [],
  });
  const receiverPort = await reservePort();
  const receiverBase = `http://127.0.0.1:${receiverPort}`;
  await writeFile(join(root, 'operator-key'), operatorKey, { mode: 0o400 });
  await writeFile(join(root, 'database-url'), url.href, { mode: 0o400 });
  launch('receiver', [process.execPath, join(receiver, 'main.mjs')], {
    STATION_TELEMETRY_BROKER_DATABASE_URL_FILE: join(root, 'database-url'),
    STATION_TELEMETRY_BROKER_OPERATOR_KEY_FILE: join(root, 'operator-key'),
    STATION_TELEMETRY_BROKER_HOST: '127.0.0.1',
    STATION_TELEMETRY_BROKER_PORT: String(receiverPort),
    STATION_TELEMETRY_BROKER_TRUSTED_PROXY: '127.0.0.1/32',
  });
  await until('receiver liveness', async () => {
    try {
      return (await fetch(`${receiverBase}/health/live`)).status === 200;
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
      return false;
    }
  });
  relay = createServer(async (req, res) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        assert.ok(bytes <= 16384);
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(
        req.headers['x-api-key'],
        undefined,
        'Lite must not disclose an installation credential',
      );
      const response = await fetch(`${receiverBase}/v1/lite/${source}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.149',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      exchanges.push({ payload, status: response.status, body });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (error) {
      res.writeHead(500);
      res.end();
      exchanges.push({ relayError: String(error) });
    }
  });
  await listen(relay);
  // macOS refuses setuid /bin/ps inside sandbox-exec. A private, unprivileged
  // ad-hoc-signed copy retains the real process birth probe for Station locks.
  const bin = join(root, 'bin');
  await mkdir(bin);
  const ps = join(bin, 'ps');
  await writeFile(ps, await readFile('/bin/ps'));
  await chmod(ps, 0o755);
  execFileSyncBounded('/usr/bin/codesign', ['--force', '--sign', '-', ps], {
    windowsHide: true,
  });
  const startStation = async (label) => {
    const stationExecution = launch(
      label,
      [
        '/usr/bin/sandbox-exec',
        '-p',
        '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))',
        process.execPath,
        station,
      ],
      {
        PATH: `${bin}:${process.env.PATH}`,
        STATION_HOME: home,
        STATION_ROOT: join(root, 'instances'),
        STATION_INSTANCE_ID: 'telemetry-receiver-proxy-qa',
        STATION_HOST: '127.0.0.1',
        PORT: '0',
        STATION_CHANNEL: 'dev',
        STATION_PRODUCT_TELEMETRY_ENDPOINT: `http://127.0.0.1:${relay.address().port}/v1/lite/${source}`,
      },
    );
    let stationPort;
    let banner = '';
    stationExecution.child.stdout.on('data', (chunk) => {
      banner = (banner + chunk.toString('utf8')).slice(-16384);
      const match = /HTTP Server: {2}http:\/\/127\.0\.0\.1:(\d+)/.exec(banner);
      if (match) stationPort = Number(match[1]);
    });
    await until('Station readiness', () => stationPort);
    return { execution: stationExecution, port: stationPort };
  };
  const seed = await startStation('station-seed');
  const dailyPath = join(home, 'config/telemetry-daily.json');
  await until('daily accumulator', async () => {
    try {
      return JSON.parse(await readFile(dailyPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  });
  children.find((c) => c.execution === seed.execution).expectedStop = true;
  const stopped = await terminateSuiteExecution(seed.execution, {
    terminationGraceMs: 15_000,
    terminationForceMs: 2000,
    waitForSuiteSettlement,
  });
  assert.ok(
    stopped.settled && !stopped.escalated && stopped.errors.length === 0,
    'seed Station shutdown',
  );
  const previous = JSON.parse(await readFile(dailyPath, 'utf8'));
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  // Exercise the real next-day sender without waiting until midnight. Preserve
  // its generated accumulator; model a prior build without channel metadata.
  previous.day = yesterday;
  previous.lastActiveDay = yesterday;
  previous.ping.channel = 'unknown';
  await writeFile(dailyPath, JSON.stringify(previous), { mode: 0o600 });
  const { port: stationPort } = await startStation('station');
  const ping = await until('real Station station_daily delivery', () =>
    exchanges.find((e) => e.payload?.event === 'station_daily'),
  );
  assert.deepEqual(
    { status: ping.status, body: ping.body },
    { status: 202, body: { inserted: 1 } },
  );
  for (const field of ['channel', 'distribution', 'layouts_customized'])
    assert.equal(ping.payload[field], 'unknown', field);
  assert.equal(
    ping.payload.version,
    'custom',
    'Build the Station diagnostic with a non-SemVer version fixture',
  );
  const environment = JSON.parse(
    await readFile(join(home, 'security/environment.json'), 'utf8'),
  );
  const stationBase = `http://127.0.0.1:${stationPort}`;
  const lower = await fetch(`${stationBase}/config/app`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${environment.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      telemetryTier: { operator: 'off' },
      telemetryFeedbackReason: 'privacy',
    }),
  });
  assert.equal(lower.status, 200, await lower.text());
  const feedback = await until('tier-lowered feedback delivery', () =>
    exchanges.find((e) => e.payload?.action === 'tier-lowered'),
  );
  assert.deepEqual(feedback, {
    payload: {
      publisher: 'operator',
      action: 'tier-lowered',
      reason: 'privacy',
    },
    status: 202,
    body: { inserted: 1 },
  });
  const feedbackResponse = await fetch(
    `${receiverBase}/v1/operator/lite/daily`,
    { headers: { authorization: `Bearer ${operatorKey}` } },
  );
  assert.equal(feedbackResponse.status, 200);
  assert.equal(feedbackResponse.headers.get('cache-control'), 'no-store');
  const feedbackExact = await feedbackResponse.json();
  assert.ok(
    feedbackExact.feedback.some(
      (row) =>
        row.publisher === 'operator' &&
        row.action === 'tier-lowered' &&
        row.reason === 'privacy' &&
        row.count === '1',
    ),
  );
  const rows = await pool.query(
    'SELECT ping FROM station_telemetry.lite_pings',
  );
  assert.deepEqual(
    rows.rows.map((r) => r.ping),
    [ping.payload],
    'Only the accepted daily ping is stored',
  );
  const {
    rows: [{ day }],
  } = await pool.query(
    "SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date-1,'YYYY-MM-DD') AS day",
  );
  // Fixture time travel closes arrival day; no sender clock field controls finalization.
  await pool.query('UPDATE station_telemetry.lite_finalization SET day=$1', [
    day,
  ]);
  await pool.query(
    "UPDATE station_telemetry.lite_pings SET received_at=$1::date::timestamp AT TIME ZONE 'UTC'",
    [day],
  );
  await store.lite.finalize();
  const response = await fetch(`${receiverBase}/v1/operator/lite/daily`, {
    headers: { authorization: `Bearer ${operatorKey}` },
  });
  assert.equal(response.status, 200);
  const exact = await response.json();
  assert.ok(
    exact.marginals.some(
      (m) =>
        m.period === day &&
        m.dimension === 'channel' &&
        m.value === 'unknown' &&
        m.pings === '1' &&
        m.contributors === '1',
    ),
  );
  assert.ok(
    (
      await pool.query(
        'SELECT client_hash,contributions FROM station_telemetry.lite_pings',
      )
    ).rows.every((r) => r.client_hash === null && r.contributions === null),
  );
  passed = true;
  console.log(
    JSON.stringify(
      {
        scope:
          'built Station server to built receiver, loopback only; no tunnel/deployment proof',
        artifacts: {
          serverSha256: await sha256(station),
          receiverSha256: await sha256(join(receiver, 'main.mjs')),
        },
        postgres: (await pool.query('SHOW server_version')).rows[0]
          .server_version,
        exchanges,
        operatorExact: exact,
        feedbackExact,
      },
      null,
      2,
    ),
  );
} finally {
  let settled = true;
  for (const { label, execution, capture } of children.reverse()) {
    const cleanup = await terminateSuiteExecution(execution, {
      terminationGraceMs: 15_000,
      terminationForceMs: 2000,
      waitForSuiteSettlement,
    });
    settled &&= cleanup.settled && cleanup.errors.length === 0;
    const output = capture.finish();
    await writeFile(
      join(root, `${label}.log`),
      output.stdout.text + output.stderr.text,
      { mode: 0o600 },
    );
  }
  if (relay) await close(relay);
  await pool?.end();
  if (created && passed && settled)
    await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
  if (passed && settled) await rm(root, { recursive: true, force: true });
  else
    console.error(`Failed diagnostic retained: ${root}; database ${database}`);
  assert.ok(settled, 'Owned processes did not settle');
}
