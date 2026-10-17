import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  type ProductTelemetryBatch,
  type StationDailyPing,
  TELEMETRY_OUTBOX_LIMITS,
  type TelemetryOutboxEntry,
} from '@kontourai/station-contracts/product-telemetry';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  LITE_TELEMETRY_INVENTORY_REVISION,
  parseStationDailyPing,
} from '@kontourai/station-shared/product-telemetry';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createUsageTelemetryDisclosureRoutes } from '../../routes/operations/usage-telemetry-disclosure.js';
import { createLogger } from '../../utils/logger.js';
import { UsageTelemetryService } from '../usage-telemetry-service.js';

const build = vi.hoisted(() => ({
  endpoint: '',
}));
vi.mock('../../domain/telemetry-build-constants.js', () => ({
  get STATION_AUTHOR_TELEMETRY_ENDPOINT() {
    return build.endpoint;
  },
}));
const makeTempDir = trackTempDirs();
const services: UsageTelemetryService[] = [];
const servers: Server[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-12T10:00:00Z');
  build.endpoint = '';
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function receiver(hold?: Promise<void>) {
  let received!: () => void;
  const entered = new Promise<void>((resolve) => {
    received = resolve;
  });
  const payloads: unknown[] = [];
  const headers: Array<string | undefined> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    payloads.push(payload);
    received();
    await hold;
    headers.push(request.headers['x-api-key'] as string | undefined);
    const batch = payload as ProductTelemetryBatch;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        batch.events
          ? {
              receipt: {
                protocol: 'station-product-commit/v1',
                receiptId: '11111111-2222-4333-8444-555555555555',
                sourceId: '22222222-2222-4333-8444-555555555555',
                eventIds: batch.events.map((event) => event.event_id),
                inserted: batch.events.length,
                alreadyPresent: 0,
                storedAt: new Date().toISOString(),
              },
            }
          : {},
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Receiver did not bind TCP');
  return {
    entered,
    endpoint: `http://127.0.0.1:${address.port}/v1/product/events`,
    payloads,
    headers,
  };
}
async function service(
  endpoint: string,
  config: Partial<AppConfig> = {},
  env: NodeJS.ProcessEnv = {},
  existingHome?: string,
  loggerOverride?: ConstructorParameters<
    typeof UsageTelemetryService
  >[0]['logger'],
  fetchOverride?: typeof globalThis.fetch,
) {
  const home = existingHome ?? makeTempDir('station-publishers-');
  const logger = loggerOverride ?? { warn: vi.fn() };
  const configValue: AppConfig = {
    defaultModel: 'fixture',
    invokeModel: 'fixture',
    structureModel: 'fixture',
    productTelemetryEndpoint: endpoint,
    telemetryTier: { operator: 'lite', kontour: 'lite' },
    ...config,
  };
  const live = new UsageTelemetryService({
    homeDir: home,
    appConfig: configValue,
    version: '1.2.3',
    env,
    logger,
    fetch: fetchOverride,
    headless: env.STATION_STDOUT_HANDSHAKE !== '1' && !env.STATION_UI_PORT,
  });
  services.push(live);
  return { live, home, config: configValue };
}
async function flush(live: UsageTelemetryService) {
  await live.flushDaily();
  await live.flush();
}
function daily(payloads: unknown[]) {
  return payloads.filter(
    (payload): payload is StationDailyPing =>
      !!payload &&
      typeof payload === 'object' &&
      'event' in payload &&
      payload.event === 'station_daily',
  );
}

test('persists one daily attempt across simultaneous flushes and a real service restart', async () => {
  const sink = await receiver();
  const { live, home } = await service(sink.endpoint);
  await live.stationStarted();
  await live.track('client_connected', {
    surface: 'web',
    device_class: 'other',
    version: 'custom',
  });
  await live.track('engine_turn', { engine: 'codex', outcome: 'completed' });
  await Promise.all([flush(live), flush(live)]);
  const reopened = await service(sink.endpoint, {}, {}, home);
  await reopened.live.stationStarted();
  await flush(reopened.live);
  expect(daily(sink.payloads)).toHaveLength(1);
  const ping = parseStationDailyPing(daily(sink.payloads)[0]);
  expect(ping.surfaces_today).toEqual(['web']);
  expect(ping.engines_used_today).toEqual(['codex']);
  expect(ping.first_active_this_week).toBe(true);
  expect(ping.first_active_this_month).toBe(true);
  expect(Object.keys(ping)).not.toContain('distinct_id');
  await expect(
    access(join(home, 'config', 'usage-telemetry-id')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  const persisted = JSON.parse(
    await readFile(join(home, 'config', 'telemetry-daily.json'), 'utf8'),
  );
  expect(persisted.firstRun).toBe('2026-10-12');
  expect(persisted.lastActiveDay).toBe('2026-10-12');
  expect(
    (await stat(join(home, 'config', 'telemetry-daily.json'))).size,
  ).toBeLessThan(16 * 1024);
  vi.setSystemTime('2026-10-13T10:00:00Z');
  await flush(reopened.live);
  vi.setSystemTime('2026-10-12T10:00:00Z');
  await flush(reopened.live);
  expect(daily(sink.payloads)).toHaveLength(2);
});

test('catches up only the latest observed unsent day, preserves weekly and monthly flags', async () => {
  const sink = await receiver();
  const { live, home } = await service(sink.endpoint);
  await live.stationStarted();
  await live.track('engine_turn', { engine: 'claude', outcome: 'failed' });
  await live.shutdown();
  vi.setSystemTime('2026-10-13T10:00:00Z');
  const next = await service(sink.endpoint, {}, {}, home);
  await next.live.stationStarted();
  await flush(next.live);
  expect(daily(sink.payloads)).toHaveLength(1);
  expect(daily(sink.payloads)[0].engines_used_today).toEqual(['claude']);
  await flush(next.live);
  expect(daily(sink.payloads)).toHaveLength(1);
  vi.setSystemTime('2026-11-02T10:00:00Z');
  await next.live.stationStarted();
  await next.live.track('engine_turn', {
    engine: 'ollama',
    outcome: 'completed',
  });
  await flush(next.live);
  expect(daily(sink.payloads)).toHaveLength(2);
  expect(daily(sink.payloads)[1].engines_used_today).not.toContain('claude');
});

test.each([
  [undefined, undefined, 'source-checkout'],
  ['beta', 'nightly', 'preview'],
  ['stable', 'dev', 'stable'],
  [undefined, 'nightly', 'nightly'],
  ['private-build-label', undefined, 'source-checkout'],
] as const)(
  'daily channel serializes captured build stamp %s and environment fallback %s as %s',
  async (channel, fallback, expected) => {
    vi.stubGlobal('__STATION_SERVER_BUILD__', { channel });
    const sink = await receiver();
    const { live } = await service(
      sink.endpoint,
      {},
      { STATION_CHANNEL: fallback },
    );
    await live.stationStarted();
    await flush(live);
    expect(daily(sink.payloads)[0].channel).toBe(expected);
  },
);

test('keeps author inert with an empty build constant even when runtime environment supplies one', async () => {
  const operator = await receiver();
  const forbiddenAuthor = await receiver();
  const { live } = await service(
    operator.endpoint,
    {},
    { STATION_AUTHOR_TELEMETRY_ENDPOINT: forbiddenAuthor.endpoint },
  );
  await live.stationStarted();
  await flush(live);
  expect(daily(operator.payloads)).toHaveLength(1);
  expect(forbiddenAuthor.payloads).toEqual([]);
  expect(
    (await live.outbox('kontour')).some(
      (row) => row.tier === 'lite' && row.reason === 'unconfigured',
    ),
  ).toBe(true);
});

test('independent sinks honor their own tier and never share operator credentials', async () => {
  const author = await receiver();
  const operator = await receiver();
  build.endpoint = author.endpoint;
  const { live, config } = await service(
    operator.endpoint,
    { productTelemetryEndpoint: undefined },
    {
      STATION_PRODUCT_TELEMETRY_KEY: 'operator-only',
      STATION_PRODUCT_TELEMETRY_ENDPOINT: operator.endpoint,
    },
  );
  await live.stationStarted();
  await flush(live);
  expect(daily(author.payloads)).toHaveLength(1);
  expect(daily(operator.payloads)).toHaveLength(1);
  expect(author.headers).toEqual([undefined]);
  expect(operator.headers).toEqual([undefined]);
  expect(daily(author.payloads)[0].event_id).not.toBe(
    daily(operator.payloads)[0].event_id,
  );
  live.reconfigure({
    ...config,
    telemetryTier: { kontour: 'off', operator: 'lite' },
  });
  vi.setSystemTime('2026-10-13T10:00:00Z');
  await flush(live);
  expect(daily(author.payloads)).toHaveLength(1);
  expect(daily(operator.payloads)).toHaveLength(2);
  live.reconfigure({
    ...config,
    telemetryTier: { kontour: 'lite', operator: 'off' },
  });
  vi.setSystemTime('2026-10-14T10:00:00Z');
  await flush(live);
  expect(daily(author.payloads)).toHaveLength(2);
  expect(daily(operator.payloads)).toHaveLength(2);
});

test.each(['kontour', 'operator'] as const)(
  'changing the other publisher does not abort %s delivery already in flight',
  async (retained) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const author = await receiver(retained === 'kontour' ? hold : undefined);
    const operator = await receiver(retained === 'operator' ? hold : undefined);
    build.endpoint = author.endpoint;
    const { live, config } = await service(operator.endpoint);
    await live.stationStarted();
    const flushing = flush(live);
    try {
      await (retained === 'kontour' ? author.entered : operator.entered);
      live.reconfigure({
        ...config,
        telemetryTier:
          retained === 'kontour'
            ? { kontour: 'lite', operator: 'off' }
            : { kontour: 'off', operator: 'lite' },
      });
    } finally {
      release();
    }
    await flushing;
    expect(
      (await live.outbox(retained)).some(
        (row) => row.tier === 'lite' && row.outcome === 'sent',
      ),
    ).toBe(true);
  },
);

test('never sends a Full event at Lite; Full needs its own receipt and uses the monthly ID', async () => {
  const sink = await receiver();
  const { live, home, config } = await service(sink.endpoint);
  await live.stationStarted();
  await live.acknowledgeDisclosure((await live.disclosure()).inventoryRevision);
  await live.track('plugin_installed', { plugin: 'custom' });
  await flush(live);
  expect(
    sink.payloads.every((payload) => !('events' in (payload as object))),
  ).toBe(true);
  expect(
    (await live.outbox('operator')).some(
      (row) =>
        row.tier === 'full' &&
        row.outcome === 'dropped' &&
        row.reason === 'disclosure',
    ),
  ).toBe(true);
  await live.acknowledgeDisclosure((await live.disclosure()).inventoryRevision);
  live.reconfigure({
    ...config,
    telemetryTier: { operator: 'full', kontour: 'full' },
  });
  await live.track('plugin_removed', { plugin: 'custom' });
  await flush(live);
  const batches = sink.payloads.filter(
    (payload): payload is ProductTelemetryBatch =>
      !!payload && typeof payload === 'object' && 'events' in payload,
  );
  expect(batches).toHaveLength(1);
  expect(
    batches[0].events.some((event) => event.event === 'plugin_removed'),
  ).toBe(true);
  expect(batches[0].distinct_id).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (await live.outbox('operator')).some(
      (row) => row.tier === 'full' && row.outcome === 'sent',
    ),
  ).toBe(true);
  expect(
    await readFile(join(home, 'config', 'usage-telemetry-id'), 'utf8'),
  ).not.toContain(batches[0].distinct_id);
});

test('author Full consent is separate, destination-bound, and does not inherit operator credentials', async () => {
  const author = await receiver();
  const operator = await receiver();
  build.endpoint = author.endpoint;
  const { live, home } = await service(
    operator.endpoint,
    {
      productTelemetryEndpoint: undefined,
      telemetryTier: { operator: 'full', kontour: 'full' },
    },
    {
      STATION_PRODUCT_TELEMETRY_ENDPOINT: operator.endpoint,
      STATION_PRODUCT_TELEMETRY_KEY: 'operator-only',
    },
  );
  await live.stationStarted();
  await live.acknowledgeDisclosure((await live.disclosure()).inventoryRevision);
  expect((await live.telemetryStatus()).publishers.kontour.tier).toBe('lite');
  const app = createUsageTelemetryDisclosureRoutes(live);
  const shown = (await (
    await app.request('/disclosure?publisher=kontour')
  ).json()) as { data: { destination: string; inventoryRevision: string } };
  expect(shown.data.destination).toBe(author.endpoint);
  const acknowledge = (destination: string) =>
    app.request('/disclosure/acknowledgements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publisher: 'kontour',
        destination,
        inventoryRevision: shown.data.inventoryRevision,
        acknowledgementProtocol: 2,
      }),
    });
  expect((await acknowledge(operator.endpoint)).status).toBe(409);
  expect((await acknowledge(author.endpoint)).status).toBe(200);
  expect((await live.telemetryStatus()).publishers.kontour.tier).toBe('full');
  const disclosed = await live.disclosure('kontour');
  expect(disclosed.telemetryEnabled).toBe(true);
  expect(disclosed.enabledSource).toBe('config');
  expect(disclosed.publishers).toMatchObject({
    kontour: { tier: 'full', source: 'config', userChoice: 'full' },
    operator: { tier: 'full', source: 'config', userChoice: 'full' },
  });
  await live.track('plugin_installed', { plugin: 'custom' });
  await live.flush();
  expect(author.headers).toEqual([undefined]);
  expect(operator.headers).toEqual(['operator-only']);
  expect(author.payloads).toHaveLength(1);
  expect((author.payloads[0] as ProductTelemetryBatch).distinct_id).toMatch(
    /^[a-f0-9]{64}$/,
  );
  await live.submitFeedback({
    publisher: 'operator',
    action: 'tier-lowered',
    reason: 'privacy',
  });
  expect(operator.headers).toEqual(['operator-only', undefined]);
  const receiptPath = join(
    home,
    'config',
    'usage-telemetry-disclosure-kontour.json',
  );
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  expect(receipt).toMatchObject({
    publisher: 'kontour',
    destination: author.endpoint,
  });
  await writeFile(
    receiptPath,
    JSON.stringify({ ...receipt, destination: operator.endpoint }),
  );
  expect((await live.telemetryStatus()).publishers.kontour).toMatchObject({
    tier: 'lite',
    reason: 'disclosure',
  });
});

