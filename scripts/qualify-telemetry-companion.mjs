import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import { verifyTelemetryCompanion } from './package-telemetry-companion.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = () => randomBytes(32).toString('base64url');
const pause = () => new Promise((done) => setTimeout(done, 500));

async function poll(label, probe, timeoutMs = 45_000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // Only reads are retried. A Docker or HTTP mutation is never retried here.
    }
    await pause();
  }
  throw new Error(`${label}: observation deadline`);
}

async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  assert(![3000, 3141].includes(port));
  return port;
}

async function request(
  port,
  path,
  { key, operator = false, basic, body, method } = {},
) {
  const headers = {};
  if (basic)
    headers.authorization = `Basic ${Buffer.from(basic).toString('base64')}`;
  if (key)
    headers[operator ? 'authorization' : 'x-api-key'] = operator
      ? `Bearer ${key}`
      : key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
    redirect: 'error',
  });
  const chunks = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) {
        await reader.cancel();
        throw new Error('HTTP response bound');
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return { status: response.status, body: JSON.parse(text) };
}

async function qualifyTelemetryCompanion(candidate, output) {
  if (process.platform === 'win32')
    throw new Error('Unix private-file runtime qualification is required');
  candidate = resolve(candidate);
  output = resolve(output);
  const within = relative(ROOT, output);
  assert(
    within === '..' || within.startsWith('../') || isAbsolute(within),
    'Qualification output must be outside the checkout',
  );
  const child = relative(candidate, output);
  assert(
    child === '..' || child.startsWith('../') || isAbsolute(child),
    'Output must not modify the candidate',
  );
  assert(
    output !== ROOT && output !== candidate,
    'Exclusive external output required',
  );
  const input = await verifyTelemetryCompanion(candidate);
  await mkdir(output, { mode: 0o700 });
  const snapshot = join(output, 'candidate');
  await cp(candidate, snapshot, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const manifest = await verifyTelemetryCompanion(snapshot);
  assert.deepEqual(manifest, input, 'Candidate changed during capture');
  const owner = randomBytes(12).toString('hex');
  const project = `telemetry-qa-${owner}`;
  const report = {
    protocol: 'station-companion-runtime-diagnostic/v1',
    scope: 'synthetic-component-runtime-only',
    installationAuthority: false,
    source: manifest.source,
    manifestSha256: createHash('sha256')
      .update(await readFile(join(snapshot, 'companion-manifest.json')))
      .digest('hex'),
    project,
    checks: [],
    effects: [],
    notVerified: [
      'real Station export',
      'diagnostic trace query semantics',
      'same-volume data durability',
      'fresh backup/restore',
      'version upgrade/rollback',
      'publisher privacy reconciliation',
      'personal grants/sync',
      'native/release acceptance',
    ],
  };
  const save = () =>
    writeFile(
      join(output, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  let sequence = 0;
  async function command(executable, args, label, env, timeoutMs = 30_000) {
    const effect = {
      label,
      executable,
      args,
      state: 'started',
      sequence: sequence++,
    };
    report.effects.push(effect);
    await save();
    const execution = executeOwnedProcess(executable, args, undefined, label, {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = captureOwnedProcessOutput(execution, {
      maxBytes: 1024 * 1024,
    });
    let timer;
    let result;
    let captured;
    let failure;
    let complete = false;
    try {
      result = await Promise.race([
        execution.completion,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('command deadline; daemon outcome unknown')),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      effect.state = 'unknown';
      failure = error;
    } finally {
      clearTimeout(timer);
      const cleanup = await terminateSuiteExecution(execution, {
        terminationGraceMs: 1000,
        terminationForceMs: 1000,
        waitForSuiteSettlement,
      });
      if (!cleanup.settled) effect.state = 'unsettled';
      const bytes = capture.finish();
      captured = bytes;
      await writeFile(
        join(output, `${effect.sequence}.log`),
        bytes.stdout.text + bytes.stderr.text,
        { mode: 0o600 },
      );
      complete =
        cleanup.settled &&
        !cleanup.escalated &&
        cleanup.errors.length === 0 &&
        !bytes.truncated &&
        !bytes.invalidUtf8;
      await save();
    }
    if (failure) throw failure;
    assert(complete, `${label}: incomplete process evidence`);
    effect.state =
      result.status === 0 && !result.error ? 'completed' : 'refused';
    await save();
    assert.equal(
      result.status,
      0,
      `${label}: command refused; see private log`,
    );
    return captured.stdout.text.trim();
  }
  let endpoint;
  let env;
  let started = false;
  let compose;
  const docker = (args, label, timeout) =>
    command('docker', ['--host', endpoint, ...args], label, env, timeout);
  async function mutate(port, path, options, label) {
    const requestFile = `${report.effects.length}.request.json`;
    await writeFile(
      join(output, requestFile),
      `${JSON.stringify(options.body)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    const effect = {
      label,
      kind: 'http',
      state: 'started',
      path,
      requestFile,
      bodySha256: createHash('sha256')
        .update(JSON.stringify(options.body))
        .digest('hex'),
    };
    report.effects.push(effect);
    await save();
    try {
      const result = await request(port, path, options);
      effect.state = 'responded';
      effect.status = result.status;
      await save();
      return result;
    } catch (error) {
      effect.state = 'unknown';
      await save();
      throw error;
    }
  }
  const check = async (label) => {
    report.checks.push(label);
    await save();
  };
  try {
    assert.equal(
      await command(
        'git',
        ['rev-parse', 'HEAD'],
        'source revision',
        process.env,
      ),
      manifest.source,
    );
    assert.equal(
      await command(
        'git',
        ['status', '--porcelain'],
        'clean source',
        process.env,
      ),
      '',
    );
    if (
      process.env.DOCKER_HOST &&
      !process.env.DOCKER_HOST.startsWith('unix://')
    )
      throw new Error('Local Unix Docker context required');
    endpoint =
      process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
        ? process.env.DOCKER_HOST
        : await command(
            'docker',
            ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
            'selected context',
            process.env,
          );
    assert(
      endpoint.startsWith('unix://'),
      'Local Unix Docker context required',
    );
    const privateDir = join(output, 'private');
    await mkdir(privateDir, { mode: 0o700 });
    const password = token(),
      operatorKey = `sto_${token()}`,
      otelKey = token(),
      grafanaPassword = token();
    for (const [name, value] of Object.entries({
      'postgres-password': password,
      'database-url': `postgresql://station_telemetry:${password}@postgres:5432/station_telemetry`,
      'product-operator-key': operatorKey,
      'otel-key': otelKey,
      'grafana-password': grafanaPassword,
    }))
      await writeFile(join(privateDir, name), value, {
        mode: 0o400,
        flag: 'wx',
      });
    const ports = await Promise.all([unusedPort(), unusedPort(), unusedPort()]);
    assert.equal(
      new Set(ports).size,
      3,
      'Distinct reserved host ports required',
    );
    const image = `station-telemetry-qa:${owner}`;
    report.ports = ports;
    report.imageTag = image;
    env = {
      ...process.env,
      DOCKER_HOST: endpoint,
      DOCKER_CONTEXT: '',
      COMPOSE_PROJECT_NAME: project,
      TELEMETRY_PRIVATE_DIR: privateDir,
      TELEMETRY_RECEIVER_IMAGE: image,
      TELEMETRY_PRODUCT_PORT: String(ports[0]),
      TELEMETRY_OTLP_PORT: String(ports[1]),
      TELEMETRY_GRAFANA_PORT: String(ports[2]),
    };
    compose = [
      'compose',
      '-p',
      project,
      '-f',
      join(snapshot, 'deployment/compose.yaml'),
    ];
    await docker(
      [
        'build',
        '--label',
        `station.telemetry.qualifier=${owner}`,
        '-t',
        image,
        snapshot,
      ],
      'build captured candidate',
      180_000,
    );
    report.image = await docker(
      ['image', 'inspect', image, '--format', '{{.Id}}'],
      'capture image identity',
    );
    await docker(
      [
        ...compose,
        'pull',
        'postgres',
        'collector',
        'prometheus',
        'tempo',
        'grafana',
      ],
      'pull immutable dependencies',
      180_000,
    );
    started = true;
    await docker(
      [
        ...compose,
        'up',
        '-d',
        '--no-build',
        '--pull',
        'never',
        '--wait',
        '--wait-timeout',
        '120',
      ],
      'start isolated profile',
      150_000,
    );
    const operator = { key: operatorKey, operator: true };
    await poll('product storage', async () => {
      const r = await request(ports[0], '/v1/operator/storage', operator);
      return (
        r.status === 200 &&
        r.body.state === 'ready' &&
        r.body.scope === 'postgres-schema-v1'
      );
    });
    assert.equal(
      (
        await request(ports[0], '/v1/operator/storage', {
          key: `sto_${token()}`,
          operator: true,
        })
      ).status,
      401,
    );
    await check('host product storage schema ready; wrong operator refused');
    await poll(
      'Grafana HTTP/database',
      async () =>
        (await request(ports[2], '/api/health')).body.database === 'ok',
      120_000,
    );
    assert.equal((await request(ports[2], '/api/search')).status, 401);
    assert.equal(
      (
        await request(ports[1], '/v1/metrics', {
          key: 'wrong-key',
          body: { resourceMetrics: [] },
        })
      ).status,
      401,
    );
    await check(
      'Grafana database ready; anonymous dashboard and wrong Collector credential refused',
    );
    for (const [service, containerPort, hostPort] of [
      ['receiver', 43891, ports[0]],
      ['collector', 4318, ports[1]],
      ['grafana', 3000, ports[2]],
    ]) {
      const [info] = JSON.parse(
        await docker(
          ['inspect', `${project}-${service}-1`],
          `inspect ${service}`,
        ),
      );
      assert.deepEqual(info.NetworkSettings.Ports[`${containerPort}/tcp`], [
        { HostIp: '127.0.0.1', HostPort: String(hostPort) },
      ]);
    }
    for (const [service, network] of [
      ['postgres', 'product'],
      ['prometheus', 'diagnostics'],
      ['tempo', 'diagnostics'],
    ]) {
      const [info] = JSON.parse(
        await docker(
          ['inspect', `${project}-${service}-1`],
          `inspect ${service}`,
        ),
      );
      assert.deepEqual(Object.keys(info.NetworkSettings.Networks), [
        `${project}_${network}`,
      ]);
      assert(
        Object.values(info.NetworkSettings.Ports).every(
          (port) => port === null,
        ),
      );
    }
    await check(
      'loopback-only frontends and unpublished separately networked backends',
    );
    const metricName = `companion_qualification_${owner}_requests`;
    const metricStart = BigInt(Date.now() - 2000) * 1_000_000n;
    for (const [index, value] of [2, 3].entries()) {
      const result = await mutate(
        ports[1],
        '/v1/metrics',
        {
          key: otelKey,
          body: {
            resourceMetrics: [
              {
                resource: {
                  attributes: [
                    {
                      key: 'service.name',
                      value: { stringValue: 'station-qualification' },
                    },
                  ],
                },
                scopeMetrics: [
                  {
                    scope: { name: 'companion-runtime-qualification' },
                    metrics: [
                      {
                        name: metricName,
                        sum: {
                          aggregationTemporality: 1,
                          isMonotonic: true,
                          dataPoints: [
                            {
                              startTimeUnixNano: String(
                                metricStart + BigInt(index) * 1_000_000_000n,
                              ),
                              timeUnixNano: String(
                                metricStart +
                                  BigInt(index + 1) * 1_000_000_000n,
                              ),
                              asInt: String(value),
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        `send synthetic delta metric ${index + 1}`,
      );
      assert.equal(result.status, 200);
      assert(
        !result.body.partialSuccess,
        'Collector partially rejected metrics',
      );
    }
    await poll(
      'Grafana queries cumulative diagnostic metric',
      async () => {
        const result = await request(
          ports[2],
          `/api/datasources/proxy/uid/station-prometheus/api/v1/query?query=${encodeURIComponent(metricName)}`,
          { basic: `admin:${grafanaPassword}` },
        );
        return (
          result.status === 200 &&
          result.body.status === 'success' &&
          result.body.data.result.length === 1 &&
          Number(result.body.data.result[0].value[1]) === 5
        );
      },
      90_000,
    );
    await check(
      'authenticated Collector delta samples 2+3 query as cumulative 5 through Grafana',
    );
    const sourceKey = `stp_${token()}`,
      sourceId = randomUUID();
    await writeFile(join(privateDir, 'source-key'), sourceKey, {
      mode: 0o400,
      flag: 'wx',
    });
    report.sourceId = sourceId;
    const provision = await mutate(
      ports[0],
      '/v1/operator/sources',
      {
        ...operator,
        body: {
          id: sourceId,
          label: 'runtime-qualification',
          credentialHash: createHash('sha256').update(sourceKey).digest('hex'),
        },
      },
      'provision synthetic source',
    );
    assert.equal(provision.status, 201);
    const inventory = (await request(ports[0], '/health/live')).body
      .inventoryRevision;
    const now = new Date().toISOString();
    const batch = {
      schema_version: 1,
      inventory_revision: inventory,
      distinct_id: randomBytes(32).toString('hex'),
      events: [
        {
          event_id: randomUUID(),
          event: 'engine_turn',
          occurred_at: now,
          observed_at: now,
          build: { version: '9.8.7', platform: 'linux', arch: 'x64' },
          properties: { engine: 'codex', outcome: 'completed' },
        },
      ],
    };
    const first = await mutate(
      ports[0],
      '/v1/product/events',
      {
        key: sourceKey,
        body: batch,
      },
      'commit synthetic event',
    );
    assert.equal(first.status, 202);
    assert.equal(first.body.receipt.inserted, 1);
    const retry = await mutate(
      ports[0],
      '/v1/product/events',
      {
        key: sourceKey,
        body: batch,
      },
      'explicit replay dedupe control',
    );
    assert.equal(retry.status, 202);
    assert.equal(retry.body.receipt.inserted, 0);
    assert.equal(retry.body.receipt.alreadyPresent, 1);
    await check('synthetic source event committed and replay deduplicated');
    await docker(
      [...compose, 'stop', '--timeout', '15', 'receiver'],
      'stop receiver before fence',
    );
    const fence = JSON.parse(
      await docker(
        [
          ...compose,
          'run',
          '--rm',
          '--no-deps',
          'receiver',
          'node',
          'dist/main.mjs',
          '--fence-product-sources-after-restore',
        ],
        'fence copied source before serving',
      ),
    );
    assert.deepEqual(fence, {
      protocol: 'station-product-restore-fence/v1',
      scope: 'product-sources-only',
      revokedSources: 1,
      publisherState: 'unreconciled',
    });
    await docker(
      [...compose, 'start', '--wait', '--wait-timeout', '120', 'receiver'],
      'restart fenced receiver',
      150_000,
    );
    await poll(
      'fenced storage ready',
      async () =>
        (await request(ports[0], '/v1/operator/storage', operator)).status ===
        200,
    );
    assert.equal(
      (
        await request(
          ports[0],
          `/v1/product/receipts/${first.body.receipt.receiptId}`,
          { key: sourceKey },
        )
      ).status,
      401,
    );
    await check(
      'one-shot product fence completes before activation; copied key refused after restart',
    );
    report.state = 'passed';
  } catch {
    report.state = 'failed';
    report.failure =
      'A required runtime check failed; inspect private command logs and retained project before manual retry';
    throw new Error(report.failure);
  } finally {
    if (started) {
      try {
        const ids = (
          await docker(
            [
              'ps',
              '-aq',
              '--filter',
              `label=com.docker.compose.project=${project}`,
            ],
            'identify owned containers',
          )
        )
          .split(/\s+/)
          .filter(Boolean);
        assert(ids.length <= 7);
        for (const id of ids) {
          const [info] = JSON.parse(
            await docker(['inspect', id], 'verify container custody'),
          );
          assert.equal(
            info.Config.Labels['com.docker.compose.project'],
            project,
          );
        }
        if (ids.length)
          await docker(
            ['stop', '--time', '15', ...ids],
            'stop exact owned containers including one-shot',
            60_000,
          );
        assert.equal(
          await docker(
            [
              'ps',
              '-q',
              '--filter',
              `label=com.docker.compose.project=${project}`,
            ],
            'confirm no owned listener remains',
          ),
          '',
        );
        report.cleanup =
          'stopped; private credentials, candidate, image and volumes retained';
      } catch {
        report.cleanup = 'UNPROVEN; reconcile owned project before retry';
        report.state = 'failed';
      }
    }
    await save();
  }
  assert.equal(report.state, 'passed');
  return {
    report: join(output, 'report.json'),
    scope: report.scope,
    state: report.state,
    installationAuthority: false,
  };
}

if (invokedDirectly(import.meta.url)) {
  const [candidate, output, ...extra] = process.argv.slice(2);
  if (!candidate || !output || extra.length)
    throw new Error(
      'Usage: qualify-telemetry-companion.mjs <candidate> <new-private-output>',
    );
  process.stdout.write(
    `${JSON.stringify(await qualifyTelemetryCompanion(candidate, output))}\n`,
  );
}
