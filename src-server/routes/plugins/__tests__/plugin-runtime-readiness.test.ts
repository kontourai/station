import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { createPluginOperationalEventSubscriptionService } from '../../../runtime/plugins/plugin-operational-event-subscriptions.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { verifyPluginActivation } from '../../../services/plugins/plugin-activation-plan.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import { createLocalPluginInstallationService } from '../../../services/plugins/plugin-installation-local.js';
import { grantPermissions } from '../../../services/plugins/plugin-permissions.js';
import { capturePluginRuntimeArtifact } from '../../../services/plugins/plugin-runtime-artifact.js';
import { readPluginBundle } from '../plugin-bundles.js';
import { registerPluginPublicRoutes } from '../plugin-public-routes.js';
import {
  acquirePluginPublicServerModule,
  readPluginPublicManifest,
} from '../plugin-public-server.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-public-ready-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const plugins = join(home, 'plugins'),
    source = join(home, 'source');
  mkdirSync(plugins);
  mkdirSync(join(source, 'dist'), { recursive: true });
  const manifest = {
    name: 'public-fixture',
    version: '1.0.0',
    serverModule: 'server.mjs',
    operationalEventSubscriptions: [
      {
        id: 'ready',
        version: '1.0.0',
        eventTypes: ['station.runtime.lifecycle/v1'],
        projection: 'metadata' as const,
      },
    ],
  };
  writeFileSync(join(source, 'plugin.json'), JSON.stringify(manifest));
  writeFileSync(
    join(source, 'server.mjs'),
    "globalThis.__stationPublicReadinessImports = (globalThis.__stationPublicReadinessImports ?? 0) + 1; export function register(app) { app.get('/ping', c => c.text('ready')); } export const operationalEvents = { async observe() { globalThis.__stationPublicReadinessEvents = (globalThis.__stationPublicReadinessEvents ?? 0) + 1; return { kind: 'accepted' }; } };",
  );
  writeFileSync(
    join(source, 'dist', 'bundle.js'),
    'export const ready = true;',
  );
  const digest = computePluginContentDigest(dirname(source), basename(source))!;
  const store = new EventStore(join(home, 'events.sqlite'));
  cleanups.push(() => store.close());
  const journal = store.createPackageMcpAdmissionJournal();
  await createLocalPluginInstallationService(plugins, journal, source).install({
    installation: manifest.name,
    expected: null,
    artifact: { digest },
    origin: 'a'.repeat(64),
  });
  const prior = journal.currentInstallation(manifest.name);
  if (prior.state !== 'observed')
    throw new Error('Missing fixture installation');
  const recorded = journal.recordInstallation({
    pluginId: manifest.name,
    contentDigest: digest,
    materialization: prior.installation.materialization,
    dataScope: prior.installation.dataScope,
    origin: 'a'.repeat(64),
    previous: prior.installation,
    activationPlan: {
      version: 1,
      artifactDigest: digest,
      descriptorDigest: digest,
      sourceDigest: digest,
      origin: 'a'.repeat(64),
      consent: {
        kind: 'no-operator-decision',
        caller: 'public-readiness-test',
      },
      previous: null,
      agents: [],
      ownedDependencies: [],
    },
  });
  if (recorded.state !== 'recorded') throw new Error('Missing pending fixture');
  const ready = async () => {
    const permit = journal.claimActivation(recorded.installation);
    await verifyPluginActivation(permit, journal, async () => {});
    expect(journal.completeActivation(permit)).toEqual({ state: 'applied' });
  };
  return { home, plugins, manifest, journal, ready, store };
}
const logger = {
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
} as any;

test('pending selected artifacts expose neither bundles nor manifests nor server imports; ready selection executes its installed declaration', async () => {
  const f = await fixture();
  const globals = globalThis as typeof globalThis & {
    __stationPublicReadinessImports?: number;
  };
  const before = globals.__stationPublicReadinessImports ?? 0;
  expect(
    await readPluginBundle(f.plugins, f.manifest.name, 'bundle.js', f.journal),
  ).toBeNull();
  expect(
    await readPluginPublicManifest(f.plugins, f.manifest.name, f.journal),
  ).toBeNull();
  expect(
    await acquirePluginPublicServerModule(
      f.plugins,
      f.manifest.name,
      f.manifest,
      logger,
      { journal: f.journal },
    ),
  ).toBeNull();
  expect(globals.__stationPublicReadinessImports ?? 0).toBe(before);
  await f.ready();
  expect(
    await acquirePluginPublicServerModule(
      f.plugins,
      f.manifest.name,
      f.manifest,
      logger,
      { journal: f.journal, authorize: () => false },
    ),
  ).toBeNull();
  expect(globals.__stationPublicReadinessImports ?? 0).toBe(before);
  expect(
    await readPluginBundle(f.plugins, f.manifest.name, 'bundle.js', f.journal),
  ).toContain('ready = true');
  const acquired = await acquirePluginPublicServerModule(
    f.plugins,
    f.manifest.name,
    { ...f.manifest, serverModule: '../forged.mjs' },
    logger,
    { journal: f.journal },
  );
  expect(acquired).not.toBeNull();
  const app = new Hono();
  await acquired!.loaded.register(app, {} as any);
  expect(await (await app.request('/ping')).text()).toBe('ready');
  expect(globals.__stationPublicReadinessImports).toBe(before + 1);
  acquired!.release();
});

