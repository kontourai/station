/**
 * E2E: MCP UI Layout
 *
 * Proves mixed project layouts can render a builtin/plugin-compatible tab and
 * an MCP tool UI tab state without requiring an external MCP server.
 */
import { expect, type Page, test } from '@playwright/test';
import { buildMcpAppsSandboxProxyDocument } from '../src-server/runtime/mcp/mcp-ui-frame-server.js';

const stationBaseUrl = process.env.PW_BASE_URL;
if (!stationBaseUrl) {
  throw new Error('PW_BASE_URL is required for MCP UI browser tests.');
}
const STATION_ORIGIN = new URL(stationBaseUrl).origin;

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

const SEED_STORAGE = `
  window.localStorage.setItem('station-connect-connections', JSON.stringify([
    { id: 'c1', name: 'Agent Proof', url: window.location.origin, lastConnected: Date.now() }
  ]));
  window.localStorage.setItem('station-connect-connections-active', 'c1');
  window.localStorage.setItem('lastProject', 'mcp-proof');
  window.localStorage.setItem('lastProjectLayout', 'mixed');
`;

const PROJECT = {
  id: 'project-mcp-proof',
  slug: 'mcp-proof',
  name: 'MCP Proof',
  icon: 'M',
  description: 'Mixed layout proof project',
  hasWorkingDirectory: false,
  layoutCount: 1,
  hasKnowledge: false,
  createdAt: '2026-05-06T00:00:00Z',
  updatedAt: '2026-05-06T00:00:00Z',
};

const LAYOUT_SUMMARY = {
  id: 'layout-mixed',
  slug: 'mixed',
  projectSlug: PROJECT.slug,
  type: 'dashboard',
  name: 'Mixed MCP Layout',
  icon: 'M',
};

const MIXED_LAYOUT = {
  ...LAYOUT_SUMMARY,
  description: 'Builtin plus MCP UI layout tabs',
  config: {
    tabs: [
      {
        id: 'overview',
        label: 'Overview',
        description: 'Builtin tab proves normal layout navigation still works.',
        component: { kind: 'builtin-component', name: 'default' },
      },
      {
        id: 'tool-ui',
        label: 'Tool UI',
        description: 'MCP tab proves resolver-backed states render.',
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
  createdAt: '2026-05-06T00:00:00Z',
  updatedAt: '2026-05-06T00:00:00Z',
};

async function seedRoutes(page: Page) {
  await Promise.all([
    page.addInitScript(SEED_STORAGE),
    page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    ),
    page.route('**/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [PROJECT] }),
      }),
    ),
    page.route('**/api/projects/mcp-proof', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: PROJECT }),
      }),
    ),
    page.route('**/api/projects/mcp-proof/layouts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [LAYOUT_SUMMARY] }),
      }),
    ),
    page.route('**/api/projects/mcp-proof/layouts/mixed', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MIXED_LAYOUT }),
      }),
    ),
    page.route('**/integrations/demo-server/ui/visual-tool', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            status: 'missing_resource',
            ref: 'demo-server/visual-tool',
            serverId: 'demo-server',
            toolName: 'visual-tool',
            reason: 'Mocked tool catalog does not expose UI metadata.',
          },
        }),
      }),
    ),
    page.route('**/api/agents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/layouts', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/plugins', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/branding', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      }),
    ),
    page.route('**/api/auth/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true }),
      }),
    ),
    page.route('**/api/config/app', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { defaultModel: 'claude-sonnet', region: 'us-east-1' },
        }),
      }),
    ),
    page.route('**/api/models/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/events', (route) => route.abort()),
    page.route('**/events', (route) => route.abort()),
  ]);
}

