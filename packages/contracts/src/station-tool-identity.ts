/** The MCP servers whose tools are Station's own. */
export const STATION_TOOL_SERVERS = [
  'station-control',
  'station-knowledge',
  'station-browser',
  'station-docs',
] as const;

export type StationToolServer = (typeof STATION_TOOL_SERVERS)[number];

const QUALIFIED_NAME = new RegExp(
  `^(?:mcp__(${STATION_TOOL_SERVERS.join('|')})__|mcp_(${STATION_TOOL_SERVERS.join('|')})_|(${STATION_TOOL_SERVERS.join('|')})[_/.]|Tool: (${STATION_TOOL_SERVERS.join('|')})/)([A-Za-z0-9_-]+)$`,
);

/**
 * The Station tool a call is, by its name as any engine spells it
 * (`mcp__station-control__x`, `station-control/x`, …) or by a bare name plus
 * the engine's `server` field. A bare name alone is never claimed.
 */
export function stationToolOf(
  toolName: string | undefined,
  server?: string,
): { server: StationToolServer; tool: string } | undefined {
  if (typeof toolName !== 'string') return undefined;
  const name = toolName.trim();
  const qualified = QUALIFIED_NAME.exec(name);
  if (qualified) {
    const found = (qualified[1] ??
      qualified[2] ??
      qualified[3] ??
      qualified[4]) as StationToolServer | undefined;
    const tool = qualified[5];
    return found && tool ? { server: found, tool } : undefined;
  }
  if (
    typeof server === 'string' &&
    (STATION_TOOL_SERVERS as readonly string[]).includes(server) &&
    /^[A-Za-z0-9_-]+$/u.test(name)
  )
    return { server: server as StationToolServer, tool: name };
  return undefined;
}
