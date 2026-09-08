import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  clearPluginProviders,
  getProvider,
} from '../../../providers/registries/registry.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { createConsentApp } from '../../../runtime/consent/consent-listener.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  closePluginActivationSession,
  createPluginActivationSession,
} from '../../../services/plugins/plugin-activation-composition.js';
import { derivePluginConsentBasis } from '../../../services/plugins/plugin-install-consent.js';
import { readPluginManifestFile } from '../../../services/plugins/plugin-manifest-loader.js';
import {
  getPluginGrants,
  revokeGrants,
} from '../../../services/plugins/plugin-permissions.js';
import { installPluginFromSource } from '../plugin-install-shared.js';
import { createPluginRoutes } from '../plugins.js';

test('retained recovery reaches separate trusted approval without exposing pending or ungranted modules', {
  timeout: 20_000,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'station-trusted-recovery-'));
  const store = new EventStore(join(home, 'events.sqlite'));
  const session = createPluginActivationSession();
  const channel = new ConsentChannelService();
  channel.markListening(4978);
  const credential = 'O'.repeat(43);
  const consent = createConsentApp({
    channel,
    credentials: {
      verifyOperatorCredential: (candidate) => candidate === credential,
      identifyDevice: () => null,
    },
  });
  const pluginsDir = join(home, 'plugins'),
    source = join(home, 'source');
  const serverWitness = join(home, 'server-imported'),
    providerWitness = join(home, 'provider-imported');
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
  const journal = store.createPackageMcpAdmissionJournal();
  const deps = {
    projectHomeDir: home,
    pluginsDir,
    agentsDir: join(home, 'agents'),
    packageMcpJournal: journal,
    logger,
    buildPlugin: async () => {},
  };
  try {
    mkdirSync(pluginsDir);
    mkdirSync(source);
    writeFileSync(
      join(source, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'trusted-recovery',
        version: '1.0.0',
        extensions: {
          'io.kontourai.station': {
            schemaVersion: '1.0',
            serverModule: './server.mjs',
            providers: [{ type: 'branding', module: './provider.mjs' }],
          },
        },
      }),
    );
    writeFileSync(
      join(source, 'server.mjs'),
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(serverWitness)},'imported'); export function register(app){app.get('/ping',c=>c.text('approved'));}`,
    );
    writeFileSync(
      join(source, 'provider.mjs'),
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(providerWitness)},'imported'); export default {getAppName:()=> 'Recovered trusted provider'};`,
    );
    const basis = derivePluginConsentBasis(
      source,
      await readPluginManifestFile(join(source, 'plugin.json')),
    )!;
    await installPluginFromSource(source, [], deps, {
      activationSession: session,
      consent: {
        kind: 'operator-decision',
        contentDigest: basis.contentDigest,
        permissions: basis.required,
        dependencies: basis.dependencies,
      },
    });
    closePluginActivationSession(session);
    rmSync(source, { recursive: true, force: true });
    unlinkSync(join(pluginsDir, 'trusted-recovery'));
    // Real configuration mutation/ready owner; this fixture declares no Agents,
    // so the controlled empty rebuild does not stand in for model execution.
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationPersistenceQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.agentConfigurationActivationDeadlineMs = 1000;
    runtime.agentMetadataMap = new Map();
    runtime.logger = logger;
    runtime.reloadConfigurationFromDisk = async () => {};
    const app = createPluginRoutes(home, logger, undefined, {
      applyConfigurationMutation: (operation, options) =>
        runtime.applyAgentConfigurationMutation(operation, options),
      packageMcpJournal: journal,
      consentChannel: channel,
      settleProviderAdapterRetirements: async () => {},
      reconcileEngineConnections: async () => {},
      removeEngineConnections: async () => {},
      quiesceEventSubscriptions: async () => ({ release() {} }),
      reconcileEventSubscriptions: async () => ({ kind: 'applied' }),
    });
    const open = () =>
      app.request('/host-approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost:3141' },
        body: JSON.stringify({
          pluginName: 'trusted-recovery',
          permissions: ['plugin.server', 'providers.register'],
        }),
      });
    expect((await open()).status).not.toBe(200);
    const preview = (await (
      await app.request('/trusted-recovery/recovery-preview')
    ).json()) as any;
    const recovered = await app.request('/trusted-recovery/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recoveryRevision: preview.recoveryRevision,
        consent: {
          contentDigest: preview.contentDigest,
          grantRevision: preview.grantRevision,
          permissions: preview.permissions.required,
          dependencies: [],
          dependencyApprovals: [],
        },
      }),
    });
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    const result = (await recovered.json()) as any;
    expect(
      result.permissions.pendingConsent
        .map((entry: any) => entry.permission)
        .sort(),
    ).toEqual(['plugin.server', 'providers.register']);
    const selected = journal.currentInstallation('trusted-recovery');
    if (selected.state !== 'observed')
      throw new Error('Recovery lost selection');
    expect(journal.admissionOpen(selected.installation)).toBe(true);
    unlinkSync(join(pluginsDir, 'trusted-recovery'));
    expect((await app.request('/trusted-recovery/ping')).status).not.toBe(200);
    expect(existsSync(serverWitness)).toBe(false);
    expect(existsSync(providerWitness)).toBe(false);
    const decide = async (id: string) => {
      const review = await consent.request(`/consent/${id}`, {
        headers: {
          host: 'localhost:4978',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          cookie: `station-device=${credential}`,
        },
      });
      const nonce = (await review.text()).match(
        /name="nonce" value="([^"]+)"/,
      )?.[1];
      expect(nonce).toBeTruthy();
      await consent.request(`/consent/${id}/decide`, {
        method: 'POST',
        headers: {
          host: 'localhost:4978',
          origin: 'http://localhost:4978',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-user': '?1',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `station-device=${credential}`,
        },
        body: new URLSearchParams({
          decision: 'approve',
          nonce: nonce!,
        }).toString(),
      });
      return (
        (await (await app.request(`/host-approvals/${id}`)).json()) as any
      ).approval;
    };
    const proposal = await open();
    expect(proposal.status).toBe(200);
    const stale = ((await proposal.json()) as any).approval.id;
    await revokeGrants(home, 'trusted-recovery', ['plugin.server']);
    expect((await decide(stale)).status).not.toBe('approved');
    expect(getPluginGrants(home, 'trusted-recovery')).not.toContain(
      'plugin.server',
    );
    expect(existsSync(serverWitness)).toBe(false);
    expect(existsSync(providerWitness)).toBe(false);
    const fresh = await open();
    expect(fresh.status).toBe(200);
    expect(
      (await decide(((await fresh.json()) as any).approval.id)).status,
    ).toBe('approved');
    await vi.waitFor(
      () =>
        expect(
          getProvider<{ getAppName(): string }>('branding')?.getAppName(),
        ).toBe('Recovered trusted provider'),
      { timeout: 5000 },
    );
    expect(await (await app.request('/trusted-recovery/ping')).text()).toBe(
      'approved',
    );
    expect(readFileSync(serverWitness, 'utf8')).toBe('imported');
    expect(readFileSync(providerWitness, 'utf8')).toBe('imported');
  } finally {
    closePluginActivationSession(session);
    clearPluginProviders();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
