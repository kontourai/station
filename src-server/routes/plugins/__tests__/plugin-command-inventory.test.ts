import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { verifyPluginActivation } from '../../../services/plugins/plugin-activation-plan.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import { createLocalPluginInstallationService } from '../../../services/plugins/plugin-installation-local.js';
import { readPluginManifestFileSync } from '../../../services/plugins/plugin-manifest-loader.js';
import {
  capturePluginRuntimeArtifact,
  pluginInstallationGeneration,
} from '../../../services/plugins/plugin-runtime-artifact.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';

// Removed in an after-hook even when an assertion fails (#2421).
const makeTempDir = trackTempDirs();

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const logger = {
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
} as never;

const commands = [
  {
    version: '1.0',
    id: 'demo.open-plugins',
    title: 'Open plugins',
    intent: { kind: 'navigate', surfaceId: 'plugins' },
  },
];

function home() {
  const dir = makeTempDir('station-command-inventory-');
  const plugins = join(dir, 'plugins');
  mkdirSync(plugins);
  return { dir, plugins };
}

function routes(
  input: { dir: string; plugins: string },
  options: {
    journal?: ReturnType<EventStore['createPackageMcpAdmissionJournal']>;
    visible?: (installed: readonly string[]) => readonly string[];
  } = {},
) {
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    projectVisiblePlugins: () => options.visible ?? ((installed) => installed),
    pluginsDir: input.plugins,
    projectHomeDir: input.dir,
    agentsDir: join(input.dir, 'agents'),
    ...(options.journal ? { packageMcpJournal: options.journal } : {}),
    logger,
  });
  return async () =>
    ((await (await app.request('/')).json()) as { plugins: unknown[] })
      .plugins as Array<Record<string, unknown>>;
}

test('a ready installation publishes its commands and the generation admission derives', async () => {
  const h = home();
  mkdirSync(join(h.plugins, 'demo'));
  writeFileSync(
    join(h.plugins, 'demo', 'plugin.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', commands }),
  );
  const [record] = await routes(h)();
  const artifact = capturePluginRuntimeArtifact(h.plugins, 'demo');
  expect(artifact).not.toBeNull();
  expect(record).toMatchObject({
    name: 'demo',
    installationReadiness: { state: 'ready' },
    commands,
    installationGeneration: pluginInstallationGeneration(artifact!),
  });

  // The generation is bound to content: changed bytes publish a new one.
  writeFileSync(
    join(h.plugins, 'demo', 'plugin.json'),
    JSON.stringify({ name: 'demo', version: '1.0.1', commands }),
  );
  const [changed] = await routes(h)();
  expect(changed.installationGeneration).not.toBe(
    record.installationGeneration,
  );
});

test('L5: invalid command declarations are dropped from a ready record with their diagnostic, and the plugin stays listed', async () => {
  const h = home();
  mkdirSync(join(h.plugins, 'demo'));
  writeFileSync(
    join(h.plugins, 'demo', 'plugin.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      commands: [{ ...commands[0], id: 'someone-else.open' }],
    }),
  );
  const [record] = await routes(h)();
  expect(record).toMatchObject({
    name: 'demo',
    installationReadiness: { state: 'ready' },
    commands: [],
    commandsRejected: { reason: expect.stringContaining("'demo.'") },
  });
  expect(record).not.toHaveProperty('status');
});

test('an invisible plugin is absent from the inventory, commands included', async () => {
  const h = home();
  mkdirSync(join(h.plugins, 'demo'));
  writeFileSync(
    join(h.plugins, 'demo', 'plugin.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', commands }),
  );
  const plugins = await routes(h, { visible: () => [] })();
  expect(plugins).toEqual([]);
});

test('a pending managed installation publishes neither commands nor a generation until it is ready', async () => {
  const h = home();
  const source = join(h.dir, 'source');
  mkdirSync(source);
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', commands }),
  );
  const manifest = readPluginManifestFileSync(join(source, 'plugin.json'));
  const digest = computePluginContentDigest(dirname(source), basename(source))!;
  const store = new EventStore(join(h.dir, 'events.sqlite'));
  cleanups.push(() => store.close());
  const journal = store.createPackageMcpAdmissionJournal();
  await createLocalPluginInstallationService(
    h.plugins,
    journal,
    source,
  ).install({
    installation: manifest.name,
    expected: null,
    artifact: { digest },
    origin: 'a'.repeat(64),
  });
  const prior = journal.currentInstallation(manifest.name);
  if (prior.state !== 'observed') throw new Error('fixture not installed');
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
      consent: { kind: 'no-operator-decision', caller: 'command-inventory' },
      previous: null,
      agents: [],
      ownedDependencies: [],
    },
  });
  if (recorded.state !== 'recorded') throw new Error('fixture not pending');
  const read = routes(h, { journal });

  const [pending] = await read();
  expect(pending).toMatchObject({
    name: 'demo',
    installationReadiness: { state: 'pending', recovery: 'review' },
  });
  expect(pending).not.toHaveProperty('commands');
  expect(pending).not.toHaveProperty('installationGeneration');

  const permit = journal.claimActivation(recorded.installation);
  await verifyPluginActivation(permit, journal, async () => {});
  expect(journal.completeActivation(permit)).toEqual({ state: 'applied' });
  const [ready] = await read();
  const artifact = capturePluginRuntimeArtifact(h.plugins, 'demo', journal);
  expect(artifact?.generation).toBeTruthy();
  expect(ready).toMatchObject({
    installationReadiness: { state: 'ready' },
    commands,
    installationGeneration: pluginInstallationGeneration(artifact!),
  });
});
