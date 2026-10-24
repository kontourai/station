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
  ToolServerOAuthUnavailableError,
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
const needsSignIn = vi.fn(async (_id: string, _resource: string) => {});
let resolve: ReturnType<typeof createEngineMcpOAuthResolver>;

beforeEach(() => {
  needsSignIn.mockClear();
  home = makeTempDir('station-engine-oauth-');
  def = { ...server, kind: 'mcp', credentialOwnership: { owner: 'principal' } };
  const resolver = createEngineMcpOAuthResolver({
    needsSignIn,
    homeDir: () => home,
    port: () => 43143,
    getIntegration: async (id) => ({ ...def, id }),
  });
  resolve = (servers, principal, project, session = 'oauth-session') =>
    resolver(servers, principal, project, session);
});
afterEach(() => {
  vi.useRealTimers();
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

async function proxyAccount() {
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
  const urls = await resolve([server], 'human:local:operator');
  return {
    provider,
    url: urls.get('t3')!,
    proxy: createEngineOAuthProxyRoutes(),
  };
}

async function proxyFixture(mode: 'legacy' | 'auto' = 'legacy') {
  const { provider, url, proxy } = await proxyAccount();
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
  const client = new Client(
    { name: 'engine-fixture', version: '1.0' },
    { versionNegotiation: { mode } },
  );
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

test.each(['legacy', 'auto'] as const)(
  '%s proxy reaches real MCP tools, refreshes mid-session expiry and 401, and fails visibly after disconnect',
  async (mode) => {
    const fixture = await proxyFixture(mode);
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
  },
);

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

test('a fresh token read cannot swallow a concurrent remote-401 refresh', async () => {
  const provider = await account('human:local:operator');
  await provider.saveTokens(
    {
      access_token: 'current',
      refresh_token: 'refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      ...issuer,
    },
    issuer,
  );
  const refresh = vi.fn(async () =>
    Response.json({
      access_token: 'after-401',
      refresh_token: 'next-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    }),
  );
  vi.stubGlobal('fetch', refresh);
  const [, rejected] = await Promise.all([
    provider.accessToken(),
    provider.accessToken('current'),
  ]);
  expect(rejected).toBe('after-401');
  expect(refresh).toHaveBeenCalledTimes(1);
});

const proxyPost = (
  proxy: Hono,
  url: string,
  body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
) =>
  proxy.request(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
    },
    loopbackEnv(),
  );

test.each(['503', 'network', 'timeout'] as const)(
  '%s refresh failure preserves early and expired accounts and recovers through managed transport and engine admission',
  async (kind) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    const provider = await account('human:local:operator');
    let unavailable = true;
    let attempts = 0;
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      attempts++;
      if (unavailable) {
        if (kind === '503') return new Response(null, { status: 503 });
        if (kind === 'network') throw new TypeError('network failure');
        // Exercise the production timeout signal without a 15-second wall-clock sleep.
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(init!.signal!.reason),
            { once: true },
          );
        });
      }
      return Response.json({
        access_token: 'recovered',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    });
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    if (kind === 'timeout')
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        expect(ms).toBe(15_000);
        return realTimeout(1);
      });
    for (const expires_in of [90, -1]) {
      await provider.saveTokens(
        {
          access_token: 'retained',
          refresh_token: 'refresh',
          token_type: 'Bearer',
          expires_in,
          ...issuer,
        },
        issuer,
      );
      const transport = await provider.forTransport();
      if (!('token' in transport))
        throw new Error('Expected managed account transport');
      if (expires_in > 0) {
        expect(await transport.token()).toBe('retained');
        await resolve([server], 'human:local:operator');
        await expect(provider.accessToken('retained')).rejects.toBeInstanceOf(
          ToolServerOAuthUnavailableError,
        );
      } else {
        await expect(transport.token()).rejects.toBeInstanceOf(
          ToolServerOAuthUnavailableError,
        );
        await expect(
          resolve([server], 'human:local:operator'),
        ).rejects.toBeInstanceOf(ToolServerOAuthUnavailableError);
      }
      expect((await provider.tokens())?.access_token).toBe('retained');
      expect(needsSignIn).not.toHaveBeenCalled();
      unavailable = false;
      vi.setSystemTime(Date.now() + 30_000);
      expect(await provider.accessToken()).toBe('recovered');
      unavailable = true;
    }
    expect(attempts).toBe(5);
  },
);