test.describe('MCP UI layout tabs', () => {
  test('renders builtin and MCP tool UI tab states without breaking navigation', async ({
    page,
  }) => {
    await seedRoutes(page);
    // mcpUiHost is on by default; opt out here so a missing_resource shows the
    // inert state (not the read-only embedded fallback) — this test is about
    // navigation + the inert resolver states.
    const configOff = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { defaultModel: 'claude-sonnet', mcpUiHost: false },
      }),
    };
    await page.route('**/config/app', (route) => route.fulfill(configOff));
    await page.route('**/api/config/app', (route) => route.fulfill(configOff));

    await page.goto('/projects/mcp-proof/layouts/mixed');

    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tool UI' })).toBeVisible();
    await expect(page.getByText('Mixed MCP Layout')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open Chat', exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Tool UI' }).click();

    await expect(page.getByText('MCP UI resource missing')).toBeVisible();
    await expect(
      page.getByText('Mocked tool catalog does not expose UI metadata.'),
    ).toBeVisible();
    await expect(page.getByText('ref: demo-server/visual-tool')).toBeVisible();
    await expect(page.getByText('server: demo-server')).toBeVisible();
    await expect(page.getByText('tool: visual-tool')).toBeVisible();

    await page.getByRole('button', { name: 'Overview' }).click();
    await expect(
      page.getByRole('button', { name: 'Open Chat', exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/mcp-proof\/layouts\/mixed/);
  });

  test('renders a resolved MCP UI in a hardened sandboxed iframe when mcpUiHost is on', async ({
    page,
  }) => {
    await seedRoutes(page);

    // Override (later routes win): enable the flag, resolve successfully, and
    // serve resource HTML.
    const configWithFlag = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          defaultModel: 'claude-sonnet',
          region: 'us-east-1',
          mcpUiHost: true,
        },
      }),
    };
    await page.route('**/config/app', (route) => route.fulfill(configWithFlag));
    await page.route('**/api/config/app', (route) =>
      route.fulfill(configWithFlag),
    );
    await page.route(
      '**/integrations/demo-server/ui/visual-tool/resource',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              uri: 'ui://demo-server/visual-tool',
              mimeType: 'text/html',
              text: '<main id="panel">hello from mcp app</main>',
            },
          }),
        }),
    );
    await page.route('**/integrations/demo-server/ui/visual-tool', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            status: 'success',
            ref: 'demo-server/visual-tool',
            serverId: 'demo-server',
            toolName: 'visual-tool',
            resourceUri: 'ui://demo-server/visual-tool',
          },
        }),
      }),
    );

    await page.goto('/projects/mcp-proof/layouts/mixed');
    await page.getByRole('button', { name: 'Tool UI' }).click();

    const frame = page.getByTitle('MCP tool UI: demo-server/visual-tool');
    await expect(frame).toBeVisible();
    // Hardened sandbox: scripts only, NO same-origin.
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts');
    const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
    expect(srcdoc).toContain('hello from mcp app');
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    // The inert "unsupported" notice must not appear when the render is active.
    await expect(page.getByText('MCP UI unsupported')).toBeHidden();
  });

  test('renders through the required different-origin sandbox proxy', async ({
    page,
  }) => {
    await seedRoutes(page);

    // The sandbox proxy must have a browser origin distinct from Station.
    const frameOrigin = 'http://127.0.0.1:9787';
    const configWithFrame = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          defaultModel: 'claude-sonnet',
          region: 'us-east-1',
          mcpUiHost: true,
          mcpUiFrameOrigin: frameOrigin,
        },
      }),
    };
    await page.route('**/config/app', (route) =>
      route.fulfill(configWithFrame),
    );
    await page.route('**/api/config/app', (route) =>
      route.fulfill(configWithFrame),
    );
    await page.route('**/integrations/demo-server/ui/visual-tool', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            status: 'success',
            ref: 'demo-server/visual-tool',
            serverId: 'demo-server',
            toolName: 'visual-tool',
            resourceUri: 'ui://demo-server/visual-tool',
          },
        }),
      }),
    );

    // The host pins and reads the resource before sending it to the proxy.
    let resourceProxied = false;
    await page.route(
      '**/integrations/demo-server/ui/visual-tool/resource',
      (route) => {
        resourceProxied = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              uri: 'ui://demo-server/visual-tool',
              mimeType: 'text/html;profile=mcp-app',
              text: '<!doctype html><html><body><main id="panel">served through sandbox proxy</main></body></html>',
            },
          }),
        });
      },
    );
    // Serve the isolated intermediate proxy, not the app document itself.
    const proxyNonce = 'layout-proxy';
    await page.route(`${frameOrigin}/mcp-ui/proxy`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: buildMcpAppsSandboxProxyDocument(proxyNonce, [STATION_ORIGIN]),
      }),
    );

    await page.goto('/projects/mcp-proof/layouts/mixed');
    await page.getByRole('button', { name: 'Tool UI' }).click();

    const frame = page.getByTitle('MCP tool UI: demo-server/visual-tool');
    await expect(frame).toBeVisible();
    // allow-same-origin is granted ONLY because the origin is verified distinct.
    expect(await frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin',
    );
    expect(await frame.getAttribute('src')).toBe(`${frameOrigin}/mcp-ui/proxy`);
    expect(await frame.getAttribute('srcdoc')).toBeNull();
    // The document loads from the isolated origin into the frame.
    await expect(
      page
        .frameLocator('iframe[title="MCP tool UI: demo-server/visual-tool"]')
        .frameLocator('iframe[title="MCP app"]')
        .locator('#panel'),
    ).toHaveText('served through sandbox proxy');
    expect(resourceProxied).toBe(true);
    await expect(page.getByText('MCP UI unsupported')).toBeHidden();
  });

  test('renders an mcp-ui.dev embedded-dialect server via the read-only embedded fallback', async ({
    page,
  }) => {
    await seedRoutes(page);

    // mcpUiHost on; the layout pins the tool read-only (MIXED_LAYOUT). The
    // resolver finds no SEP-1865 _meta.ui.resourceUri (seedRoutes already
    // returns missing_resource), so the host falls back to the embedded path.
    const configWithFlag = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          defaultModel: 'claude-sonnet',
          region: 'us-east-1',
          mcpUiHost: true,
        },
      }),
    };
    await page.route('**/config/app', (route) => route.fulfill(configWithFlag));
    await page.route('**/api/config/app', (route) =>
      route.fulfill(configWithFlag),
    );

    // The SEP-1865 /resource endpoint must NOT be hit in embedded mode.
    let declaredRead = false;
    await page.route(
      '**/integrations/demo-server/ui/visual-tool/resource',
      (route) => {
        declaredRead = true;
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'no declared uri' }),
        });
      },
    );
    // The embedded endpoint calls the tool and returns its embedded UI.
    await page.route(
      '**/integrations/demo-server/ui/visual-tool/embedded',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              uri: 'ui://demo-server/visual-tool',
              mimeType: 'text/html;profile=mcp-app',
              text: '<main id="panel">embedded mcp-ui.dev panel</main>',
            },
          }),
        }),
    );

    await page.goto('/projects/mcp-proof/layouts/mixed');
    await page.getByRole('button', { name: 'Tool UI' }).click();

    const frame = page.getByTitle('MCP tool UI: demo-server/visual-tool');
    await expect(frame).toBeVisible();
    // Embedded dialect is opaque-origin srcdoc only.
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts');
    const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
    expect(srcdoc).toContain('embedded mcp-ui.dev panel');
    expect(srcdoc).toContain("default-src 'none'");
    expect(declaredRead).toBe(false);
    await expect(page.getByText('MCP UI resource missing')).toBeHidden();
  });
});
