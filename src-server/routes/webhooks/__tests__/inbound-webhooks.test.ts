import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RuntimeAuthFailureLimiter } from '../../../security/runtime-request-security.js';
import {
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { InboundWebhookAuthorizationService } from '../../../services/webhooks/inbound-webhook-authorization.js';
import {
  InboundWebhookAuditStore,
  InboundWebhookConfigurationStore,
} from '../../../services/webhooks/inbound-webhook-store.js';
import {
  createInboundWebhookRoutes,
  INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_MAX_ATTEMPTS,
  InboundWebhookNoiseAggregator,
} from '../inbound-webhooks.js';

const now = 1_780_000_000_000;
const timestamp = String(Math.floor(now / 1000));
// Review L2: must clear the store's 32-character floor or writeEnabled()
// itself fails closed before a test even starts.
const secret = 'test-webhook-secret-32-chars-min';
const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function home(): string {
  const result = mkdtempSync(join(tmpdir(), 'station-inbound-webhook-'));
  temporaryHomes.push(result);
  return result;
}

function body(
  overrides: Partial<{ agent: string; project: string; message: string }> = {},
) {
  return JSON.stringify({
    agent: 'station',
    message: 'CI failed: inspect the deploy receipt.',
    ...overrides,
  });
}

function signature(payload: string, nonce: string, at = timestamp): string {
  return `sha256=${createHmac('sha256', secret)
    .update(`${at}\n${nonce}\n${payload}`)
    .digest('hex')}`;
}

function writeEnabled(
  homeDir: string,
  overrides: Record<string, unknown> = {},
) {
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
    ...overrides,
  });
}

function foregroundDependencies(): ExecutionTargetExecutionDependencies {
  return {
    resolveEnvironmentAccess: async () => ({
      apiBase: 'http://127.0.0.1:43141',
      environmentId: 'environment-current',
      environmentName: 'Current Station',
      kind: 'current',
    }),
    getAgent: async () => ({ slug: 'station', available: true }),
    getConnection: vi.fn(),
    getProject: vi.fn(),
    getProviderAdapter: vi.fn(
      () =>
        ({
          provider: 'station-agent',
          metadata: {
            modelLaunch: {
              defaultAtStart: 'engine-selected',
              omissionAtResume: 'engine-selected',
              omissionPerTurn: 'engine-selected',
              overrideAtStart: true,
              overrideAtResume: true,
              overridePerTurn: true,
            },
          },
        }) as never,
    ),
    readSessionBinding: vi.fn(async () => null),
    startSession: vi.fn(async () => undefined),
    sendTurn: vi.fn(async () => ({ turnId: 'provider-turn-webhook' })),
    createConversationId: () => 'conversation:webhook',
  };
}

function app(homeDir: string, deps = foregroundDependencies()) {
  const authorization = new InboundWebhookAuthorizationService(
    homeDir,
    () => now,
  );
  return {
    app: createInboundWebhookRoutes({
      homeDir,
      authorization,
      logger: { warn: vi.fn() },
      // This is the actual foreground execution seam, not a hand-built
      // session/result: the assertion below observes its real start input.
      startTurn: (input) => executeForegroundMessage(input, deps),
    }),
    deps,
  };
}

async function request(
  app: ReturnType<typeof createInboundWebhookRoutes>,
  payload: string,
  nonce = randomBytes(16).toString('base64url'),
  options: { tokenId?: string; signature?: string; at?: string } = {},
) {
  const at = options.at ?? timestamp;
  return app.request('http://station.test/inbound', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-station-webhook-token': options.tokenId ?? 'ci-deploy',
      'x-station-webhook-timestamp': at,
      'x-station-webhook-nonce': nonce,
      'x-station-webhook-signature':
        options.signature ?? signature(payload, nonce, at),
    },
    body: payload,
  });
}

