/**
 * Dedicated MCP Apps sandbox-proxy origin.
 *
 * The stable Apps protocol requires web hosts to place an intermediate proxy
 * between the Station page and untrusted app HTML. This listener serves only
 * that proxy. The host sends resource HTML after the proxy's ready
 * notification; the proxy creates the inner app iframe, applies resource CSP
 * and permissions, and forwards non-reserved JSON-RPC messages both ways.
 */
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mcpUiFrameServeTotal } from '../../telemetry/metrics.js';
import { sanitizedTransportError } from '../../utils/outward-error.js';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  // This document is intentionally embedded by Station from another origin.
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export interface McpUiFrameAppOptions {
  /**
   * Exact Station UI origins permitted to embed the dedicated proxy. An empty
   * list deliberately denies framing instead of relying on a request referrer.
   */
  frameAncestors?: readonly string[];
}

/**
 * Build the fixed Station UI origin set used by the proxy's framing policy.
 *
 * This mirrors the runtime's trusted browser origins, but stays local to the
 * proxy so an untrusted request can never expand the frame-ancestors policy.
 */
export function resolveMcpUiFrameAncestors(options: {
  port: number;
  host?: string;
  additionalOrigins?: readonly string[];
}): string[] {
  const origins = new Set<string>();
  const add = (origin: string | undefined) => {
    if (!origin) return;
    try {
      const url = new URL(origin);
      if (
        (url.protocol !== 'http:' &&
          url.protocol !== 'https:' &&
          url.protocol !== 'tauri:') ||
        (url.protocol === 'tauri:' && url.hostname !== 'localhost')
      ) {
        return;
      }
      // URL.origin is "null" for Tauri's custom scheme, while CSP accepts
      // the concrete tauri://localhost source expression.
      origins.add(url.protocol === 'tauri:' ? 'tauri://localhost' : url.origin);
    } catch {
      // Invalid deployment configuration must narrow access, never broaden it.
    }
  };

  for (const origin of options.additionalOrigins ?? []) add(origin);
  add(`http://localhost:${options.port}`);
  add(`http://127.0.0.1:${options.port}`);
  add(`http://[::1]:${options.port}`);
  add('tauri://localhost');
  add('https://tauri.localhost');
  add('http://tauri.localhost');
  if (options.host && options.host !== '0.0.0.0' && options.host !== '::') {
    add(`http://${options.host}:${options.port}`);
    add(`https://${options.host}:${options.port}`);
  }
  return [...origins];
}

export function createMcpUiFrameApp(options: McpUiFrameAppOptions = {}): Hono {
  const app = new Hono();
  const frameAncestors = options.frameAncestors?.length
    ? options.frameAncestors.join(' ')
    : "'none'";
  const frameHeaders = {
    // frame-ancestors does not apply to the proxy's srcdoc child, so it keeps
    // the resource-specific inner CSP intact while constraining the outer
    // document to Station's known UI origins.
    'Content-Security-Policy': `frame-ancestors ${frameAncestors}`,
    // Legacy user agents cannot express an allow-list. They fail closed rather
    // than allowing an arbitrary page to embed a loopback proxy; CSP is the
    // authoritative policy in supported desktop and mobile WebViews.
    'X-Frame-Options': 'SAMEORIGIN',
  };

  app.get('/mcp-ui/proxy', (c) => {
    const nonce = randomBytes(18).toString('base64');
    mcpUiFrameServeTotal.add(1, { result: 'success', mode: 'sandbox_proxy' });
    return c.html(
      buildMcpAppsSandboxProxyDocument(nonce, options.frameAncestors),
      200,
      {
        ...SECURITY_HEADERS,
        ...frameHeaders,
        // Do not apply an HTTP *resource* CSP to the proxy document: it would be
        // inherited by the inner srcdoc and could only be tightened, preventing
        // the resource's own policy from allowing its declared scripts/domains.
        // frame-ancestors above is safe because it is not inherited by srcdoc.
      },
    );
  });

  // Plugins use the same dedicated, asset-free origin as MCP Apps.  In
  // particular, do not add a static-file fallback here: extension bytes cross
  // the authenticated host bridge and are never fetched by this document.
  app.get('/plugin-host/frame', (c) => {
    const nonce = randomBytes(18).toString('base64');
    mcpUiFrameServeTotal.add(1, { result: 'success', mode: 'sandbox_proxy' });
    return c.html(
      buildPluginHostFrameDocument(nonce, options.frameAncestors),
      200,
      {
        ...SECURITY_HEADERS,
        ...frameHeaders,
        // Do not apply an HTTP *resource* CSP to the outer document: it would be
        // inherited by the inner srcdoc and could only be tightened. The inner
        // plugin policy is deliberately complete and precedes untrusted bytes.
      },
    );
  });

  app.all('*', (c) => c.text('Not found', 404, SECURITY_HEADERS));
  return app;
}

