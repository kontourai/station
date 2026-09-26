/**
 * Plugin command effects against the lifecycle changes that withdraw them
 * (kontourai/station#1418, #1419).
 *
 * Every case drives REAL route compositions (`createPluginRoutes`, and
 * `createRegistryRoutes` for the registry rows) over a real Station home:
 * removal, legacy Git update, registry removal, registry install-over,
 * `plugin.server` revocation, a grant against a changed binding, and a
 * host-approval regrant decided through the real consent listener.
 * Interleavings are forced with promise gates at named seams — the awaited
 * requirement check, or immediately before the ledger append inside every lock
 * and lease the append runs under — never with sleeps that decide an outcome.
 * The only timer bounds how long a serialized change is observed to stay
 * blocked.
 *
 * Invariants:
 * - I1: a withdrawal reads `completed` only when every captured effect
 *   settled with proof.
 * - I3: no effect is admitted after its authority's withdrawal point.
 * - I4: capacity refuses new admissions and never evicts an outstanding
 *   effect; only an operator's resolution frees it.
 * - F1: a lifecycle change commits even when the ledger cannot record it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PluginCommandEffectReceipt,
  PluginCommandEffectsWithdrawalSummary,
  PluginCommandWithdrawalProjection,
} from '@kontourai/station-contracts/plugin-command-effect';
import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import type { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  clearAll,
  registerPluginRegistryProvider,
} from '../../../providers/registries/registry.js';
import { createConsentApp } from '../../../runtime/consent/consent-listener.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { grantPermissions } from '../../../services/plugins/plugin-permissions.js';
import { capturePluginRuntimeArtifact } from '../../../services/plugins/plugin-runtime-artifact.js';
import { PluginVisibilityService } from '../../../services/plugins/plugin-visibility-service.js';
import { createPluginRoutes } from '../plugins.js';
import { createRegistryRoutes } from '../registry.js';
import { TEST_OPERATOR_PRINCIPAL } from './plugin-visibility-test-support.js';

// Removed in an after-hook even when an assertion fails (#2421).
const makeTempDir = trackTempDirs();

const CONSENT_PORT = 4979;
const CONSENT_HOST = `localhost:${CONSENT_PORT}`;
const OPERATOR_CREDENTIAL = 'O'.repeat(43);
const DOCUMENT_ID = 'document-lifecycle-1';
const DOCUMENT_KEY = 'd'.repeat(43);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  clearAll();
});

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const OPEN = {
  version: '1.0',
  id: 'demo.open',
  title: 'Open plugins',
  requires: ['project'],
  intent: { kind: 'navigate', surfaceId: 'plugins' },
};
const SERVE = {
  version: '1.0',
  id: 'demo.serve',
  title: 'Draft from the server',
  requires: ['plugin-server', 'project'],
  intent: { kind: 'seed-composer', text: 'Summarize with the plugin server' },
};

function writePlugin(dir: string, version: string, behavior = 'reviewed') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      name: 'demo',
      version,
      serverModule: 'server.mjs',
      permissions: ['system.config', 'ui.confirm'],
      commands: [OPEN, SERVE],
    }),
  );
  writeFileSync(
    join(dir, 'server.mjs'),
    `export const behavior = ${JSON.stringify(behavior)};\n`,
  );
}

function git(cwd: string, ...args: string[]) {
  execFileSync(
    'git',
    [
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'user.name=Fixture',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'ignore', windowsHide: true },
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type GateSeam = 'requirement' | 'record';
type Harness = ReturnType<typeof harness>;

function harness(
  options: {
    source?: 'plain' | 'git' | 'registry';
    caller?: PrincipalRef;
    hosted?: boolean;
    /** Compose grant reconciliation so approvals can reach `completed`. */
    reconciliation?: boolean;
  } = {},
) {
  const home = makeTempDir('station-command-lifecycle-');
  // Registry routes read through the Station home schema gate.
  ensureStationHomeSchemaSync(home);
  const plugins = join(home, 'plugins');
  const pluginDir = join(plugins, 'demo');
  const source = join(home, 'source-demo');
  if (options.source === 'git') {
    writePlugin(source, '1.0.0');
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'add', '.');
    git(source, 'commit', '-q', '-m', 'initial');
    mkdirSync(plugins, { recursive: true });
    git(plugins, 'clone', '-q', source, 'demo');
  } else if (options.source === 'registry') {
    writePlugin(source, '1.0.0');
    mkdirSync(plugins, { recursive: true });
    registerPluginRegistryProvider({
      registryKey: 'lifecycle-test-registry',
      listAvailable: async () => [],
      listInstalled: async () => [],
      resolveSource: async (id: string) => (id === 'demo' ? source : null),
      install: async () => ({ success: false, message: 'unused' }),
      uninstall: async () => ({ success: false, message: 'unused' }),
    } as never);
  } else {
    writePlugin(pluginDir, '1.0.0');
  }
  const clock = { now: Date.now() };
  const gates: Partial<
    Record<
      GateSeam,
      {
        entered: ReturnType<typeof deferred>;
        release: ReturnType<typeof deferred>;
      }
    >
  > = {};
  const pass = async (seam: GateSeam) => {
    const gate = gates[seam];
    if (!gate) return;
    delete gates[seam];
    gate.entered.resolve();
    await gate.release.promise;
  };
  const channel = new ConsentChannelService();
  channel.markListening(CONSENT_PORT);
  const consentApp = createConsentApp({
    channel,
    credentials: {
      verifyOperatorCredential: (candidate) =>
        candidate === OPERATOR_CREDENTIAL,
      identifyDevice: () => null,
    },
  });
  const visibility = new PluginVisibilityService(home);
  const caller = options.caller ?? TEST_OPERATOR_PRINCIPAL;
  const mount = () =>
    createPluginRoutes(home, logger, undefined, {
      visibility: {
        service: visibility,
        resolvePrincipal: () => caller,
        listKnownPrincipals: () => [],
      },
      consentChannel: channel,
      applyConfigurationMutation: undefined as never,
      settleProviderAdapterRetirements: async () => {},
      ...(options.reconciliation
        ? {
            quiesceEventSubscriptions: async () => ({ release() {} }),
            reconcileEventSubscriptions: async () => ({
              kind: 'applied' as const,
            }),
            removeEngineConnections: async () => {},
            reconcileEngineConnections: async () => {},
          }
        : {}),
      commandEffects: {
        isHostedDeployment: () => options.hosted === true,
        publishAudit: () => true,
        now: () => new Date(Math.max(clock.now, Date.now())),
        indeterminateAfterMs: 60_000,
        resolveRequirement: async () => {
          await pass('requirement');
          return 'available';
        },
        beforeRecord: () => pass('record'),
      },
    });
  const mountRegistry = () =>
    createRegistryRoutes(
      { getProjectHomeDir: () => home } as never,
      async () => {},
      undefined,
      undefined,
      { logger } as never,
    );
  let app = mount();
  let registryApp: Hono = mountRegistry();
  return {
    home,
    plugins,
    pluginDir,
    source,
    consentApp,
    visibility,
    get app() {
      return app;
    },
    get registryApp() {
      return registryApp;
    },
    restart() {
      app = mount();
      registryApp = mountRegistry();
    },
    advance(ms: number) {
      clock.now = Math.max(clock.now, Date.now()) + ms;
    },
    /** The next admission stops at `seam` until released. */
    gate(seam: GateSeam) {
      const gate = { entered: deferred(), release: deferred() };
      gates[seam] = gate;
      return gate;
    },
  };
}

