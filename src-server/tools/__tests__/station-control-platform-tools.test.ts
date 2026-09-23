import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  registerPluginValidateRoutes,
  validatePluginSource,
} from '../../routes/plugins/plugin-validate-routes.js';

/**
 * archive#167 Wave 3: characterization tests for `station-control-platform-tools.ts`'s
 * audited operations (`list_integrations`, `get_integration`,
 * `create_integration`, `delete_integration`, `list_registry_integrations`,
 * `install_registry_integration`), written *before* the migration to
 * `@kontourai/station-sdk/client` and run green against the pre-refactor
 * `api()`-based implementation first, then re-run unmodified after the
 * migration. See `station-control-operations-tools.test.ts`'s docblock for
 * the shared "real McpServer + direct `.handler` invocation + mocked global
 * `fetch`" pattern this file also uses.
 */

process.env.STATION_API_BASE = 'http://control-platform-test.local';
delete process.env.STATION_PORT;

const API_BASE = 'http://control-platform-test.local';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (...args: any[]) => Promise<ToolResult>;

async function registerTools(): Promise<Record<string, ToolHandler>> {
  const { registerPlatformTools } = await import(
    '../station-control-platform-tools.js'
  );
  const { StationControlToolRegistry } = await import(
    '../station-control-mcp-server.js'
  );
  const server = new McpServer({
    name: 'platform-tools-characterization',
    version: '0.0.0',
  });
  registerPlatformTools(new StationControlToolRegistry(server));
  const registry = (
    server as unknown as {
      _registeredTools: Record<string, { handler: ToolHandler }>;
    }
  )._registeredTools;
  const handlers: Record<string, ToolHandler> = {};
  for (const [name, tool] of Object.entries(registry)) {
    handlers[name] = tool.handler;
  }
  return handlers;
}

