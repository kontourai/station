/** Disposable real installer. Checkpoints terminate without running cleanup. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installPluginFromSource } from '../../../../routes/plugins/plugin-install-shared.js';
import { EventStore } from '../../../orchestration/event-store.js';
import { derivePluginConsentBasis } from '../../plugin-install-consent.js';
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
try {
  const manifest = await readPluginManifestFile(join(source, 'plugin.json'));
  const basis = derivePluginConsentBasis(source, manifest)!;
  const consent =
    stage === 'stale'
      ? JSON.parse(readFileSync(join(home, 'initial-consent.json'), 'utf8'))
      : {
          kind: 'operator-decision' as const,
          permissions: basis.required,
          contentDigest: basis.contentDigest,
          dependencies: basis.dependencies,
          grantRevision: readPluginGrantRevision(home, manifest.name),
        };
  if (['selected', 'after-host', 'before-ready'].includes(stage))
    writeFileSync(join(home, 'initial-consent.json'), JSON.stringify(consent));
  await installPluginFromSource(
    source,
    [],
    {
      projectHomeDir: home,
      pluginsDir: join(home, 'plugins'),
      agentsDir: join(home, 'agents'),
      packageMcpJournal: journal,
      installationHost: host,
      buildPlugin: async () => {},
      reconcileEngineConnections: async () => {
        if (stage === 'after-host') interrupt('after-host');
      },
      logger: { info() {}, warn() {}, debug() {}, error() {} } as any,
    },
    { consent },
  );
  store.close();
  process.exit(0);
} catch (error) {
  writeFileSync(
    join(home, 'last-refusal'),
    error instanceof Error ? error.message : 'Unknown refusal',
  );
  store.close();
  process.exit(2);
}
