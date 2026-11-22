import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { createPluginRoutes } from '../plugins.js';
import { operatorPluginVisibility } from './plugin-visibility-test-support.js';

const makeTempDir = trackTempDirs();

/**
 * The install a slow host produces: the real route and the real runtime
 * mutation owner, with the rebuild held past the activation deadline (the
 * seam the runtime's own activation tests use). What the client is told, and
 * what it can do next, both come from here.
 */
/**
 * A list read made while the install request is still open must not say the
 * plugin needs recovery: the activation is in flight and settles by itself.
 * Only once the deadline has stopped it does the row read `pending`.
 */
test('the plugin list reports an in-flight activation as activating, and needs recovery only once it was stopped', {
  timeout: 30_000,
}, async () => {
  const home = makeTempDir('station-install-pending-');
  const store = new EventStore(join(home, 'events.sqlite'));
  const channel = new ConsentChannelService();
  channel.markListening(4978);
  const pluginsDir = join(home, 'plugins');
  const source = join(home, 'source');
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
  const journal = store.createPackageMcpAdmissionJournal();
  const runtime = Object.create(StationRuntime.prototype) as any;
  runtime.timers = [];
  let release = () => {};
  try {
    mkdirSync(pluginsDir);
    mkdirSync(source);
    writeFileSync(
      join(source, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'slow-activation',
        version: '1.0.0',
        extensions: {
          'io.kontourai.station': {
            schemaVersion: '1.0',
            serverModule: './server.mjs',
          },
        },
      }),
    );
    writeFileSync(
      join(source, 'server.mjs'),
      `export function register(app){app.get('/ping',c=>c.text('ok'));}`,
    );
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationPersistenceQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.agentConfigurationActivationDeadlineMs = 200;
    runtime.agentMetadataMap = new Map();
    runtime.logger = logger;
    runtime.scheduleAgentConfigurationReconciliation = vi.fn();
    // The next runtime pass waits on this gate; each hold blocks one pass.
    let gate: Promise<void> | undefined;
    const hold = () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    hold();
    runtime.reloadConfigurationFromDisk = vi.fn(async () => {
      const blocked = gate;
      gate = undefined;
      if (blocked) await blocked;
    });
    const app = withOperatorPrincipal(
      createPluginRoutes(home, logger, undefined, {
        visibility: operatorPluginVisibility(home),
        applyConfigurationMutation: (operation, options) =>
          runtime.applyAgentConfigurationMutation(operation, options),
        packageMcpJournal: journal,
        consentChannel: channel,
        settleProviderAdapterRetirements: async () => {},
        reconcileEngineConnections: async () => {},
        removeEngineConnections: async () => {},
        quiesceEventSubscriptions: async () => ({ release() {} }),
        reconcileEventSubscriptions: async () => ({ kind: 'applied' }),
      }),
    );
    const row = async () =>
      ((await (await app.request('/')).json()) as any).plugins.find(
        (plugin: any) => plugin.name === 'slow-activation',
      );
    const preview = (await (
      await app.request('/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      })
    ).json()) as any;
    const installing = app.request('/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source,
        skip: [],
        consent: {
          contentDigest: preview.contentDigest,
          grantRevision: preview.grantRevision,
          permissions: preview.permissions.required,
          dependencies: [],
        },
      }),
    });
    // The runtime rebuild is held: the request is open and activating.
    await vi.waitFor(() =>
      expect(runtime.reloadConfigurationFromDisk).toHaveBeenCalled(),
    );
    expect(await row()).toMatchObject({
      installationReadiness: { state: 'pending', recovery: 'review' },
      activationInFlight: true,
    });

    const response = await installing;
    expect(response.status).toBe(202);
    const stopped = await row();
    expect(stopped.installationReadiness).toEqual({
      state: 'pending',
      recovery: 'review',
    });
    expect(stopped.activationInFlight).toBeUndefined();
  } finally {
    release();
    for (const timer of runtime.timers) clearTimeout(timer);
    store.close();
  }
});
