/**
 * Plugin command effects against the lifecycle changes that withdraw them
 * (kontourai/station#1418, #1419).
 *
 * Every case drives the REAL plugin route composition (`createPluginRoutes`)
 * over a real Station home: a legacy plugin removal, a legacy Git update, a
 * `plugin.server` revocation, and a host-approval regrant decided through the
 * real consent listener. Interleavings are forced with promise gates inside
 * the admission's awaited requirement check, never with sleeps that decide
 * an outcome; the only timer is a bound on how long a serialized lifecycle is
 * observed to stay blocked.
 *
 * Invariants:
 * - I1: a withdrawal reads `completed` only when every captured effect
 *   settled with proof.
 * - I3: no effect is admitted after its authority's withdrawal point.
 * - I4: capacity refuses new admissions and never evicts an outstanding
 *   effect; only an operator's resolution frees it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PluginCommandEffectReceipt,
  PluginCommandEffectsWithdrawalSummary,
  PluginCommandWithdrawalProjection,
} from '@kontourai/station-contracts/plugin-command-effect';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createConsentApp } from '../../../runtime/consent/consent-listener.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { grantPermissions } from '../../../services/plugins/plugin-permissions.js';
import { capturePluginRuntimeArtifact } from '../../../services/plugins/plugin-runtime-artifact.js';
import { PluginVisibilityService } from '../../../services/plugins/plugin-visibility-service.js';
import { createPluginRoutes } from '../plugins.js';
import { TEST_OPERATOR_PRINCIPAL } from './plugin-visibility-test-support.js';

const CONSENT_PORT = 4979;
const CONSENT_HOST = `localhost:${CONSENT_PORT}`;
const OPERATOR_CREDENTIAL = 'O'.repeat(43);
const DOCUMENT_ID = 'document-lifecycle-1';
const DOCUMENT_KEY = 'd'.repeat(43);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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
      permissions: ['system.config'],
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

type Harness = ReturnType<typeof harness>;

function harness(options: { git?: boolean; caller?: PrincipalRef } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'station-command-lifecycle-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const plugins = join(home, 'plugins');
  const pluginDir = join(plugins, 'demo');
  const source = join(home, 'source-demo');
  if (options.git) {
    writePlugin(source, '1.0.0');
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'add', '.');
    git(source, 'commit', '-q', '-m', 'initial');
    mkdirSync(plugins, { recursive: true });
    git(plugins, 'clone', '-q', source, 'demo');
  } else {
    writePlugin(pluginDir, '1.0.0');
  }
  // Lifecycle transactions stamp withdrawals with the wall clock; the route
  // service's clock starts there and only moves forward.
  let clock = Date.now();
  let requirementGate: {
    entered: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  } | null = null;
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
  const mount = () =>
    createPluginRoutes(home, logger, undefined, {
      visibility: {
        service: visibility,
        resolvePrincipal: () => options.caller ?? TEST_OPERATOR_PRINCIPAL,
        listKnownPrincipals: () => [],
      },
      consentChannel: channel,
      applyConfigurationMutation: undefined as never,
      settleProviderAdapterRetirements: async () => {},
      commandEffects: {
        isHostedDeployment: () => false,
        publishAudit: () => true,
        now: () => new Date(clock),
        indeterminateAfterMs: 60_000,
        resolveRequirement: async () => {
          const gate = requirementGate;
          if (gate) {
            requirementGate = null;
            gate.entered.resolve();
            await gate.release.promise;
          }
          return 'available';
        },
      },
    });
  let app = mount();
  return {
    home,
    plugins,
    pluginDir,
    source,
    consentApp,
    get app() {
      return app;
    },
    restart() {
      app = mount();
    },
    advance(ms: number) {
      clock = Math.max(clock, Date.now()) + ms;
    },
    /** The next admission stops inside its requirement check until released. */
    gateNextRequirement() {
      const gate = { entered: deferred(), release: deferred() };
      requirementGate = gate;
      return gate;
    },
  };
}

async function generation(h: Harness): Promise<string> {
  const body = (await (await h.app.request('/')).json()) as {
    plugins: Array<{ name: string; installationGeneration?: string }>;
  };
  const record = body.plugins.find((plugin) => plugin.name === 'demo');
  if (!record?.installationGeneration)
    throw new Error('demo has no ready installation generation');
  return record.installationGeneration;
}

let requestSequence = 0;
function nextRequestId() {
  requestSequence += 1;
  return `request-${String(requestSequence).padStart(6, '0')}`;
}

