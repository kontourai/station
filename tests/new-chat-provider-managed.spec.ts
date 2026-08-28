import { expect, type Page, test } from '@playwright/test';
import { contrastRatio } from './helpers/color-contrast';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';
import { installVisualViewportFixture } from './helpers/visual-viewport';

const PROJECTS = [
  {
    id: 'p1',
    slug: 'my-project',
    name: 'My Project',
    icon: '🚀',
    description: 'Project with provider-backed managed chat',
    hasWorkingDirectory: true,
    workingDirectory: '/Users/brian/dev/github/kontourai',
    layoutCount: 0,
    hasKnowledge: false,
  },
];

const AGENTS = [
  {
    slug: 'station',
    name: 'Station',
    description: 'Default agent with full access to manage Station',
    source: 'local',
    engineId: 'station',
    engineDisplayName: 'Station',
    engineDefault: true,
    available: true,
    model: 'us.anthropic.claude-sonnet-4-6',
    toolsConfig: { mcpServers: ['station-control'], autoApprove: [] },
  },
];

function seedRoutes(
  page: import('@playwright/test').Page,
  options?: {
    projectHasProviderDefaults?: boolean;
    projectDefaultModel?: string;
    agentRequiresMcp?: boolean;
    runtimeConnections?: unknown[];
    acpConnections?: unknown[];
  },
) {
  const stationAgents =
    options?.agentRequiresMcp === false
      ? [
          {
            ...AGENTS[0],
            toolsConfig: { mcpServers: [], autoApprove: [] },
          },
        ]
      : AGENTS;
  const engineAgents = (options?.runtimeConnections ?? [])
    .filter((value) => {
      const connection = value as { config?: { executionClass?: string } };
      return connection.config?.executionClass !== 'managed';
    })
    .map((value) => {
      const connection = value as {
        id: string;
        name: string;
        type?: string;
        description?: string;
        status?: string;
        config?: { defaultModel?: string; engineId?: string };
        runtimeCatalog?: { models?: Array<{ id: string }> };
      };
      const defaultModel =
        connection.config?.defaultModel ??
        connection.runtimeCatalog?.models?.[0]?.id;
      const cleanEngineId = connection.config?.engineId ?? connection.id;
      return {
        slug: cleanEngineId,
        name: connection.name,
        description: connection.description ?? `${connection.name} Agent`,
        source: 'local',
        engineId: cleanEngineId,
        engineDisplayName: connection.name,
        engineConnectionType: connection.type,
        engineDefault: true,
        available: connection.status === 'ready',
        model: defaultModel,
        execution: {
          agentConnectionId: connection.id,
          ...(defaultModel ? { modelId: defaultModel } : {}),
        },
      };
    });
  const agents = [...stationAgents, ...engineAgents];
  const projectConfig = {
    ...PROJECTS[0],
    ...(options?.projectHasProviderDefaults
      ? {
          defaultProviderId: 'ollama-local',
          defaultModel: options?.projectDefaultModel ?? 'llama3.2',
        }
      : {}),
    agents: ['station'],
    createdAt: '2026-04-12T00:00:00Z',
    updatedAt: '2026-04-12T00:00:00Z',
  };
  return Promise.all([
    page.route('**/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: PROJECTS }),
      }),
    ),
    page.route('**/api/projects/my-project', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: projectConfig,
        }),
      }),
    ),
    page.route('**/api/agents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: agents }),
      }),
    ),
    page.route('**/api/connections/agents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: options?.runtimeConnections ?? [],
        }),
      }),
    ),
    page.route('**/acp/connections', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: options?.acpConnections ?? [],
        }),
      }),
    ),
    page.route('**/api/connections/models', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: 'ollama-local',
              kind: 'model',
              type: 'ollama',
              name: 'Local Ollama',
              enabled: true,
              capabilities: ['llm'],
              config: {
                baseUrl: 'http://localhost:11434',
                defaultModel: 'llama3.2',
                modelOptions: [
                  {
                    id: 'llama3.2',
                    name: 'Llama 3.2',
                    originalId: 'llama3.2',
                  },
                  {
                    id: 'qwen3-coder',
                    name: 'Qwen 3 Coder',
                    originalId: 'qwen3-coder',
                  },
                ],
              },
              status: 'ready',
              prerequisites: [],
            },
          ],
        }),
      }),
    ),
    page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: true,
          acp: { connected: false, connections: [] },
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
            chat: { ready: true, source: 'ollama' },
            runtime: { ready: false, source: null },
            knowledge: { ready: false, source: null },
            acp: { ready: false, source: null },
          },
          recommendation: null,
          prerequisites: [],
          clis: { codex: false, claude: false, 'kiro-cli': false },
        }),
      }),
    ),
    page.route('**/api/system/capabilities', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          voice: { stt: [], tts: [] },
          context: { providers: [] },
        }),
      }),
    ),
    page.route('**/config/app', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            defaultModel: 'llama3.2',
            defaultLLMProvider: 'ollama-local',
          },
        }),
      }),
    ),
    page.route('**/api/bedrock/models', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ models: [] }),
      }),
    ),
    page.route('**/api/conversations**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: [] }),
      }),
    ),
    page.route('**/events', (route) => route.abort()),
  ]);
}

