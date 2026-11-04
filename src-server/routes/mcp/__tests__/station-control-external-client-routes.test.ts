import { parseStationControlExternalClientLease } from '@kontourai/station-contracts/station-control-external-client';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  resolveStationControlCallerFromToken,
  type StationControlCallerRecord,
} from '../../../runtime/mcp/station-control-caller.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
  readStationControlExternalClientLease,
  revokeStationControlMcpToken,
  verifyStationControlMcpToken,
} from '../../../runtime/mcp/station-control-mcp-token.js';
import { matchPairingScopeRule } from '../../../security/pairing-route-scopes.js';
import {
  bindRuntimeLocalOperator,
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { stationControlMcpTokenMinted } from '../../../telemetry/metrics.js';
import { STATION_CONTROL_OPERATOR_PRINCIPAL_ID } from '../../../tools/station-control-policy.js';
import { createStationControlExternalClientRoutes } from '../station-control-external-client-routes.js';
import { createStationControlMcpRoutes } from '../station-control-mcp-route.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  stationControlMcpHttpAuth: { add: vi.fn() },
  stationControlMcpTokenMinted: { add: vi.fn() },
  tenantExecutionContextAttributes: vi.fn((value) => value),
  tenantExecutionContextOutcomes: { add: vi.fn() },
}));

const operator: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'fixture-local-device',
  authority: 'device-credential',
  deviceId: 'local-device',
  deviceKind: 'device',
  source: 'bearer',
  pairingSource: 'same-origin',
  locality: 'home-possession',
  mintKind: 'local-grant',
};
const path = '/api/orchestration/station-control/external-clients';
const request = {
  sessionId: 'real-session',
  allowedTools: ['read_conversation'],
  ttlSeconds: 300,
};

function fixture(
  principal: RuntimeAuthenticatedRequestPrincipal | null = operator,
) {
  const state: {
    record: StationControlCallerRecord | undefined;
    projectId: string;
    hosted: boolean;
    issuerCurrent: boolean;
  } = {
    record: {
      principal: {
        id: STATION_CONTROL_OPERATOR_PRINCIPAL_ID,
        source: 'session-owner',
      },
      localProjectId: 'project-id',
      projectIdSource: 'session-record',
      projectSlug: 'project',
      conversationId: 'conversation',
    },
    projectId: 'project-id',
    hosted: false,
    issuerCurrent: true,
  };
  const resolveRecord = (id: string) =>
    id === 'real-session' ? state.record : undefined;
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (principal)
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, principal);
    bindRuntimeLocalOperator(c.req.raw);
    await next();
  });
  app.route(
    '/api/orchestration',
    createStationControlExternalClientRoutes({
      port: 43521,
      resolveRecord,
      isHosted: () => state.hosted,
      currentProjectId: (slug) =>
        slug === 'project' ? state.projectId : undefined,
      issuerAuthority: {
        credentialHoldsScope: (id, scope) =>
          id === 'local-device' &&
          scope === 'access:manage' &&
          state.issuerCurrent,
      },
    }),
  );
  app.route(
    '',
    createStationControlMcpRoutes({
      port: 43521,
      resolveCallerRecord: resolveRecord,
      resolveExternalClientProjectId: (slug) =>
        slug === 'project' ? state.projectId : undefined,
    }),
  );
  const create = (body: unknown = request) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const rpc = (token: string) =>
    app.request(
      'http://localhost/mcp/station-control',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );
  return { app, state, resolveRecord, create, rpc };
}

async function issued(response: Response) {
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('data' in value))
    throw new Error('Missing public lease envelope.');
  const lease = parseStationControlExternalClientLease(value.data);
  if (!lease) throw new Error('Invalid public lease contract.');
  return lease;
}

afterEach(() => {
  __resetStationControlMcpTokensForTests();
  vi.restoreAllMocks();
});

