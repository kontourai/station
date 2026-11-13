/**
 * Check all probes with `startSignIn: false`. A remote server that wants a
 * sign-in must then be recorded as needing one, with no authorization URL, no
 * client registration and no pending sign-in left behind. The person's own
 * check (the default) still begins a sign-in, which proves the fixture reaches
 * the authorization branch.
 */
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { MCPService } from '../mcp-service.js';
import { ToolServerCredentialStore } from '../tool-server-credential-store.js';
import { StationToolServerOAuthProvider } from '../tool-server-oauth.js';

const ORIGIN = 'https://check-only-fixture.example';
const makeHome = trackTempDirs();
let home: string;
let loader: ConfigLoader;
let custody: MCPLocalConnectionCustody;
let service: MCPService;
let requests: string[];
/** What the MCP endpoint answers; an OAuth server's 401 by default. */
let mcpAnswer: () => Response;
const oauthChallenge = () =>
  new Response('authorization required', {
    status: 401,
    headers: {
      'www-authenticate': `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
    },
  });

beforeEach(async () => {
  home = makeHome('station-probe-check-only-');
  loader = new ConfigLoader({ projectHomeDir: home });
  custody = new MCPLocalConnectionCustody({ waitMs: 5 });
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  service = new MCPService(
    loader,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    logger,
    undefined,
    43141,
    undefined,
    undefined,
    custody,
  );
  requests = [];
  mcpAnswer = oauthChallenge;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
        return Response.json({
          resource: `${ORIGIN}/mcp`,
          authorization_servers: [ORIGIN],
          scopes_supported: ['mcp'],
        });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        return Response.json({
          issuer: ORIGIN,
          authorization_endpoint: `${ORIGIN}/authorize`,
          token_endpoint: `${ORIGIN}/token`,
          registration_endpoint: `${ORIGIN}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['mcp'],
        });
      if (url.pathname === '/register') {
        const registered = (await request.json()) as Record<string, unknown>;
        return Response.json({
          ...registered,
          client_id: 'check-only-client',
          token_endpoint_auth_method: 'none',
        });
      }
      if (url.pathname === '/mcp') return mcpAnswer();
      return new Response('not found', { status: 404 });
    }),
  );
  // Its last probe passed: Check all includes it.
  await loader.saveIntegration('remote', {
    id: 'remote',
    kind: 'mcp',
    transport: 'streamable-http',
    endpoint: `${ORIGIN}/mcp`,
    probe: { ok: true, toolCount: 2, checkedAt: new Date(0).toISOString() },
  });
});

afterEach(async () => {
  try {
    expect((await custody.shutdown()).state).toBe('settled');
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await loader.dispose();
  }
});

test('a person’s own check of a server that wants a sign-in begins one', async () => {
  const probed = await service.probeIntegration('remote');
  expect(probed.probe?.authorization).toEqual({
    state: 'awaiting-operator-consent',
  });
  expect(requests).toContain('/register');
  expect(service.inspectLocalConnections().retained).toBe(1);
});

test('a check-only probe records that a sign-in is needed and begins none', async () => {
  const probed = await service.probeIntegration('remote', undefined, {
    startSignIn: false,
  });
  expect(probed.probe).toMatchObject({
    ok: false,
    toolCount: 0,
    authorization: { state: 'never-authorized' },
  });
  expect((await loader.loadIntegration('remote')).probe).toMatchObject({
    ok: false,
    authorization: { state: 'never-authorized' },
  });
  // It asked the server, and went no further: no discovery, no client
  // registration, no authorization URL and nothing held for a pending sign-in.
  expect(requests).toContain('/mcp');
  expect(requests).not.toContain('/register');
  expect(requests).not.toContain('/.well-known/oauth-authorization-server');
  expect(service.inspectLocalConnections().retained).toBe(0);
  await expect(
    service.finishOAuth(
      'remote',
      'http://127.0.0.1:43141/integrations/remote/oauth/callback?code=x&state=y',
    ),
  ).rejects.toThrow();
});

async function saveSignIn() {
  await new StationToolServerOAuthProvider(
    new ToolServerCredentialStore(home),
    'remote',
    `${ORIGIN}/mcp`,
    'http://127.0.0.1:43141/integrations/remote/oauth/callback',
  ).saveTokens({
    access_token: 'still-valid',
    token_type: 'Bearer',
    expires_in: 3600,
  });
}

test('a check-only 401 from a server with no OAuth (a refused API key) is an ordinary failure, not a sign-in', async () => {
  mcpAnswer = () => new Response('bad key', { status: 401 });
  const probed = await service.probeIntegration('remote', undefined, {
    startSignIn: false,
  });
  expect(probed.probe).toMatchObject({ ok: false, toolCount: 0 });
  expect(probed.probe?.error).toBeTruthy();
  expect(probed.probe?.authorization).toBeUndefined();
  const saved = (await loader.loadIntegration('remote')).probe;
  expect(saved?.ok).toBe(false);
  expect(saved?.authorization).toBeUndefined();
  expect(requests).not.toContain('/register');
});

test('a check-only 403 with a working saved sign-in is not recorded as an expired sign-in', async () => {
  await saveSignIn();
  mcpAnswer = () => new Response('forbidden', { status: 403 });
  const probed = await service.probeIntegration('remote', undefined, {
    startSignIn: false,
  });
  expect(probed.probe).toMatchObject({ ok: false, toolCount: 0 });
  expect(probed.probe?.authorization).toBeUndefined();
  expect(
    (await loader.loadIntegration('remote')).probe?.authorization,
  ).toBeUndefined();
});

test('a check-only 401 with a saved sign-in records that the sign-in no longer works', async () => {
  // The control for the 403 case: the saved sign-in alone marks the server
  // as an OAuth server, with no discovery in the answer.
  await saveSignIn();
  mcpAnswer = () => new Response('expired', { status: 401 });
  const probed = await service.probeIntegration('remote', undefined, {
    startSignIn: false,
  });
  expect(probed.probe?.authorization).toMatchObject({
    state: 'token-expired-refresh-failed',
  });
});
