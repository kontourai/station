import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { RegistryPackageClaim } from '@kontourai/station-contracts/registry-trust';
import { createPluginTelemetry } from '@kontourai/station-sdk/client';
import { parsePluginDailyPing } from '@kontourai/station-shared/plugin-telemetry';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchema } from '../../../domain/home-schema-gate.js';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import { replacePluginProvidersForSource } from '../../../providers/registries/registry.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { installPluginFromSource } from '../../../services/plugins/plugin-install-transaction.js';
import { readPluginManifestFile } from '../../../services/plugins/plugin-manifest-loader.js';
import { registryPackageSignaturePayload } from '../../../services/plugins/registry-supply-chain.js';
import { createLocalRegistryTrustPolicyAuthority } from '../../../services/plugins/registry-trust-policy.js';
import { UsageTelemetryService } from '../../../services/usage-telemetry-service.js';
import { createLogger } from '../../../utils/logger.js';
import { registerPluginInstallRoutes } from '../../plugins/plugin-install-routes.js';
import { registerPluginLifecycleRoutes } from '../../plugins/plugin-lifecycle-routes.js';
import { createTelemetryRoutes } from '../telemetry-events.js';
import { createUsageTelemetryDisclosureRoutes } from '../usage-telemetry-disclosure.js';

