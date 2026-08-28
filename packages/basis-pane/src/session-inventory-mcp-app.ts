import sessionInventoryMcpApp from './session-inventory-mcp-app.generated';

export const STATION_SESSION_INVENTORY_MCP_RESOURCE_URI =
  'ui://station/basis/session-inventory/v1';

export function buildStationSessionInventoryMcpAppResource() {
  const text = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>Session inventory</title><style>body{margin:0;padding:1rem;background:var(--color-background-primary,#fff);color:var(--color-text-primary,#17201b);font-family:var(--font-sans,system-ui,sans-serif)}button,summary{min-height:44px}section{min-width:0;overflow-wrap:anywhere}bdi{unicode-bidi:isolate}@media(max-width:390px){body{padding:.75rem}}</style></head><body><main id="session-inventory-app" aria-label="Session inventory"></main><script type="module">${safe(sessionInventoryMcpApp)}</script></body></html>`;
  if (new TextEncoder().encode(text).byteLength > 500 * 1024)
    throw new Error(
      'Station Session inventory MCP App resource exceeds 500 KiB',
    );
  return {
    uri: STATION_SESSION_INVENTORY_MCP_RESOURCE_URI,
    mimeType: 'text/html;profile=mcp-app' as const,
    text,
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
  };
}

function safe(value: string) {
  return value.split('</').join('<\\/').split('<!--').join('<\\!--');
}
