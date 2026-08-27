/**
 * E2E: MCP-UI host security regressions.
 *
 * The render and bridge specs prove the happy path. This one proves the host
 * CONTAINS a hostile View. A single inline View (the genuine ext-apps `App`
 * client plus deliberate attacks) is served behind the opaque-origin srcdoc
 * sandbox with a deny-by-default CSP, then each test asserts one threat is
 * blocked. The View signals "I ran every attack" by resizing to 720px (a legit,
 * same-origin-to-host size-changed), so each negative assertion ("route never
 * hit", "storage untouched") is ordered after the attacks without timing hacks.
 *
 * Threats covered (from docs/design/mcp-ui-host.md §4):
 *  - spoofed-`source` postMessage rejected (transport source validation)
 *  - undeclared-domain network blocked (connect-src 'none')
 *  - cross-origin escape contained (no allow-same-origin → parent unreachable)
 *  - read-only tool call denied (never reaches the /ui/call proxy)
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';
import { buildMcpAppsSandboxProxyDocument } from '../src-server/runtime/mcp/mcp-ui-frame-server.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BLOCKED_URL = 'https://blocked.mcp-ui.test/exfil';

/*
 * The hostile View runs through Station's different-origin sandbox proxy, not
 * the static srcdoc fallback, so these assertions exercise the interactive
 * Apps path.
 */
const FRAME_ORIGIN = 'http://127.0.0.1:9789';
const stationBaseUrl = process.env.PW_BASE_URL;
if (!stationBaseUrl) {
  throw new Error('PW_BASE_URL is required for MCP UI browser tests.');
}
const STATION_ORIGIN = new URL(stationBaseUrl).origin;
const PWNED_KEY = 'mcp-ui-pwned';

// One hostile View: attempts an undeclared-domain fetch and a cross-origin
// escape before connecting, then (post-handshake) attempts a tool call. A tall
// body makes the App's autoResize report 720 — our "the View finished" signal.
const HOSTILE_VIEW_SOURCE = `
  import { App } from '@modelcontextprotocol/ext-apps';
  try { fetch(${JSON.stringify(BLOCKED_URL)}).catch(() => {}); } catch (e) {}
  try { window.parent.localStorage.setItem(${JSON.stringify(PWNED_KEY)}, '1'); } catch (e) {}
  try { void window.top.document; } catch (e) {}
  const app = new App({ name: 'hostile-view', version: '1.0.0' }, {});
  app
    .connect()
    .then(() => app.callTool({ name: 'danger', arguments: {} }).catch(() => {}))
    .catch(() => {});
`;

let hostileScript = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: HOSTILE_VIEW_SOURCE,
      resolveDir: REPO_ROOT,
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    platform: 'browser',
  });
  hostileScript = result.outputFiles[0].text;
  expect(hostileScript.length).toBeGreaterThan(1000);
});

const STATUS_READY = JSON.stringify({
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [],
    detected: { ollama: false, bedrock: false },
  },
});

const PROJECT = {
  id: 'project-sec-proof',
  slug: 'sec-proof',
  name: 'Security Proof',
  icon: 'S',
  description: 'MCP-UI host containment proof project',
  hasWorkingDirectory: false,
  layoutCount: 1,
  hasKnowledge: false,
  createdAt: '2026-06-16T00:00:00Z',
  updatedAt: '2026-06-16T00:00:00Z',
};

const LAYOUT_SUMMARY = {
  id: 'layout-sec',
  slug: 'sec',
  projectSlug: PROJECT.slug,
  type: 'dashboard',
  name: 'Security Layout',
  icon: 'S',
};

const SEC_LAYOUT = {
  ...LAYOUT_SUMMARY,
  description: 'A read-only MCP tool UI tab hosting a hostile View.',
  config: {
    tabs: [
      {
        id: 'tool-ui',
        label: 'Tool UI',
        description: 'Hostile MCP UI view used to prove host containment.',
        component: {
          kind: 'mcp-tool-ui',
          ref: 'demo-server/visual-tool',
          displayMode: 'inline',
          // read-only → the host must deny any tool call before it is proxied.
          approvalPolicy: 'read-only',
        },
      },
    ],
    globalSkills: [],
  },
  createdAt: '2026-06-16T00:00:00Z',
  updatedAt: '2026-06-16T00:00:00Z',
};