test.each(['kontour', 'operator'] as const)(
  'changing the other publisher does not fence %s Full delivery',
  async (retained) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const author = await receiver(retained === 'kontour' ? hold : undefined);
    const operator = await receiver(retained === 'operator' ? hold : undefined);
    build.endpoint = author.endpoint;
    const { live, config } = await service(operator.endpoint, {
      telemetryTier: { operator: 'full', kontour: 'full' },
    });
    await live.stationStarted();
    const revision = (await live.disclosure()).inventoryRevision;
    await live.acknowledgeDisclosure(revision);
    await live.acknowledgeDisclosure(revision, 'kontour', author.endpoint);
    await live.track('plugin_removed', { plugin: 'custom' });
    const flushing = live.flush();
    try {
      await (retained === 'kontour' ? author.entered : operator.entered);
      live.reconfigure({
        ...config,
        telemetryTier:
          retained === 'kontour'
            ? { kontour: 'full', operator: 'off' }
            : { kontour: 'off', operator: 'full' },
      });
    } finally {
      release();
    }
    await flushing;
    expect(
      (await live.outbox(retained)).some(
        (row) => row.tier === 'full' && row.outcome === 'sent',
      ),
    ).toBe(true);
  },
);

test('shutdown aborts a pending daily request and records its dropped outcome before returning', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sink = await receiver(hold);
  const { live } = await service(sink.endpoint);
  await live.stationStarted();
  const flushing = live.flushDaily();
  try {
    await sink.entered;
    await live.shutdown();
    await flushing;
  } finally {
    release();
  }
  expect(
    (await live.outbox('operator')).some(
      (row) =>
        row.tier === 'lite' &&
        row.reason === 'transport' &&
        row.outcome === 'dropped',
    ),
  ).toBe(true);
});