async function generation(h: Harness, name = 'demo'): Promise<string> {
  const body = (await (await h.app.request('/')).json()) as {
    plugins: Array<{ name: string; installationGeneration?: string }>;
  };
  const record = body.plugins.find((plugin) => plugin.name === name);
  if (!record?.installationGeneration)
    throw new Error(`${name} has no ready installation generation`);
  return record.installationGeneration;
}

let requestSequence = 0;
function nextRequestId() {
  requestSequence += 1;
  return `request-${String(requestSequence).padStart(6, '0')}`;
}

function admissionBody(
  command: 'open' | 'serve',
  installationGeneration: string,
  requestId: string,
) {
  return {
    documentId: DOCUMENT_ID,
    documentKey: DOCUMENT_KEY,
    requestId,
    issuedAt: Date.now(),
    installationGeneration,
    commandId: command === 'open' ? OPEN.id : SERVE.id,
    target:
      command === 'open'
        ? { kind: 'destination', destinationId: 'plugins' }
        : { kind: 'composer', sessionId: 'session-1' },
    context: {
      projectSlug: 'demo-project',
      activeChatSessionId: 'session-1',
    },
  };
}

function admit(
  h: Harness,
  command: 'open' | 'serve',
  installationGeneration: string,
  requestId = nextRequestId(),
  plugin = 'demo',
) {
  return {
    requestId,
    response: h.app.request(`/${plugin}/command-effects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        admissionBody(command, installationGeneration, requestId),
      ),
    }),
  };
}

async function receiptOf(response: Response | Promise<Response>) {
  const resolved = await response;
  const body = (await resolved.json()) as {
    receipt?: PluginCommandEffectReceipt;
  };
  expect(resolved.status, JSON.stringify(body)).toBe(200);
  return body.receipt!;
}

async function refusalOf(response: Response | Promise<Response>) {
  const resolved = await response;
  const body = (await resolved.json()) as { reason?: string };
  expect(resolved.status).not.toBe(200);
  return body.reason;
}

async function settle(
  h: Harness,
  items: Array<{ requestId: string; effectId?: string; outcome: string }>,
) {
  const response = await h.app.request('/command-effects/settlements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      documentId: DOCUMENT_ID,
      documentKey: DOCUMENT_KEY,
      items,
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      results: Array<{ requestId: string; status: string }>;
    },
  };
}

async function withdrawalOf(
  h: Harness,
  id: string,
): Promise<PluginCommandWithdrawalProjection> {
  const response = await h.app.request(`/command-effects/withdrawals/${id}`);
  expect(response.status).toBe(200);
  return (
    (await response.json()) as { withdrawal: PluginCommandWithdrawalProjection }
  ).withdrawal;
}

/** Resolves to 'pending' when the promise has not settled within the bound. */
async function stateOf(promise: Promise<unknown>, boundMs = 150) {
  return Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) =>
      setTimeout(() => resolve('pending'), boundMs),
    ),
  ]);
}

interface LifecycleResult {
  status: number;
  approvalId?: string;
  commandEffects?: PluginCommandEffectsWithdrawalSummary;
  commandEffectsUnavailable?: boolean;
}

interface Lifecycle {
  name: string;
  command: 'open' | 'serve';
  source?: 'plain' | 'git' | 'registry';
  /** Waits on the admission's plugin content lock. */
  serialized: boolean;
  /**
   * Where the gated admission stops: inside the requirement check, or just
   * before the append inside the content lock and (for `serve`) the grants
   * lease — the seam an unserialized grant withdrawal must wait on.
   */
  gateSeam: GateSeam;
  /** How the gated admission ends when this change contends with it. */
  gatedAdmission: 'admitted' | 'permission-unavailable';
  /** A fresh admission of the withdrawn authority after the change. */
  staleRefusal: string;
  /** Out-of-band byte change this grant path needs, applied before the change. */
  alterBytes?(h: Harness): void;
  prepare(h: Harness): Promise<void>;
  /** The durable authority change itself (after any `alterBytes`). */
  commit(h: Harness): Promise<LifecycleResult>;
  /** For the capacity case: make a current generation admissible again. */
  readmit?(h: Harness): Promise<void>;
}

async function grantServer(h: Harness) {
  const artifact = capturePluginRuntimeArtifact(h.plugins, 'demo');
  if (!artifact) throw new Error('fixture plugin is not installed');
  await grantPermissions(h.home, 'demo', ['plugin.server'], artifact);
}

async function jsonResult(response: Response): Promise<LifecycleResult> {
  const body = (await response.json()) as {
    commandEffects?: PluginCommandEffectsWithdrawalSummary;
    commandEffectsUnavailable?: boolean;
  };
  expect(response.status, JSON.stringify(body)).toBeLessThan(300);
  return {
    status: response.status,
    commandEffects: body.commandEffects,
    commandEffectsUnavailable: body.commandEffectsUnavailable,
  };
}

async function registryInstall(h: Harness): Promise<Response> {
  const preview = (await (
    await h.app.request('/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ registryId: 'demo' }),
    })
  ).json()) as {
    contentDigest: string;
    grantRevision?: string;
    registryTrustRevision?: string;
    permissions: { required: string[] };
  };
  return h.registryApp.request('/plugins/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'demo',
      consent: {
        permissions: preview.permissions.required,
        contentDigest: preview.contentDigest,
        grantRevision: preview.grantRevision,
        registryTrustRevision: preview.registryTrustRevision,
        dependencies: [],
      },
    }),
  });
}

function changeServerBytes(h: Harness) {
  writeFileSync(
    join(h.pluginDir, 'server.mjs'),
    'export const behavior = "changed";\n',
  );
}

async function approveTrusted(h: Harness): Promise<LifecycleResult> {
  const opened = await h.app.request('/host-approvals', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost:3141' },
    body: JSON.stringify({
      pluginName: 'demo',
      permissions: ['system.config'],
    }),
  });
  expect(opened.status).toBe(200);
  const { approval } = (await opened.json()) as { approval: { id: string } };
  const review = await h.consentApp.request(`/consent/${approval.id}`, {
    headers: {
      host: CONSENT_HOST,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      cookie: `station-device=${OPERATOR_CREDENTIAL}`,
    },
  });
  const nonce = (await review.text()).match(
    /name="nonce" value="([^"]+)"/,
  )?.[1];
  expect(nonce).toBeTruthy();
  const decided = await h.consentApp.request(`/consent/${approval.id}/decide`, {
    method: 'POST',
    headers: {
      host: CONSENT_HOST,
      origin: `http://${CONSENT_HOST}`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-user': '?1',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `station-device=${OPERATOR_CREDENTIAL}`,
    },
    body: new URLSearchParams({
      decision: 'approve',
      nonce: nonce!,
    }).toString(),
  });
  expect(decided.status).toBe(200);
  const status = (await (
    await h.app.request(`/host-approvals/${approval.id}`)
  ).json()) as {
    approval: {
      status: string;
      reconciliation?: {
        status: string;
        failures?: string[];
        commandEffects?: PluginCommandEffectsWithdrawalSummary;
      };
    };
  };
  expect(status.approval.status).toBe('approved');
  return {
    status: decided.status,
    approvalId: approval.id,
    commandEffects: status.approval.reconciliation?.commandEffects,
    commandEffectsUnavailable:
      status.approval.reconciliation?.failures?.includes('command-effects') ||
      undefined,
  };
}