test('captured public module refuses currentness after physical content changes and managed selection never falls back without its journal', async () => {
  const f = await fixture();
  await f.ready();
  expect(capturePluginRuntimeArtifact(f.plugins, f.manifest.name)).toBeNull();
  const artifact = capturePluginRuntimeArtifact(
    f.plugins,
    f.manifest.name,
    f.journal,
  )!;
  const acquired = await acquirePluginPublicServerModule(
    f.plugins,
    f.manifest.name,
    f.manifest,
    logger,
    { journal: f.journal },
  );
  expect(acquired!.isCurrent()).toBe(true);
  writeFileSync(
    join(artifact.packageRoot, 'server.mjs'),
    'export function register() {}',
  );
  expect(acquired!.isCurrent()).toBe(false);
  expect(
    await acquirePluginPublicServerModule(
      f.plugins,
      f.manifest.name,
      f.manifest,
      logger,
      { artifact },
    ),
  ).toBeNull();
  acquired!.release();
});

test('real public HTTP routes refuse pending activation and serve only a ready granted generation', async () => {
  const f = await fixture();
  const app = new Hono();
  registerPluginPublicRoutes(app, {
    pluginsDir: f.plugins,
    projectHomeDir: f.home,
    packageMcpJournal: f.journal,
    logger,
  });
  expect((await app.request('/public-fixture/bundle.js')).status).toBe(404);
  expect((await app.request('/public-fixture/ping')).status).toBe(404);
  await f.ready();
  const artifact = capturePluginRuntimeArtifact(
    f.plugins,
    f.manifest.name,
    f.journal,
  )!;
  await grantPermissions(f.home, f.manifest.name, ['plugin.server'], artifact);
  expect(await (await app.request('/public-fixture/ping')).text()).toBe(
    'ready',
  );
  expect(
    await (await app.request('/public-fixture/bundle.js')).text(),
  ).toContain('ready = true');
});

test('background subscriptions discover a ready journal selection without its alias and stop after the captured content changes', async () => {
  const f = await fixture();
  const globals = globalThis as typeof globalThis & {
    __stationPublicReadinessEvents?: number;
  };
  const before = globals.__stationPublicReadinessEvents ?? 0;
  const eventBus = new EventBus();
  const service = createPluginOperationalEventSubscriptionService({
    eventBus,
    eventStore: f.store,
    logger,
    projectHomeDir: f.home,
    packageMcpJournal: f.journal,
  });
  try {
    expect(await service.start()).toEqual({ kind: 'applied', active: 0 });
    await f.ready();
    const artifact = capturePluginRuntimeArtifact(
      f.plugins,
      f.manifest.name,
      f.journal,
    )!;
    await grantPermissions(
      f.home,
      f.manifest.name,
      ['plugin.server', 'events.subscribe'],
      artifact,
    );
    unlinkSync(join(f.plugins, f.manifest.name));
    expect(await service.reconcile()).toEqual({ kind: 'applied', active: 1 });
    const publisher = f.store.createOperationalEventPublisher();
    expect(
      publisher.append({
        schemaVersion: 'station.operational-event/v1',
        id: 'ready-event',
        type: 'station.runtime.lifecycle/v1',
        producer: { id: 'station-server', version: '1' },
        scopes: [{ kind: 'project', projectId: 'project-1' }],
        payload: {
          schema: 'station.runtime.lifecycle/v1',
          data: { phase: 'ready' },
        },
        occurredAt: new Date().toISOString(),
        privacy: 'private',
        delivery: 'durable',
      }),
    ).toMatchObject({ kind: 'appended' });
    await vi.waitFor(() =>
      expect(globals.__stationPublicReadinessEvents).toBe(before + 1),
    );
    writeFileSync(
      join(artifact.packageRoot, 'server.mjs'),
      'export function register() {}',
    );
    expect(await service.reconcile()).toEqual({ kind: 'applied', active: 0 });
    expect(globals.__stationPublicReadinessEvents).toBe(before + 1);
  } finally {
    await service.close();
  }
});
