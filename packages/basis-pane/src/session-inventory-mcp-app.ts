import sessionInventoryMcpApp from './session-inventory-mcp-app.generated';

export const STATION_SESSION_INVENTORY_MCP_RESOURCE_URI =
  'ui://station/basis/session-inventory/v1';
export const STATION_SESSION_INVENTORY_MCP_V2_RESOURCE_URI =
  'ui://station/basis/session-inventory/v2';

export function buildStationSessionInventoryMcpAppResource() {
  return buildResource(STATION_SESSION_INVENTORY_MCP_RESOURCE_URI);
}

/** v2 is independently addressable; v1's resource URI stays immutable. */
export function buildStationSessionInventoryMcpV2AppResource() {
  return buildResource(STATION_SESSION_INVENTORY_MCP_V2_RESOURCE_URI);
}

function buildResource(uri: string) {
  const text = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>Session inventory</title><style>body{margin:0;padding:1rem;background:var(--color-background-primary,#fff);color:var(--color-text-primary,#17201b);font-family:var(--font-sans,system-ui,sans-serif)}button,summary{min-height:44px}section{min-width:0;overflow-wrap:anywhere}bdi{unicode-bidi:isolate}@media(max-width:390px){body{padding:.75rem}}</style></head><body><main id="session-inventory-app" aria-label="Session inventory"></main><script type="module">${safe(sessionInventoryMcpApp)}</script></body></html>`;
  // Re-grounded 2026-09-11 alongside the task-basis guard: the generated
  // basis bundles grew past 512,000 bytes in one window (#1562 honest
  // basis/diff panes, @kontourai/surface 3.2.0 in #1741), and this
  // registration-time throw 500s every station-control initialize. 640 KiB
  // carries ~12% headroom over the measured Task resource (574,724 bytes);
  // the tracked gzip budgets live in package-boundary.test.ts.
  if (new TextEncoder().encode(text).byteLength > 640 * 1024)
    throw new Error(
      'Station Session inventory MCP App resource exceeds the 640 KiB resource budget',
    );
  return {
    uri,
    mimeType: 'text/html;profile=mcp-app' as const,
    text,
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
  };
}

function safe(value: string) {
  return value.split('</').join('<\\/').split('<!--').join('<\\!--');
}
