import { expect, type Page, test } from '@playwright/test';
import { contrastRatio } from './helpers/color-contrast';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
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
    workingDirectory: '/Users/me/dev/github/kontourai',
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

/** The dock's start composer (the New chat dialog's one form). */
function startComposer(page: import('@playwright/test').Page) {
  return page
    .getByRole('dialog', { name: 'New chat', exact: true })
    .getByRole('form', { name: 'Start work' });
}

/** Chooses a project (or No project) on the composer's project chip. */
async function chooseProject(
  page: import('@playwright/test').Page,
  name: string | RegExp,
) {
  await startComposer(page)
    .getByRole('button', { name: /^Project: / })
    .click();
  const menu = page.getByRole('dialog', { name: 'Choose project' });
  await menu.getByRole('button', { name }).click();
  await expect(menu).toHaveCount(0);
}

async function selectNoWorkspace(page: import('@playwright/test').Page) {
  await chooseProject(page, /No project/);
  await expect(
    startComposer(page).getByRole('button', {
      name: 'Project: No project',
      exact: true,
    }),
  ).toBeVisible();
}

/** Opens the composer's Agent chip list and returns it. */
async function openAgentList(page: import('@playwright/test').Page) {
  await startComposer(page)
    .getByRole('button', { name: /^Agent:/ })
    .click();
  const agents = page.getByRole('dialog', { name: 'Choose agent' });
  await expect(agents).toBeVisible();
  return agents;
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

  await expect(startComposer(page)).toBeVisible({ timeout: 3000 });
  // Last-visited context must not silently bind a new chat (#3362: the start
  // composer's project chip). Choose the project explicitly before checking
  // its model/engine behavior.
  await expect(
    startComposer(page).getByRole('button', {
      name: 'Project: No project',
      exact: true,
    }),
  ).toBeVisible();
  await chooseProject(page, /My Project/);
  await expect(
    startComposer(page).getByRole('button', {
      name: 'Project: My Project',
      exact: true,
    }),
  ).toBeVisible();
  const agents = await openAgentList(page);
  await expect(
    agents.locator('.new-chat-modal__agent', { hasText: 'Station' }),
  ).toBeVisible();
  // The stale unsupported project Model is ignored: no "not reported" and no
  // "runtime chooses" fallbacks anywhere in the draft.
  const dialog = page.getByRole('dialog', { name: 'New chat', exact: true });
  for (const surface of [dialog, agents]) {
    await expect(surface).not.toContainText('Model not reported');
    await expect(surface).not.toContainText('Runtime chooses model');
    await expect(surface).not.toContainText('claude-sonnet-4-6');
  }
  // archive#3721's absence still holds: no separate "model and options"
  // control; the row's own Model control is the picker.
  await expect(
    agents.getByRole('button', {
      name: 'Choose model and options for Station',
    }),
  ).toHaveCount(0);

  await agents
    .locator('.new-chat-modal__agent', { hasText: 'Station' })
    .click();
  // The chip names the provider-managed default, not the stale project Model.
  await expect(
    startComposer(page).getByRole('button', {
      name: /^Agent: Station · Llama 3\.2$/,
    }),
  ).toBeVisible();
  const again = await openAgentList(page);
  await again
    .locator('.new-chat-modal__agent-row', { hasText: 'Station' })
    .getByRole('button', { name: /^Model: / })
    .click();
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

  await expect(startComposer(page)).toBeVisible({ timeout: 3000 });
  // Last-visited context must not silently bind a new chat. Choose the
  // project explicitly before checking its model/engine behavior.
  await expect(
    startComposer(page).getByRole('button', {
      name: 'Project: No project',
      exact: true,
    }),
  ).toBeVisible();
  await chooseProject(page, /My Project/);
  const chip = startComposer(page).getByRole('button', {
    name: 'Project: My Project',
    exact: true,
  });
  await expect(chip).toHaveAttribute(
    'title',
    'Runs in /Users/me/dev/github/kontourai',
  );
  // The project menu states the folder the chat runs in.
  await chip.click();
  const menu = page.getByRole('dialog', { name: 'Choose project' });
  await expect(
    menu.locator('.start-menu__hint .new-chat-modal__cwd-breadcrumb'),
  ).toHaveAttribute(
    'aria-label',
    'Working directory: /Users/me/dev/github/kontourai',
  );
  await menu.press('Escape');

  // No project provider defaults, but the global default (ollama-local) still
  // satisfies provider-managed, so the MCP-having Station agent is selectable.
  const agents = await openAgentList(page);
  await expect(
    agents.locator('.new-chat-modal__agent', { hasText: 'Station' }),
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
        id: 'codex',
        kind: 'agent',
        type: 'codex',
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

  await selectNoWorkspace(page);
  // The Agent chip opens on the remembered engine default (#3362).
  await expect(
    startComposer(page).getByRole('button', { name: /^Agent: Codex/ }),
  ).toBeVisible();
  const modal = await openAgentList(page);
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
        id: 'codex',
        kind: 'agent',
        type: 'codex',
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
    await expect(startComposer(page)).toBeVisible();
  };

  await page.goto('/?dock=open');
  await openModal();

  // Context: the project chip's list states each project's folder (#3362).
  const projectChip = startComposer(page).getByRole('button', {
    name: /^Project: /,
  });
  await projectChip.click();
  const dropdown = page.getByRole('dialog', { name: 'Choose project' });
  await expect(dropdown).toBeVisible();
  const dropdownBreadcrumb = dropdown
    .locator('[data-context-value="my-project"]')
    .locator('.new-chat-modal__cwd-breadcrumb');
  await expect(dropdownBreadcrumb).toHaveAttribute(
    'aria-label',
    'Working directory: /Users/me/dev/github/kontourai',
  );
  await expect(dropdownBreadcrumb).toContainText(
    '/Users/me/dev/github/kontourai',
  );
  await dropdown.getByRole('button', { name: /No project/ }).click();
  await expect(projectChip).toHaveAccessibleName('Project: No project');
  await chooseProject(page, /My Project/);
  await expect(projectChip).toHaveAccessibleName('Project: My Project');

  // Search, in the Agent chip's list.
  let agents = await openAgentList(page);
  const search = agents.getByPlaceholder('Search agents...');
  await search.fill('Station');
  await expect(agents.locator('.new-chat-modal__agent')).toHaveCount(1);
  await expect(agents.getByText('Managed Runtime')).toHaveCount(0);
  await search.fill('');
  await search.press('Escape');
  // Escape closes the list alone, never the draft.
  await expect(agents).toHaveCount(0);
  await expect(startComposer(page)).toBeVisible();

  await chooseProject(page, /No project/);
  await expect(projectChip).toHaveAccessibleName('Project: No project');

  // Keyboard: arrows move the highlight; Enter chooses the Agent and closes
  // the list, and starts nothing.
  agents = await openAgentList(page);
  const rows = agents.locator('.new-chat-modal__agent');
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await expect(rows.nth(0)).toHaveClass(/new-chat-modal__agent--selected/);
  const listSearch = agents.getByPlaceholder('Search agents...');
  await listSearch.press('ArrowDown');
  await expect(rows.nth(1)).toHaveClass(/new-chat-modal__agent--selected/);
  await expect(rows.nth(0)).not.toHaveClass(/new-chat-modal__agent--selected/);
  await listSearch.press('ArrowUp');
  await expect(rows.nth(0)).toHaveClass(/new-chat-modal__agent--selected/);
  await expect(rows.nth(1)).not.toHaveClass(/new-chat-modal__agent--selected/);
  const firstName = (
    await rows.nth(0).locator('.new-chat-modal__agent-name').textContent()
  )?.trim();
  await listSearch.press('Enter');
  await expect(agents).toHaveCount(0);
  await expect(
    startComposer(page).getByRole('button', {
      name: new RegExp(`^Agent: ${firstName}`),
    }),
  ).toBeVisible();

  // Pointer: hover highlights, a click chooses and closes the list.
  agents = await openAgentList(page);
  const station = agents.locator('.new-chat-modal__agent', {
    hasText: 'Station',
  });
  await station.hover();
  await expect(station).toHaveClass(/new-chat-modal__agent--selected/);
  await station.click();
  await expect(agents).toHaveCount(0);
  await expect(
    startComposer(page).getByRole('button', { name: /^Agent: Station/ }),
  ).toBeVisible();

  // Close: Escape in the draft, and a click outside it.
  await startComposer(page)
    .getByRole('textbox', { name: 'What would you like done?' })
    .press('Escape');
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
        id: 'codex',
        kind: 'agent',
        type: 'codex',
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
  // The rows live in the Agent chip's list now (#3362).
  const list = await openAgentList(page);

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
    const station = list.locator('.new-chat-modal__agent', {
      hasText: 'Station',
    });
    const hovered = list.locator('.new-chat-modal__agent', {
      hasText: 'Codex',
    });
    const search = list.getByPlaceholder('Search agents...');

    // Select Station through the component's keyboard behavior, then move the
    // pointer away so this samples the selected rule without :hover.
    await page.mouse.move(0, 0);
    await search.fill('Station');
    await expect(list.locator('.new-chat-modal__agent')).toHaveCount(1);
    await expect(station).toHaveClass(/new-chat-modal__agent--selected/);
    // Clearing the filter resets the index to 0 (`NewChatModal.tsx:544-548`),
    // and index 0 is Station: with no Recent group both rows sit in the one
    // "AI apps" band in `/api/agents` order
    // (`new-chat-modal-utils.ts:512-517, 575-582`).
    await search.fill('');
    await expect(list.locator('.new-chat-modal__agent')).toHaveCount(2);
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
  // The task-first Home surface deliberately opens New Chat without an
  // implicit workspace. Choose the project explicitly before proving its
  // project-path layout remains contained on a phone.
  await expect(
    startComposer(page).getByRole('button', {
      name: 'Project: No project',
      exact: true,
    }),
  ).toBeVisible();
  await chooseProject(page, /My Project/);
  // The chip names the project and carries the folder the chat runs in.
  const chip = startComposer(page).getByRole('button', {
    name: 'Project: My Project',
    exact: true,
  });
  await expect(chip).toHaveAttribute(
    'title',
    'Runs in /Users/me/dev/github/kontourai',
  );
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
  await seedRoutes(page);
  await page.route('**/api/agents', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: [
          ...AGENTS,
          ...Array.from({ length: 12 }, (_, index) => ({
            ...AGENTS[0],
            slug: `saved-agent-${index}`,
            name: `Saved agent ${index}`,
            engineDefault: false,
            description: `Distinct saved agent ${index}`,
          })),
        ],
      },
    }),
  );
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
  // The draft's own targets: both chips and Close (#3362: the start
  // composer replaced the inline list).
  const projectChip = startComposer(page).getByRole('button', {
    name: /^Project: /,
  });
  const agentChip = startComposer(page).getByRole('button', {
    name: /^Agent:/,
  });
  const close = modal.getByRole('button', { name: 'Close new chat' });
  // No keyboard is summoned on a phone before the person asks to type.
  await expect(
    startComposer(page).getByRole('textbox', {
      name: 'What would you like done?',
    }),
  ).not.toBeFocused();
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
    [projectChip, agentChip, close].map((locator) => locator.boundingBox()),
  );
  for (const box of dimensions) {
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(box!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  }
  const closeBox = dimensions[2]!;
  expect(closeBox.y).toBeGreaterThanOrEqual(12);
  expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(492);

  // The draft stays inside the visual viewport and the page does not
  // overflow, before and after the Agent list opens.
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

  // The Agent list: a sheet whose own list scrolls, with 44px rows.
  const agents = await openAgentList(page);
  const list = agents.locator('.start-menu__list');
  const firstAgent = agents.locator('.new-chat-modal__agent').first();
  const firstBox = await firstAgent.boundingBox();
  expect(firstBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  await expect(agents.getByPlaceholder('Search agents...')).not.toBeFocused();
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
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await agents.getByRole('button', { name: 'Close agent list' }).click();
  await expect(agents).toHaveCount(0);

  await close.click();
  await expect(modal).toHaveCount(0);
});

