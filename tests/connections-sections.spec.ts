import { expect, type Page, test } from '@playwright/test';

/**
 * Coverage for the Connections IA (`src-ui/src/views/connections-hub/connection-sections.ts`
 * + `ConnectionsSectionFrame.tsx`): the five sections it defines, the
 * `/connections` resolver, legacy-path redirects, and the frame contract each
 * section shares (one H1, one `Connections` eyebrow — station#4463 slice 1 fix
 * round: unlinked parent-context text, not the retired `Connections / <Section>`
 * breadcrumb-as-eyebrow — exactly one add action). Also covers the Models
 * add+test journey (b) and the Tools built-in-vs-user-server distinction (d)
 * that live inside those sections.
 *
 * The E2E regression lane added (c): the Engines section's rows — named by the
 * ENGINE, carrying the server's state, offering the one inline repair — plus
 * the retired-vocabulary gate DESIGN §7 asks for. It extends `SECTIONS` and
 * `seedRoutes` rather than opening a second Connections spec.
 *
 * Every route is intercepted with `page.route` (house style from
 * `tests/connections-crud.spec.ts` / `tests/ssh-environments-ui.spec.ts`) so
 * this spec never depends on live backend state.
 */

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

interface ModelConnection {
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
}

/**
 * The shape `/api/connections/agents` serves for one engine. `setup.state` is
 * what `AgentConnectionView` reads for the row's state, so a fixture without
 * it puts the app into a state a real Station never serves (station#3390).
 */
interface EngineConnection {
  id: string;
  kind: 'agent';
  type: string;
  name: string;
  enabled: boolean;
  capabilities: string[];
  config: Record<string, unknown>;
  status: string;
  prerequisites: unknown[];
  setup: { state: string; detected: boolean; configured: boolean };
}

interface Integration {
  id: string;
  kind: 'mcp';
  builtin?: boolean;
  transport?: string;
  command?: string;
  args?: string[];
  displayName: string;
  description?: string;
  enabled?: boolean;
}

/**
 * The five sections `connection-sections.ts` declares: path, H1 title, and
 * the ACCESSIBLE NAME of the one add action that section is supposed to
 * offer.
 *
 * sol review verification gap: this spec used to assert only that
 * `.page__actions` held exactly one button. A count is satisfied by ANY
 * button — Engines, Tools and Knowledge could each have shipped the wrong
 * add action, or one wired to another section's creator, and this file would
 * still have been green. The name is the claim a user can act on, so the
 * name is what is asserted; the count stays as the "exactly one entry per
 * section" half (design P3).
 */
const SECTIONS: ReadonlyArray<{
  path: string;
  title: string;
  addLabel: string;
}> = [
  {
    path: '/connections/models',
    title: 'Models',
    addLabel: 'Add model connection',
  },
  { path: '/connections/engines', title: 'Engines', addLabel: 'Add engine' },
  { path: '/connections/tools', title: 'Tools', addLabel: 'Add tool server' },
  {
    path: '/connections/knowledge',
    title: 'Knowledge',
    addLabel: 'Add knowledge source',
  },
  {
    path: '/connections/computers',
    title: 'Computers',
    addLabel: 'Add computer',
  },
];

const MODEL_TEST_FAILURE_REASON =
  'The endpoint returned 401 Unauthorized for the configured API key.';