const LIFECYCLES: Lifecycle[] = [
  {
    name: 'removal',
    command: 'open',
    serialized: true,
    gateSeam: 'requirement',
    gatedAdmission: 'admitted',
    staleRefusal: 'not-found',
    prepare: async () => {},
    commit: async (h) =>
      jsonResult(await h.app.request('/demo', { method: 'DELETE' })),
    readmit: async (h) => writePlugin(h.pluginDir, '2.0.0'),
  },
  {
    name: 'legacy git update',
    command: 'open',
    source: 'git',
    serialized: true,
    gateSeam: 'requirement',
    gatedAdmission: 'admitted',
    staleRefusal: 'generation-changed',
    prepare: async () => {},
    commit: async (h) => {
      writePlugin(h.source, '1.1.0');
      git(h.source, 'commit', '-q', '-am', 'update');
      return jsonResult(
        await h.app.request('/demo/update', { method: 'POST' }),
      );
    },
  },
  {
    name: 'registry removal',
    command: 'open',
    serialized: true,
    gateSeam: 'requirement',
    gatedAdmission: 'admitted',
    staleRefusal: 'not-found',
    prepare: async () => {},
    commit: async (h) =>
      jsonResult(
        await h.registryApp.request('/plugins/demo', { method: 'DELETE' }),
      ),
    readmit: async (h) => writePlugin(h.pluginDir, '2.0.0'),
  },
  {
    name: 'registry install-over',
    command: 'open',
    source: 'registry',
    serialized: true,
    gateSeam: 'requirement',
    gatedAdmission: 'admitted',
    staleRefusal: 'generation-changed',
    prepare: async (h) => {
      await jsonResult(await registryInstall(h));
    },
    commit: async (h) => {
      writePlugin(h.source, '1.1.0');
      return jsonResult(await registryInstall(h));
    },
  },
  {
    name: 'plugin.server revoke',
    command: 'serve',
    serialized: true,
    gateSeam: 'record',
    gatedAdmission: 'admitted',
    staleRefusal: 'permission-unavailable',
    prepare: grantServer,
    commit: async (h) =>
      jsonResult(
        await h.app.request('/demo/grant', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ permissions: ['plugin.server'] }),
        }),
      ),
  },
  {
    name: 'grant over changed binding',
    command: 'serve',
    serialized: false,
    gateSeam: 'requirement',
    gatedAdmission: 'permission-unavailable',
    staleRefusal: 'generation-changed',
    prepare: grantServer,
    alterBytes: changeServerBytes,
    commit: async (h) => {
      const response = await h.app.request('/demo/grant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: ['ui.confirm'] }),
      });
      const body = (await response.clone().json()) as { withdrawn?: string[] };
      expect(body.withdrawn).toContain('plugin.server');
      return jsonResult(response);
    },
  },
  {
    name: 'host-approval regrant',
    command: 'serve',
    serialized: true,
    gateSeam: 'requirement',
    gatedAdmission: 'permission-unavailable',
    staleRefusal: 'generation-changed',
    prepare: grantServer,
    alterBytes: changeServerBytes,
    commit: approveTrusted,
  },
];

