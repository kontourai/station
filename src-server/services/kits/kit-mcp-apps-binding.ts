import type { MCPService } from '../plugins/mcp-service.js';
import type { StationKitMcpAppsBindingResolver } from './kit-observability-host.js';

/**
 * Kept as an explicit fail-closed seam for a future Station-owned binding
 * record. Raw MCP metadata cannot prove that a Kit package owns an integration,
 * so this release never probes arbitrary installed servers for a match.
 */
export function createStationKitMcpAppsBindingResolver(
  _mcpService: MCPService,
  _isRenderRevoked: (serverId: string) => boolean,
): StationKitMcpAppsBindingResolver {
  return async () => undefined;
}