describe('inbound webhooks', () => {
  test('valid named token enters the real foreground seam with only its allowed target and ephemeral visibility', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route, deps } = app(homeDir);

    const response = await request(route, body());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { conversationId: 'conversation:webhook', ephemeral: true },
    });
    expect(deps.startSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'conversation:webhook',
        persistSession: false,
        metadata: expect.objectContaining({ sessionVisibility: 'ephemeral' }),
      }),
    );
    expect(deps.sendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: 'conversation:webhook',
        input: 'CI failed: inspect the deploy receipt.',
      }),
      undefined,
    );
    const startInput = vi.mocked(deps.startSession).mock.calls[0]?.[1];
    if (!startInput) throw new Error('Foreground seam did not start a session');
    expect((startInput.metadata as Record<string, unknown>).agentId).toBe(
      agentId('station'),
    );
  });

  test('records an invalid signature and starts nothing', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route, deps } = app(homeDir);

    const response = await request(route, body(), undefined, {
      // Valid header shape, wrong digest: this crosses timingSafeEqual rather
      // than proving only the syntax gate rejects malformed headers.
      signature: `sha256=${'0'.repeat(64)}`,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'invalid_signature' });
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(new InboundWebhookAuditStore(homeDir).read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'invalid_signature' }),
      ]),
    );
  });

  test('refuses a nonce replay within the named replay window', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route, deps } = app(homeDir);
    const nonce = 'replay-proof-nonce-0001';
    const payload = body();

    expect((await request(route, payload, nonce)).status).toBe(202);
    const replay = await request(route, payload, nonce);

    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ code: 'replay' });
    expect(deps.startSession).toHaveBeenCalledTimes(1);
    expect(new InboundWebhookAuditStore(homeDir).read()).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'replay' })]),
    );
  });

  test('distinguishes unknown tokens from a revoked known token and applies revocation on the next request', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route, deps } = app(homeDir);
    const payload = body();

    expect(
      (await request(route, payload, undefined, { tokenId: 'missing' })).status,
    ).toBe(401);
    new InboundWebhookConfigurationStore(homeDir).write({
      schemaVersion: 1,
      enabled: true,
      tokens: [
        {
          id: 'ci-deploy',
          name: 'CI deploy failures',
          secret,
          revokedAt: '2026-08-16T00:00:00.000Z',
          starts: [{ agentId: 'station' }],
        },
      ],
    });

    const revoked = await request(route, payload);
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ code: 'revoked_token' });
    expect(deps.startSession).not.toHaveBeenCalled();
  });

  test('refuses a valid signature that asks a named token to start outside its grant', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route, deps } = app(homeDir);
    const payload = body({ project: 'production' });

    const response = await request(route, payload);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'forbidden_start' });
    expect(deps.startSession).not.toHaveBeenCalled();
  });

  test('the durable off switch survives a fresh route construction and refuses a valid signature', async () => {
    const homeDir = home();
    writeEnabled(homeDir, { enabled: false });
    const { app: route, deps } = app(homeDir);

    const response = await request(route, body());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'disabled' });
    expect(deps.startSession).not.toHaveBeenCalled();
  });

  test('returns the typed critical resource posture code as a retryable refusal', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const route = createInboundWebhookRoutes({
      homeDir,
      authorization: new InboundWebhookAuthorizationService(homeDir, () => now),
      logger: { warn: vi.fn() },
      startTurn: async () => {
        throw Object.assign(new Error('Engine start refused'), {
          code: 'resource_posture_critical',
        });
      },
    });

    const response = await request(route, body());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'resource_posture_critical',
      retryable: true,
    });
  });

  test('refuses a stale signed request before it can start', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route, deps } = app(homeDir);
    const oldTimestamp = String(Math.floor((now - 5 * 60_000 - 1000) / 1000));

    const response = await request(route, body(), undefined, {
      at: oldTimestamp,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'stale_timestamp' });
    expect(deps.startSession).not.toHaveBeenCalled();
  });

  // Review M1: freshness tolerates future clock skew, so a request signed at
  // T = now + skew stays fresh until T + WINDOW. If the replay claim expires
  // at RECEIPT time + WINDOW instead, the ledger evicts it skew-early and a
  // captured request replays into that gap with the ledger already empty —
  // eviction re-opening the exact window it exists to close.
  test('a future-skewed request cannot be replayed after its receipt-anchored expiry would have passed', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    let clock = now;
    const authorization = new InboundWebhookAuthorizationService(
      homeDir,
      () => clock,
    );
    const deps = foregroundDependencies();
    const route = createInboundWebhookRoutes({
      homeDir,
      authorization,
      logger: { warn: vi.fn() },
      startTurn: (input) => executeForegroundMessage(input, deps),
    });
    const windowMs = 5 * 60_000;
    const skewed = String(Math.floor((now + windowMs - 1000) / 1000));
    const nonce = randomBytes(16).toString('base64url');

    const first = await request(route, body(), nonce, { at: skewed });
    expect(first.status).toBe(202);

    // Receipt-anchored expiry (now + WINDOW) has passed; the signed
    // timestamp keeps the request fresh (|clock - T| = 2s).
    clock = now + windowMs + 1000;
    const replay = await request(route, body(), nonce, { at: skewed });
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ code: 'replay' });
  });

  // Review test-power note: every other test signs JSON.stringify output, so
  // an implementation that re-serialized the parsed body before HMAC would
  // produce identical bytes and stay green. Non-canonical whitespace pins
  // that the HMAC is computed over the raw received bytes.
  test('the HMAC covers the raw received bytes, not a re-serialization', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route } = app(homeDir);
    const rawBody =
      '{ "agent"   : "station",\n  "message" : "deploy finished" }';

    const response = await request(route, rawBody);
    expect(response.status).toBe(202);
  });

  // Review M3: success was previously visible only as an OTel counter
  // (invisible without an OTLP endpoint), with nothing durable binding a
  // token id to the conversation it started.
  test('an accepted start records a durable audit success entry and stamps the token id into session metadata', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route, deps } = app(homeDir);

    const response = await request(route, body());
    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      data: { conversationId: string };
    };
    expect(payload.data.conversationId).toBe('conversation:webhook');

    const startInput = vi.mocked(deps.startSession).mock.calls[0]?.[1];
    if (!startInput) throw new Error('Foreground seam did not start a session');
    const metadata = startInput.metadata as Record<string, unknown>;
    expect(metadata.webhookTokenId).toBe('ci-deploy');
    expect(metadata.sessionVisibility).toBe('ephemeral');

    expect(new InboundWebhookAuditStore(homeDir).read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'accepted',
          tokenId: 'ci-deploy',
          conversationId: 'conversation:webhook',
        }),
      ]),
    );
  });
});

