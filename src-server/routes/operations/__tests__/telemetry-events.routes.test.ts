import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { RegistryPackageClaim } from '@kontourai/station-contracts/registry-trust';
import { createPluginTelemetry } from '@kontourai/station-sdk/client';
import {
  parsePluginDailyPing,
  pluginTelemetryPublisherId,
} from '@kontourai/station-shared/plugin-telemetry';
import * as publicNetwork from '@kontourai/station-shared/public-network';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchema } from '../../../domain/home-schema-gate.js';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import { replacePluginProvidersForSource } from '../../../providers/registries/registry.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import * as transport from '../../../services/plugin-telemetry-transport.js';
import { installPluginFromSource } from '../../../services/plugins/plugin-install-transaction.js';
import { readPluginManifestFile } from '../../../services/plugins/plugin-manifest-loader.js';
import * as pluginPermissions from '../../../services/plugins/plugin-permissions.js';
import { registryPackageSignaturePayload } from '../../../services/plugins/registry-supply-chain.js';
import { createLocalRegistryTrustPolicyAuthority } from '../../../services/plugins/registry-trust-policy.js';
import { TelemetryLocalState } from '../../../services/telemetry-local-state.js';
import { UsageTelemetryService } from '../../../services/usage-telemetry-service.js';
import { createLogger } from '../../../utils/logger.js';
import { registerPluginInstallRoutes } from '../../plugins/plugin-install-routes.js';
import { registerPluginLifecycleRoutes } from '../../plugins/plugin-lifecycle-routes.js';
import { createTelemetryRoutes } from '../telemetry-events.js';
import { createUsageTelemetryDisclosureRoutes } from '../usage-telemetry-disclosure.js';

