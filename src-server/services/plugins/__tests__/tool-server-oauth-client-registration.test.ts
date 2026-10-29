import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import {
  INTEGRATION_INSTANCE_FILE,
  INTEGRATION_OAUTH_ISSUER_FILE,
} from '../../../domain/config-loader-storage.js';
import { OAUTH_CLIENT_ID_REQUIRED_REASON } from '../../../security/tool-server-reason.js';
import {
  FileSecretBindingAdministration,
  SecretBindingIntegrationService,
} from '../../secrets/secret-binding-administration.js';
import { MCPService } from '../mcp-service.js';
import {
  deploymentClientMetadataUrl,
  INSTANCE_CREDENTIAL_OWNER,
  OAUTH_CLIENT_METADATA_URL_ENV,
  OAuthClientIssuerMismatchError,
  OAuthClientIssuerRequiredError,
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
const CAROL = humanPrincipal('tailscale-serve', 'carol', 'carol').id;
const DAN = humanPrincipal('tailscale-serve', 'dan', 'dan').id;

type ServerOptions = {
  dcr: boolean;
  cimd?: boolean;
  authMethods?: string[];
  /** RFC 9207 `authorization_response_iss_parameter_supported`. */
  issAdvertised?: boolean;
  /**
   * Mix-up staging: the attacker's metadata sends people to the honest
   * authorization endpoint but keeps its own token endpoint.
   */
  mixUp?: boolean;
  /** The scope the registration endpoint grants, when fewer than asked. */
  registeredScope?: string;
};

type TokenRequest = {
  origin: string;
  params: URLSearchParams;
  authorization: string | null;
};

const ATTACKER = 'https://attacker-as.example';

function startAuthorizationServer(options: ServerOptions) {
  const registrations: Array<Record<string, unknown>> = [];
  const tokenRequests: TokenRequest[] = [];
  const contacted = new Set<string>();
  let authorizationServer = ORIGIN;
  let issued = 0;
  let hold: Promise<void> | undefined;
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
      contacted.add(url.origin);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
        return Response.json({
          resource: `${ORIGIN}/mcp`,
          authorization_servers: [authorizationServer],
          scopes_supported: ['mail.readonly', 'mail.compose'],
        });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        // Each host answers as its own issuer, so resource metadata decides
        // which authorization server Station is sent to.
        return Response.json({
          issuer: url.origin,
          authorization_endpoint:
            options.mixUp && url.origin === ATTACKER
              ? `${ORIGIN}/authorize`
              : `${url.origin}/authorize`,
          ...(options.issAdvertised
            ? { authorization_response_iss_parameter_supported: true }
            : {}),
          token_endpoint: `${url.origin}/token`,
          ...(options.dcr
            ? { registration_endpoint: `${url.origin}/register` }
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
        registrations.push({ ...body, origin: url.origin });
        return Response.json({
          ...body,
          ...(options.registeredScope !== undefined
            ? { scope: options.registeredScope }
            : {}),
          client_id:
            registrations.length === 1
              ? 'dcr-registered-client'
              : `dcr-registered-client-${registrations.length}`,
        });
      }
      if (url.pathname === '/token') {
        const held = hold;
        hold = undefined;
        if (held) await held;
        tokenRequests.push({
          origin: url.origin,
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
  return {
    registrations,
    tokenRequests,
    contacted,
    /** Pause the next token request until the returned release is called. */
    holdNextTokenRequest: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    /** RFC 9728 metadata names a different authorization server from now on. */
    nameAuthorizationServer: (origin: string) => {
      authorizationServer = origin;
    },
    close: () => mcpHandler.close(),
  };
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

async function bindClientSecret(
  env: ReturnType<typeof setup>,
  existingRevision?: number,
) {
  const revision =
    existingRevision ??
    (
      await env.bindings.create({
        id: 'byo-client-secret',
        name: 'BYO client secret',
        authRef: { env: SECRET_ENV },
      })
    ).revision;
  const outcome = await env.consumers.bindOAuthClientSecret({
    id: 'byo-client-secret',
    integrationId: SERVER,
    expectedRevision: revision,
  });
  expect(outcome.outcome).toBe('complete');
}

async function consent(
  env: ReturnType<typeof setup>,
  actor?: { principalId: string },
  requested?: { scopes?: string[] },
  callbackIss?: string,
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
  if (callbackIss) callback.searchParams.set('iss', callbackIss);
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
        oauthClient: {
          clientId: CLIENT_ID,
          issuer: ORIGIN,
          scopes: ['mail.readonly'],
        },
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
        issuer: ORIGIN,
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
      await createIntegration(env, {
        oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
      });
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
      await createIntegration(env, {
        oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
      });
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
      await createIntegration(env, {
        oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
      });
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
    await createIntegration(env, {
      oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
    });
    await expect(
      env.service.saveIntegration({
        id: SERVER,
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: `${ORIGIN}/mcp`,
        oauthClient: {
          clientId: CLIENT_ID,
          issuer: ORIGIN,
          clientSecretRef: 'other',
        },
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
        oauthClient: {
          clientId: CLIENT_ID,
          issuer: ORIGIN,
          scopes: ['mail.readonly'],
        },
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
      await createIntegration(env, {
        oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
      });
      const authorizationUrl = await consent(env);
      // The SDK requests what the resource advertises.
      expect(authorizationUrl.searchParams.get('scope')).toBe(
        'mail.readonly mail.compose',
      );
    } finally {
      await as.close();
    }
  });

  test('an empty choice requests the server’s scopes instead of the integration default', async () => {
    const as = startAuthorizationServer({ dcr: false, authMethods: ['none'] });
    const env = setup();
    try {
      await createIntegration(env, {
        oauthClient: {
          clientId: CLIENT_ID,
          issuer: ORIGIN,
          scopes: ['mail.readonly'],
        },
      });
      const authorizationUrl = await consent(env, undefined, { scopes: [] });
      expect(authorizationUrl.searchParams.get('scope')).toBe(
        'mail.readonly mail.compose',
      );
    } finally {
      await as.close();
    }
  });

  test.each([
    { label: 'the person’s choice', extra: {}, requested: ['mail.readonly'] },
    {
      label: 'the integration default',
      extra: { oauthClient: { scopes: ['mail.readonly'] } },
      requested: undefined,
    },
  ])(
    'a dynamically registered client is registered for $label, not the advertised scopes',
    async ({ extra, requested }) => {
      const as = startAuthorizationServer({ dcr: true });
      const env = setup();
      try {
        await createIntegration(env, extra);
        const authorizationUrl = await consent(
          env,
          undefined,
          requested ? { scopes: requested } : undefined,
        );
        expect(as.registrations).toHaveLength(1);
        expect(as.registrations[0]!.scope).toBe('mail.readonly');
        expect(authorizationUrl.searchParams.get('client_id')).toBe(
          'dcr-registered-client',
        );
        expect(authorizationUrl.searchParams.get('scope')).toBe(
          'mail.readonly',
        );
      } finally {
        await as.close();
      }
    },
  );

  test.each([
    [['a', 'a']],
    [['bad scope']],
    [['quote"']],
    [Array.from({ length: 33 }, (_, index) => `s${index}`)],
  ])(
    'a malformed choice %j is refused before the server is contacted',
    async (scopes) => {
      const as = startAuthorizationServer({ dcr: true });
      const env = setup();
      try {
        await createIntegration(env);
        await expect(
          env.service.startOAuth(SERVER, 'remote', undefined, { scopes }),
        ).rejects.toThrow(
          'Scopes must be at most 32 distinct OAuth scope values',
        );
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      } finally {
        await as.close();
      }
    },
  );
});

describe('the client secret is used only with its declared authorization server (GHSA-6qxp-vccf-f47h)', () => {
  test('after Alice signs in, metadata naming another issuer cannot collect the shared secret through Bob, even after Alice disconnects', async () => {
    const as = startAuthorizationServer({
      dcr: false,
      authMethods: ['client_secret_basic'],
    });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
        oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
      });
      await bindClientSecret(env);
      await consent(env, { principalId: ALICE });
      // Consent, then the catalog read refreshing her already-due token.
      expect(as.tokenRequests.length).toBeGreaterThan(0);
      expect(
        new Set(as.tokenRequests.map((request) => request.origin)),
      ).toEqual(new Set([ORIGIN]));

      const reads = vi.spyOn(env.bindings, 'resolveOAuthClientSecret');
      as.nameAuthorizationServer(ATTACKER);
      // Bob's bucket has no saved discovery, so he follows the new metadata.
      await expect(
        env.service.startOAuth(SERVER, 'remote', { principalId: BOB }),
      ).rejects.toBeInstanceOf(OAuthClientIssuerMismatchError);
      // Concurrent first sign-ins have nothing to race: the issuer is config.
      const concurrent = await Promise.allSettled([
        env.service.startOAuth(SERVER, 'remote', { principalId: CAROL }),
        env.service.startOAuth(SERVER, 'remote', { principalId: DAN }),
      ]);
      for (const outcome of concurrent) {
        expect(outcome.status).toBe('rejected');
        expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
          OAuthClientIssuerMismatchError,
        );
      }
      // A disconnect clears Alice's saved discovery; the declared issuer stays.
      await env.service.disconnectAccount(SERVER, { principalId: ALICE });
      await expect(
        env.service.startOAuth(SERVER, 'remote', { principalId: ALICE }),
      ).rejects.toBeInstanceOf(OAuthClientIssuerMismatchError);

      expect(as.contacted.has(ATTACKER)).toBe(true);
      expect(reads).not.toHaveBeenCalled();
      expect(
        as.tokenRequests.filter((request) => request.origin === ATTACKER),
      ).toEqual([]);
      // Nothing about the issuer was written by a sign-in attempt.
      expect(
        (await env.loader.loadIntegration(SERVER)).oauthClient?.issuer,
      ).toBe(ORIGIN);
    } finally {
      await as.close();
    }
  });

  test('a bound secret without a declared issuer is refused before it is read', async () => {
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
    await expect(
      provider.clientInformation({ issuer: ORIGIN }),
    ).rejects.toBeInstanceOf(OAuthClientIssuerRequiredError);
    // Without an issuer context there is no server to present a secret to.
    expect(await provider.clientInformation()).toEqual({
      client_id: CLIENT_ID,
    });
    expect(secret).not.toHaveBeenCalled();
  });

  test('a public pre-registered client is refused without a declared issuer and with a different one', async () => {
    const env = setup();
    const providerWith = (issuer?: string) =>
      new StationToolServerOAuthProvider(
        toolServerCredentialStoreFor(env.home, INSTANCE_CREDENTIAL_OWNER),
        SERVER,
        `${ORIGIN}/mcp`,
        `http://127.0.0.1:${PORT}/integrations/${SERVER}/oauth/callback`,
        undefined,
        INSTANCE_CREDENTIAL_OWNER,
        { clientId: CLIENT_ID, ...(issuer ? { issuer } : {}) },
      );
    await expect(
      providerWith().clientInformation({ issuer: ORIGIN }),
    ).rejects.toBeInstanceOf(OAuthClientIssuerRequiredError);
    await expect(
      providerWith(ORIGIN).clientInformation({ issuer: ATTACKER }),
    ).rejects.toBeInstanceOf(OAuthClientIssuerMismatchError);
    expect(
      await providerWith(ORIGIN).clientInformation({ issuer: ORIGIN }),
    ).toEqual({ client_id: CLIENT_ID, issuer: ORIGIN });
  });

  test('binding a secret needs a declared issuer, and the issuer moves only after unbinding', async () => {
    startAuthorizationServer({ dcr: false });
    const env = setup();
    await createIntegration(env);
    const created = await env.bindings.create({
      id: 'byo-client-secret',
      name: 'BYO client secret',
      authRef: { env: SECRET_ENV },
    });
    await expect(
      env.consumers.bindOAuthClientSecret({
        id: created.id,
        integrationId: SERVER,
        expectedRevision: created.revision,
      }),
    ).rejects.toThrow("Declare the client's authorization server");
    await createIntegration(env, {
      oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
    });
    await bindClientSecret(env, created.revision);
    await expect(
      createIntegration(env, {
        oauthClient: { clientId: CLIENT_ID, issuer: ATTACKER },
      }),
    ).rejects.toThrow('Unbind the OAuth client secret before changing');
    await expect(
      createIntegration(env, { oauthClient: { clientId: CLIENT_ID } }),
    ).rejects.toThrow("needs its authorization server's issuer");
  });
});

describe('authorization-server mix-up (round 2)', () => {
  test('a public pre-registered client cannot be mixed up: Bob is refused before any redirect', async () => {
    const as = startAuthorizationServer({
      dcr: false,
      authMethods: ['none'],
      mixUp: true,
    });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
        oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
      });
      await consent(env, { principalId: ALICE });
      as.nameAuthorizationServer(ATTACKER);
      await expect(
        env.service.startOAuth(SERVER, 'remote', { principalId: BOB }),
      ).rejects.toBeInstanceOf(OAuthClientIssuerMismatchError);
      expect(
        as.tokenRequests.filter((request) => request.origin === ATTACKER),
      ).toEqual([]);
    } finally {
      await as.close();
    }
  });

  test('RFC 9207: a callback iss from another server is refused before the code reaches any token endpoint', async () => {
    const as = startAuthorizationServer({ dcr: true, mixUp: true });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
      });
      as.nameAuthorizationServer(ATTACKER);
      // A registration with no declared issuer follows the metadata; the
      // honest server's iss in the callback is what exposes the mix-up.
      await expect(
        consent(env, { principalId: BOB }, undefined, ORIGIN),
      ).rejects.toThrow('OAuth authorization failed');
      expect(as.tokenRequests).toEqual([]);
    } finally {
      await as.close();
    }
  });

  test.each([
    { label: 'missing', iss: undefined, ok: false },
    { label: 'from another server', iss: ATTACKER, ok: false },
    { label: 'matching', iss: ORIGIN, ok: true },
  ])(
    'RFC 9207: when the server advertises iss, a $label iss is handled',
    async ({ iss, ok }) => {
      const as = startAuthorizationServer({ dcr: true, issAdvertised: true });
      const env = setup();
      try {
        await createIntegration(env);
        const signIn = consent(env, undefined, undefined, iss);
        if (ok) {
          await signIn;
          expect(as.tokenRequests).toHaveLength(1);
        } else {
          await expect(signIn).rejects.toThrow('OAuth authorization failed');
          expect(as.tokenRequests).toEqual([]);
        }
      } finally {
        await as.close();
      }
    },
  );

  test('a declared issuer also pins dynamic registration: nothing is registered at another server', async () => {
    const as = startAuthorizationServer({ dcr: true, mixUp: true });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
        oauthClient: { issuer: ORIGIN },
      });
      as.nameAuthorizationServer(ATTACKER);
      await expect(
        env.service.startOAuth(SERVER, 'remote', { principalId: BOB }),
      ).rejects.toBeInstanceOf(OAuthClientIssuerMismatchError);
      expect(as.registrations).toEqual([]);
    } finally {
      await as.close();
    }
  });

  test('a callback carrying two iss values is refused', async () => {
    const as = startAuthorizationServer({ dcr: true });
    const env = setup();
    try {
      await createIntegration(env);
      const started = await env.service.startOAuth(SERVER, 'remote');
      const url = new URL(started.authorizationUrl);
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
      callback.searchParams.set('code', 'fixture-code');
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      callback.searchParams.append('iss', ORIGIN);
      callback.searchParams.append('iss', ATTACKER);
      await expect(
        env.service.finishOAuth(SERVER, callback.href),
      ).rejects.toThrow('at most one iss');
      expect(as.tokenRequests).toEqual([]);
    } finally {
      await as.close();
    }
  });
});

