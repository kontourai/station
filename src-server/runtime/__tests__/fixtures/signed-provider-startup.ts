import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { getOrchestrationDatabasePath } from '../../../domain/migrations/003-orchestration-events.js';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import {
  registerPluginRegistryProvider,
  replacePluginProvidersForSource,
} from '../../../providers/registries/registry.js';
import {
  capturePluginRegistryAcquisition,
  installPluginFromSource,
} from '../../../routes/plugins/plugin-install-shared.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { derivePluginConsentBasis } from '../../../services/plugins/plugin-install-consent.js';
import { readPluginManifestFile } from '../../../services/plugins/plugin-manifest-loader.js';
import { grantPermissions } from '../../../services/plugins/plugin-permissions.js';
import { capturePluginRuntimeArtifact } from '../../../services/plugins/plugin-runtime-artifact.js';
import { registryAcquisitionRevision } from '../../../services/plugins/registry-acquisition.js';
import {
  type RegistryPackageClaim,
  registryPackageSignaturePayload,
} from '../../../services/plugins/registry-supply-chain.js';
import { createLocalRegistryTrustPolicyAuthority } from '../../../services/plugins/registry-trust-policy.js';
import { createLogger } from '../../../utils/logger.js';

/** Actual signed installer setup. Runtime initialization remains the test subject. */
export async function installSignedStartupProvider(home: string) {
  const source = join(home, 'signed-source');
  const catalog = join(home, 'signed-catalog.json');
  mkdirSync(source);
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'startup-signed-brand',
      version: '1.0.0',
      extensions: {
        'io.kontourai.station': {
          schemaVersion: '1.0',
          providers: [{ type: 'branding', module: './brand.mjs' }],
        },
      },
    }),
  );
  writeFileSync(
    join(source, 'brand.mjs'),
    "globalThis.__stationSignedStartupImports = (globalThis.__stationSignedStartupImports ?? 0) + 1; export default function () { return { getAppName: () => 'Signed startup provider' }; }",
  );
  const pair = generateKeyPairSync('ed25519');
  const configuration = {
    profiles: [
      {
        registryKey: catalog,
        signatures: 'required' as const,
        trustedEd25519Keys: {
          primary: pair.publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        },
      },
    ],
  };
  const loader = new ConfigLoader({ projectHomeDir: home });
  await loader.mutateAppConfig(() => ({ registryTrust: configuration }));
  const store = new EventStore(getOrchestrationDatabasePath(home));
  try {
    const policy = createLocalRegistryTrustPolicyAuthority(
      home,
      store.createRegistryTrustPolicyDecisions(),
    );
    const applied = await policy.publishApplied(
      await policy.captureApplication(),
      configuration,
    );
    const manifest = await readPluginManifestFile(join(source, 'plugin.json'));
    const basis = derivePluginConsentBasis(source, manifest);
    if (!basis) throw new Error('Missing signed fixture consent basis');
    const unsigned: RegistryPackageClaim = {
      packageSchema:
        'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      registryId: manifest.name,
      registryKey: catalog,
      pluginName: manifest.name,
      packageVersion: manifest.version,
      source,
      packageDigest: basis.contentDigest,
    };
    const claim = {
      ...unsigned,
      signature: {
        algorithm: 'ed25519',
        keyId: 'primary',
        value: sign(
          null,
          registryPackageSignaturePayload(unsigned),
          pair.privateKey,
        ).toString('base64'),
      },
    };
    writeFileSync(
      catalog,
      JSON.stringify({
        version: 1,
        plugins: [{ id: manifest.name, source, claim }],
      }),
    );
    registerPluginRegistryProvider(
      new JsonManifestRegistryProvider(catalog, home),
      'signed-startup-fixture',
    );
    const journal = store.createPackageMcpAdmissionJournal();
    const deps = {
      projectHomeDir: home,
      pluginsDir: join(home, 'plugins'),
      agentsDir: join(home, 'agents'),
      logger: createLogger({ name: 'signed-startup-fixture', level: 'error' }),
      registryTrustPolicyAuthority: policy,
      packageMcpJournal: journal,
      buildPlugin: async () => {},
    };
    const preview = await capturePluginRegistryAcquisition(
      source,
      manifest,
      basis.contentDigest,
      deps,
      manifest.name,
      catalog,
    );
    if (!preview.registryAcquisition)
      throw new Error('Missing signed fixture verification');
    await installPluginFromSource(source, [], deps, {
      registryId: manifest.name,
      registryKey: catalog,
      consent: {
        kind: 'operator-decision',
        permissions: basis.required,
        contentDigest: basis.contentDigest,
        dependencies: [],
        registryTrustRevision: registryAcquisitionRevision(
          preview.registryAcquisition,
        ),
      },
    });
    const artifact = capturePluginRuntimeArtifact(
      deps.pluginsDir,
      manifest.name,
      journal,
    );
    if (!artifact) throw new Error('Missing ready fixture artifact');
    await grantPermissions(
      home,
      manifest.name,
      ['providers.register'],
      artifact,
    );
    return { applied, pluginName: manifest.name };
  } finally {
    await replacePluginProvidersForSource('signed-startup-fixture', []);
    store.close();
    await loader.dispose();
  }
}
