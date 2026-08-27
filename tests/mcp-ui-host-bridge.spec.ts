/**
 * E2E: MCP-UI host bridge handshake (real AppBridge ↔ App).
 *
 * The other MCP-UI specs prove the resolver states and the hardened iframe
 * render. This one proves the *bridge* actually works in a real browser: we
 * serve resource HTML running the genuine `App` View client (bundled inline —
 * no external fetch), let it perform the `ui/initialize` handshake and, via
 * `autoResize`, emit a real `notifications/size-changed`. The host's
 * `onsizechange` must then grow the iframe past its default height. If the
 * handshake silently failed the height would stay at the default and this test
 * would catch it.
 *
 * The fixture runs through Station's different-origin sandbox proxy, not the
 * static srcdoc fallback. The proxy receives the raw resource only after its
 * ready notification and mounts it in an opaque inner frame.
 *
 * The proxy applies the same resource-policy construction used in production.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';
import { buildMcpAppsSandboxProxyDocument } from '../src-server/runtime/mcp/mcp-ui-frame-server.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The View runs the genuine client: connect() performs the ui/initialize
// handshake, and the App's default autoResize reports the document's height
// back to the host via notifications/size-changed. The fixture body is sized to
// 720px, so a working handshake must grow the iframe well past its 360 default.
const VIEW_SOURCE = `
  import { App } from '@modelcontextprotocol/ext-apps';
  const app = new App({ name: 'station-e2e-view', version: '1.0.0' }, {});
  app.connect().catch(() => {});
`;

const FRAME_ORIGIN = 'http://127.0.0.1:9788';
const stationBaseUrl = process.env.PW_BASE_URL;
if (!stationBaseUrl) {
  throw new Error('PW_BASE_URL is required for MCP UI browser tests.');
}
const STATION_ORIGIN = new URL(stationBaseUrl).origin;

let viewScript = '';

test.beforeAll(async () => {
  // Bundle the genuine View client to a self-contained inline IIFE (faithful to
  // the installed ext-apps version — no committed blob to drift).
  const result = await build({
    stdin: { contents: VIEW_SOURCE, resolveDir: REPO_ROOT, loader: 'js' },
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    platform: 'browser',
  });
  viewScript = result.outputFiles[0].text;
  expect(viewScript.length).toBeGreaterThan(1000);
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
  id: 'project-bridge-proof',
  slug: 'bridge-proof',
  name: 'Bridge Proof',
  icon: 'B',
  description: 'MCP-UI bridge handshake proof project',
  hasWorkingDirectory: false,
  layoutCount: 1,
  hasKnowledge: false,
  createdAt: '2026-06-16T00:00:00Z',
  updatedAt: '2026-06-16T00:00:00Z',
};

const LAYOUT_SUMMARY = {
  id: 'layout-bridge',
  slug: 'bridge',
  projectSlug: PROJECT.slug,
  type: 'dashboard',
  name: 'Bridge Layout',
  icon: 'B',
};

const BRIDGE_LAYOUT = {
  ...LAYOUT_SUMMARY,
  description: 'A single MCP tool UI tab that speaks the host bridge.',
  config: {
    tabs: [
      {
        id: 'tool-ui',
        label: 'Tool UI',
        description: 'Live MCP UI view that performs the host handshake.',
        component: {
          kind: 'mcp-tool-ui',
          ref: 'demo-server/visual-tool',
          displayMode: 'inline',
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
  window.localStorage.setItem('lastProject', 'bridge-proof');
  window.localStorage.setItem('lastProjectLayout', 'bridge');
`;

function jsonRoute(data: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

async function seedRoutes(page: Page) {
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
    page.route('**/api/projects/bridge-proof', (r) =>
      r.fulfill(jsonRoute({ success: true, data: PROJECT })),
    ),
    page.route('**/api/projects/bridge-proof/layouts', (r) =>
      r.fulfill(jsonRoute({ success: true, data: [LAYOUT_SUMMARY] })),
    ),
    page.route('**/api/projects/bridge-proof/layouts/bridge', (r) =>
      r.fulfill(jsonRoute({ success: true, data: BRIDGE_LAYOUT })),
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
            // A 720px-tall body so the App's autoResize reports a height the
            // host must grow to (well past its 360px default).
            text: `<!doctype html><html><head></head><body style="margin:0"><main id="panel" style="height:720px">live mcp app</main><script>${viewScript}</script></body></html>`,
          },
        }),
      ),
    ),
    page.route(`${FRAME_ORIGIN}/mcp-ui/proxy`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'text/html',
        body: buildMcpAppsSandboxProxyDocument('bridge-proxy', [
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
}

test.describe('MCP-UI host bridge', () => {
  test('completes the initialize handshake and resizes the iframe from a real size-changed', async ({
    page,
  }) => {
    await seedRoutes(page);

    await page.goto('/projects/bridge-proof/layouts/bridge');
    await page.getByRole('button', { name: 'Tool UI' }).click();

    const frame = page.getByTitle('MCP tool UI: demo-server/visual-tool');
    await expect(frame).toBeVisible();

    // The host starts the iframe at its 360px default. A completed handshake +
    // the View's autoResize size-changed must drive the host to set the iframe's
    // height to the 720px body. We assert the inline style the host writes (the
    // value it received over the bridge) rather than the rendered box, which the
    // surrounding layout may clamp.
    await expect
      .poll(
        () =>
          frame.evaluate((el) =>
            Number.parseInt((el as HTMLIFrameElement).style.height || '0', 10),
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(600);
  });
});