/**
 * The isolated plugin bootstrap; all executable plugin bytes arrive by bridge.
 *
 * The bridge is two-way. Plugin→host has always been relayed (the first
 * branch of the message handler); host→plugin was NOT, so every message the
 * host sent that this bootstrap did not itself consume arrived here and
 * stopped. Nothing said so, which is the same silence station#3308 and
 * station#3323 were both filed for.
 *
 * station#4201 step 3 makes the downlink load-bearing: the pane-host
 * contract's `confirm` resolves with the user's decision and its `facts` push
 * on change, and a request/response member whose response cannot be delivered
 * is a capability that only looks implemented. So the three pane-host replies
 * are relayed down to the plugin frame.
 *
 * The relay is an ALLOWLIST, not a pass-through, and the uplink's rule is why:
 * one layer up, a message the adapter does not recognise is refused rather
 * than dropped. Two directions of one bridge with opposite defaults is how a
 * future host→frame message reaches plugin code with nobody deciding it
 * should.
 *
 * `DOWN` therefore names the three pane-host replies and nothing else. It is
 * NOT a list of one message being withheld: it is the general property that
 * every host→frame message is decided one at a time. This list previously
 * carried an argument about `api-response`, the reply half of the frame's
 * `api-request` bridge; station#4300 deleted that bridge outright, so there is
 * no longer a message being kept out — there is only the allowlist, and the
 * next member added to it needs its own reason on its own review.
 *
 * `'*'` is the only available targetOrigin: the inner frame is
 * `sandbox="allow-scripts"` without `allow-same-origin`, so it has an opaque
 * origin that cannot be named. The only script inside it is the plugin's own
 * bundle — which is who these messages are addressed to — and the relay is
 * reached only after the parent's origin has been pinned above.
 */
