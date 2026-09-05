import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { EventStore } from '../../orchestration/event-store.js';
import { AgentPluginLoader } from '../agent-plugin-loader.js';
import {
  pluginActivationDescriptorDigest,
  verifyPluginActivation,
} from '../plugin-activation-plan.js';
import { computePluginContentDigest } from '../plugin-content-integrity.js';
import { createLocalPluginInstallationService } from '../plugin-installation-local.js';
import { readPluginManifestFile } from '../plugin-manifest-loader.js';

test('the production Agent Plugin catalog withholds pending core and namespace contributions until verified activation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'station-activation-loader-'));
  const source = join(home, 'source');
  const plugins = join(home, 'plugins');
  mkdirSync(source);
  mkdirSync(plugins);
  const store = new EventStore(join(home, 'events.sqlite'));
  try {
    writeFileSync(
      join(source, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'pending-loader',
        extensions: {
          'io.kontourai.station': {
            schemaVersion: '1.0',
            settings: [{ key: 'greeting', type: 'string', title: 'Greeting' }],
          },
        },
      }),
    );
    mkdirSync(join(source, 'skills', 'sample'), { recursive: true });
    writeFileSync(
      join(source, 'skills', 'sample', 'SKILL.md'),
      '---\nname: sample\ndescription: Sample skill\n---\nSample.',
    );
    const manifest = await readPluginManifestFile(join(source, 'plugin.json'));
    const digest = computePluginContentDigest(
      dirname(source),
      basename(source),
    )!;
    const journal = store.createPackageMcpAdmissionJournal();
    await createLocalPluginInstallationService(
      plugins,
      journal,
      source,
    ).install({
      installation: 'pending-loader',
      expected: null,
      artifact: { digest },
      origin: 'b'.repeat(64),
      activationPlan: {
        version: 1,
        artifactDigest: digest,
        sourceDigest: digest,
        descriptorDigest: pluginActivationDescriptorDigest(manifest),
        origin: 'b'.repeat(64),
        consent: { kind: 'no-operator-decision', caller: 'loader-fixture' },
        previous: null,
        agents: [],
        ownedDependencies: [],
      },
    });
    const loader = new AgentPluginLoader({
      projectHomeDir: home,
      journal: () => journal,
    });
    expect(loader.listInstalled()).toEqual([]);
    expect(loader.skillSources()).toEqual([
      expect.objectContaining({ excludeOnly: true }),
    ]);
    expect(loader.skillSources()[0]!.isCurrent?.()).toBe(false);
    expect(loader.listIntegrations()).toEqual([]);
    const selected = journal.currentInstallation('pending-loader');
    if (selected.state !== 'observed') throw new Error('Missing installation');
    const permit = journal.claimActivation(selected.installation);
    await verifyPluginActivation(permit, journal, async () => {});
    expect(journal.completeActivation(permit)).toEqual({ state: 'applied' });
    expect(loader.listInstalled()).toHaveLength(1);
    expect(loader.skillSources()).toHaveLength(1);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