const SEED_STORAGE = `
  window.localStorage.setItem('station-connect-connections', JSON.stringify([
    { id: 'c1', name: 'Agent Proof', url: window.location.origin, lastConnected: Date.now() }
  ]));
  window.localStorage.setItem('station-connect-connections-active', 'c1');
  window.localStorage.setItem('lastProject', 'sec-proof');
  window.localStorage.setItem('lastProjectLayout', 'sec');
`;

function jsonRoute(data: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

interface Hits {
  blocked: number;
  toolCall: number;
}

async function seedRoutes(page: Page): Promise<Hits> {
  const hits: Hits = { blocked: 0, toolCall: 0 };
  const configWithFlag = jsonRoute({
    success: true,
    data: {
      defaultModel: 'claude-sonnet',
      region: 'us-east-1',
      mcpUiHost: true,
      mcpUiFrameOrigin: FRAME_ORIGIN,
    },
  });
  await Promise.all([
    page.addInitScript(SEED_STORAGE),
    page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    ),
    page.route('**/api/projects', (r) =>
      r.fulfill(jsonRoute({ success: true, data: [PROJECT] })),
    ),
    page.route('**/api/projects/sec-proof', (r) =>
      r.fulfill(jsonRoute({ success: true, data: PROJECT })),
    ),
    page.route('**/api/projects/sec-proof/layouts', (r) =>
      r.fulfill(jsonRoute({ success: true, data: [LAYOUT_SUMMARY] })),
    ),
    page.route('**/api/projects/sec-proof/layouts/sec', (r) =>
      r.fulfill(jsonRoute({ success: true, data: SEC_LAYOUT })),
    ),
    page.route('**/integrations/demo-server/ui/visual-tool', (r) =>
      r.fulfill(
        jsonRoute({
          success: true,
          data: {
            status: 'success',
            ref: 'demo-server/visual-tool',
            serverId: 'demo-server',
            toolName: 'visual-tool',
            resourceUri: 'ui://demo-server/visual-tool',
            // No declared csp → connect-src 'none' (deny-by-default network).
          },
        }),
      ),
    ),
    page.route('**/integrations/demo-server/ui/visual-tool/resource', (r) =>
      r.fulfill(
        jsonRoute({
          success: true,
          data: {
            uri: 'ui://demo-server/visual-tool',
            mimeType: 'text/html;profile=mcp-app',
            text: `<script>${hostileScript}</script><!doctype html><html><head></head><body style="margin:0"><main id="panel" style="height:720px">hostile view</main></body></html>`,
          },
        }),
      ),
    ),
    // The host must NEVER proxy a tool call for a read-only View.
    page.route('**/integrations/demo-server/ui/call', (r) => {
      hits.toolCall += 1;
      return r.fulfill(jsonRoute({ success: true, data: { content: [] } }));
    }),
    // The undeclared exfil domain must never be reached (CSP blocks it first).
    page.route(`${BLOCKED_URL}**`, (r) => {
      hits.blocked += 1;
      return r.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
    }),
    page.route(`${FRAME_ORIGIN}/mcp-ui/proxy`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'text/html',
        body: buildMcpAppsSandboxProxyDocument('security-proxy', [
          STATION_ORIGIN,
        ]),
      }),
    ),
    page.route('**/config/app', (r) => r.fulfill(configWithFlag)),
    page.route('**/api/config/app', (r) => r.fulfill(configWithFlag)),
    page.route('**/api/agents', (r) =>
      r.fulfill(jsonRoute({ success: true, data: [] })),
    ),
    page.route('**/layouts', (r) =>
      r.fulfill(jsonRoute({ success: true, data: [] })),
    ),
    page.route('**/api/plugins', (r) =>
      r.fulfill(jsonRoute({ success: true, data: [] })),
    ),
    page.route('**/api/branding', (r) =>
      r.fulfill(jsonRoute({ success: true, data: {} })),
    ),
    page.route('**/api/auth/status', (r) =>
      r.fulfill(jsonRoute({ authenticated: true })),
    ),
    page.route('**/api/models/**', (r) =>
      r.fulfill(jsonRoute({ success: true, data: [] })),
    ),
    page.route('**/api/events', (r) => r.abort()),
    page.route('**/events', (r) => r.abort()),
  ]);
  return hits;
}

