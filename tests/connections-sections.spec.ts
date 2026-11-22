import { expect, type Page, test } from '@playwright/test';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * Coverage for the Customize page and the connection-backed items it hosts
 * (`src-ui/src/views/connections-hub/connection-sections.ts`,
 * `CustomizeSectionFrame.tsx`, `views/customize/`): the page by address and
 * by Back, old Connections addresses landing on their Customize item, and the
 * frame contract each item shares (one H1, a `Customize` eyebrow that goes
 * back to the list, exactly one add action). Computers left Connections
 * without becoming a Customize item and keeps its own address. Also covers
 * the Providers add+test journey (b) and the Tools built-in-vs-user-server
 * distinction (d) that live inside those items.
 *
 * The E2E regression lane adds (c): the Engines section's rows — named by the
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
 * it puts the app into a state a real Station never serves (archive#3390).
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
 * Verification gap: asserting only that
 * `.page__actions` held exactly one button is satisfied by ANY
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
  addPath?: string;
}> = [
  {
    path: '/customize/providers',
    title: 'Providers',
    addLabel: 'Add model connection',
    addPath: '/customize/providers/new',
  },
  {
    path: '/customize/engines',
    title: 'Engines',
    addLabel: 'Add engine',
    addPath: '/customize/engines/new',
  },
  {
    path: '/customize/tools',
    title: 'Tools',
    addLabel: 'Add tool server',
    addPath: '/customize/tools/new',
  },
  {
    path: '/customize/knowledge',
    title: 'Knowledge',
    addLabel: 'Add knowledge source',
    addPath: '/settings?view=knowledge',
  },
  // Not a Customize item: devices move to the Station page, and until it
  // exists this address keeps today's Computers screen.
  {
    path: '/connections/computers',
    title: 'Computers',
    addLabel: 'Add computer',
  },
];

const CUSTOMIZE_ITEMS = [
  ['Agents', '/agents'],
  // Straight to its tab, so opening Skills is one history entry.
  ['Skills', '/guidance?tab=skills'],
  ['Engines', '/customize/engines'],
  ['Providers', '/customize/providers'],
  ['Tools', '/customize/tools'],
  ['Knowledge', '/customize/knowledge'],
] as const;

/** Where the page is, including the query that tells Skills its tab. */
function address(url: URL) {
  return `${url.pathname}${url.search}`;
}

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

