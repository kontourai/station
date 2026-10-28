import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import curated from '../curated/station-mcp-subregistry.json' with {
  type: 'json',
};
import {
  MCP_SUBREGISTRY_LIMITS,
  McpSubregistrySource,
  parseMcpSubregistryPage,
  STATION_CURATION_META_KEY,
} from '../mcp-subregistry.js';
import {
  McpSubregistryIntegrationProvider,
  mcpSubregistryIntegrationProviders,
  UNAVAILABLE,
} from '../mcp-subregistry-provider.js';

const SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const URL_BASE = 'https://subregistry.example.test/v0.1/servers';

function entry(name: string, overrides: Record<string, unknown> = {}) {
  return {
    server: {
      $schema: SCHEMA,
      name,
      description: `${name} description`,
      version: '1.0.0',
      remotes: [
        { type: 'streamable-http', url: `https://${name.split('/')[0]}/mcp` },
      ],
      ...overrides,
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: 'active',
        isLatest: true,
      },
    },
  };
}

function page(servers: unknown[], nextCursor?: string) {
  return JSON.stringify({
    servers,
    metadata: { count: servers.length, ...(nextCursor ? { nextCursor } : {}) },
  });
}

/** A body with no content-length, so only the streamed count can refuse it. */
function streamed(body: string, status = 200) {
  const bytes = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 1024)
          controller.enqueue(bytes.slice(at, at + 1024));
        controller.close();
      },
    }),
    { status },
  );
}

const makeTempDir = trackTempDirs();
const cacheDir = () => makeTempDir('mcp-subregistry-');

function source(
  fetchImpl: typeof fetch,
  options: Partial<ConstructorParameters<typeof McpSubregistrySource>[0]> = {},
) {
  return new McpSubregistrySource({
    id: 'configured',
    displayName: 'Configured',
    origin: 'configured',
    url: URL_BASE,
    cacheDir: cacheDir(),
    fetch: fetchImpl,
    ...options,
  });
}

describe('MCP subregistry bounds', () => {
  test('pins the shipped limits', () => {
    expect(MCP_SUBREGISTRY_LIMITS).toMatchObject({
      maxBytes: 1024 * 1024,
      maxPages: 10,
      maxServers: 500,
    });
  });

  test('accepts a page at the byte bound and refuses one byte more', async () => {
    const body = page([entry('com.example/a')]);
    const exact = source(async () => streamed(body), {
      limits: { maxBytes: Buffer.byteLength(body) },
    });
    await exact.refresh();
    expect(exact.status()).toMatchObject({ lastError: null, serverCount: 1 });

    const over = source(async () => streamed(body), {
      limits: { maxBytes: Buffer.byteLength(body) - 1 },
    });
    await over.refresh();
    expect(over.status().lastError).toBe(
      `The subregistry page is larger than ${Buffer.byteLength(body) - 1} bytes.`,
    );
    expect(over.servers()).toEqual([]);
  });

  test('refuses a declared oversize page before reading it', async () => {
    let read = false;
    const response = new Response(
      new ReadableStream(
        {
          pull() {
            read = true;
          },
        },
        // Pulled only by a read, not when the response is built.
        { highWaterMark: 0 },
      ),
      { headers: { 'content-length': '2048' } },
    );
    const refused = source(async () => response, {
      limits: { maxBytes: 2047 },
    });
    await refused.refresh();
    expect(refused.status().lastError).toBe(
      'The subregistry page is larger than 2047 bytes.',
    );
    expect(read).toBe(false);
  });

  test('accepts the server bound and refuses the whole index at one more', async () => {
    const servers = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        entry(`com.example/s${index}`),
      );
    const exact = source(async () => streamed(page(servers(3))), {
      limits: { maxServers: 3 },
    });
    await exact.refresh();
    expect(exact.status()).toMatchObject({ lastError: null, serverCount: 3 });

    const over = source(async () => streamed(page(servers(4))), {
      limits: { maxServers: 3 },
    });
    await over.refresh();
    expect(over.status().lastError).toBe(
      'The subregistry lists more than 3 servers.',
    );
    expect(over.servers()).toEqual([]);
  });

  test('counts servers across pages and refuses past the page bound', async () => {
    const twoPages = source(
      async (input) =>
        streamed(
          new URL(String(input)).searchParams.get('cursor') === 'p2'
            ? page([entry('com.example/b'), entry('com.example/c')])
            : page([entry('com.example/a')], 'p2'),
        ),
      { limits: { maxServers: 2 } },
    );
    await twoPages.refresh();
    expect(twoPages.status().lastError).toBe(
      'The subregistry lists more than 2 servers.',
    );

    let calls = 0;
    const endless = source(
      async () => {
        calls += 1;
        return streamed(page([entry(`com.example/p${calls}`)], `c${calls}`));
      },
      { limits: { maxPages: 2 } },
    );
    await endless.refresh();
    expect(endless.status().lastError).toBe(
      'The subregistry has more than 2 pages.',
    );
    expect(calls).toBe(2);
  });
});