describe('a registered client is registered again when scopes outgrow it (round 2)', () => {
  test('choosing scopes the registration does not cover registers again; a covered choice does not', async () => {
    const as = startAuthorizationServer({ dcr: true });
    const env = setup();
    try {
      await createIntegration(env, {
        oauthClient: { scopes: ['mail.readonly'] },
      });
      await consent(env);
      expect(as.registrations.map((r) => r.scope)).toEqual(['mail.readonly']);

      const widened = await consent(env, undefined, {
        scopes: ['mail.readonly', 'mail.compose'],
      });
      expect(as.registrations.map((r) => r.scope)).toEqual([
        'mail.readonly',
        'mail.readonly mail.compose',
      ]);
      expect(widened.searchParams.get('client_id')).toBe(
        'dcr-registered-client-2',
      );

      const narrowed = await consent(env, undefined, {
        scopes: ['mail.compose'],
      });
      expect(as.registrations).toHaveLength(2);
      expect(narrowed.searchParams.get('client_id')).toBe(
        'dcr-registered-client-2',
      );
    } finally {
      await as.close();
    }
  });
});

describe('one client per consent, swapped only when it completes (round 3)', () => {
  const instanceProvider = async (env: ReturnType<typeof setup>) =>
    new StationToolServerOAuthProvider(
      toolServerCredentialStoreFor(env.home, INSTANCE_CREDENTIAL_OWNER),
      SERVER,
      `${ORIGIN}/mcp`,
      `http://127.0.0.1:${PORT}/integrations/${SERVER}/oauth/callback`,
      undefined,
      INSTANCE_CREDENTIAL_OWNER,
      toolServerOAuthClientConfig(
        await env.loader.loadIntegration(SERVER),
        env.bindings,
      ),
    );

  test('a server granting fewer scopes than asked: the exchange uses the authorizing client, and asking again does not register again', async () => {
    const as = startAuthorizationServer({
      dcr: true,
      registeredScope: 'mail.readonly',
    });
    const env = setup();
    try {
      await createIntegration(env, {
        oauthClient: { scopes: ['mail.readonly'] },
      });
      await consent(env);
      const authorized = await consent(env, undefined, {
        scopes: ['mail.readonly', 'mail.compose'],
      });
      // One re-registration for the wider request, decided before the
      // redirect; the code exchange presents that same client.
      expect(as.registrations).toHaveLength(2);
      expect(as.tokenRequests.at(-1)!.params.get('client_id')).toBe(
        authorized.searchParams.get('client_id'),
      );
      // The server's reduced grant is accepted: the same request again
      // reuses the client instead of registering in a loop.
      await consent(env, undefined, {
        scopes: ['mail.readonly', 'mail.compose'],
      });
      expect(as.registrations).toHaveLength(2);
    } finally {
      await as.close();
    }
  });

  test('an abandoned re-registration keeps the old client and its tokens; a completed one swaps both together', async () => {
    const as = startAuthorizationServer({ dcr: true });
    const env = setup();
    try {
      await createIntegration(env, {
        oauthClient: { scopes: ['mail.readonly'] },
      });
      await consent(env);
      expect(as.tokenRequests[0]!.params.get('client_id')).toBe(
        'dcr-registered-client',
      );

      // Start a wider consent and abandon it before the callback.
      await env.service.startOAuth(SERVER, 'remote', undefined, {
        scopes: ['mail.readonly', 'mail.compose'],
      });
      expect(as.registrations).toHaveLength(2);
      const beforeRefresh = as.tokenRequests.length;
      expect(await (await instanceProvider(env)).accessToken()).toMatch(
        /^access-/,
      );
      const refresh = as.tokenRequests[beforeRefresh]!;
      expect(refresh.params.get('grant_type')).toBe('refresh_token');
      expect(refresh.params.get('refresh_token')).toBe('refresh-1');
      expect(refresh.params.get('client_id')).toBe('dcr-registered-client');

      // A completed re-registration publishes the new client with its tokens.
      await consent(env, undefined, {
        scopes: ['mail.readonly', 'mail.compose'],
      });
      const exchange = as.tokenRequests.at(-1)!;
      expect(exchange.params.get('grant_type')).toBe('authorization_code');
      const swapped = exchange.params.get('client_id');
      expect(swapped).toMatch(/^dcr-registered-client-\d+$/);
      const afterSwap = as.tokenRequests.length;
      await (await instanceProvider(env)).accessToken();
      expect(as.tokenRequests[afterSwap]!.params.get('client_id')).toBe(
        swapped,
      );
      // No refresh token was ever presented with a client it was not issued to.
      for (const request of as.tokenRequests.filter(
        (r) => r.params.get('grant_type') === 'refresh_token',
      ))
        expect(request.params.get('client_id')).toBe(
          request.params.get('refresh_token') === 'refresh-1' ||
            request.params.get('refresh_token') === 'refresh-2'
            ? 'dcr-registered-client'
            : swapped,
        );
    } finally {
      await as.close();
    }
  });
});