test('shared shutdown abort reaches Full while the daily ledger publication is contended', async () => {
  let releaseReceiver!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseReceiver = resolve;
  });
  const sink = await receiver(hold);
  let fullSignal: AbortSignal | undefined;
  const observeFetch: typeof globalThis.fetch = (input, init) => {
    if (typeof init?.body === 'string' && 'events' in JSON.parse(init.body))
      fullSignal = init.signal ?? undefined;
    return globalThis.fetch(input, init);
  };
  const { live, home } = await service(
    sink.endpoint,
    { telemetryTier: { operator: 'full', kontour: 'lite' } },
    {},
    undefined,
    undefined,
    observeFetch,
  );
  await live.acknowledgeDisclosure((await live.disclosure()).inventoryRevision);
  await live.stationStarted();
  const releaseLedger = await acquireFileMutationLockAsync(
    join(home, 'config', 'telemetry-outbox.json.mutation'),
  );
  const fullFlush = live.flush();
  let dailyFlush: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await sink.entered;
    dailyFlush = live.flushDaily();
    await vi.waitFor(() => expect(daily(sink.payloads)).toHaveLength(1));
    const budget = new AbortController();
    stopping = live.shutdown(budget.signal);
    expect(
      fullSignal?.aborted,
      'the Full request must still be pending before budget expiry',
    ).toBe(false);
    budget.abort();
    expect(
      fullSignal?.aborted,
      'local ledger contention cannot delay the shared network abort',
    ).toBe(true);
  } finally {
    await releaseLedger();
    releaseReceiver();
    await Promise.all([fullFlush, dailyFlush, stopping]);
  }
});