async function selectNoWorkspace(page: import('@playwright/test').Page) {
  const workspace = page.locator('.new-chat-modal__context-button');
  await workspace.click();
  // Desktop renders the anchored `.new-chat-modal__dropdown`; at/below the
  // mobile breakpoint the same options render inside the bottom sheet
  // (`.new-chat-modal__context-sheet`) instead. Only one exists at a time.
  await page
    .locator('.new-chat-modal__dropdown, .new-chat-modal__context-sheet')
    .getByRole('button', { name: /No workspace/ })
    .click();
  await expect(workspace).toContainText('No workspace');
}

/**
 * Open New Chat through whichever affordance the viewport offers: desktop keeps
 * the dock's tab-bar button, a phone moves New/Open/history into the one-row
 * header's overflow sheet.
 */
async function openNewChatForViewport(page: Page) {
  // ChatDock registers this public UI event regardless of whether its desktop
  // tab button, phone overflow action, or collapsed affordance is visible.
  // Drive that stable boundary so the helper also works immediately after a
  // selection creates a chat and changes the dock layout.
  await expect(page.locator('#chat-dock')).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() =>
    window.dispatchEvent(new Event('station:open-new-chat')),
  );
  await expect(page.locator('.new-chat-modal')).toBeVisible({
    timeout: 15_000,
  });
}

test('provider-managed project ignores a stale unsupported project model even when the agent requires MCP', async ({
  page,
}) => {
  // A managed agent with MCP tools is now provider-managed-selectable: the
  // managed path runs its tools on the resolved Model connection. With a ready
  // global default (ollama-local), Station appears regardless of MCP.
  await seedRoutes(page, {
    projectHasProviderDefaults: true,
    projectDefaultModel: 'claude-sonnet-4-6',
    runtimeConnections: [
      agentConnectionFixture({
        id: 'bedrock-runtime',
        kind: 'agent',
        type: 'bedrock-runtime',
        name: 'Amazon Bedrock',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          engineId: 'bedrock',
          executionClass: 'managed',
        },
        status: 'ready',
        runtimeCatalog: {
          source: 'live',
          models: [
            {
              id: 'anthropic.claude-sonnet',
              name: 'Claude Sonnet',
              originalId: 'anthropic.claude-sonnet',
            },
          ],
          builtInModels: [],
        },
        prerequisites: [],
      }),
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('lastProject', 'my-project');
    localStorage.removeItem('recentAgents');
  });

  await page.goto('/?dock=open');

  await openNewChatForViewport(page);

  await expect(page.getByText('New Chat')).toBeVisible({ timeout: 3000 });
  await expect(
    page.locator('.new-chat-modal__context-button', { hasText: 'My Project' }),
  ).toBeVisible();
  await expect(
    page.locator('.new-chat-modal__agent', { hasText: 'Station' }),
  ).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'New Chat' });
  await expect(dialog).not.toContainText('Model not reported');
  await expect(dialog).not.toContainText('Runtime chooses model');
  // archive#3721 rebuilt the picker row down to name + readiness
  // (`components/modals/NewChatModal.tsx:869-950`): there is no pre-chat model
  // trigger any more, and model choice belongs to the session composer, which
  // is where the rest of this test goes. Asserted as an absence so the row
  // cannot quietly regrow one.
  await expect(
    dialog.getByRole('button', {
      name: 'Choose model and options for Station',
    }),
  ).toHaveCount(0);

  await page.locator('.new-chat-modal__agent', { hasText: 'Station' }).click();
  const activeModel = page.locator('.chat-input__model-btn');
  await expect(activeModel).toContainText('Local Ollama');
  await expect(activeModel).toContainText('Llama 3.2');
  await activeModel.click();
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  await expect(picker.getByRole('option', { name: /Llama 3.2/ })).toBeVisible();
  await expect(
    picker.getByRole('option', { name: /Qwen 3 Coder/ }),
  ).toBeVisible();
});