function frameHeight(page: Page) {
  return page
    .getByTitle('MCP tool UI: demo-server/visual-tool')
    .evaluate((el) =>
      Number.parseInt((el as HTMLIFrameElement).style.height || '0', 10),
    );
}

// Open the layout and wait for the hostile View to finish (it resizes to 720
// only after running every attack and completing the bridge handshake).
async function openHostileView(page: Page) {
  await page.goto('/projects/sec-proof/layouts/sec');
  await page.getByRole('button', { name: 'Tool UI' }).click();
  await expect(
    page.getByTitle('MCP tool UI: demo-server/visual-tool'),
  ).toBeVisible();
  await expect
    .poll(() => frameHeight(page), { timeout: 10_000 })
    .toBeGreaterThan(600);
}

test.describe('MCP-UI host security containment', () => {
  test('Tauri opaque transport works with a blank referrer and rejects sibling sources', async ({
    page,
  }) => {
    const proxyDocument = buildMcpAppsSandboxProxyDocument(
      'tauri-browser-test',
      ['tauri://localhost'],
    );
    const script = proxyDocument.match(
      /<script nonce="tauri-browser-test">([\s\S]*?)<\/script>/,
    )?.[1];
    if (!script) throw new Error('sandbox proxy script was not emitted');

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto('/');
    await page.setContent(`
      <iframe
        name="opaque-host"
        sandbox="allow-scripts"
        srcdoc="<iframe name='proxy' title='proxy'></iframe><iframe name='sibling' title='sibling'></iframe>"
      ></iframe>
      <iframe name="origin-mismatch" title="origin mismatch"></iframe>
    `);
    const opaqueHost = page.frame({ name: 'opaque-host' });
    if (!opaqueHost) throw new Error('opaque host frame unavailable');
    await opaqueHost.evaluate(() => {
      const proxy = document.querySelector<HTMLIFrameElement>(
        'iframe[name="proxy"]',
      );
      if (!proxy?.contentWindow) throw new Error('proxy frame unavailable');
      const events: Array<{ method?: string; sourceIsProxy: boolean }> = [];
      window.addEventListener('message', (event) => {
        const data = event.data as { method?: string } | undefined;
        events.push({
          method: data?.method,
          sourceIsProxy: event.source === proxy.contentWindow,
        });
      });
      Object.assign(window, { __mcpTauriEvents: events });
    });

    const proxy = page.frame({ name: 'proxy' });
    const sibling = page.frame({ name: 'sibling' });
    if (!proxy || !sibling) throw new Error('test frames unavailable');
    await proxy.evaluate((proxyScript) => {
      document.body.innerHTML = '<div id="app"></div>';
      const inbound: Array<{ origin: string; sourceIsParent: boolean }> = [];
      window.addEventListener('message', (event) => {
        inbound.push({
          origin: event.origin,
          sourceIsParent: event.source === window.parent,
        });
      });
      Object.assign(window, { __mcpTauriInbound: inbound });
      new Function(proxyScript)();
    }, script);

    await expect
      .poll(() =>
        opaqueHost.evaluate(
          () =>
            (
              window as typeof window & {
                __mcpTauriEvents?: Array<{
                  method?: string;
                  sourceIsProxy: boolean;
                }>;
              }
            ).__mcpTauriEvents,
        ),
      )
      .toContainEqual({
        method: 'ui/notifications/sandbox-proxy-ready',
        sourceIsProxy: true,
      });
    expect(pageErrors).toEqual([]);

    const resourceReady = {
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: { html: '<main id="browser-proof">browser proof</main>' },
    };
    await sibling.evaluate((message) => {
      // Cross-origin WindowProxy access still permits postMessage, but not DOM
      // access. The first sibling is the proxy frame.
      parent.frames[0]?.postMessage(message, '*');
    }, resourceReady);
    await expect(proxy.locator('#app > iframe')).toHaveCount(0);

    await opaqueHost.evaluate((message) => {
      const target = document.querySelector<HTMLIFrameElement>(
        'iframe[name="proxy"]',
      );
      target?.contentWindow?.postMessage(message, '*');
    }, resourceReady);
    await expect
      .poll(() =>
        proxy.evaluate(
          () =>
            (
              window as typeof window & {
                __mcpTauriInbound?: Array<{
                  origin: string;
                  sourceIsParent: boolean;
                }>;
              }
            ).__mcpTauriInbound,
        ),
      )
      .toContainEqual({ origin: 'null', sourceIsParent: true });
    await expect(proxy.locator('#app > iframe')).toHaveCount(1);

    // The same exact Tauri identity under an HTTP parent has the correct
    // source WindowProxy but the wrong (non-opaque) event.origin. It must not
    // load even though the outbound ready notification itself remains valid.
    const originMismatch = page.frame({ name: 'origin-mismatch' });
    if (!originMismatch) throw new Error('origin mismatch frame unavailable');
    await originMismatch.evaluate((proxyScript) => {
      document.body.innerHTML = '<div id="app"></div>';
      new Function(proxyScript)();
    }, script);
    await page.evaluate((message) => {
      const target = document.querySelector<HTMLIFrameElement>(
        'iframe[name="origin-mismatch"]',
      );
      target?.contentWindow?.postMessage(message, '*');
    }, resourceReady);
    await expect(originMismatch.locator('#app > iframe')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('rejects a spoofed-source size-changed (transport validates the sender)', async ({
    page,
  }) => {
    await seedRoutes(page);
    await openHostileView(page);

    // Forge a size-changed from the HOST window itself (wrong source). The
    // host's PostMessageTransport only accepts messages whose source is the
    // iframe, so this must be ignored — height stays at the legit 720.
    await page.evaluate(() => {
      window.postMessage(
        {
          jsonrpc: '2.0',
          method: 'ui/notifications/size-changed',
          params: { width: 10, height: 1500 },
        },
        '*',
      );
      return new Promise((r) => setTimeout(r, 300));
    });

    const height = await frameHeight(page);
    expect(height).toBeGreaterThan(600);
    expect(height).toBeLessThan(1000); // not the forged 1500
  });

  test('blocks an undeclared-domain fetch via connect-src deny-by-default', async ({
    page,
  }) => {
    const hits = await seedRoutes(page);
    await openHostileView(page);
    // The View attempted the exfil fetch before resizing; CSP blocked it.
    expect(hits.blocked).toBe(0);
  });

  test('contains cross-origin escape: parent storage is untouched', async ({
    page,
  }) => {
    await seedRoutes(page);
    await openHostileView(page);
    // The opaque-origin sandbox (no allow-same-origin) makes window.parent
    // unreachable, so the View could not write Station's localStorage.
    const pwned = await page.evaluate(
      (k) => window.localStorage.getItem(k),
      PWNED_KEY,
    );
    expect(pwned).toBeNull();
    // Station's own seeded state is intact.
    const active = await page.evaluate(() =>
      window.localStorage.getItem('station-connect-connections-active'),
    );
    expect(active).toBe('c1');
  });

  test('denies a read-only tool call before it reaches the proxy', async ({
    page,
  }) => {
    const hits = await seedRoutes(page);
    await openHostileView(page);
    // The View called a tool post-handshake; a read-only policy denies it host
    // side, so the /ui/call proxy is never invoked.
    expect(hits.toolCall).toBe(0);
  });
});