// Review L1: run the headers-only checks (off switch, token
// existence/revocation, timestamp/nonce format, freshness) before the body
// is ever read. Each test's body would fail JSON.parse, so a 400
// malformed_request response (rather than the header-phase reason) would
// prove the body was read first.
describe('header-only refusals never read the body (review L1)', () => {
  const garbageBody = 'not-json{{{';
  const garbageHeaders = (overrides: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    'x-station-webhook-token': 'ci-deploy',
    'x-station-webhook-timestamp': timestamp,
    'x-station-webhook-nonce': randomBytes(16).toString('base64url'),
    'x-station-webhook-signature': `sha256=${'0'.repeat(64)}`,
    ...overrides,
  });

  test('the off switch refuses before the body is read', async () => {
    const homeDir = home();
    writeEnabled(homeDir, { enabled: false });
    const { app: route } = app(homeDir);

    const response = await route.request('http://station.test/inbound', {
      method: 'POST',
      headers: garbageHeaders(),
      body: garbageBody,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'disabled' });
  });

  test('an unknown token refuses before the body is read', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route } = app(homeDir);

    const response = await route.request('http://station.test/inbound', {
      method: 'POST',
      headers: garbageHeaders({
        'x-station-webhook-token': 'never-configured',
      }),
      body: garbageBody,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'unknown_token' });
  });

  test('a stale timestamp refuses before the body is read', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route } = app(homeDir);
    const oldTimestamp = String(Math.floor((now - 5 * 60_000 - 1000) / 1000));

    const response = await route.request('http://station.test/inbound', {
      method: 'POST',
      headers: garbageHeaders({ 'x-station-webhook-timestamp': oldTimestamp }),
      body: garbageBody,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'stale_timestamp' });
  });
});