test('selected project context shows Station via the global provider-managed fallback even with MCP', async ({
  page,
}) => {
  await seedRoutes(page, { projectHasProviderDefaults: false });
  await page.addInitScript(() => {
    localStorage.setItem('lastProject', 'my-project');
    localStorage.removeItem('recentAgents');
  });

  await page.goto('/?dock=open');

  await openNewChatForViewport(page);

  await expect(page.getByText('New Chat')).toBeVisible({ timeout: 3000 });
  // Scope to the modal's context button — the expanded sidebar also surfaces
  // the project name now.
  await expect(
    page.locator('.new-chat-modal__context-button', { hasText: 'My Project' }),
  ).toBeVisible();
  const breadcrumb = page.locator(
    '.new-chat-modal__context-button .new-chat-modal__cwd-breadcrumb',
  );
  await expect(breadcrumb).toHaveAttribute(
    'aria-label',
    'Working directory: /Users/brian/dev/github/kontourai',
  );
  await expect(breadcrumb).toContainText('/Users/brian/dev/github/kontourai');

  // No project provider defaults, but the global default (ollama-local) still
  // satisfies provider-managed, so the MCP-having Station agent is selectable.
  await expect(
    page.locator('.new-chat-modal__agent', { hasText: 'Station' }),
  ).toBeVisible();
});

test('new chat lists persisted engine defaults and keeps selected and hovered text accessible', async ({
  page,
}) => {
  await seedRoutes(page, {
    runtimeConnections: [
      agentConnectionFixture({
        id: 'bedrock-runtime',
        kind: 'agent',
        type: 'bedrock-runtime',
        name: 'Bedrock',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          engineId: 'bedrock',
          executionClass: 'managed',
          provider: 'bedrock',
        },
        status: 'ready',
        runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
        prerequisites: [],
      }),
      agentConnectionFixture({
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex-runtime',
        name: 'Codex',
        description: 'Codex Agent',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          engineId: 'codex',
          executionClass: 'external',
        },
        status: 'ready',
        runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
        prerequisites: [],
      }),
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('recentAgents', JSON.stringify(['codex']));
  });

  await page.goto('/?dock=open');
  await openNewChatForViewport(page);

  const modal = page.locator('.new-chat-modal');
  await expect(modal).toBeVisible();
  await selectNoWorkspace(page);
  await expect(modal.getByText('Bedrock')).toHaveCount(0);
  const selected = modal.locator('.new-chat-modal__agent--selected');
  await expect(selected).toContainText('Codex');
  // archive#3721 deleted the row description, and neither of the two remaining
  // trailing elements is a replacement rung: the readiness badge
  // (`@kontourai/ui` `.tone-*`) and the engine chip
  // (`components/badges/EngineChip.css:26-36`) each paint their own opaque
  // background, so their ratio is fixed by a token pair and cannot vary with
  // the row's selected/hover surface — measuring them would assert nothing.
  // The row name is the one text whose colour follows that surface.
  expect(
    await contrastRatio(selected.locator('.new-chat-modal__agent-name')),
  ).toBeGreaterThanOrEqual(4.5);

  const station = modal.locator('.new-chat-modal__agent', {
    hasText: 'Station',
  });
  await station.hover();
  expect(
    await contrastRatio(station.locator('.new-chat-modal__agent-name')),
  ).toBeGreaterThanOrEqual(4.5);
});