test.each([90, -1])(
  'a transient refresh outage cools down sequential requests for a token with %s seconds remaining',
  async (expires_in) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    const provider = await account('human:local:operator');
    await provider.saveTokens(
      {
        access_token: 'retained',
        refresh_token: 'refresh',
        token_type: 'Bearer',
        expires_in,
        ...issuer,
      },
      issuer,
    );
    const remote = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', remote);
    const transport = await provider.forTransport();
    if (!('token' in transport))
      throw new Error('Expected managed account transport');
    const read = async () => {
      if (expires_in > 0) expect(await transport.token()).toBe('retained');
      else
        await expect(transport.token()).rejects.toBeInstanceOf(
          ToolServerOAuthUnavailableError,
        );
    };
    await read();
    expect(remote).toHaveBeenCalledTimes(1);
    // Make extra network calls observable without introducing a hanging fixture.
    remote.mockImplementation(async () => {
      throw new Error('Cooldown must skip the network');
    });
    for (let i = 0; i < 5; i++) await read();
    if (expires_in > 0) await resolve([server], 'human:local:operator');
    else
      await expect(
        resolve([server], 'human:local:operator'),
      ).rejects.toBeInstanceOf(ToolServerOAuthUnavailableError);
    expect(remote).toHaveBeenCalledTimes(1);
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Response>();
    remote.mockImplementation(async () => {
      entered.resolve();
      return reply.promise;
    });
    // A 401 gets one forced attempt; ordinary cooldown reads do not wait for it.
    const forced = expect(
      provider.accessToken('retained'),
    ).rejects.toBeInstanceOf(ToolServerOAuthUnavailableError);
    await entered.promise;
    try {
      await read();
    } finally {
      reply.resolve(new Response(null, { status: 503 }));
      await forced;
    }
    remote.mockImplementation(async () => new Response(null, { status: 503 }));
    expect(remote).toHaveBeenCalledTimes(2);
    await expect(provider.accessToken('retained')).rejects.toBeInstanceOf(
      ToolServerOAuthUnavailableError,
    );
    await read();
    expect(remote).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 29_999);
    await read();
    expect(remote).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 1);
    await read();
    expect(remote).toHaveBeenCalledTimes(3);
    expect(needsSignIn).not.toHaveBeenCalled();
  },
);

test.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])(
  '%s retires the account and records authorization health',
  async (error) => {
    const provider = await account('human:local:operator');
    await provider.saveTokens(
      {
        access_token: 'rejected',
        refresh_token: 'refresh',
        token_type: 'Bearer',
        expires_in: 90,
        ...issuer,
      },
      issuer,
    );
    const remote = vi.fn(async () => Response.json({ error }, { status: 400 }));
    vi.stubGlobal('fetch', remote);
    await expect(resolve([server], 'human:local:operator')).rejects.toThrow(
      'needs sign-in',
    );
    expect(await provider.tokens()).toBeUndefined();
    await expect(provider.accessToken()).rejects.toThrow(
      'Connect your account',
    );
    expect(remote).toHaveBeenCalledTimes(1);
    expect(needsSignIn).toHaveBeenCalledWith('t3', endpoint);
  },
);

test('a parallel request refresh between token selection and send uses the current bearer without marking health', async () => {
  const fixture = await proxyAccount();
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === `${origin}/token`)
        return Response.json({
          access_token: 'rotated-1',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    },
  );
  const access = StationToolServerOAuthProvider.prototype.accessToken;
  let entered = false;
  vi.spyOn(
    StationToolServerOAuthProvider.prototype,
    'accessToken',
  ).mockImplementation(async function (
    this: StationToolServerOAuthProvider,
    rejected,
  ) {
    const selected = await access.call(this, rejected);
    if (!entered) {
      entered = true;
      // A second request refreshes the same account after this request selected its token.
      await access.call(fixture.provider, selected);
    }
    return selected;
  });
  const response = await proxyPost(fixture.proxy, fixture.url);
  expect(await response.json()).toMatchObject({
    result: { tools: expect.any(Array) },
  });
  expect(seen.at(-1)).toBe('Bearer rotated-1');
  expect(needsSignIn).not.toHaveBeenCalled();
  expect((await fixture.provider.tokens())?.access_token).toBe('rotated-1');
});

test.each([
  'disconnect',
  'missing-at-send',
  'missing-refresh',
  'rejected-without-refresh',
  'repeated-401',
] as const)(
  '%s through the proxy marks authorization health and repeated rejection cannot burn a refresh family',
  async (condition) => {
    const fixture = await proxyAccount();
    if (condition === 'disconnect') await fixture.provider.clearCredentials();
    else if (condition === 'missing-at-send') {
      const access = StationToolServerOAuthProvider.prototype.accessToken;
      vi.spyOn(
        StationToolServerOAuthProvider.prototype,
        'accessToken',
      ).mockImplementationOnce(async function (
        this: StationToolServerOAuthProvider,
      ) {
        const token = await access.call(this);
        await fixture.provider.clearCredentials();
        return token;
      });
    } else if (condition === 'rejected-without-refresh') {
      await fixture.provider.saveTokens(
        {
          access_token: 'rejected',
          token_type: 'Bearer',
          expires_in: 3600,
          ...issuer,
        },
        issuer,
      );
      vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));
    } else if (condition === 'missing-refresh')
      await fixture.provider.saveTokens(
        {
          access_token: 'expired',
          token_type: 'Bearer',
          expires_in: -1,
          ...issuer,
        },
        issuer,
      );
    else {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          if (String(input) === `${origin}/token`)
            return Response.json({
              access_token: 'rejected-again',
              refresh_token: 'rotating-family',
              token_type: 'Bearer',
              expires_in: 3600,
            });
          return new Response(null, { status: 401 });
        }),
      );
    }
    needsSignIn.mockClear();
    expect(
      await (await proxyPost(fixture.proxy, fixture.url)).json(),
    ).toMatchObject({
      error: { message: expect.stringContaining('needs sign-in') },
    });
    expect(needsSignIn).toHaveBeenCalledWith('t3', endpoint);
    expect(await fixture.provider.tokens()).toBeUndefined();
    if (condition === 'repeated-401') {
      const remote = vi.mocked(fetch);
      const calls = remote.mock.calls.length;
      expect(calls).toBe(3);
      expect(
        await (await proxyPost(fixture.proxy, fixture.url)).json(),
      ).toMatchObject({
        error: { message: expect.stringContaining('needs sign-in') },
      });
      expect(remote).toHaveBeenCalledTimes(calls);
    }
  },
);