const run = async (lifecycle: Lifecycle, h: Harness) => {
  lifecycle.alterBytes?.(h);
  return lifecycle.commit(h);
};

describe.each(LIFECYCLES)('plugin command effects × $name', (lifecycle) => {
  const setup = async () => {
    const h = harness({ source: lifecycle.source });
    await lifecycle.prepare(h);
    return { h, before: await generation(h) };
  };

  test('I3: a withdrawal contending with an admission at its seam never admits after it', async () => {
    const { h } = await setup();
    // A grant path's authority is already withheld by its byte change, so the
    // admission contends with the current bytes, not the old generation.
    lifecycle.alterBytes?.(h);
    const current = await generation(h);
    const gate = h.gate(lifecycle.gateSeam);
    const admission = admit(h, lifecycle.command, current);
    await gate.entered.promise;
    const withdrawal = lifecycle.commit(h);
    if (lifecycle.serialized) {
      // It waits on the lock or lease the admission holds at this seam.
      expect(await stateOf(withdrawal)).toBe('pending');
    } else {
      await withdrawal;
    }
    gate.release.resolve();
    const response = await admission.response;
    const result = await withdrawal;

    if (lifecycle.gatedAdmission === 'admitted') {
      const receipt = await receiptOf(response);
      expect(result.status).toBe(202);
      expect(result.commandEffects).toMatchObject({
        status: 'winding-down',
        outstanding: 1,
      });
      expect(
        (await withdrawalOf(h, result.commandEffects!.withdrawalId))
          .outstandingEffectIds,
      ).toEqual([receipt.effectId]);
      await settle(h, [
        {
          requestId: admission.requestId,
          effectId: receipt.effectId,
          outcome: 'applied',
        },
      ]);
      expect(
        (await withdrawalOf(h, result.commandEffects!.withdrawalId)).status,
      ).toBe('completed');
    } else {
      // The derived grant binding refuses: `grantPermissions` can only
      // withdraw a permission the byte change already withheld.
      expect(await refusalOf(response)).toBe(lifecycle.gatedAdmission);
      expect(result.commandEffects).toBeUndefined();
    }
    expect(await refusalOf(admit(h, lifecycle.command, current).response)).toBe(
      lifecycle.alterBytes ? 'permission-unavailable' : lifecycle.staleRefusal,
    );
  });

  test('I1: a withdrawal after the append but before the receipt is read waits for its settlement', async () => {
    const { h, before } = await setup();
    const admission = admit(h, lifecycle.command, before);
    const response = await admission.response;
    expect(response.status).toBe(200);
    const result = await run(lifecycle, h);
    if (lifecycle.name !== 'host-approval regrant')
      expect(result.status).toBe(202);
    expect(result.commandEffects).toMatchObject({
      status: 'winding-down',
      outstanding: 1,
    });
    const receipt = await receiptOf(response);
    const id = result.commandEffects!.withdrawalId;
    expect((await withdrawalOf(h, id)).outstandingEffectIds).toEqual([
      receipt.effectId,
    ]);
    expect(await refusalOf(admit(h, lifecycle.command, before).response)).toBe(
      lifecycle.staleRefusal,
    );
    await settle(h, [
      {
        requestId: admission.requestId,
        effectId: receipt.effectId,
        outcome: 'applied',
      },
    ]);
    expect(await withdrawalOf(h, id)).toMatchObject({
      status: 'completed',
      outstanding: 0,
    });
  });

  test('duplicate and out-of-order settlements: first terminal wins and completion never regresses', async () => {
    const { h, before } = await setup();
    const admission = admit(h, lifecycle.command, before);
    const receipt = await receiptOf(admission.response);
    const result = await run(lifecycle, h);
    const id = result.commandEffects!.withdrawalId;
    const mismatched = await settle(h, [
      {
        requestId: admission.requestId,
        effectId: 'pce-not-this-effect',
        outcome: 'applied',
      },
    ]);
    expect(mismatched.body.results[0]?.status).toBe('not-found');
    const cancelled = await settle(h, [
      { requestId: admission.requestId, outcome: 'cancelled' },
    ]);
    expect(cancelled.body.results).toEqual([
      { requestId: admission.requestId, status: 'settled' },
    ]);
    expect((await withdrawalOf(h, id)).status).toBe('completed');
    const duplicate = await settle(h, [
      { requestId: admission.requestId, outcome: 'cancelled' },
    ]);
    expect(duplicate.body.results[0]?.status).toBe('already-settled');
    const late = await settle(h, [
      {
        requestId: admission.requestId,
        effectId: receipt.effectId,
        outcome: 'applied',
      },
    ]);
    expect(late.status).toBe(409);
    expect(late.body.results[0]?.status).toBe('conflict');
    expect((await withdrawalOf(h, id)).status).toBe('completed');
  });

  test('a cancel recorded before the admission commits refuses it, and the withdrawal then captures nothing', async () => {
    const { h, before } = await setup();
    const gate = h.gate('requirement');
    const admission = admit(h, lifecycle.command, before);
    await gate.entered.promise;
    const cancel = await settle(h, [
      { requestId: admission.requestId, outcome: 'cancelled' },
    ]);
    expect(cancel.body.results[0]?.status).toBe('cancel-recorded');
    gate.release.resolve();
    expect(await refusalOf(admission.response)).toBe('cancelled');
    const result = await run(lifecycle, h);
    expect(result.commandEffects).toBeUndefined();
    expect(result.status).toBe(200);
  });

  test('a restart between admission and settlement keeps the withdrawal honest', async () => {
    const { h, before } = await setup();
    const admission = admit(h, lifecycle.command, before);
    const receipt = await receiptOf(admission.response);
    const result = await run(lifecycle, h);
    const id = result.commandEffects!.withdrawalId;
    h.restart();
    expect(await withdrawalOf(h, id)).toMatchObject({
      status: 'winding-down',
      outstandingEffectIds: [receipt.effectId],
    });
    await settle(h, [
      {
        requestId: admission.requestId,
        effectId: receipt.effectId,
        outcome: 'aborted',
      },
    ]);
    expect((await withdrawalOf(h, id)).status).toBe('completed');
  });

  test('I4: capacity exhausted by an indeterminate withdrawal refuses admissions until the operator resolves it', async () => {
    const { h, before } = await setup();
    const held: string[] = [];
    for (let index = 0; index < 8; index += 1)
      held.push(
        (await receiptOf(admit(h, lifecycle.command, before).response))
          .effectId,
      );
    const result = await run(lifecycle, h);
    const id = result.commandEffects!.withdrawalId;
    expect(result.commandEffects?.outstanding).toBe(8);
    await lifecycle.readmit?.(h);
    const current = await generation(h);
    if (lifecycle.name === 'plugin.server revoke') expect(current).toBe(before);
    else expect(current).not.toBe(before);
    expect(await refusalOf(admit(h, 'open', current).response)).toBe(
      'capacity',
    );
    const resolve = () =>
      h.app.request(`/command-effects/withdrawals/${id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disposition: 'accept-indeterminate' }),
      });
    expect((await resolve()).status).toBe(409);
    h.advance(60_000);
    const indeterminate = await withdrawalOf(h, id);
    expect(indeterminate).toMatchObject({
      status: 'indeterminate',
      outstanding: 8,
    });
    expect([...indeterminate.outstandingEffectIds].sort()).toEqual(
      [...held].sort(),
    );
    expect((await resolve()).status).toBe(200);
    expect(await withdrawalOf(h, id)).toMatchObject({
      status: 'closed-indeterminate',
      outstanding: 0,
    });
    await receiptOf(admit(h, 'open', current).response);
  });

  test('F1: a change commits even when its withdrawal cannot be recorded, and says so', async () => {
    const { h, before } = await setup();
    await receiptOf(admit(h, lifecycle.command, before).response);
    writeFileSync(join(h.home, 'plugin-command-effects.json'), 'not json');
    const result = await run(lifecycle, h);
    expect(result.commandEffects).toBeUndefined();
    expect(result.commandEffectsUnavailable).toBe(true);
    if (lifecycle.name !== 'host-approval regrant')
      expect(result.status).toBe(202);
    // The change itself committed: the withdrawn authority is gone.
    rmSync(join(h.home, 'plugin-command-effects.json'));
    expect(await refusalOf(admit(h, lifecycle.command, before).response)).toBe(
      lifecycle.staleRefusal,
    );
  });
});

describe('plugin command effects × coalescing across lifecycle routes', () => {
  test('a revoke then a removal of the same plugin answer with one withdrawal', async () => {
    const h = harness();
    await grantServer(h);
    const before = await generation(h);
    const admission = admit(h, 'serve', before);
    await receiptOf(admission.response);
    const revoked = await jsonResult(
      await h.app.request('/demo/grant', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: ['plugin.server'] }),
      }),
    );
    const removed = await jsonResult(
      await h.app.request('/demo', { method: 'DELETE' }),
    );
    expect(removed.commandEffects?.withdrawalId).toBe(
      revoked.commandEffects?.withdrawalId,
    );
    expect(
      await withdrawalOf(h, removed.commandEffects!.withdrawalId),
    ).toMatchObject({
      causes: ['grant-withdrawal', 'removal'],
      outstanding: 1,
    });
  });
});

describe('plugin command effect admission seams', () => {
  test('the currentness re-check refuses a navigate command whose bytes changed during the requirement wait', async () => {
    const h = harness();
    const current = await generation(h);
    const gate = h.gate('requirement');
    const admission = admit(h, 'open', current);
    await gate.entered.promise;
    // Not a lifecycle change: nothing but the post-wait re-check can notice.
    writeFileSync(join(h.pluginDir, 'server.mjs'), 'export const x = 1;\n');
    gate.release.resolve();
    expect(await refusalOf(admission.response)).toBe('generation-changed');
  });

  test('L1: an invisible installed plugin is refused exactly like one that was never installed', async () => {
    const collaborator = humanPrincipal(
      'device',
      'collaborator-device',
      'Collaborator',
    );
    const h = harness({ caller: collaborator });
    const current = await generation(harness());
    // The collaborator may see `ghost` — which does not exist — and not `demo`.
    await h.visibility.grant(collaborator.id, 'ghost');
    const body = JSON.stringify(
      admissionBody('open', current, nextRequestId()),
    );
    const invisible = await h.app.request('/demo/command-effects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const absent = await h.app.request('/ghost/command-effects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(invisible.status).toBe(404);
    expect(absent.status).toBe(invisible.status);
    expect(await absent.text()).toBe(await invisible.text());
    // The control: once visible, the same request reaches the plugin.
    await h.visibility.grant(collaborator.id, 'demo');
    const visible = await h.app.request('/demo/command-effects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(visible.status).not.toBe(404);
  });

  test('the receipt carries seed text read from the installed declaration', async () => {
    const h = harness();
    await grantServer(h);
    const receipt = await receiptOf(
      admit(h, 'serve', await generation(h)).response,
    );
    expect(receipt.effect).toEqual({
      kind: 'seed-composer',
      sessionId: 'session-1',
      text: SERVE.intent.text,
    });
  });
});

describe('plugin command effect operator routes', () => {
  const operatorPaths = [
    ['GET', '/command-effects/withdrawals'],
    ['GET', '/command-effects/withdrawals/pcw-anything'],
    ['POST', '/command-effects/withdrawals/pcw-anything/resolve'],
    ['GET', '/command-effects/uncaptured'],
    ['POST', '/command-effects/effects/pce-anything/abandon'],
  ] as const;

  test.each(operatorPaths)('%s %s is operator-only', async (method, path) => {
    const collaborator = harness({
      caller: { id: 'device:collaborator', kind: 'human', display: 'Other' },
    });
    const refused = await collaborator.app.request(path, {
      method,
      ...(method === 'POST'
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ disposition: 'accept-indeterminate' }),
          }
        : {}),
    });
    expect(refused.status).toBe(403);
    const operator = harness();
    const reached = await operator.app.request(path, {
      method,
      ...(method === 'POST'
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ disposition: 'accept-indeterminate' }),
          }
        : {}),
    });
    expect(reached.status).not.toBe(403);
  });

  test('F6: hosted deployments refuse every command-effect route', async () => {
    const h = harness({ hosted: true });
    const current = await generation(harness());
    const paths = [
      ['POST', '/demo/command-effects'],
      ['POST', '/command-effects/settlements'],
      ...operatorPaths,
    ] as const;
    for (const [method, path] of paths) {
      const response = await h.app.request(path, {
        method,
        ...(method === 'POST'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(
                admissionBody('open', current, nextRequestId()),
              ),
            }
          : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  test('M1/M2: the operator lists withdrawals and uncaptured effects, and abandons an aged uncaptured one', async () => {
    const h = harness();
    await grantServer(h);
    const current = await generation(h);
    const loose = await receiptOf(admit(h, 'open', current).response);
    const held = await receiptOf(admit(h, 'serve', current).response);
    const revoked = await jsonResult(
      await h.app.request('/demo/grant', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: ['plugin.server'] }),
      }),
    );
    const listed = (await (
      await h.app.request('/command-effects/withdrawals')
    ).json()) as { withdrawals: PluginCommandWithdrawalProjection[] };
    expect(listed.withdrawals).toEqual([
      expect.objectContaining({
        withdrawalId: revoked.commandEffects!.withdrawalId,
        outstandingEffectIds: [held.effectId],
      }),
    ]);
    const uncaptured = (await (
      await h.app.request('/command-effects/uncaptured')
    ).json()) as { effects: Array<{ effectId: string; abandonable: boolean }> };
    expect(uncaptured.effects).toEqual([
      expect.objectContaining({ effectId: loose.effectId, abandonable: false }),
    ]);
    const abandon = (effectId: string) =>
      h.app.request(`/command-effects/effects/${effectId}/abandon`, {
        method: 'POST',
      });
    expect((await abandon(loose.effectId)).status).toBe(409);
    h.advance(60_000);
    expect((await abandon(held.effectId)).status).toBe(409);
    expect((await abandon(loose.effectId)).status).toBe(200);
    expect((await abandon(loose.effectId)).status).toBe(404);
  });

  test('M3: a host approval re-reads its command effects and never reads completed while they are outstanding', async () => {
    const h = harness({ reconciliation: true });
    await grantServer(h);
    const before = await generation(h);
    const admission = admit(h, 'serve', before);
    const receipt = await receiptOf(admission.response);
    changeServerBytes(h);
    const { approvalId } = await approveTrusted(h);
    const reconciliation = async () =>
      (
        (await (
          await h.app.request(`/host-approvals/${approvalId}`)
        ).json()) as {
          approval: {
            reconciliation: {
              status: string;
              commandEffects: PluginCommandEffectsWithdrawalSummary;
            };
          };
        }
      ).approval.reconciliation;
    const outstanding = await reconciliation();
    expect(outstanding.status).not.toBe('completed');
    expect(outstanding.commandEffects).toMatchObject({
      status: 'winding-down',
      outstanding: 1,
    });
    await settle(h, [
      {
        requestId: admission.requestId,
        effectId: receipt.effectId,
        outcome: 'applied',
      },
    ]);
    // Re-projected from the ledger on read, not the decision's snapshot.
    // (Under the decision guard runtime reconciliation itself answers
    // `winding-down`, so that base status is what remains.)
    expect(await reconciliation()).toMatchObject({
      status: 'winding-down',
      commandEffects: { status: 'completed', outstanding: 0 },
    });
  });
});