describe('a client secret survives no rewrite of its integration (round 3)', () => {
  test('deleting a bound integration and recreating the id with another issuer cannot materialize the secret', async () => {
    const as = startAuthorizationServer({
      dcr: false,
      authMethods: ['client_secret_basic'],
    });
    const env = setup();
    try {
      await createIntegration(env, {
        oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
      });
      await bindClientSecret(env);
      await consent(env);
      await env.service.deleteIntegration(SERVER);
      // Any writer that bypasses the integration guard: a raw file with the
      // old binding reference, now naming the attacker as its issuer.
      mkdirSync(join(env.home, 'integrations', SERVER), { recursive: true });
      writeFileSync(
        join(env.home, 'integrations', SERVER, 'integration.json'),
        JSON.stringify({
          id: SERVER,
          kind: 'mcp',
          transport: 'streamable-http',
          endpoint: `${ORIGIN}/mcp`,
          oauthClient: {
            clientId: CLIENT_ID,
            issuer: ATTACKER,
            clientSecretRef: 'byo-client-secret',
          },
        }),
      );
      as.nameAuthorizationServer(ATTACKER);
      const reads = vi.spyOn(env.bindings, 'resolveOAuthClientSecret');
      await expect(env.service.startOAuth(SERVER, 'remote')).rejects.toThrow(
        'The OAuth client secret is unavailable',
      );
      // The binding authority was asked for the attacker's issuer and said no.
      expect(reads).toHaveBeenCalledWith(
        expect.objectContaining({ issuer: ATTACKER }),
      );
      await expect(reads.mock.results[0]!.value).rejects.toMatchObject({
        reason: 'grant_missing',
      });
      expect(
        as.tokenRequests.filter((request) => request.origin === ATTACKER),
      ).toEqual([]);
    } finally {
      await as.close();
    }
  });
});