describe('operator-issued external Station Control clients', () => {
  test('refuses issuance when an admitted issuer loses authority while its request body is pending', async () => {
    const f = fixture();
    let reading!: () => void;
    const bodyReadStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          streamController = controller;
        },
        pull() {
          reading();
        },
      },
      { highWaterMark: 0 },
    );
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stream,
      duplex: 'half',
    };
    const count = vi.mocked(stationControlMcpTokenMinted.add).mock.calls.length;
    const pending = f.app.request(path, init);
    await bodyReadStarted;
    f.state.issuerCurrent = false;
    streamController.enqueue(new TextEncoder().encode(JSON.stringify(request)));
    streamController.close();
    expect((await pending).status).toBe(403);
    expect(vi.mocked(stationControlMcpTokenMinted.add).mock.calls).toHaveLength(
      count,
    );
  });
  test('issuance and revocation require explicit access administration and refuse personal tokens', () => {
    for (const [method, route] of [
      ['POST', path],
      ['DELETE', `${path}/${'a'.repeat(32)}`],
    ]) {
      expect(matchPairingScopeRule(method!, route!)).toMatchObject({
        origin: 'explicit',
        scope: 'access:manage',
        personalTokens: 'refused',
      });
    }
  });

  test.each([
    ['unauthenticated', null],
    [
      'operator credential',
      { ...operator, authority: 'operator-credential' as const },
    ],
    ['UI bootstrap', { ...operator, mintKind: 'ui-bootstrap' as const }],
    [
      'internal process',
      { ...operator, kind: 'internal' as const, mintKind: undefined },
    ],
    [
      'paired remote device',
      { ...operator, locality: undefined, mintKind: undefined },
    ],
    ['delegation device', { ...operator, deviceKind: 'delegation' as const }],
  ])('refuses %s creation and revocation', async (_label, principal) => {
    const f = fixture(principal);
    expect((await f.create()).status).toBe(403);
    expect(
      (await f.app.request(`${path}/unknown`, { method: 'DELETE' })).status,
    ).toBe(403);
  });

  test.each([
    { sessionId: 'real-session', ttlSeconds: 300 },
    { ...request, allowedTools: [] },
    { ...request, allowedTools: ['read_conversation', 'read_conversation'] },
    { ...request, allowedTools: ['browser_navigate'] },
    { ...request, ttlSeconds: 0 },
    { ...request, ttlSeconds: 3601 },
    { ...request, ttlSeconds: 60.5 },
    { ...request, projectId: 'forged-project' },
    { ...request, principalId: STATION_CONTROL_OPERATOR_PRINCIPAL_ID },
  ])('rejects invalid or caller-supplied authority: %j', async (body) => {
    expect((await fixture().create(body)).status).toBe(400);
  });

  test('requires a real owned Session, recorded Project, current identity, and personal host', async () => {
    const f = fixture();
    expect(
      (await f.create({ ...request, sessionId: 'invented-session' })).status,
    ).toBe(403);
    f.state.record = {
      ...f.state.record,
      principal: { id: 'human:other', source: 'session-owner' },
    };
    expect((await f.create()).status).toBe(403);
    f.state.record = fixture().state.record;
    f.state.record = { ...f.state.record, projectIdSource: 'slug-lookup' };
    expect((await f.create()).status).toBe(403);
    f.state.record = fixture().state.record;
    f.state.projectId = 'replacement-project';
    expect((await f.create()).status).toBe(403);
    f.state.projectId = 'project-id';
    f.state.hosted = true;
    expect((await f.create()).status).toBe(403);
  });

  test('creates selected header-only clients without rotating runtime or other client credentials', async () => {
    const f = fixture();
    const runtime = mintStationControlMcpToken(
      'real-session',
      'url-token',
    ).token;
    const response = await f.create({
      ...request,
      allowedTools: ['read_conversation', 'board_pin'],
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const first = await issued(response);
    const second = await issued(await f.create());
    const firstToken = first.config.headers.Authorization.slice(
      'Bearer '.length,
    );
    const secondToken = second.config.headers.Authorization.slice(
      'Bearer '.length,
    );
    expect(first.config.url).toBe('http://127.0.0.1:43521/mcp/station-control');
    expect(first.project).toEqual({ id: 'project-id', slug: 'project' });
    expect(verifyStationControlMcpToken(firstToken)?.allowedTools).toEqual([
      'read_conversation',
      'board_pin',
    ]);
    expect(verifyStationControlMcpToken(runtime)).toBeDefined();
    const replacement = mintStationControlMcpToken(
      'real-session',
      'url-token',
    ).token;
    expect(verifyStationControlMcpToken(firstToken)).toBeDefined();
    expect(verifyStationControlMcpToken(secondToken)).toBeDefined();
    expect(
      resolveStationControlCallerFromToken(firstToken, f.resolveRecord)
        ?.assurance,
    ).toBe('delegated-custody');
    expect(
      JSON.stringify(readStationControlExternalClientLease(first.leaseId)),
    ).not.toContain(firstToken);
    f.state.record = undefined;
    expect(
      (await f.app.request(`${path}/${first.leaseId}`, { method: 'DELETE' }))
        .status,
    ).toBe(200);
    expect(verifyStationControlMcpToken(firstToken)).toBeUndefined();
    expect(verifyStationControlMcpToken(secondToken)).toBeDefined();
    expect(verifyStationControlMcpToken(replacement)).toBeDefined();
  });

  test('serves only selected tools and refuses the lease when recorded authority changes or is revoked', async () => {
    const f = fixture();
    const lease = await issued(await f.create());
    const token = lease.config.headers.Authorization.slice('Bearer '.length);
    const query = await f.app.request(
      `http://localhost/mcp/station-control?token=${token}`,
      {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );
    expect(query.status).toBe(401);
    const listed = await f.rpc(token);
    expect(listed.status).toBe(200);
    const text = await listed.text();
    const json = text.startsWith('{')
      ? JSON.parse(text)
      : JSON.parse(
          text
            .split('\n')
            .find((line) => line.startsWith('data: '))!
            .slice(6),
        );
    expect(
      json.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(['read_conversation']);
    f.state.record = {
      ...f.state.record,
      conversationId: 'other-conversation',
    };
    expect((await f.rpc(token)).status).toBe(401);
    f.state.record = fixture().state.record;
    f.state.projectId = 'reused-project-id';
    expect((await f.rpc(token)).status).toBe(401);
    f.state.projectId = 'project-id';
    expect(
      (await f.app.request(`${path}/${lease.leaseId}`, { method: 'DELETE' }))
        .status,
    ).toBe(200);
    expect((await f.rpc(token)).status).toBe(401);
  });

  test('refuses future calls and new issuance when the issuing device loses authority', async () => {
    const f = fixture();
    const lease = await issued(await f.create());
    const token = lease.config.headers.Authorization.slice('Bearer '.length);
    f.state.issuerCurrent = false;
    expect((await f.rpc(token)).status).toBe(401);
    expect((await f.create()).status).toBe(403);
    const fresh = fixture({ ...operator, deviceId: 'fresh-device' });
    expect(
      (
        await fresh.app.request(`${path}/${lease.leaseId}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
  });

  test('expires clients, revokes all Session leases on stop, and loses them on restart', async () => {
    const f = fixture();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const expired = await issued(
      await f.create({ ...request, ttlSeconds: 60 }),
    );
    const expiredToken = expired.config.headers.Authorization.slice(
      'Bearer '.length,
    );
    now += 60_001;
    expect((await f.rpc(expiredToken)).status).toBe(401);
    const current = await issued(await f.create());
    const token = current.config.headers.Authorization.slice('Bearer '.length);
    revokeStationControlMcpToken('real-session');
    expect((await f.rpc(token)).status).toBe(401);
    const afterStop = await issued(await f.create());
    __resetStationControlMcpTokensForTests();
    expect(
      (
        await f.rpc(
          afterStop.config.headers.Authorization.slice('Bearer '.length),
        )
      ).status,
    ).toBe(401);
  });
});
