/**
 * The approval policy of the built-in `station-browser` server (#90 D14,
 * N2), in a module with no dependencies so the tool-approval gate can read
 * it without loading the tools.
 */

/** The server id, and the key it is delivered under. */
export const STATION_BROWSER_MCP_SERVER_ID = 'station-browser';

/** Names served by the separate Browser MCP server, also used by parity checks. */
export const STATION_BROWSER_TOOL_NAMES = [
  'browser_capture_to_task',
  'browser_click',
  'browser_close',
  'browser_color_scheme',
  'browser_drag',
  'browser_evaluate',
  'browser_hover',
  'browser_navigate',
  'browser_open',
  'browser_press',
  'browser_record_to_task',
  'browser_resize',
  'browser_scroll',
  'browser_select',
  'browser_snapshot',
  'browser_status',
  'browser_type',
  'browser_wait_for',
] as const;

/** Hard ceilings for a Task-bound Browser recording. */
export const BROWSER_RECORD_MAX_DURATION_MS = 30_000;
export const BROWSER_RECORD_MAX_ENCODED_BYTES = 16 * 1024 * 1024;

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
