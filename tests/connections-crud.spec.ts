import { devices, expect, type Page, test } from '@playwright/test';
import { contrastRatio } from './helpers/color-contrast';
import { E2E_STATION_COMPATIBILITY } from './helpers/current-station-contract';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';
import { installVisualViewportFixture } from './helpers/visual-viewport';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

type ModelConnection = {
  id: string;
  kind: 'model';
  type: string;
  name: string;
  enabled: boolean;
  capabilities: string[];
  config: Record<string, unknown>;
  status: string;
  prerequisites: unknown[];
  lastCheckedAt: string | null;
};

type RuntimeConnection = {
  id: string;
  kind: 'agent';
  type: string;
  name: string;
  description: string;
  enabled: boolean;
  capabilities: string[];
  config: Record<string, unknown>;
  status: string;
  prerequisites: unknown[];
  setup: {
    state: 'ready' | 'configured' | 'available';
    detected: boolean;
    configured: boolean;
  };
  runtimeCatalog: {
    source: string;
    reason?: string;
    models: Array<{ id: string; name: string }>;
    builtInModels: Array<{ id: string; name: string }>;
  };
  readinessEvidence?: {
    evidenceVersion: 1;
    level:
      | 'discovered'
      | 'prerequisite-ready'
      | 'catalog-ready'
      | 'smoke-passed';
    observedAt: string;
    freshness: 'fresh' | 'stale' | 'unknown';
    summary: string;
    action?: string;
    smoke: {
      status: 'not-tested' | 'passed' | 'failed';
      freshness: 'fresh' | 'stale' | 'unknown';
      reason?: string;
      action?: string;
      turnLimit: 1;
    };
  };
};

type Integration = {
  id: string;
  kind: 'mcp';
  transport: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  displayName: string;
  description: string;
  connected?: boolean;
};

