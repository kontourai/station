import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve('.kontourai/metrics-populations');
const suite = join(root, 'run-' + Date.now());
mkdirSync(suite, { mode: 0o700 });
mkdirSync(join(suite, 'provisioning', 'dashboards'), { recursive: true });
mkdirSync(join(suite, 'provisioning', 'datasources'), { recursive: true });
const key = randomBytes(24).toString('hex');
const password = randomBytes(24).toString('hex');
writeFileSync(join(suite, 'otel-key'), key, { mode: 0o600 });
const otel = readFileSync('deployment/telemetry/collector.yaml', 'utf8')
  .replace('/run/private/otel-key', JSON.stringify(join(suite, 'otel-key')))
  .replace('0.0.0.0:4318', '127.0.0.1:44982')
  .replace('0.0.0.0:8889', '127.0.0.1:44981')
  .replace('exporters:\n', 'exporters:\n  debug:\n    verbosity: detailed\n')
  .replace('level: warn', 'level: info')
  .replace('exporters: [otlphttp/tempo]', 'exporters: [debug]');
writeFileSync(join(suite, 'collector.yaml'), otel);
const prom = readFileSync('deployment/telemetry/prometheus.yml', 'utf8')
  .replace('collector:8889', '127.0.0.1:44981')
  .replace('scrape_interval: 15s', 'scrape_interval: 2s')
  .replace('scrape_timeout: 5s', 'scrape_timeout: 1s');
writeFileSync(join(suite, 'prometheus.yml'), prom);
const provision = readFileSync(
  'deployment/telemetry/grafana-dashboards.yaml',
  'utf8',
).replace('/var/lib/grafana/dashboards', join(suite, 'dashboards'));
mkdirSync(join(suite, 'dashboards'));
writeFileSync(
  join(suite, 'dashboards', 'station.json'),
  readFileSync('deployment/telemetry/dashboards/station.json'),
);
writeFileSync(
  join(suite, 'provisioning', 'dashboards', 'dashboard.yaml'),
  provision,
);
writeFileSync(
  join(suite, 'provisioning', 'datasources', 'source.yaml'),
  readFileSync('deployment/telemetry/grafana-datasources.yaml', 'utf8').replace(
    'http://prometheus:9090',
    'http://127.0.0.1:44983',
  ),
);
const children = [];
function start(name, command, args, env = {}) {
  const fd = openSync(join(suite, `${name}.log`), 'w', 0o600);
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  children.push({ child, ended });
  return ended;
}
async function wait(description, probe, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    try {
      const result = await probe();
      if (result) return result;
    } catch {}
    await delay(200);
  } while (Date.now() < deadline);
  throw Error('Timed out waiting for ' + description);
}
const authorization =
  'Basic ' + Buffer.from('telemetry-admin:' + password).toString('base64');
