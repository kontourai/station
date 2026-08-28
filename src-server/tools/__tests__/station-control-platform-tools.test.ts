import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
    expect(payload.message).toContain('Plugins page');
    expect(payload.message).toContain('station plugin install');
    // The route is never reached: nothing to refuse, nothing to roll back.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