async function seedConnectionsRoutes(page: Page) {
  await page.addInitScript(() => {
    // The fixture models an already-operating Station. Its focused connection
    // assertions must not be obscured by the unrelated first-run engine picker.
    localStorage.setItem('station:onboarding-setup-dismissed', '1');
  });
  const state: {
    models: ModelConnection[];
    runtimes: RuntimeConnection[];
    integrations: Integration[];
    acpInstalled: boolean;
    customACPConnections: Array<{
      id: string;
      name: string;
      command: string;
      args: string[];
      enabled: boolean;
      status: string;
      source: 'user';
      slashCommands: string[];
    }>;
  } = {
    acpInstalled: false,
    customACPConnections: [],
    models: [
      {
        id: 'ollama-local',
        kind: 'model',
        type: 'ollama',
        name: 'Local Ollama',
        enabled: true,
        capabilities: ['llm'],
        config: { baseUrl: 'http://localhost:11434' },
        status: 'ready',
        prerequisites: [],
        lastCheckedAt: null,
      },
    ],
    runtimes: [
      {
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex',
        name: 'Codex Runtime',
        description: 'Connected runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          executionClass: 'connected',
          providerLabel: 'Codex Runtime',
          defaultModel: 'codex-mini',
        },
        status: 'ready',
        prerequisites: [],
        setup: { state: 'ready', detected: true, configured: false },
        runtimeCatalog: {
          source: 'static',
          reason: 'Mock runtime catalog',
          models: [{ id: 'codex-mini', name: 'Codex Mini' }],
          builtInModels: [],
        },
        readinessEvidence: {
          evidenceVersion: 1,
          level: 'catalog-ready',
          observedAt: '2026-07-13T12:00:00.000Z',
          freshness: 'fresh',
          summary: 'Live model catalog loaded.',
          smoke: {
            status: 'not-tested',
            freshness: 'unknown',
            turnLimit: 1,
          },
        },
      },
      {
        id: 'claude-runtime',
        kind: 'agent',
        type: 'claude',
        name: 'Claude Code',
        description: 'Detected locally; login is still required.',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          executionClass: 'connected',
          providerLabel: 'Claude',
          defaultModel: '',
        },
        status: 'missing_prerequisites',
        prerequisites: [
          {
            id: 'claude-cli',
            name: 'Claude CLI',
            status: 'installed',
          },
          {
            id: 'claude-auth',
            name: 'Claude login',
            status: 'missing',
          },
        ],
        setup: { state: 'available', detected: true, configured: false },
        runtimeCatalog: {
          source: 'none',
          models: [],
          builtInModels: [],
        },
      },
    ],
    integrations: [
      {
        id: 'filesystem-tools',
        kind: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/filesystem-tools'],
        displayName: 'Filesystem Tools',
        description: 'Local filesystem helpers',
        connected: false,
      },
    ],
  };

  await page.route('**/.well-known/station/v1', (route) =>
    route.fulfill(
      json({
        schemaVersion: 1,
        environmentId: ENVIRONMENT_ID,
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
        compatibility: E2E_STATION_COMPATIBILITY,
      }),
    ),
  );

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/system/identity') {
      await route.fulfill(
        json({
          environmentId: ENVIRONMENT_ID,
          instanceId: 'connections-crud-fixture',
          bootId: 'connections-crud-boot',
          sha: '1111111111111111111111111111111111111111',
        }),
      );
      return;
    }

    if (path === '/api/system/status') {
      await route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          developerServices: [
            {
              id: 'git',
              name: 'Git',
              state: 'ready',
              detail: 'Installed on this Station host.',
            },
            {
              id: 'github',
              name: 'GitHub',
              state: 'sign_in_required',
              detail:
                'The command-line tool is installed, but GitHub is not signed in.',
              command: 'gh auth login',
            },
            {
              id: 'gitlab',
              name: 'GitLab',
              state: 'not_installed',
              detail:
                'GitLab needs its command-line tool on this Station host.',
              command: 'Install GitLab CLI: https://gitlab.com/gitlab-org/cli',
            },
          ],
          providers: {
            configuredChatReady: true,
            configured: [
              {
                id: 'ollama-local',
                type: 'ollama',
                enabled: true,
                capabilities: ['llm'],
              },
            ],
            detected: { ollama: true, bedrock: false },
          },
          capabilities: {
            chat: {
              ready: true,
              source: 'ollama-local',
            },
          },
          recommendation: {
            code: 'configured-chat-ready',
            type: 'providers',
            actionLabel: 'Manage Connections',
            title: 'Connections ready',
            detail: 'Mocked connection inventory',
          },
        }),
      );
      return;
    }

    if (path === '/api/system/capabilities') {
      await route.fulfill(
        json({
          runtime: 'voltagent',
          voice: { stt: [], tts: [] },
          context: { providers: [] },
          scheduler: true,
        }),
      );
      return;
    }

    if (path === '/api/auth/status') {
      await route.fulfill(json({ authenticated: true, user: null }));
      return;
    }

    if (path === '/api/branding') {
      await route.fulfill(json({ success: true, data: {} }));
      return;
    }

    if (path === '/config/app') {
      await route.fulfill(
        json({
          success: true,
          data: { defaultModel: 'codex-mini', region: 'us-east-1' },
        }),
      );
      return;
    }

    if (path === '/api/agents') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }

    if (path === '/api/projects') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }

    if (path === '/api/models') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }

    if (path === '/api/knowledge/status') {
      await route.fulfill(
        json({
          success: true,
          data: {
            vectorDb: null,
            embedding: null,
            stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
          },
        }),
      );
      return;
    }

    if (path === '/api/connections' && method === 'GET') {
      await route.fulfill(
        json({ success: true, data: [...state.models, ...state.runtimes] }),
      );
      return;
    }

    if (path === '/api/connections' && method === 'POST') {
      const body = route.request().postDataJSON() as ModelConnection;
      state.models.push(body);
      await route.fulfill(json({ success: true, data: body }));
      return;
    }

    if (path === '/api/connections/models') {
      await route.fulfill(json({ success: true, data: state.models }));
      return;
    }

    if (path === '/api/connections/agents') {
      await route.fulfill(json({ success: true, data: state.runtimes }));
      return;
    }

    const connectionMatch = path.match(
      /^\/api\/connections\/([^/]+)(?:\/test)?$/,
    );
    if (connectionMatch) {
      const id = decodeURIComponent(connectionMatch[1]);
      const isTest = path.endsWith('/test');
      const existingModel = state.models.find((entry) => entry.id === id);
      const existingRuntime = state.runtimes.find((entry) => entry.id === id);

      if (isTest && method === 'POST') {
        await route.fulfill(
          json({
            success: true,
            data: { healthy: true, status: 'ready' },
          }),
        );
        return;
      }

      if (method === 'GET') {
        const connection = existingModel ?? existingRuntime;
        if (!connection) {
          await route.fulfill(
            json({ success: false, error: 'Not found' }, 404),
          );
          return;
        }
        await route.fulfill(json({ success: true, data: connection }));
        return;
      }

      if (method === 'PUT') {
        const body = route.request().postDataJSON() as
          | ModelConnection
          | RuntimeConnection;
        if (existingModel) {
          Object.assign(existingModel, body);
          await route.fulfill(json({ success: true, data: existingModel }));
          return;
        }
        if (existingRuntime) {
          Object.assign(existingRuntime, body);
          await route.fulfill(json({ success: true, data: existingRuntime }));
          return;
        }
      }

      if (method === 'DELETE' && existingRuntime) {
        existingRuntime.name = 'Codex Runtime';
        existingRuntime.enabled = true;
        await route.fulfill(json({ success: true, data: existingRuntime }));
        return;
      }

      if (method === 'DELETE' && existingModel) {
        state.models = state.models.filter((entry) => entry.id !== id);
        await route.fulfill(json({ success: true }));
        return;
      }
    }

    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route('**/integrations**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/integrations' && method === 'GET') {
      await route.fulfill(json({ success: true, data: state.integrations }));
      return;
    }

    if (path === '/integrations' && method === 'POST') {
      const body = route.request().postDataJSON() as Integration;
      state.integrations.push(body);
      await route.fulfill(json({ success: true, data: body }));
      return;
    }

    const integrationMatch = path.match(
      /^\/integrations\/([^/]+)(?:\/reconnect)?$/,
    );
    if (integrationMatch) {
      const id = decodeURIComponent(integrationMatch[1]);
      const existing = state.integrations.find((entry) => entry.id === id);

      if (path.endsWith('/reconnect') && method === 'POST') {
        if (existing) existing.connected = true;
        await route.fulfill(json({ success: true }));
        return;
      }

      if (method === 'GET') {
        if (!existing) {
          await route.fulfill(
            json({ success: false, error: 'Not found' }, 404),
          );
          return;
        }
        await route.fulfill(json({ success: true, data: existing }));
        return;
      }

      if (method === 'PUT') {
        const body = route.request().postDataJSON() as Integration;
        if (existing) {
          Object.assign(existing, body);
          await route.fulfill(json({ success: true, data: existing }));
          return;
        }
      }

      if (method === 'DELETE') {
        state.integrations = state.integrations.filter(
          (entry) => entry.id !== id,
        );
        await route.fulfill(json({ success: true }));
        return;
      }
    }

    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route('**/acp/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/acp/connections' && route.request().method() === 'GET') {
      await route.fulfill(
        json({
          success: true,
          data: [
            ...(state.acpInstalled
              ? [
                  {
                    id: 'kiro',
                    name: 'Kiro CLI',
                    command: 'kiro',
                    args: ['--acp'],
                    enabled: true,
                    status: 'available',
                    source: 'user' as const,
                    slashCommands: [],
                  },
                ]
              : []),
            ...state.customACPConnections,
          ],
        }),
      );
      return;
    }

    if (path === '/acp/connections' && route.request().method() === 'POST') {
      const draft = route.request().postDataJSON() as {
        id: string;
        name?: string;
        command: string;
        args?: string[];
      };
      const connection = {
        id: draft.id,
        name: draft.name || draft.id,
        command: draft.command,
        args: draft.args ?? [],
        enabled: true,
        status: 'available',
        source: 'user' as const,
        slashCommands: [],
      };
      state.customACPConnections.push(connection);
      await route.fulfill(json({ success: true, data: connection }));
      return;
    }

    if (path === '/acp/registry') {
      await route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'kiro',
              name: 'Kiro CLI',
              command: 'kiro',
              args: ['--acp'],
              description: 'Connect Kiro through ACP',
              installed: state.acpInstalled,
              detected: true,
            },
            {
              id: 'opencode',
              name: 'OpenCode',
              command: 'opencode',
              args: ['acp'],
              description: 'Connect OpenCode through ACP',
              installed: false,
              detected: false,
            },
          ],
        }),
      );
      return;
    }

    if (path === '/acp/registry/kiro/install') {
      state.acpInstalled = true;
      await route.fulfill(
        json({
          success: true,
          data: {
            id: 'kiro',
            name: 'Kiro CLI',
            command: 'kiro',
            args: ['--acp'],
            enabled: true,
          },
        }),
      );
      return;
    }

    await route.fulfill(json({ success: true, data: [] }));
  });
}

