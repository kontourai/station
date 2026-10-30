/**
 * #3483: the untrusted-content permission for external engines, at the
 * Station seams that carry their MCP calls: the OAuth proxy (here) and the
 * station-control guard (station-control-authority-guard.routes.test.ts),
 * and the staged evaluator stage that makes an engine ask the person.
 */
import type { ResolvedAgentToolServer } from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createEngineOAuthProxyRoutes } from '../../../routes/mcp/engine-oauth-proxy-route.js';
import { createStagedPreToolPolicyEvaluator } from '../../../runtime/agents/pre-tool-policy.js';
import { createEngineMcpOAuthResolver } from '../engine-mcp-oauth.js';
import {
  externalUntrustedContentPermission,
  recordPersonApprovedExternalTool,
  resetPersonApprovedCalls,
} from '../mediated-untrusted-content-gate.js';
import {
  principalCredentialOwner,
  StationToolServerOAuthProvider,
  toolServerCredentialStoreFor,
} from '../tool-server-oauth.js';
import { sharedUntrustedContentLedger } from '../untrusted-content-policy.js';

const makeTempDir = trackTempDirs();
const PRINCIPAL = 'human:local:operator';
const origin = 'https://mail-fixture.example';
const endpoint = `${origin}/mcp`;
let home: string;
let def: ToolDef;
let session = 0;
let sessionId: string;
let remote: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  resetPersonApprovedCalls();
  home = makeTempDir('station-mediated-gate-');
  sessionId = `mediated-session-${++session}`;
  def = {
    id: 'mail',
    kind: 'mcp',
    transport: 'streamable-http',
    endpoint,
    credentialOwnership: { owner: 'principal' },
    contentTrust: 'untrusted',
  };
  const owner = principalCredentialOwner(PRINCIPAL);
  const provider = new StationToolServerOAuthProvider(
    toolServerCredentialStoreFor(home, owner),
    'mail',
    endpoint,
    'http://127.0.0.1:43143/integrations/mail/oauth/callback',
    undefined,
    owner,
  );
  const issuer = { issuer: origin };
  await provider.saveDiscoveryState({
    authorizationServerUrl: origin,
    resourceMetadata: { resource: endpoint, authorization_servers: [origin] },
    authorizationServerMetadata: {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['none'],
    },
  });
  await provider.saveClientInformation(
    { client_id: 'station-fixture', ...issuer },
    issuer,
  );
  await provider.saveTokens(
    {
      access_token: 'remote-secret',
      token_type: 'Bearer',
      expires_in: 3600,
      ...issuer,
    },
    issuer,
  );
  remote = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = (await request.json()) as { id: number };
    return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
  });
  vi.stubGlobal('fetch', remote);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function proxy() {
  const server: ResolvedAgentToolServer = {
    id: 'mail',
    transport: 'streamable-http',
    endpoint,
  };
  const urls = await createEngineMcpOAuthResolver({
    homeDir: () => home,
    port: () => 43143,
    getIntegration: async () => def,
  })([server], PRINCIPAL, undefined, sessionId);
  const app = new Hono();
  app.route('', createEngineOAuthProxyRoutes());
  let id = 0;
  return async (method: string, name?: string) => {
    const response = await app.request(
      urls.get('mail')!,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method,
          ...(name ? { params: { name, arguments: {} } } : {}),
        }),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );
    return {
      status: response.status,
      body: (await response.json()) as { error?: { message: string } },
    };
  };
}

test('a proxied result from an untrusted server marks the conversation, and later calls ask', async () => {
  const call = await proxy();
  expect(
    await sharedUntrustedContentLedger.conversationHasRead(sessionId),
  ).toBe(false);
  expect((await call('tools/list')).status).toBe(200);
  expect(
    await sharedUntrustedContentLedger.conversationHasRead(sessionId),
  ).toBe(false);
  expect((await call('tools/call', 'read_message')).status).toBe(200);
  expect(
    await sharedUntrustedContentLedger.conversationHasRead(sessionId),
  ).toBe(true);
  remote.mockClear();
  const refused = await call('tools/call', 'send_reply');
  expect(refused.status).toBe(403);
  expect(refused.body.error?.message).toMatch(/needs your approval/);
  expect(remote).not.toHaveBeenCalled();
});

test("a person's approval of that tool admits exactly one call", async () => {
  const call = await proxy();
  await call('tools/call', 'read_message');
  recordPersonApprovedExternalTool(sessionId, 'mcp__mail__send_reply');
  remote.mockClear();
  expect((await call('tools/call', 'send_reply')).status).toBe(200);
  expect((await call('tools/call', 'send_reply')).status).toBe(403);
  expect(remote).toHaveBeenCalledTimes(1);
  // An approval for another tool or another conversation does not count.
  recordPersonApprovedExternalTool(sessionId, 'mcp__mail__archive');
  recordPersonApprovedExternalTool('other-session', 'mcp__mail__send_reply');
  expect((await call('tools/call', 'send_reply')).status).toBe(403);
});

test("the person's allow and deny apply; a trusted server's results do not mark", async () => {
  const call = await proxy();
  await call('tools/call', 'read_message');
  def = {
    ...def,
    untrustedContentPermissions: {
      tools: { send_reply: 'allow' },
      default: 'deny',
    },
  };
  expect((await call('tools/call', 'send_reply')).status).toBe(200);
  recordPersonApprovedExternalTool(sessionId, 'mcp__mail__archive');
  const denied = await call('tools/call', 'archive');
  expect(denied.status).toBe(403);
  expect(denied.body.error?.message).toMatch(/set to refuse/);

  sessionId = `mediated-session-${++session}`;
  def = {
    ...def,
    contentTrust: 'trusted',
    untrustedContentPermissions: undefined,
  };
  const trusted = await proxy();
  await trusted('tools/call', 'read_message');
  expect(
    await sharedUntrustedContentLedger.conversationHasRead(sessionId),
  ).toBe(false);
  expect((await trusted('tools/call', 'send_reply')).status).toBe(200);
});

test('an engine that asks Station asks the person after untrusted content, even for a granted tool', async () => {
  const evaluate = createStagedPreToolPolicyEvaluator({
    spec: { name: 'Assistant', prompt: '' } as never,
    toolNameMapping: new Map(),
    isGranted: () => true,
    untrustedContentPermission: externalUntrustedContentPermission({
      loadIntegration: async () => def,
    }),
    logger: { warn: vi.fn(), info: vi.fn() },
  });
  const decide = (toolName: string) =>
    evaluate(
      { toolName, toolCallId: 'call-1', toolArgs: {} },
      { agentSlug: 'assistant', conversationId: sessionId },
      { interaction: 'external' },
    );
  expect(await decide('mcp__mail__send_reply')).toMatchObject({
    behavior: 'allow',
  });
  sharedUntrustedContentLedger.markConversation(
    sessionId,
    Promise.resolve(true),
  );
  expect(await decide('mcp__mail__send_reply')).toEqual({
    behavior: 'ask',
    required: true,
  });
  // Not an MCP call: left to the engine's usual policy.
  expect(await decide('Bash')).toMatchObject({ behavior: 'allow' });
});
