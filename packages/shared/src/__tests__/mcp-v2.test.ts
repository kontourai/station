import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { connectMCP, createMCPTransport } from '../mcp.js';

const MODERN_SERVER = fileURLToPath(
  new URL('./fixtures/mcp-modern-server.mjs', import.meta.url),
);
const LEGACY_SERVER = fileURLToPath(
  new URL('../../../../examples/mcp-ui-demo/server.mjs', import.meta.url),
);

const openConnections: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(
    openConnections.splice(0).map((item) => item.close()),
  );
});

describe('MCP 2026 connection adapter', () => {
  test('negotiates a modern server, advertises Apps, and preserves results', async () => {
    const onNegotiated = vi.fn();
    const connection = await connectMCP(
      {
        id: 'modern',
        kind: 'mcp',
        transport: 'stdio',
        command: process.execPath,
        args: [MODERN_SERVER],
      },
      { onNegotiated },
    );
    openConnections.push(connection);

    expect(connection.negotiation).toMatchObject({
      era: 'modern',
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'station-modern-fixture', version: '2.0.0' },
      extensionIds: ['io.modelcontextprotocol/ui'],
      fellBackToLegacy: false,
    });
    expect(onNegotiated).toHaveBeenCalledWith('modern', connection.negotiation);
    expect(connection.tools).toEqual([
      expect.objectContaining({
        name: 'modern_echo',
        originalName: 'echo',
        serverId: 'modern',
        ui: {
          resourceUri: 'ui://station-modern-fixture/panel',
        },
      }),
    ]);

    const called = await connection.client.callTool({
      name: 'echo',
      arguments: { value: 'hello' },
    });
    expect(called).toMatchObject({
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: { value: 'hello', era: 'modern' },
      _meta: { fixture: 'modern' },
    });

    const resource = await connection.client.readResource({
      uri: 'ui://station-modern-fixture/panel',
    });
    expect(resource.contents[0]).toMatchObject({
      mimeType: 'text/html;profile=mcp-app',
      text: expect.stringContaining('Modern fixture'),
    });
  });

  test('falls back automatically to a deployed legacy server', async () => {
    const connection = await connectMCP({
      id: 'legacy',
      kind: 'mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [LEGACY_SERVER],
    });
    openConnections.push(connection);

    expect(connection.negotiation).toMatchObject({
      era: 'legacy',
      fellBackToLegacy: true,
      serverInfo: { name: 'mcp-ui-demo', version: '1.0.0' },
    });
    expect(connection.negotiation.protocolVersion).toMatch(/^2025-/);
    expect(connection.tools).toEqual([
      expect.objectContaining({
        name: 'legacy_status_panel',
        originalName: 'status_panel',
        serverId: 'legacy',
      }),
    ]);

    const result = await connection.client.callTool({
      name: 'status_panel',
      arguments: { label: 'legacy' },
    });
    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('legacy'),
        },
      ],
      structuredContent: { label: 'legacy' },
    });
  });

  test('preserves the three canonical MCP transport definitions', () => {
    const stdio = createMCPTransport({
      id: 'stdio',
      kind: 'mcp',
      transport: 'stdio',
      command: process.execPath,
      args: ['server.mjs'],
    });
    const sse = createMCPTransport({
      id: 'sse',
      kind: 'mcp',
      transport: 'sse',
      endpoint: 'https://example.test/sse',
    });
    const http = createMCPTransport({
      id: 'http',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://example.test/mcp',
    });
    expect(stdio.constructor.name).toBe('StdioClientTransport');
    expect(sse.constructor.name).toBe('SSEClientTransport');
    expect(http.constructor.name).toBe('StreamableHTTPClientTransport');
  });

  test('passes live cwd and literal headers to transports without letting package auth override client auth', () => {
    const stdio = createMCPTransport({
      id: 'stdio-options',
      kind: 'mcp',
      transport: 'stdio',
      command: process.execPath,
      cwd: '/tmp/plugin-root',
    }) as unknown as { _serverParams: { cwd?: string } };
    expect(stdio._serverParams.cwd).toBe('/tmp/plugin-root');

    const http = createMCPTransport(
      {
        id: 'http-options',
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://example.test/mcp',
        headers: {
          Authorization: 'package-value',
          'MCP-Session-Id': 'package-session',
          'X-Tenant': 'public',
        },
      },
      { tokens: vi.fn() } as never,
    ) as unknown as {
      _requestInit: { redirect?: string; headers?: Record<string, string> };
    };
    expect(http._requestInit).toEqual({
      redirect: 'error',
      headers: { 'X-Tenant': 'public' },
    });
  });
});
