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
import {
  clearAll,
  getProvider,
} from '../../../providers/registries/registry.js';
import { createPluginOperationalEventSubscriptionService } from '../../../runtime/plugins/plugin-operational-event-subscriptions.js';
import { loadRuntimePluginProviders } from '../../../runtime/plugins/runtime-plugin-loader.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { DistributionProfileService } from '../../../services/plugins/distribution-profile-service.js';
import { verifyPluginActivation } from '../../../services/plugins/plugin-activation-plan.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import { createLocalPluginInstallationService } from '../../../services/plugins/plugin-installation-local.js';
import { readPluginManifestFileSync } from '../../../services/plugins/plugin-manifest-loader.js';
import { grantPermissions } from '../../../services/plugins/plugin-permissions.js';
import { capturePluginRuntimeArtifact } from '../../../services/plugins/plugin-runtime-artifact.js';
import { readCurrentWorkspacePaneCatalog } from '../../../services/projects/workspace-pane-catalog.js';
import { readPluginBundle } from '../plugin-bundles.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';
import { registerPluginPublicRoutes } from '../plugin-public-routes.js';
import {
  acquirePluginPublicServerModule,
  readPluginPublicManifest,
} from '../plugin-public-server.js';
import * as pluginSource from '../plugin-source.js';

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
  const declaration = {
    name: 'public-fixture',
    version: '1.0.0',
    serverModule: 'server.mjs',
    workspacePanes: [
      {
        version: '1.0' as const,
        id: 'public-fixture-review',
        name: 'Review',
        rendererId: 'public-fixture.review',
        renderer: { kind: 'plugin-component' as const, name: 'review' },
        placement: { supportedRegions: ['primary' as const] },
        modes: [
          { id: 'default', contextRequirement: { project: true as const } },
        ],
        provenance: { origin: 'plugin' as const, pluginId: 'public-fixture' },
        lifecycle: { stage: 'stable' as const },
      },
    ],
    providers: [{ type: 'branding', module: './provider.mjs' }],
    operationalEventSubscriptions: [
      {
        id: 'ready',
        version: '1.0.0',
        eventTypes: ['station.runtime.lifecycle/v1'],
        projection: 'metadata' as const,
      },
    ],
  };
  writeFileSync(join(source, 'plugin.json'), JSON.stringify(declaration));
  const manifest = readPluginManifestFileSync(join(source, 'plugin.json'));
  writeFileSync(
    join(source, 'server.mjs'),
    "globalThis.__stationPublicReadinessImports = (globalThis.__stationPublicReadinessImports ?? 0) + 1; export function register(app) { app.get('/ping', c => c.text('ready')); } export const operationalEvents = { async observe() { globalThis.__stationPublicReadinessEvents = (globalThis.__stationPublicReadinessEvents ?? 0) + 1; return { kind: 'accepted' }; } };",
  );
  writeFileSync(
    join(source, 'dist', 'bundle.js'),
    'export const ready = true;',
  );
  writeFileSync(
    join(source, 'provider.mjs'),
    "globalThis.__stationReadyProviderImports = (globalThis.__stationReadyProviderImports ?? 0) + 1; export default function () { globalThis.__stationReadyProviderFactoryGate?.(); return { getAppName: () => 'Ready provider' }; }",
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

test('ordinary provider boot imports only ready journal selections and refuses publication if selection changes during construction', async () => {
  const f = await fixture();
  const globals = globalThis as typeof globalThis & {
    __stationReadyProviderImports?: number;
    __stationReadyProviderFactoryGate?: () => void;
  };
  const before = globals.__stationReadyProviderImports ?? 0;
  await clearAll();
  const context = {
    logger,
    projectHomeDir: f.home,
    packageMcpJournal: f.journal,
    loadPluginOverrides: async () => ({}),
  };
  try {
    await loadRuntimePluginProviders(context);
    expect(globals.__stationReadyProviderImports ?? 0).toBe(before);
    expect(getProvider('branding')).toBeNull();
    await f.ready();
    const artifact = capturePluginRuntimeArtifact(
      f.plugins,
      f.manifest.name,
      f.journal,
    )!;
    await grantPermissions(
      f.home,
      f.manifest.name,
      ['providers.register'],
      artifact,
    );
    unlinkSync(join(f.plugins, f.manifest.name));
    await loadRuntimePluginProviders(context);
    expect(
      getProvider<{ getAppName(): string }>('branding')?.getAppName(),
    ).toBe('Ready provider');
    expect(globals.__stationReadyProviderImports).toBe(before + 1);
    globals.__stationReadyProviderFactoryGate = () => {
      const current = f.journal.currentInstallation(f.manifest.name);
      if (current.state !== 'observed')
        throw new Error('Missing current installation');
      const result = f.journal.recordInstallation({
        pluginId: f.manifest.name,
        contentDigest: artifact.digest,
        previous: current.installation,
        materialization: current.installation.materialization,
        dataScope: current.installation.dataScope,
        origin: 'a'.repeat(64),
        activationPlan: f.journal.activationPlan(current.installation)!,
      });
      expect(result.state).toBe('recorded');
    };
    await loadRuntimePluginProviders(context);
    expect(globals.__stationReadyProviderImports).toBe(before + 2);
    expect(getProvider('branding')).toBeNull();
  } finally {
    delete globals.__stationReadyProviderFactoryGate;
    await clearAll();
  }
});

test('inventory and Pane catalogs retain pending rows without loading them and discover ready selections without aliases', async () => {
  const f = await fixture();
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    pluginsDir: f.plugins,
    projectHomeDir: f.home,
    agentsDir: join(f.home, 'agents'),
    packageMcpJournal: f.journal,
    logger,
  });
  const pending = (await (await app.request('/')).json()) as {
    plugins: unknown[];
  };
  expect(pending.plugins).toContainEqual(
    expect.objectContaining({
      name: f.manifest.name,
      hasBundle: false,
      installationReadiness: { state: 'pending', recovery: 'review' },
    }),
  );
  const distribution = new DistributionProfileService(
    f.home,
    undefined,
    f.journal,
  );
  expect(distribution.listPluginWorkspacePaneContributions()).toContainEqual(
    expect.objectContaining({
      enabled: false,
      installationReadiness: { state: 'pending', recovery: 'review' },
    }),
  );
  const catalog = readCurrentWorkspacePaneCatalog(distribution, 'project-a');
  expect(catalog.availability).toContainEqual(
    expect.objectContaining({
      descriptorId: 'public-fixture-review',
      availability: expect.objectContaining({
        state: 'temporarily-unavailable',
        reason: { code: 'installation-pending', source: 'configuration' },
      }),
    }),
  );
  await f.ready();
  unlinkSync(join(f.plugins, f.manifest.name));
  const ready = (await (await app.request('/')).json()) as {
    plugins: unknown[];
  };
  expect(ready.plugins).toContainEqual(
    expect.objectContaining({
      name: f.manifest.name,
      hasBundle: true,
      retainedOnRemoval: true,
      installationReadiness: { state: 'ready' },
    }),
  );
  expect(distribution.listPluginWorkspacePaneContributions()).toContainEqual(
    expect.objectContaining({
      enabled: true,
      installationReadiness: { state: 'ready' },
    }),
  );
});