const dns = vi.hoisted(() => ({
  answers: [{ address: '8.8.8.8', family: 4 }],
}));
vi.mock('node:dns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns')>()),
  lookup: (
    _host: string,
    _options: unknown,
    callback: (error: null, answers: unknown) => void,
  ) => callback(null, dns.answers),
}));
const makeTempDir = trackTempDirs();
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await replacePluginProvidersForSource('telemetry-fixture', []);
});
async function fixture(
  options: {
    unsigned?: boolean;
    private?: boolean;
    wrongPublisher?: boolean;
    secondPlugin?: boolean;
  } = {},
) {
  const directory = makeTempDir('station-publisher-test-');
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });
  const source = join(directory, 'telemetry-writer');
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
  const id = pluginTelemetryPublisherId(
    `sha256:${createHash('sha256').update(catalog.registryKey).digest('hex')}`,
    'telemetry-writer',
  );
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
  await replacePluginProvidersForSource('telemetry-fixture', [
    { type: 'pluginRegistry', provider: catalog, source: 'telemetry-fixture' },
  ]);
  const entries: Array<{
    id: string;
    source: string;
    displayName: string;
    version: string;
    claim: RegistryPackageClaim;
  }> = [];
  const installs = new Map<
    string,
    () => ReturnType<typeof installPluginFromSource>
  >();
  for (const pluginName of options.secondPlugin
    ? ['telemetry-writer', 'telemetry-reader']
    : ['telemetry-writer']) {
    const source = join(directory, pluginName);
    mkdirSync(source);
    writeFileSync(
      join(source, 'plugin.json'),
      readFileSync(
        new URL('./fixtures/telemetry-plugin.json', import.meta.url),
        'utf8',
      ).replaceAll('telemetry-writer', pluginName),
    );
    if (options.wrongPublisher) {
      const path = join(source, 'plugin.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.extensions['io.kontourai.station'].telemetry.publisher =
        'someone-else';
      writeFileSync(path, JSON.stringify(manifest));
    }
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
      packageSchema:
        'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      registryId: pluginName,
      registryKey: catalog.registryKey,
      pluginName: pluginName,
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
    entries.push({
      id: pluginName,
      source,
      displayName: pluginName,
      version: '1.0.0',
      claim,
    });
    writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        plugins: entries,
      }),
    );
    const registryPreview = await previewApp.request('/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ registryId: pluginName }),
    });
    const reviewed = (await registryPreview.json()) as {
      valid: boolean;
      contentDigest: string;
      registryTrust?: { revision: string };
      permissions: { required: string[] };
      registryTrustRevision?: string;
    };
    expect(reviewed.valid, JSON.stringify(reviewed)).toBe(true);
    installs.set(pluginName, () =>
      installPluginFromSource(source, [], deps, {
        registryId: pluginName,
        registryKey: catalog.registryKey,
        consent: {
          kind: 'operator-decision',
          contentDigest: reviewed.contentDigest,
          permissions: reviewed.permissions.required,
          dependencies: [],
          registryTrustRevision:
            reviewed.registryTrust?.revision ?? reviewed.registryTrustRevision,
        },
      }),
    );
  }
  const install = () => installs.get('telemetry-writer')!();
  const installSecond = () => installs.get('telemetry-reader')!();
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
  vi.spyOn(publicNetwork, 'resolvePublicAddress').mockResolvedValue({
    address: '8.8.8.8',
    family: 4,
  });
  vi.spyOn(transport, 'sendPluginTelemetry').mockImplementation(
    async (url, body, _selected, signal) => {
      expect(url).toBe('https://publisher.example.test/counts');
      const queued = nextSend;
      nextSend = undefined;
      if (queued) {
        queued.started();
        await queued.wait;
      }
      const response = await receiverFetch(
        `http://127.0.0.1:${address.port}/`,
        { method: 'POST', body, signal },
      );
      return response.ok;
    },
  );
  const serviceOptions: ConstructorParameters<typeof UsageTelemetryService>[0] =
    {
      homeDir: home,
      appConfig: config,
      version: '1.0.0',
      env,
      logger,
      pluginTelemetry: { homeDir: home, journal, trustPolicy },
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
  let token: string | undefined;
  let tokenExpires = 0;
  const capability = async () => {
    if (!token || tokenExpires <= Date.now()) {
      const response = await app.request('/api/telemetry/panes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plugin: 'telemetry-writer' }),
      });
      const json = (await response.json()) as {
        data?: { token: string; expiresAt: string };
      };
      token = json.data?.token;
      tokenExpires = Date.parse(json.data?.expiresAt ?? '');
    }
    return token ?? 'missing';
  };
  const post = async (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(path === '/api/telemetry/events'
          ? { 'x-station-plugin-capability': await capability() }
          : {}),
      },
      body: JSON.stringify(body),
    });
  const count = (
    event = 'opened',
    attributes: Record<string, string | number> = { surface: 'main', items: 2 },
  ) => post('/api/telemetry/events', { events: [{ event, attributes }] });
  return {
    id,
    capability,
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
    installSecond,
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
    await f.capability(),
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

test.each([{ unsigned: true }, { private: true }, { wrongPublisher: true }])(
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
      telemetryPublisherPolicy: { [f.id]: policy },
    });
    expect((await f.service.telemetryStatus()).publishers[f.id].tier).toBe(
      'off',
    );
    f.service.reconfigure({
      ...f.config,
      telemetryPublisherPolicy: { [f.id]: policy },
      telemetryTier: { [f.id]: 'off' as const },
    });
    expect((await f.service.telemetryStatus()).publishers[f.id]).toMatchObject({
      tier: 'off',
      reason: 'user',
    });
  }
  f.env.DO_NOT_TRACK = '1';
  f.service.reconfigure({
    ...f.config,
    telemetryTier: { [f.id]: 'full' as const },
  });
  expect((await f.service.telemetryStatus()).publishers[f.id]).toMatchObject({
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
  f.service.reconfigure({
    ...f.config,
    telemetryTier: { [f.id]: 'lite' as const },
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
  expect((await f.count()).status).toBe(200);
  vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
  await f.service.flushDaily();
  expect(f.received).toEqual([]);
  expect(await f.service.outbox(f.id)).toEqual([
    expect.objectContaining({ reason: 'notice' }),
  ]);
  const status = await f.service.telemetryStatus();
  const revision = status.publishers[f.id].liteInventoryRevision;
  expect(
    (
      await f.post('/api/usage-telemetry/lite-notices', {
        publisher: f.id,
        inventoryRevision: status.liteInventoryRevision,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.post('/api/usage-telemetry/lite-notices', {
        publisher: f.id,
        inventoryRevision: revision,
      })
    ).status,
  ).toBe(200);
  for (let i = 0; i < 5; i++) expect((await f.count()).status).toBe(200);
  vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));
  await Promise.all([f.service.flushDaily(), f.service.flushDaily()]);
  expect(f.received).toHaveLength(1);
  const ping = parsePluginDailyPing(f.received[0], f.declaration, f.id);
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
  expect(existsSync(join(f.home, 'config', 'usage-telemetry-f.id'))).toBe(
    false,
  );
  await f.restart();
  expect(
    (await f.service.telemetryStatus()).publishers[f.id].liteNoticeShown,
  ).toBe(true);
  await f.service.flushDaily();
  expect(f.received).toHaveLength(1);
});

test('Full requires a destination/inventory-bound publisher acknowledgement and uses a monthly publisher ID', async () => {
  const f = await fixture();
  await f.install();
  f.service.reconfigure({
    ...f.config,
    telemetryTier: { [f.id]: 'full' as const },
  });
  expect((await f.count()).status).toBe(200);
  expect(f.received).toEqual([]);
  const disclosureResponse = await f.app.request(
    `/api/usage-telemetry/disclosure?publisher=${f.id}`,
  );
  const { data: disclosure } = (await disclosureResponse.json()) as {
    data: { inventoryRevision: string; destination: string };
  };
  const acknowledgement = {
    publisher: f.id,
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
  await f.service.flush();
  await f.count();
  await f.service.flush();
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  await f.service.countPluginTelemetry(
    (await f.service.mountPluginTelemetryPane('telemetry-writer')).token,
    [{ event: 'opened', attributes: { surface: 'main', items: 2 } }],
  );
  await f.service.flush();
  const events = (f.received as Array<{ events: unknown[] }>).flatMap(
    (batch) => batch.events,
  ) as Array<{
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
  f.service.reconfigure({
    ...f.config,
    telemetryTier: { [f.id]: 'lite' as const },
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
  const status = await f.service.telemetryStatus();
  await f.post('/api/usage-telemetry/lite-notices', {
    publisher: f.id,
    inventoryRevision: status.publishers[f.id].liteInventoryRevision,
  });
  await f.count();
  const removal = await f.app.request(
    '/telemetry-writer?telemetryFeedbackReason=not-useful',
    { method: 'DELETE' },
  );
  expect(removal.status, await removal.clone().text()).toBe(200);
  expect(f.received).toEqual([
    { publisher: f.id, action: 'plugin-uninstalled', reason: 'not-useful' },
  ]);
  expect((await f.service.telemetryStatus()).publishers[f.id]).toBeUndefined();
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
    (await f.service.telemetryStatus()).publishers[f.id].liteNoticeShown,
  ).toBe(false);
  const outbox = await f.app.request(
    `/api/usage-telemetry/outbox?publisher=${f.id}`,
  );
  expect(outbox.status).toBe(200);
});

test('uninstall aborts an already admitted Full send still waiting to reach the receiver', async () => {
  const f = await fixture();
  await f.install();
  f.service.reconfigure({
    ...f.config,
    telemetryTier: { [f.id]: 'full' as const },
  });
  const disclosure = await f.service.disclosure(f.id);
  await f.service.acknowledgeDisclosure(
    disclosure.inventoryRevision,
    f.id,
    disclosure.destination,
  );
  const gate = f.pauseNextSend();
  await f.count();
  const pending = f.service.flush();
  await gate.arrived;
  try {
    const response = await f.app.request('/telemetry-writer', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
  } finally {
    gate.release();
  }
  await pending;
  expect(f.received).toEqual([]);
  expect(await f.service.outbox(f.id)).toEqual([
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
      telemetryTier: { [f.id]: 'full' as const },
    };
    f.service.reconfigure(fullConfig);
    const disclosure = await f.service.disclosure(f.id);
    await f.service.acknowledgeDisclosure(
      disclosure.inventoryRevision,
      f.id,
      disclosure.destination,
    );
    const gate = f.pauseNextSend();
    await f.count();
    const pending = f.service.flush();
    await gate.arrived;
    try {
      if (withdrawal === 'DNT') f.env.DO_NOT_TRACK = '1';
      f.service.reconfigure(
        withdrawal === 'DNT'
          ? fullConfig
          : { ...f.config, telemetryTier: { [f.id]: 'off' as const } },
      );
    } finally {
      gate.release();
    }
    await pending;
    expect(f.received).toEqual([]);
    expect((await f.service.telemetryStatus()).publishers[f.id].tier).toBe(
      'off',
    );
  },
);

test('a fresh plugin stays Off after its notice, including explicit uninstall feedback', async () => {
  const f = await fixture();
  await f.install();
  expect((await f.service.telemetryStatus()).publishers[f.id].tier).toBe('off');
  await f.post('/api/usage-telemetry/lite-notices', {
    publisher: f.id,
    inventoryRevision: (await f.service.telemetryStatus()).publishers[f.id]
      .liteInventoryRevision,
  });
  await f.count();
  await f.service.flush();
  await f.service.flushDaily();
  await f.app.request('/telemetry-writer?telemetryFeedbackReason=privacy', {
    method: 'DELETE',
  });
  expect(f.received).toEqual([]);
});

test('forged plugin headers confer no counting authority; tokens own publisher attribution and cannot acknowledge consent', async () => {
  const f = await fixture();
  await f.install();
  const events = [
    { event: 'opened', attributes: { surface: 'main', items: 2 } },
  ];
  const forged = await f.app.request('/api/telemetry/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-station-plugin': 'telemetry-writer',
    },
    body: JSON.stringify({ events }),
  });
  expect(forged.status).toBe(400);
  const token = await f.capability();
  const agent = await f.app.request('/api/telemetry/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-station-plugin-capability': token,
      'x-station-control-origin': 'agent-tool',
    },
    body: JSON.stringify({ events }),
  });
  expect(agent.status).toBe(403);
  const foreign = await f.app.request('/api/telemetry/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-station-plugin-capability': token,
      'x-station-plugin': 'another-plugin',
    },
    body: JSON.stringify({ events, publisher: 'publisher:another-plugin' }),
  });
  expect(foreign.status).toBe(200);
  expect(await f.service.outbox('publisher:another-plugin')).toEqual([]);
  expect(await f.service.outbox(f.id)).toHaveLength(1);
  for (const path of [
    '/api/usage-telemetry/lite-notices',
    '/api/usage-telemetry/disclosure/acknowledgements',
  ]) {
    const response = await f.app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-station-plugin-capability': token,
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
  }
});

test('every DNS answer must be public before a plugin send', async () => {
  const f = await fixture();
  await f.install();
  f.service.reconfigure({
    ...f.config,
    telemetryTier: { [f.id]: 'full' as const },
  });
  const disclosure = await f.service.disclosure(f.id);
  await f.service.acknowledgeDisclosure(
    disclosure.inventoryRevision,
    f.id,
    disclosure.destination,
  );
  await f.count();
  vi.mocked(publicNetwork.resolvePublicAddress).mockRestore();
  dns.answers = [
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await f.service.flush();
  expect(f.received).toEqual([]);
  expect(await f.service.outbox(f.id)).toEqual([
    expect.objectContaining({ outcome: 'dropped', reason: 'transport' }),
  ]);
});

test.each(['uninstall', 'off', 'DNT', 'registry'] as const)(
  '%s fences a Full send paused after retirement observation and before controller registration',
  async (withdrawal) => {
    const f = await fixture();
    await f.install();
    f.service.reconfigure({
      ...f.config,
      telemetryTier: { [f.id]: 'full' as const },
    });
    const disclosure = await f.service.disclosure(f.id);
    await f.service.acknowledgeDisclosure(
      disclosure.inventoryRevision,
      f.id,
      disclosure.destination,
    );
    await f.count();
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    vi.mocked(publicNetwork.resolvePublicAddress).mockImplementationOnce(
      async () => {
        arrived();
        await gate;
        return { address: '8.8.8.8', family: 4 };
      },
    );
    const pending = f.service.flush();
    await started;
    try {
      if (withdrawal === 'uninstall') await f.service.pluginUninstalled(f.id);
      else if (withdrawal === 'DNT') f.env.DO_NOT_TRACK = '1';
      else if (withdrawal === 'off')
        f.service.reconfigure({
          ...f.config,
          telemetryTier: { [f.id]: 'off' as const },
        });
      else
        f.service.reconfigure({ ...f.config, publicTelemetryRegistries: [] });
    } finally {
      release();
    }
    await pending;
    expect(f.received).toEqual([]);
  },
);

test('publisher floods coalesce local drops and Full events are sent as one bounded batch per flush', async () => {
  const f = await fixture();
  await f.install();
  const local = new TelemetryLocalState(f.home);
  await local.record({
    publisher: 'kontour',
    tier: 'lite',
    recordedAt: new Date().toISOString(),
    outcome: 'dropped',
    reason: 'off',
    payload: { event: 'telemetry_dropped', count: 1 },
  });
  await local.record({
    publisher: 'operator',
    tier: 'lite',
    recordedAt: new Date().toISOString(),
    outcome: 'dropped',
    reason: 'off',
    payload: { event: 'telemetry_dropped', count: 1 },
  });
  f.service.reconfigure({
    ...f.config,
    telemetryTier: { [f.id]: 'full' as const },
  });
  const disclosure = await f.service.disclosure(f.id);
  await f.service.acknowledgeDisclosure(
    disclosure.inventoryRevision,
    f.id,
    disclosure.destination,
  );
  const token = await f.capability();
  const events = Array.from({ length: 100 }, () => ({
    event: 'opened',
    attributes: { surface: 'main', items: 2 },
  }));
  await f.service.countPluginTelemetry(token, events);
  await f.service.countPluginTelemetry(token, events);
  await f.service.flush();
  expect(f.received).toHaveLength(1);
  expect((f.received[0] as { events: unknown[] }).events).toHaveLength(100);
  for (let i = 0; i < 105; i++) await f.count();
  expect(await local.outbox('kontour')).toHaveLength(1);
  expect(await local.outbox('operator')).toHaveLength(1);
  expect(
    (await local.outbox(f.id)).filter((row) => row.reason === 'overflow'),
  ).toHaveLength(1);
});

test('expired Pane capabilities cannot count or borrow a renewed capability', async () => {
  const f = await fixture();
  await f.install();
  const token = await f.capability();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 300001);
  const old = await f.app.request('/api/telemetry/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-station-plugin-capability': token,
    },
    body: JSON.stringify({ events: [{ event: 'closed', attributes: {} }] }),
  });
  expect(old.status).toBe(400);
  expect((await f.count()).status).toBe(200);
});