function admit(
  h: Harness,
  command: 'open' | 'serve',
  installationGeneration: string,
  requestId = nextRequestId(),
) {
  return {
    requestId,
    response: h.app.request('/demo/command-effects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: DOCUMENT_ID,
        documentKey: DOCUMENT_KEY,
        requestId,
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
      }),
    }),
  };
}

async function receiptOf(response: Response | Promise<Response>) {
  const resolved = await response;
  const body = (await resolved.json()) as {
    receipt?: PluginCommandEffectReceipt;
    reason?: string;
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
    (await response.json()) as {
      withdrawal: PluginCommandWithdrawalProjection;
    }
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
  commandEffects?: PluginCommandEffectsWithdrawalSummary;
}

interface Lifecycle {
  name: string;
  command: 'open' | 'serve';
  git?: boolean;
  /** Waits on the admission's plugin content lock. */
  serialized: boolean;
  /** How a gated admission ends when this withdrawal wins the interleaving. */
  gatedAdmission: 'admitted' | 'permission-unavailable' | 'generation-changed';
  /** A fresh admission of the withdrawn authority after the change. */
  staleRefusal: string;
  prepare(h: Harness): Promise<void>;
  run(h: Harness): Promise<LifecycleResult>;
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
  };
  return { status: response.status, commandEffects: body.commandEffects };
}

const LIFECYCLES: Lifecycle[] = [
  {
    name: 'removal',
    command: 'open',
    serialized: true,
    gatedAdmission: 'admitted',
    staleRefusal: 'not-found',
    prepare: async () => {},
    run: async (h) =>
      jsonResult(await h.app.request('/demo', { method: 'DELETE' })),
    readmit: async (h) => writePlugin(h.pluginDir, '2.0.0'),
  },
  {
    name: 'update',
    command: 'open',
    git: true,
    serialized: true,
    gatedAdmission: 'admitted',
    staleRefusal: 'generation-changed',
    prepare: async () => {},
    run: async (h) => {
      writePlugin(h.source, '1.1.0');
      git(h.source, 'commit', '-q', '-am', 'update');
      return jsonResult(
        await h.app.request('/demo/update', { method: 'POST' }),
      );
    },
  },
  {
    name: 'plugin.server revoke',
    command: 'serve',
    serialized: false,
    gatedAdmission: 'permission-unavailable',
    staleRefusal: 'permission-unavailable',
    prepare: grantServer,
    run: async (h) =>
      jsonResult(
        await h.app.request('/demo/grant', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ permissions: ['plugin.server'] }),
        }),
      ),
  },
  {
    name: 'host-approval regrant',
    command: 'serve',
    serialized: true,
    gatedAdmission: 'generation-changed',
    staleRefusal: 'generation-changed',
    prepare: grantServer,
    run: async (h) => {
      // The reviewed bytes change, so approving another trusted permission
      // re-binds consent and withdraws `plugin.server`.
      writeFileSync(
        join(h.pluginDir, 'server.mjs'),
        'export const behavior = "changed";\n',
      );
      const opened = await h.app.request('/host-approvals', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost:3141',
        },
        body: JSON.stringify({
          pluginName: 'demo',
          permissions: ['system.config'],
        }),
      });
      expect(opened.status).toBe(200);
      const { approval } = (await opened.json()) as {
        approval: { id: string };
      };
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
      const decided = await h.consentApp.request(
        `/consent/${approval.id}/decide`,
        {
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
        },
      );
      expect(decided.status).toBe(200);
      const status = (await (
        await h.app.request(`/host-approvals/${approval.id}`)
      ).json()) as {
        approval: {
          status: string;
          reconciliation?: {
            commandEffects?: PluginCommandEffectsWithdrawalSummary;
          };
        };
      };
      expect(status.approval.status).toBe('approved');
      return {
        status: decided.status,
        commandEffects: status.approval.reconciliation?.commandEffects,
      };
    },
  },
];