test.describe('Customize page', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
  });

  test('the sidebar opens Customize, each item opens from its list, and Back returns through them', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Customize', exact: true })
      .click();
    await expect(page).toHaveURL((url) => url.pathname === '/customize');
    await expect(
      page.getByRole('heading', { name: 'Customize', level: 1, exact: true }),
    ).toBeVisible();
    const list = page.getByRole('navigation', { name: 'Customize' });
    for (const group of [
      'Your agents',
      'What they run on',
      'What they can reach',
    ]) {
      await expect(
        list.getByRole('heading', { name: group, exact: true }),
      ).toBeVisible();
    }
    await expect(list.getByRole('link', { name: /^Plugins/ })).toHaveCount(0);
    for (const [label, path] of CUSTOMIZE_ITEMS) {
      await list
        .getByRole('link', { name: new RegExp(`^${label}\\b`) })
        .click();
      await expect(page).toHaveURL((url) => address(url) === path);
      await expect(
        list.getByRole('link', { name: new RegExp(`^${label}\\b`) }),
      ).toHaveAttribute('aria-current', 'page');
    }
    // One item per press, both ways: no item adds a second history entry
    // (Skills used to rewrite /guidance to /guidance?tab=skills, so Back
    // stayed on Skills).
    for (const [label, path] of [...CUSTOMIZE_ITEMS].reverse().slice(1)) {
      await page.goBack();
      await expect(page).toHaveURL((url) => address(url) === path);
      await expect(
        list.getByRole('link', { name: new RegExp(`^${label}\\b`) }),
      ).toHaveAttribute('aria-current', 'page');
    }
    await page.goBack();
    await expect(page).toHaveURL((url) => address(url) === '/customize');
    for (const [label, path] of CUSTOMIZE_ITEMS) {
      await page.goForward();
      await expect(page).toHaveURL((url) => address(url) === path);
      await expect(
        list.getByRole('link', { name: new RegExp(`^${label}\\b`) }),
      ).toHaveAttribute('aria-current', 'page');
    }
  });

  test('Computers is reachable from the landing and from its old section address', async ({
    page,
  }) => {
    await page.goto('/customize');
    await page
      .locator('.customize-landing')
      .getByRole('link', { name: 'Computers', exact: true })
      .click();
    await expect(page).toHaveURL(
      (url) => url.pathname === '/connections/computers',
    );
    await expect(
      page.getByRole('heading', { name: 'Computers', level: 1, exact: true }),
    ).toBeVisible();
    await page.goto('/connections?section=computers');
    await expect(page).toHaveURL(
      (url) => url.pathname === '/connections/computers',
    );
  });

  test('old Connections addresses land on the matching Customize item', async ({
    page,
  }) => {
    for (const [legacy, current, title] of [
      ['/connections', '/customize', 'Customize'],
      ['/connections/models', '/customize/providers', 'Providers'],
      ['/connections/providers', '/customize/providers', 'Providers'],
      ['/connections/engines', '/customize/engines', 'Engines'],
      ['/connections/acp', '/customize/engines', 'Engines'],
      ['/connections/tools', '/customize/tools', 'Tools'],
      ['/connections/knowledge', '/customize/knowledge', 'Knowledge'],
    ] as const) {
      await page.goto(legacy);
      await expect(page).toHaveURL((url) => url.pathname === current);
      await expect(
        page.getByRole('heading', { name: title, level: 1, exact: true }),
      ).toBeVisible();
    }
  });

  test('each item renders its own H1, a Customize eyebrow back to the list, and exactly one add action', async ({
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
      // The old section rail is gone: the Customize list replaces it.
      await expect(page.getByRole('tab')).toHaveCount(0);
      if (section.path === '/connections/computers') {
        // Not a Customize item: no eyebrow into it, no Customize list.
        await expect(page.locator('.page__label')).toHaveCount(0);
        await expect(
          page.getByRole('navigation', { name: 'Customize' }),
        ).toHaveCount(0);
      } else {
        await expect(
          page.locator('.page__label').getByRole('link', {
            name: 'Customize',
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page
            .getByRole('navigation', { name: 'Customize' })
            .getByRole('link', { name: new RegExp(`^${section.title}\\b`) }),
        ).toHaveAttribute('aria-current', 'page');
      }

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
    // The eyebrow goes back to the Customize landing.
    await page.goto('/customize/tools');
    await page
      .locator('.page__label')
      .getByRole('link', { name: 'Customize', exact: true })
      .click();
    await expect(page).toHaveURL((url) => url.pathname === '/customize');
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
    await page.goto('/customize/providers');

    // Drive the real Add affordance: it opens the picker with the
    // OpenAI-Compatible type genuinely reachable.
    await page.getByRole('button', { name: 'Add model connection' }).click();
    await expect(page).toHaveURL(/\/customize\/providers\/new$/);
    await expect(
      page.getByRole('heading', { name: 'Add model connection' }),
    ).toBeVisible();
    // The "More" group's entry, not the "OpenAI" preset — regex anchored
    // to the start of the accessible name so it cannot match the preset.
    await expect(
      page.getByRole('button', { name: /^OpenAI-Compatible/ }),
    ).toBeVisible();

    // Drive the real Test affordance against the seeded connection.
    await page.getByRole('button', { name: /Custom OpenAI/ }).click();
    await expect(page).toHaveURL(/\/customize\/providers\/oa-compat-1$/);

    const testButton = page.getByRole('button', {
      name: 'Test connection',
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

    await page.goto('/customize/tools');

    await page.getByRole('button', { name: /Station Docs/ }).click();
    await expect(page).toHaveURL(/\/customize\/tools\/station-docs$/);
    const detailPanel = page.locator('.integration-editor-panel');
    await expect(
      detailPanel.getByText('Built in', { exact: true }),
    ).toBeVisible();
    await expect(
      detailPanel.getByRole('button', { name: 'Delete', exact: true }),
    ).toHaveCount(0);

    await page.getByRole('button', { name: /Browser Tools/ }).click();
    await expect(page).toHaveURL(/\/customize\/tools\/browser-tools$/);
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
 * a name for (`claude` -> "Claude Code") and one whose `type` it does
 * not (`muse`). Both ship in Station today.
 */
const ENGINES: readonly EngineConnection[] = [
  {
    id: 'claude',
    kind: 'agent',
    type: 'claude',
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
    type: 'muse',
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
 * decide the result. "Providers" left this list: the first-release design
 * makes it the name of a Customize item.
 */
const RETIRED_HUB_WORDS = [
  'ACP',
  'agent app',
  'Agent app',
  'Remote work',
  'Developer services',
];

test.describe('Customize — Engines item', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page, { engines: [...ENGINES] });
  });

  test('every engine row is named by its engine and prints no internal type slug', async ({
    page,
  }) => {
    await page.goto('/customize/engines');
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
    await page.goto('/customize/engines');
    await expect(
      page.getByRole('heading', { name: 'Engines', level: 1, exact: true }),
    ).toBeVisible();
    await expect(page.locator('.split-pane__item').first()).toBeVisible();

    // The item's page only: the Customize list beside it names its siblings
    // (Providers among them), which is the first-release design's word.
    const section = await page.locator('.customize-shell__main').innerText();
    for (const word of RETIRED_HUB_WORDS) {
      expect(section, `the Engines section still says "${word}"`).not.toContain(
        word,
      );
    }
  });
});

test.describe('Customize items at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
  });

  test('the landing is the list: the left list is hidden, and each item opens from the landing and comes back', async ({
    page,
  }) => {
    await page.goto('/customize');
    await expect(
      page.getByRole('navigation', { name: 'Customize' }),
    ).toBeHidden();
    const landing = page.locator('.customize-landing');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    for (const [label, path] of CUSTOMIZE_ITEMS) {
      const link = landing.getByRole('link', {
        name: new RegExp(`^${label}\\b`),
      });
      const box = (await link.boundingBox())!;
      expect(box.height, `${label} row`).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET_PX - 0.001,
      );
      await link.tap();
      await expect(page).toHaveURL((url) => address(url) === path);
      // The way back on a phone is the page's own Customize eyebrow, at the
      // touch floor; Agents and Skills carry it too.
      const back = page
        .locator('.page__label')
        .getByRole('link', { name: 'Customize', exact: true });
      await expect(back).toBeVisible();
      const backBox = (await back.boundingBox())!;
      expect(backBox.height, `${label} way back`).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET_PX - 0.001,
      );
      await back.tap();
      await expect(page).toHaveURL((url) => address(url) === '/customize');
    }
  });

  test('every section opens its single visible add action without horizontal scroll', async ({
    page,
  }) => {
    const measuredActionHeights: Record<string, number> = {};
    for (const section of SECTIONS) {
      await page.goto(section.path);
      await expect(
        page.getByRole('heading', {
          name: section.title,
          level: 1,
          exact: true,
        }),
      ).toBeVisible();

      const add = page.getByRole('button', {
        name: section.addLabel,
        exact: true,
      });
      await expect(add).toHaveCount(1);
      await expect(add).toBeVisible();

      const actionBox = await add.boundingBox();
      expect(actionBox).not.toBeNull();
      measuredActionHeights[section.title] = actionBox?.height ?? 0;

      const noHorizontalScroll = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(noHorizontalScroll).toBe(true);

      await add.tap();
      if (section.addPath)
        await expect(page).toHaveURL(
          (url) => url.pathname + url.search === section.addPath,
        );
      else
        await expect(
          page.getByRole('dialog', { name: 'What do you want to do?' }),
        ).toBeVisible();
    }
    console.log('PAGE_ACTION_HEIGHTS', JSON.stringify(measuredActionHeights));
    for (const [sectionTitle, height] of Object.entries(
      measuredActionHeights,
    )) {
      expect(
        height,
        `${sectionTitle} page action must meet the mobile touch-target floor`,
      ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
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
    await page.goto('/customize/providers');

    await page.getByRole('button', { name: 'Add model connection' }).click();
    await expect(
      page.getByRole('button', { name: /^OpenAI-Compatible/ }),
    ).toBeVisible();

    // At 390 the list and the open picker occupy separate mobile sheets —
    // return to the list before selecting the existing connection.
    await page.goto('/customize/providers');
    await page.getByRole('button', { name: /Custom OpenAI/ }).click();
    await expect(page).toHaveURL(/\/customize\/providers\/oa-compat-1$/);

    const testButton = page.getByRole('button', {
      name: 'Test connection',
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

    await page.goto('/customize/tools');
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
    await page.goto('/customize/engines');
    await expect(
      page.getByRole('heading', { name: 'Engines', level: 1, exact: true }),
    ).toBeVisible();

    const rows = page.locator('.split-pane__item');
    await expect(rows).toHaveCount(ENGINES.length);

    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noHorizontalScroll).toBe(true);

    // No engine row prints its internal type slug on the phone either.
    for (const engine of ENGINES) {
      await expect(rows.filter({ hasText: engine.name })).not.toContainText(
        engine.type,
      );
    }
  });
});

/**
 * archive#3739: the Engines list read
 *
 *     Muse Code   Ready · None catalog · muse
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
              type: 'muse',
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
              type: 'claude',
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

    await page.goto('/customize/engines');
    const list = page.locator('.split-pane__list');
    await expect(list.getByText('Muse Code').first()).toBeVisible({
      timeout: 15_000,
    });
    const listing = await list.innerText();
    expect(listing).toContain('No model catalog');
    expect(listing).toContain('Live model catalog');
    expect(listing).not.toContain('muse');
    expect(listing).not.toContain('None catalog');
    // The row is already named; the subtitle must not repeat it.
    expect(listing.match(/Claude Code/g)?.length).toBe(1);
  });
});