const makeTempDir = trackTempDirs();
const cleanups: Array<() => void | Promise<void>> = [];
const id = 'publisher:telemetry-writer';
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await replacePluginProvidersForSource('telemetry-fixture', []);
});
async function fixture(
  options: { unsigned?: boolean; private?: boolean } = {},
) {
  const directory = makeTempDir('station-publisher-test-');
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });
  const source = join(directory, 'writer');
  mkdirSync(source);
  writeFileSync(
    join(source, 'plugin.json'),
    readFileSync(new URL('./fixtures/telemetry-plugin.json', import.meta.url)),
  );
  await ensureStationHomeSchema(home);
  mkdirSync(join(home, 'plugins'), { recursive: true });
  const store = new EventStore(join(home, 'events.sqlite'));
  cleanups.push(() => {
    store.close();
  });
  const journal = store.createPackageMcpAdmissionJournal();
  const loader = new ConfigLoader({ projectHomeDir: home });
  const catalogPath = join(directory, 'registry.json');
  const catalog = new JsonManifestRegistryProvider(catalogPath, home);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config: AppConfig = {
    defaultModel: 'fixture',
    invokeModel: 'fixture',
    structureModel: 'fixture',
    publicTelemetryRegistries: options.private ? [] : [catalog.registryKey],
    registryTrust: {
      profiles: [
        {
          registryKey: catalog.registryKey,
          signatures: 'optional',
          trustedEd25519Keys: {
            fixture: publicKey
              .export({ type: 'spki', format: 'pem' })
              .toString(),
          },
        },
      ],
    },
  };
  await loader.mutateAppConfig(() => config);
  const trustPolicy = createLocalRegistryTrustPolicyAuthority(
    home,
    store.createRegistryTrustPolicyDecisions(),
  );
  await trustPolicy.publishApplied(
    await trustPolicy.captureApplication(),
    config.registryTrust!,
  );
  const logger = createLogger({ name: 'telemetry-test', level: 'warn' });
  const deps = {
    projectHomeDir: home,
    pluginsDir: join(home, 'plugins'),
    agentsDir: join(home, 'agents'),
    packageMcpJournal: journal,
    registryTrustPolicyAuthority: trustPolicy,
    logger,
    buildPlugin: async () => {},
  };
  const previewApp = new Hono();
  registerPluginInstallRoutes(previewApp, {
    ...deps,
    projectVisiblePlugins: () => (installed) => installed,
  });
  // Obtain the source digest through the real preview. This is then signed by the fixture registry.
  const initial = await previewApp.request('/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  const preview = (await initial.json()) as {
    valid: boolean;
    contentDigest: string;
    permissions: { required: string[] };
    registryTrust?: { revision: string };
  };
  expect(preview.valid, JSON.stringify(preview)).toBe(true);
  const plain: RegistryPackageClaim = {
    packageSchema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    registryId: 'telemetry-writer',
    registryKey: catalog.registryKey,
    pluginName: 'telemetry-writer',
    packageVersion: '1.0.0',
    source,
    packageDigest: preview.contentDigest,
  };
  const claim: RegistryPackageClaim = options.unsigned
    ? plain
    : {
        ...plain,
        signature: {
          algorithm: 'ed25519',
          keyId: 'fixture',
          value: sign(
            null,
            registryPackageSignaturePayload(plain),
            privateKey,
          ).toString('base64'),
        },
      };
  writeFileSync(
    catalogPath,
    JSON.stringify({
      version: 1,
      plugins: [
        {
          id: 'telemetry-writer',
          source,
          displayName: 'Writer',
          version: '1.0.0',
          claim,
        },
      ],
    }),
  );
  await replacePluginProvidersForSource('telemetry-fixture', [
    { type: 'pluginRegistry', provider: catalog, source: 'telemetry-fixture' },
  ]);
  const registryPreview = await previewApp.request('/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ registryId: 'telemetry-writer' }),
  });
  const reviewed = (await registryPreview.json()) as {
    valid: boolean;
    contentDigest: string;
    registryTrust?: { revision: string };
    permissions: { required: string[] };
    registryTrustRevision?: string;
  };
  expect(reviewed.valid, JSON.stringify(reviewed)).toBe(true);
  const install = () =>
    installPluginFromSource(source, [], deps, {
      registryId: 'telemetry-writer',
      registryKey: catalog.registryKey,
      consent: {
        kind: 'operator-decision',
        contentDigest: reviewed.contentDigest,
        permissions: reviewed.permissions.required,
        dependencies: [],
        registryTrustRevision:
          reviewed.registryTrust?.revision ?? reviewed.registryTrustRevision,
      },
    });
  const received: unknown[] = [];
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    expect(req.headers.authorization).toBeUndefined();
    res.writeHead(202).end();
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, '127.0.0.1', resolve),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = receiver.address();
  if (!address || typeof address === 'string')
    throw new Error('Receiver not listening');
  const env = { STATION_STDOUT_HANDSHAKE: '1', DO_NOT_TRACK: '' };
  let nextSend: { started: () => void; wait: Promise<void> } | undefined;
  const pauseNextSend = () => {
    let started!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    nextSend = { started, wait };
    return { arrived, release };
  };
  const receiverFetch = globalThis.fetch;
  const serviceOptions: ConstructorParameters<typeof UsageTelemetryService>[0] =
    {
      homeDir: home,
      appConfig: config,
      version: '1.0.0',
      env,
      logger,
      pluginTelemetry: { homeDir: home, journal, trustPolicy },
      // Preserve the declared HTTPS admission boundary; only test transport is mapped to the loopback receiver.
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://publisher.example.test/counts');
        const queued = nextSend;
        nextSend = undefined;
        if (queued) {
          queued.started();
          await queued.wait;
        }
        return receiverFetch(`http://127.0.0.1:${address.port}/`, init);
      },
    };
  let service = new UsageTelemetryService(serviceOptions);
  const restart = async () => {
    await service.shutdown();
    service = new UsageTelemetryService(serviceOptions);
    await service.stationStarted();
  };
  cleanups.push(() => service.shutdown());
  const app = new Hono();
  app.route(
    '/api/telemetry',
    createTelemetryRoutes(() => service),
  );
  app.route(
    '/api/usage-telemetry',
    createUsageTelemetryDisclosureRoutes(() => service),
  );
  registerPluginLifecycleRoutes(app, {
    ...deps,
    onTelemetryRemoval: (publisher, reason) =>
      service.pluginUninstalled(publisher, reason),
  });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-station-plugin': 'telemetry-writer',
      },
      body: JSON.stringify(body),
    });
  const count = (
    event = 'opened',
    attributes: Record<string, string | number> = { surface: 'main', items: 2 },
  ) => post('/api/telemetry/events', { events: [{ event, attributes }] });
  return {
    pauseNextSend,
    restart,
    home,
    source,
    config,
    env,
    get service() {
      return service;
    },
    app,
    deps,
    received,
    install,
    count,
    post,
    declaration: (await readPluginManifestFile(join(source, 'plugin.json')))
      .telemetry!,
  };
}

test('real signed install and kernel route reject undeclared events, props and values before admitting a batch', async () => {
  const f = await fixture();
  await f.install();
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
    f.app.request(input, init),
  );
  const telemetry = createPluginTelemetry(
    'https://station.example.test',
    'telemetry-writer',
  );
  await telemetry.count('opened', { surface: 'main', items: 2 });
  await expect(telemetry.count('undeclared')).rejects.toThrow(/rejected/);
  for (const [event, props] of [
    ['unknown', {}],
    ['opened', { surface: 'main', items: 1, private_text: 'secret' }],
    ['opened', { surface: 'secret', items: 1 }],
    ['opened', { surface: 'main', items: 65536 }],
    ['opened', {}],
  ] as const)
    expect((await f.count(event, props)).status, event).toBe(400);
  expect(f.received).toEqual([]);
  expect((await f.post('/api/telemetry/events', { events: [] })).status).toBe(
    400,
  );
});