test('one plugin minting 2000 Pane capabilities cannot block another plugin', async () => {
  const f = await fixture({ secondPlugin: true });
  await f.install();
  await f.installSecond();
  const oldest = await f.capability();
  const body = { events: [{ event: 'closed', attributes: {} }] };
  const countWith = (capability: string) =>
    f.app.request('/api/telemetry/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-station-plugin-capability': capability,
      },
      body: JSON.stringify(body),
    });
  let newest = oldest;
  for (let i = 0; i < 2000; i++) {
    const response = await f.post('/api/telemetry/panes', {
      plugin: 'telemetry-writer',
    });
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { token: string } };
    newest = data.token;
    if (i === 14) expect((await countWith(oldest)).status).toBe(200);
    if (i === 15) expect((await countWith(oldest)).status).toBe(400);
  }
  const other = await f.post('/api/telemetry/panes', {
    plugin: 'telemetry-reader',
  });
  expect(other.status).toBe(200);
  const {
    data: { token },
  } = (await other.json()) as { data: { token: string } };
  expect((await countWith(oldest)).status).toBe(400);
  expect((await countWith(newest)).status).toBe(200);
  expect((await countWith(token)).status).toBe(200);
}, 120000);

test('an aborted uninstall restores counting and consent without releasing a pre-withdrawal send', async () => {
  const f = await fixture();
  await f.install();
  f.service.reconfigure({
    ...f.config,
    telemetryTier: { [f.id]: 'full' as const },
  });
  const disclosure = await f.service.disclosure(f.id);
  await f.service.acknowledgeDisclosure(
    disclosure.inventoryRevision,
    f.id,
    disclosure.destination,
  );
  await f.count();
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  vi.mocked(publicNetwork.resolvePublicAddress).mockImplementationOnce(
    async () => {
      arrived();
      await gate;
      return { address: '8.8.8.8', family: 4 };
    },
  );
  const pending = f.service.flush();
  await started;
  // Fail after withdrawal, before the uninstall backup completes.
  vi.spyOn(
    pluginPermissions,
    'snapshotPluginGrantEntry',
  ).mockImplementationOnce(() => {
    throw new Error('fixture backup refused');
  });
  let response: Response;
  try {
    response = await f.app.request('/telemetry-writer', { method: 'DELETE' });
  } finally {
    release();
    await pending;
  }
  expect(response.status).toBe(500);
  expect(await response.text()).toContain('fixture backup refused');
  expect(f.received).toEqual([]);
  const renewed = await f.post('/api/telemetry/panes', {
    plugin: 'telemetry-writer',
  });
  expect(renewed.status, await renewed.clone().text()).toBe(200);
  const {
    data: { token },
  } = (await renewed.json()) as { data: { token: string } };
  await f.service.countPluginTelemetry(token, [
    { event: 'closed', attributes: {} },
  ]);
  await f.service.flush();
  expect(f.received).toHaveLength(1);
  expect(
    (f.received[0] as { events: Array<{ name: string }> }).events[0].name,
  ).toBe('closed');
});
