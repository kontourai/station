/**
 * The approval policy of the built-in `station-browser` server (#90 D14,
 * N2), in a module with no dependencies so the tool-approval gate can read
 * it without loading the tools.
 */

/** The server id, and the key it is delivered under. */
export const STATION_BROWSER_MCP_SERVER_ID = 'station-browser';

/**
 * Tool sensitivity. Only `browser_status` is a read of Station's own
 * records. Every other tool reads or drives a logged-in page —
 * `browser_snapshot` and `browser_wait_for` included, since what they return
 * is the page's content — so all of them are `sensitive`: a wildcard or
 * `station-*` auto-approve pattern never covers them; only a pattern that
 * names `station-browser` itself does (`tool-approval.ts`).
 */
const STATION_BROWSER_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'browser_status',
]);

export function classifyStationBrowserTool(
  toolName: string,
): 'read-only' | 'sensitive' {
  return STATION_BROWSER_READ_ONLY_TOOLS.has(toolName)
    ? 'read-only'
    : 'sensitive';
}