test('new chat preserves context, search, keyboard, pointer, and close interactions', async ({
  page,
}) => {
  await seedRoutes(page, {
    runtimeConnections: [
      agentConnectionFixture({
        id: 'bedrock-runtime',
        kind: 'agent',
        type: 'bedrock-runtime',
        name: 'Bedrock',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          engineId: 'bedrock',
          executionClass: 'managed',
          provider: 'bedrock',
        },
        status: 'ready',
        runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
        prerequisites: [],
      }),
      agentConnectionFixture({
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex-runtime',
        name: 'Codex',
        description: 'Codex Agent',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          engineId: 'codex',
          executionClass: 'external',
        },
        status: 'ready',
        runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
        prerequisites: [],
      }),
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('lastProject', 'my-project');
    localStorage.setItem('recentAgents', JSON.stringify(['station']));
  });

  const openModal = async () => {
    await openNewChatForViewport(page);
    await expect(page.locator('.new-chat-modal')).toBeVisible();
  };

  await page.goto('/?dock=open');
  await openModal();

  const modal = page.locator('.new-chat-modal');
  const contextButton = modal.locator('.new-chat-modal__context-button');
  await contextButton.click();
  const dropdown = modal.locator('.new-chat-modal__dropdown');
  await expect(dropdown).toBeVisible();
  const dropdownBreadcrumb = dropdown.locator(
    '.new-chat-modal__cwd-breadcrumb',
  );
  await expect(dropdownBreadcrumb).toHaveAttribute(
    'aria-label',
    'Working directory: /Users/brian/dev/github/kontourai',
  );
  await expect(dropdownBreadcrumb).toContainText(
    '/Users/brian/dev/github/kontourai',
  );

  await dropdown.getByRole('button', { name: /No workspace/ }).click();
  await expect(contextButton).toContainText('No workspace');
  await contextButton.click();
  await dropdown.getByRole('button', { name: /My Project/ }).click();
  await expect(contextButton).toContainText('My Project');

  const search = modal.getByPlaceholder('Search agents...');
  await search.fill('Station');
  await expect(modal.locator('.new-chat-modal__agent')).toHaveCount(1);
  await expect(modal.getByText('Managed Runtime')).toHaveCount(0);
  await search.fill('');

  await contextButton.click();
  await dropdown.getByRole('button', { name: /No workspace/ }).click();
  await expect(contextButton).toContainText('No workspace');

  const rows = modal.locator('.new-chat-modal__agent');
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await expect(rows.nth(0)).toHaveClass(/new-chat-modal__agent--selected/);
  await search.press('ArrowDown');
  await expect(rows.nth(1)).toHaveClass(/new-chat-modal__agent--selected/);
  await expect(rows.nth(0)).not.toHaveClass(/new-chat-modal__agent--selected/);
  await search.press('ArrowUp');
  await expect(rows.nth(0)).toHaveClass(/new-chat-modal__agent--selected/);
  await expect(rows.nth(1)).not.toHaveClass(/new-chat-modal__agent--selected/);
  await search.press('Enter');
  await expect(modal).toHaveCount(0);

  await openModal();
  const station = page.locator('.new-chat-modal__agent', {
    hasText: 'Station',
  });
  await station.hover();
  await expect(station).toHaveClass(/new-chat-modal__agent--selected/);
  await station.click();
  await expect(page.locator('.new-chat-modal')).toHaveCount(0);

  await openModal();
  await page.getByPlaceholder('Search agents...').press('Escape');
  await expect(page.locator('.new-chat-modal')).toHaveCount(0);

  await openModal();
  await page
    .locator('.new-chat-modal__overlay')
    .click({ position: { x: 4, y: 4 } });
  await expect(page.locator('.new-chat-modal')).toHaveCount(0);
});

