import { parseMcpToolRef } from '@kontourai/station-contracts/layout';
import type {
  MCPToolUIResolution,
  MCPToolUIResolutionStatus,
} from '@kontourai/station-shared/mcp';
import type { MCPUIToolCatalogResult } from '../../services/plugins/mcp-service.js';
import {
  mcpUiRenderPermissionChecks,
  mcpUiResolveTotal,
} from '../../telemetry/metrics.js';
import { extractMCPAppsToolMetadata } from './mcp-apps-metadata.js';

interface MCPUIResolverService {
  listIntegrations: () => Promise<Array<{ id: string }>>;
  getConnectionStatus?: (
    agentSlug: string,
    toolId: string,
  ) => { connected: boolean; error?: string } | undefined;
  getAgentTools?: (agentSlug: string) => unknown[];
  getMCPToolCatalog?: () => unknown[] | Promise<unknown[]>;
  listTools?: () => unknown[] | Promise<unknown[]>;
  // Server-scoped catalog read over Station's raw MCP connection, so tools
  // retain `originalName`, `_meta`, and `ui.resourceUri`. Preferred when
  // present.
  getMCPUIToolCatalog?: (serverId: string) => Promise<MCPUIToolCatalogResult>;
}

interface ParsedMCPToolRef {
  serverId: string;
  toolName: string;
}

/** Host-policy hooks layered onto resolution (S2 render permission). */
export interface MCPToolUIResolveOptions {
  /**
   * True when the server's UI render has been explicitly revoked by the
   * operator. The MCP Apps spec (SEP-1865) defines the *protocol* for
   * rendering, not host policy — gating whether to render is a host-policy
   * decision made BEFORE any protocol handshake, so refusing here is fully
   * spec-compliant (a host may decline to embed a server, just like any other
   * MCP-UI host).
   */
  isRenderRevoked?: (serverId: string) => boolean;
}

export async function resolveMCPToolUIRef(
  service: MCPUIResolverService,
  ref: string,
  agentSlug = 'default',
  options: MCPToolUIResolveOptions = {},
): Promise<MCPToolUIResolution> {
  const parsed = parseMcpToolRef(ref);
  if (!parsed) {
    return recordResolution({
      status: 'invalid_ref',
      ref,
      reason: 'Expected canonical <serverId>/<toolName> reference',
    });
  }

  const integrations = await service.listIntegrations();
  if (!integrations.some((integration) => integration.id === parsed.serverId)) {
    return recordResolution({
      status: 'missing_server',
      ref,
      ...parsed,
      reason: 'MCP server is not installed',
    });
  }

  const connection = service.getConnectionStatus?.(agentSlug, parsed.serverId);
  if (connection && !connection.connected) {
    return recordResolution({
      status: 'missing_server',
      ref,
      ...parsed,
      reason: 'MCP server is not connected',
    });
  }

  // Per-server render permission (S2, allow + revoke). Default is allow; a
  // server only fails here when the operator has explicitly revoked it. The
  // gate sits before resource discovery / the host bridge, so a revoked server
  // never reaches the protocol — a host-policy decision, not a spec violation.
  if (options.isRenderRevoked) {
    const revoked = options.isRenderRevoked(parsed.serverId);
    mcpUiRenderPermissionChecks.add(1, {
      server: parsed.serverId,
      revoked: String(revoked),
    });
    if (revoked) {
      return recordResolution({
        status: 'render_revoked',
        ref,
        ...parsed,
        reason:
          'Rendering is disabled for this MCP server; re-enable it in settings.',
      });
    }
  }

  const tools = await getToolCatalog(service, agentSlug, parsed.serverId);
  const tool = tools.find((candidate) => matchesToolRef(candidate, parsed));
  if (!tool) {
    return recordResolution({
      status: 'missing_tool',
      ref,
      ...parsed,
      reason: 'MCP tool was not discovered for this server',
    });
  }

  const ui = extractMCPAppsToolMetadata(tool);
  const resourceUri = ui.resourceUri;
  if (!resourceUri) {
    return recordResolution({
      status: 'missing_resource',
      ref,
      ...parsed,
      reason: 'MCP tool does not expose UI resource metadata',
    });
  }

  return recordResolution({
    status: 'success',
    ref,
    ...parsed,
    resourceUri,
  });
}

async function getToolCatalog(
  service: MCPUIResolverService,
  agentSlug: string,
  serverId: string,
): Promise<unknown[]> {
  // Prefer Station's raw server catalog: it preserves the raw name + `_meta.ui`
  // needed for live resolution. An available result is authoritative even
  // when empty; compatibility catalogs are only valid when the server-scoped
  // authority is unavailable.
  if (service.getMCPUIToolCatalog) {
    const catalog = await service.getMCPUIToolCatalog(serverId);
    if (catalog.available) return catalog.tools;
  }
  if (service.getMCPToolCatalog) return service.getMCPToolCatalog();
  if (service.listTools) return service.listTools();
  return service.getAgentTools?.(agentSlug) ?? [];
}

function matchesToolRef(tool: unknown, ref: ParsedMCPToolRef): boolean {
  if (!isRecord(tool)) return false;

  const serverId = stringField(tool, 'serverId') ?? stringField(tool, 'server');
  if (serverId !== ref.serverId) return false;

  const prefixedName = `${ref.serverId}_${ref.toolName}`;
  // Match the raw tool name across the fields different catalogs expose it in.
  // Station's raw catalog puts it in `originalName`; compatibility catalogs
  // may put it in `toolName` and the prefixed name in `id`/`originalName`.
  return (
    stringField(tool, 'originalName') === ref.toolName ||
    stringField(tool, 'toolName') === ref.toolName ||
    stringField(tool, 'name') === ref.toolName ||
    stringField(tool, 'name') === prefixedName ||
    stringField(tool, 'id') === prefixedName ||
    stringField(tool, 'originalName') === prefixedName
  );
}

function recordResolution(result: MCPToolUIResolution): MCPToolUIResolution {
  const attrs: Record<string, string> = {
    source: 'layout',
    component_kind: 'mcp-tool-ui',
    outcome: result.status,
    reason: telemetryReason(result.status),
    has_server_ref: String(Boolean(result.serverId)),
    has_tool_ref: String(Boolean(result.toolName)),
  };

  mcpUiResolveTotal.add(1, attrs);
  return result;
}

function telemetryReason(status: MCPToolUIResolutionStatus): string {
  switch (status) {
    case 'invalid_ref':
      return 'invalid_ref';
    case 'missing_server':
      return 'server_unavailable';
    case 'missing_tool':
      return 'tool_unavailable';
    case 'missing_resource':
      return 'resource_missing';
    case 'render_revoked':
      return 'render_revoked';
    case 'unsupported':
      return 'unsupported_resource';
    case 'success':
      return 'resolved';
    default:
      return 'unknown';
  }
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export type { MCPToolUIResolutionStatus };
