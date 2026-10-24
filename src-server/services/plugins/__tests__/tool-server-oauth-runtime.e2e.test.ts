import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIRING_SCOPE_ORCHESTRATION_OPERATE } from '@kontourai/station-contracts';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { revokeStationControlMcpToken } from '../../../runtime/mcp/station-control-mcp-token.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import { TaskGraphService } from '../../projects/task-graph-service.js';
import { createEngineMcpOAuthResolver } from '../engine-mcp-oauth.js';

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
  store: EventStore,
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
      // This fixture has no operator-installed account provider. The broad
      // service proxy would otherwise invent one for this optional field.
      deploymentAuthentication: undefined,
      orchestrationEventStore: store,
      taskGraphService: new TaskGraphService(loader.getProjectHomeDir()),
      eventBus: new EventBus(),
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
        expect(registered.redirect_uris).toEqual([
          'http://127.0.0.1:43141/integrations/oauth-proof/oauth/callback',
        ]);
        expect(registered.token_endpoint_auth_method).toBe('none');
        return Response.json({
          ...registered,
          client_id: 'station-runtime-proof',
          token_endpoint_auth_method: 'none',
        });
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(await request.text());
        expect(params.get('resource')).toBe(`${origin}/mcp`);
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
  const store = new EventStore(join(home, 'orchestration.sqlite'));
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
    delete process.env[HOSTED_TENANT_REGISTRY_ENV];
    configureRuntimeRoutes(runtimeContext(app, loader, service, logger, store));

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
    expect(authorizationUrl.searchParams.get('resource')).toBe(
      `${fixture.origin}/mcp`,
    );
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
    const resolveEngine = createEngineMcpOAuthResolver({
      homeDir: () => home,
      port: () => 43141,
      getIntegration: (id) => service.getIntegration(id),
      needsSignIn: (id, resource) => service.markOAuthNeedsSignIn(id, resource),
    });
    const proxyUrls = await resolveEngine(
      [
        {
          id: 'oauth-proof',
          transport: 'streamable-http',
          endpoint: `${fixture.origin}/mcp`,
        },
      ],
      undefined,
      undefined,
      'proxy-engine',
    );
    const engineClient = new Client(
      { name: 'engine-proxy-proof', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    try {
      await engineClient.connect(
        new StreamableHTTPClientTransport(
          new URL(proxyUrls.get('oauth-proof')!),
          { fetch: async (url, init) => app.request(url, init, loopbackEnv()) },
        ),
      );
      expect(
        await engineClient.callTool({
          name: 'proof',
          arguments: { value: 'through secured proxy' },
        }),
      ).toMatchObject({ content: [{ text: 'through secured proxy' }] });
      const invalid = new URL(proxyUrls.get('oauth-proof')!);
      invalid.searchParams.set('token', 'wrong-proxy-token');
      expect((await app.request(invalid.href, {}, loopbackEnv())).status).toBe(
        401,
      );
    } finally {
      await engineClient.close();
      revokeStationControlMcpToken('proxy-engine');
    }

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
    await expect.poll(() => store.close().kind).toBe('closed');
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  }
});
