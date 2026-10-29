/**
 * MCP-UI sandbox CSP construction — deliberately a standalone, dependency-free
 * module. It is imported as a *value* by the browser UI (srcdoc `<meta>`) AND
 * the server (dedicated frame-origin HTTP header), so it must not pull in any
 * node-only code (which `./mcp.ts` does via the MCP SDK transports). Keeping it
 * here lets both sides share one source of truth without breaking the UI bundle.
 */

/** Declared CSP allowlists from resource-content `_meta.ui.csp`. */
export interface MCPToolUICsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/**
 * Filters declarations by their parsed URL protocol, returning original text.
 * This is not a complete validator for CSP source-expression syntax.
 */
export function safeCspDomains(
  domains?: string[],
  allowedProtocols: readonly string[] = ['https:'],
): string[] {
  if (!domains) return [];
  return domains.filter((d) => {
    try {
      return allowedProtocols.includes(new URL(d).protocol);
    } catch {
      return false;
    }
  });
}

/**
 * Builds the base policy and appends protocol-filtered declarations. Connect
 * sources also accept wss. With no declarations, network connections are
 * CSP-blocked; this does not block WebRTC ICE. Inline scripts/styles and data images/fonts remain available.
 */
export function buildMcpUiCsp(csp?: MCPToolUICsp): string {
  const connect = safeCspDomains(csp?.connectDomains, ['https:', 'wss:']);
  const resource = safeCspDomains(csp?.resourceDomains);
  const base = safeCspDomains(csp?.baseUriDomains);
  const src = (sources: string[]) =>
    sources.length ? sources.join(' ') : "'none'";
  const withResource = (head: string) =>
    resource.length ? `${head} ${resource.join(' ')}` : head;
  return [
    "default-src 'none'",
    withResource("script-src 'unsafe-inline'"),
    withResource("style-src 'unsafe-inline'"),
    withResource('img-src data:'),
    'font-src data:',
    `connect-src ${src(connect)}`,
    "frame-src 'none'",
    `base-uri ${src(base)}`,
    "form-action 'none'",
  ].join('; ');
}

/**
 * Defense in depth before authored bytes. CSP does not govern WebRTC ICE.
 * Nested srcdoc inherits CSP but obtains fresh constructors, so this is not a
 * network isolation guarantee. See docs/decisions/html-replies.md.
 */
export const MCP_UI_NETWORK_BOOTSTRAP_TAG = `<script>(()=>{'use strict';for(const name of ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','RTCIceGatherer','RTCIceTransport'])Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});})();</script>`;