describe('station-control platform tools (characterization)', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('list_plugins shares the canonical SDK collection route and preserves its envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ plugins: [{ name: 'demo', version: '1.0.0' }] }),
    );
    const tools = await registerTools();

    const result = await tools.list_plugins();

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { plugins: [{ name: 'demo', version: '1.0.0' }] },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/plugins`);
  });

  test('list_plugins preserves the grants-unavailable envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: 'Plugin grants are temporarily unavailable',
          grantsUnavailable: true,
        },
        503,
      ),
    );
    const tools = await registerTools();

    await expect(tools.list_plugins()).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: 'Plugin grants are temporarily unavailable',
              grantsUnavailable: true,
            },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('list_integrations forwards the raw integrations envelope on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [{ id: 'station-control', transport: 'stdio' }],
      }),
    );
    const tools = await registerTools();

    const result = await tools.list_integrations();

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              data: [{ id: 'station-control', transport: 'stdio' }],
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/integrations`);
  });

  test('list_integrations forwards the error envelope on failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'listing failed' }, 500),
    );
    const tools = await registerTools();

    const result = await tools.list_integrations();

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: false, error: 'listing failed' },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('get_integration forwards the single-integration envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { id: 'station-control', transport: 'stdio' },
      }),
    );
    const tools = await registerTools();

    const result = await tools.get_integration({ id: 'station-control' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              data: { id: 'station-control', transport: 'stdio' },
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/integrations/station-control`,
    );
  });

  test('get_integration forwards the not-found envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'Integration not found' }, 404),
    );
    const tools = await registerTools();

    const result = await tools.get_integration({ id: 'missing' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: false, error: 'Integration not found' },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('create_integration posts the payload with kind:mcp and forwards the created envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }, 201));
    const tools = await registerTools();

    const result = await tools.create_integration({
      id: 'demo-server',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    });

    expect(result).toEqual({
      content: [
        { type: 'text', text: JSON.stringify({ success: true }, null, 2) },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/integrations`);
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          id: 'demo-server',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          kind: 'mcp',
        }),
      }),
    );
  });

  test('create_integration forwards the error envelope when creation fails', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'id already exists' }, 400),
    );
    const tools = await registerTools();

    const result = await tools.create_integration({
      id: 'demo-server',
      transport: 'stdio',
    });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: false, error: 'id already exists' },
            null,
            2,
          ),
        },
      ],
    });
  });

  test('delete_integration issues the DELETE request and forwards the bare-success envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    const tools = await registerTools();

    const result = await tools.delete_integration({ id: 'demo-server' });

    expect(result).toEqual({
      content: [
        { type: 'text', text: JSON.stringify({ success: true }, null, 2) },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/integrations/demo-server`,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test('list_registry_integrations forwards the raw registry catalog envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [{ id: 'github', name: 'GitHub' }] }),
    );
    const tools = await registerTools();

    const result = await tools.list_registry_integrations();

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, data: [{ id: 'github', name: 'GitHub' }] },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/registry/integrations`,
    );
  });

  test('install_registry_integration posts the id and forwards the install-result envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, message: 'Installed' }),
    );
    const tools = await registerTools();

    const result = await tools.install_registry_integration({ id: 'github' });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { success: true, message: 'Installed' },
            null,
            2,
          ),
        },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_BASE}/api/registry/integrations/install`,
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ id: 'github' }),
      }),
    );
  });

  /**
   * archive#4288. `install_plugin` used to POST `{ source }` to
   * `/api/plugins/install`, which now refuses without an operator's decision —
   * so the tool could never succeed while its description still advertised
   * installing. It does not call the route at all now, and says why.
   *
   * The alternative — preview, read back the digest and permissions, echo them
   * into the install — was rejected deliberately: it would record an operator
   * decision that no operator made. There is no person in this tool's loop to
   * make one.
   */
  test('install_plugin does not install, and names where the approval is taken', async () => {
    const tools = await registerTools();

    const result = await tools.install_plugin({ source: '/tmp/demo-plugin' });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.installed).toBe(false);
    expect(payload.reason).toBe('operator-approval-required');
    // #2323 S5: it names the tool that can act, which proposes.
    expect(payload.message).toContain('propose_plugin_install');
    // The route is never reached: nothing to refuse, nothing to roll back.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * #2323 S5. The three proposing tools make exactly one request, to the
   * proposal route, and none to a plugin lifecycle route. Driven end to end
   * through the real auth boundary, so the proposal's `principal: 'agent'`
   * is what the boundary derived from station-control's own headers.
   */
  describe('proposing tools (#2323 S5)', () => {
    async function withProposalServer(
      run: (ctx: {
        root: string;
        pluginsDir: string;
        proposals: import('../../services/plugins/plugin-lifecycle-proposals.js').PluginLifecycleProposalService;
      }) => Promise<void>,
    ) {
      const root = mkdtempSync(join(tmpdir(), 'station-s5-propose-tool-'));
      try {
        const home = join(root, 'home');
        const pluginsDir = join(home, 'plugins');
        mkdirSync(join(pluginsDir, 'installed-plugin'), { recursive: true });
        writeFileSync(
          join(pluginsDir, 'installed-plugin', 'plugin.json'),
          JSON.stringify({ name: 'installed-plugin', version: '1.0.0' }),
        );
        const { configureRuntimeHttp } = await import(
          '../../runtime/bootstrap/runtime-http.js'
        );
        const { PluginLifecycleProposalService } = await import(
          '../../services/plugins/plugin-lifecycle-proposals.js'
        );
        const { createPluginProposalRoutes } = await import(
          '../../routes/plugins/plugin-proposal-routes.js'
        );
        const { LOCAL_OPERATOR_PRINCIPAL_ID } = await import(
          '../../services/identity/principal-resolver.js'
        );
        const noop = () => {};
        const logger = {
          info: noop,
          warn: noop,
          error: noop,
          debug: noop,
          trace: noop,
          fatal: noop,
          child() {
            return this;
          },
          setLevel: noop,
          getLevel: () => 'info' as const,
        };
        const app = new Hono();
        configureRuntimeHttp({
          app: app as never,
          logger,
          eventBus: { emit: noop },
          security: {
            verifyCredential: () => false,
            resolveGrantedScope: () => undefined,
            allowedOrigins: [],
          },
        } as never);
        const proposals = new PluginLifecycleProposalService(home);
        // A request to any other route (a lifecycle route, say) answers in
        // JSON, so a tool that reached one fails on WHICH path it asked for,
        // not on a parse error.
        app.notFound((c) =>
          c.json({ success: false, error: 'not mounted in this test' }, 404),
        );
        app.route(
          '/api/plugin-proposals',
          createPluginProposalRoutes({
            proposals,
            pluginsDir,
            logger,
            // station-control's internal caller resolves as the operator,
            // and is still answered as an agent (delta review HIGH).
            resolvePrincipal: () => ({
              id: LOCAL_OPERATOR_PRINCIPAL_ID,
              kind: 'human',
              display: 'Operator',
            }),
          }),
        );
        fetchMock.mockImplementation(async (input, init) => {
          const url = new URL(String(input));
          expect(url.origin).toBe(API_BASE);
          return app.request(
            `${url.pathname}${url.search}`,
            init as RequestInit,
            {
              incoming: { socket: { remoteAddress: '127.0.0.1' } },
            } as never,
          );
        });
        await run({ root, pluginsDir, proposals });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    const requestedPaths = () =>
      fetchMock.mock.calls.map(([input, init]) => [
        (init as RequestInit | undefined)?.method ?? 'GET',
        new URL(String(input)).pathname,
      ]);

    test('propose_plugin_install records an install proposal and installs nothing', async () => {
      await withProposalServer(async ({ root, proposals }) => {
        const source = join(root, 'my-pulse');
        mkdirSync(source);
        writeFileSync(
          join(source, 'plugin.json'),
          JSON.stringify({ name: 'my-pulse', version: '1.0.0' }),
        );
        const tools = await registerTools();

        const result = await tools.propose_plugin_install({
          source: `  ${source} `,
          rationale: 'Adds the pulse pane you asked for.',
          _sourceContext: { agentSlug: 'station', conversationId: 'conv-9' },
        });

        const payload = JSON.parse(result.content[0].text);
        expect(requestedPaths()).toEqual([['POST', '/api/plugin-proposals']]);
        // The agent is answered with the id and status alone (delta review
        // HIGH); what was recorded is read from the store.
        expect(payload).toMatchObject({
          installed: false,
          success: true,
          deduplicated: false,
        });
        expect(payload.proposal).toStrictEqual({
          id: expect.any(String),
          status: 'open',
        });
        expect(proposals.get(payload.proposal.id)).toMatchObject({
          kind: 'install',
          source,
          status: 'open',
          author: {
            principal: 'agent',
            agentSlug: 'station',
            conversationId: 'conv-9',
          },
        });
        expect(payload.message).toMatch(/nothing was changed/);
        expect(proposals.listOpen()).toHaveLength(1);

        // Asking twice is one ask.
        const again = JSON.parse(
          (
            await tools.propose_plugin_install({
              source,
              rationale: 'Again.',
            })
          ).content[0].text,
        );
        expect(again.deduplicated).toBe(true);
        expect(proposals.listOpen()).toHaveLength(1);
      });
    });

    test('update_plugin and remove_plugin record proposals and call no lifecycle route', async () => {
      await withProposalServer(async ({ proposals }) => {
        const tools = await registerTools();

        const update = JSON.parse(
          (
            await tools.update_plugin({
              name: 'installed-plugin',
              rationale: 'v2 fixes the crash.',
            })
          ).content[0].text,
        );
        const remove = JSON.parse(
          (await tools.remove_plugin({ name: 'installed-plugin' })).content[0]
            .text,
        );

        expect(requestedPaths()).toEqual([
          ['POST', '/api/plugin-proposals'],
          ['POST', '/api/plugin-proposals'],
        ]);
        expect(update).toMatchObject({ updated: false, success: true });
        expect(remove).toMatchObject({ removed: false, success: true });
        expect(proposals.get(update.proposal.id)).toMatchObject({
          kind: 'update',
          pluginName: 'installed-plugin',
        });
        expect(proposals.get(remove.proposal.id)).toMatchObject({
          kind: 'remove',
          pluginName: 'installed-plugin',
          rationale: 'An agent asked to remove this plugin.',
        });
        expect(
          proposals
            .listOpen()
            .map((entry) => entry.kind)
            .sort(),
        ).toEqual(['remove', 'update']);
      });
    });

    test('a proposal for a plugin that is not installed relays the route refusal', async () => {
      await withProposalServer(async ({ proposals }) => {
        const tools = await registerTools();
        const payload = JSON.parse(
          (await tools.remove_plugin({ name: 'not-installed' })).content[0]
            .text,
        );
        expect(payload).toMatchObject({
          removed: false,
          success: false,
          code: 'plugin-not-installed',
        });
        expect(proposals.listOpen()).toEqual([]);
      });
    });
  });

  /**
   * #2323 S1. The tool is driven end to end: its handler, the station-control
   * HTTP client, and the real `/api/plugins/validate` route mounted where
   * `plugins.ts` mounts it. Only the network hop is replaced, by handing the
   * request to that Hono app.
   */
  test('validate_plugin refuses a remote, network or relative source with the route’s own result, making no request', async () => {
    const tools = await registerTools();
    const root = mkdtempSync(join(tmpdir(), 'station-validate-refuse-'));
    try {
      const home = join(root, 'home');
      mkdirSync(join(home, 'plugins'), { recursive: true });
      const deps = {
        agentsDir: join(home, 'agents'),
        logger: { debug() {}, error() {}, info() {}, warn() {} } as any,
        pluginsDir: join(home, 'plugins'),
        projectHomeDir: home,
      };
      for (const [source, code] of [
        ['https://example.invalid/owner/plugin.git', 'remote-source-refused'],
        ['git@example.invalid:owner/plugin.git', 'remote-source-refused'],
        ['\\\\attacker\\share\\plugin', 'network-path-refused'],
        ['/net/attacker/plugin', 'network-path-refused'],
        ['./my-plugin', 'source-not-absolute'],
      ] as const) {
        const payload = JSON.parse(
          (await tools.validate_plugin({ source })).content[0].text,
        );
        // Same codes and the same shape as the route, not a tool dialect.
        expect(payload, source).toEqual(
          await validatePluginSource(source, deps),
        );
        expect(payload.diagnostics, source).toEqual([
          expect.objectContaining({ code }),
        ]);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('validate_plugin trims a padded source, answering exactly as the HTTP route does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-validate-trim-'));
    try {
      const home = join(root, 'home');
      mkdirSync(join(home, 'plugins'), { recursive: true });
      const plugins = new Hono();
      registerPluginValidateRoutes(plugins, {
        agentsDir: join(home, 'agents'),
        logger: { debug() {}, error() {}, info() {}, warn() {} } as any,
        pluginsDir: join(home, 'plugins'),
        projectHomeDir: home,
      });
      const app = new Hono().route('/api/plugins', plugins);
      const tools = await registerTools();
      for (const source of [
        '  https://example.invalid/owner/plugin.git  ',
        '\t/net/attacker/plugin\n',
        '  ./my-plugin ',
      ]) {
        const viaTool = JSON.parse(
          (await tools.validate_plugin({ source })).content[0].text,
        );
        const viaRoute = await (
          await app.request('/api/plugins/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source }),
          })
        ).json();
        expect(viaTool, JSON.stringify(source)).toEqual(viaRoute);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('validate_plugin reaches the validate route and relays its diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-validate-tool-'));
    try {
      const home = join(root, 'home');
      const pluginsDir = join(home, 'plugins');
      mkdirSync(pluginsDir, { recursive: true });
      const source = join(root, 'author', 'tool-pulse');
      mkdirSync(join(source, 'src'), { recursive: true });
      writeFileSync(
        join(source, 'plugin.json'),
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
          name: 'tool-pulse',
          version: '1.0.0',
          extensions: {
            'io.kontourai.station': {
              schemaVersion: '1.0',
              // Missing: the tool must relay the route's refusal.
              entrypoint: './src/missing.tsx',
            },
          },
        }),
      );
      const plugins = new Hono();
      registerPluginValidateRoutes(plugins, {
        agentsDir: join(home, 'agents'),
        logger: { debug() {}, error() {}, info() {}, warn() {} } as any,
        pluginsDir,
        projectHomeDir: home,
      });
      const app = new Hono().route('/api/plugins', plugins);
      fetchMock.mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe(API_BASE);
        return app.request(url.pathname, init as RequestInit);
      });
      const tools = await registerTools();

      const result = await tools.validate_plugin({ source });

      const payload = JSON.parse(result.content[0].text);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${API_BASE}/api/plugins/validate`,
      );
      expect(payload.valid).toBe(false);
      expect(payload.plugin).toMatchObject({ name: 'tool-pulse' });
      expect(payload.diagnostics).toEqual([
        expect.objectContaining({ code: 'entrypoint-missing' }),
      ]);
      expect(payload).not.toHaveProperty('contentDigest');
      expect(readdirSync(pluginsDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