test('an expired-token refresh outage through the proxy is retryable without changing account health', async () => {
  const fixture = await proxyAccount();
  await fixture.provider.saveTokens(
    {
      access_token: 'expired',
      refresh_token: 'refresh',
      token_type: 'Bearer',
      expires_in: -1,
      ...issuer,
    },
    issuer,
  );
  vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }));
  const response = await proxyPost(fixture.proxy, fixture.url);
  const body = await response.text();
  expect(body).toContain('unavailable');
  expect(body).not.toContain('needs sign-in');
  expect(await fixture.provider.tokens()).toBeDefined();
  expect(needsSignIn).not.toHaveBeenCalled();
});

test('the proxy forwards just before its twelve-hour credential expiry and refuses at expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const issuedAt = new Date('2026-10-23T12:00:00Z').getTime();
  vi.setSystemTime(issuedAt);
  // Independent 12-hour contract for station-control-mcp-token.ts DEFAULT_TTL_MS.
  const proxyTtlMs = 12 * 60 * 60 * 1000;
  const fixture = await proxyAccount();
  await fixture.provider.saveTokens(
    { access_token: 'remote-secret', token_type: 'Bearer', ...issuer },
    issuer,
  );
  const remote = vi.fn(async () =>
    Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
  );
  vi.stubGlobal('fetch', remote);
  vi.setSystemTime(issuedAt + proxyTtlMs - 60_000);
  const beforeExpiry = await proxyPost(fixture.proxy, fixture.url);
  expect(beforeExpiry.status).toBe(200);
  expect(await beforeExpiry.json()).toMatchObject({
    result: { tools: [] },
  });
  expect(remote).toHaveBeenCalledOnce();
  remote.mockClear();
  vi.setSystemTime(issuedAt + proxyTtlMs);
  expect((await proxyPost(fixture.proxy, fixture.url)).status).toBe(401);
  expect(remote).not.toHaveBeenCalled();
});

test('streamed bodies at each proxy limit succeed and limit-plus-one bodies are cancelled', async () => {
  const fixture = await proxyAccount();
  const finiteBody = (text: string, cancel: () => void) => {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset === bytes.length) controller.close();
          else {
            const end = Math.min(offset + 8192, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
  };
  const requestLimit = 8 * 1024 * 1024;
  const negotiationLimit = 64 * 1024;
  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  const remote = vi.fn(async () =>
    Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
  );
  vi.stubGlobal('fetch', remote);
  for (const extra of [0, 1]) {
    remote.mockClear();
    const cancelled = vi.fn();
    const requestOptions: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      body: finiteBody(requestBody.padEnd(requestLimit + extra), cancelled),
      duplex: 'half',
    };
    const result = await fixture.proxy.request(
      new Request(fixture.url, requestOptions),
      {},
      loopbackEnv(),
    );
    if (extra === 0) {
      expect(await result.json()).toMatchObject({ result: { tools: [] } });
      expect(remote).toHaveBeenCalledOnce();
      expect(cancelled).not.toHaveBeenCalled();
    } else {
      expect(result.status).toBe(413);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(remote).not.toHaveBeenCalled();
    }
  }
  const negotiation = JSON.stringify({
    error: { code: -32022, data: { supported: ['2025-03-26'] } },
  });
  for (const extra of [0, 1]) {
    const cancelled = vi.fn();
    remote.mockImplementation(
      async () =>
        new Response(
          finiteBody(negotiation.padEnd(negotiationLimit + extra), cancelled),
          { status: 400 },
        ),
    );
    const result = await proxyPost(fixture.proxy, fixture.url);
    if (extra === 0) {
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({
        error: { code: -32022, data: { supported: ['2025-03-26'] } },
      });
      expect(cancelled).not.toHaveBeenCalled();
    } else {
      expect(await result.json()).toMatchObject({
        error: { message: 'Remote MCP request failed.' },
      });
      expect(cancelled).toHaveBeenCalledOnce();
    }
  }
});