test('OpenCode chooses its model where the chat starts, and says it is fixed after, at 390x844', async ({
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
  const agents = await openAgentList(page);
  await agents.getByPlaceholder('Search agents...').fill('OpenCode');
  await expect(agents).not.toContainText('Live catalog');
  await expect(agents).not.toContainText('unknown');
  // OpenCode chooses its model for a new chat, not inside an existing
  // conversation, so the choice is made where the chat starts: its row's
  // Model control in the start composer (#3362; the old empty-chat model
  // button no longer exists, since a chat starts with its first message).
  const row = agents.locator('.new-chat-modal__agent-row', {
    hasText: 'OpenCode',
  });
  const rowModel = row.getByRole('button', { name: /^Model: / });
  await expect(rowModel).toContainText('Big Pickle');
  // Glossary vocabulary only (docs/design/chat-composer.md §3.3).
  await expect(rowModel).not.toContainText('runtime');
  await rowModel.click();
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  await picker.getByRole('option', { name: /GPT-5.5/ }).click();
  // Choosing the Model closes the picker; nothing is left to dismiss.
  await expect(picker).toBeHidden();
  const chip = startComposer(page).getByRole('button', { name: /^Agent: / });
  await expect(chip).toHaveAccessibleName('Agent: OpenCode · GPT-5.5');

  // Start carries the chosen model to the engine.
  const sent: Record<string, unknown>[] = [];
  await page.route('**/api/orchestration/chat{,/background}', (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        foregroundMessageReceiptEnvelope({
          conversationId: 'opencode-conversation',
          agent: 'agent:opencode',
        }),
      ),
    });
  });
  await startComposer(page)
    .getByRole('textbox', { name: 'What would you like done?' })
    .fill('Plan the change');
  await startComposer(page)
    .getByRole('button', { name: 'Start', exact: true })
    .click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({
    target: { model: { override: 'opencode/gpt-5.5' } },
  });

  // In the started chat the model is named and honestly not changeable:
  // the engine cannot switch it inside a conversation.
  const activeModel = page.locator('.chat-input__model-btn');
  await expect(activeModel).toContainText('GPT-5.5');
  await expect(activeModel).toHaveAttribute('aria-disabled', 'true');
  await expect(activeModel).toHaveAttribute(
    'aria-label',
    /cannot change it in an existing conversation/,
  );
  await expect(activeModel).not.toContainText('runtime');
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
        id: 'codex',
        kind: 'agent',
        type: 'codex',
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
  const agents = await openAgentList(page);
  await agents.getByPlaceholder('Search agents...').fill('Codex');

  const runtime = agents.locator('.new-chat-modal__agent', {
    hasText: 'Codex',
  });
  await expect(runtime).toBeVisible();
  await expect(runtime).not.toContainText('Confidence');
  await expect(runtime).not.toContainText('Smoke failed');
  await expect(runtime).not.toContainText('Live catalog');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  // Choosing the row chooses the Agent; its Model (and the picker) are the
  // row's own Model control.
  await runtime.click();
  await expect(agents).toHaveCount(0);
  await expect(
    startComposer(page).getByRole('button', {
      name: 'Agent: Codex · GPT-5 Codex',
      exact: true,
    }),
  ).toBeVisible();
  const again = await openAgentList(page);
  await again.getByRole('button', { name: /^Model: GPT-5 Codex/ }).click();
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
        id: 'codex',
        kind: 'agent',
        type: 'codex',
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

  await expect(startComposer(page)).toBeVisible({ timeout: 3000 });
  // The catalog's compatibility warning reads in the Agent list, where the
  // choice it qualifies is made.
  const agents = await openAgentList(page);
  await expect(agents.getByText(/Codex: Degraded/)).toBeVisible();
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

  await expect(startComposer(page)).toBeVisible({ timeout: 3000 });
  // DESIGN §5: the picker groups by the Agents list's two bands
  // (`components/agent-provenance.ts:29-30`), not by engine name.
  // `engineDefault: true` puts Station in the engine band, and the row's
  // accessible name is "<name> <readiness state>" (`AgentReadinessCell.tsx`).
  const dialog = await openAgentList(page);
  await expect(dialog.getByText('AI apps')).toBeVisible();
  await expect(dialog.getByText('Your agents')).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Station Ready' }),
  ).toBeVisible();
});
