/**
 * #3279: two people connect the same OAuth MCP server with their own
 * accounts. Each one's turn reaches the server with their own token, and
 * neither can complete, list, or use the other's credential or binding.
 *
 * Real stack: the secured runtime routes (pairing-scope gate, request
 * principal resolution), the MCP service, the credential stores, the Agent
 * tool loader, and the authorized-turn correlation seam the orchestration
 * service uses for Station-agent turns. Only the remote OAuth/MCP server is a
 * fixture (fetch stub), and paired-device credentials stand in for the
 * people's authenticated requests.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PAIRING_SCOPE_ACCESS_MANAGE,
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
} from '@kontourai/station-contracts';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

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
const { createAuthorizedTurnCorrelation, runWithAuthorizedTurnCorrelation } =
  await import('../../../runtime/conversation/authorized-turn-correlation.js');
const { createMCPToolProvenanceGeneration } = await import(
  '../../orchestration/mcp-tool-provenance.js'
);
const { FileSecretBindingAdministration, SecretBindingIntegrationService } =
  await import('../../secrets/secret-binding-administration.js');
const { MCPService } = await import('../mcp-service.js');

// Created first so its after-hook removes the home after everything else.
const makeTempDir = trackTempDirs();

const SERVER = 'mail';
const PORT = 43142;
const GRANTED_SCOPE = `${PAIRING_SCOPE_ORCHESTRATION_OPERATE} ${PAIRING_SCOPE_ACCESS_MANAGE}`;

/** Two people on paired devices bound to their tailnet identities, plus a
 * device paired without a person (per-device attribution, not a person). */
const DEVICES = {
  'alice-credential': {
    id: 'device-alice',
    name: 'Alice laptop',
    principalBinding: {
      provider: 'tailscale-serve',
      subject: 'alice',
      approvedAt: 1,
      approvalId: 'approval-alice',
      approvedBy: 'operator',
    },
  },
  'bob-credential': {
    id: 'device-bob',
    name: 'Bob laptop',
    principalBinding: {
      provider: 'tailscale-serve',
      subject: 'bob',
      approvedAt: 1,
      approvalId: 'approval-bob',
      approvedBy: 'operator',
    },
  },
  'dave-credential': {
    id: 'device-dave',
    name: 'Dave laptop',
    principalBinding: {
      provider: 'tailscale-serve',
      subject: 'dave',
      approvedAt: 1,
      approvalId: 'approval-dave',
      approvedBy: 'operator',
    },
  },
  'kiosk-credential': { id: 'device-kiosk', name: 'Kiosk' },
  // A device the operator allowed to run commands (coding:exec).
  'exec-credential': { id: 'device-exec', name: 'Exec' },
} as const;
type Credential = keyof typeof DEVICES;

const ALICE = humanPrincipal('tailscale-serve', 'alice', 'alice').id;
const BOB = humanPrincipal('tailscale-serve', 'bob', 'bob').id;
const DAVE = humanPrincipal('tailscale-serve', 'dave', 'dave').id;

