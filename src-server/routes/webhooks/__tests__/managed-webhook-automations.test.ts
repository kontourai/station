/**
 * #4521: `limits.webhookAutomations: false`. The inbound route refuses a
 * correctly signed request before reading anything, the configuration file
 * is kept and stays editable, editing it cannot re-enable it, and the turn
 * starter and the integration status agree.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { installManagedCapabilityLimits } from '../../../security/managed-capability-limits.js';
import { createIntegrationStatusProbes } from '../../../services/integrations/integration-status-service.js';
import type { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { InboundWebhookAuthorizationService } from '../../../services/webhooks/inbound-webhook-authorization.js';
import { InboundWebhookConfigurationStore } from '../../../services/webhooks/inbound-webhook-store.js';
import { createInboundWebhookRoutes } from '../inbound-webhooks.js';
import { createWebhookTurnStarter } from '../webhook-turn-starter.js';

const now = 1_780_000_000_000;
const timestamp = String(Math.floor(now / 1000));
const secret = 'test-webhook-secret-32-chars-min';
const temporary = trackTempDirs();

afterEach(() => {
  installManagedCapabilityLimits(null);
});

function policy() {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { webhookAutomations: false },
  });
  if (!parsed.ok) throw new Error('fixture policy refused');
  return { summary: summarizeManagedPolicy(parsed.document) };
}

function enabledHome(): string {
  const homeDir = temporary('station-managed-webhook-');
  new InboundWebhookConfigurationStore(homeDir).write({
    schemaVersion: 1,
    enabled: true,
    tokens: [
      {
        id: 'ci-deploy',
        name: 'CI deploy failures',
        secret,
        starts: [{ agentId: 'station' }],
      },
    ],
  });
  return homeDir;
}

function route(homeDir: string) {
  const startTurn = vi.fn(async () => ({
    conversationId: 'conversation:webhook',
    providerTurnId: 'turn-1',
  }));
  const authorization = new InboundWebhookAuthorizationService(
    homeDir,
    () => now,
  );
  // The credential lookup is the first configuration read Telltale makes.
  const lookup = vi.spyOn(authorization, 'lookup');
  const app = createInboundWebhookRoutes({
    homeDir,
    authorization,
    logger: { warn: vi.fn() },
    startTurn,
  });
  return { app, startTurn, lookup };
}

/** A correctly signed request for the token's granted Agent. */
function signed(app: ReturnType<typeof createInboundWebhookRoutes>) {
  const payload = JSON.stringify({ agent: 'station', message: 'Check CI.' });
  const nonce = randomBytes(16).toString('base64url');
  return app.request('http://station.test/inbound', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-station-webhook-token': 'ci-deploy',
      'x-station-webhook-timestamp': timestamp,
      'x-station-webhook-nonce': nonce,
      'x-station-webhook-signature': `sha256=${createHmac('sha256', secret)
        .update(`${timestamp}\n${nonce}\n${payload}`)
        .digest('hex')}`,
    },
    body: payload,
  });
}

test('control: without a policy a signed request starts a turn', async () => {
  const { app, startTurn } = route(enabledHome());
  expect((await signed(app)).status).toBe(202);
  expect(startTurn).toHaveBeenCalledTimes(1);
});

test('the route refuses a signed request before reading anything and starts nothing', async () => {
  installManagedCapabilityLimits(policy());
  const homeDir = enabledHome();
  const configPath = join(homeDir, 'security', 'inbound-webhooks.json');
  const before = readFileSync(configPath, 'utf8');
  const { app, startTurn, lookup } = route(homeDir);

  const response = await signed(app);

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    success: false,
    code: MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
    error:
      "Acme's policy manages webhook automations: it is turned off. Contact your administrator for help.",
    retryable: false,
  });
  expect(startTurn).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  // Kept as it was: the policy disables, it does not delete.
  expect(readFileSync(configPath, 'utf8')).toBe(before);
});

test('the configuration stays editable, and an edit cannot re-enable it', async () => {
  installManagedCapabilityLimits(policy());
  const homeDir = enabledHome();
  const store = new InboundWebhookConfigurationStore(homeDir);
  store.write({
    schemaVersion: 1,
    enabled: true,
    tokens: [
      {
        id: 'ci-new',
        name: 'A token added under the policy',
        secret,
        starts: [{ agentId: 'station' }],
      },
    ],
  });
  expect(store.read().tokens?.map((token) => token.id)).toEqual(['ci-new']);
  store.write({ schemaVersion: 1 });
  expect(store.read()).toEqual({ schemaVersion: 1 });
  const { app, startTurn } = route(enabledHome());
  expect((await signed(app)).status).toBe(403);
  expect(startTurn).not.toHaveBeenCalled();
});

test('the turn starter refuses without reaching orchestration', async () => {
  installManagedCapabilityLimits(policy());
  const orchestrationService = new Proxy(
    {},
    {
      get: () => {
        throw new Error('orchestration reached');
      },
    },
  ) as OrchestrationService;
  const start = createWebhookTurnStarter({
    readAuthorityFor: () => {
      throw new Error('authority reached');
    },
    orchestrationService,
  });
  await expect(
    start({
      target: { environment: { kind: 'current' } } as never,
      message: 'Check CI.',
      ephemeral: true,
      webhookTokenId: 'ci-deploy',
    }),
  ).rejects.toThrow("Acme's policy manages webhook automations");
});

test('the integration status reports the managed refusal, not the file', async () => {
  const webhookStatus = async () => {
    const probes = createIntegrationStatusProbes({
      readDiscord: () => ({ state: 'unavailable', reason: 'n/a' }) as never,
      readWebhook: () => ({
        schemaVersion: 1,
        enabled: true,
        tokens: [
          { id: 't', name: 't', secret, starts: [{ agentId: 'station' }] },
        ],
      }),
      exec: (async () => {
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      }) as never,
    });
    for (const probe of probes) {
      const status = await probe.run();
      if (status.provider === 'webhook') return status.actions[0];
    }
    throw new Error('no webhook probe');
  };
  expect((await webhookStatus())?.state).toBe('unverified');
  installManagedCapabilityLimits(policy());
  expect(await webhookStatus()).toMatchObject({
    state: 'unsupported',
    reason: expect.stringContaining(
      "Acme's policy manages webhook automations",
    ),
  });
});