describe('minimum secret strength (review L2)', () => {
  test('a sub-32-character hand-authored secret fails closed at read, naming the token and the floor', () => {
    const homeDir = home();
    const securityDir = join(homeDir, 'security');
    mkdirSync(securityDir, { recursive: true });
    writeFileSync(
      join(securityDir, 'inbound-webhooks.json'),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        tokens: [
          {
            id: 'weak-secret-token',
            name: 'Hand-authored weak token',
            secret: 'too-short',
            starts: [{ agentId: 'station' }],
          },
        ],
      }),
    );

    expect(() => new InboundWebhookConfigurationStore(homeDir).read()).toThrow(
      /weak-secret-token.*32-character floor/,
    );
  });

  // Review M1: the floor's naming message used to be caught and discarded —
  // a weak secret was indistinguishable from a corrupt config (same code,
  // same log, same audit entry). Pin that the detail now reaches the log.
  test('a weak-secret refusal surfaces the naming message to the operator log', async () => {
    const homeDir = home();
    // Hand-write the config: the store's own write() now enforces the floor,
    // and the point is the READ path an operator's hand-authored file takes.
    mkdirSync(join(homeDir, 'security'), { recursive: true });
    writeFileSync(
      join(homeDir, 'security', 'inbound-webhooks.json'),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        tokens: [{ id: 'weak', name: 'Weak', secret: 'short', starts: [] }],
      }),
    );
    const warn = vi.fn();
    const authorization = new InboundWebhookAuthorizationService(
      homeDir,
      () => now,
      { warn },
    );
    const deps = foregroundDependencies();
    const route = createInboundWebhookRoutes({
      homeDir,
      authorization,
      logger: { warn: vi.fn() },
      startTurn: (input) => executeForegroundMessage(input, deps),
    });
    const response = await request(route, body(), undefined, {
      tokenId: 'weak',
    });
    expect(response.status).toBe(403);
    expect(warn).toHaveBeenCalledWith(
      'Inbound webhook configuration rejected',
      expect.objectContaining({
        detail: expect.stringContaining('32-character'),
      }),
    );
  });

  test('write() also refuses a sub-32-character secret', () => {
    const homeDir = home();
    expect(() =>
      new InboundWebhookConfigurationStore(homeDir).write({
        schemaVersion: 1,
        enabled: true,
        tokens: [{ id: 'weak', name: 'weak', secret: 'short', starts: [] }],
      }),
    ).toThrow(/weak.*32-character floor/);
  });
});