describe.each(LIFECYCLES)('plugin command effects × $name', (lifecycle) => {
  const setup = async () => {
    const h = harness({ git: lifecycle.git });
    await lifecycle.prepare(h);
    return { h, before: await generation(h) };
  };

  test('I3: a withdrawal between the requirement check and the append never admits after it', async () => {
    const { h, before } = await setup();
    const gate = h.gateNextRequirement();
    const admission = admit(h, lifecycle.command, before);
    await gate.entered.promise;
    const withdrawal = lifecycle.run(h);
    if (lifecycle.serialized) {
      // It waits on the content lock the admission holds.
      expect(await stateOf(withdrawal)).toBe('pending');
    } else {
      await withdrawal;
    }
    gate.release.resolve();
    const response = await admission.response;
    const result = await withdrawal;

    if (lifecycle.gatedAdmission === 'admitted') {
      const receipt = await receiptOf(response);
      // Admitted before the withdrawal point, so it is captured, and the
      // withdrawal cannot claim completion while it is outstanding.
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
      expect(await refusalOf(response)).toBe(lifecycle.gatedAdmission);
      // Nothing was admitted, so nothing was captured.
      expect(result.commandEffects).toBeUndefined();
    }
    expect(await refusalOf(admit(h, lifecycle.command, before).response)).toBe(
      lifecycle.staleRefusal,
    );
  });

  test('I1: a withdrawal after the append but before the receipt is read waits for its settlement', async () => {
    const { h, before } = await setup();
    const admission = admit(h, lifecycle.command, before);
    const response = await admission.response;
    expect(response.status).toBe(200);
    const result = await lifecycle.run(h);
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
    const result = await lifecycle.run(h);
    const id = result.commandEffects!.withdrawalId;
    // The document abandoned before it saw the receipt: cancel by request.
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
    const gate = h.gateNextRequirement();
    const admission = admit(h, lifecycle.command, before);
    await gate.entered.promise;
    const cancel = await settle(h, [
      { requestId: admission.requestId, outcome: 'cancelled' },
    ]);
    expect(cancel.body.results[0]?.status).toBe('cancel-recorded');
    gate.release.resolve();
    expect(await refusalOf(admission.response)).toBe('cancelled');
    const result = await lifecycle.run(h);
    expect(result.commandEffects).toBeUndefined();
    expect(result.status).toBe(200);
  });

  test('a restart between admission and settlement keeps the withdrawal honest', async () => {
    const { h, before } = await setup();
    const admission = admit(h, lifecycle.command, before);
    const receipt = await receiptOf(admission.response);
    const result = await lifecycle.run(h);
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
    const result = await lifecycle.run(h);
    const id = result.commandEffects!.withdrawalId;
    expect(result.commandEffects?.outstanding).toBe(8);
    await lifecycle.readmit?.(h);
    const current = await generation(h);
    // Revocation withdraws a permission, not the installed bytes.
    if (lifecycle.name === 'plugin.server revoke') expect(current).toBe(before);
    else expect(current).not.toBe(before);
    expect(await refusalOf(admit(h, 'open', current).response)).toBe(
      'capacity',
    );
    const early = await h.app.request(
      `/command-effects/withdrawals/${id}/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disposition: 'accept-indeterminate' }),
      },
    );
    expect(early.status).toBe(409);
    h.advance(60_000);
    const indeterminate = await withdrawalOf(h, id);
    expect(indeterminate).toMatchObject({
      status: 'indeterminate',
      outstanding: 8,
    });
    expect([...indeterminate.outstandingEffectIds].sort()).toEqual(
      [...held].sort(),
    );
    const resolved = await h.app.request(
      `/command-effects/withdrawals/${id}/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disposition: 'accept-indeterminate' }),
      },
    );
    expect(resolved.status).toBe(200);
    expect(await withdrawalOf(h, id)).toMatchObject({
      status: 'closed-indeterminate',
      outstanding: 0,
    });
    await receiptOf(admit(h, 'open', current).response);
  });
});

describe('plugin command effect routes', () => {
  test('an invisible plugin is refused exactly as an absent one', async () => {
    const collaborator: PrincipalRef = {
      id: 'device:collaborator',
      kind: 'human',
      display: 'Collaborator',
    };
    const h = harness({ caller: collaborator });
    const operator = harness();
    const current = await generation(operator);
    const invisible = await h.app.request('/demo/command-effects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: OPEN.id,
        installationGeneration: current,
      }),
    });
    const absent = await h.app.request('/missing/command-effects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: OPEN.id,
        installationGeneration: current,
      }),
    });
    expect(invisible.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await invisible.text()).toBe(await absent.text());
    // The control: the operator reaches the same plugin.
    await receiptOf(admit(operator, 'open', current).response);
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

  test('withdrawal reads and resolution are operator-only', async () => {
    const collaborator = harness({
      caller: { id: 'device:collaborator', kind: 'human', display: 'Other' },
    });
    const read = await collaborator.app.request(
      '/command-effects/withdrawals/pcw-anything',
    );
    const resolve = await collaborator.app.request(
      '/command-effects/withdrawals/pcw-anything/resolve',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disposition: 'accept-indeterminate' }),
      },
    );
    expect(read.status).toBe(403);
    expect(resolve.status).toBe(403);
    const operator = harness();
    expect(
      (await operator.app.request('/command-effects/withdrawals/pcw-anything'))
        .status,
    ).toBe(404);
  });
});