async function fillStable(page: Page, selector: string, value: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const locator = page.locator(selector).first();
    try {
      await locator.fill(value, { timeout: 1000 });
      if ((await locator.inputValue().catch(() => '')) === value) {
        return;
      }
    } catch {}
    await locator.waitFor({ state: 'visible', timeout: 1000 }).catch(() => {});
  }

  throw new Error(`Failed to fill stable input: ${selector}`);
}

test.describe('Connections CRUD', () => {
  test.beforeEach(async ({ page }) => {
    await seedConnectionsRoutes(page);
  });

  /**
   * `connections hub renders core sections` is deleted, not rewritten: the hub
   * it described is gone. `/connections` is a resolver that redirects into one
   * of five sections (`views/ConnectionsHub.tsx:14-21`,
   * `views/connections-hub/connection-sections.ts`), and
   * `tests/connections-sections.spec.ts` owns what replaced it — the resolver
   * and legacy redirects (`:284`), each section's H1, eyebrow and single add
   * action (`:308`), and the engine rows' names and states (`:491`).
   *
   * Its Developer-services half has no replacement anywhere, because it has no
   * surface: `grep -rn developerServices src-ui` returns nothing, while
   * `src-server/routes/system/system-status-routes.ts:118,705` still computes
   * and serves the field. The probe CLASSIFICATION stays covered by
   * `src-server/routes/system/__tests__/developer-services.test.ts`; the
   * state -> detail/command shaping is a private closure with no reader, and a
   * new export purely to test an unrendered field would be the wrong repair.
   * Recorded as a gap rather than papered over.
   */

  test('offers one detected-server entry on Models, and it routes into the add flow prefilled', async ({
    page,
  }) => {
    // Connections-onboarding §1: detection is for infrastructure, never
    // secrets. A local Ollama server is detected but has no connection yet.
    await page.route('**/api/connections', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    );
    // The detected panel renders only inside the section's empty content and
    // only while no Ollama connection exists (`views/ProviderSettingsView.tsx`),
    // so the MODELS list has to be empty too — the seed still served one here,
    // which is why the old locator matched a list row as well as a card.
    await page.route('**/api/connections/models', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    );
    await page.route('**/api/system/status', (route) =>
      route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configuredChatReady: false,
            configured: [],
            detected: { ollama: true, bedrock: false },
          },
          capabilities: {
            chat: { ready: false, source: null },
          },
        }),
      ),
    );

    await page.goto('/connections/models');
    await expect(
      page.getByRole('heading', { name: 'Models', level: 1, exact: true }),
    ).toBeVisible();

    // Exactly one detected entry, and it names what was detected. A count is
    // the honest form of "detection is for infrastructure only": the empty
    // state legitimately lists key-based providers under Quick Setup, and
    // `detectedActions` can only ever emit Ollama or Bedrock.
    const detected = page.getByRole('button', { name: /^Add detected / });
    await expect(detected).toHaveCount(1);
    await expect(detected).toHaveAccessibleName(
      'Add detected Ollama A local Ollama server is reachable right now.',
    );

    // Keyboard activation: also pins that the entry is a real button.
    await detected.focus();
    await detected.press('Enter');
    await expect(page).toHaveURL(/\/connections\/models\/new$/);
    // What it lands on, observed rather than assumed: the section's add flow,
    // opened on the provider type picker. (Worth a separate look — a
    // "one-click detected" entry that still asks which provider you meant is
    // one click short of its name.)
    await expect(
      page.getByRole('heading', { name: 'Add provider' }),
    ).toBeVisible();
  });

  test.describe('Pixel 7 provider overview', () => {
    const { defaultBrowserType: _defaultBrowserType, ...pixel7 } =
      devices['Pixel 7'];
    test.use(pixel7);

    test('keeps every model connection readable, touch-sized, and free of horizontal overflow', async ({
      page,
    }) => {
      await installVisualViewportFixture(page);
      // `?section=` means nothing to the resolver, and `#section-providers` /
      // `[data-provider-id]` have no producer left in `src-ui` at all — the
      // count of 4 was the OLD hub's aggregate of models and runtimes. Models
      // is a `SplitPaneLayout`, so its rows are what a phone user touches.
      await page.goto('/connections/models');

      const rows = page.locator('.split-pane__item');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toHaveAccessibleName(/Local Ollama/);
      for (const row of await rows.all()) {
        expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
      }
      // The document-level scroll claim is `connections-sections.spec.ts:541`'s;
      // what is only asserted here is the LIST's own overflow and right edge.
      const geometry = await page
        .locator('.split-pane__list')
        .evaluate((element) => ({
          overflows: element.scrollWidth > element.clientWidth,
          right: element.getBoundingClientRect().right,
          viewportWidth: document.documentElement.clientWidth,
        }));
      expect(geometry.overflows).toBe(false);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    });
  });

  test('keeps the add-model catalog tappable above an open mobile chat dock', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installVisualViewportFixture(page);
    await page.addInitScript(() => {
      const applyLongEntrance = () => {
        for (const transition of document.querySelectorAll<HTMLElement>(
          '.route-transition',
        )) {
          transition.style.setProperty(
            'animation-duration',
            '30s',
            'important',
          );
        }
      };
      const observer = new MutationObserver(applyLongEntrance);
      observer.observe(document, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent =
          '.route-transition { animation-duration: 30s !important; }';
        document.head.append(style);
        applyLongEntrance();
      });
    });
    await page.goto('/connections/models/new?dock=open');

    const dock = page.locator('#chat-dock');
    await expect(dock).toBeVisible();
    const back = page.locator('.split-pane__back');
    await expect(back).toBeFocused();

    const ollama = page.getByRole('button', { name: /^Ollama/ });
    await expect(ollama).toBeVisible();
    await ollama.evaluate((tile) => {
      tile.scrollIntoView({ block: 'center', inline: 'nearest' });
      const scrollOwner = tile.closest('.split-pane__right');
      const back = scrollOwner?.querySelector('.split-pane__back');
      if (!scrollOwner || !back) return;
      const tileBox = tile.getBoundingClientRect();
      const scrollBox = scrollOwner.getBoundingClientRect();
      const backBox = back.getBoundingClientRect();
      const usableCenter = (backBox.bottom + scrollBox.bottom) / 2;
      scrollOwner.scrollTop += tileBox.top + tileBox.height / 2 - usableCenter;
    });

    const geometry = await ollama.evaluate((tile) => {
      const tileBox = tile.getBoundingClientRect();
      const scrollOwner = tile.closest('.split-pane__right');
      const back = scrollOwner?.querySelector('.split-pane__back');
      const detail = scrollOwner?.querySelector('.detail-header');
      const dock = document.querySelector('#chat-dock');
      const toolbar = document.querySelector('.app-toolbar');
      const appMain = document.querySelector('.app__main');
      const routeTransition = document.querySelector('.route-transition');
      const pageFrame = document.querySelector('.page-frame');
      const reservingBanners = [
        ...document.querySelectorAll(
          '[data-banner-id]:not([data-overlay]), .banner-host__cap',
        ),
      ];
      const box = (element: Element | null | undefined) => {
        const rect = element?.getBoundingClientRect();
        return rect
          ? {
              top: rect.top,
              bottom: rect.bottom,
              height: rect.height,
              left: rect.left,
              right: rect.right,
            }
          : null;
      };
      const centerX = tileBox.left + tileBox.width / 2;
      const centerY = tileBox.top + tileBox.height / 2;
      const hit = document.elementFromPoint(centerX, centerY);
      return {
        tile: {
          ...box(tile),
          centerX,
          centerY,
        },
        scrollOwner: scrollOwner
          ? {
              ...box(scrollOwner),
              scrollTop: scrollOwner.scrollTop,
              scrollHeight: scrollOwner.scrollHeight,
              clientHeight: scrollOwner.clientHeight,
              scrollPaddingTop: parseFloat(
                getComputedStyle(scrollOwner).scrollPaddingTop,
              ),
            }
          : null,
        back: box(back),
        detail: detail
          ? {
              ...box(detail),
              position: getComputedStyle(detail).position,
            }
          : null,
        toolbar: box(toolbar),
        routeTransition: routeTransition
          ? {
              ...box(routeTransition),
              transform: getComputedStyle(routeTransition).transform,
            }
          : null,
        sheetOutsideRouteTransition: Boolean(
          scrollOwner && !routeTransition?.contains(scrollOwner),
        ),
        pageFrameInert: pageFrame?.hasAttribute('inert') ?? false,
        appMain: appMain
          ? {
              ...box(appMain),
              // The shell's CSS consumers use `var(--banner-stack-height,
              // 0px)`, while an empty stack need not publish the custom
              // property itself. Measure that identical zero fallback rather
              // than letting an empty string turn this geometry assertion into
              // `NaN`.
              bannerStackHeight:
                parseFloat(
                  getComputedStyle(appMain).getPropertyValue(
                    '--banner-stack-height',
                  ),
                ) || 0,
            }
          : null,
        banners: reservingBanners.map((banner) => ({
          ...box(banner),
          className: banner instanceof HTMLElement ? banner.className : null,
          id: banner.getAttribute('data-banner-id'),
        })),
        reservingBannerBottom: Math.max(
          -Infinity,
          ...reservingBanners.map(
            (banner) => banner.getBoundingClientRect().bottom,
          ),
        ),
        dock: box(dock),
        hit: {
          isTile: hit === tile || tile.contains(hit),
          isDock: Boolean(hit?.closest('#chat-dock')),
          tag: hit?.tagName ?? null,
          id: hit?.id ?? null,
          className: hit instanceof HTMLElement ? hit.className : null,
          text: hit?.textContent?.trim().slice(0, 80) ?? null,
        },
      };
    });
    const diagnostics = JSON.stringify(geometry, null, 2);

    expect(geometry, diagnostics).toMatchObject({
      scrollOwner: expect.anything(),
      back: expect.anything(),
      detail: { position: 'static' },
      toolbar: expect.anything(),
      routeTransition: expect.anything(),
      appMain: expect.anything(),
      dock: expect.anything(),
      sheetOutsideRouteTransition: true,
      pageFrameInert: true,
      hit: { isDock: false, isTile: true },
    });
    expect(geometry.routeTransition?.transform, diagnostics).not.toBe('none');
    expect(geometry.dock?.height ?? 0, diagnostics).toBeGreaterThan(100);
    expect(
      geometry.scrollOwner?.scrollPaddingTop ?? 0,
      diagnostics,
    ).toBeGreaterThanOrEqual(geometry.back?.height ?? Infinity);
    const sheetTopBlocker = Math.max(
      geometry.toolbar?.bottom ?? -Infinity,
      (geometry.toolbar?.bottom ?? -Infinity) +
        (geometry.appMain?.bannerStackHeight ?? -Infinity),
    );
    expect(
      geometry.scrollOwner?.top ?? -Infinity,
      diagnostics,
    ).toBeGreaterThanOrEqual(sheetTopBlocker - 1);
    expect(geometry.scrollOwner?.bottom ?? 0, diagnostics).toBeCloseTo(
      geometry.dock?.top ?? 0,
      0,
    );
    expect(
      geometry.scrollOwner?.clientHeight ?? 0,
      diagnostics,
    ).toBeGreaterThan(100);
    expect(geometry.scrollOwner?.top ?? 0, diagnostics).toBeLessThanOrEqual(
      geometry.back?.top ?? -Infinity,
    );
    expect(geometry.back?.bottom ?? Infinity, diagnostics).toBeLessThanOrEqual(
      geometry.scrollOwner?.bottom ?? -Infinity,
    );
    expect(geometry.tile.centerY, diagnostics).toBeGreaterThan(
      geometry.back?.bottom ?? Infinity,
    );
    expect(geometry.tile.centerY, diagnostics).toBeLessThan(
      Math.min(
        geometry.scrollOwner?.bottom ?? Infinity,
        geometry.dock?.top ?? Infinity,
      ),
    );

    await ollama.click();
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue(
      'Ollama',
    );
  });

  test('returns mobile Connections focus across browser and routed closes without carrying it into a direct detail', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installVisualViewportFixture(page);
    await page.goto('/connections/models');

    const row = page.getByRole('button', { name: /Local Ollama/ });
    await row.focus();
    await row.press('Enter');
    const back = page.getByRole('button', { name: '← Back to list' });
    await expect(back).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/\/connections\/models$/);
    await expect(row).toBeFocused();

    const add = page
      .locator('.page__actions')
      .getByRole('button', { name: 'Add model connection', exact: true });
    await add.focus();
    await add.press('Enter');
    await expect(page).toHaveURL(/\/connections\/models\/new$/);
    await expect(back).toBeFocused();
    // The picker owns a real route close, not the split pane's Back button.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page).toHaveURL(/\/connections\/models$/);
    await expect(add).toBeFocused();

    // Drive the route authority directly, without activating a row. This is a
    // real SPA history route (as from a deep link/history navigation), so the
    // detail has no semantic opener. Back must fall back to its own list,
    // never resurrect the Add chain the picker close already consumed.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/connections/models/ollama-local');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page).toHaveURL(/\/connections\/models\/ollama-local$/);
    await expect(back).toBeFocused();
    await back.click();
    await expect(page.locator('.split-pane__list')).toBeFocused();
  });

  test('keeps the catalog behind explicit Add and checks a detected provider in one dialog', async ({
    page,
  }) => {
    // `/connections/acp` redirects to the Engines SECTION, whose one add
    // action is "Add engine" (`connection-sections.ts:12-26`,
    // `ConnectionsSectionFrame.tsx:40-53`). The ACP provider setup surface —
    // and with it the `Add provider` trigger and its catalog dialog — now
    // mounts only on the item route (`app-shell/routing.ts` →
    // `AppViewContent.tsx`), which opens straight onto the custom stage.
    await page.goto('/connections/engines/new/custom');
    await page
      .getByRole('dialog', { name: 'Custom provider' })
      .getByRole('button', { name: 'Cancel' })
      .click();

    // With no dialog open the catalog is not on the page: that is the claim.
    await expect(page.getByRole('button', { name: /Kiro CLI/ })).toHaveCount(0);
    const add = page.getByRole('button', {
      name: 'Add provider',
      exact: true,
    });
    await add.click();
    // The deep link names a provider, so the dialog reopens on that provider's
    // stage; the catalog is the stage behind it.
    await page
      .getByRole('dialog', { name: 'Custom provider' })
      .getByRole('button', { name: 'Back' })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Add provider',
    });
    const kiro = dialog.getByRole('button', { name: /Kiro CLI/ });
    await expect(kiro).toContainText(
      'Found on this computer — not yet connected to this Station.',
    );

    // Enter proves the catalog choice is a keyboard-reachable action; it
    // starts the existing install-and-probe mutation directly.
    await kiro.focus();
    await kiro.press('Enter');

    await expect(dialog.getByRole('status')).toContainText('Ready');
    await expect(
      page.getByRole('button', {
        name: 'Add provider',
        exact: true,
      }),
    ).toHaveCount(1);
  });

  test('custom setup checks in the same dialog and failures stay repairable', async ({
    page,
  }) => {
    await page.route('**/acp/connections', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      await route.fulfill(
        json({ success: false, error: 'The command could not be reached.' }),
      );
    });
    // The item route opens directly on the custom stage, so the catalog hop
    // the old body performed is one step this journey no longer needs.
    await page.goto('/connections/engines/new/custom');
    // Unnamed on purpose: there is one dialog, and its accessible name tracks
    // the stage — "Custom provider" while editing, "Add provider" once the
    // check has answered.
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Custom provider' }),
    ).toBeVisible();
    await dialog.getByLabel('Name').fill('Gemini CLI');
    await dialog.getByRole('textbox', { name: 'Command' }).fill('gemini');
    await dialog.getByRole('button', { name: 'Check provider' }).click();

    await expect(dialog.getByRole('alert')).toContainText('Unavailable');
    await expect(dialog.getByRole('alert')).toContainText(
      'The command could not be reached.',
    );
    await expect(dialog.getByText('Ready', { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Try again' }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Edit setup' }).click();
    await expect(dialog.getByLabel('Name')).toHaveValue('Gemini CLI');
    await expect(dialog.getByRole('textbox', { name: 'Command' })).toHaveValue(
      'gemini',
    );
  });

  /**
   * Return-focus for a section's add action, moved onto the one add entry the
   * IA guarantees will keep opening a Dialog rather than a route: Computers ->
   * Add computer (`connection-sections.ts:38-45`,
   * `ConnectionsSectionFrame.tsx:40-53` — every other section's add action
   * navigates). The claim is unchanged and is not covered elsewhere:
   * `tests/dialog-return-focus.spec.ts` exercises synthetic survivor/inert
   * cases and the connect modal, never a Connections add action.
   *
   * `AddMachineModal` passes no `returnFocusTarget`, so `ResponsiveDialogSurface`
   * captures `document.activeElement` at mount — i.e. the trigger — and
   * restores it on unmount. That is exactly the path a regression would break.
   */
  test('the section add action opens a dialog with keyboard semantics and restores focus to its trigger', async ({
    page,
  }) => {
    await page.goto('/connections/computers');
    await expect(
      page.getByRole('heading', { name: 'Computers', level: 1, exact: true }),
    ).toBeVisible();

    const add = page
      .locator('.page__actions')
      .getByRole('button', { name: 'Add computer', exact: true });
    await add.focus();
    await add.press('Enter');

    const dialog = page.getByRole('dialog', {
      name: 'What do you want to do?',
    });
    await expect(dialog).toBeFocused();
    await dialog.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();
  });

  test.describe('Pixel 7 local provider setup', () => {
    const { defaultBrowserType: _defaultBrowserType, ...pixel7 } =
      devices['Pixel 7'];
    test.use(pixel7);

    test('contains the Add sheet with touch-sized choices and legible themes', async ({
      page,
    }) => {
      await installVisualViewportFixture(page);
      await page.goto('/connections/engines/new/custom');
      await page
        .getByRole('dialog', { name: 'Custom provider' })
        .getByRole('button', { name: 'Cancel' })
        .click();
      const add = page.getByRole('button', {
        name: 'Add provider',
        exact: true,
      });
      // Measured before opening: the trigger itself has to be tappable.
      expect((await add.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET_PX,
      );
      await add.click();
      // The deep link names a provider, so the dialog reopens on that stage;
      // the catalog is behind it.
      await page
        .getByRole('dialog', { name: 'Custom provider' })
        .getByRole('button', { name: 'Back' })
        .click();

      const dialog = page.getByRole('dialog', {
        name: 'Add provider',
      });
      const kiro = dialog.getByRole('button', { name: /Kiro CLI/ });
      const custom = dialog.getByRole('button', {
        name: 'Custom provider',
      });
      for (const control of [kiro, custom]) {
        expect(
          (await control.boundingBox())?.height ?? 0,
        ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }

      const geometry = await dialog.evaluate((element) => ({
        overflows: element.scrollWidth > element.clientWidth,
        bottom: element.getBoundingClientRect().bottom,
        visualBottom:
          (window.visualViewport?.offsetTop ?? 0) +
          (window.visualViewport?.height ?? window.innerHeight),
      }));
      expect(geometry.overflows).toBe(false);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.visualBottom + 1);

      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        await expect
          .poll(() => contrastRatio(kiro))
          .toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  test('discovery miss remains an honest available Add entry', async ({
    page,
  }) => {
    await page.route('**/api/connections/agents', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    );
    await page.route('**/api/connections/agents/catalog', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'claude-runtime',
              kind: 'agent',
              type: 'claude',
              name: 'Claude Code',
              description: 'Claude Code integration.',
              enabled: true,
              capabilities: ['agent-runtime'],
              config: { executionClass: 'connected' },
              status: 'missing_prerequisites',
              prerequisites: [],
              setup: {
                state: 'available',
                detected: false,
                configured: false,
              },
            },
          ],
        }),
      ),
    );

    await page.goto('/connections/engines');
    // The section's own empty copy (`views/AgentConnectionView.tsx:257`), and
    // its ONE add action, which the frame owns (`ConnectionsSectionFrame.tsx`).
    await expect(page.getByText('Add an engine to get started')).toBeVisible();
    await page
      .locator('.page__actions')
      .getByRole('button', { name: 'Add engine', exact: true })
      .click();
    await expect(page).toHaveURL(/\/connections\/engines\/new$/);
    await expect(
      page.locator('.plugins__registry-name', { hasText: 'Claude Code' }),
    ).toBeVisible();
    await expect(
      page.locator('.plugins__registry-name .plugins__cap'),
    ).toHaveText('Available');
  });

  test('model-only first run does not invent an engine connection', async ({
    page,
  }) => {
    await page.route('**/api/connections', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'ollama-local',
              kind: 'model',
              type: 'ollama',
              name: 'Local Ollama',
              enabled: true,
              capabilities: ['llm'],
              config: {},
              status: 'ready',
              prerequisites: [],
            },
          ],
        }),
      ),
    );
    // A truly model-only machine: no ACP CLIs detected either.
    await page.route('**/acp/registry', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    );

    // The seed's runtimes still answer `/api/connections/agents`, so a
    // model-only machine has to say so on that endpoint too — otherwise this
    // test asserted an absence the fixture itself contradicted.
    await page.route('**/api/connections/agents', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    );
    await page.route('**/api/connections/models', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'ollama-local',
              kind: 'model',
              type: 'ollama',
              name: 'Local Ollama',
              enabled: true,
              capabilities: ['llm'],
              config: {},
              status: 'ready',
              prerequisites: [],
            },
          ],
        }),
      ),
    );

    // The claim is now split across the two sections that own the two halves.
    await page.goto('/connections/models');
    const modelRows = page.locator('.split-pane__list .split-pane__item');
    await expect(modelRows).toHaveCount(1);
    await expect(modelRows.first()).toHaveAccessibleName(/^Local Ollama/);
    // Both counts come from one derivation
    // (`views/connections-hub/connection-section-signals.ts`), so this also
    // pins that nothing was invented in the rail.
    await expect(page.getByRole('tab', { name: /^Models 1/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Engines 0/ })).toBeVisible();

    await page.goto('/connections/engines');
    await expect(page.getByText('Add an engine to get started')).toBeVisible();
    await expect(
      page.locator('.split-pane__list .split-pane__item'),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Codex Runtime|Claude Code/ }),
    ).toHaveCount(0);
  });

  test('provider create flow and runtime save flow settle', async ({
    page,
  }) => {
    // `/connections/providers` redirects to Models. The add flow is a ROUTE
    // now, not a dialog: the frame's action navigates to `/models/new`, where
    // the split pane's detail is the provider type picker.
    await page.goto('/connections/models');
    await expect(
      page.getByRole('heading', { name: 'Models', level: 1, exact: true }),
    ).toBeVisible();

    await page
      .locator('.page__actions')
      .getByRole('button', { name: 'Add model connection', exact: true })
      .click();
    await expect(page).toHaveURL(/\/connections\/models\/new$/);
    await expect(
      page.getByRole('heading', { name: 'Add provider' }),
    ).toBeVisible();

    // Plain clicks, not `forceClickRole`/`fillStable`: those existed to beat
    // the old hub's hover-lift transform, and a synthetic `dispatchEvent`
    // click lands even on a `pointer-events: none` control — which would hide
    // exactly the regression this test is for.
    await page.getByRole('button', { name: /^Ollama/ }).click();

    const nameField = page.getByRole('textbox', { name: 'Name' });
    await expect(nameField).toHaveValue('Ollama');
    await nameField.fill('Team Ollama');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // The create settles: the route moves to the persisted id and the primary
    // action becomes Save.
    await expect(page).toHaveURL(/\/connections\/models\/[0-9a-f-]{36}$/);
    await expect(nameField).toHaveValue('Team Ollama');
    await expect(
      page.getByRole('button', { name: 'Save', exact: true }),
    ).toBeVisible();

    await page.goto('/connections/engines/codex-runtime');
    await page.getByText('Advanced', { exact: true }).click();
    // By accessible name: inside the Advanced disclosure the old
    // `.editor-field .editor-input` also matches the read-only Type/Status/
    // Catalog cells.
    const engineName = page.getByRole('textbox', { name: 'Name' });
    await engineName.fill('Codex Runtime Updated');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(engineName).toHaveValue('Codex Runtime Updated');

    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByText(/Healthy/)).toBeVisible();
  });

  test('preset click resolves to openai-compat with prefilled config', async ({
    page,
  }) => {
    await page.goto('/connections/models');
    await page
      .locator('.page__actions')
      .getByRole('button', { name: 'Add model connection', exact: true })
      .click();
    await expect(page).toHaveURL(/\/connections\/models\/new$/);
    await expect(
      page.getByRole('heading', { name: 'Add provider' }),
    ).toBeVisible();

    await page.getByRole('button', { name: /^OpenRouter/ }).click();

    // Server URL renders only for `openai-compat`, so its presence with the
    // preset's own value IS the "resolved to openai-compat" claim: this fails
    // if the preset ever stops mapping to that type.
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue(
      'OpenRouter',
    );
    await expect(page.getByRole('textbox', { name: 'Server URL' })).toHaveValue(
      'https://openrouter.ai/api/v1',
    );
  });

  test('tool server create and delete flows settle', async ({ page }) => {
    await page.goto('/connections/tools');

    // The section H1 is "Tools"; the view's own `+ Add Tool Server` was
    // deliberately deleted so the frame owns the section's single add action
    // (`views/IntegrationsView.tsx:246-251`).
    await expect(
      page.getByRole('heading', { name: 'Tools', level: 1, exact: true }),
    ).toBeVisible();
    await page
      .locator('.page__actions')
      .getByRole('button', { name: 'Add tool server', exact: true })
      .click();
    await expect(page).toHaveURL(/\/connections\/tools\/new$/);
    await page.waitForSelector('#int-id', { timeout: 15_000 });
    await fillStable(page, '#int-id', 'browser-tools');
    await fillStable(page, '#int-name', 'Browser Tools');
    await fillStable(page, '#int-cmd', 'npx');
    await fillStable(page, '#int-args', '-y @example/browser-tools');
    await page.locator('.editor-btn--primary').click();

    await expect(page.getByText('Saved')).toBeVisible();
    await expect(page.locator('#int-name')).toHaveValue('Browser Tools');

    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete' }).last().click();

    await expect(page.locator('#int-name')).not.toBeVisible();
  });

  test('knowledge view guards a dirty data-directory edit before navigating away', async ({
    page,
  }) => {
    const vectorDbConnection: ModelConnection = {
      id: 'lancedb-builtin',
      kind: 'model',
      type: 'lancedb',
      name: 'Built-in Vector Store',
      enabled: true,
      capabilities: ['vectordb'],
      config: { dataDir: '/data/lancedb' },
      status: 'ready',
      prerequisites: [],
      lastCheckedAt: null,
    };

    // Overrides the beforeEach seed's empty connection list for this test
    // only (Playwright routes are LIFO — this handler, registered after
    // seedConnectionsRoutes, is checked first; non-GET requests fall back
    // to the shared handler).
    await page.route('**/api/connections', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill(json({ success: true, data: [vectorDbConnection] }));
    });

    await page.goto('/connections/knowledge');
    // The view renders inside `ConnectionsSectionFrame`'s own
    // `PageHeaderScope`, so the frame's header wins: eyebrow `Connections`
    // (archive#4463: unlinked parent-context text, not a
    // breadcrumb trail and not a link — `/connections` is a redirect-only
    // resolver, so a click would be a no-op or a sibling jump), H1
    // `Knowledge`. Nothing on the page says "Knowledge infrastructure" any
    // more, and the eyebrow has no link affordance — so the exit affordance
    // this test used is gone too.
    await expect(
      page.getByRole('heading', { name: 'Knowledge', level: 1, exact: true }),
    ).toBeVisible();

    const dataDirInput = page.locator(
      '.knowledge-view__field input.editor-input',
    );
    await expect(dataDirInput).toHaveValue('/data/lancedb');
    await dataDirInput.fill('/data/lancedb-edited');

    // Leaving via the section rail. `useUnsavedGuard` registers a GLOBAL
    // navigation guard while dirty and `navigationStore.navigate` runs every
    // guard on any pathname change, so the rail tab — a real `role="tab"` that
    // navigates (`ConnectionsSectionFrame.tsx`) — is arbitrated by it exactly
    // as the old breadcrumb was.
    const breadcrumb = page.getByRole('tab', { name: /^Models/ });

    await breadcrumb.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'Unsaved Changes' }),
    ).toBeVisible();

    // Cancel keeps the edit and stays on the Knowledge view.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(dataDirInput).toHaveValue('/data/lancedb-edited');
    await expect(page).toHaveURL(/\/connections\/knowledge$/);

    // Discard proceeds with the navigation.
    await breadcrumb.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Discard' })
      .click();
    await expect(page).toHaveURL(/\/connections\/models$/);
  });
});
