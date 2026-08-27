import { describe, expect, test } from 'vitest';
import { BuiltinIntegrationRegistryProvider } from '../defaults.js';

describe('BuiltinIntegrationRegistryProvider', () => {
  test('lists the filesystem MCP server by default', async () => {
    const provider = new BuiltinIntegrationRegistryProvider();

    await expect(provider.listAvailable()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'filesystem',
          displayName: 'Filesystem (MCP)',
          source: 'modelcontextprotocol/servers',
        }),
        expect.objectContaining({
          id: 'bash',
          displayName: 'Bash',
        }),
        expect.objectContaining({
          id: 'file-editor',
          displayName: 'File Editor',
        }),
        expect.objectContaining({
          id: 'http-request',
          displayName: 'HTTP Request',
        }),
        expect.objectContaining({
          id: 'notebook',
          displayName: 'Notebook',
        }),
      ]),
    );
  });

  test('returns a ready-to-save tool definition for filesystem', async () => {
    const provider = new BuiltinIntegrationRegistryProvider();
    const toolDef = await provider.getToolDef('filesystem');

    expect(toolDef).toEqual(
      expect.objectContaining({
        id: 'filesystem',
        kind: 'mcp',
        command: 'npx',
        transport: 'stdio',
      }),
    );
    expect(toolDef?.args?.[0]).toBe('-y');
    expect(toolDef?.args?.[1]).toBe('@modelcontextprotocol/server-filesystem');
    expect(toolDef?.permissions?.filesystem).toBe(true);
    expect(toolDef?.permissions?.allowedPaths?.length).toBe(1);
  });

  test('allows installing Station-named builtin compatibility tools', async () => {
    const provider = new BuiltinIntegrationRegistryProvider();

    await expect(provider.install('notebook')).resolves.toEqual(
      expect.objectContaining({
        success: true,
      }),
    );
    await expect(provider.getToolDef('notebook')).resolves.toEqual(
      expect.objectContaining({
        id: 'notebook',
        kind: 'builtin',
        builtinPolicy: { name: 'station_notebook' },
      }),
    );
  });
});
