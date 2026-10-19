/**
 * Telemetry producer tokens through the real runtime HTTP auth stack
 * (`configureRuntimeHttp` + the real `TelemetryProducerStore` + the real
 * ingest routes). The producer seam lives in `runtime-http.ts`; these tests
 * reach it through requests, not through the store.
 */
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { K } from '../../../src-shared/monitoring-keys.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createTelemetryProducerRoutes } from '../../routes/telemetry-producers.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import {
  admittedTelemetryProducer,
  TELEMETRY_PRODUCER_LIMIT,
  TELEMETRY_PRODUCERS_FILE,
  TelemetryProducerStore,
} from '../../services/telemetry-producers/telemetry-producer-store.js';
import type { Logger } from '../../utils/logger.js';
import { createOtlpReceiverRoutes } from '../otlp-receiver.js';
import type { MonitoringEvent } from '../schema.js';

const OPERATE_DEVICE = 'A'.repeat(43);
const READ_DEVICE = 'B'.repeat(43);
const OPERATOR = 'C'.repeat(43);
/** Holds access:manage but is a paired device, not the Station operator. */
const MANAGE_DEVICE = 'D'.repeat(43);
const DAY_MS = 24 * 60 * 60 * 1000;

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

const logger = (): Logger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  }) as unknown as Logger;

const agentEvent = (overrides: Record<string, unknown> = {}) => ({
  schema_version: '0.3.0',
  timestamp: `${Date.now()}`,
  session_id: 'session-1',
  event_id: 'event-1',
  event_type: 'tool.invoke',
  agent: { name: 'codex', runtime: 'codex', version: '1.0.0' },
  tool: { name: 'shell', input: { command: 'ls' } },
  // Flow Agents 0.3.0 sends fields this receiver does not read.
  hook: { event_name: 'PreToolUse' },
  ...overrides,
});

const makeTempDir = trackTempDirs();