test.each([{ unsigned: true }, { private: true }])(
  'installation rejects telemetry from unqualified registry %j',
  async (options) => {
    const f = await fixture(options);
    await expect(f.install()).rejects.toThrow(
      /telemetry requires.*public registry.*verified signature/,
    );
    expect(existsSync(join(f.home, 'plugins', 'telemetry-writer'))).toBe(false);
  },
);

test('publisher policy only lowers defaults, and a user choice wins downward through status and DNT', async () => {
  const f = await fixture();
  await f.install();
  for (const policy of ['full', 'lite', 'off'] as const) {
    f.service.reconfigure({
      ...f.config,
      telemetryPublisherPolicy: { [id]: policy },
    });
    expect((await f.service.telemetryStatus()).publishers[id].tier).toBe(
      policy === 'off' ? 'off' : 'lite',
    );
    f.service.reconfigure({
      ...f.config,
      telemetryPublisherPolicy: { [id]: policy },
      telemetryTier: { [id]: 'off' },
    });
    expect((await f.service.telemetryStatus()).publishers[id]).toMatchObject({
      tier: 'off',
      reason: 'user',
    });
  }
  f.env.DO_NOT_TRACK = '1';
  f.service.reconfigure({ ...f.config, telemetryTier: { [id]: 'full' } });
  expect((await f.service.telemetryStatus()).publishers[id]).toMatchObject({
    tier: 'off',
    reason: 'DNT',
    userChoice: 'full',
  });
  expect((await f.count()).status).toBe(200);
  expect(f.received).toEqual([]);
});

test('Lite needs its own notice and sends only bucketed yesterday counts once', async () => {
  const f = await fixture();
  await f.install();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
  expect((await f.count()).status).toBe(200);
  vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
  await f.service.flushDaily();
  expect(f.received).toEqual([]);
  expect(await f.service.outbox(id)).toEqual([
    expect.objectContaining({ reason: 'notice' }),
  ]);
  const status = await f.service.telemetryStatus();
  const revision = status.publishers[id].liteInventoryRevision;
  expect(
    (
      await f.post('/api/usage-telemetry/lite-notices', {
        publisher: id,
        inventoryRevision: status.liteInventoryRevision,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.post('/api/usage-telemetry/lite-notices', {
        publisher: id,
        inventoryRevision: revision,
      })
    ).status,
  ).toBe(200);
  for (let i = 0; i < 5; i++) expect((await f.count()).status).toBe(200);
  vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));
  await Promise.all([f.service.flushDaily(), f.service.flushDaily()]);
  expect(f.received).toHaveLength(1);
  const ping = parsePluginDailyPing(f.received[0], f.declaration);
  expect(ping.events.opened).toEqual({
    count: '4+',
    properties: {
      surface: { main: '4+', dock: '0' },
      items: { '0': '0', '1': '0', '2-3': '4+', '4-10': '0', '11+': '0' },
    },
  });
  expect(JSON.stringify(ping)).not.toMatch(
    /distinct_id|timestamp|2026-09|main.*secret/,
  );
  expect(existsSync(join(f.home, 'config', 'usage-telemetry-id'))).toBe(false);
  await f.restart();
  expect(
    (await f.service.telemetryStatus()).publishers[id].liteNoticeShown,
  ).toBe(true);
  await f.service.flushDaily();
  expect(f.received).toHaveLength(1);
});