describe('round 4: the secret is authorized at each token request', () => {
  async function startedConsent(env: ReturnType<typeof setup>) {
    const started = await env.service.startOAuth(SERVER, 'remote');
    const url = new URL(started.authorizationUrl);
    const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('state', url.searchParams.get('state') ?? '');
    return callback.href;
  }
  const materialized = (env: ReturnType<typeof setup>) =>
    env.auditLogger.info.mock.calls.filter(
      ([, attributes]) =>
        (attributes as { operation?: string }).operation === 'materialize',
    ).length;

  test.each([
    {
      label: 'revoked',
      change: async (env: ReturnType<typeof setup>) => {
        const binding = await env.bindings.get('byo-client-secret');
        await env.bindings.revoke({
          id: 'byo-client-secret',
          expectedRevision: binding!.revision,
        });
      },
    },
    {
      label: 'unbound',
      change: async (env: ReturnType<typeof setup>) => {
        const binding = await env.bindings.get('byo-client-secret');
        await env.consumers.unbindOAuthClientSecret({
          id: 'byo-client-secret',
          integrationId: SERVER,
          expectedRevision: binding!.revision,
        });
      },
    },
  ])(
    'a secret $label mid-consent is not spent at the code exchange',
    async ({ change }) => {
      const as = startAuthorizationServer({
        dcr: false,
        authMethods: ['client_secret_basic'],
      });
      const env = setup();
      try {
        await createIntegration(env, {
          oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
        });
        await bindClientSecret(env);
        const callback = await startedConsent(env);
        await change(env);
        const before = materialized(env);
        await expect(env.service.finishOAuth(SERVER, callback)).rejects.toThrow(
          'OAuth authorization failed',
        );
        expect(as.tokenRequests).toEqual([]);
        expect(materialized(env)).toBe(before);
      } finally {
        await as.close();
      }
    },
  );
});