describe('MCP subregistry parsing', () => {
  test('refuses a document that is not a server list', () => {
    expect(
      parseMcpSubregistryPage('{"items":[]}', {
        maxServers: 5,
        trustCuration: false,
      }),
    ).toEqual({
      ok: false,
      reason: 'The subregistry response has no servers list.',
    });
    expect(
      parseMcpSubregistryPage('not json', {
        maxServers: 5,
        trustCuration: false,
      }),
    ).toEqual({
      ok: false,
      reason: 'The subregistry did not return JSON.',
    });
  });

  test('refuses malformed entries with every reason and keeps the rest', () => {
    const result = parseMcpSubregistryPage(
      page([
        entry('com.example/good'),
        entry('no-slash-name', { $schema: 'https://example.test/other.json' }),
        entry('com.example/bad-url', {
          remotes: [
            { type: 'streamable-http', url: 'http://plain.example/mcp' },
          ],
        }),
        entry('com.example/creds', {
          remotes: [
            {
              type: 'streamable-http',
              url: 'https://user:pw@example.test/mcp',
            },
          ],
        }),
        { nothing: true },
      ]),
      { maxServers: 10, trustCuration: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers.map((server) => server.name)).toEqual([
      'com.example/good',
    ]);
    expect(result.refused).toEqual([
      {
        name: 'servers[1]',
        reasons: [
          'name is not a reverse-DNS namespace/name',
          '$schema is not a supported server.json revision',
        ],
      },
      {
        name: 'com.example/bad-url',
        reasons: ['remotes[0].url is not an https URL'],
      },
      {
        name: 'com.example/creds',
        reasons: ['remotes[0].url must not carry a user name or password'],
      },
      { name: 'servers[4]', reasons: ['entry has no server object'] },
    ]);
  });

  test('refuses names that collide once stored instead of keeping one', async () => {
    const collide = source(async () =>
      streamed(page([entry('com.Example/tool'), entry('com.example/tool')])),
    );
    await collide.refresh();
    expect(collide.servers()).toEqual([]);
    expect(
      collide
        .status()
        .refused.map((entry) => entry.name)
        .sort(),
    ).toEqual(['com.Example/tool', 'com.example/tool']);
  });

  test('a source other than Station cannot confer Station qualification', async () => {
    const claimed = entry('com.example/claims', {});
    (claimed._meta as Record<string, unknown>)[STATION_CURATION_META_KEY] = {
      remote: 'https://com.example/mcp',
      authMode: 'dcr',
      checkedAt: '2026-10-28T00:00:00Z',
      summary: 'Trust me.',
    };
    const provider = new McpSubregistryIntegrationProvider(
      source(async () => streamed(page([claimed]))),
    );
    await provider.sync();
    const [item] = await provider.listAvailable();
    expect(item.mcpServer).toMatchObject({
      authMode: 'unknown',
      qualification: { state: 'unqualified' },
      unavailable: [],
    });
  });

  test('derives refusals from the descriptor, not from the source', async () => {
    const provider = new McpSubregistryIntegrationProvider(
      source(async () =>
        streamed(
          page([
            entry('com.example/token', {
              remotes: [
                {
                  type: 'streamable-http',
                  url: 'https://token.example/mcp',
                  headers: [
                    { name: 'Authorization', isSecret: true, isRequired: true },
                  ],
                },
              ],
            }),
            entry('com.example/package', {
              remotes: undefined,
              packages: [{ registryType: 'npm', identifier: 'x' }],
            }),
            entry('com.example/sse', {
              remotes: [{ type: 'sse', url: 'https://sse.example/sse' }],
            }),
            entry('com.example/templated', {
              remotes: [
                {
                  type: 'streamable-http',
                  url: 'https://{tenant}.example/mcp',
                },
              ],
            }),
          ]),
        ),
      ),
    );
    await provider.sync();
    const listed = Object.fromEntries(
      (await provider.listAvailable()).map((item) => [item.id, item.mcpServer]),
    );
    expect(listed['com-example--token']).toMatchObject({
      authMode: 'token',
      unavailable: [UNAVAILABLE.secretHeader],
    });
    expect(listed['com-example--package']?.unavailable).toEqual([
      UNAVAILABLE.packagesOnly,
    ]);
    expect(listed['com-example--sse']?.unavailable).toEqual([
      UNAVAILABLE.sseOnly,
    ]);
    expect(listed['com-example--templated']?.unavailable).toEqual([
      UNAVAILABLE.variables,
    ]);
    expect(await provider.install('com-example--token')).toEqual({
      success: false,
      message: UNAVAILABLE.secretHeader,
    });
    expect(await provider.getToolDef('com-example--token')).toBeNull();
  });
});

describe('MCP subregistry offline copy', () => {
  test('serves the saved copy as stale when the network fails, and refuses Add', async () => {
    const dir = cacheDir();
    const online = new McpSubregistryIntegrationProvider(
      source(async () => streamed(page([entry('com.example/a')])), {
        cacheDir: dir,
      }),
    );
    await online.sync();
    const [fresh] = await online.listAvailable();
    expect(fresh.catalogFreshness).toBeUndefined();
    expect(online.status().freshness).toBe('live');
    expect(await online.install('com-example--a')).toMatchObject({
      success: true,
    });

    const offlineSource = source(
      async () => {
        throw new TypeError('fetch failed');
      },
      { cacheDir: dir },
    );
    const offline = new McpSubregistryIntegrationProvider(offlineSource);
    await offline.sync();
    expect(offline.status()).toMatchObject({
      freshness: 'stale',
      lastError: 'The subregistry could not be reached.',
      serverCount: 1,
    });
    const [stale] = await offline.listAvailable();
    expect(stale).toMatchObject({
      id: 'com-example--a',
      catalogFreshness: 'stale',
      mcpServer: { unavailable: [UNAVAILABLE.stale] },
    });
    expect(await offline.install('com-example--a')).toEqual({
      success: false,
      message: UNAVAILABLE.stale,
    });
  });

  test('a failed refresh after a live read marks the kept listing stale', async () => {
    let online = true;
    const provider = new McpSubregistryIntegrationProvider(
      source(
        async () => {
          if (!online) throw new TypeError('fetch failed');
          return streamed(page([entry('com.example/a')]));
        },
        { limits: { minRefreshIntervalMs: 0 } },
      ),
    );
    await provider.sync();
    online = false;
    await provider.sync();
    expect(provider.status().freshness).toBe('stale');
    expect((await provider.listAvailable())[0].catalogFreshness).toBe('stale');
  });

  test('no saved copy and no network reports the error with nothing listed', async () => {
    const provider = new McpSubregistryIntegrationProvider(
      source(async () => streamed('{}', 503)),
    );
    await provider.sync();
    expect(provider.status()).toMatchObject({
      freshness: 'none',
      lastError: 'The subregistry answered with HTTP status 503.',
    });
    expect(await provider.listAvailable()).toEqual([]);
  });
});

describe('Station curated MCP subregistry', () => {
  const provider = (preRegisteredClients = false) => {
    const [curatedProvider] = mcpSubregistryIntegrationProviders(
      cacheDir(),
      {},
      () => preRegisteredClients,
    );
    return curatedProvider;
  };

  test('registering pre-registered client support makes blocked entries addable without editing the data', async () => {
    const listed = Object.fromEntries(
      (await provider(true).listAvailable()).map((item) => [
        item.mcpServer!.name,
        item.mcpServer!,
      ]),
    );
    for (const name of [
      'io.github.github/github-mcp-server',
      'ai.kontour.station/gmail',
    ])
      expect(listed[name]).toMatchObject({
        authMode: 'pre-registered-required',
        qualification: { state: 'setup-required' },
        unavailable: [],
      });
    expect(listed['app.linear/linear'].qualification.state).toBe('qualified');
    expect(
      await provider(true).getToolDef('ai-kontour-station--gmail'),
    ).toMatchObject({
      endpoint: 'https://gmailmcp.googleapis.com/mcp/v1',
      contentTrust: 'untrusted',
    });
  });

  test('the capability is read from the host registration at listing time', async () => {
    const { registerToolServerOAuthCapability } = await import(
      '../../../services/plugins/tool-server-oauth-capabilities.js'
    );
    const [hostDefault] = mcpSubregistryIntegrationProviders(cacheDir(), {});
    const github = async () =>
      (await hostDefault.listAvailable()).find(
        (item) => item.id === 'io-github-github--github-mcp-server',
      )!.mcpServer!;
    expect((await github()).unavailable).toEqual([UNAVAILABLE.preRegistered]);
    registerToolServerOAuthCapability('pre-registered-clients');
    expect((await github()).unavailable).toEqual([]);
  });

  test('every bundled entry parses and nothing is refused', async () => {
    const curatedProvider = provider();
    await curatedProvider.listAvailable();
    expect(curatedProvider.status()).toMatchObject({
      origin: 'station',
      freshness: 'bundled',
      lastError: null,
      refused: [],
      serverCount: curated.servers.length,
    });
  });

  test('records auth mode and qualification per entry', async () => {
    const listed = Object.fromEntries(
      (await provider().listAvailable()).map((item) => [
        item.mcpServer!.name,
        {
          authMode: item.mcpServer!.authMode,
          state: item.mcpServer!.qualification.state,
          unavailable: item.mcpServer!.unavailable,
        },
      ]),
    );
    expect(listed).toEqual({
      'app.linear/linear': {
        authMode: 'dcr',
        state: 'qualified',
        unavailable: [],
      },
      'com.notion/mcp': {
        authMode: 'dcr',
        state: 'qualified',
        unavailable: [],
      },
      'com.atlassian/atlassian-mcp-server': {
        authMode: 'dcr',
        state: 'qualified',
        unavailable: [],
      },
      'io.github.github/github-mcp-server': {
        authMode: 'pre-registered-required',
        state: 'blocked',
        unavailable: [UNAVAILABLE.preRegistered],
      },
      'ai.kontour.station/gmail': {
        authMode: 'pre-registered-required',
        state: 'blocked',
        unavailable: [UNAVAILABLE.preRegistered],
      },
    });
  });

  test('every curated id fits the stored tool id grammar', async () => {
    // schemas/tool.schema.json `id.pattern`; ConfigLoader refuses anything else.
    for (const item of await provider().listAvailable())
      expect(item.id).toMatch(/^[a-z0-9-]+$/);
  });

  test('a qualified entry becomes a principal-owned remote tool server', async () => {
    expect(await provider().getToolDef('app-linear--linear')).toEqual({
      id: 'app-linear--linear',
      kind: 'mcp',
      displayName: 'Linear',
      description:
        'Find and manage issues, projects, and documents in your Linear workspace.',
      transport: 'streamable-http',
      endpoint: 'https://mcp.linear.app/mcp',
      credentialOwnership: { owner: 'principal' },
      timeouts: { startupMs: 15_000, requestMs: 60_000 },
    });
  });

  test('the curated source can be withdrawn and a bad configured URL is visible', () => {
    expect(
      mcpSubregistryIntegrationProviders(cacheDir(), {
        STATION_MCP_CURATED_REGISTRY: 'off',
      }),
    ).toEqual([]);
    const [, configured] = mcpSubregistryIntegrationProviders(cacheDir(), {
      STATION_MCP_SUBREGISTRY_URL: 'http://plain.example/v0.1/servers',
    });
    expect(configured.status()).toMatchObject({
      origin: 'configured',
      freshness: 'none',
      lastError: 'STATION_MCP_SUBREGISTRY_URL is not an https URL',
    });
  });
});

describe('untrusted-content classification from curation', () => {
  test('is a default carried into the stored definition, not a refusal', async () => {
    const mail = entry('com.example/mail');
    (mail._meta as Record<string, unknown>)[STATION_CURATION_META_KEY] = {
      remote: 'https://com.example/mcp',
      authMode: 'dcr',
      contentTrust: 'untrusted',
      trustReadOnlyHints: true,
      checkedAt: '2026-10-28T00:00:00Z',
      summary: 'Checked.',
    };
    const provider = new McpSubregistryIntegrationProvider(
      new McpSubregistrySource({
        id: 'station-curated',
        displayName: 'Station curated',
        origin: 'station',
        bundled: [page([mail])],
      }),
    );
    const [item] = await provider.listAvailable();
    expect(item.mcpServer).toMatchObject({
      contentTrust: 'untrusted',
      qualification: { state: 'qualified' },
      unavailable: [],
    });
    expect(await provider.getToolDef('com-example--mail')).toMatchObject({
      contentTrust: 'untrusted',
      trustReadOnlyHints: true,
    });
  });
});

describe('subregistry endpoint address policy', () => {
  const remotes = {
    loopback4: 'https://127.0.0.1/mcp',
    loopback6: 'https://[::1]/mcp',
    mapped: 'https://[::ffff:7f00:1]/mcp',
    privateNet: 'https://10.0.0.5/mcp',
    linkLocal: 'https://169.254.169.254/mcp',
    ula: 'https://[fd00::1]/mcp',
    localhost: 'https://localhost:8443/mcp',
    mdns: 'https://printer.local/mcp',
    decimal: 'https://2130706433/mcp',
    localhostRootDot: 'https://localhost./mcp',
    mdnsRootDot: 'https://printer.local./mcp',
    ipRootDot: 'https://127.0.0.1./mcp',
    subLocalhostDots: 'https://app.localhost../mcp',
    public: 'https://mcp.example.com/mcp',
  };
  const listing = async (allowPrivateAddresses: boolean) => {
    const provider = new McpSubregistryIntegrationProvider(
      source(async () =>
        streamed(
          page(
            Object.entries(remotes).map(([name, url]) =>
              entry(`com.example/${name}`, {
                remotes: [{ type: 'streamable-http', url }],
              }),
            ),
          ),
        ),
      ),
      () => ({ preRegisteredClients: false, allowPrivateAddresses }),
    );
    await provider.sync();
    return {
      provider,
      byName: Object.fromEntries(
        (await provider.listAvailable()).map((item) => [
          item.mcpServer!.name.split('/')[1],
          item.mcpServer!.unavailable,
        ]),
      ),
    };
  };

  test('refuses local and private network endpoints from a catalog by default', async () => {
    const { provider, byName } = await listing(false);
    for (const name of Object.keys(remotes).filter((name) => name !== 'public'))
      expect(byName[name], name).toEqual([UNAVAILABLE.privateAddress]);
    expect(byName.public).toEqual([]);
    expect(await provider.install('com-example--loopback4')).toEqual({
      success: false,
      message: UNAVAILABLE.privateAddress,
    });
    expect(await provider.getToolDef('com-example--loopback4')).toBeNull();
  });

  test('the operator opt-in allows them', async () => {
    const { byName } = await listing(true);
    for (const reasons of Object.values(byName)) expect(reasons).toEqual([]);
    const [, configured] = mcpSubregistryIntegrationProviders(
      cacheDir(),
      {
        STATION_MCP_SUBREGISTRY_URL: URL_BASE,
        STATION_MCP_SUBREGISTRY_ALLOW_PRIVATE_ADDRESSES: '1',
      },
      () => false,
    );
    expect(configured).toBeDefined();
  });
});

describe('subregistry refresh edge cases', () => {
  test('a source that does not answer in time is refused with the timeout', async () => {
    const hanging = source(
      (_input, init) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
      { limits: { fetchTimeoutMs: 1000 } },
    );
    await hanging.refresh();
    expect(hanging.status()).toMatchObject({
      freshness: 'none',
      lastError: 'The subregistry did not answer within 1 seconds.',
    });
  });

  test('an empty page that names a next page is followed, not taken as the end', async () => {
    const pages = source(async (input) => {
      const cursor = new URL(String(input)).searchParams.get('cursor');
      return streamed(
        cursor === 'p2' ? page([entry('com.example/later')]) : page([], 'p2'),
      );
    });
    await pages.refresh();
    expect(pages.status()).toMatchObject({
      lastError: null,
      freshness: 'live',
    });
    expect(pages.servers().map((server) => server.name)).toEqual([
      'com.example/later',
    ]);
  });

  test('endless empty pages are refused at the page bound', async () => {
    let calls = 0;
    const endless = source(
      async () => {
        calls += 1;
        return streamed(page([], `c${calls}`));
      },
      { limits: { maxPages: 3 } },
    );
    await endless.refresh();
    expect(endless.status()).toMatchObject({
      freshness: 'none',
      lastError: 'The subregistry has more than 3 pages.',
    });
    expect(calls).toBe(3);
  });

  test('a repeated cursor is refused', async () => {
    const looping = source(async () =>
      streamed(page([entry('com.example/a')], 'same')),
    );
    await looping.refresh();
    expect(looping.status().lastError).toBe(
      'The subregistry repeated a page cursor.',
    );
  });
});
