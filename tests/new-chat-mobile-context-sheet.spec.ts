import { expect, type Page, test } from '@playwright/test';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * kontourai/archive#689 — the New Chat workspace/project picker must be
 * fully usable on mobile: no clipping inside the header's scroll box, no
 * nested scroll-fighting between the header and the picker, and a single
 * contained scroll region (the bottom sheet's own list).
 *
 * Mirrors the seeding conventions of tests/new-chat-provider-managed.spec.ts
 * (same route surface, same `.new-chat-modal__*` locators) but supplies a
 * long project list so the sheet must actually scroll, and exercises the
 * open -> scroll -> filter -> pick journey at 390x844.
 */

const PROJECT_COUNT = 14;

const PROJECTS = Array.from({ length: PROJECT_COUNT }, (_, index) => ({
  id: `p${index}`,
  slug: `project-${index}`,
  name: `Project ${index}`,
  icon: '🚀',
  description: `Workspace ${index}`,
  hasWorkingDirectory: true,
  workingDirectory: `/Users/brian/dev/project-${index}`,
  layoutCount: 0,
  hasKnowledge: false,
}));

const AGENTS = [
  {
    slug: 'station',
    name: 'Station',
    description: 'Default agent with full access to manage Station',
    source: 'local',
    model: 'us.anthropic.claude-sonnet-4-6',
    toolsConfig: { mcpServers: [], autoApprove: [] },
  },
];

function json(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function seedRoutes(page: Page) {
  await Promise.all([
    page.route('**/api/projects', (route) =>
      route.fulfill(json({ success: true, data: PROJECTS })),
    ),
    page.route(/\/api\/projects\/project-\d+$/, (route) => {
      const slug = new URL(route.request().url()).pathname.split('/').pop();
      const project = PROJECTS.find((candidate) => candidate.slug === slug);
      return route.fulfill(
        json({
          success: true,
          data: {
            ...project,
            agents: ['station'],
            createdAt: '2026-04-12T00:00:00Z',
            updatedAt: '2026-04-12T00:00:00Z',
          },
        }),
      );
    }),
    page.route('**/api/agents', (route) =>
      route.fulfill(json({ success: true, data: AGENTS })),
    ),
    page.route('**/api/connections/agents', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    ),
    page.route('**/acp/connections', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    ),
    page.route('**/api/connections/models', (route) =>
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
              config: {
                baseUrl: 'http://localhost:11434',
                defaultModel: 'llama3.2',
                modelOptions: [
                  { id: 'llama3.2', name: 'Llama 3.2', originalId: 'llama3.2' },
                ],
              },
              status: 'ready',
              prerequisites: [],
            },
          ],
        }),
      ),
    ),
    page.route('**/api/system/status', (route) =>
      route.fulfill(
        json({
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
      ),
    ),
    page.route('**/api/system/capabilities', (route) =>
      route.fulfill(
        json({ voice: { stt: [], tts: [] }, context: { providers: [] } }),
      ),
    ),
    page.route('**/config/app', (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            defaultModel: 'llama3.2',
            defaultLLMProvider: 'ollama-local',
          },
        }),
      ),
    ),
    page.route('**/api/bedrock/models', (route) =>
      route.fulfill(json({ models: [] })),
    ),
    page.route('**/api/conversations**', (route) =>
      route.fulfill(json({ conversations: [] })),
    ),
    page.route('**/events', (route) => route.abort()),
  ]);
}

async function openNewChat(page: Page) {
  await page.goto('/?dock=open');
  // Secondary chat actions live in the phone header's menu. This fixture has
  // one ready runtime, so opening the chooser itself uses the same explicit
  // new-chat command as the command palette rather than the quick-start path.
  await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'New chat', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close actions menu' }).click();
  await page.evaluate(() =>
    window.dispatchEvent(new Event('station:open-new-chat')),
  );
  const modal = page.locator('.new-chat-modal');
  await expect(modal).toBeVisible();
  return modal;
}