function headers(credential: Credential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential}`,
    'content-type': 'application/json',
  };
}

function loopbackEnv() {
  return { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;
}

function runtimeContext(
  app: Hono,
  loader: InstanceType<typeof ConfigLoader>,
  service: InstanceType<typeof MCPService>,
  home: string,
) {
  const identifyDevice = (credential: string) =>
    (DEVICES as Record<string, (typeof DEVICES)[Credential]>)[credential];
  const devicePairing = new Proxy(
    { identifyDevice },
    {
      get: (target, property) =>
        property in target ? Reflect.get(target, property) : () => undefined,
    },
  );
  const environmentSecurityService = new Proxy(
    {
      authorizeCredential: (credential: string) => credential in DEVICES,
      verifyCredential: (credential: string) => credential in DEVICES,
      verifyOperatorCredential: () => false,
      resolveGrantedScope: (credential: string) =>
        credential === 'exec-credential'
          ? `${GRANTED_SCOPE} coding:exec`
          : credential in DEVICES
            ? GRANTED_SCOPE
            : undefined,
      identifyDevice,
      devicePairing,
      pseudonymizePairingAuditSource: () => 'connected-accounts-e2e',
    },
    {
      get: (target, property) =>
        property in target ? Reflect.get(target, property) : () => undefined,
    },
  );
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
  const secretBindingAdministration = new FileSecretBindingAdministration(home);
  const context = new Proxy(
    {
      app,
      port: PORT,
      appConfig: {},
      configLoader: loader,
      mcpService: service,
      secretBindingAdministration,
      // The production consumer service, so bind/unbind reach a real grant
      // and a real integration document.
      secretBindingIntegrationAdministration:
        new SecretBindingIntegrationService(
          secretBindingAdministration,
          loader,
        ),
      logger,
      deploymentAuthentication: undefined,
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
      reloadAgents: vi.fn(async () => undefined),
      // Personal-mode wiring reads these at configuration time.
      orchestrationEventStore: new Proxy(
        {
          sessionTurnBoundaryAuthority: () => ({
            reconcile: () => ({ kind: 'unavailable' }),
          }),
        },
        {
          get: (target, property) =>
            property in target
              ? Reflect.get(target, property)
              : () => undefined,
        },
      ),
      taskGraphService: new Proxy(
        { listTasks: () => [] },
        {
          get: (target, property) =>
            property in target
              ? Reflect.get(target, property)
              : () => undefined,
        },
      ),
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

/** One OAuth authorization server + MCP resource that issues a distinct
 * token per authorization code and records which token each call carried. */
async function startFixture() {
  const tokensByCode: Record<string, string> = {
    'code-alice': 'token-alice',
    'code-bob': 'token-bob',
  };
  const issued = new Set(Object.values(tokensByCode));
  const toolCalls: Array<{ authorization: string | undefined; value: string }> =
    [];
  const mcpHandler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'mail-fixture', version: '1.0.0' });
      server.registerTool(
        'whoami',
        {
          description: 'Reports the mailbox the call authenticated as.',
          inputSchema: { value: z.string().optional() },
        },
        async ({ value }) => ({
          content: [{ type: 'text', text: value ?? 'ok' }],
        }),
      );
      return server;
    },
    { legacy: 'reject' },
  );
  const origin = 'https://mail-fixture.example';
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
          client_id: 'station-mail-client',
          token_endpoint_auth_method: 'none',
        });
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(await request.text());
        const token = tokensByCode[params.get('code') ?? ''];
        if (
          params.get('grant_type') !== 'authorization_code' ||
          !token ||
          !params.get('code_verifier')
        )
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({
          access_token: token,
          token_type: 'Bearer',
          scope: 'mcp',
        });
      }
      if (url.pathname === '/mcp') {
        const authorization = request.headers.get('authorization') ?? undefined;
        if (!authorization || !issued.has(authorization.slice(7))) {
          return new Response('authorization required', {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
            },
          });
        }
        if (request.method === 'POST') {
          const body = (await request.clone().json()) as {
            method?: string;
            params?: { arguments?: { value?: string } };
          };
          if (body.method === 'tools/call')
            toolCalls.push({
              authorization,
              value: body.params?.arguments?.value ?? '',
            });
        }
        return mcpHandler.fetch(request);
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return { origin, toolCalls, close: () => mcpHandler.close() };
}

async function post(
  app: Hono,
  path: string,
  credential: Credential,
  body: unknown,
  method = 'POST',
) {
  const response = await app.request(
    path,
    { method, headers: headers(credential), body: JSON.stringify(body) },
    loopbackEnv(),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

/** Status plus the exact response bytes, for indistinguishability checks. */
async function raw(
  app: Hono,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  credential: Credential,
  body?: unknown,
) {
  const response = await app.request(
    path,
    {
      method,
      headers: headers(credential),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    loopbackEnv(),
  );
  return { status: response.status, body: await response.text() };
}

async function get(app: Hono, path: string, credential: Credential) {
  const response = await app.request(
    path,
    { method: 'GET', headers: headers(credential) },
    loopbackEnv(),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

/** Starts consent as `credential` and returns the paste-back URL for `code`. */
async function consentUrl(app: Hono, credential: Credential, code: string) {
  const started = await post(
    app,
    `/integrations/${SERVER}/oauth/authorize`,
    credential,
    { mode: 'remote' },
  );
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const authorizationUrl = new URL(started.body.data.authorizationUrl);
  return `${authorizationUrl.searchParams.get('redirect_uri')}?code=${code}&state=${authorizationUrl.searchParams.get('state')}`;
}

test('two principals each reach the MCP server with their own token and cannot use each other’s credential or binding', async () => {
  const fixture = await startFixture();
  const home = makeTempDir('station-connected-accounts-');
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
      { warn: vi.fn(), debug: vi.fn() },
      undefined,
      PORT,
      undefined,
      undefined,
      custody,
    );
    const app = new Hono();
    configureRuntimeRoutes(runtimeContext(app, loader, service, home));

    const created = await post(app, '/integrations', 'alice-credential', {
      id: SERVER,
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: `${fixture.origin}/mcp`,
      credentialOwnership: { owner: 'principal' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    await service.setEnabled(SERVER, true);
    expect((await loader.loadIntegration(SERVER)).credentialOwnership).toEqual({
      owner: 'principal',
    });

    // A device paired without a person cannot own a personal credential.
    const kiosk = await post(
      app,
      `/integrations/${SERVER}/oauth/authorize`,
      'kiosk-credential',
      { mode: 'remote' },
    );
    expect(kiosk.status).toBe(400);
    expect(kiosk.body.error).toContain(
      'Connect your account as a signed-in person',
    );

    // Both people start consent; Bob cannot complete Alice's flow.
    const aliceCallback = await consentUrl(
      app,
      'alice-credential',
      'code-alice',
    );
    const bobCallback = await consentUrl(app, 'bob-credential', 'code-bob');
    const stolen = await post(
      app,
      `/integrations/${SERVER}/oauth/callback`,
      'bob-credential',
      { callbackUrl: aliceCallback },
    );
    expect(stolen.status).toBe(400);
    // Bob's lookup only finds Bob's own flow, whose state Alice's URL fails.
    expect(stolen.body.error).toContain('state does not match');
    for (const [credential, callbackUrl] of [
      ['alice-credential', aliceCallback],
      ['bob-credential', bobCallback],
    ] as const) {
      const finished = await post(
        app,
        `/integrations/${SERVER}/oauth/callback`,
        credential,
        { callbackUrl },
      );
      expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    }
    // One person's consent never becomes the integration's shared health.
    expect(
      (await loader.loadIntegration(SERVER)).probe?.authorization,
    ).not.toEqual({ state: 'authorized' });

    // Views: owner and availability only, and only the caller's own.
    const aliceAccount = await get(
      app,
      `/integrations/${SERVER}/account`,
      'alice-credential',
    );
    expect(aliceAccount.body.data).toMatchObject({
      ownership: 'principal',
      connectedAs: 'you',
      personal: { connected: true },
      shared: { usable: false, connected: false },
      catalogAvailable: true,
    });
    expect(JSON.stringify(aliceAccount.body)).not.toContain('token-');
    const daveAccount = await get(
      app,
      `/integrations/${SERVER}/account`,
      'dave-credential',
    );
    expect(daveAccount.body.data).toMatchObject({
      connectedAs: null,
      personal: { connected: false },
    });

    // The Agent loads tools from the catalog Alice's own connection listed.
    const tools = await loadAgentTools(
      'mail-agent',
      { tools: { mcpServers: [SERVER], available: ['*'] } } as never,
      loader,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      PORT,
      createMCPToolProvenanceGeneration(),
      undefined,
      custody,
    );
    const whoami = tools.find((tool) => tool.name.endsWith('whoami'));
    expect(whoami, tools.map((tool) => tool.name).join(',')).toBeDefined();
    const callAs = (principalId: string | undefined, value: string) => {
      const run = () => whoami!.execute!({ value }, {} as never);
      return principalId
        ? runWithAuthorizedTurnCorrelation(
            createAuthorizedTurnCorrelation({
              accountId: principalId,
              sessionId: `session-${value}`,
            }),
            run,
          )
        : run();
    };

    await callAs(ALICE, 'alice-turn');
    await callAs(BOB, 'bob-turn');
    await callAs(ALICE, 'alice-again');
    expect(fixture.toolCalls).toEqual([
      { authorization: 'Bearer token-alice', value: 'alice-turn' },
      { authorization: 'Bearer token-bob', value: 'bob-turn' },
      { authorization: 'Bearer token-alice', value: 'alice-again' },
    ]);

    // No personal credential: a truthful refusal, never someone else's token.
    await expect(callAs(DAVE, 'dave-turn')).rejects.toThrow(
      `Connect your account for integration '${SERVER}'`,
    );
    // A device-only session owner and a call outside an authorized turn act
    // for no person.
    await expect(
      callAs(
        humanPrincipal('device', 'device-kiosk', 'Kiosk').id,
        'kiosk-turn',
      ),
    ).rejects.toThrow('Connect your account');
    await expect(callAs(undefined, 'no-turn')).rejects.toThrow(
      'Connect your account',
    );
    expect(fixture.toolCalls.map((call) => call.value)).toEqual([
      'alice-turn',
      'bob-turn',
      'alice-again',
    ]);

    // Bob disconnects: his next turn refuses; Alice's still works.
    const disconnected = await post(
      app,
      `/integrations/${SERVER}/account`,
      'bob-credential',
      undefined,
      'DELETE',
    );
    expect(disconnected.body.data).toMatchObject({ connectedAs: null });
    await expect(callAs(BOB, 'bob-after-disconnect')).rejects.toThrow(
      'Connect your account',
    );
    await callAs(ALICE, 'alice-after-bob-left');
    expect(fixture.toolCalls.at(-1)).toEqual({
      authorization: 'Bearer token-alice',
      value: 'alice-after-bob-left',
    });

    // Secret bindings: nothing can consume a person-owned binding yet, so
    // the route refuses to create one, for the caller themselves too.
    for (const extra of [{}, { projectSlug: 'sales' }]) {
      expect(
        await raw(app, 'POST', '/api/secret-bindings', 'alice-credential', {
          id: 'alice-mail',
          name: 'Alice mail',
          authRef: { env: 'ALICE_MAIL_TOKEN' },
          owner: 'self',
          ...extra,
        }),
      ).toEqual({
        status: 400,
        body: JSON.stringify({
          success: false,
          error: 'Person-owned secret bindings are not available yet.',
        }),
      });
    }
    // A person-owned record can still exist (written earlier or by hand):
    // create it through the real writer, then give it the owner it would
    // have persisted. It is listed and readable only by its owner.
    const bindingsFile = join(home, 'security', 'secret-bindings.json');
    const editBinding = async (
      id: string,
      edit: (binding: Record<string, unknown>) => void,
    ) => {
      const document = JSON.parse(await readFile(bindingsFile, 'utf8'));
      edit(document.bindings[id]);
      await writeFile(bindingsFile, JSON.stringify(document), { mode: 0o600 });
    };
    const aliceBinding = await post(
      app,
      '/api/secret-bindings',
      'alice-credential',
      {
        id: 'alice-mail',
        name: 'Alice mail',
        authRef: { env: 'ALICE_MAIL_TOKEN' },
      },
    );
    expect(aliceBinding.status, JSON.stringify(aliceBinding.body)).toBe(201);
    await editBinding('alice-mail', (binding) => {
      binding.owner = { kind: 'principal', principalId: ALICE };
    });
    expect(
      (await get(app, '/api/secret-bindings/alice-mail', 'alice-credential'))
        .body.data.owner,
    ).toEqual({ kind: 'principal', principalId: ALICE });
    const shared = await post(app, '/api/secret-bindings', 'bob-credential', {
      id: 'shared-crm',
      name: 'Shared CRM',
      authRef: { env: 'SHARED_CRM_TOKEN' },
    });
    expect(shared.status).toBe(201);
    const ids = async (credential: Credential) =>
      (
        (await get(app, '/api/secret-bindings', credential)).body
          .data as Array<{
          id: string;
        }>
      ).map((binding) => binding.id);
    expect(await ids('alice-credential')).toEqual(['alice-mail', 'shared-crm']);
    expect(await ids('bob-credential')).toEqual(['shared-crm']);

    // A stdio integration that can consume bindings (never spawned here).
    const LOCAL = 'local-mail';
    await loader.saveIntegration(LOCAL, {
      id: LOCAL,
      kind: 'mcp',
      transport: 'stdio',
      command: 'local-mail-mcp',
      env: { MAIL_TOKEN: 'declared', CRM_TOKEN: 'declared' },
    });
    const consumer = (envName: string, expectedRevision: number) => ({
      integrationId: LOCAL,
      envName,
      expectedRevision,
    });
    const acpHeader = (expectedRevision: number) => ({
      kind: 'acp-provider-header',
      connectionId: 'conn-mail',
      providerId: 'provider-mail',
      headerName: 'X-Mail-Token',
      expectedRevision,
    });
    const NOT_FOUND = {
      status: 404,
      body: JSON.stringify({
        success: false,
        error: 'Secret binding not found.',
      }),
    };
    const bobAgainstHiddenAndMissing = async (
      method: 'GET' | 'POST' | 'PUT',
      suffix: string,
      body: unknown,
    ) => ({
      hidden: await raw(
        app,
        method,
        `/api/secret-bindings/alice-mail${suffix}`,
        'bob-credential',
        body,
      ),
      missing: await raw(
        app,
        method,
        `/api/secret-bindings/no-such-binding${suffix}`,
        'bob-credential',
        body,
      ),
    });
    // Someone else's binding answers exactly like an id that does not exist:
    // same status, same bytes, on every route that names a binding.
    const probes: Array<[string, 'GET' | 'POST' | 'PUT', string, unknown]> = [
      ['get', 'GET', '', undefined],
      [
        'replace',
        'PUT',
        '',
        { name: 'Taken', authRef: { env: 'TAKEN' }, expectedRevision: 1 },
      ],
      ['revoke', 'POST', '/revoke', { expectedRevision: 1 }],
      ['bind', 'POST', '/bind', consumer('MAIL_TOKEN', 1)],
      ['unbind', 'POST', '/unbind', consumer('MAIL_TOKEN', 1)],
      ['acp-bind', 'POST', '/bind', acpHeader(1)],
      ['acp-unbind', 'POST', '/unbind', acpHeader(1)],
    ];
    for (const [label, method, suffix, body] of probes) {
      const { hidden, missing } = await bobAgainstHiddenAndMissing(
        method,
        suffix,
        body,
      );
      expect(hidden, label).toEqual(missing);
      expect(hidden, label).toEqual(NOT_FOUND);
    }

    // The owner cannot grant their binding to a shared child: a stdio MCP
    // child or ACP provider names no principal, so it could never use it.
    const PERSON_GRANT = {
      status: 400,
      body: JSON.stringify({
        success: false,
        error:
          'A person-owned secret binding cannot be granted to a shared integration or provider.',
      }),
    };
    for (const [label, body] of [
      ['mcp-env', consumer('MAIL_TOKEN', 1)],
      ['acp-header', acpHeader(1)],
    ] as const) {
      expect(
        await raw(
          app,
          'POST',
          '/api/secret-bindings/alice-mail/bind',
          'alice-credential',
          body,
        ),
        label,
      ).toEqual(PERSON_GRANT);
    }
    const aliceAfter = (
      await get(app, '/api/secret-bindings/alice-mail', 'alice-credential')
    ).body.data;
    expect(aliceAfter).toMatchObject({ revision: 1, grants: [] });
    expect(aliceAfter.acpProviderHeaderGrants).toBeUndefined();
    expect((await loader.loadIntegration(LOCAL)).secretEnvRefs).toBeUndefined();
    // A grant already on record (written before the refusal) does not let
    // bind skip `grant` and write the reference.
    await editBinding('alice-mail', (binding) => {
      binding.grants = [
        {
          kind: 'mcp-integration-env',
          integrationId: LOCAL,
          envName: 'MAIL_TOKEN',
        },
      ];
    });
    expect(
      await raw(
        app,
        'POST',
        '/api/secret-bindings/alice-mail/bind',
        'alice-credential',
        consumer('MAIL_TOKEN', 1),
      ),
    ).toEqual(PERSON_GRANT);
    expect((await loader.loadIntegration(LOCAL)).secretEnvRefs).toBeUndefined();

    // An instance binding on a command-launching server is the environment of
    // a command Station will run, so a person without the operator's
    // coding:exec grant cannot attach one, whatever their account...
    const refusedBind = await post(
      app,
      '/api/secret-bindings/shared-crm/bind',
      'bob-credential',
      consumer('CRM_TOKEN', 1),
    );
    expect(refusedBind.status, JSON.stringify(refusedBind.body)).toBe(403);
    expect(refusedBind.body.code).toBe('command-not-granted');
    expect((await loader.loadIntegration(LOCAL)).secretEnvRefs).toBeUndefined();
    // ...and binds exactly as before for a device that holds the grant.
    const crmBind = await post(
      app,
      '/api/secret-bindings/shared-crm/bind',
      'exec-credential',
      consumer('CRM_TOKEN', 1),
    );
    expect(crmBind.status, JSON.stringify(crmBind.body)).toBe(200);
    expect(crmBind.body.data).toMatchObject({
      outcome: 'complete',
      binding: {
        id: 'shared-crm',
        revision: 2,
        grants: [
          {
            kind: 'mcp-integration-env',
            integrationId: LOCAL,
            envName: 'CRM_TOKEN',
          },
        ],
      },
    });
    // Every caller, including a device without a person, sees every
    // reference: none can name a person's binding.
    for (const credential of [
      'alice-credential',
      'bob-credential',
      'kiosk-credential',
    ] as const) {
      expect(
        (
          await get(
            app,
            `/api/secret-bindings/integrations/${LOCAL}`,
            credential,
          )
        ).body.data,
        credential,
      ).toEqual({
        integrationId: LOCAL,
        secretEnvBindingIds: { CRM_TOKEN: 'shared-crm' },
      });
    }
    // On an env bound to another binding, Alice's hidden id and a missing id
    // still answer Bob identically.
    const boundEnv = await bobAgainstHiddenAndMissing(
      'POST',
      '/bind',
      consumer('CRM_TOKEN', 1),
    );
    expect(boundEnv.hidden).toEqual(boundEnv.missing);
    // The body cannot name another principal as owner.
    const forged = await post(app, '/api/secret-bindings', 'bob-credential', {
      id: 'forged',
      name: 'Forged',
      authRef: { env: 'FORGED' },
      owner: { kind: 'principal', principalId: ALICE },
    });
    expect(forged.status).toBe(400);
    expect(
      (await get(app, '/api/secret-bindings/alice-mail', 'alice-credential'))
        .status,
    ).toBe(200);
    // A device without a person cannot own a binding either.
    const kioskBinding = await post(
      app,
      '/api/secret-bindings',
      'kiosk-credential',
      {
        id: 'kiosk-own',
        name: 'Kiosk own',
        authRef: { env: 'KIOSK' },
        owner: 'self',
      },
    );
    expect(kioskBinding.status).toBe(400);
  } finally {
    expect((await custody.shutdown()).state).toBe('settled');
    await fixture.close();
    vi.unstubAllGlobals();
  }
});