export function buildPluginHostFrameDocument(
  nonce: string,
  frameAncestors: readonly string[] = [],
): string {
  const parentOrigins = JSON.stringify([...new Set(frameAncestors)]);
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#app{border:0;height:100%;margin:0;width:100%}iframe{border:0;display:block;height:100%;width:100%}</style></head><body><div id="app"></div><script nonce="${nonce}">(() => {'use strict';
const READY='plugin-host-ready', RESOURCE='plugin-resource-ready';
const allowed=new Set(${parentOrigins}); const opaqueTauri=allowed.has('tauri://localhost'); let host=null;
const postHost=(value)=>{if(host){parent.postMessage(value,host.outboundOrigin);return;} for(const origin of allowed)if(origin!=='tauri://localhost')parent.postMessage(value,origin);if(opaqueTauri)parent.postMessage(value,'*');};
const escape=(value)=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;');
const scriptBytes=(value)=>String(value).replace(/<\\/script/gi,'<\\\\/script');
const styleBytes=(value)=>String(value).replace(/<\\/style/gi,'<\\/style');
const cssTokens=(tokens)=>Object.entries(tokens&&typeof tokens==='object'?tokens:{}).map(([key,value])=>'--'+key.replace(/[^a-zA-Z0-9_-]/g,'')+':'+String(value).replace(/[;{}]/g,'')).join(';');
const DOWN=new Set(['pane-host/confirm-result','pane-host/facts-changed','pane-host/refused']);
let inner=null;
const load=(params={})=>{if(typeof params.runtimeJs!=='string'||typeof params.bundleJs!=='string')return;const frame=document.createElement('iframe');frame.title='Plugin';frame.sandbox.value='allow-scripts';const csp="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";const doc='<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="'+escape(csp)+'"><style>:root{'+cssTokens(params.themeTokens)+'}</style><style>'+styleBytes(params.bundleCss||'')+'</style><script>'+scriptBytes(params.runtimeJs)+'<\\/script><script>'+scriptBytes(params.bundleJs)+'<\\/script></head><body><div id="app"></div></body></html>';frame.srcdoc=doc;document.getElementById('app').replaceChildren(frame);inner=frame;};
addEventListener('message',(event)=>{if(inner&&event.source===inner.contentWindow){postHost(event.data);return;}if(!host){if(!allowed.has(event.origin)&&!(opaqueTauri&&event.origin==='null'))return;host={inboundOrigin:event.origin,outboundOrigin:event.origin==='null'?'*':event.origin};}else if(event.origin!==host.inboundOrigin)return;const method=event.data&&event.data.method;if(method===RESOURCE){load(event.data.params);return;}if(method==='teardown'){document.getElementById('app').replaceChildren();inner=null;return;}if(inner&&DOWN.has(method))inner.contentWindow&&inner.contentWindow.postMessage(event.data,'*');});postHost({method:READY,params:{}});})();</script></body></html>`;
}

export function buildMcpAppsSandboxProxyDocument(
  nonce: string,
  frameAncestors: readonly string[] = [],
): string {
  // This list is derived at server startup, never from the embedding request.
  // Keeping it in the document lets the bridge authenticate the parent without
  // depending on document.referrer, which may be intentionally suppressed.
  const parentOrigins = JSON.stringify([...new Set(frameAncestors)]);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>html,body,#app{border:0;height:100%;margin:0;padding:0;width:100%}iframe{border:0;display:block;height:100%;width:100%}</style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">
    (() => {
      'use strict';
      const READY = 'ui/notifications/sandbox-proxy-ready';
      const RESOURCE = 'ui/notifications/sandbox-resource-ready';
      const allowedParentOrigins = new Set(${parentOrigins});
      const allowsOpaqueTauri = allowedParentOrigins.has('tauri://localhost');
      let host = null;
      let inner = null;

      const isRpc = (value) =>
        value && typeof value === 'object' && value.jsonrpc === '2.0';
      const isReserved = (value) =>
        typeof value?.method === 'string' &&
        value.method.startsWith('ui/notifications/sandbox-');
      const postHost = (value) => {
        if (host) {
          window.parent.postMessage(value, host.outboundOrigin);
          return;
        }
        // The proxy starts the Apps lifecycle before a message from the host can
        // bind its WindowProxy. Send only to the server-derived concrete parent
        // origins; the browser delivers a targetOrigin message only to its exact
        // matching parent. Tauri's opaque origin requires '*'; that exception
        // exists only when the server has explicitly configured its exact
        // tauri://localhost parent origin. It must not depend on referrer
        // metadata, which native WebViews may suppress.
        for (const origin of allowedParentOrigins) {
          if (origin !== 'tauri://localhost') window.parent.postMessage(value, origin);
        }
        if (allowsOpaqueTauri) window.parent.postMessage(value, '*');
      };
      const safeDomains = (domains, protocols = ['https:']) => {
        if (!Array.isArray(domains)) return [];
        return domains.filter((domain) => {
          try { return protocols.includes(new URL(domain).protocol); } catch { return false; }
        });
      };
      const sources = (domains, protocols) => {
        const safe = safeDomains(domains, protocols);
        return safe.length ? safe.join(' ') : "'none'";
      };
      const buildCsp = (csp = {}) => {
        const resources = safeDomains(csp.resourceDomains);
        const withResources = (head) =>
          resources.length ? head + ' ' + resources.join(' ') : head;
        return [
          "default-src 'none'",
          withResources("script-src 'unsafe-inline'"),
          withResources("style-src 'unsafe-inline'"),
          withResources('img-src data:'),
          'font-src data:',
          'connect-src ' + sources(csp.connectDomains, ['https:', 'wss:']),
          'frame-src ' + sources(csp.frameDomains),
          'base-uri ' + sources(csp.baseUriDomains),
          "object-src 'none'",
          "form-action 'none'"
        ].join('; ');
      };
      const escapeAttribute = (value) =>
        value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
      const wrapHtml = (html, csp) => {
        const meta = '<meta http-equiv="Content-Security-Policy" content="' +
          escapeAttribute(csp) + '">';
        // The policy must precede every byte of untrusted markup. Wrapping the
        // raw resource after a host-owned head prevents a script placed before
        // the resource's own <head> from running before CSP takes effect.
        return '<!doctype html><html><head>' + meta +
          '</head><body>' + html + '</body></html>';
      };
      const isPlainObject = (value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value);
      const allowedSandboxTokens = new Set(['allow-scripts']);
      const sandbox = (value) => {
        if (typeof value !== 'string') return 'allow-scripts';
        const tokens = value.split(/\\s+/).filter(Boolean);
        const allowed = tokens.filter((token) => allowedSandboxTokens.has(token));
        return allowed.length ? [...new Set(allowed)].join(' ') : 'allow-scripts';
      };
      const allow = (permissions) => {
        if (!isPlainObject(permissions)) return '';
        const values = [];
        if (isPlainObject(permissions.camera)) values.push('camera');
        if (isPlainObject(permissions.microphone)) values.push('microphone');
        if (isPlainObject(permissions.geolocation)) values.push('geolocation');
        if (isPlainObject(permissions.clipboardWrite)) values.push('clipboard-write');
        return values.join('; ');
      };
      const loadResource = (params = {}) => {
        if (typeof params.html !== 'string') return;
        const frame = document.createElement('iframe');
        frame.title = 'MCP app';
        frame.sandbox.value = sandbox(params.sandbox);
        const permissionPolicy = allow(params.permissions);
        if (permissionPolicy) frame.allow = permissionPolicy;
        frame.srcdoc = wrapHtml(params.html, buildCsp(params.csp));
        document.getElementById('app').replaceChildren(frame);
        inner = frame;
      };

      window.addEventListener('message', (event) => {
        if (!isRpc(event.data)) return;
        if (event.source === window.parent) {
          if (!host) {
            const acceptsOpaqueTauri =
              allowsOpaqueTauri && event.origin === 'null';
            if (!allowedParentOrigins.has(event.origin) && !acceptsOpaqueTauri) return;
            host = {
              inboundOrigin: event.origin,
              outboundOrigin: acceptsOpaqueTauri ? '*' : event.origin,
            };
          }
          if (event.origin !== host.inboundOrigin) return;
          if (event.data.method === RESOURCE) {
            loadResource(event.data.params);
            return;
          }
          if (!isReserved(event.data) && inner?.contentWindow) {
            inner.contentWindow.postMessage(event.data, '*');
          }
          return;
        }
        if (
          inner?.contentWindow &&
          event.source === inner.contentWindow &&
          !isReserved(event.data)
        ) {
          postHost(event.data);
        }
      });

      postHost({ jsonrpc: '2.0', method: READY, params: {} });
    })();
  </script>
</body>
</html>`;
}

