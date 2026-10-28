import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { OAUTH_CLIENT_ID_REQUIRED_REASON } from '../../../security/tool-server-reason.js';
import {
  FileSecretBindingAdministration,
  SecretBindingIntegrationService,
} from '../../secrets/secret-binding-administration.js';
import { MCPService } from '../mcp-service.js';
import {
  INSTANCE_CREDENTIAL_OWNER,
  OAuthClientIssuerMismatchError,
  OAuthClientRequiredError,
  principalCredentialOwner,
  StationToolServerOAuthProvider,
  toolServerCredentialCandidates,
  toolServerCredentialStoreFor,
  toolServerOAuthClientConfig,
} from '../tool-server-oauth.js';

/**
 * Remote MCP servers without Dynamic Client Registration (Gmail's and Slack's
 * MCP servers, for example) need a client the operator registered, or a
 * Client ID Metadata Document. These drive the real consent flow through
 * `MCPService` against a fake authorization server.
 */

const makeTempDir = trackTempDirs();
const ORIGIN = 'https://as.fixture.example';
const PORT = 43177;
const SERVER = 'byo-client';
const CLIENT_ID = 'byo-client-id.apps.example';
const CLIENT_SECRET = 'byo-client-secret-0f9a4c2e7d61';
const SECRET_ENV = 'STATION_TEST_BYO_CLIENT_SECRET';
const CIMD_URL = 'https://client.example/station/client-metadata.json';
const ALICE = humanPrincipal('tailscale-serve', 'alice', 'alice').id;
const BOB = humanPrincipal('tailscale-serve', 'bob', 'bob').id;

type ServerOptions = {
  dcr: boolean;
  cimd?: boolean;
  authMethods?: string[];
};

type TokenRequest = {
  params: URLSearchParams;
  authorization: string | null;
};