async function seedRoutes(
  page: Page,
  opts: {
    integrations?: Integration[];
    models?: ModelConnection[];
    engines?: EngineConnection[];
  } = {},
) {
  const state: {
    models: ModelConnection[];
    integrations: Integration[];
    engines: EngineConnection[];
  } = {
    models: opts.models ?? [],
    integrations: opts.integrations ?? [],
    engines: opts.engines ?? [],
  };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

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
          data: { defaultModel: '', region: 'us-east-1' },
        }),
      );
      return;
    }
    if (path === '/api/projects') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/agents') {
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
    if (path === '/api/system/identity') {
      await route.fulfill(
        json({
          environmentId: 'e2e-connections-sections',
          instanceId: 'e2e-connections-sections-instance',
          bootId: 'e2e-connections-sections-boot',
          sha: '2222222222222222222222222222222222222222',
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
          providers: {
            configuredChatReady: true,
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: { chat: { ready: true, source: null } },
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

    if (path === '/api/connections' && method === 'GET') {
      await route.fulfill(json({ success: true, data: state.models }));
      return;
    }
    if (path === '/api/connections' && method === 'POST') {
      const body = request.postDataJSON() as ModelConnection;
      state.models.push(body);
      await route.fulfill(json({ success: true, data: body }));
      return;
    }
    if (path === '/api/connections/models') {
      await route.fulfill(json({ success: true, data: state.models }));
      return;
    }
    if (path === '/api/connections/agents') {
      await route.fulfill(json({ success: true, data: state.engines }));
      return;
    }
    const testMatch = path.match(/^\/api\/connections\/([^/]+)\/test$/);
    if (testMatch && method === 'POST') {
      await route.fulfill(
        json({
          success: true,
          data: { healthy: false, reason: MODEL_TEST_FAILURE_REASON },
        }),
      );
      return;
    }

    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route('**/integrations**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === '/integrations' && method === 'GET') {
      await route.fulfill(json({ success: true, data: state.integrations }));
      return;
    }
    const idMatch = path.match(/^\/integrations\/([^/]+)$/);
    if (idMatch && method === 'GET') {
      const found = state.integrations.find(
        (entry) => entry.id === decodeURIComponent(idMatch[1]),
      );
      if (!found) {
        await route.fulfill(json({ success: false, error: 'Not found' }, 404));
        return;
      }
      await route.fulfill(json({ success: true, data: found }));
      return;
    }

    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route('**/acp/**', async (route) => {
    await route.fulfill(json({ success: true, data: [] }));
  });
}

test.describe('Connections IA', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
  });

  test('the /connections resolver lands on a section, and legacy paths redirect into their owning section', async ({
    page,
  }) => {
    await page.goto('/connections');
    await expect(page).toHaveURL(/\/connections\/models$/);
    await expect(
      page.getByRole('heading', { name: 'Models', level: 1, exact: true }),
    ).toBeVisible();

    // Legacy path for Models.
    await page.goto('/connections/providers');
    await expect(page).toHaveURL(/\/connections\/models$/);
    await expect(
      page.getByRole('heading', { name: 'Models', level: 1, exact: true }),
    ).toBeVisible();

    // Legacy path for Engines.
    await page.goto('/connections/acp');
    await expect(page).toHaveURL(/\/connections\/engines$/);
    await expect(
      page.getByRole('heading', { name: 'Engines', level: 1, exact: true }),
    ).toBeVisible();
  });

  test('each of the five sections renders its own H1, its Connections eyebrow, and exactly one add action', async ({
    page,
  }) => {
    for (const section of SECTIONS) {
      await page.goto(section.path);
      await expect(
        page.getByRole('heading', {
          name: section.title,
          level: 1,
          exact: true,
        }),
      ).toBeVisible();
      // station#4463 slice 1 fix round: 'Connections' only, unlinked — not
      // the retired 'Connections / <Section>' breadcrumb-as-eyebrow. Static
      // parent-context text, not a link: `/connections` is a redirect-only
      // resolver, so a click here would be a no-op or a sibling jump dressed
      // up as "go up".
      await expect(page.locator('.page__label')).toHaveText('Connections');
      // Role-based, not class-based: both eyebrow-producing paths
      // (PageEyebrowTrail and SplitPaneLayout's trail) expose role=link iff
      // they carry a handler, so this holds even if the frame's suppression
      // of the child trail is ever removed.
      await expect(page.locator('.page__label').getByRole('link')).toHaveCount(
        0,
      );
      await expect(page.locator('.page__label-link')).toHaveCount(0);

      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(5);
      const activeTab = page.locator('[role="tab"][aria-selected="true"]');
      await expect(activeTab).toHaveCount(1);
      await expect(activeTab).toContainText(section.title);

      const actionButtons = page.locator('.page__actions').getByRole('button');
      await expect(actionButtons).toHaveCount(1);
      // The action is NAMED, not merely present — see SECTIONS above.
      await expect(
        actionButtons.filter({ hasText: section.addLabel }),
      ).toHaveCount(1);
      await expect(
        page
          .locator('.page__actions')
          .getByRole('button', { name: section.addLabel, exact: true }),
      ).toBeVisible();
    }
  });

  test("the Add-provider picker offers OpenAI-Compatible, and testing an existing model connection renders the server's own failure sentence", async ({
    page,
  }) => {
    const stub: ModelConnection = {
      id: 'oa-compat-1',
      kind: 'model',
      type: 'openai-compat',
      name: 'Custom OpenAI',
      enabled: true,
      capabilities: ['llm', 'embedding'],
      config: { baseUrl: 'https://api.example.test/v1', apiKey: '' },
      status: 'ready',
      prerequisites: [],
      lastCheckedAt: null,
    };
    await seedRoutes(page, { models: [stub] });
    await page.goto('/connections/models');

    // Drive the real Add affordance: it opens the picker with the
    // OpenAI-Compatible type genuinely reachable.
    await page.getByRole('button', { name: 'Add model connection' }).click();
    await expect(page).toHaveURL(/\/connections\/models\/new$/);
    await expect(
      page.getByRole('heading', { name: 'Add provider' }),
    ).toBeVisible();
    // The "More providers" entry, not the "OpenAI" preset — regex anchored
    // to the start of the accessible name so it cannot match the preset.
    await expect(
      page.getByRole('button', { name: /^OpenAI-Compatible/ }),
    ).toBeVisible();

    // Drive the real Test affordance against the seeded connection.
    await page.getByRole('button', { name: /Custom OpenAI/ }).click();
    await expect(page).toHaveURL(/\/connections\/models\/oa-compat-1$/);

    const testButton = page.getByRole('button', {
      name: 'Test Connection',
      exact: true,
    });
    await expect(testButton).toBeVisible();
    await testButton.click();

    // Assertion is on rendered UI text, not on the mocked response object.
    await expect(
      page.getByText('Connection failed', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(MODEL_TEST_FAILURE_REASON)).toBeVisible();
  });

  test('a built-in tool server shows a Built in tag with no Delete; a user tool server keeps Delete', async ({
    page,
  }) => {
    const builtin: Integration = {
      id: 'station-docs',
      kind: 'mcp',
      builtin: true,
      displayName: 'Station Docs',
      description: 'Built-in Station documentation search.',
      enabled: true,
    };
    const userServer: Integration = {
      id: 'browser-tools',
      kind: 'mcp',
      builtin: false,
      displayName: 'Browser Tools',
      description: 'Headless browser automation.',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/browser-tools'],
    };
    await seedRoutes(page, { integrations: [builtin, userServer] });

    await page.goto('/connections/tools');

    await page.getByRole('button', { name: /Station Docs/ }).click();
    await expect(page).toHaveURL(/\/connections\/tools\/station-docs$/);
    const detailPanel = page.locator('.integration-editor-panel');
    await expect(
      detailPanel.getByText('Built in', { exact: true }),
    ).toBeVisible();
    await expect(
      detailPanel.getByRole('button', { name: 'Delete', exact: true }),
    ).toHaveCount(0);

    await page.getByRole('button', { name: /Browser Tools/ }).click();
    await expect(page).toHaveURL(/\/connections\/tools\/browser-tools$/);
    await expect(
      detailPanel.getByText('Built in', { exact: true }),
    ).toHaveCount(0);
    await expect(
      detailPanel.getByRole('button', { name: 'Delete', exact: true }),
    ).toBeVisible();
  });
});

/**
 * Engine connections as a real Station serves them: one whose `type` the UI has
 * a name for (`claude-runtime` -> "Claude Code") and one whose `type` it does
 * not (`muse-runtime`). Both ship in Station today.
 */
const ENGINES: readonly EngineConnection[] = [
  {
    id: 'claude',
    kind: 'agent',
    type: 'claude-runtime',
    name: 'Claude Code',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: {},
    status: 'ready',
    prerequisites: [],
    setup: { state: 'ready', detected: true, configured: true },
  },
  {
    id: 'muse',
    kind: 'agent',
    type: 'muse-runtime',
    name: 'Muse Code',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: {},
    status: 'ready',
    prerequisites: [],
    setup: { state: 'ready', detected: true, configured: true },
  },
];

/**
 * The words DESIGN §7 retires from this hub. They are checked against the
 * rendered SECTION, not the whole document, so the sidebar's own labels do not
 * decide the result.
 */
const RETIRED_HUB_WORDS = [
  'ACP',
  'agent app',
  'Agent app',
  'Providers',
  'Remote work',
  'Developer services',
];

test.describe('Connections — Engines section', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page, { engines: [...ENGINES] });
  });

  test('every engine row is named by its engine and prints no internal type slug', async ({
    page,
  }) => {
    await page.goto('/connections/engines');
    await expect(
      page.getByRole('heading', { name: 'Engines', level: 1, exact: true }),
    ).toBeVisible();

    const rows = page.locator('.split-pane__item');
    await expect(rows).toHaveCount(ENGINES.length);

    for (const engine of ENGINES) {
      const row = rows.filter({ hasText: engine.name });
      await expect(row).toHaveCount(1);
      // DESIGN P2/§4: the row says the engine's own name. `type` is an
      // internal connection kind and `id` is a connection id — neither is a
      // word this surface may print (the audit's CI-R10 vocabulary rule).
      await expect(row).not.toContainText(engine.type);
    }
  });

  test('the Engines section speaks none of the retired hub vocabulary', async ({
    page,
  }) => {
    await page.goto('/connections/engines');
    await expect(
      page.getByRole('heading', { name: 'Engines', level: 1, exact: true }),
    ).toBeVisible();
    await expect(page.locator('.split-pane__item').first()).toBeVisible();

    const section = await page.locator('main').innerText();
    for (const word of RETIRED_HUB_WORDS) {
      expect(section, `the Engines section still says "${word}"`).not.toContain(
        word,
      );
    }
  });
});