test('DNT suppresses every publisher, including explicit feedback', async () => {
  const sink = await receiver();
  build.endpoint = sink.endpoint;
  const { live } = await service(sink.endpoint, {}, { DO_NOT_TRACK: 'yes' });
  await live.stationStarted();
  await flush(live);
  await live.submitFeedback({
    publisher: 'operator',
    action: 'tier-lowered',
    reason: 'privacy',
  });
  expect(sink.payloads).toEqual([]);
  expect((await live.outbox()).every((row) => row.reason === 'DNT')).toBe(true);
});

test('notice is recorded once per inventory and desktop/web must record the shown revision before Lite', async () => {
  vi.stubEnv('STATION_LOG_LEVEL', 'error');
  vi.stubEnv('STATION_STDOUT_LOGS', '0');
  const diagnostics = createLogger({
    name: 'telemetry-notice-test',
    level: 'error',
  });
  const stderr = vi.spyOn(process.stderr, 'write');
  expect(diagnostics.getLevel()).toBe('error');
  const noticeCalls = () =>
    stderr.mock.calls.filter(([message]) =>
      String(message).includes('Lite sends'),
    );
  const sink = await receiver();
  const { live, home } = await service(
    sink.endpoint,
    {},
    {},
    undefined,
    diagnostics,
  );
  await live.stationStarted();
  await live.stationStarted();
  expect(noticeCalls()).toHaveLength(2);
  const next = await service(sink.endpoint, {}, {}, home, diagnostics);
  await next.live.stationStarted();
  expect(noticeCalls()).toHaveLength(2);
  const ui = await service(
    sink.endpoint,
    {},
    { STATION_STDOUT_HANDSHAKE: '1' },
  );
  await ui.live.stationStarted();
  await flush(ui.live);
  expect(sink.payloads).toEqual([]);
  expect(
    (await ui.live.outbox('operator')).some((row) => row.reason === 'notice'),
  ).toBe(true);
  await ui.live.recordLiteNotice('operator', LITE_TELEMETRY_INVENTORY_REVISION);
  vi.setSystemTime('2026-10-13T10:00:00Z');
  await flush(ui.live);
  expect(daily(sink.payloads)).toHaveLength(1);
});