test('new chat selected and hovered rows meet contrast in light and dark themes', async ({
  page,
}) => {
  await seedRoutes(page, {
    runtimeConnections: [
      agentConnectionFixture({
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex-runtime',
        name: 'Codex',
        description: 'Connected coding runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          engineId: 'codex',
          executionClass: 'external',
        },
        status: 'ready',
        runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
        prerequisites: [],
      }),
    ],
  });
  await page.addInitScript(() => localStorage.removeItem('recentAgents'));
  await page.goto('/?dock=open');
  await openNewChatForViewport(page);
  await selectNoWorkspace(page);

  // `.new-chat-modal__agent` animates `background-color`/`color`, so a reading
  // taken straight after the `data-theme` flip returns the previous theme's
  // surface. This loop happens to do enough work between the flip and the
  // measurement that it currently lands settled — but that is timing luck, and
  // the identical pattern in `accessibility-core` was provably inert for
  // light-theme regressions. Remove the transition instead of relying on it.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; }',
  });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
    }, theme);
    const station = page.locator('.new-chat-modal__agent', {
      hasText: 'Station',
    });
    const hovered = page.locator('.new-chat-modal__agent', {
      hasText: 'Codex',
    });
    const search = page.getByPlaceholder('Search agents...');

    // Select Station through the component's keyboard behavior, then move the
    // pointer away so this samples the selected rule without :hover.
    await page.mouse.move(0, 0);
    await search.fill('Station');
    await expect(page.locator('.new-chat-modal__agent')).toHaveCount(1);
    await expect(station).toHaveClass(/new-chat-modal__agent--selected/);
    // Clearing the filter resets the index to 0 (`NewChatModal.tsx:544-548`),
    // and index 0 is Station: with no Recent group both rows sit in the one
    // "Engines on this machine" band in `/api/agents` order
    // (`new-chat-modal-utils.ts:512-517, 575-582`).
    await search.fill('');
    await expect(page.locator('.new-chat-modal__agent')).toHaveCount(2);
    await expect(station).toHaveClass(/new-chat-modal__agent--selected/);
    await expect(hovered).not.toHaveClass(/new-chat-modal__agent--selected/);
    expect(await station.evaluate((row) => row.matches(':hover'))).toBe(false);
    // archive#3721 deleted the row description; the row NAME is the only text whose
    // colour follows the selected/hover surface. The readiness badge and the
    // engine chip each paint their own opaque background, so their ratio is
    // fixed by a token pair and cannot regress with row state.
    await expect
      .poll(() => contrastRatio(station.locator('.new-chat-modal__agent-name')))
      .toBeGreaterThanOrEqual(4.5);

    // Hovering Codex moves selection there (index 1). Focus the search without
    // moving the pointer, then ArrowUp back to Station (index 0) — Codex is now
    // genuinely hover-only while Station remains selected. Up, not down:
    // `NewChatModal.tsx:555-558` clamps at `Math.max(p - 1, 0)`.
    await hovered.hover();
    await expect(hovered).toHaveClass(/new-chat-modal__agent--selected/);
    await search.focus();
    await search.press('ArrowUp');
    await expect(station).toHaveClass(/new-chat-modal__agent--selected/);
    await expect(hovered).not.toHaveClass(/new-chat-modal__agent--selected/);
    expect(await hovered.evaluate((row) => row.matches(':hover'))).toBe(true);
    await expect
      .poll(() => contrastRatio(hovered.locator('.new-chat-modal__agent-name')))
      .toBeGreaterThanOrEqual(4.5);
  }
});

test('new chat project path stays overflow-free at 390x844', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRoutes(page, { projectHasProviderDefaults: false });
  await page.addInitScript(() => {
    localStorage.removeItem('lastProject');
    localStorage.removeItem('recentAgents');
  });

  await page.goto('/?dock=open');
  await openNewChatForViewport(page);

  const modal = page.locator('.new-chat-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByText('Workspace', { exact: true })).toBeVisible();
  // The task-first Home surface deliberately opens New Chat without an
  // implicit workspace. Choose the project explicitly before proving its
  // project-path layout remains contained on a phone.
  await modal.locator('.new-chat-modal__context-button').click();
  await page
    .locator('.new-chat-modal__dropdown, .new-chat-modal__context-sheet')
    .getByRole('button', { name: 'My Project' })
    .click();
  await expect(modal.locator('.new-chat-modal__context-button')).toContainText(
    'My Project',
  );
  await expect(
    modal.locator('.new-chat-modal__cwd-breadcrumb'),
  ).toHaveAttribute('title', '/Users/brian/dev/github/kontourai');
  expect(
    await page.evaluate(() => ({
      document: document.documentElement.scrollWidth <= window.innerWidth,
      modal:
        document.querySelector('.new-chat-modal')!.scrollWidth <=
        document.querySelector('.new-chat-modal')!.clientWidth,
    })),
  ).toEqual({ document: true, modal: true });
});