test.describe('New Chat mobile workspace picker (390x844)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      localStorage.removeItem('lastProject');
      localStorage.removeItem('recentAgents');
    });
    await seedRoutes(page);
  });

  test('opens as a bottom sheet instead of the clipped anchored dropdown', async ({
    page,
  }) => {
    const modal = await openNewChat(page);
    const contextButton = modal.locator('.new-chat-modal__context-button');
    await contextButton.click();

    // Mobile never renders the desktop anchored dropdown (it would be clipped
    // by the header's `overflow-y: auto`); it renders the bottom sheet.
    await expect(modal.locator('.new-chat-modal__dropdown')).toHaveCount(0);
    const sheet = page.getByRole('dialog', { name: 'Select workspace' });
    await expect(sheet).toBeVisible();

    // The sheet overlay sits fixed above the whole modal and is not clipped
    // by (nor a source of) the header's own scroll box.
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox).not.toBeNull();
    expect(sheetBox!.y).toBeGreaterThanOrEqual(0);
    expect(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(844);

    // Design decision: no autofocus on mobile, to avoid a keyboard-driven
    // viewport jump the instant the sheet opens.
    const filter = sheet.getByPlaceholder('Filter...');
    await expect(filter).not.toBeFocused();
  });

  test('scrolls its own contained list, filters, and picks a workspace', async ({
    page,
  }) => {
    const modal = await openNewChat(page);
    const contextButton = modal.locator('.new-chat-modal__context-button');
    await contextButton.click();

    const sheet = page.getByRole('dialog', { name: 'Select workspace' });
    await expect(sheet).toBeVisible();
    const list = sheet.locator('.new-chat-modal__context-sheet-list');

    // The list is genuinely the only scroll container in play: it overflows
    // its own box, and the header behind it never moves.
    const header = page.locator('.new-chat-modal__header');
    const headerScrollBefore = await header.evaluate((el) => el.scrollTop);
    const before = await list.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    }));
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);

    await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    expect(await header.evaluate((el) => el.scrollTop)).toBe(
      headerScrollBefore,
    );

    // The last project is reachable now that it has scrolled into view —
    // this is exactly the option the old clipped dropdown could strand.
    // (Text-content match, not accessible-name match: the item's accessible
    // name also folds in the working-directory breadcrumb's own aria-label.)
    const lastProject = sheet.locator('.new-chat-modal__dropdown-item', {
      hasText: `Project ${PROJECT_COUNT - 1}`,
    });
    await expect(lastProject).toBeInViewport();
    const lastBox = await lastProject.boundingBox();
    expect(lastBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    // Filter narrows the list to a single match.
    const filter = sheet.getByPlaceholder('Filter...');
    await filter.fill('Project 3');
    const matches = sheet.locator('.new-chat-modal__dropdown-item');
    await expect(matches).toHaveCount(1);
    await expect(matches).toContainText('Project 3');

    // Picking closes the sheet and updates the trigger.
    await matches.click();
    await expect(sheet).toBeHidden();
    await expect(contextButton).toContainText('Project 3');
  });

  test('dismisses on outside tap and on Escape without picking anything', async ({
    page,
  }) => {
    const modal = await openNewChat(page);
    const contextButton = modal.locator('.new-chat-modal__context-button');
    const selectionBefore = await contextButton.textContent();

    await contextButton.click();
    let sheet = page.getByRole('dialog', { name: 'Select workspace' });
    await expect(sheet).toBeVisible();
    // Tap the backdrop area above the sheet (not the sheet panel itself).
    await page.locator('.new-chat-modal__context-sheet-overlay').click({
      position: { x: 8, y: 8 },
    });
    await expect(sheet).toBeHidden();
    await expect(contextButton).toHaveText(selectionBefore ?? '');

    await contextButton.click();
    sheet = page.getByRole('dialog', { name: 'Select workspace' });
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    // Escape closed only the sheet, not the whole New Chat modal.
    await expect(modal).toBeVisible();
    await expect(contextButton).toHaveText(selectionBefore ?? '');
  });
});
