import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedAgentToolServer } from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createEngineMcpOAuthResolver,
  engineMcpTokenEnvName,
} from '../../services/plugins/engine-mcp-oauth.js';
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
let home: string;
let def: ToolDef;
let resolve: ReturnType<typeof createEngineMcpOAuthResolver>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'station-engine-oauth-'));
  def = { ...server, kind: 'mcp', credentialOwnership: { owner: 'principal' } };
  resolve = createEngineMcpOAuthResolver({
    homeDir: () => home,
    port: () => 43143,
    getIntegration: async () => def,
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
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
  const name = engineMcpTokenEnvName('t3');
  const claude = resolveClaudeMcpServers([server], undefined, {}, tokens);
  expect(claude.servers.t3).toEqual({
    type: 'http',
    url: endpoint,
    headers: { Authorization: `Bearer \${${name}}` },
  });
  expect(claude.env?.[name]).toBe(value);
  const codex = resolveCodexMcpServers([server], undefined, undefined, tokens);
  expect(codex.configArgs).toContain(
    `mcp_servers.t3.bearer_token_env_var="${name}"`,
  );
  expect(codex.env?.[name]).toBe(value);
  expect(codex.deliveredIds).toEqual(['t3']);
  expect(JSON.stringify(claude.servers)).not.toContain(value);
  expect(codex.configArgs.join(' ')).not.toContain(value);
  expect(claude.skipped).toEqual([]);
  expect(codex.skipped).toEqual([]);
}

test('both engine passthroughs deliver the Project account through env, without secrets in config', async () => {
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
  const fetchSpy = vi.fn(() => {
    throw new Error('fresh credentials must not perform discovery or refresh');
  });
  vi.stubGlobal('fetch', fetchSpy);
  expectEngineDelivery(
    await resolve([server], 'human:local:operator', 'alpha'),
    'project-secret',
  );
  expect(fetchSpy).not.toHaveBeenCalled();
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
    'needs sign-in',
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
