import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

// NON-MOCKED integration test: spawns the real examples/mcp-ui-demo SEP-1865 MCP
// server and drives the MCP-UI host's resolve + read paths through the real
// `connectMCP` SDK client — NOT mocks. This is the boundary the unit/e2e suites
// stubbed (and where a live regression — voltagent stripping _meta/resource,
// the matchesToolRef raw-name mismatch — went undetected). If MCP-UI stops
// working against a real server, this fails.

vi.mock('../../telemetry/metrics.js', () => ({
  mcpLifecycle: { add: vi.fn() },
  mcpUiResolveTotal: { add: vi.fn() },
}));

const { MCPService } = await import('../plugins/mcp-service.js');
const { resolveMCPToolUIRef } = await import(
  '../../runtime/mcp/mcp-ui-resolver.js'
);

const STATION_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const DEMO_SERVER = resolve(STATION_ROOT, 'examples/mcp-ui-demo/server.mjs');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeService() {
  const def = {
    id: 'demo',
    kind: 'mcp',
    transport: 'stdio',
    command: 'node',
    args: [DEMO_SERVER],
  };
  const configLoader = { loadIntegration: vi.fn().mockResolvedValue(def) };
  return new MCPService(
    configLoader as never,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    logger as never,
  );
}

describe('MCP-UI host against a real SEP-1865 server (integration)', () => {
  test('resolves the declared ui:// ref and reads its resource end to end', async () => {
    const service = makeService();
    // The resolver only needs the integration list + the transient UI catalog.
    const resolverService = {
      listIntegrations: async () => [{ id: 'demo' }],
      getMCPUIToolCatalog: (serverId: string) =>
        service.getMCPUIToolCatalog(serverId),
    };

    const resolution = await resolveMCPToolUIRef(
      resolverService as never,
      'demo/status_panel',
    );
    expect(resolution.status).toBe('success');
    expect(resolution.resourceUri).toBe('ui://mcp-ui-demo/status-panel');

    const content = await service.readMCPUIResource(
      'demo',
      'ui://mcp-ui-demo/status-panel',
    );
    expect(content.mimeType).toContain('text/html');
    expect(content.text).toContain('Station MCP-UI demo');
  }, 30_000);

  test('missing tool resolves to missing_tool against the real server', async () => {
    const service = makeService();
    const resolverService = {
      listIntegrations: async () => [{ id: 'demo' }],
      getMCPUIToolCatalog: (serverId: string) =>
        service.getMCPUIToolCatalog(serverId),
    };
    const resolution = await resolveMCPToolUIRef(
      resolverService as never,
      'demo/does_not_exist',
    );
    expect(resolution.status).toBe('missing_tool');
  }, 30_000);
});
