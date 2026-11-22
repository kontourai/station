import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPluginLifecycleResponse } from '@kontourai/station-contracts/plugin';
import { expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  PLUGIN_ACTIVATION_STOPPED_REASON,
  StationRuntime,
} from '../../../runtime/bootstrap/station-runtime.js';
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
test('an install whose activation outruns its deadline is saved but not active, says so, stays inactive until recovered, and owes its trusted approval until then', {
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
    const readiness = async () =>
      ((await (await app.request('/')).json()) as any).plugins.find(
        (plugin: any) => plugin.name === 'slow-activation',
      )?.installationReadiness;
    const openHostApproval = () =>
      app.request('/host-approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost:3141' },
        body: JSON.stringify({
          pluginName: 'slow-activation',
          permissions: ['plugin.server'],
        }),
      });

    const preview = (await (
      await app.request('/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      })
    ).json()) as any;
    const response = await app.request('/install', {
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
    const body = (await response.json()) as any;

    // The designed acceptance, read the way every client now reads it, and
    // a reason that does not promise a background activation nothing runs.
    expect(response.status, JSON.stringify(body)).toBe(202);
    expect(readPluginLifecycleResponse(response.status, body)).toEqual({
      state: 'saved',
      unapplied: {
        kind: 'activation',
        recovery: 'required',
        deadlineMs: 200,
        reason: PLUGIN_ACTIVATION_STOPPED_REASON,
      },
    });
    expect(body.plugin).toMatchObject({ name: 'slow-activation' });
    // Consent: the install decision never grants the trusted tier, so it is
    // genuinely still owed...
    expect(body.permissions.pendingConsent).toEqual([
      { permission: 'plugin.server', tier: 'trusted' },
    ]);
    expect(await readiness()).toEqual({ state: 'pending', recovery: 'review' });
    // ...but its host review cannot be opened for a plugin that is not
    // active, so a prompt now would take a yes nothing can record.
    const early = await openHostApproval();
    expect(early.status).toBe(404);

    // The abandoned pass finishing, and the reconciliation rail's own reload,
    // do not make the plugin ready: only a person's recovery does.
    release();
    // Settled either way; it is barred from publishing readiness.
    await vi.waitFor(
      () =>
        expect(
          [...logger.info.mock.calls, ...logger.error.mock.calls].map(
            (call: unknown[]) => call[0],
          ),
        ).toEqual(
          expect.arrayContaining([
            expect.stringMatching(
              /^Abandoned runtime activation (finished|failed)/,
            ),
          ]),
        ),
      { timeout: 10_000 },
    );
    await runtime.reloadConfigurationFromDisk();
    expect(await readiness()).toEqual({ state: 'pending', recovery: 'review' });

    const review = (await (
      await app.request('/slow-activation/recovery-preview')
    ).json()) as any;
    const recovered = await app.request('/slow-activation/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recoveryRevision: review.recoveryRevision,
        consent: {
          contentDigest: review.contentDigest,
          grantRevision: review.grantRevision,
          permissions: review.permissions.required,
          dependencies: [],
          dependencyApprovals: [],
        },
      }),
    });
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    expect(await readiness()).toEqual({ state: 'ready' });
    // Now, and only now, the owed approval can be asked for.
    expect((await openHostApproval()).status).toBe(200);

    // A removal activates nothing. Held past the deadline it is saved, the
    // runtime is told to reconcile (which finishes unloading it), and its
    // reason says the work continues, which for a removal is true.
    hold();
    runtime.scheduleAgentConfigurationReconciliation.mockClear();
    const removal = await app.request('/slow-activation', { method: 'DELETE' });
    const removed = (await removal.json()) as any;
    expect(removal.status, JSON.stringify(removed)).toBe(202);
    expect(readPluginLifecycleResponse(removal.status, removed)).toEqual({
      state: 'saved',
      unapplied: {
        kind: 'activation',
        recovery: 'none',
        deadlineMs: 200,
        reason: expect.stringContaining('continuing in the background'),
      },
    });
    expect(runtime.scheduleAgentConfigurationReconciliation).toHaveBeenCalled();
    expect(await readiness()).toBeUndefined();
  } finally {
    release();
    for (const timer of runtime.timers) clearTimeout(timer);
    store.close();
  }
});