console.log('fixture', suite);
try {
  start('collector', join(root, 'bin', 'otelcol-contrib'), [
    '--config=' + join(suite, 'collector.yaml'),
  ]);
  start('prometheus', join(root, 'bin', 'prometheus'), [
    '--config.file=' + join(suite, 'prometheus.yml'),
    '--storage.tsdb.path=' + join(suite, 'prometheus'),
    '--web.listen-address=127.0.0.1:44983',
  ]);
  start(
    'grafana',
    join(root, 'grafana', 'bin', 'grafana'),
    ['server', '--homepath', join(root, 'grafana')],
    {
      GF_PATHS_DATA: join(suite, 'grafana-data'),
      GF_PATHS_LOGS: join(suite, 'grafana-logs'),
      GF_PATHS_PLUGINS: join(suite, 'grafana-plugins'),
      GF_PATHS_PROVISIONING: join(suite, 'provisioning'),
      GF_SERVER_HTTP_ADDR: '127.0.0.1',
      GF_SERVER_HTTP_PORT: '44984',
      GF_SECURITY_ADMIN_USER: 'telemetry-admin',
      GF_SECURITY_ADMIN_PASSWORD: password,
      GF_AUTH_ANONYMOUS_ENABLED: 'false',
      GF_USERS_ALLOW_SIGN_UP: 'false',
      GF_ANALYTICS_REPORTING_ENABLED: 'false',
      GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
      GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
      GF_PLUGINS_PREINSTALL_DISABLED: 'true',
      GF_PLUGINS_PREINSTALL_AUTO_UPDATE: 'false',
    },
  );
  await wait(
    'collector and Prometheus',
    async () =>
      (await fetch('http://127.0.0.1:44981/metrics')).ok &&
      (await fetch('http://127.0.0.1:44983/-/ready')).ok,
  );
  await wait(
    'Grafana health',
    async () => (await fetch('http://127.0.0.1:44984/api/health')).ok,
  );
  assert.equal(
    (
      await fetch('http://127.0.0.1:44982/v1/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.equal(
    (await fetch('http://127.0.0.1:44984/api/dashboards/uid/station-overview'))
      .status,
    401,
  );
  const dashboardResponse = await fetch(
    'http://127.0.0.1:44984/api/dashboards/uid/station-overview',
    { headers: { Authorization: authorization } },
  );
  assert(dashboardResponse.ok, await dashboardResponse.clone().text());
  const { dashboard } = await dashboardResponse.json();
  const ended = start(
    'producer',
    process.execPath,
    ['--import', 'tsx', join(root, 'produce.ts')],
    {
      STATION_HOME: join(suite, 'station-home'),
      STATION_ROOT: '',
      OTEL_SERVICE_NAME: 'station-fixture',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:44982',
      STATION_OTEL_API_KEY: key,
      OTEL_METRIC_EXPORT_INTERVAL: '1000',
      OTEL_BSP_SCHEDULE_DELAY: '500',
    },
  );
  const prometheus = async (query) => {
    const url = new URL(
      'http://127.0.0.1:44984/api/datasources/proxy/uid/station-prometheus/api/v1/query',
    );
    url.searchParams.set('query', query);
    const response = await fetch(url, {
      headers: { Authorization: authorization },
    });
    assert(response.ok, await response.clone().text());
    const body = await response.json();
    assert.equal(body.status, 'success');
    return body.data.result;
  };
  await prometheus('up');
  const targets = dashboard.panels.flatMap((panel) =>
    (panel.targets ?? []).map((target) => ({
      id: panel.id,
      title: panel.title,
      expr: target.expr,
    })),
  );
  const result = await ended;
  assert.equal(result.code, 0, 'producer failed; inspect its owned log');
  await wait('scheduler and primary chat samples', async () => {
    const jobs = await prometheus(
      targets.find((target) => target.id === 42).expr,
    );
    return (
      jobs.length === 2 &&
      (await prometheus(targets.find((target) => target.id === 1).expr)).length
    );
  });
  const raw = await (await fetch('http://127.0.0.1:44981/metrics')).text();
  writeFileSync(
    join(suite, 'scrape-diagnostic.txt'),
    raw
      .split('\n')
      .filter(
        (line) =>
          line.includes('station_scheduler') || line.includes('station_chat'),
      )
      .join('\n'),
  );
  await wait('second chat batch and histogram', async () => {
    const total = await prometheus(
      targets.find((target) => target.id === 1).expr,
    );
    const quantile = await prometheus(
      targets.find((target) => target.id === 3).expr,
    );
    const schedulerDuration = await prometheus(
      targets.find((target) => target.id === 43).expr,
    );
    return (
      Number(total[0]?.value[1]) === 4 &&
      quantile.some((row) => Number.isFinite(Number(row.value[1]))) &&
      schedulerDuration.some((row) => Number.isFinite(Number(row.value[1])))
    );
  });
  const results = [];
  for (const panel of targets)
    results.push({ ...panel, series: await prometheus(panel.expr) });
  const resultFor = (id) => results.filter((row) => row.id === id);
  const values = (id) =>
    resultFor(id).flatMap((row) =>
      row.series.map((series) => ({
        status: series.metric.status,
        op: series.metric.op,
        value: Number(series.value[1]),
      })),
    );
  assert.deepEqual(
    values(42).sort((a, b) => a.status.localeCompare(b.status)),
    [
      { status: 'error', op: undefined, value: 1 },
      { status: 'success', op: undefined, value: 3 },
    ],
  );
  assert.deepEqual(
    values(44)
      .map((x) => [x.op, x.value])
      .sort(),
    [
      ['create_job', 3],
      ['run_job', 4],
    ],
  );
  assert.equal(values(1)[0]?.value, 4);
  assert.equal(values(10).length, 0);
  assert(resultFor(3)[0].series.length > 0, 'histogram query lacked data');
  const traces = readFileSync(join(suite, 'collector.log'), 'utf8');
  for (const status of ['Error', 'Ok', 'Unset'])
    assert(
      new RegExp('Status code\\s*:\\s*' + status, 'i').test(traces),
      'Collector trace status ' + status + ' missing',
    );
  assert(
    !traces.includes('fixture primary stream failed'),
    'source exception escaped projection',
  );
  writeFileSync(
    join(suite, 'query-result.json'),
    JSON.stringify(
      { panels: results, collectorStatuses: ['Error', 'Ok', 'Unset'] },
      null,
      2,
    ),
  );
  console.log(
    'Grafana data source evaluated',
    targets.length,
    'queries; scheduler, chat, missing error series, histogram and Collector trace controls passed',
  );
} finally {
  for (const { child } of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
  await Promise.allSettled(
    children.map(({ ended }) => Promise.race([ended, delay(3_000)])),
  );
  for (const { child } of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
}
