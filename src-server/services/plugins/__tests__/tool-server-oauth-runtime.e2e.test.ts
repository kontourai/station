import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIRING_SCOPE_ORCHESTRATION_OPERATE } from '@kontourai/station-contracts';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../../utils/internal-api-token.js';

const runtimeSupport = vi.hoisted(() => {
  const service = new Proxy({}, { get: () => () => undefined });
  return {
    service,
    notificationService: { list: vi.fn(() => []) },
  };
});

vi.mock('../../../runtime/routes/runtime-route-support.js', () => ({
  configureRuntimeSupportServices: () => ({
    schedulerService: runtimeSupport.service,
    notificationService: runtimeSupport.notificationService,
    attentionProjection: runtimeSupport.service,
    webPushService: runtimeSupport.service,
    webPushEnabled: false,
  }),
  createRuntimeSystemRouteDeps: () => runtimeSupport.service,
}));

const { ConfigLoader } = await import('../../../domain/config-loader.js');
const { configureRuntimeRoutes } = await import(
  '../../../runtime/routes/runtime-routes.js'
);
const { loadAgentTools } = await import('../../../runtime/mcp/mcp-manager.js');
const { createMCPToolProvenanceGeneration } = await import(
  '../../orchestration/mcp-tool-provenance.js'
);
const { requiredExternalSurfaceCapability } = await import(
  '../../../security/pairing-route-scopes.js'
);
const { MCPService } = await import('../mcp-service.js');

const OPERATOR_CREDENTIAL = 'oauth-runtime-operator-credential';
const HOSTED_TENANT_REGISTRY_ENV = 'STATION_HOSTED_TENANT_REGISTRY_FILE';

function operatorHeaders(contentType = true): Record<string, string> {
  return {
    Authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_TENANT_HEADER]: 'oauth-tenant',
    ...(contentType ? { 'content-type': 'application/json' } : {}),
  };
}

function loopbackEnv() {
  return { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;
}

function runtimeContext(
  app: Hono,
  loader: InstanceType<typeof ConfigLoader>,
  service: InstanceType<typeof MCPService>,
  logger: Record<string, unknown>,
) {
  const devicePairing = new Proxy(
    { identifyDevice: () => undefined },
    {
      get: (target, property) =>
        property in target ? Reflect.get(target, property) : () => undefined,
    },
  );
  const environmentSecurityService = new Proxy(
    {
      authorizeCredential: (credential: string) =>
        credential === OPERATOR_CREDENTIAL,
      verifyCredential: (credential: string) =>
        credential === OPERATOR_CREDENTIAL,
      verifyOperatorCredential: (credential: string) =>
        credential === OPERATOR_CREDENTIAL,
      resolveGrantedScope: (credential: string) =>
        credential === OPERATOR_CREDENTIAL
          ? PAIRING_SCOPE_ORCHESTRATION_OPERATE
          : undefined,
      devicePairing,
      pseudonymizePairingAuditSource: () => 'oauth-e2e-source',
    },
    {
      get: (target, property) =>
        property in target ? Reflect.get(target, property) : () => undefined,
    },
  );
  const context = new Proxy(
    {
      app,
      port: 43141,
      appConfig: {},
      configLoader: loader,
      mcpService: service,
      logger,
      eventBus: { emit: vi.fn() },
      environmentSecurityService,
      activeAgents: new Map(),
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      reloadAgents: vi.fn(),
    },
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return new Proxy(() => undefined, {
          get: () => () => undefined,
        });
      },
    },
  );
  Reflect.set(context as object, 'buildRuntimeContext', () => context);
  return context as never;
}

type OAuthFixture = {
  close(): Promise<void>;
  origin: string;
  endpointBRequestAuthorizations: Array<string | undefined>;
  protectedRequestAuthorizations: Array<string | undefined>;
  protectedResponses: Array<{ method: string; status: number; body: string }>;
  protectedErrors: string[];
};