describe('round 4: overlapping consents never pair tokens with another client', () => {
  test('A registers C2 and pauses at the exchange; B (on C1) finishes after A and is refused', async () => {
    const as = startAuthorizationServer({ dcr: true });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
        oauthClient: { scopes: ['mail.readonly'] },
      });
      const alice = { principalId: ALICE };
      await consent(env, alice);
      const registered = (n: number) =>
        n === 1 ? 'dcr-registered-client' : `dcr-registered-client-${n}`;

      // A: wider scopes, so it registers C2 for this flow only.
      const startA = await env.service.startOAuth(SERVER, 'remote', alice, {
        scopes: ['mail.readonly', 'mail.compose'],
      });
      const urlA = new URL(startA.authorizationUrl);
      expect(urlA.searchParams.get('client_id')).toBe(registered(2));
      const callbackA = new URL(urlA.searchParams.get('redirect_uri') ?? '');
      callbackA.searchParams.set('code', 'code-a');
      callbackA.searchParams.set('state', urlA.searchParams.get('state') ?? '');
      const releaseA = as.holdNextTokenRequest();
      const finishA = env.service.finishOAuth(SERVER, callbackA.href, alice);
      // A cannot publish until released, so B below starts from C1.

      // B: the original scopes, so it keeps C1.
      const startB = await env.service.startOAuth(SERVER, 'remote', alice);
      const urlB = new URL(startB.authorizationUrl);
      expect(urlB.searchParams.get('client_id')).toBe(registered(1));
      const callbackB = new URL(urlB.searchParams.get('redirect_uri') ?? '');
      callbackB.searchParams.set('code', 'code-b');
      callbackB.searchParams.set('state', urlB.searchParams.get('state') ?? '');

      releaseA();
      await finishA;
      await expect(
        env.service.finishOAuth(SERVER, callbackB.href, alice),
      ).rejects.toThrow('OAuth authorization failed');

      // Stored: C2 with the tokens C2 obtained, paired by client id.
      const def = await env.loader.loadIntegration(SERVER);
      const provider = new StationToolServerOAuthProvider(
        toolServerCredentialStoreFor(env.home, principalCredentialOwner(ALICE)),
        SERVER,
        `${ORIGIN}/mcp`,
        `http://127.0.0.1:${PORT}/integrations/${SERVER}/oauth/callback`,
        undefined,
        principalCredentialOwner(ALICE),
        toolServerOAuthClientConfig(def, env.bindings),
      );
      expect((await provider.clientInformation())?.client_id).toBe(
        registered(2),
      );
      const exchangeA = as.tokenRequests.find(
        (request) => request.params.get('code') === 'code-a',
      )!;
      expect(exchangeA.params.get('client_id')).toBe(registered(2));
      const refreshBefore = as.tokenRequests.length;
      await provider.accessToken();
      expect(as.tokenRequests[refreshBefore]!.params.get('client_id')).toBe(
        registered(2),
      );
    } finally {
      await as.close();
    }
  });
});

