/**
 * #3483: every connection Station makes for a catalog-supplied remote MCP
 * server resolves its hostname once, refuses the name when any answer is a
 * private address, and connects only to the answer it checked.
 *
 * A local server stands in for the remote. The stub resolver's loopback
 * answer plays a public address (`isRefusedAddress` refuses only 10/8), so
 * a request that reaches the stand-in proves which address was used.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import type { ResolvedAgentToolServer } from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { createMCPTransport } from '@kontourai/station-shared/mcp';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createEngineOAuthProxyRoutes } from '../../../routes/mcp/engine-oauth-proxy-route.js';
import { createEngineMcpOAuthResolver } from '../engine-mcp-oauth.js';
import { recordIntegrationOrigin } from '../integration-origin.js';
import { installCatalogServerAddressPolicy } from '../remote-mcp-address-policy.js';
import {
  principalCredentialOwner,
  StationToolServerOAuthProvider,
  toolServerCredentialStoreFor,
} from '../tool-server-oauth.js';

const makeTempDir = trackTempDirs();
const PRINCIPAL = 'human:local:operator';

type Answers = readonly { address: string; family: number }[];
const PUBLIC: Answers = [{ address: '127.0.0.1', family: 4 }];
const PRIVATE: Answers = [{ address: '10.1.2.3', family: 4 }];
const scenarios = {
  private: { answers: [PRIVATE], refused: true },
  mixed: { answers: [[...PUBLIC, ...PRIVATE]], refused: true },
  // The second answer would be private; the first checked answer is kept.
  changing: { answers: [PUBLIC, PRIVATE], refused: false },
} as const;

let home: string;
let stand: Server;
let port: number;
let received: IncomingMessage[];
let uninstall: (() => void) | undefined;
let lookups: string[];
let tokenEncoding: string | undefined;

beforeEach(async () => {
  home = makeTempDir('station-catalog-address-');
  // Each stand-in logs to its own list: a late request to an earlier
  // test's server must not count here.
  const log: IncomingMessage[] = [];
  received = log;
  lookups = [];
  tokenEncoding = undefined;
  stand = createServer((request, response) => {
    // Only the paths these tests use: another local process may probe a
    // newly listening loopback port, and that is not a Station request.
    if (request.url === '/mcp' || request.url === '/token') log.push(request);
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.url === '/token') {
        const token = Buffer.from(
          JSON.stringify({
            access_token: 'rotated-secret',
            refresh_token: 'rotated-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
        const encoders = {
          gzip: gzipSync,
          deflate: deflateSync,
          br: brotliCompressSync,
        };
        const encode = encoders[tokenEncoding as keyof typeof encoders];
        response.writeHead(200, {
          'content-type': 'application/json',
          ...(tokenEncoding ? { 'content-encoding': tokenEncoding } : {}),
        });
        response.end(encode ? encode(token) : token);
        return;
      }
      const message = body ? JSON.parse(body) : {};
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }),
      );
    });
  });
  await new Promise<void>((ready) => stand.listen(0, '127.0.0.1', ready));
  port = (stand.address() as AddressInfo).port;
});

afterEach(async () => {
  uninstall?.();
  uninstall = undefined;
  await new Promise((closed) => stand.close(closed));
});

function install(answers: readonly Answers[], env: NodeJS.ProcessEnv = {}) {
  const asked = lookups;
  uninstall = installCatalogServerAddressPolicy(() => home, {
    env,
    resolve: async (hostname) => {
      asked.push(hostname);
      return answers[Math.min(asked.length - 1, answers.length - 1)]!;
    },
    isRefusedAddress: (address) => address.startsWith('10.'),
  });
}

function catalogDef(
  id: string,
  extra: Partial<ToolDef> = {},
  host = 'catalog.test',
): ToolDef {
  const def: ToolDef = {
    id,
    kind: 'mcp',
    transport: 'streamable-http',
    endpoint: `http://${host}:${port}/mcp`,
    ...extra,
  };
  recordIntegrationOrigin(home, def, {
    kind: 'registry',
    registryId: 'mcp-subregistry:station-curated',
  });
  return def;
}

async function send(transport: ReturnType<typeof createMCPTransport>) {
  return transport.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
}

test.each(Object.entries(scenarios))(
  "Station's MCP client transport, %s answers",
  async (_name, scenario) => {
    install(scenario.answers);
    const transport = createMCPTransport(catalogDef('catalog-client'));
    await transport.start();
    try {
      const first = send(transport);
      if (scenario.refused) {
        await expect(first).rejects.toThrow(/private network address/);
        expect(lookups).toEqual(['catalog.test']);
        expect(received).toHaveLength(0);
        return;
      }
      await first;
      await send(transport);
      // The SDK may also open its optional SSE stream; count the posts.
      const posts = received.filter((request) => request.method === 'POST');
      expect(posts).toHaveLength(2);
      expect(
        received.every(
          (request) => request.headers.host === `catalog.test:${port}`,
        ),
      ).toBe(true);
      expect(lookups).toEqual(['catalog.test']);
    } finally {
      await transport.close();
    }
  },
);

test('a server no catalog supplied keeps the platform connection', async () => {
  install([PRIVATE]);
  const transport = createMCPTransport({
    id: 'manual-server',
    kind: 'mcp',
    transport: 'streamable-http',
    endpoint: `http://127.0.0.1:${port}/mcp`,
  });
  await transport.start();
  await send(transport);
  await transport.close();
  expect(lookups).toEqual([]);
  expect(received).toHaveLength(1);
});

test('the default rule refuses a private literal unless the operator opts in', async () => {
  const literal = (id: string) =>
    catalogDef(id, { endpoint: `http://127.0.0.1:${port}/mcp` });
  uninstall = installCatalogServerAddressPolicy(() => home, { env: {} });
  const refused = createMCPTransport(literal('literal-refused'));
  await refused.start();
  await expect(send(refused)).rejects.toThrow(/private network address/);
  await refused.close();
  expect(received).toHaveLength(0);
  uninstall();
  uninstall = installCatalogServerAddressPolicy(() => home, {
    env: { STATION_MCP_SUBREGISTRY_ALLOW_PRIVATE_ADDRESSES: '1' },
  });
  const allowed = createMCPTransport(literal('literal-allowed'));
  await allowed.start();
  await send(allowed);
  await allowed.close();
  expect(received).toHaveLength(1);
});

async function signedInAccount(
  def: ToolDef,
  tokens: { expired: boolean },
): Promise<void> {
  const origin = new URL(def.endpoint!).origin;
  const owner = principalCredentialOwner(PRINCIPAL);
  const provider = new StationToolServerOAuthProvider(
    toolServerCredentialStoreFor(home, owner),
    def.id,
    def.endpoint!,
    'http://127.0.0.1:43143/integrations/x/oauth/callback',
    undefined,
    owner,
  );
  const issuer = { issuer: origin };
  await provider.saveDiscoveryState({
    authorizationServerUrl: origin,
    resourceMetadata: {
      resource: def.endpoint!,
      authorization_servers: [origin],
    },
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
      refresh_token: 'refresh-secret',
      token_type: 'Bearer',
      expires_in: tokens.expired ? -1 : 3600,
      ...issuer,
    },
    issuer,
  );
}

function engineResolver(def: ToolDef) {
  return createEngineMcpOAuthResolver({
    homeDir: () => home,
    port: () => 43143,
    getIntegration: async () => def,
  });
}

const asServer = (def: ToolDef): ResolvedAgentToolServer => ({
  id: def.id,
  transport: 'streamable-http',
  endpoint: def.endpoint!,
});

test.each(Object.entries(scenarios))(
  'the OAuth proxy for external engines, %s answers',
  async (_name, scenario) => {
    const def = catalogDef('catalog-proxy', {
      credentialOwnership: { owner: 'principal' },
    });
    await signedInAccount(def, { expired: false });
    install(scenario.answers);
    const urls = await engineResolver(def)(
      [asServer(def)],
      PRINCIPAL,
      undefined,
      'proxy-session',
    );
    const app = new Hono();
    app.route('', createEngineOAuthProxyRoutes());
    const call = (id: number) =>
      app.request(
        urls.get(def.id)!,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }),
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      );
    const first = await call(1);
    if (scenario.refused) {
      expect(first.status).toBe(502);
      // Refused by the address check, not by an unresolvable name.
      expect(lookups).toEqual(['catalog.test']);
      expect(received).toHaveLength(0);
      return;
    }
    expect(first.status).toBe(200);
    expect((await call(2)).status).toBe(200);
    expect(received).toHaveLength(2);
    expect(received[0]!.headers.authorization).toBe('Bearer remote-secret');
    expect(
      received.every((r) => r.headers.host === `catalog.test:${port}`),
    ).toBe(true);
    expect(lookups).toEqual(['catalog.test']);
  },
);

test.each(Object.entries(scenarios))(
  "Station's token refresh outside a transport, %s answers",
  async (_name, scenario) => {
    // The SDK sends token requests over http only to `*.localhost`; the
    // name still goes through the stub resolver.
    const def = catalogDef(
      'catalog-refresh',
      { credentialOwnership: { owner: 'principal' } },
      'catalog.localhost',
    );
    await signedInAccount(def, { expired: true });
    install(scenario.answers);
    const delivered = engineResolver(def)(
      [asServer(def)],
      PRINCIPAL,
      undefined,
      'refresh-session',
    );
    if (scenario.refused) {
      await expect(delivered).rejects.toThrow();
      expect(lookups).toEqual(['catalog.localhost']);
      expect(received).toHaveLength(0);
      return;
    }
    expect((await delivered).has(def.id)).toBe(true);
    expect(received.map((request) => request.url)).toEqual(['/token']);
    expect(received[0]!.headers.host).toBe(`catalog.localhost:${port}`);
    expect(lookups).toEqual(['catalog.localhost']);
  },
);

test('a catalog server is never handed to an engine to connect directly', async () => {
  const catalog = catalogDef('catalog-direct');
  await expect(
    engineResolver(catalog)([asServer(catalog)], PRINCIPAL, undefined, 's'),
  ).rejects.toThrow(/came from a catalog and can only connect through Station/);
  const manual: ToolDef = {
    id: 'manual-direct',
    kind: 'mcp',
    transport: 'streamable-http',
    endpoint: `http://catalog.test:${port}/mcp`,
  };
  expect(
    (
      await engineResolver(manual)(
        [asServer(manual)],
        PRINCIPAL,
        undefined,
        's',
      )
    ).size,
  ).toBe(0);
});

test.each(['gzip', 'deflate', 'br'])(
  'catalog token refresh decodes %s without resolving again',
  async (encoding) => {
    tokenEncoding = encoding;
    const def = catalogDef(
      'compressed-refresh',
      { credentialOwnership: { owner: 'principal' } },
      'catalog.localhost',
    );
    await signedInAccount(def, { expired: true });
    install([PUBLIC, PRIVATE]);
    const urls = await engineResolver(def)(
      [asServer(def)],
      PRINCIPAL,
      undefined,
      'compressed-refresh-session',
    );
    expect(urls.has(def.id)).toBe(true);
    expect(received.map((request) => request.url)).toEqual(['/token']);
    expect(received[0]!.headers.host).toBe(`catalog.localhost:${port}`);
    expect(lookups).toEqual(['catalog.localhost']);
  },
);