async function startOAuthFixture(): Promise<OAuthFixture> {
  const endpointBRequestAuthorizations: Array<string | undefined> = [];
  const protectedRequestAuthorizations: Array<string | undefined> = [];
  const protectedResponses: Array<{
    method: string;
    status: number;
    body: string;
  }> = [];
  const protectedErrors: string[] = [];
  const mcpHandler = createMcpHandler(
    () => {
      const server = new McpServer({
        name: 'oauth-runtime-proof',
        version: '1.0.0',
      });
      server.registerTool(
        'proof',
        {
          description: 'Proves the authenticated runtime connection.',
          inputSchema: { value: z.string().optional() },
        },
        async ({ value }) => ({
          content: [{ type: 'text', text: value ?? 'authorized' }],
        }),
      );
      return server;
    },
    { legacy: 'reject' },
  );

  const origin = 'https://oauth-fixture.example';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ['mcp'],
        });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['mcp'],
        });
      }
      if (url.pathname === '/register') {
        const registered = (await request.json()) as Record<string, unknown>;
        return Response.json({
          ...registered,
          client_id: 'station-runtime-proof',
          token_endpoint_auth_method: 'none',
        });
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(await request.text());
        if (
          params.get('grant_type') !== 'authorization_code' ||
          params.get('code') !== 'fixture-code' ||
          !params.get('code_verifier')
        ) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        return Response.json({
          access_token: 'runtime-access-token',
          refresh_token: 'runtime-refresh-token',
          token_type: 'Bearer',
          scope: 'mcp',
        });
      }
      if (url.pathname === '/mcp') {
        const authorization = request.headers.get('authorization') ?? undefined;
        protectedRequestAuthorizations.push(authorization);
        if (authorization !== 'Bearer runtime-access-token') {
          return new Response('authorization required', {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
            },
          });
        }
        let result: Response;
        try {
          result = await mcpHandler.fetch(request);
        } catch (error) {
          protectedErrors.push(
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
        protectedResponses.push({
          method: request.method,
          status: result.status,
          body: await result.clone().text(),
        });
        return result;
      }
      if (url.pathname === '/mcp-b') {
        endpointBRequestAuthorizations.push(
          request.headers.get('authorization') ?? undefined,
        );
        return new Response('authorization required', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp-b", scope="mcp"`,
          },
        });
      }
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp-b') {
        return Response.json({
          resource: `${origin}/mcp-b`,
          authorization_servers: [origin],
          scopes_supported: ['mcp'],
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return {
    close: () => mcpHandler.close(),
    endpointBRequestAuthorizations,
    origin,
    protectedRequestAuthorizations,
    protectedResponses,
    protectedErrors,
  };
}

test('real secured stack: authenticated paste-back reaches the runtime and no public OAuth route exists', async () => {
  const fixture = await startOAuthFixture();
  const home = await mkdtemp(join(tmpdir(), 'station-oauth-runtime-e2e-'));
  const previousHostedRegistry = process.env[HOSTED_TENANT_REGISTRY_ENV];
  const custody = new MCPLocalConnectionCustody();
  try {
    const loader = new ConfigLoader({ projectHomeDir: home });
    const service = new MCPService(
      loader,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { warn: vi.fn() },
      undefined,
      43141,
      undefined,
      undefined,
      custody,
    );
    const app = new Hono();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
      setLevel: vi.fn(),
      getLevel: vi.fn(() => 'info' as const),
    };
    const hostedRegistryPath = join(home, 'hosted-tenants.json');
    await writeFile(
      hostedRegistryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [
          { id: 'oauth-tenant', authority: 'oauth-tenant.example.test' },
        ],
      }),
    );
    process.env[HOSTED_TENANT_REGISTRY_ENV] = hostedRegistryPath;
    configureRuntimeRoutes(runtimeContext(app, loader, service, logger));

    const oauthRoutes = app.routes
      .filter((route) => route.path.includes('/oauth/'))
      .map((route) => ({ method: route.method, path: route.path }));
    expect(
      oauthRoutes,
      'OAuth route guard: only authenticated POST authorize and paste-back routes may be mounted',
    ).toEqual([
      {
        method: 'POST',
        path: '/integrations/:id/oauth/authorize',
      },
      {
        method: 'POST',
        path: '/integrations/:id/oauth/callback',
      },
    ]);
    for (const route of oauthRoutes) {
      expect(
        requiredExternalSurfaceCapability(
          'http',
          route.method,
          route.path.replace(':id', 'oauth-proof'),
        ),
        `OAuth route guard: ${route.method} ${route.path} must require operator scope`,
      ).toMatchObject({
        capability: 'pairing-scope',
        scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
      });
      const unauthenticated = await app.request(
        route.path.replace(':id', 'oauth-proof'),
        {
          method: route.method,
          headers: {
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            [INTERNAL_TENANT_HEADER]: 'oauth-tenant',
            'content-type': 'application/json',
          },
          body:
            route.method === 'POST'
              ? JSON.stringify({
                  mode: 'remote',
                  callbackUrl:
                    'http://127.0.0.1:43141/integrations/oauth-proof/oauth/callback?code=x&state=x',
                })
              : undefined,
        },
        loopbackEnv(),
      );
      expect(
        unauthenticated.status,
        `OAuth route guard: unauthenticated ${route.method} ${route.path} must be rejected`,
      ).toBe(401);
    }

    const createResponse = await app.request(
      '/integrations',
      {
        method: 'POST',
        headers: operatorHeaders(),
        body: JSON.stringify({
          id: 'oauth-proof',
          kind: 'mcp',
          transport: 'streamable-http',
          endpoint: `${fixture.origin}/mcp#operator-view`,
        }),
      },
      loopbackEnv(),
    );
    expect(createResponse.status).toBe(200);

    const authorizeResponse = await app.request(
      '/integrations/oauth-proof/oauth/authorize',
      {
        method: 'POST',
        headers: operatorHeaders(),
        body: JSON.stringify({ mode: 'remote' }),
      },
      loopbackEnv(),
    );
    const authorizeBody = await authorizeResponse.clone().json();
    expect(authorizeResponse.status, JSON.stringify(authorizeBody)).toBe(200);
    const authorization = (await authorizeResponse.json()) as {
      data: { authorizationUrl: string; completionInstructions: string };
    };
    expect(authorization.data.completionInstructions).toContain(
      'copy the full redirected loopback URL from the address bar',
    );
    const authorizationUrl = new URL(authorization.data.authorizationUrl);
    const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
    const state = authorizationUrl.searchParams.get('state');
    expect(redirectUri).toBe(
      'http://127.0.0.1:43141/integrations/oauth-proof/oauth/callback',
    );
    expect(state).toBeTruthy();

    const malformedCallbackResponse = await app.request(
      '/integrations/oauth-proof/oauth/callback',
      {
        method: 'POST',
        headers: operatorHeaders(),
        body: JSON.stringify({ callbackUrl: 'not a URL' }),
      },
      loopbackEnv(),
    );
    expect(malformedCallbackResponse.status).toBe(400);
    expect(await malformedCallbackResponse.text()).toContain(
      'callback URL is not a valid URL',
    );

    const callbackUrl = `${redirectUri}?code=fixture-code&state=${state}`;
    const callbackResponse = await app.request(
      '/integrations/oauth-proof/oauth/callback',
      {
        method: 'POST',
        headers: operatorHeaders(),
        body: JSON.stringify({ callbackUrl }),
      },
      loopbackEnv(),
    );
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.json()).toMatchObject({
      success: true,
      data: {
        probe: { authorization: { state: 'authorized' } },
      },
    });
    const replayResponse = await app.request(
      '/integrations/oauth-proof/oauth/callback',
      {
        method: 'POST',
        headers: operatorHeaders(),
        body: JSON.stringify({ callbackUrl }),
      },
      loopbackEnv(),
    );
    expect(replayResponse.status).toBe(400);
    expect(await replayResponse.text()).toContain('No OAuth consent flow');

    await service.setEnabled('oauth-proof', true);
    const runtimeLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    const mcpToolProvenanceGeneration = createMCPToolProvenanceGeneration();
    const tools = await loadAgentTools(
      'runtime-agent',
      { tools: { mcpServers: ['oauth-proof'], available: ['*'] } } as never,
      loader,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      runtimeLogger,
      43141,
      mcpToolProvenanceGeneration,
      undefined,
      custody,
    );

    expect(fixture.protectedRequestAuthorizations).toContain(
      'Bearer runtime-access-token',
    );
    expect(fixture.protectedErrors).toEqual([]);
    expect(fixture.protectedResponses).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 200 })]),
    );
    expect(runtimeLogger.error.mock.calls).toEqual([]);
    expect(tools.map((tool) => tool.name)).toContain('oauthProof_proof');

    const endpointB = `${fixture.origin}/mcp-b`;
    const current = await loader.loadIntegration('oauth-proof');
    await service.saveIntegration({ ...current, endpoint: endpointB });
    const toolsAfterEndpointChange = await loadAgentTools(
      'runtime-agent',
      { tools: { mcpServers: ['oauth-proof'], available: ['*'] } } as never,
      loader,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      runtimeLogger,
      43141,
      mcpToolProvenanceGeneration,
      undefined,
      custody,
    );

    expect(fixture.endpointBRequestAuthorizations).not.toContain(
      'Bearer runtime-access-token',
    );
    expect(fixture.endpointBRequestAuthorizations[0]).toBeUndefined();
    expect(toolsAfterEndpointChange).toEqual([]);
    expect(
      (await loader.loadIntegration('oauth-proof')).probe?.authorization,
    ).toMatchObject({ state: 'never-authorized' });
  } finally {
    if (previousHostedRegistry === undefined)
      delete process.env[HOSTED_TENANT_REGISTRY_ENV];
    else process.env[HOSTED_TENANT_REGISTRY_ENV] = previousHostedRegistry;
    expect((await custody.shutdown()).state).toBe('settled');
    await fixture.close();
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  }
});