function harness(
  budget: {
    maxMutationsPerWindow?: number;
    maxMutationBodyBytes?: number;
  } = {},
) {
  const home = makeTempDir('station-telemetry-producers-');
  let now = Date.UTC(2026, 9, 1);
  const store = new TelemetryProducerStore({
    securityDir: join(home, 'security'),
    now: () => now,
  });
  const emitted: MonitoringEvent[] = [];
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: logger(),
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (credential: string) =>
        [OPERATE_DEVICE, READ_DEVICE, OPERATOR, MANAGE_DEVICE].includes(
          credential,
        ),
      resolveGrantedScope: (credential: string) =>
        credential === READ_DEVICE
          ? 'orchestration:read'
          : credential === OPERATOR || credential === MANAGE_DEVICE
            ? 'access:manage'
            : 'orchestration:operate',
      resolveCredentialAuthority: (credential: string) =>
        credential === OPERATOR ? 'operator-credential' : 'device-credential',
      telemetryProducers: store,
      ...budget,
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  app.route(
    '',
    createOtlpReceiverRoutes(
      (event) => emitted.push(event),
      () => 'station-owner',
      admittedTelemetryProducer,
    ),
  );
  app.route(
    '/api/telemetry-producers',
    createTelemetryProducerRoutes({
      store,
      // The production predicate resolves the principal; here the operator
      // credential is the operator.
      isOperator: (c) => c.req.header('authorization') === `Bearer ${OPERATOR}`,
    }),
  );
  app.get('/api/projects', (c) => c.json({ success: true, data: [] }));

  const send = (
    path: string,
    init: {
      method?: string;
      token?: string;
      body?: unknown;
      peer?: string;
      host?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.request(
      `http://127.0.0.1:3141${path}`,
      {
        method: init.method ?? 'POST',
        headers: {
          host: init.host ?? '127.0.0.1:3141',
          'content-type': 'application/json',
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined
          ? {
              body:
                typeof init.body === 'string'
                  ? init.body
                  : JSON.stringify(init.body),
            }
          : {}),
      },
      {
        incoming: { socket: { remoteAddress: init.peer ?? '127.0.0.1' } },
      } as TestBindings,
    );

  return {
    home,
    store,
    emitted,
    send,
    advance: (ms: number) => {
      now += ms;
    },
    create: async (
      name: string,
      options: { allowRemote?: boolean; expiresInDays?: number } = {},
    ) =>
      (
        await store.create({
          name,
          allowRemote: options.allowRemote ?? false,
          expiresInDays: options.expiresInDays ?? null,
        })
      ).secret,
  };
}

describe('telemetry producer tokens on the ingest routes', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  test('no credential is refused 401 and nothing is ingested', async () => {
    const response = await h.send('/v1/agent-events', { body: agentEvent() });
    expect(response.status).toBe(401);
    expect(h.emitted).toHaveLength(0);
  });

  test('a valid token is admitted and the row names its producer', async () => {
    const token = await h.create('flow-agents-codex');
    expect(token).toMatch(/^sti_[A-Za-z0-9_-]{43}$/);

    const response = await h.send('/v1/agent-events', {
      token,
      body: agentEvent(),
    });

    expect(response.status).toBe(200);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.[K.TELEMETRY_PRODUCER]).toBe('flow-agents-codex');
    expect(h.emitted[0]?.[K.TOOL_NAME]).toBe('shell');
    expect(h.emitted[0]?.[K.AT_SCHEMA_VERSION]).toBe('0.3.0');
  });

  test('the OTLP traces and logs leaves accept the token too', async () => {
    const token = await h.create('otel');
    const traces = await h.send('/v1/traces', {
      token,
      body: {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 't1',
                    spanId: 's1',
                    name: 'x',
                    kind: 1,
                    startTimeUnixNano: '1',
                    attributes: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const logs = await h.send('/v1/logs', {
      token,
      body: {
        resourceLogs: [
          {
            scopeLogs: [
              { logRecords: [{ timeUnixNano: '1', attributes: [] }] },
            ],
          },
        ],
      },
    });
    expect([traces.status, logs.status]).toEqual([200, 200]);
    expect(h.emitted.map((event) => event[K.TELEMETRY_PRODUCER])).toEqual([
      'otel',
      'otel',
    ]);
  });

  test('an unknown token is refused 401', async () => {
    await h.create('real');
    const forged = `sti_${'x'.repeat(43)}`;
    const response = await h.send('/v1/agent-events', {
      token: forged,
      body: agentEvent(),
    });
    expect(response.status).toBe(401);
    expect(h.emitted).toHaveLength(0);
  });

  test('a revoked token is refused 401', async () => {
    const token = await h.create('soon-gone');
    expect(await h.store.revoke('soon-gone')).toBe(true);
    const response = await h.send('/v1/agent-events', {
      token,
      body: agentEvent(),
    });
    expect(response.status).toBe(401);
    expect(h.emitted).toHaveLength(0);
  });

  test('an expired token is refused 403 telemetry_producer_expired', async () => {
    const token = await h.create('short', { expiresInDays: 1 });
    expect(
      (await h.send('/v1/agent-events', { token, body: agentEvent() })).status,
    ).toBe(200);
    h.advance(DAY_MS + 1);

    const response = await h.send('/v1/agent-events', {
      token,
      body: agentEvent(),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'telemetry_producer_expired' },
    });
    expect(h.emitted).toHaveLength(1);
  });

  test('a remote sender is refused 403 unless the token allows remote', async () => {
    const local = await h.create('local-only');
    const remote = await h.create('tailnet', { allowRemote: true });

    const refused = await h.send('/v1/agent-events', {
      token: local,
      body: agentEvent(),
      peer: '100.64.1.2',
      host: 'station.example.ts.net',
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: { code: 'telemetry_producer_remote_not_allowed' },
    });

    const admitted = await h.send('/v1/agent-events', {
      token: remote,
      body: agentEvent(),
      peer: '100.64.1.2',
      host: 'station.example.ts.net',
    });
    expect(admitted.status).toBe(200);
    expect(h.emitted.map((event) => event[K.TELEMETRY_PRODUCER])).toEqual([
      'tailnet',
    ]);
  });

  test('a loopback socket carrying Tailscale Serve evidence is remote', async () => {
    // Tailscale Serve dials Station from loopback; the socket alone would
    // read every tailnet sender as local.
    const local = await h.create('local-only');
    const response = await h.send('/v1/agent-events', {
      token: local,
      body: agentEvent(),
      headers: { 'tailscale-user-login': 'someone@example.com' },
    });
    expect(response.status).toBe(403);
    expect(h.emitted).toHaveLength(0);
  });

  test('the token authenticates nothing outside the ingest routes', async () => {
    const token = await h.create('flow-agents');
    const read = await h.send('/api/projects', { method: 'GET', token });
    expect(read.status).toBe(401);
    const manage = await h.send('/api/telemetry-producers', {
      method: 'GET',
      token,
    });
    expect(manage.status).toBe(401);
    // Exact leaves only: a trailing slash is not ingest.
    const nearMiss = await h.send('/v1/agent-events/', {
      token,
      body: agentEvent(),
    });
    expect(nearMiss.status).toBe(401);
    expect(h.emitted).toHaveLength(0);
  });

  test('a body that does not match the agent event schema is refused 400', async () => {
    const token = await h.create('flow-agents');
    const missing = await h.send('/v1/agent-events', {
      token,
      body: agentEvent({ agent: undefined }),
    });
    expect(missing.status).toBe(400);
    expect(
      ((await missing.json()) as { error: { code: string } }).error.code,
    ).toBe('invalid_agent_event');

    const version = await h.send('/v1/agent-events', {
      token,
      body: agentEvent({ schema_version: '2.0.0' }),
    });
    expect(version.status).toBe(400);
    expect(
      ((await version.json()) as { error: { code: string } }).error.code,
    ).toBe('unsupported_schema_version');

    const notJson = await h.send('/v1/agent-events', { token, body: '{' });
    expect(notJson.status).toBe(400);
    expect(h.emitted).toHaveLength(0);
  });

  test('timestamps are epoch-ms digits or ISO 8601 within the Date range', async () => {
    const h = harness();
    const token = await h.create('flow-agents');
    const statusFor = async (timestamp: string) =>
      (
        await h.send('/v1/agent-events', {
          token,
          body: agentEvent({ timestamp }),
        })
      ).status;
    // Out of range: these passed isFinite and then threw in toISOString.
    expect(await statusFor('99999999999999999')).toBe(400);
    expect(await statusFor('8640000000000001')).toBe(400);
    // Date-parseable prose is not the documented contract.
    expect(await statusFor('Tue Oct 19 2026')).toBe(400);
    expect(await statusFor('2026-10-19')).toBe(400);
    expect(h.emitted).toHaveLength(0);

    expect(await statusFor('8640000000000000')).toBe(200);
    expect(await statusFor('0')).toBe(200);
    expect(await statusFor('2026-10-19T12:00:00.123Z')).toBe(200);
    expect(await statusFor('2026-10-19T12:00:00+02:00')).toBe(200);
    expect(h.emitted.map((event) => event.timestamp)).toEqual([
      '+275760-09-13T00:00:00.000Z',
      '1970-01-01T00:00:00.000Z',
      '2026-10-19T12:00:00.123Z',
      '2026-10-19T10:00:00.000Z',
    ]);
  });

  test('a paired credential with the operate tier keeps working, unattributed', async () => {
    const operate = await h.send('/v1/agent-events', {
      token: OPERATE_DEVICE,
      body: agentEvent(),
    });
    expect(operate.status).toBe(200);
    expect(K.TELEMETRY_PRODUCER in h.emitted[0]!).toBe(false);

    const read = await h.send('/v1/agent-events', {
      token: READ_DEVICE,
      body: agentEvent(),
    });
    expect(read.status).toBe(403);
    expect(h.emitted).toHaveLength(1);
  });
});

describe('telemetry producer store', () => {
  test('refuses the producer past its bound', async () => {
    const h = harness();
    for (let index = 0; index < TELEMETRY_PRODUCER_LIMIT; index += 1)
      await h.create(`producer-${index}`);
    await expect(h.create('one-too-many')).rejects.toMatchObject({
      code: 'producer_limit_reached',
    });
    expect(h.store.list()).toHaveLength(TELEMETRY_PRODUCER_LIMIT);
    // Pinned beside the constant it is derived from.
    expect(TELEMETRY_PRODUCER_LIMIT).toBe(32);
  });

  test('keeps only a hash, owner-only', async () => {
    const h = harness();
    const token = await h.create('flow-agents');
    const path = join(h.home, 'security', TELEMETRY_PRODUCERS_FILE);
    expect(readFileSync(path, 'utf8')).not.toContain(token);
    if (process.platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('refuses a duplicate name', async () => {
    const h = harness();
    await h.create('flow-agents');
    await expect(h.create('flow-agents')).rejects.toMatchObject({
      code: 'producer_exists',
    });
  });
});

describe('telemetry producer management routes', () => {
  test('the operator creates, lists and revokes; the secret is shown once', async () => {
    const h = harness();
    const created = await h.send('/api/telemetry-producers', {
      token: OPERATOR,
      body: { name: 'flow-agents', allowRemote: true, expiresInDays: 30 },
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as {
      data: { token: string; producer: Record<string, unknown> };
    };
    expect(data.token).toMatch(/^sti_/);
    expect(data.producer).toMatchObject({
      name: 'flow-agents',
      allowRemote: true,
      expired: false,
    });

    const listed = await h.send('/api/telemetry-producers', {
      method: 'GET',
      token: OPERATOR,
    });
    const listText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listText).toContain('flow-agents');
    expect(listText).not.toContain(data.token);

    const revoked = await h.send('/api/telemetry-producers/flow-agents', {
      method: 'DELETE',
      token: OPERATOR,
    });
    expect(revoked.status).toBe(200);
    expect(
      (
        await h.send('/v1/agent-events', {
          token: data.token,
          body: agentEvent(),
        })
      ).status,
    ).toBe(401);
  });

  test('a device without access:manage cannot manage producers', async () => {
    const h = harness();
    const response = await h.send('/api/telemetry-producers', {
      token: OPERATE_DEVICE,
      body: { name: 'x' },
    });
    expect(response.status).toBe(403);
    expect(h.store.list()).toHaveLength(0);
  });

  test('the bound is refused through the route as 409', async () => {
    const h = harness();
    for (let index = 0; index < TELEMETRY_PRODUCER_LIMIT; index += 1)
      await h.create(`producer-${index}`);
    const response = await h.send('/api/telemetry-producers', {
      token: OPERATOR,
      body: { name: 'one-too-many' },
    });
    expect(response.status).toBe(409);
  });
});

describe('telemetry producer admission edges (review round 1)', () => {
  test('unknown tokens from an address do not lock out a valid producer', async () => {
    const h = harness();
    const token = await h.create('flow-agents');
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect(
        (
          await h.send('/v1/agent-events', {
            token: `sti_${String(attempt).padStart(43, 'x')}`,
            body: agentEvent(),
          })
        ).status,
      ).toBe(401);
    // The address's failure budget is spent: an eleventh guess is limited.
    expect(
      (
        await h.send('/v1/agent-events', {
          token: `sti_${'y'.repeat(43)}`,
          body: agentEvent(),
        })
      ).status,
    ).toBe(429);
    const valid = await h.send('/v1/agent-events', {
      token,
      body: agentEvent(),
    });
    expect(valid.status).toBe(200);
  });

  test('refused known tokens do not lock out other producers', async () => {
    const h = harness();
    const expired = await h.create('old', { expiresInDays: 1 });
    const localOnly = await h.create('local-only');
    const valid = await h.create('current');
    h.advance(DAY_MS + 1);
    for (let attempt = 0; attempt < 11; attempt += 1) {
      expect(
        (
          await h.send('/v1/agent-events', {
            token: expired,
            body: agentEvent(),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await h.send('/v1/agent-events', {
            token: localOnly,
            body: agentEvent(),
            headers: { 'x-forwarded-for': '100.64.1.2' },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await h.send('/v1/agent-events', { token: valid, body: agentEvent() }))
        .status,
    ).toBe(200);
  });

  test('a refused known token does not reset the failure budget for guessers', async () => {
    const h = harness();
    const expired = await h.create('old', { expiresInDays: 1 });
    h.advance(DAY_MS + 1);
    const guess = (index: number) =>
      h.send('/v1/agent-events', {
        token: `sti_${String(index).padStart(43, 'g')}`,
        body: agentEvent(),
      });
    for (let index = 0; index < 10; index += 1)
      expect((await guess(index)).status).toBe(401);
    expect(
      (await h.send('/v1/agent-events', { token: expired, body: agentEvent() }))
        .status,
    ).toBe(403);
    expect((await guess(10)).status).toBe(429);
  });

  test('a token in the query string is refused even with a valid bearer', async () => {
    const h = harness();
    const token = await h.create('flow-agents');
    const response = await h.send(`/v1/agent-events?token=${token}`, {
      token,
      body: agentEvent(),
    });
    expect(response.status).toBe(401);
    expect(h.emitted).toHaveLength(0);
  });

  test('an unsafe token file admits no producer (503)', async () => {
    const h = harness();
    const token = await h.create('flow-agents');
    if (process.platform === 'win32') return;
    chmodSync(join(h.home, 'security', TELEMETRY_PRODUCERS_FILE), 0o644);
    const response = await h.send('/v1/agent-events', {
      token,
      body: agentEvent(),
    });
    expect(response.status).toBe(503);
    expect(h.emitted).toHaveLength(0);
  });

  test('the mutation budget bounds a producer: rate (429) and body size (413)', async () => {
    const h = harness({ maxMutationsPerWindow: 2, maxMutationBodyBytes: 4096 });
    const token = await h.create('flow-agents');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1)
      statuses.push(
        (await h.send('/v1/agent-events', { token, body: agentEvent() }))
          .status,
      );
    expect(statuses).toEqual([200, 200, 429]);

    const small = harness({ maxMutationBodyBytes: 4096 });
    const smallToken = await small.create('flow-agents');
    const large = await small.send('/v1/agent-events', {
      token: smallToken,
      body: agentEvent({ tool: { name: 'shell', input: 'x'.repeat(8192) } }),
    });
    expect(large.status).toBe(413);
    expect(small.emitted).toHaveLength(0);
  });

  test('a paired device with access:manage that is not the operator cannot manage producers', async () => {
    const h = harness();
    const response = await h.send('/api/telemetry-producers', {
      token: MANAGE_DEVICE,
      body: { name: 'x' },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(
      'operator_required',
    );
    expect(h.store.list()).toHaveLength(0);
  });
});
