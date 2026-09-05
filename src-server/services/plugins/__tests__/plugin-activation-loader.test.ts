import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { EventStore } from '../../orchestration/event-store.js';
import { AgentPluginLoader } from '../agent-plugin-loader.js';
import {
  closePluginActivationSession,
  createPluginActivationSession,
  preparePluginActivationComposition,
  registerPluginActivation,
} from '../plugin-activation-composition.js';
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
    const config = new ConfigLoader({
      projectHomeDir: home,
      pluginAgentAdmission: (id, generation, capability) =>
        loader.admitsPluginAgent(id, generation, capability),
    });
    for (const slug of ['owned-agent', 'independent-agent']) {
      mkdirSync(join(home, 'agents', slug), { recursive: true });
      writeFileSync(
        join(home, 'agents', slug, 'agent.json'),
        JSON.stringify({ name: slug, prompt: 'Fixture Agent' }),
      );
    }
    writeFileSync(
      join(home, 'agents', 'owned-agent', '.station-plugin-owner.json'),
      JSON.stringify({
        plugin: 'pending-loader',
        generation: selected.installation.incarnation,
      }),
    );
    expect((await config.listAgents()).map((agent) => agent.slug)).toEqual([
      'independent-agent',
    ]);
    await expect(config.loadAgent('owned-agent')).rejects.toThrow('not ready');
    const session = createPluginActivationSession();
    const pendingPermit = registerPluginActivation(
      session,
      journal,
      selected.installation,
      async () => {},
    );
    const composition = await preparePluginActivationComposition(session);
    const composingSources = loader.skillSources(composition);
    const composingConfig = config.forPluginActivationComposition(composition);
    expect((await composingConfig.loadAgent('owned-agent')).name).toBe(
      'owned-agent',
    );
    expect((await config.listAgents()).map((agent) => agent.slug)).toEqual([
      'independent-agent',
    ]);
    expect(composingSources[0]!.excludeOnly).toBeUndefined();
    expect(composingSources[0]!.isCurrent?.()).toBe(true);
    // Supplying the capability to a composition call does not change the
    // ordinary loader or give separately scheduled work ambient authority.
    expect(loader.listInstalled()).toEqual([]);
    expect(
      await new Promise((resolve) =>
        setImmediate(() => resolve(loader.listInstalled())),
      ),
    ).toEqual([]);
    expect(journal.reserve(selected.installation, 'probe')).toEqual({
      state: 'blocked',
    });
    const reserved = journal.reserveActivation(pendingPermit, 'probe');
    if (reserved.state !== 'reserved')
      throw new Error('Owned pending probe refused');
    const started = journal.reserveActivation(pendingPermit, 'probe');
    if (started.state !== 'reserved')
      throw new Error('Owned pending probe refused');
    expect(started.claim.enterEffectBoundary()).toEqual({ state: 'applied' });
    closePluginActivationSession(session);
    expect(reserved.claim.isCurrent()).toBe(false);
    expect(journal.inspect(selected.installation)).toMatchObject({
      possibleEffects: 1,
      mutationAllowed: false,
    });
    expect(composingSources[0]!.isCurrent?.()).toBe(false);
    await expect(composingConfig.loadAgent('owned-agent')).rejects.toThrow(
      'not ready',
    );
    const permit = journal.claimActivation(selected.installation);
    await verifyPluginActivation(permit, journal, async () => {});
    expect(journal.completeActivation(permit)).toEqual({ state: 'applied' });
    expect(reserved.claim.enterEffectBoundary()).toEqual({ state: 'blocked' });
    expect(loader.listInstalled()).toHaveLength(1);
    expect((await config.loadAgent('owned-agent')).name).toBe('owned-agent');
    expect(loader.skillSources()).toHaveLength(1);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