test('Full requires a destination/inventory-bound publisher acknowledgement and uses a monthly publisher ID', async () => {
  const f = await fixture();
  await f.install();
  f.service.reconfigure({ ...f.config, telemetryTier: { [id]: 'full' } });
  expect((await f.count()).status).toBe(200);
  expect(f.received).toEqual([]);
  const disclosureResponse = await f.app.request(
    `/api/usage-telemetry/disclosure?publisher=${id}`,
  );
  const { data: disclosure } = (await disclosureResponse.json()) as {
    data: { inventoryRevision: string; destination: string };
  };
  const acknowledgement = {
    publisher: id,
    acknowledgementProtocol: 2,
    inventoryRevision: disclosure.inventoryRevision,
    destination: disclosure.destination,
  };
  expect(
    (
      await f.post('/api/usage-telemetry/disclosure/acknowledgements', {
        ...acknowledgement,
        destination: 'https://different.invalid',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.post(
        '/api/usage-telemetry/disclosure/acknowledgements',
        acknowledgement,
      )
    ).status,
  ).toBe(200);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
  await f.count();
  await f.count();
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  await f.count();
  const events = f.received as Array<{
    distinct_id: string;
    properties: unknown;
  }>;
  expect(events).toHaveLength(3);
  expect(events[0].distinct_id).toMatch(/^[a-f0-9]{64}$/);
  expect(events[0].distinct_id).toBe(events[1].distinct_id);
  expect(events[2].distinct_id).not.toBe(events[0].distinct_id);
  expect(events[0].properties).toEqual({ surface: 'main', items: '2-3' });
  f.env.DO_NOT_TRACK = '1';
  expect(
    (
      await f.post(
        '/api/usage-telemetry/disclosure/acknowledgements',
        acknowledgement,
      )
    ).status,
  ).toBe(409);
  await f.count();
  expect(f.received).toHaveLength(3);
});

test('uninstall sends explicit capped feedback before removal and retires pending daily counts', async () => {
  const f = await fixture();
  await f.install();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
  const status = await f.service.telemetryStatus();
  await f.post('/api/usage-telemetry/lite-notices', {
    publisher: id,
    inventoryRevision: status.publishers[id].liteInventoryRevision,
  });
  await f.count();
  const removal = await f.app.request(
    '/telemetry-writer?telemetryFeedbackReason=not-useful',
    { method: 'DELETE' },
  );
  expect(removal.status, await removal.clone().text()).toBe(200);
  expect(f.received).toEqual([
    { publisher: id, action: 'plugin-uninstalled', reason: 'not-useful' },
  ]);
  expect((await f.service.telemetryStatus()).publishers[id]).toBeUndefined();
  expect((await f.count()).status).toBe(400);
  await f.install();
  expect(
    (
      await f.app.request('/telemetry-writer?telemetryFeedbackReason=privacy', {
        method: 'DELETE',
      })
    ).status,
  ).toBe(200);
  expect(f.received).toHaveLength(1);
  // Reinstall the same signed artifact the next day: old snapshots and consent must stay withdrawn.
  vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
  await f.install();
  await f.service.flushDaily();
  expect(f.received).toHaveLength(1);
  expect(
    (await f.service.telemetryStatus()).publishers[id].liteNoticeShown,
  ).toBe(false);
  const outbox = await f.app.request(
    `/api/usage-telemetry/outbox?publisher=${id}`,
  );
  expect(outbox.status).toBe(200);
});

test('uninstall aborts an already admitted Full send still waiting to reach the receiver', async () => {
  const f = await fixture();
  await f.install();
  f.service.reconfigure({ ...f.config, telemetryTier: { [id]: 'full' } });
  const disclosure = await f.service.disclosure(id);
  await f.service.acknowledgeDisclosure(
    disclosure.inventoryRevision,
    id,
    disclosure.destination,
  );
  const gate = f.pauseNextSend();
  const pending = f.count();
  await gate.arrived;
  try {
    const response = await f.app.request('/telemetry-writer', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
  } finally {
    gate.release();
  }
  expect((await pending).status).toBe(200);
  expect(f.received).toEqual([]);
  expect(await f.service.outbox(id)).toEqual([
    expect.objectContaining({ outcome: 'dropped' }),
  ]);
});

test.each(['off', 'DNT'] as const)(
  'a %s withdrawal aborts an admitted Full request before receiver delivery',
  async (withdrawal) => {
    const f = await fixture();
    await f.install();
    const fullConfig = {
      ...f.config,
      telemetryTier: { [id]: 'full' as const },
    };
    f.service.reconfigure(fullConfig);
    const disclosure = await f.service.disclosure(id);
    await f.service.acknowledgeDisclosure(
      disclosure.inventoryRevision,
      id,
      disclosure.destination,
    );
    const gate = f.pauseNextSend();
    const pending = f.count();
    await gate.arrived;
    try {
      if (withdrawal === 'DNT') f.env.DO_NOT_TRACK = '1';
      f.service.reconfigure(
        withdrawal === 'DNT'
          ? fullConfig
          : { ...f.config, telemetryTier: { [id]: 'off' } },
      );
    } finally {
      gate.release();
    }
    expect((await pending).status).toBe(200);
    expect(f.received).toEqual([]);
    expect((await f.service.telemetryStatus()).publishers[id].tier).toBe('off');
  },
);