test('new chat remains touch-usable and scrollable at 390x844', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installVisualViewportFixture(page);
  await seedRoutes(page, {
    runtimeConnections: Array.from({ length: 12 }, (_, index) =>
      agentConnectionFixture({
        id: `runtime-${index}`,
        type: `runtime-${index}`,
        name: `Runtime ${index}`,
        description: `Connected coding runtime ${index}`,
        config: { executionClass: 'external' },
        runtimeCatalog: { source: 'live', models: [], builtInModels: [] },
      }),
    ),
  });
  await page.addInitScript(() => localStorage.removeItem('recentAgents'));
  await page.goto('/?dock=open');
  await openNewChatForViewport(page);
  await selectNoWorkspace(page);

  await page.evaluate(() =>
    (
      window as typeof window & {
        __setTestVisualViewport: (height: number, offsetTop: number) => void;
      }
    ).__setTestVisualViewport(480, 12),
  );
  await expect
    .poll(() =>
      page.locator('.new-chat-modal__overlay').evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        top: element.getBoundingClientRect().top,
      })),
    )
    .toEqual({ height: 480, top: 12 });

  const modal = page.locator('.new-chat-modal');
  const list = modal.locator('.new-chat-modal__list');
  const contextButton = modal.locator('.new-chat-modal__context-button');
  const firstAgent = modal.locator('.new-chat-modal__agent').first();
  const search = modal.getByPlaceholder('Search agents...');
  const close = modal.getByRole('button', { name: 'Close new chat' });
  await expect(search).not.toBeFocused();
  const mainContentBefore = await page
    .locator('.main-content')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.className = 'banner-host';
    host.setAttribute('data-testid', 'banner-host');
    const banner = document.createElement('div');
    banner.className = 'banner-host__item banner-host__item--blocked';
    banner.setAttribute('role', 'alert');
    banner.setAttribute('data-banner-id', 'chrome:onboarding:credential');
    banner.innerHTML =
      '<span>Pair this device to reconnect.</span><button type="button">Pair this device</button>';
    host.append(banner);
    document.querySelector('.app__main')!.append(host);
  });
  const layerOrder = await page.evaluate(() => ({
    dialog: Number(
      getComputedStyle(document.querySelector('.responsive-surface-overlay')!)
        .zIndex,
    ),
    // BannerHost chrome is an overlay at --layer-notice (archive#3308); the
    // dialog overlay's layer must still exceed it.
    reconnectNotice:
      Number(
        getComputedStyle(document.querySelector('.banner-host')!).zIndex,
      ) || 0,
  }));
  expect(layerOrder.dialog).toBeGreaterThan(layerOrder.reconnectNotice);
  // The overlay never reflows the app: presenting a banner must leave
  // `.main-content` exactly where it was (archive#3308 contract, replacing
  // the old in-flow assertion).
  const mainContentAfter = await page
    .locator('.main-content')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
  expect(mainContentAfter).toEqual(mainContentBefore);
  const dimensions = await Promise.all(
    [contextButton, firstAgent, close].map((locator) => locator.boundingBox()),
  );
  for (const box of dimensions) {
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(box!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  }
  const closeBox = dimensions[2]!;
  expect(closeBox.y).toBeGreaterThanOrEqual(12);
  expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(492);

  const before = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
  await list.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  expect(
    await page.evaluate(() => {
      const dialog = document.querySelector('.new-chat-modal')!;
      return {
        documentOverflow:
          document.documentElement.scrollWidth > window.innerWidth,
        dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
        withinViewport:
          dialog.getBoundingClientRect().left >= 0 &&
          dialog.getBoundingClientRect().right <= window.innerWidth &&
          dialog.getBoundingClientRect().top >=
            window.visualViewport!.offsetTop &&
          dialog.getBoundingClientRect().bottom <=
            window.visualViewport!.offsetTop + window.visualViewport!.height,
      };
    }),
  ).toEqual({
    documentOverflow: false,
    dialogOverflow: false,
    withinViewport: true,
  });

  await close.click();
  await expect(modal).toHaveCount(0);
});