describe('round 4: a recreated integration is a new instance', () => {
  test('delete, then recreate the exact id, issuer and MCP URL: the old grant does not authorize it', async () => {
    const as = startAuthorizationServer({
      dcr: false,
      authMethods: ['client_secret_basic'],
    });
    const env = setup();
    try {
      const definition = {
        oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
      };
      await createIntegration(env, definition);
      await bindClientSecret(env);
      await consent(env);
      const instanceFile = join(
        env.home,
        'integrations',
        SERVER,
        INTEGRATION_INSTANCE_FILE,
      );
      const firstInstance = readFileSync(instanceFile, 'utf8');
      await env.service.deleteIntegration(SERVER);

      // Recreated by the server writer with the same tuple and different
      // scopes, then given the old reference by a path that bypasses it.
      await createIntegration(env, {
        oauthClient: { ...definition.oauthClient, scopes: ['mail.compose'] },
      });
      expect(readFileSync(instanceFile, 'utf8')).not.toBe(firstInstance);
      const path = join(env.home, 'integrations', SERVER, 'integration.json');
      const recreated = JSON.parse(readFileSync(path, 'utf8'));
      recreated.oauthClient.clientSecretRef = 'byo-client-secret';
      writeFileSync(path, JSON.stringify(recreated));

      const before = as.tokenRequests.length;
      await expect(env.service.startOAuth(SERVER, 'remote')).rejects.toThrow(
        'The OAuth client secret is unavailable',
      );
      expect(as.tokenRequests.length).toBe(before);
    } finally {
      await as.close();
    }
  });
});