export interface MCPUIFrameServer {
  origin: string;
  close: () => Promise<void>;
}

export async function startMcpUiFrameServer(opts: {
  port: number;
  stationPort: number;
  stationHost?: string;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<MCPUIFrameServer | null> {
  const host = '127.0.0.1';
  const app = createMcpUiFrameApp({
    frameAncestors: resolveMcpUiFrameAncestors({
      port: opts.stationPort,
      host: opts.stationHost,
      additionalOrigins: (process.env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    }),
  });
  return new Promise((resolve) => {
    let settled = false;
    try {
      const server = serve(
        { fetch: app.fetch, port: opts.port, hostname: host },
        (info) => {
          if (settled) return;
          settled = true;
          const origin = `http://${host}:${info.port}`;
          opts.logger?.info?.('MCP Apps sandbox proxy listening', { origin });
          resolve({
            origin,
            close: () =>
              new Promise<void>((done) => {
                server.close(() => done());
              }),
          });
        },
      );
      (server as { on?: (e: string, cb: (err: unknown) => void) => void }).on?.(
        'error',
        (error) => {
          if (settled) return;
          settled = true;
          opts.logger?.warn?.(
            'MCP Apps sandbox proxy failed to bind; using opaque-origin render',
            { error: sanitizedTransportError(error) },
          );
          resolve(null);
        },
      );
    } catch (error) {
      if (!settled) {
        settled = true;
        opts.logger?.warn?.('MCP Apps sandbox proxy failed to start', {
          error: sanitizedTransportError(error),
        });
        resolve(null);
      }
    }
  });
}