// Review M2: the rate limiter is keyed on the attacker-chosen token id, so
// rotation buys a fresh bucket every request; every refusal costs a config
// read plus an audit read-modify-rewrite, and 256 junk requests can flush
// every earlier audit entry. These tests drive the real route with a fixed
// clock so the global budget and its debounced noise aggregator behave
// deterministically regardless of test execution speed.
describe('global unauthenticated-attempt budget (review M2)', () => {
  function budgetedRoute(
    homeDir: string,
    // Behavioural tests inject a small trip point so they stay independent of
    // the production threshold's VALUE, which the H1 pin test asserts
    // separately with the real constant.
    maxFailures = INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_MAX_ATTEMPTS,
  ) {
    const unauthenticatedBudget = new RuntimeAuthFailureLimiter({
      now: () => now,
      maxFailures,
      windowMs: 60_000,
      maxTrackedPeers: 1,
    });
    const noiseAggregator = new InboundWebhookNoiseAggregator(
      new InboundWebhookAuditStore(homeDir),
      () => now,
    );
    return createInboundWebhookRoutes({
      homeDir,
      logger: { warn: vi.fn() },
      unauthenticatedBudget,
      noiseAggregator,
      startTurn: async () => ({
        conversationId: 'unused',
        providerTurnId: 'unused',
      }),
    });
  }

  test('rotating token ids stop costing disk once the global unauthenticated budget trips', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const configReadSpy = vi.spyOn(
      InboundWebhookConfigurationStore.prototype,
      'read',
    );
    const auditRecordSpy = vi.spyOn(
      InboundWebhookAuditStore.prototype,
      'record',
    );
    const auditSuccessSpy = vi.spyOn(
      InboundWebhookAuditStore.prototype,
      'recordSuccess',
    );
    const route = budgetedRoute(homeDir);

    // Unique ids so the existing per-token limiter never itself intervenes;
    // only the new global budget can explain the disk activity flattening.
    for (
      let i = 0;
      i < INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_MAX_ATTEMPTS + 10;
      i += 1
    ) {
      await request(route, body(), undefined, { tokenId: `rotating-${i}` });
    }
    const configReadsAtTrip = configReadSpy.mock.calls.length;
    const auditWritesAtTrip = auditRecordSpy.mock.calls.length;
    expect(configReadsAtTrip).toBeLessThanOrEqual(
      INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_MAX_ATTEMPTS,
    );

    // The actual assertion: drive the store spy, not a counter. A second
    // wave, well past the trip point, must add ZERO further store touches.
    for (let i = 0; i < 50; i += 1) {
      await request(route, body(), undefined, {
        tokenId: `second-wave-${i}`,
      });
    }
    expect(configReadSpy.mock.calls.length).toBe(configReadsAtTrip);
    expect(auditRecordSpy.mock.calls.length).toBe(auditWritesAtTrip);
    expect(auditSuccessSpy).not.toHaveBeenCalled();

    configReadSpy.mockRestore();
    auditRecordSpy.mockRestore();
    auditSuccessSpy.mockRestore();
  });

  // Review H1: the budget is an ADMISSION kill switch. Once tripped, even a
  // correctly signed request from the legitimate caller is refused for the
  // window's remainder — a deliberate availability trade, pinned here so it
  // remains a recorded decision rather than an emergent one.
  test('a valid signed request is refused once the budget trips', async () => {
    const homeDir = home();
    writeEnabled(homeDir);
    const { app: route, deps } = app(homeDir);
    for (let i = 0; i < 300; i += 1) {
      await request(route, body(), undefined, { tokenId: `junk-${i}` });
    }
    const legitimate = await request(route, body());
    expect(legitimate.status).toBe(429);
    expect(deps.startSession).not.toHaveBeenCalled();
  });

  test('post-budget noise cannot evict pre-budget audit entries', async () => {
    const homeDir = home();
    // Known-but-revoked tokens (rather than unknown ones) so the refusal
    // carries the token id into the audit entry — an unknown-token refusal
    // deliberately never echoes the attacker-supplied id (see `authorize`'s
    // `refuse('unknown_token', 401)` call, no third argument).
    writeEnabled(homeDir, {
      tokens: [
        {
          id: 'pre-budget-first',
          name: 'Pre-budget first',
          secret,
          revokedAt: '2026-01-01T00:00:00.000Z',
          starts: [],
        },
        {
          id: 'pre-budget-second',
          name: 'Pre-budget second',
          secret,
          revokedAt: '2026-01-01T00:00:00.000Z',
          starts: [],
        },
      ],
    });
    const route = budgetedRoute(homeDir, 5);

    await request(route, body(), undefined, { tokenId: 'pre-budget-first' });
    await request(route, body(), undefined, { tokenId: 'pre-budget-second' });
    const seeded = new InboundWebhookAuditStore(homeDir).read();
    expect(seeded.some((entry) => entry.tokenId === 'pre-budget-first')).toBe(
      true,
    );
    expect(seeded.some((entry) => entry.tokenId === 'pre-budget-second')).toBe(
      true,
    );

    // Enough additional unique ids to trip the budget AND, absent the fix,
    // exceed the audit store's 256-entry cap (2 seed + ~budget-trip + flood).
    for (
      let i = 0;
      i < INBOUND_WEBHOOK_UNAUTHENTICATED_BUDGET_MAX_ATTEMPTS + 400;
      i += 1
    ) {
      await request(route, body(), undefined, { tokenId: `flood-${i}` });
    }

    const afterFlood = new InboundWebhookAuditStore(homeDir).read();
    expect(
      afterFlood.some((entry) => entry.tokenId === 'pre-budget-first'),
    ).toBe(true);
    expect(
      afterFlood.some((entry) => entry.tokenId === 'pre-budget-second'),
    ).toBe(true);
  });
});