describe('dynamic registration without a declared issuer pins its server', () => {
  const pinFile = (env: ReturnType<typeof setup>) =>
    join(env.home, 'integrations', SERVER, INTEGRATION_OAUTH_ISSUER_FILE);

  test("after Alice's consent pins the server, metadata naming another one cannot redirect Bob, even after Alice disconnects", async () => {
    const as = startAuthorizationServer({ dcr: true, mixUp: true });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
      });
      await consent(env, { principalId: ALICE });
      expect(JSON.parse(readFileSync(pinFile(env), 'utf8'))).toMatchObject({
        resource: `${ORIGIN}/mcp`,
        issuer: ORIGIN,
      });

      as.nameAuthorizationServer(ATTACKER);
      for (const principalId of [BOB, ALICE]) {
        if (principalId === ALICE)
          await env.service.disconnectAccount(SERVER, { principalId });
        await expect(
          env.service.startOAuth(SERVER, 'remote', { principalId }),
        ).rejects.toBeInstanceOf(OAuthClientIssuerMismatchError);
      }
      expect(as.registrations.filter((r) => r.origin === ATTACKER)).toEqual([]);
      expect(as.tokenRequests.filter((r) => r.origin === ATTACKER)).toEqual([]);
    } finally {
      await as.close();
    }
  });

  test('a consent already open when another person pins the honest server is refused before its code or verifier is sent', async () => {
    const as = startAuthorizationServer({ dcr: true, mixUp: true });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
      });
      // Bob starts while the resource names the attacker, which sends him to
      // the honest authorization page but keeps its own token endpoint.
      as.nameAuthorizationServer(ATTACKER);
      const bob = { principalId: BOB };
      const started = await env.service.startOAuth(SERVER, 'remote', bob);
      const url = new URL(started.authorizationUrl);
      expect(url.origin).toBe(ORIGIN);
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
      callback.searchParams.set('code', 'honest-server-code');
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');

      // Alice completes an honest sign-in, pinning the honest server.
      as.nameAuthorizationServer(ORIGIN);
      await consent(env, { principalId: ALICE });
      expect(existsSync(pinFile(env))).toBe(true);

      // Bob returns without iss (the honest server does not send one).
      await expect(
        env.service.finishOAuth(SERVER, callback.href, bob),
      ).rejects.toThrow('OAuth authorization failed');
      expect(
        as.tokenRequests.filter((request) => request.origin === ATTACKER),
      ).toEqual([]);
    } finally {
      await as.close();
    }
  });

  test('a hostile first sign-in refused by its iss check pins nothing; the honest one then pins its server', async () => {
    const as = startAuthorizationServer({ dcr: true, mixUp: true });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
      });
      as.nameAuthorizationServer(ATTACKER);
      await expect(
        consent(env, { principalId: BOB }, undefined, ORIGIN),
      ).rejects.toThrow('OAuth authorization failed');
      expect(existsSync(pinFile(env))).toBe(false);

      as.nameAuthorizationServer(ORIGIN);
      await consent(env, { principalId: ALICE });
      expect(JSON.parse(readFileSync(pinFile(env), 'utf8')).issuer).toBe(
        ORIGIN,
      );
    } finally {
      await as.close();
    }
  });
});

