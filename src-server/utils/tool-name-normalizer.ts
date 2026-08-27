/**
 * Normalize tool names to be compatible with Nova streaming
 *
 * Nova crashes when tool names contain hyphens during streaming.
 * This utility converts tool names to camelCase with underscore separator.
 *
 * Format: <serverNameInCamelCase>_<toolNameInCamelCase>
 *
 * Examples:
 * - my-server_tool_name → myServer_toolName
 * - other-mcp_query → otherMcp_query
 * - my-tool → myTool
 */

export function normalizeToolName(toolName: string): string {
  // Find the first underscore to split server from tool name
  const firstUnderscore = toolName.indexOf('_');

  if (firstUnderscore === -1) {
    // No underscore, just convert hyphens to camelCase
    return hyphenToCamelCase(toolName);
  }

  // Split into server and tool parts
  const serverPart = toolName.substring(0, firstUnderscore);
  const toolPart = toolName.substring(firstUnderscore + 1);

  // Convert each part
  const normalizedServer = hyphenToCamelCase(serverPart);
  const normalizedTool = hyphenToCamelCase(toolPart);

  return `${normalizedServer}_${normalizedTool}`;
}

function hyphenToCamelCase(str: string): string {
  // Convert hyphens to camelCase
  const withoutHyphens = str.replace(/-([a-z])/g, (_, letter) =>
    letter.toUpperCase(),
  );
  // Convert underscores to camelCase
  return withoutHyphens.replace(/_([a-z])/g, (_, letter) =>
    letter.toUpperCase(),
  );
}

/**
 * Parse tool name into server and tool parts
 * Examples:
 *   "my-server_tool_name" → { server: "my-server", tool: "tool_name" }
 *   "simple_tool" → { server: null, tool: "simple_tool" }
 */
export function parseToolName(toolName: string): {
  server: string | null;
  tool: string;
} {
  const underscoreIndex = toolName.indexOf('_');

  if (underscoreIndex === -1) {
    return { server: null, tool: toolName };
  }

  return {
    server: toolName.substring(0, underscoreIndex),
    tool: toolName.substring(underscoreIndex + 1),
  };
}