test('feedback route rejects free text, targets one publisher, skips silently, and filters outbox', async () => {
  const operator = await receiver();
  const author = await receiver();
  build.endpoint = author.endpoint;
  const { live } = await service(operator.endpoint);
  const app = createUsageTelemetryDisclosureRoutes(live);
  const submit = (body: unknown) =>
    app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect(
    (
      await submit({
        publisher: 'operator',
        action: ['tier-lowered'],
        reason: 'privacy',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await submit({
        publisher: ['operator'],
        action: 'tier-lowered',
        reason: 'privacy',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await submit({
        publisher: 'operator',
        action: 'tier-lowered',
        reason: 'private free text',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await submit({
        publisher: 'operator',
        action: 'tier-lowered',
        reason: 'privacy',
        id: 'forbidden',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await submit({
        publisher: 'operator',
        action: 'tier-lowered',
        reason: 'privacy',
      })
    ).status,
  ).toBe(200);
  expect(operator.payloads).toEqual([
    { publisher: 'operator', action: 'tier-lowered', reason: 'privacy' },
  ]);
  expect(author.payloads).toEqual([]);
  await submit({
    publisher: 'kontour',
    action: 'plugin-uninstalled',
    reason: 'skip',
  });
  expect(author.payloads).toEqual([]);
  const result = await app.request('/outbox?publisher=operator');
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  const body = await result.json();
  expect(body).toMatchObject({
    success: true,
    data: [{ publisher: 'operator', payload: { reason: 'privacy' } }],
  });
  expect(body).toHaveProperty('data.length', 1);
  expect((await app.request('/outbox?publisher=private-name')).status).toBe(
    400,
  );
});

test('outbox evicts oldest entries at both the 30-day and actual serialized 5 MiB bounds', async () => {
  const sink = await receiver();
  const { live, home } = await service(sink.endpoint);
  await live.stationStarted();
  await flush(live);
  const outboxPath = join(home, 'config', 'telemetry-outbox.json');
  const produced: TelemetryOutboxEntry[] = JSON.parse(
    await readFile(outboxPath, 'utf8'),
  );
  const sample = produced.find((row) => row.tier === 'lite');
  if (!sample) throw new Error('Daily writer did not produce a ledger row');
  const expired = { ...sample, recordedAt: '2026-09-01T00:00:00.000Z' };
  const rows: TelemetryOutboxEntry[] = [expired];
  // Start below the actual writer bound, using its exact persisted row shape.
  const rowBytes =
    Buffer.byteLength(
      JSON.stringify(sample, null, 2)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    ) + 2;
  const count = Math.floor(
    (TELEMETRY_OUTBOX_LIMITS.maxBytes - 2048) / rowBytes,
  );
  for (let index = 0; index < count; index++)
    rows.push({
      ...sample,
      recordedAt: new Date(
        Date.parse('2026-10-11T00:00:00Z') + index,
      ).toISOString(),
    });
  await writeFile(outboxPath, JSON.stringify(rows, null, 2));
  // Appending multiple legitimate feedback payloads crosses the size bound.
  for (let index = 0; index < 12; index++)
    await live.submitFeedback({
      publisher: 'operator',
      action: 'tier-lowered',
      reason: 'privacy',
    });
  expect((await stat(outboxPath)).size).toBeLessThanOrEqual(
    TELEMETRY_OUTBOX_LIMITS.maxBytes,
  );
  const retained = await live.outbox();
  expect(retained.some((row) => row.recordedAt === expired.recordedAt)).toBe(
    false,
  );
  expect(retained.some((row) => row.recordedAt === rows[1].recordedAt)).toBe(
    false,
  );
  expect(retained.at(-1)?.payload).toEqual({
    publisher: 'operator',
    action: 'tier-lowered',
    reason: 'privacy',
  });
});
