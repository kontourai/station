import { MCPManager } from '@kontourai/station-shared/mcp';
import { resolvePluginIntegrations } from '@kontourai/station-shared/parsers';

interface DevMcpContext {
  cwd: string;
  toolsDir: string;
}

export async function setupDevMcpManager({
  cwd,
  toolsDir,
}: DevMcpContext): Promise<MCPManager | null> {
  const toolDefs = resolvePluginIntegrations(cwd, toolsDir);
  if (toolDefs.size === 0) {
    return null;
  }

  const mcpManager = new MCPManager({
    onStatus: (id, status, error) => {
      console.log(
        status === 'connected'
          ? `   ✓ MCP: ${id}`
          : `   ✗ MCP: ${id} — ${error}`,
      );
    },
  });

  await mcpManager.connectAll(Array.from(toolDefs.values()));
  console.log(
    `   🔌 ${mcpManager.listTools().length} tools from ${toolDefs.size} MCP servers`,
  );
  return mcpManager;
}
