import type { ResolvedAgentToolServer } from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createEngineOAuthProxyRoutes } from '../../routes/mcp/engine-oauth-proxy-route.js';
import { resolveStationControlCallerFromToken } from '../../runtime/mcp/station-control-caller.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import {
  createInMemorySessionTurnBoundaryAuthority,
  runSessionStartWithBoundary,
} from '../../services/orchestration/session-turn-boundary.js';
import { createEngineMcpOAuthResolver } from '../../services/plugins/engine-mcp-oauth.js';
import { ToolServerCredentialStore } from '../../services/plugins/tool-server-credential-store.js';
import {
  INSTANCE_CREDENTIAL_OWNER,
  principalCredentialOwner,
  StationToolServerOAuthProvider,
  toolServerCredentialStoreFor,
} from '../../services/plugins/tool-server-oauth.js';
import { resolveClaudeMcpServers } from '../adapters/claude-mcp-passthrough.js';
import { resolveCodexMcpServers } from '../adapters/codex-mcp-passthrough.js';

const origin = 'https://oauth-mcp-fixture.example';
const endpoint = `${origin}/mcp`;
const issuer = { issuer: origin };
const server: ResolvedAgentToolServer = {
  id: 't3',
  transport: 'streamable-http',
  endpoint,
};
const makeTempDir = trackTempDirs();
let home: string;
let def: ToolDef;
let resolve: ReturnType<typeof createEngineMcpOAuthResolver>;

beforeEach(() => {
  home = makeTempDir('station-engine-oauth-');
  def = { ...server, kind: 'mcp', credentialOwnership: { owner: 'principal' } };
  const resolver = createEngineMcpOAuthResolver({
    homeDir: () => home,
    port: () => 43143,
    getIntegration: async (id) => ({ ...def, id }),
  });
  resolve = (servers, principal, project, session = 'oauth-session') =>
    resolver(servers, principal, project, session);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function account(principalId?: string, project?: string) {
  const owner = principalId
    ? principalCredentialOwner(principalId, project)
    : INSTANCE_CREDENTIAL_OWNER;
  const provider = new StationToolServerOAuthProvider(
    toolServerCredentialStoreFor(home, owner),
    't3',
    endpoint,
    'http://127.0.0.1:43143/integrations/t3/oauth/callback',
    undefined,
    owner,
  );
  // Use the production writers: issuer/resource envelopes are not raw token JSON.
  await provider.saveDiscoveryState({
    authorizationServerUrl: origin,
    resourceMetadata: { resource: endpoint, authorization_servers: [origin] },
    authorizationServerMetadata: {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['none'],
    },
  });
  await provider.saveClientInformation(
    { client_id: 'station-fixture', ...issuer },
    issuer,
  );
  return provider;
}

function expectEngineDelivery(
  tokens: ReadonlyMap<string, string>,
  value: string,
) {
  const url = tokens.get('t3')!;
  expect(url).toMatch(
    /^http:\/\/127.0.0.1:43143\/mcp\/oauth-proxy\/t3\/oauth-session\?token=/,
  );
  const claude = resolveClaudeMcpServers([server], undefined, {}, tokens);
  expect(claude.servers.t3).toEqual({ type: 'http', url });
  const codex = resolveCodexMcpServers([server], undefined, undefined, tokens);
  expect(codex.configArgs).toContain(`mcp_servers.t3.url="${url}"`);
  expect(JSON.stringify(claude)).not.toContain(value);
  expect(JSON.stringify(codex)).not.toContain(value);
  expect(JSON.stringify([claude, codex])).not.toContain('STATION_MCP_OAUTH_');
  expect(claude.skipped).toEqual([]);
  expect(codex.skipped).toEqual([]);
}

test('both engines receive a proxy URL for the selected Project account', async () => {
  const personal = await account('human:local:operator');
  const project = await account('human:local:operator', 'alpha');
  await personal.saveTokens(
    {
      access_token: 'personal-secret',
      token_type: 'Bearer',
      expires_in: 3600,
      ...issuer,
    },
    issuer,
  );
  await project.saveTokens(
    {
      access_token: 'project-secret',
      token_type: 'Bearer',
      expires_in: 3600,
      ...issuer,
    },
    issuer,
  );
  const urls = await resolve([server], 'human:local:operator', 'alpha');
  expectEngineDelivery(urls, 'project-secret');
  const authorizations: string[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.url !== endpoint)
        throw new Error('Unexpected Project account fixture request');
      authorizations.push(request.headers.get('authorization') ?? '');
      return request.headers.get('authorization') === 'Bearer project-secret'
        ? Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
        : new Response(null, { status: 401 });
    },
  );
  const response = await createEngineOAuthProxyRoutes().request(
    urls.get('t3')!,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    },
    loopbackEnv(),
  );
  expect(authorizations).toEqual(['Bearer project-secret']);
  expect(await response.json()).toMatchObject({ result: { tools: [] } });
});