function startAuthorizationServer(options: ServerOptions) {
  const registrations: unknown[] = [];
  const tokenRequests: TokenRequest[] = [];
  let issued = 0;
  const mcpHandler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'byo-proof', version: '1.0.0' });
      server.registerTool('proof', { description: 'Proof.' }, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
      return server;
    },
    { legacy: 'reject' },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
        return Response.json({
          resource: `${ORIGIN}/mcp`,
          authorization_servers: [ORIGIN],
          scopes_supported: ['mail.readonly', 'mail.compose'],
        });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        return Response.json({
          issuer: ORIGIN,
          authorization_endpoint: `${ORIGIN}/authorize`,
          token_endpoint: `${ORIGIN}/token`,
          ...(options.dcr
            ? { registration_endpoint: `${ORIGIN}/register` }
            : {}),
          ...(options.cimd
            ? { client_id_metadata_document_supported: true }
            : {}),
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: options.authMethods ?? [
            'none',
          ],
        });
      if (url.pathname === '/register') {
        const body = (await request.json()) as Record<string, unknown>;
        registrations.push(body);
        return Response.json({ ...body, client_id: 'dcr-registered-client' });
      }
      if (url.pathname === '/token') {
        tokenRequests.push({
          params: new URLSearchParams(await request.text()),
          authorization: request.headers.get('authorization'),
        });
        issued += 1;
        return Response.json({
          access_token: `access-${issued}`,
          refresh_token: `refresh-${issued}`,
          token_type: 'Bearer',
          // Due immediately, so the next read exercises refresh.
          expires_in: 1,
        });
      }
      if (url.pathname === '/mcp') {
        const authorization = request.headers.get('authorization');
        if (!authorization?.startsWith('Bearer access-'))
          return new Response('authorization required', {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        return mcpHandler.fetch(request);
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return { registrations, tokenRequests, close: () => mcpHandler.close() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const home = makeTempDir('station-oauth-byo-');
  const loader = new ConfigLoader({ projectHomeDir: home });
  const auditLogger = { info: vi.fn() };
  const serviceLogger = {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
  const bindings = new FileSecretBindingAdministration(home, {
    environment: { [SECRET_ENV]: CLIENT_SECRET },
    logger: auditLogger,
  });
  const consumers = new SecretBindingIntegrationService(
    bindings,
    loader,
    auditLogger,
  );
  const service = new MCPService(
    loader,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    serviceLogger,
    undefined,
    PORT,
    bindings,
    bindings,
    new MCPLocalConnectionCustody(),
  );
  return {
    home,
    loader,
    bindings,
    consumers,
    service,
    auditLogger,
    serviceLogger,
  };
}

async function createIntegration(
  env: ReturnType<typeof setup>,
  extra: Partial<ToolDef> = {},
) {
  await env.service.saveIntegration({
    id: SERVER,
    kind: 'mcp',
    transport: 'streamable-http',
    endpoint: `${ORIGIN}/mcp`,
    ...extra,
  });
}

async function bindClientSecret(env: ReturnType<typeof setup>) {
  const created = await env.bindings.create({
    id: 'byo-client-secret',
    name: 'BYO client secret',
    authRef: { env: SECRET_ENV },
  });
  const outcome = await env.consumers.bindOAuthClientSecret({
    id: created.id,
    integrationId: SERVER,
    expectedRevision: created.revision,
  });
  expect(outcome.outcome).toBe('complete');
}

async function consent(
  env: ReturnType<typeof setup>,
  actor?: { principalId: string },
  requested?: { scopes?: string[] },
) {
  const started = await env.service.startOAuth(
    SERVER,
    'remote',
    actor,
    requested,
  );
  const authorizationUrl = new URL(started.authorizationUrl);
  const callback = new URL(
    authorizationUrl.searchParams.get('redirect_uri') ?? '',
  );
  callback.searchParams.set('code', 'fixture-code');
  callback.searchParams.set(
    'state',
    authorizationUrl.searchParams.get('state') ?? '',
  );
  await env.service.finishOAuth(SERVER, callback.href, actor);
  return authorizationUrl;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('pre-registered OAuth client on a server without DCR', () => {
  test('a confidential client authenticates with Basic at consent and on refresh, and never registers', async () => {
    const as = startAuthorizationServer({
      dcr: false,
      authMethods: ['client_secret_basic', 'client_secret_post'],
    });
    const env = setup();
    try {
      await createIntegration(env, {
        oauthClient: { clientId: CLIENT_ID, scopes: ['mail.readonly'] },
      });
      await bindClientSecret(env);

      const authorizationUrl = await consent(env);
      expect(authorizationUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
      // Declared read-only scopes replace the server's advertised set.
      expect(authorizationUrl.searchParams.get('scope')).toBe('mail.readonly');
      expect(as.registrations).toEqual([]);

      const basic = `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;
      expect(as.tokenRequests).toHaveLength(1);
      expect(as.tokenRequests[0]!.params.get('grant_type')).toBe(
        'authorization_code',
      );
      expect(as.tokenRequests[0]!.authorization).toBe(basic);
      expect(
        (await env.service.getIntegration(SERVER)).probe?.authorization,
      ).toEqual({ state: 'authorized' });

      // The issued token is already due, so this read refreshes, and the
      // refresh must authenticate as the same confidential client.
      const def = await env.loader.loadIntegration(SERVER);
      const provider = new StationToolServerOAuthProvider(
        toolServerCredentialStoreFor(env.home, INSTANCE_CREDENTIAL_OWNER),
        SERVER,
        `${ORIGIN}/mcp`,
        `http://127.0.0.1:${PORT}/integrations/${SERVER}/oauth/callback`,
        undefined,
        INSTANCE_CREDENTIAL_OWNER,
        toolServerOAuthClientConfig(def, env.bindings),
      );
      expect(await provider.accessToken()).toBe('access-2');
      expect(as.tokenRequests[1]!.params.get('grant_type')).toBe(
        'refresh_token',
      );
      expect(as.tokenRequests[1]!.authorization).toBe(basic);

      // (d) The secret reached only the token endpoint: not the integration
      // JSON, the credential store, any other file, or any log record.
      for (const file of filesUnder(env.home))
        expect(readFileSync(file, 'utf8'), file).not.toContain(CLIENT_SECRET);
      const logged = JSON.stringify([
        env.auditLogger.info.mock.calls,
        env.serviceLogger.warn.mock.calls,
        env.serviceLogger.debug.mock.calls,
        env.serviceLogger.info.mock.calls,
        env.serviceLogger.error.mock.calls,
      ]);
      expect(logged).not.toContain(CLIENT_SECRET);
      expect(def.oauthClient).toEqual({
        clientId: CLIENT_ID,
        scopes: ['mail.readonly'],
        clientSecretRef: 'byo-client-secret',
      });
    } finally {
      await as.close();
    }
  });

  test('client_secret_post sends the secret in the body when that is all the server allows', async () => {
    const as = startAuthorizationServer({
      dcr: false,
      authMethods: ['client_secret_post'],
    });
    const env = setup();
    try {
      await createIntegration(env, { oauthClient: { clientId: CLIENT_ID } });
      await bindClientSecret(env);
      await consent(env);
      const [exchange] = as.tokenRequests;
      expect(exchange!.authorization).toBeNull();
      expect(exchange!.params.get('client_id')).toBe(CLIENT_ID);
      expect(exchange!.params.get('client_secret')).toBe(CLIENT_SECRET);
    } finally {
      await as.close();
    }
  });

  test('a public pre-registered client sends only its client ID', async () => {
    const as = startAuthorizationServer({ dcr: false, authMethods: ['none'] });
    const env = setup();
    try {
      await createIntegration(env, { oauthClient: { clientId: CLIENT_ID } });
      await consent(env);
      const [exchange] = as.tokenRequests;
      expect(exchange!.params.get('client_id')).toBe(CLIENT_ID);
      expect(exchange!.params.has('client_secret')).toBe(false);
      expect(exchange!.authorization).toBeNull();
      expect(as.registrations).toEqual([]);
    } finally {
      await as.close();
    }
  });

  test('a secret binding that cannot be read refuses instead of signing in as a public client', async () => {
    const as = startAuthorizationServer({
      dcr: false,
      authMethods: ['client_secret_basic', 'none'],
    });
    const env = setup();
    try {
      await createIntegration(env, { oauthClient: { clientId: CLIENT_ID } });
      await bindClientSecret(env);
      const unreadable = new MCPService(
        env.loader,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        env.serviceLogger,
        undefined,
        PORT,
        new FileSecretBindingAdministration(env.home, { environment: {} }),
      );
      await expect(unreadable.startOAuth(SERVER, 'remote')).rejects.toThrow(
        'The OAuth client secret is unavailable',
      );
      expect(as.tokenRequests).toEqual([]);
    } finally {
      await as.close();
    }
  });

  test('raw integration JSON cannot point the client secret at a binding', async () => {
    startAuthorizationServer({ dcr: false });
    const env = setup();
    await createIntegration(env, { oauthClient: { clientId: CLIENT_ID } });
    await expect(
      env.service.saveIntegration({
        id: SERVER,
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: `${ORIGIN}/mcp`,
        oauthClient: { clientId: CLIENT_ID, clientSecretRef: 'other' },
      }),
    ).rejects.toThrow('only through the operator binding API');
  });
});

describe('scopes are the signing-in person’s choice', () => {
  test.each([
    {
      label: 'adds write access to the default',
      chosen: ['mail.readonly', 'mail.compose'],
    },
    {
      label: 'removes the default for another scope',
      chosen: ['mail.compose'],
    },
  ])('$label: exactly the chosen scopes are requested', async ({ chosen }) => {
    const as = startAuthorizationServer({ dcr: false, authMethods: ['none'] });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
        oauthClient: { clientId: CLIENT_ID, scopes: ['mail.readonly'] },
      });
      const authorizationUrl = await consent(
        env,
        { principalId: ALICE },
        { scopes: chosen },
      );
      expect(authorizationUrl.searchParams.get('scope')).toBe(chosen.join(' '));
      // A person's choice is not written back as everyone's default.
      expect(
        (await env.loader.loadIntegration(SERVER)).oauthClient?.scopes,
      ).toEqual(['mail.readonly']);
    } finally {
      await as.close();
    }
  });

  test('without a choice the integration default applies; without a default, the server’s', async () => {
    const as = startAuthorizationServer({ dcr: false, authMethods: ['none'] });
    const env = setup();
    try {
      await createIntegration(env, { oauthClient: { clientId: CLIENT_ID } });
      const authorizationUrl = await consent(env);
      // The SDK requests what the resource advertises.
      expect(authorizationUrl.searchParams.get('scope')).toBe(
        'mail.readonly mail.compose',
      );
    } finally {
      await as.close();
    }
  });

  test.each([[[]], [['a', 'a']], [['bad scope']], [['quote"']]])(
    'a malformed choice %j is refused before the server is contacted',
    async (scopes) => {
      const as = startAuthorizationServer({ dcr: true });
      const env = setup();
      try {
        await createIntegration(env);
        await expect(
          env.service.startOAuth(SERVER, 'remote', undefined, { scopes }),
        ).rejects.toThrow('Scopes must be 1 to 32 distinct OAuth scope values');
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      } finally {
        await as.close();
      }
    },
  );
});

describe('a configured client secret stays with its first authorization server', () => {
  test('a different issuer is refused before the secret is read (GHSA-6qxp-vccf-f47h)', async () => {
    const env = setup();
    const secret = vi.fn(async () => CLIENT_SECRET);
    const provider = new StationToolServerOAuthProvider(
      toolServerCredentialStoreFor(env.home, INSTANCE_CREDENTIAL_OWNER),
      SERVER,
      `${ORIGIN}/mcp`,
      `http://127.0.0.1:${PORT}/integrations/${SERVER}/oauth/callback`,
      undefined,
      INSTANCE_CREDENTIAL_OWNER,
      { clientId: CLIENT_ID, clientSecret: secret },
    );
    expect(await provider.clientInformation({ issuer: ORIGIN })).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      issuer: ORIGIN,
    });
    expect(await provider.clientInformation({ issuer: ORIGIN })).toMatchObject({
      client_secret: CLIENT_SECRET,
    });
    expect(secret).toHaveBeenCalledTimes(2);

    await expect(
      provider.clientInformation({ issuer: 'https://other-as.example' }),
    ).rejects.toBeInstanceOf(OAuthClientIssuerMismatchError);
    expect(secret).toHaveBeenCalledTimes(2);
    // No issuer context, no server to present a secret to.
    expect(await provider.clientInformation()).toEqual({
      client_id: CLIENT_ID,
    });
    expect(secret).toHaveBeenCalledTimes(2);

    // Resetting the credentials (disable, endpoint or client change) re-pins.
    await provider.clearCredentials();
    expect(
      await provider.clientInformation({ issuer: 'https://other-as.example' }),
    ).toMatchObject({ issuer: 'https://other-as.example' });
  });
});

