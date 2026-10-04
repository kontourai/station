/**
 * ONE integration test (kontourai/station#1418, #1419): the REAL client
 * coordinator against the REAL plugin command-effect routes
 * (`createPluginRoutes`, `app.request`), through a transport that lets the
 * test reorder the admission response, a withdrawal (grant-withdrawal, via a
 * real `plugin.server` permission revoke) and the ack.
 *
 * Everything else (every abort/retry/backoff/identity edge) is covered by
 * the scripted-fake-transport unit tests in
 * `plugin-command-effect-coordinator.test.ts`. This test's only job is to
 * prove the coordinator's request/response shapes actually match what the
 * server sends and expects, and that the strict-withdrawal contract holds
 * end to end: an effect admitted before a `plugin.server` revocation commits
 * stays outstanding (`winding-down`) until the coordinator's own ack proves
 * it, and only then does the withdrawal read `completed`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createPluginCommandEffectCoordinator,
  type PluginCommandEffectAdmitOutcome,
  type PluginCommandEffectTransport,
} from '../../../../src-ui/src/components/plugin-command-effect-coordinator';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { grantPermissions } from '../../../services/plugins/plugin-permissions.js';
import { capturePluginRuntimeArtifact } from '../../../services/plugins/plugin-runtime-artifact.js';
import { PluginVisibilityService } from '../../../services/plugins/plugin-visibility-service.js';
import { createPluginRoutes } from '../plugins.js';
import { TEST_OPERATOR_PRINCIPAL } from './plugin-visibility-test-support.js';

// Removed in an after-hook even when an assertion fails (#2421).
const makeTempDir = trackTempDirs();

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as never;

function harness() {
  const home = makeTempDir('station-command-coordinator-');
  const plugins = join(home, 'plugins');
  const pluginDir = join(plugins, 'demo');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      serverModule: 'server.mjs',
      permissions: ['plugin.server'],
      commands: [
        {
          version: '1.0',
          id: 'demo.draft',
          title: 'Draft with demo',
          requires: ['plugin-server'],
          intent: { kind: 'seed-composer', text: 'Drafted by demo' },
        },
      ],
    }),
  );
  writeFileSync(
    join(pluginDir, 'server.mjs'),
    'export const behavior = "reviewed";\n',
  );
  const app: Hono = createPluginRoutes(home, logger, undefined, {
    visibility: {
      service: new PluginVisibilityService(home),
      resolvePrincipal: () => TEST_OPERATOR_PRINCIPAL,
      listKnownPrincipals: () => [],
    },
    applyConfigurationMutation: undefined as never,
    settleProviderAdapterRetirements: async () => {},
    commandEffects: {
      isHostedDeployment: () => false,
      publishAudit: () => true,
      indeterminateAfterMs: 60_000,
      resolveRequirement: async () => 'available',
    },
  });
  return { home, plugins, app };
}

async function grantServer(home: string, plugins: string) {
  const artifact = capturePluginRuntimeArtifact(plugins, 'demo');
  if (!artifact) throw new Error('fixture plugin is not installed');
  await grantPermissions(home, 'demo', ['plugin.server'], artifact);
}

/** The real HTTP admission/settlement shapes, dispatched in-process. */
function realTransport(app: Hono): PluginCommandEffectTransport {
  return {
    async admit(apiBase, pluginId, request, signal) {
      const response = await app.request(
        `${apiBase}/${pluginId}/command-effects`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal,
        },
      );
      const body = (await response.json()) as {
        success: boolean;
        receipt?: unknown;
        reason?: string;
      };
      if (body.success && body.receipt) {
        return {
          kind: 'admitted',
          receipt: body.receipt,
        } as PluginCommandEffectAdmitOutcome;
      }
      return {
        kind: 'refused',
        reason: (body.reason ?? 'unavailable') as never,
      };
    },
    async settle(apiBase, request) {
      const response = await app.request(
        `${apiBase}/command-effects/settlements`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      const body = (await response.json()) as {
        success: boolean;
        results?: unknown;
      };
      return body.success ? (body.results as never) : null;
    },
  };
}

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function fakeWindow() {
  return {
    addEventListener() {},
    removeEventListener() {},
  };
}

async function withdrawalOf(app: Hono, id: string) {
  const response = await app.request(`/command-effects/withdrawals/${id}`);
  const body = (await response.json()) as {
    withdrawal: { status: string; outstanding: number };
  };
  return body.withdrawal;
}

describe('plugin command effect coordinator, integration', () => {
  test("a real admission stays outstanding through a real grant-withdrawal, and the coordinator's own ack — not a second HTTP poll or SSE timing — is what completes it", async () => {
    const { home, plugins, app } = harness();
    // Grant the permission the command `requires`, content-bound to the
    // exact bytes installed above.
    await grantServer(home, plugins);

    // The auto-scheduled ack-flush timer is disabled here (a no-op
    // "timer") so this test controls exactly when the ack is sent, via
    // `_debug.flushNow()` — the only way to make the ordering below
    // (admit → apply → withdraw while still unacked → ack) deterministic
    // against a REAL in-process HTTP round trip.
    const coordinator = createPluginCommandEffectCoordinator({
      transport: realTransport(app),
      storage: fakeStorage(),
      windowLike: fakeWindow(),
      setTimer: () => 0,
      clearTimer: () => {},
    });

    let appliedText: string | null = null;
    coordinator.runCommand({
      apiBase: '',
      pluginId: 'demo',
      commandId: 'demo.draft',
      installationGeneration: await currentGeneration(app),
      target: { kind: 'composer', sessionId: 'session-1' },
      context: { activeChatSessionId: 'session-1' },
      currentGeneration: () => undefined,
      apply: (content) => {
        if (content.kind !== 'seed-composer') return false;
        appliedText = content.text;
        return true;
      },
    });

    // The admission's receipt round-trips and applies — proves the
    // request/response shapes against the real route — but the ack is
    // deliberately still unsent (the flush timer is neutered above).
    await waitFor(() => appliedText !== null);
    expect(appliedText).toBe('Drafted by demo');

    // Withdraw the authority the effect was admitted under. It commits
    // immediately; the effect it captured is still outstanding, because
    // this document has not proved anything to the server yet.
    const revoke = await app.request('/demo/grant', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['plugin.server'] }),
    });
    // 202: winding-down. The route only reports 200/`completed` once every
    // captured effect is settled with proof (owner decision, #1419).
    expect(revoke.status).toBe(202);
    const revokeBody = (await revoke.json()) as {
      commandEffects?: { withdrawalId: string; status: string };
    };
    expect(revokeBody.commandEffects?.status).toBe('winding-down');
    const withdrawalId = revokeBody.commandEffects!.withdrawalId;
    expect((await withdrawalOf(app, withdrawalId)).status).toBe('winding-down');
    expect((await withdrawalOf(app, withdrawalId)).outstanding).toBe(1);

    // The coordinator's own ack outbox flush is what proves it.
    await coordinator._debug.flushNow();
    expect((await withdrawalOf(app, withdrawalId)).status).toBe('completed');
    expect((await withdrawalOf(app, withdrawalId)).outstanding).toBe(0);
  });
});

async function currentGeneration(app: Hono, name = 'demo'): Promise<string> {
  const response = await app.request('/');
  const body = (await response.json()) as {
    plugins: Array<{ name: string; installationGeneration?: string }>;
  };
  const record = body.plugins.find((plugin) => plugin.name === name);
  if (!record?.installationGeneration) {
    throw new Error(`${name} has no ready installation generation`);
  }
  return record.installationGeneration;
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
