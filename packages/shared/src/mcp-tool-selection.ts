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

/** Probe receipts carry the server prefix; protocol calls use the original name. */
export function originalMcpToolName(
  serverId: string,
  recordedName: string,
): string {
  const prefix = `${serverId}_`;
  return recordedName.startsWith(prefix)
    ? recordedName.slice(prefix.length)
    : recordedName;
}

export function mcpToolApprovalKey(serverId: string, name?: string): string {
  const encode = (value: string) =>
    encodeURIComponent(value).replaceAll('*', '%2A');
  return `mcp/${encode(serverId)}/${name === undefined ? '*' : encode(name)}`;
}

export function mcpToolIdentities(serverId: string, name: string): string[] {
  const qualified = `${serverId}_${name}`;
  return [name, qualified, normalizeToolName(qualified)];
}

export function mcpToolDisabled(
  serverId: string,
  name: string,
  disabled: readonly string[] = [],
): boolean {
  return mcpToolIdentities(serverId, name).some((identity) =>
    disabled.includes(identity),
  );
}

export function selectedMcpTools(
  serverId: string,
  names: readonly string[],
  available: readonly string[],
  serverIds: readonly string[],
): string[] | undefined {
  if (
    available.includes('*') ||
    available.includes(`${serverId}_*`) ||
    available.includes(`${serverId}/*`)
  )
    return undefined;
  const selected = new Set<string>();
  for (const entry of available) {
    if (entry.endsWith('_*') || entry.endsWith('/*')) {
      const prefix = entry.slice(0, -2);
      for (const name of names) {
        if (
          mcpToolIdentities(serverId, name).some(
            (identity) =>
              identity.startsWith(`${prefix}_`) ||
              identity.startsWith(`${prefix}/`),
          )
        )
          selected.add(name);
      }
      continue;
    }
    const qualified = names.filter((name) => `${serverId}_${name}` === entry);
    const normalized = qualified.length
      ? qualified
      : names.filter(
          (name) => normalizeToolName(`${serverId}_${name}`) === entry,
        );
    if (normalized.length) {
      for (const name of normalized) selected.add(name);
    } else if (entry.startsWith(`${serverId}_`))
      selected.add(entry.slice(serverId.length + 1));
    else if (
      !entry.includes('*') &&
      !serverIds.some(
        (id) =>
          entry.startsWith(`${id}_`) ||
          entry.startsWith(`${id}/`) ||
          entry.startsWith(normalizeToolName(`${id}_`)),
      )
    )
      selected.add(entry);
  }
  return [...selected];
}

export function canonicalDisabledMcpTools(
  serverId: string,
  names: readonly string[],
  disabled: readonly string[] = [],
): string[] {
  const unknown = disabled.filter(
    (entry) => !names.some((name) => mcpToolDisabled(serverId, name, [entry])),
  );
  return [
    ...new Set([
      ...unknown,
      ...names
        .filter((name) => mcpToolDisabled(serverId, name, disabled))
        .map((name) => normalizeToolName(`${serverId}_${name}`)),
    ]),
  ];
}

/** The SDK's separator is ambiguous when either name contains a double underscore. */
export function externalMcpToolApprovalIdentity(toolName: string): {
  key?: string;
  ambiguous: boolean;
} {
  if (!toolName.startsWith('mcp__')) return { ambiguous: false };
  const suffix = toolName.slice(5);
  const parts = suffix.split('__');
  if (parts.length !== 2 || suffix.includes('___')) return { ambiguous: true };
  return { key: mcpToolApprovalKey(parts[0], parts[1]), ambiguous: false };
}

/** Exact choices override source defaults; Ask wins equally specific rules. */
export function resolveAuthoredToolApproval(
  identities: readonly string[],
  autoApprove: readonly string[] = [],
  askBeforeUse: readonly string[] = [],
  sourceIdentity?: string,
): 'always' | 'ask' | undefined {
  const matches = (pattern: string) => {
    const expression = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const candidates = pattern.startsWith('mcp/')
      ? sourceIdentity
        ? [sourceIdentity]
        : []
      : identities;
    return candidates.some((identity) =>
      new RegExp(`^${expression}$`).test(identity),
    );
  };
  const sourceAsk = askBeforeUse.some(
    (pattern) =>
      pattern.startsWith('mcp/') && pattern.endsWith('/*') && matches(pattern),
  );
  for (const wildcard of [false, true]) {
    if (
      askBeforeUse.some(
        (pattern) => pattern.includes('*') === wildcard && matches(pattern),
      )
    )
      return 'ask';
    if (
      autoApprove.some(
        (pattern) =>
          pattern.includes('*') === wildcard &&
          (!sourceAsk || pattern.startsWith('mcp/')) &&
          matches(pattern),
      )
    )
      return 'always';
  }
  return undefined;
}