describe('no client and no registration', () => {
  test('consent stops with an actionable client-id-required state, not a registration attempt', async () => {
    const as = startAuthorizationServer({ dcr: false });
    const env = setup();
    try {
      await createIntegration(env);
      const failure = await env.service.startOAuth(SERVER, 'remote').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(OAuthClientRequiredError);
      expect((failure as Error).message).toContain('needs an OAuth client ID');
      expect(as.registrations).toEqual([]);
      expect(as.tokenRequests).toEqual([]);
      expect(
        (await env.service.getIntegration(SERVER)).probe?.authorization,
      ).toEqual({
        state: 'client-id-required',
        reason: OAUTH_CLIENT_ID_REQUIRED_REASON,
      });
    } finally {
      await as.close();
    }
  });

  test('a metadata document the server does not accept still needs a client ID', async () => {
    const as = startAuthorizationServer({ dcr: false, cimd: false });
    const env = setup();
    try {
      await createIntegration(env, {
        oauthClient: { clientMetadataUrl: CIMD_URL },
      });
      await expect(env.service.startOAuth(SERVER, 'remote')).rejects.toThrow(
        OAuthClientRequiredError,
      );
    } finally {
      await as.close();
    }
  });
});

describe('Client ID Metadata Document', () => {
  test('is the client ID when the server advertises support', async () => {
    const as = startAuthorizationServer({ dcr: true, cimd: true });
    const env = setup();
    try {
      await createIntegration(env, {
        oauthClient: { clientMetadataUrl: CIMD_URL },
      });
      const authorizationUrl = await consent(env);
      expect(authorizationUrl.searchParams.get('client_id')).toBe(CIMD_URL);
      expect(as.registrations).toEqual([]);
      expect(as.tokenRequests[0]!.params.get('client_id')).toBe(CIMD_URL);
    } finally {
      await as.close();
    }
  });

  test('is not used when the server does not advertise support; DCR is', async () => {
    const as = startAuthorizationServer({ dcr: true, cimd: false });
    const env = setup();
    try {
      await createIntegration(env, {
        oauthClient: { clientMetadataUrl: CIMD_URL },
      });
      const authorizationUrl = await consent(env);
      expect(authorizationUrl.searchParams.get('client_id')).toBe(
        'dcr-registered-client',
      );
      expect(as.registrations).toHaveLength(1);
    } finally {
      await as.close();
    }
  });

  test('a pre-registered client ID wins over an advertised metadata document', async () => {
    const as = startAuthorizationServer({ dcr: true, cimd: true });
    const env = setup();
    try {
      await createIntegration(env, {
        oauthClient: { clientId: CLIENT_ID, clientMetadataUrl: CIMD_URL },
      });
      const authorizationUrl = await consent(env);
      expect(authorizationUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(as.registrations).toEqual([]);
    } finally {
      await as.close();
    }
  });
});

describe('person-owned integration with a pre-registered client', () => {
  test("a person's tokens stay theirs; another person and the shared account get nothing", async () => {
    const as = startAuthorizationServer({
      dcr: false,
      authMethods: ['client_secret_basic'],
    });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
        oauthClient: { clientId: CLIENT_ID },
      });
      await bindClientSecret(env);
      await consent(env, { principalId: ALICE });
      expect(as.tokenRequests[0]!.authorization).toBe(
        `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      );

      expect(
        (await env.service.getAccountStatus(SERVER, { principalId: ALICE }))
          .connectedAs,
      ).toBe('you');
      expect(
        (await env.service.getAccountStatus(SERVER, { principalId: BOB }))
          .connectedAs,
      ).toBeNull();

      const def = await env.loader.loadIntegration(SERVER);
      const client = toolServerOAuthClientConfig(def, env.bindings);
      const providerFor = (
        owner: ReturnType<typeof principalCredentialOwner>,
      ) =>
        new StationToolServerOAuthProvider(
          toolServerCredentialStoreFor(env.home, owner),
          SERVER,
          `${ORIGIN}/mcp`,
          `http://127.0.0.1:${PORT}/integrations/${SERVER}/oauth/callback`,
          undefined,
          owner,
          client,
        );
      // Bob's candidates never include the shared credential, and none of
      // the owners he can reach holds a token.
      const bobOwners = toolServerCredentialCandidates(def, BOB);
      expect(bobOwners).not.toContainEqual(INSTANCE_CREDENTIAL_OWNER);
      for (const owner of bobOwners)
        expect(await providerFor(owner).tokens()).toBeUndefined();
      expect(
        await providerFor(INSTANCE_CREDENTIAL_OWNER).tokens(),
      ).toBeUndefined();
      // Recording Alice's catalog may already have refreshed her due token.
      expect(
        (await providerFor(principalCredentialOwner(ALICE)).tokens())
          ?.access_token,
      ).toMatch(/^access-\d+$/);
    } finally {
      await as.close();
    }
  });
});