describe("a person's scope choice is remembered between sign-ins", () => {
  test('remembered for their own account after a completed sign-in, never for someone else, and cleared by disconnect', async () => {
    const as = startAuthorizationServer({ dcr: false, authMethods: ['none'] });
    const env = setup();
    try {
      await createIntegration(env, {
        credentialOwnership: { owner: 'principal' },
        oauthClient: {
          clientId: CLIENT_ID,
          issuer: ORIGIN,
          scopes: ['mail.readonly'],
        },
      });
      const alice = { principalId: ALICE };
      const bob = { principalId: BOB };
      // Started but not completed: nothing is remembered.
      await env.service.startOAuth(SERVER, 'remote', alice, {
        scopes: ['mail.compose'],
      });
      expect(
        (await env.service.getAccountStatus(SERVER, alice)).rememberedScopes,
      ).toBeUndefined();

      await consent(env, alice, { scopes: ['mail.readonly', 'mail.compose'] });
      expect(
        (await env.service.getAccountStatus(SERVER, alice)).rememberedScopes,
      ).toEqual(['mail.readonly', 'mail.compose']);
      expect(
        (await env.service.getAccountStatus(SERVER, bob)).rememberedScopes,
      ).toBeUndefined();

      // Choosing the server's own scopes is a choice too.
      await consent(env, alice, { scopes: [] });
      expect(
        (await env.service.getAccountStatus(SERVER, alice)).rememberedScopes,
      ).toEqual([]);

      await env.service.disconnectAccount(SERVER, alice);
      expect(
        (await env.service.getAccountStatus(SERVER, alice)).rememberedScopes,
      ).toBeUndefined();
    } finally {
      await as.close();
    }
  });
});

describe('deployment-wide Client ID Metadata Document default', () => {
  const DEPLOYMENT_CIMD = 'https://station.example.org/oauth/client.json';
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('none by default: an advertising server gets dynamic registration', async () => {
    vi.stubEnv(OAUTH_CLIENT_METADATA_URL_ENV, '');
    const as = startAuthorizationServer({ dcr: true, cimd: true });
    const env = setup();
    try {
      await createIntegration(env);
      const url = await consent(env);
      expect(url.searchParams.get('client_id')).toBe('dcr-registered-client');
      expect(as.registrations).toHaveLength(1);
    } finally {
      await as.close();
    }
  });

  test('when set, it is the client ID for integrations without their own client', async () => {
    vi.stubEnv(OAUTH_CLIENT_METADATA_URL_ENV, DEPLOYMENT_CIMD);
    const as = startAuthorizationServer({ dcr: true, cimd: true });
    const env = setup();
    try {
      await createIntegration(env);
      const url = await consent(env);
      expect(url.searchParams.get('client_id')).toBe(DEPLOYMENT_CIMD);
      expect(as.registrations).toEqual([]);
      expect(as.tokenRequests[0]!.params.get('client_id')).toBe(
        DEPLOYMENT_CIMD,
      );
    } finally {
      await as.close();
    }
  });

  test.each([
    {
      label: 'its own metadata URL',
      own: { clientMetadataUrl: CIMD_URL },
      expected: CIMD_URL,
    },
    {
      label: 'a pre-registered client',
      own: { clientId: CLIENT_ID, issuer: ORIGIN },
      expected: CLIENT_ID,
    },
  ])('an integration with $label keeps it', async ({ own, expected }) => {
    vi.stubEnv(OAUTH_CLIENT_METADATA_URL_ENV, DEPLOYMENT_CIMD);
    const as = startAuthorizationServer({ dcr: true, cimd: true });
    const env = setup();
    try {
      await createIntegration(env, { oauthClient: own });
      const url = await consent(env);
      expect(url.searchParams.get('client_id')).toBe(expected);
    } finally {
      await as.close();
    }
  });

  test('a malformed value is refused, not ignored', () => {
    for (const value of [
      'http://station.example.org/client.json',
      'https://station.example.org/',
      'https://user:pw@station.example.org/client.json',
    ])
      expect(() =>
        deploymentClientMetadataUrl({ [OAUTH_CLIENT_METADATA_URL_ENV]: value }),
      ).toThrow(OAUTH_CLIENT_METADATA_URL_ENV);
    expect(deploymentClientMetadataUrl({})).toBeUndefined();
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
        oauthClient: {
          clientId: CLIENT_ID,
          issuer: ORIGIN,
          clientMetadataUrl: CIMD_URL,
        },
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
        oauthClient: { clientId: CLIENT_ID, issuer: ORIGIN },
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
