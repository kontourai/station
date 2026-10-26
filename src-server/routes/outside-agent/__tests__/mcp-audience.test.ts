// This non-distributable composition replaces only the compiled refusal; released composition is covered separately.
import '@modelcontextprotocol/server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { MCPServerRegistry, type ServerProviderDeps } from '@voltagent/core';
import { createVoltAgentApp } from '@voltagent/server-hono';
import { expect, test, vi } from 'vitest';
import {
  issuer,
  outsideMcpFixture,
} from '../../../__test-utils__/outside-agent-mcp-fixture.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { mintStationControlMcpToken } from '../../../runtime/mcp/station-control-mcp-token.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { getInternalApiToken } from '../../../utils/internal-api-token.js';
import { createEngineOAuthProxyRoutes } from '../../mcp/engine-oauth-proxy-route.js';
import { createStationControlMcpRoutes } from '../../mcp/station-control-mcp-route.js';

vi.mock('../../../security/outside-agent-release-guard.js', () => ({
  outsideAgentReleaseGuard: async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

test('every credential type crosses every MCP family through runtime admission and the real VoltAgent/internal routers', async () => {
  const f = await outsideMcpFixture();
  const security = new EnvironmentSecurityService({ homeDir: f.home });
  const operator = await security.initialize();
  const pairing = security.devicePairing;
  const offer = pairing.createOffer({
    endpoint: issuer,
    scope: DEFAULT_GRANT_PAIRING_SCOPE,
  });
  const pending = pairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'matrix',
    source: 'pairing-code',
    requesterPosition: 'unproven',
  });
  pairing.confirmRequest(pending.requestId, { kind: 'presented-credential' });
  const device = pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: pending.requestId,
  });
  const voltEffects = vi.fn();
  const registry = new MCPServerRegistry();
  const example = {
    initialize() {},
    getMetadata: () => ({
      id: 'example',
      name: 'Example',
      protocols: { http: true },
    }),
    handleStreamableHttpRequest: async ({
      res,
    }: {
      res: {
        writeHead(status: number, headers: Record<string, string>): void;
        end(body: string): void;
      };
    }) => {
      voltEffects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    },
  };
  registry.register(example, {});
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: () => 'info' as const,
  };
  const { app } = await createVoltAgentApp(
    { mcp: { registry } } as ServerProviderDeps,
    {
      configureFullApp({ app, routes }) {
        configureRuntimeHttp({
          app,
          logger,
          eventBus: { emit: vi.fn() } as never,
          security: {
            verifyCredential: (token, request) =>
              request
                ? security.authorizeCredential(token, request)
                : security.verifyCredential(token),
            recognizeCredential: (token) => security.verifyCredential(token),
            resolveGrantedScope: (token) => security.resolveGrantedScope(token),
            resolveCredentialAuthority: (token) =>
              security.verifyOperatorCredential(token)
                ? 'operator-credential'
                : security.identifyDevice(token)
                  ? 'device-credential'
                  : undefined,
            maxFailures: 1000,
          },
        });
        app.route('', f.server.app);
        app.route('', createStationControlMcpRoutes({ port: 43141 }));
        app.route('', createEngineOAuthProxyRoutes());
        app.get('/api/projects', (c) => c.json({ success: true }));
        routes.mcp();
      },
    },
    43141,
  );
  // Generic Station CORS must not answer this feature's preflight or grant cookie authority.
  const cors = await f.request(
    '/mcp',
    {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
      },
    },
    { app },
  );
  expect(cors.status).toBe(403);
  expect(cors.headers.get('access-control-allow-credentials')).toBeNull();
  expect(app.routes.some((r) => r.path === '/mcp/servers')).toBe(true);
  expect(app.routes.some((r) => r.path === '/mcp/:serverId/mcp')).toBe(true);
  const tokens = f.grant();
  const internal = mintStationControlMcpToken(
    'matrix-internal',
    'http-header-token',
  ).token;
  const knowledge = mintStationControlMcpToken(
    'matrix-knowledge',
    'http-header-token',
    undefined,
    undefined,
    undefined,
    'station-knowledge',
  ).token;
  const proxy = mintStationControlMcpToken(
    'matrix-proxy',
    'http-header-token',
    undefined,
    undefined,
    undefined,
    'oauth-proxy:example',
  ).token;
  const credentials = [
    ['outside', tokens.accessToken],
    ['refresh', tokens.refreshToken],
    ['code', `oac_${'a'.repeat(43)}`],
    ['station-control', internal],
    ['knowledge', knowledge],
    ['proxy', proxy],
    ['device', device.credential],
    ['operator', operator.credential],
    ['anonymous', ''],
    ['raw-internal', ''],
  ];
  for (const [kind, token] of credentials) {
    for (const [method, path] of [
      ['POST', '/mcp'],
      ['POST', '/mcp/station-control'],
      ['GET', '/mcp/servers'],
      ['GET', '/mcp/servers/example'],
      ['POST', '/mcp/example/mcp'],
      ['POST', '/mcp/oauth-proxy/example'],
      ['GET', '/api/projects'],
    ]) {
      const before = voltEffects.mock.calls.length;
      const response = await f.request(
        path,
        {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(kind === 'raw-internal'
              ? {
                  'x-station-internal-token': getInternalApiToken(),
                  'x-station-proxy-caller': 'local',
                }
              : {}),
            'content-type': 'application/json',
          },
          ...(method === 'POST'
            ? {
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'initialize',
                  params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'matrix', version: '1' },
                  },
                }),
              }
            : {}),
        },
        { app },
      );
      const positive =
        (path === '/mcp' && kind === 'outside') ||
        (path === '/mcp/station-control' && kind === 'station-control') ||
        (['device', 'operator', 'raw-internal'].includes(kind!) &&
          [
            '/mcp/servers',
            '/mcp/servers/example',
            '/mcp/example/mcp',
            '/api/projects',
          ].includes(path!));
      expect(
        response.status,
        `${kind} -> ${method} ${path}: ${await response.clone().text()}`,
      ).toBe(
        positive
          ? 200
          : path === '/mcp' && kind === 'raw-internal'
            ? 404
            : path === '/mcp/oauth-proxy/example' &&
                !['outside', 'refresh', 'code'].includes(kind!)
              ? 404
              : 401,
      );
      await response.body?.cancel();
      if (!positive) expect(voltEffects.mock.calls.length).toBe(before);
    }
  }
  // Even a valid internal attestation cannot launder an outside bearer into another family.
  const mixed = await f.request(
    '/mcp/servers',
    {
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'x-station-internal-token': getInternalApiToken(),
        'x-station-proxy-caller': 'local',
      },
    },
    { app },
  );
  expect(mixed.status).toBe(401);
});
