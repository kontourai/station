import type { RegistryItem } from '@kontourai/station-contracts/catalog';
import type { ToolMetadata } from '@kontourai/station-contracts/tool';
import { expect, test, vi } from 'vitest';
import { toolLibraryCatalog } from '../tool-library-catalog.js';

const registry = vi.hoisted(() => ({ items: [] as RegistryItem[] }));
vi.mock('../../../providers/registries/registry.js', () => ({
  getIntegrationRegistryProvider: () => ({
    listAvailable: async () => registry.items,
  }),
}));
vi.mock('../../../providers/registries/registry-source-manager.js', () => ({
  registrySourceManager: () => ({ catalog: async () => [] }),
}));
test('the MCP library never offers engine-native tools as installable MCP sources', async () => {
  registry.items = [
    {
      id: 'notebook',
      displayName: 'Notebook',
      description: '',
      installed: true,
    },
    {
      id: 'bash',
      displayName: 'Bash',
      description: '',
      installed: false,
      tags: ['builtin'],
    },
    {
      id: 'remote',
      displayName: 'Remote MCP',
      description: '',
      installed: false,
      tags: ['mcp'],
    },
  ];
  const installed: ToolMetadata[] = [
    { id: 'notebook', kind: 'builtin', displayName: 'Notebook', enabled: true },
    {
      id: 'reports',
      kind: 'mcp',
      displayName: 'Reports',
      enabled: true,
      probe: {
        ok: true,
        checkedAt: '2026-10-15T00:00:00Z',
        toolCount: 1,
        tools: [{ name: 'read' }],
      },
    },
  ];
  const sources = await toolLibraryCatalog('/unused-test-home', {
    listIntegrations: async () => installed,
    getMCPToolCatalog: () => [],
  });
  expect(sources.map((source) => source.id)).toEqual(['reports', 'remote']);
  expect(sources[0]?.tools.map((tool) => tool.name)).toEqual(['read']);
  expect(sources[0]).toMatchObject({
    from: 'Origin not recorded',
    enabled: true,
  });
});
