/**
 * #4521: the real server entrypoint started with all three capability
 * switches turned off by an injected managed policy (the test override).
 *
 * The child is given everything that would otherwise turn each capability
 * on: an OTel collector and a product telemetry destination (both a local
 * server that records every request), an enabled inbound webhook with a
 * valid token, and a local marketplace folder. Over HTTP it then reports the
 * switches in its summary, refuses each capability with the managed code,
 * and the collector receives nothing.
 */
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { MANAGED_POLICY_CAPABILITY_DISABLED_CODE } from '@kontourai/station-contracts/managed-policy';
import { afterEach, expect, test } from 'vitest';
import { localLabEnvironment } from '../../scripts/lib/local-collaboration-process.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../scripts/lib/owned-process.mjs';
import { trackTempDirs } from '../__test-utils__/temp-dirs.js';
import { ensureStationHomeSchemaSync } from '../domain/home-schema-gate.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const readyPrefix = '{"event":"listening",';
const secret = 'process-webhook-secret-32-chars-min';
const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function bounded<T>(promise: Promise<T>, label: string, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Records every request; stands in for the OTel collector and destination. */
async function collector() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

const limits = {
  telemetry: false,
  webhookAutomations: false,
  registries: {
    allowedUrls: ['https://approved.example.com/registry.json'],
    unsignedPackages: false,
    defaultSkillRegistries: false,
    acpRegistryInstalls: false,
  },
};

test('a server started with every capability switch off refuses each one', async () => {
  const sink = await collector();
  const root = makeTempDir('station-managed-switches-');
  chmodSync(root, 0o700);
  const home = join(root, 'home');
  const osHome = join(root, 'os-home');
  const temp = join(root, 'tmp');
  for (const dir of [osHome, temp])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A home the server accepts, so the webhook file can be written first.
  ensureStationHomeSchemaSync(home);
  mkdirSync(join(home, 'security'), { recursive: true, mode: 0o700 });
  const policyPath = join(root, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      schemaVersion: 1,
      organization: 'Acme',
      supportUrl: 'https://help.example/station',
      limits,
    }),
  );
  // Without the policy this token would start a turn.
  const webhookConfig = join(home, 'security', 'inbound-webhooks.json');
  writeFileSync(
    webhookConfig,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      tokens: [
        {
          id: 'ci',
          name: 'CI',
          secret,
          starts: [{ agentId: 'station' }],
        },
      ],
    }),
    { mode: 0o600 },
  );
  const skills = join(root, 'skills');
  mkdirSync(join(skills, 'clarify'), { recursive: true });
  writeFileSync(
    join(skills, 'clarify', 'SKILL.md'),
    '---\nname: clarify\ndescription: Clarify\n---\n\nBody',
  );

  const env = {
    ...localLabEnvironment(),
    TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json'),
    DOTENV_CONFIG_PATH: join(root, 'missing.env'),
    HOME: osHome,
    USERPROFILE: osHome,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CONFIG_HOME: join(osHome, 'config'),
    XDG_CACHE_HOME: join(osHome, 'cache'),
    STATION_HOME: home,
    STATION_ROOT: join(root, 'station-root'),
    STATION_HOST: '127.0.0.1',
    PORT: '0',
    STATION_INSTANCE: 'managed-switches-fixture',
    STATION_INSTANCE_ID: 'managed-switches-fixture',
    STATION_STDOUT_HANDSHAKE: '1',
    STATION_LOG_LEVEL: 'error',
    AWS_EC2_METADATA_DISABLED: 'true',
    // Everything that would turn telemetry on, Do Not Track off.
    OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
    STATION_PRODUCT_TELEMETRY_ENDPOINT: `${sink.url}/v1/product/events`,
    STATION_TELEMETRY_TIER: 'lite',
    DO_NOT_TRACK: '',
    STATION_MANAGED_POLICY_TEST_FILE: policyPath,
  } as Record<string, string>;
  delete env.OTEL_SDK_DISABLED;

  const owned = executeOwnedCommand(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      join(repoRoot, 'src-server/index.ts'),
    ],
    spawn,
    'managed-switches Station',
    {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
  const capture = captureOwnedProcessOutput(owned, { maxBytes: 512 * 1024 });
  cleanups.push(async () => {
    const result = await terminateSuiteExecution(owned, {
      waitForSuiteSettlement,
      terminationGraceMs: 15_000,
      terminationForceMs: 5_000,
      processLabel: 'managed-switches Station',
    });
    capture.finish();
    expect(result.errors).toEqual([]);
  });
  const child = owned.child;
  if (!('stdout' in child) || !child.stdout) throw new Error('no stdout');
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });
  let pending = '';
  const ready = new Promise<number>((resolveReady) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines)
        if (line.startsWith(readyPrefix))
          resolveReady(JSON.parse(line).port as number);
    });
  });
  const early = owned.completion.then((result) => {
    throw new Error(
      `Station exited before listening (${result.status}): ${stderrTail}`,
    );
  });
  void early.catch(() => {});
  const port = await bounded(Promise.race([ready, early]), 'ready', 150_000);
  const apiBase = `http://127.0.0.1:${port}`;

  const grant = await fetch(
    `${apiBase}/.well-known/station/v1/pairing/local-grant`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: readFileSync(
          join(home, 'runtime/local-grant.secret'),
          'utf8',
        ).trim(),
        deviceName: 'managed-switches-test',
        clientInstanceId: randomUUID(),
      }),
    },
  );
  const grantText = await grant.text();
  expect(grant.status, grantText).toBe(200);
  const { credential } = JSON.parse(grantText) as { credential: string };
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  const managedRefusal = async (response: Response, subject: string) => {
    const text = await response.text();
    expect(response.status, text).toBe(403);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.code).toBe(MANAGED_POLICY_CAPABILITY_DISABLED_CODE);
    expect(String(body.error ?? body.message)).toContain(
      `Acme's policy manages ${subject}`,
    );
  };

  // The summary exposes the switches.
  const summary = (await (
    await api('/api/settings/managed-policy')
  ).json()) as {
    data: { summary: { limits: unknown } };
  };
  expect(summary.data.summary.limits).toEqual(limits);

  // Telemetry: every publisher is off for the policy, the OTel bootstrap
  // registered nothing, and a connection check contacts nothing.
  const status = (await (await api('/api/usage-telemetry/status')).json()) as {
    data: { publishers: Record<string, { tier: string; reason: string }> };
  };
  for (const publisher of ['kontour', 'operator'])
    expect(status.data.publishers[publisher]).toMatchObject({
      tier: 'off',
      reason: 'managed',
    });
  const delivery = (await (
    await api('/api/usage-telemetry/delivery-status')
  ).json()) as { data: { otel: { managedDenial?: string; phase: string } } };
  expect(delivery.data.otel.managedDenial).toContain(
    "Acme's policy manages telemetry",
  );
  await managedRefusal(
    await api('/api/usage-telemetry/connection-checks/otel', {
      method: 'POST',
    }),
    'telemetry',
  );
  await managedRefusal(
    await api('/config/app', {
      method: 'PUT',
      body: JSON.stringify({ telemetryTier: { operator: 'full' } }),
    }),
    'usage sharing',
  );

  // Webhooks: a correctly signed request is refused; the file is kept.
  const payload = JSON.stringify({ agent: 'station', message: 'Check CI.' });
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('base64url');
  await managedRefusal(
    await fetch(`${apiBase}/api/webhooks/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-station-webhook-token': 'ci',
        'x-station-webhook-timestamp': ts,
        'x-station-webhook-nonce': nonce,
        'x-station-webhook-signature': `sha256=${createHmac('sha256', secret)
          .update(`${ts}\n${nonce}\n${payload}`)
          .digest('hex')}`,
      },
      body: payload,
    }),
    'webhook automations',
  );
  expect(JSON.parse(readFileSync(webhookConfig, 'utf8')).enabled).toBe(true);

  // Registries: a marketplace outside the allow list cannot be added.
  await managedRefusal(
    await api('/api/registry/sources', {
      method: 'POST',
      body: JSON.stringify({
        displayName: 'Local skills folder',
        adapter: 'directory',
        location: skills,
      }),
    }),
    'this marketplace',
  );

  // Nothing reached the collector, OTel or product telemetry.
  expect(sink.requests).toEqual([]);
}, 300_000);