test('inventory does not advertise a ready bundle when journal selection becomes pending during the awaited Git observation', async () => {
  const f = await fixture();
  await f.ready();
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    pluginsDir: f.plugins,
    projectHomeDir: f.home,
    agentsDir: join(f.home, 'agents'),
    packageMcpJournal: f.journal,
    logger,
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = pluginSource.getPluginGitInfo;
  const spy = vi
    .spyOn(pluginSource, 'getPluginGitInfo')
    .mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
  const response = app.request('/');
  try {
    await started;
    const current = f.journal.currentInstallation(f.manifest.name);
    if (current.state !== 'observed')
      throw new Error('Missing fixture installation');
    expect(
      f.journal.recordInstallation({
        pluginId: f.manifest.name,
        contentDigest: current.installation.contentDigest,
        previous: current.installation,
        materialization: current.installation.materialization,
        dataScope: current.installation.dataScope,
        origin: 'a'.repeat(64),
        activationPlan: f.journal.activationPlan(current.installation)!,
      }).state,
    ).toBe('recorded');
    release();
    const body = (await (await response).json()) as { plugins: unknown[] };
    expect(body.plugins).toContainEqual(
      expect.objectContaining({
        name: f.manifest.name,
        installationReadiness: { state: 'pending', recovery: 'review' },
        hasBundle: false,
      }),
    );
  } finally {
    release();
    await response;
    spy.mockRestore();
  }
});