test.describe('Connections sections at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
  });

  test('every section renders its title and exactly one add action with no horizontal document scroll', async ({
    page,
  }) => {
    for (const section of SECTIONS) {
      await page.goto(section.path);
      await expect(
        page.getByRole('heading', {
          name: section.title,
          level: 1,
          exact: true,
        }),
      ).toBeVisible();

      const actionButtons = page.locator('.page__actions').getByRole('button');
      await expect(actionButtons).toHaveCount(1);
      await expect(
        page
          .locator('.page__actions')
          .getByRole('button', { name: section.addLabel, exact: true }),
      ).toBeVisible();

      const noHorizontalScroll = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(noHorizontalScroll).toBe(true);
    }
  });

  test('the Add-provider picker opens and testing an existing model connection shows the server failure sentence at 390 too', async ({
    page,
  }) => {
    const stub: ModelConnection = {
      id: 'oa-compat-1',
      kind: 'model',
      type: 'openai-compat',
      name: 'Custom OpenAI',
      enabled: true,
      capabilities: ['llm', 'embedding'],
      config: { baseUrl: 'https://api.example.test/v1', apiKey: '' },
      status: 'ready',
      prerequisites: [],
      lastCheckedAt: null,
    };
    await seedRoutes(page, { models: [stub] });
    await page.goto('/connections/models');

    await page.getByRole('button', { name: 'Add model connection' }).click();
    await expect(
      page.getByRole('button', { name: /^OpenAI-Compatible/ }),
    ).toBeVisible();

    // At 390 the list and the open picker occupy separate mobile sheets —
    // return to the list before selecting the existing connection.
    await page.goto('/connections/models');
    await page.getByRole('button', { name: /Custom OpenAI/ }).click();
    await expect(page).toHaveURL(/\/connections\/models\/oa-compat-1$/);

    const testButton = page.getByRole('button', {
      name: 'Test Connection',
      exact: true,
    });
    await expect(testButton).toBeVisible();
    await testButton.click();

    await expect(page.getByText(MODEL_TEST_FAILURE_REASON)).toBeVisible();

    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noHorizontalScroll).toBe(true);
  });

  test('a built-in tool server hides Delete at 390 too', async ({ page }) => {
    const builtin: Integration = {
      id: 'station-docs',
      kind: 'mcp',
      builtin: true,
      displayName: 'Station Docs',
      description: 'Built-in Station documentation search.',
      enabled: true,
    };
    await seedRoutes(page, { integrations: [builtin] });

    await page.goto('/connections/tools');
    await page.getByRole('button', { name: /Station Docs/ }).click();

    const detailPanel = page.locator('.integration-editor-panel');
    await expect(
      detailPanel.getByText('Built in', { exact: true }),
    ).toBeVisible();
    await expect(
      detailPanel.getByRole('button', { name: 'Delete', exact: true }),
    ).toHaveCount(0);
  });

  test('the Engines rows render at 390 with no horizontal document scroll', async ({
    page,
  }) => {
    await seedRoutes(page, { engines: [...ENGINES] });
    await page.goto('/connections/engines');
    await expect(
      page.getByRole('heading', { name: 'Engines', level: 1, exact: true }),
    ).toBeVisible();

    const rows = page.locator('.split-pane__item');
    await expect(rows).toHaveCount(ENGINES.length);

    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noHorizontalScroll).toBe(true);
  });

  /**
   * Split from the containment case above deliberately. Folding an
   * expected-to-fail claim into a passing one means the passing half can
   * regress unnoticed: the file would still "fail as expected" and nobody
   * would learn the phone had started scrolling sideways.
   */
  test('no engine row prints its internal type slug at 390 either', async ({
    page,
  }) => {
    await seedRoutes(page, { engines: [...ENGINES] });
    await page.goto('/connections/engines');

    const rows = page.locator('.split-pane__item');
    await expect(rows).toHaveCount(ENGINES.length);
    for (const engine of ENGINES) {
      await expect(rows.filter({ hasText: engine.name })).not.toContainText(
        engine.type,
      );
    }
  });
});

