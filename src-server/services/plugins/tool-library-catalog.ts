import type { ToolLibrarySource } from '@kontourai/station-contracts/tool-library';
import { mcpToolDisabled } from '@kontourai/station-shared/mcp-tool-selection';
import { getIntegrationRegistryProvider } from '../../providers/registries/registry.js';
import { registrySourceManager } from '../../providers/registries/registry-source-manager.js';
import { stationControlToolCatalog } from '../../tools/station-control-mcp-server.js';
import { stationDocsToolCatalog } from '../../tools/station-docs-mcp-server.js';
import { stationKnowledgeToolCatalog } from '../../tools/station-knowledge-mcp-server.js';
import { toolOriginLocation } from './integration-origin.js';
import type { MCPService } from './mcp-service.js';

export async function toolLibraryCatalog(
  home: string,
  mcp: Pick<MCPService, 'listIntegrations' | 'getMCPToolCatalog'>,
): Promise<ToolLibrarySource[]> {
  const [installed, integrations, plugins] = await Promise.all([
    mcp.listIntegrations(),
    getIntegrationRegistryProvider().listAvailable(),
    registrySourceManager(home).catalog('plugins'),
  ]);
  const runtimeTools = mcp.getMCPToolCatalog();
  const builtin = new Map([
    ['station-control', stationControlToolCatalog()],
    ['station-docs', stationDocsToolCatalog()],
    ['station-knowledge', stationKnowledgeToolCatalog()],
  ]);
  const rows: ToolLibrarySource[] = installed
    .filter((source) => source.kind === 'mcp')
    .map((source) => ({
      id: source.id,
      kind: 'integration',
      name: source.displayName || source.id,
      description: source.description,
      from: builtin.has(source.id)
        ? 'Station'
        : source.origin?.pluginName ||
          source.origin?.registryName ||
          (source.origin?.kind === 'manual'
            ? 'Connected on this Station'
            : 'Origin not recorded'),
      origin: builtin.has(source.id)
        ? { kind: 'station', registryName: 'Station' }
        : source.origin,
      personalAccount: !!source.credentialOwnership,
      installed: true,
      enabled: source.enabled !== false && source.probe?.ok !== false,
      permitted: true,
      operatorOnly: source.id === 'station-control',
      tools: (
        builtin.get(source.id) ??
        source.probe?.tools ??
        runtimeTools
          .filter((tool) => tool.serverId === source.id)
          .map((tool) => ({
            name: tool.toolName ?? tool.originalName,
            description: tool.description,
          }))
      ).map((tool) => ({
        name: tool.name,
        disabled: mcpToolDisabled(
          source.id,
          tool.name,
          source.disabledTools ?? [],
        ),
        description: tool.description,
        ...('title' in tool && typeof tool.title === 'string'
          ? { title: tool.title }
          : {}),
        ...('group' in tool ? { group: tool.group } : {}),
        ...('readOnly' in tool ? { readOnly: tool.readOnly } : {}),
        classificationSource: builtin.has(source.id) ? 'station' : 'publisher',
      })),
    }));
  for (const item of integrations) {
    if (
      item.tags?.includes('builtin') ||
      installed.some((source) => source.id === item.id && source.kind !== 'mcp')
    )
      continue;
    if (rows.some((row) => row.kind === 'integration' && row.id === item.id))
      continue;
    rows.push({
      id: item.id,
      kind: 'integration',
      name: item.displayName || item.id,
      description: item.description,
      from: item.toolOrigin?.registryName || 'Catalog',
      origin: item.toolOrigin,
      installed: false,
      enabled: false,
      permitted: true,
      operatorOnly: false,
      tools: [],
    });
  }
  for (const item of plugins) {
    const pluginName = item.installedPluginName;
    const servers = installed.filter(
      (source) =>
        source.kind === 'mcp' && source.origin?.pluginName === pluginName,
    );
    rows.push({
      id: item.id,
      kind: 'plugin',
      providesTools: item.providesTools,
      name: item.displayName || item.id,
      description: item.description,
      from: item.catalogSourceName || 'Plugin catalog',
      origin: {
        kind: 'registry',
        registryId: toolOriginLocation(item.catalog?.sourceId),
        registryName: item.catalogSourceName,
        location: toolOriginLocation(item.source),
        version: item.version,
        itemId: item.id,
      },
      installed: !!item.installed,
      enabled: !!item.installed && servers.length > 0,
      permitted: true,
      operatorOnly: false,
      tools: [],
      serverIds: servers.map((source) => source.id),
    });
  }
  return rows;
}