test('refreshes expired tokens with the resource indicator once and delivers the rotated token to both engines', async () => {
  const provider = await account('human:local:operator');
  await provider.saveTokens(
    {
      access_token: 'expired-secret',
      refresh_token: 'refresh-secret',
      token_type: 'Bearer',
      expires_in: -1,
      ...issuer,
    },
    issuer,
  );
  const fetchSpy = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe(`${origin}/token`);
      const params = new URLSearchParams(await request.text());
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('client_id')).toBe('station-fixture');
      expect(params.get('refresh_token')).toBe('refresh-secret');
      expect(params.get('resource')).toBe(endpoint);
      return Response.json({
        access_token: 'rotated-secret',
        refresh_token: 'rotated-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    },
  );
  vi.stubGlobal('fetch', fetchSpy);
  const results = await Promise.all([
    resolve([server], 'human:local:operator'),
    resolve([server], 'human:local:operator'),
  ]);
  for (const tokens of results) expectEngineDelivery(tokens, 'rotated-secret');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect((await provider.tokens())?.refresh_token).toBe('rotated-refresh');
  expectEngineDelivery(
    await resolve([server], 'human:local:operator'),
    'rotated-secret',
  );
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'expired-without-refresh', 'refresh-rejected'])(
  '%s refuses engine delivery with needs-sign-in and no remote response text',
  async (condition) => {
    const provider = await account('human:local:operator');
    if (condition !== 'missing')
      await provider.saveTokens(
        {
          access_token: 'expired-secret',
          token_type: 'Bearer',
          expires_in: -1,
          ...(condition === 'refresh-rejected'
            ? { refresh_token: 'refresh-secret' }
            : {}),
          ...issuer,
        },
        issuer,
      );
    const fetchSpy = vi.fn(async () =>
      Response.json(
        { error: 'invalid_grant', error_description: 'opaque-remote-secret' },
        { status: 400 },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await expect(resolve([server], 'human:local:operator')).rejects.toThrow(
      "Integration 't3' needs sign-in",
    );
    await expect(resolve([server], 'human:local:operator')).rejects.toThrow(
      'needs sign-in',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(
      condition === 'refresh-rejected' ? 1 : 0,
    );
  },
);

test('never borrows another person or the shared account without explicit fallback', async () => {
  for (const principal of [undefined, 'human:local:someone-else']) {
    const provider = await account(principal);
    await provider.saveTokens(
      { access_token: 'other-secret', token_type: 'Bearer', ...issuer },
      issuer,
    );
  }
  await expect(resolve([server], 'human:local:operator')).rejects.toThrow(
    'needs sign-in',
  );
  def.credentialOwnership = { owner: 'principal', allowInstanceFallback: true };
  expectEngineDelivery(
    await resolve([server], 'human:local:operator'),
    'other-secret',
  );
});

test('a shared OAuth server without its token fails closed while a public remote server stays public', async () => {
  def = {
    ...def,
    credentialOwnership: undefined,
    probe: {
      ok: true,
      toolCount: 2,
      checkedAt: '2026-10-23T00:00:00Z',
      authorization: { state: 'authorized' },
    },
  };
  await expect(resolve([server])).rejects.toThrow('needs sign-in');
  def = { ...def, probe: undefined };
  expect((await resolve([server])).size).toBe(0);
});

test('an endpoint changed during refresh cannot receive the prepared credential', async () => {
  const provider = await account('human:local:operator');
  await provider.saveTokens(
    {
      access_token: 'expired',
      refresh_token: 'refresh',
      token_type: 'Bearer',
      expires_in: -1,
      ...issuer,
    },
    issuer,
  );
  vi.stubGlobal('fetch', async () => {
    def = { ...def, endpoint: `${origin}/different-mcp` };
    return Response.json({
      access_token: 'rotated-secret',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });
  await expect(resolve([server], 'human:local:operator')).rejects.toThrow(
    'changed',
  );
});

test('disconnect during refresh cannot recreate or export the removed account', async () => {
  const provider = await account('human:local:operator');
  await provider.saveTokens(
    {
      access_token: 'expired',
      refresh_token: 'refresh',
      token_type: 'Bearer',
      expires_in: -1,
      ...issuer,
    },
    issuer,
  );
  vi.stubGlobal('fetch', async () => {
    await provider.clearCredentials();
    return Response.json({
      access_token: 'rotated-secret',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });
  await expect(resolve([server], 'human:local:operator')).rejects.toThrow(
    'needs sign-in',
  );
  expect(await provider.tokens()).toBeUndefined();
});

test('disconnect after refresh validation cannot be overwritten by conditional publication', async () => {
  const provider = await account('human:local:operator');
  await provider.saveTokens(
    {
      access_token: 'expired',
      refresh_token: 'refresh',
      token_type: 'Bearer',
      expires_in: -1,
      ...issuer,
    },
    issuer,
  );
  vi.stubGlobal('fetch', async () =>
    Response.json({
      access_token: 'rotated-secret',
      token_type: 'Bearer',
      expires_in: 3600,
    }),
  );
  const publish = ToolServerCredentialStore.prototype.compareAndSwap;
  vi.spyOn(
    ToolServerCredentialStore.prototype,
    'compareAndSwap',
  ).mockImplementationOnce(async function (
    this: ToolServerCredentialStore,
    id,
    key,
    expected,
    next,
  ) {
    await provider.clearCredentials();
    return publish.call(this, id, key, expected, next);
  });
  await expect(resolve([server], 'human:local:operator')).rejects.toThrow(
    'needs sign-in',
  );
  expect(await provider.tokens()).toBeUndefined();
});

test('a losing compare-and-swap re-reads a concurrent writer without burning its refresh family', async () => {
  const provider = await account('human:local:operator');
  await provider.saveTokens(
    {
      access_token: 'old',
      refresh_token: 'old-refresh',
      token_type: 'Bearer',
      expires_in: -1,
      ...issuer,
    },
    issuer,
  );
  const publish = ToolServerCredentialStore.prototype.compareAndSwap;
  vi.spyOn(
    ToolServerCredentialStore.prototype,
    'compareAndSwap',
  ).mockImplementationOnce(async function (
    this: ToolServerCredentialStore,
    id,
    key,
    expected,
    next,
  ) {
    await provider.saveTokens(
      {
        access_token: 'winner',
        refresh_token: 'winner-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        ...issuer,
      },
      issuer,
    );
    return publish.call(this, id, key, expected, next);
  });
  const fetchSpy = vi.fn(async () =>
    Response.json({
      access_token: 'loser',
      refresh_token: 'loser-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  const transport = await provider.forTransport();
  if (!('token' in transport))
    throw new Error('Existing account must use coordinated transport');
  const [, token] = await Promise.all([
    resolve([server], 'human:local:operator'),
    transport.token(),
  ]);
  expect(token).toBe('winner');
  expect((await provider.tokens())?.refresh_token).toBe('winner-refresh');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test.each(['legacy', 'unknown-expiry'])(
  '%s tokens remain usable until rejected by the remote',
  async (kind) => {
    const provider = await account('human:local:operator');
    await provider.saveTokens(
      { access_token: 'legacy', token_type: 'Bearer', ...issuer },
      issuer,
    );
    if (kind === 'legacy') {
      const store = toolServerCredentialStoreFor(
        home,
        principalCredentialOwner('human:local:operator'),
      );
      const raw = JSON.parse(store.get(provider.bucket, 'oauth.tokens'));
      raw.value.expires_in = 3600;
      await store.upsert(provider.bucket, 'oauth.tokens', JSON.stringify(raw));
    }
    expectEngineDelivery(
      await resolve([server], 'human:local:operator'),
      'legacy',
    );
    await expect(provider.accessToken('legacy')).rejects.toThrow(
      'Connect your account',
    );
  },
);

const loopbackEnv = (remoteAddress = '127.0.0.1') => ({
  incoming: { socket: { remoteAddress } },
});

async function proxyFixture() {
  const provider = await account('human:local:operator');
  await provider.saveTokens(
    {
      access_token: 'remote-secret',
      refresh_token: 'refresh-secret',
      token_type: 'Bearer',
      expires_in: 3600,
      ...issuer,
    },
    issuer,
  );
  let acceptedToken = 'remote-secret';
  let refreshes = 0;
  const seen: string[] = [];
  const remote = new Hono();
  const mcp = createMcpHandler(
    () => {
      const service = new McpServer({
        name: 'fixture-oauth-mcp',
        version: '1.0.0',
      });
      service.registerTool(
        'fixture_echo',
        { inputSchema: z.object({ text: z.string() }) },
        async ({ text }) => ({ content: [{ type: 'text', text }] }),
      );
      return service;
    },
    { legacy: 'stateless' },
  );
  remote.all('/mcp', async (c) => {
    seen.push(c.req.header('authorization') ?? '');
    if (c.req.header('authorization') !== `Bearer ${acceptedToken}`)
      return c.text('Unauthorized opaque-remote-secret', 401);
    return mcp.fetch(c.req.raw);
  });
  const fetchSpy = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.url === `${origin}/token`) {
        refreshes++;
        acceptedToken = `rotated-${refreshes}`;
        return Response.json({
          access_token: acceptedToken,
          refresh_token: `refresh-${refreshes}`,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      expect(new URL(request.url).origin).toBe(origin);
      return remote.fetch(request);
    },
  );
  vi.stubGlobal('fetch', fetchSpy);
  const urls = await resolve([server], 'human:local:operator');
  const url = urls.get('t3')!;
  const proxy = createEngineOAuthProxyRoutes();
  const client = new Client({ name: 'engine-fixture', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: async (input, init) => proxy.request(input, init, loopbackEnv()),
  });
  await client.connect(transport);
  return {
    provider,
    client,
    url,
    proxy,
    seen,
    refreshes: () => refreshes,
    rejectCurrent: () => {
      acceptedToken = 'not-the-stored-token';
    },
  };
}

test('the proxy reaches real MCP tools, refreshes mid-session expiry and 401, and fails visibly after disconnect', async () => {
  const fixture = await proxyFixture();
  try {
    expect(
      await fixture.client.callTool({
        name: 'fixture_echo',
        arguments: { text: 'authenticated call' },
      }),
    ).toMatchObject({ content: [{ text: 'authenticated call' }] });
    await fixture.provider.saveTokens(
      {
        access_token: 'remote-secret',
        refresh_token: 'refresh-secret',
        token_type: 'Bearer',
        expires_in: 61,
        ...issuer,
      },
      issuer,
    );
    expect(
      await fixture.client.callTool({
        name: 'fixture_echo',
        arguments: { text: 'near expiry' },
      }),
    ).toMatchObject({ content: [{ text: 'near expiry' }] });
    expect(fixture.refreshes()).toBe(1);
    fixture.rejectCurrent();
    expect(
      await fixture.client.callTool({
        name: 'fixture_echo',
        arguments: { text: 'after 401' },
      }),
    ).toMatchObject({ content: [{ text: 'after 401' }] });
    expect(fixture.refreshes()).toBe(2);
    expect(fixture.seen).toContain('Bearer remote-secret');
    expect(fixture.seen).toContain('Bearer rotated-2');
    await fixture.provider.clearCredentials();
    await expect(
      fixture.client.callTool({
        name: 'fixture_echo',
        arguments: { text: 'disconnected' },
      }),
    ).rejects.toThrow('needs sign-in');
    expect(fixture.seen).not.toContain('');
  } finally {
    await fixture.client.close();
  }
});

test('proxy auth binds session and server, excludes Station-control credentials, and refuses non-loopback and ended sessions', async () => {
  const fixture = await proxyFixture();
  const request = (url: string, address?: string) =>
    fixture.proxy.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      },
      loopbackEnv(address),
    );
  try {
    const other = { ...server, id: 'other' };
    const owner = principalCredentialOwner('human:local:operator');
    const otherProvider = new StationToolServerOAuthProvider(
      toolServerCredentialStoreFor(home, owner),
      'other',
      endpoint,
      'http://127.0.0.1:43143/callback',
      undefined,
      owner,
    );
    await otherProvider.saveTokens({
      access_token: 'remote-secret',
      token_type: 'Bearer',
    });
    await resolve([other], 'human:local:operator');
    await resolve([server], 'human:local:operator', undefined, 'other-session');
    const url = new URL(fixture.url);
    expect(
      resolveStationControlCallerFromToken(url.searchParams.get('token')),
    ).toBeNull();
    url.search = '';
    expect((await request(url.href)).status).toBe(401);
    const wrongServer = fixture.url.replace('/t3/', '/other/');
    expect((await request(wrongServer)).status).toBe(401);
    expect(
      (await request(fixture.url.replace('/oauth-session?', '/other-session?')))
        .status,
    ).toBe(401);
    const { token } = mintStationControlMcpToken('oauth-session', 'url-token');
    url.searchParams.set('token', token);
    expect((await request(url.href)).status).toBe(401);
    expect((await request(fixture.url, '192.0.2.25')).status).toBe(404);
    revokeStationControlMcpToken('oauth-session');
    expect((await request(fixture.url)).status).toBe(401);
  } finally {
    await fixture.client.close();
  }
});

test('missing OAuth refuses the real start boundary deterministically without possible provider effects', async () => {
  const authority = createInMemorySessionTurnBoundaryAuthority();
  await expect(
    runSessionStartWithBoundary(authority, 'oauth-session', () =>
      resolve([server], 'human:local:operator'),
    ),
  ).rejects.toMatchObject({
    code: 'mcp_sign_in_required',
    failurePhase: 'refused',
  });
  expect(authority.hasPossibleEffect('oauth-session')).toEqual({
    kind: 'available',
    active: false,
  });
});

test('SSE endpoint events stay on the authenticated proxy and message POSTs inject only the remote bearer', async () => {
  const provider = await account('human:local:operator');
  await provider.saveTokens(
    { access_token: 'sse-remote-token', token_type: 'Bearer', ...issuer },
    issuer,
  );
  const sse = { ...server, transport: 'sse' as const };
  def = { ...def, transport: 'sse' };
  const urls = await resolve([sse], 'human:local:operator');
  const url = urls.get('t3')!;
  const remoteMessage = `${origin}/messages?sessionId=remote-session`;
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      seen.push(request.url);
      expect(request.headers.get('authorization')).toBe(
        'Bearer sse-remote-token',
      );
      expect(request.url).not.toContain(new URL(url).searchParams.get('token'));
      if (request.method === 'GET')
        return new Response(`event: endpoint\ndata: ${remoteMessage}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      expect(request.url).toBe(remoteMessage);
      return new Response(null, { status: 202 });
    },
  );
  const proxy = createEngineOAuthProxyRoutes();
  const response = await proxy.request(url, {}, loopbackEnv());
  const events = await response.text();
  const localMessage = /^data: (.+)$/m.exec(events)?.[1];
  expect(localMessage).toContain(
    '/mcp/oauth-proxy/t3/oauth-session/messages?token=',
  );
  expect(events).not.toContain(origin);
  expect(
    (
      await proxy.request(
        localMessage!,
        {
          method: 'POST',
          body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        },
        loopbackEnv(),
      )
    ).status,
  ).toBe(202);
  expect(seen).toEqual([endpoint, remoteMessage]);
});