/**
 * station#3739: the Engines list read
 *
 *     Muse Code   Ready · None catalog · muse-runtime
 *
 * The third segment either repeated the row's own name or, for an engine
 * Station itself ships, printed the raw `type` slug that
 * `connectionTypeLabel`'s `default: return type` fell through to. "None
 * catalog" was `runtimeCatalogSourceLabel('none')` read out loud.
 */
test.describe('Engines vocabulary', () => {
  test('an engine is named, and its catalogue reads as a sentence', async ({
    page,
  }) => {
    await seedRoutes(page);
    // Registered after `seedRoutes`, so it wins for this one path.
    await page.route('**/api/connections/agents', async (route) => {
      await route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'muse',
              kind: 'agent',
              type: 'muse-runtime',
              name: 'Muse Code',
              enabled: true,
              status: 'ready',
              capabilities: ['agent-runtime'],
              config: { engineId: 'muse' },
              prerequisites: [],
              runtimeCatalog: { source: 'none' },
            },
            {
              id: 'claude',
              kind: 'agent',
              type: 'claude-runtime',
              name: 'Claude Code',
              enabled: true,
              status: 'ready',
              capabilities: ['agent-runtime'],
              config: { engineId: 'claude' },
              prerequisites: [],
              runtimeCatalog: { source: 'live' },
            },
          ],
        }),
      );
    });

    await page.goto('/connections/engines');
    const list = page.locator('.split-pane__list');
    await expect(list.getByText('Muse Code').first()).toBeVisible({
      timeout: 15_000,
    });
    const listing = await list.innerText();
    expect(listing).toContain('No model catalog');
    expect(listing).toContain('Live model catalog');
    expect(listing).not.toContain('muse-runtime');
    expect(listing).not.toContain('None catalog');
    // The row is already named; the subtitle must not repeat it.
    expect(listing.match(/Claude Code/g)?.length).toBe(1);
  });
});
