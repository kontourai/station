/** Disposable real installer. Checkpoints terminate without running cleanup. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { JsonManifestRegistryProvider } from '../../../../providers/registries/json-manifest-registry.js';
import { replacePluginProvidersForSource } from '../../../../providers/registries/registry.js';
import { registerPluginInstallRoutes } from '../../../../routes/plugins/plugin-install-routes.js';
import {
  installPluginFromSource,
  previewInstalledPluginRecovery,
  recoverInstalledPlugin,
} from '../../../../routes/plugins/plugin-install-shared.js';
import { EventStore } from '../../../orchestration/event-store.js';
import {
  derivePluginConsentBasis,
  type PluginInstallConsent,
} from '../../plugin-install-consent.js';
import { createLocalPluginInstallationHost } from '../../plugin-installation-local.js';
import { readPluginManifestFile } from '../../plugin-manifest-loader.js';
import { readPluginGrantRevision } from '../../plugin-permissions.js';

const [home, source, stage] = process.argv.slice(2) as [string, string, string];
const store = new EventStore(join(home, 'events.sqlite'));
const originalJournal = store.createPackageMcpAdmissionJournal();
function interrupt(checkpoint: string): never {
  writeFileSync(join(home, 'interrupted-at'), checkpoint);
  process.kill(process.pid, 'SIGKILL');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Process interruption did not terminate the fixture');
}
const journal =
  stage === 'before-ready'
    ? {
        ...originalJournal,
        completeActivation() {
          return interrupt('before-ready');
        },
      }
    : originalJournal;
const localHost = createLocalPluginInstallationHost(
  join(home, 'plugins'),
  journal,
);
const host = {
  reconcile: () => localHost.reconcile(),
  async service(artifact?: Parameters<typeof localHost.service>[0]) {
    const service = await localHost.service(artifact);
    return new Proxy(service, {
      get(target, property) {
        if (property === 'install')
          return async (...args: Parameters<typeof service.install>) => {
            const result = await target.install(...args);
            if (stage === 'selected') interrupt('selected');
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  },
};
const deps = {
  projectHomeDir: home,
  pluginsDir: join(home, 'plugins'),
  agentsDir: join(home, 'agents'),
  packageMcpJournal: journal,
  installationHost: host,
  buildPlugin: async () => {
    if (stage.startsWith('offline'))
      throw new Error('Offline recovery must not rebuild');
  },
  reconcileEngineConnections: async () => {
    if (stage === 'after-host') interrupt('after-host');
  },
  logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
};
try {
  if (stage === 'offline' || stage.startsWith('offline:')) {
    const name = stage.split(':')[1] ?? 'recoverable';
    const preview = await previewInstalledPluginRecovery(name, deps);
    await recoverInstalledPlugin(name, deps, {
      recoveryRevision: preview.recoveryRevision,
      consent: {
        kind: 'operator-decision',
        contentDigest: preview.contentDigest,
        permissions: preview.permissions.required,
        grantRevision: preview.grantRevision,
        dependencies: preview.dependencies.map((entry) => entry.id),
        dependencyApprovals: preview.dependencies.map((entry) => ({
          id: entry.id,
          ...entry.consent,
        })),
      },
    });
    store.close();
    process.exit(0);
  }
  const manifest = await readPluginManifestFile(join(source, 'plugin.json'));
  const basis = derivePluginConsentBasis(source, manifest)!;
  let dependencyApprovals: Extract<
    PluginInstallConsent,
    { kind: 'operator-decision' }
  >['dependencyApprovals'];
  if (existsSync(join(home, 'registry.json'))) {
    const provider = new JsonManifestRegistryProvider(
      join(home, 'registry.json'),
      home,
    );
    await replacePluginProvidersForSource('restart-catalog', [
      { type: 'pluginRegistry', provider, source: 'restart-catalog' },
    ]);
    const app = new Hono();
    registerPluginInstallRoutes(app, deps);
    const response = await app.request('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const preview = (await response.json()) as any;
    if (!preview.valid) throw new Error(JSON.stringify(preview));
    dependencyApprovals = preview.dependencies.map((entry: any) => ({
      id: entry.id,
      contentDigest: entry.consent.contentDigest,
      permissions: entry.consent.permissions,
      dependencies: entry.consent.dependencies,
      grantRevision: entry.consent.grantRevision,
    }));
  }
  const consent =
    stage === 'stale'
      ? JSON.parse(readFileSync(join(home, 'initial-consent.json'), 'utf8'))
      : {
          kind: 'operator-decision' as const,
          permissions: basis.required,
          contentDigest: basis.contentDigest,
          dependencies:
            dependencyApprovals?.map((entry: any) => entry.id) ??
            basis.dependencies,
          dependencyApprovals,
          grantRevision: readPluginGrantRevision(home, manifest.name),
        };
  if (['selected', 'after-host', 'before-ready'].includes(stage))
    writeFileSync(join(home, 'initial-consent.json'), JSON.stringify(consent));
  await installPluginFromSource(source, [], deps, { consent });
  store.close();
  process.exit(0);
} catch (error) {
  writeFileSync(
    join(home, 'last-refusal'),
    error instanceof Error ? (error.stack ?? error.message) : 'Unknown refusal',
  );
  store.close();
  process.exit(2);
}