test('OpenCode exposes live model switching in chat at 390x844', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRoutes(page, {
    runtimeConnections: [
      agentConnectionFixture({
        id: 'opencode',
        kind: 'agent',
        // OpenCode is an ACP-connected engine
        // (`src-server/providers/llm/defaults.ts:62-69`); there is no
        // `opencode` entry in `ENGINE_CAPABILITY_MATRICES`, so an invented
        // `opencode-runtime` type resolves to
        // `UNKNOWN_EXTERNAL_ENGINE_MATRIX` — whose `modelSelection` is
        // `unsupported`, which is what disabled the composer's model button
        // this test is about.
        type: 'acp',
        name: 'OpenCode',
        enabled: true,
        capabilities: ['agent-runtime', 'session-lifecycle'],
        config: {
          engineId: 'opencode',
          executionClass: 'external',
        },
        status: 'ready',
        runtimeCatalog: {
          source: 'live',
          models: [
            {
              id: 'opencode/big-pickle',
              name: 'Big Pickle',
              originalId: 'opencode/big-pickle',
            },
            {
              id: 'opencode/gpt-5.5',
              name: 'GPT-5.5',
              originalId: 'opencode/gpt-5.5',
            },
          ],
          builtInModels: [],
        },
        prerequisites: [],
      }),
    ],
    acpConnections: [
      {
        id: 'opencode',
        name: 'OpenCode',
        enabled: true,
        status: 'available',
        modes: ['build', 'plan'],
        currentModel: 'opencode/big-pickle',
        configOptions: [
          {
            category: 'mode',
            currentValue: 'plan',
            options: ['build', 'plan'],
          },
          {
            category: 'model',
            currentValue: 'opencode/big-pickle',
            options: ['opencode/big-pickle', 'opencode/gpt-5.5'],
          },
        ],
      },
    ],
  });
  await page.addInitScript(() => localStorage.removeItem('recentAgents'));
  await page.goto('/?dock=open');
  await openNewChatForViewport(page);
  await selectNoWorkspace(page);
  await page.getByPlaceholder('Search agents...').fill('OpenCode');

  const newChat = page.getByRole('dialog', { name: 'New Chat' });
  await expect(newChat).not.toContainText('Live catalog');
  await expect(newChat).not.toContainText('unknown');
  await page.locator('.new-chat-modal__agent', { hasText: 'OpenCode' }).click();

  const activeModel = page.locator('.chat-input__model-btn');
  await expect(activeModel).toContainText('OpenCode');
  await expect(activeModel).toContainText('Big Pickle');
  // Glossary vocabulary only (docs/design/chat-composer.md §3.3) — the
  // internal 'runtime' source label renders as "reported by app", not the
  // banned word "runtime" itself.
  await expect(activeModel).not.toContainText('runtime');
  await expect(activeModel).toHaveAttribute('aria-label', /reported by app/);
  await expect(activeModel).not.toHaveAttribute('aria-label', /runtime/);
  await activeModel.click();
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  await picker.getByRole('option', { name: /GPT-5.5/ }).click();
  // The live switch itself: the composer now names the model the engine is on.
  await expect(activeModel).toContainText('GPT-5.5');
  // …and it is still an APP-REPORTED model, not a local session override. An
  // ACP engine's model selection travels over the wire
  // (`packages/contracts/src/engine-capability-matrix.ts:816` —
  // `{ state: 'session', channel: 'wire' }`), so the engine acknowledges the
  // choice and reports it; there is no local override held on the chat and
  // therefore no local reset to offer. The override/reset pair is the
  // local-channel affordance and is owned by
  // `src-ui/src/__tests__/ChatInputArea.test.tsx:384` ("offers a session-only
  // reset when an override is active") over
  // `src-ui/src/__tests__/execution.test.ts:1112`.
  await expect(activeModel).toHaveAttribute('aria-label', /reported by app/);
  await expect(activeModel).not.toContainText('runtime');
  await expect(
    page.getByRole('button', { name: 'Use reported by app' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('new chat keeps engine diagnostics out of the mobile Agent chooser', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedRoutes(page, {
    runtimeConnections: [
      agentConnectionFixture({
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex-runtime',
        name: 'Codex',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          engineId: 'codex',
          executionClass: 'connected',
          defaultModel: 'gpt-5-codex',
        },
        status: 'ready',
        runtimeCatalog: {
          source: 'live',
          models: [
            {
              id: 'gpt-5-codex',
              name: 'GPT-5 Codex',
              originalId: 'gpt-5-codex',
            },
          ],
          builtInModels: [],
        },
        prerequisites: [],
        readinessEvidence: {
          evidenceVersion: 1,
          level: 'catalog-ready',
          observedAt: '2026-07-13T12:00:00.000Z',
          freshness: 'fresh',
          summary:
            'Live model catalog loaded, but no successful smoke is current.',
          action:
            'Run an explicit one-turn smoke before relying on this runtime.',
          smoke: {
            status: 'failed',
            freshness: 'fresh',
            testedAt: '2026-07-13T12:00:00.000Z',
            reasonCode: 'turn-failed',
            reason: 'The runtime rejected the test turn.',
            action: 'Check runtime authentication, then run the smoke again.',
            turnLimit: 1,
          },
        },
      }),
    ],
  });
  await page.addInitScript(() => localStorage.removeItem('recentAgents'));
  await page.goto('/?dock=open');
  await openNewChatForViewport(page);
  await selectNoWorkspace(page);
  await page.getByPlaceholder('Search agents...').fill('Codex');

  const runtime = page.locator('.new-chat-modal__agent', {
    hasText: 'Codex',
  });
  await expect(runtime).not.toContainText('Confidence');
  await expect(runtime).not.toContainText('Smoke failed');
  await expect(runtime).not.toContainText('Live catalog');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await runtime.click();
  const activeModel = page.locator('.chat-input__model-btn');
  await expect(activeModel).toContainText('GPT-5 Codex');
  await activeModel.click();
  await expect(
    page.getByRole('dialog', { name: 'Choose model' }),
  ).toBeVisible();
});

test('new chat shows degraded engine compatibility messaging from its catalog status', async ({
  page,
}) => {
  await seedRoutes(page, {
    runtimeConnections: [
      agentConnectionFixture({
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex-runtime',
        name: 'Codex',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: {
          engineId: 'codex',
          executionClass: 'connected',
          defaultModel: 'gpt-5-codex',
        },
        status: 'degraded',
        runtimeCatalog: {
          source: 'built-in',
          reason: 'Live catalog unavailable.',
          models: [],
          builtInModels: [
            {
              id: 'gpt-5-codex',
              name: 'GPT-5 Codex',
              originalId: 'gpt-5-codex',
            },
          ],
        },
        prerequisites: [],
      }),
    ],
  });
  await page.addInitScript(() => {
    localStorage.removeItem('recentAgents');
  });

  await page.goto('/?dock=open');

  await openNewChatForViewport(page);

  await expect(page.getByText('New Chat')).toBeVisible({ timeout: 3000 });
  await expect(page.getByText(/Codex: Degraded/)).toBeVisible();
});

test('new chat shows Station when the Station Agent matches the capability set', async ({
  page,
}) => {
  await seedRoutes(page, { agentRequiresMcp: false });
  await page.addInitScript(() => {
    localStorage.removeItem('recentAgents');
  });

  await page.goto('/?dock=open');

  await openNewChatForViewport(page);

  await expect(page.getByText('New Chat')).toBeVisible({ timeout: 3000 });
  // DESIGN §5: the picker groups by the Agents list's two bands
  // (`components/agent-provenance.ts:29-30`, rendered at
  // `NewChatModal.tsx:645-656`), not by engine name. `engineDefault: true`
  // puts Station in the engine band, and the row's accessible name is
  // "<name> <readiness state>" (`AgentReadinessCell.tsx:71`).
  const dialog = page.getByRole('dialog', { name: 'New Chat' });
  await expect(dialog.getByText('Engines on this machine')).toBeVisible();
  await expect(dialog.getByText('Your agents')).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Station Ready' }),
  ).toBeVisible();
});
