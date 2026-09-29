import { expect, type Page } from '@playwright/test';
import { codingNavigation, openCodingView } from './helpers/coding-stack';
import { test } from './helpers/fixture-audit';
import {
  DEFAULT_CONVERSATION_LOOKUPS,
  DEFAULT_CONVERSATIONS,
  dismissSetupLauncher,
  installMockOrchestrationSse,
  seedActiveChats,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

/**
 * #928 coding stack, desktop slice: the Coding layout's centre is a
 * navigation stack — the conversation (Chat page, with its inbox) and the
 * panes drilled into from it. Every page change is browser history; the
 * inbox choosing another conversation is not.
 */

const ROUTE = '/projects/dev/layouts/code';

async function seed(page: Page) {
  await seedActiveChats(page, [
    {
      sessionId: 'session-1',
      conversationId: 'conv-1',
      agentSlug: 'dev-agent',
      title: 'Fix the login flake',
      model: 'claude-sonnet',
      provider: 'codex',
      providerOptions: {},
      projectSlug: 'dev',
      projectName: 'Dev',
      orchestrationSessionStarted: true,
      inputHistory: [],
      ephemeralMessages: [],
    },
    {
      sessionId: 'session-2',
      conversationId: 'conv-2',
      agentSlug: 'dev-agent',
      title: 'Tidy the README',
      model: 'claude-sonnet',
      provider: 'codex',
      providerOptions: {},
      projectSlug: 'dev',
      projectName: 'Dev',
      orchestrationSessionStarted: true,
      inputHistory: [],
      ephemeralMessages: [],
    },
  ]);
  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page, {
    conversations: [
      ...DEFAULT_CONVERSATIONS,
      {
        id: 'conv-2',
        title: 'Tidy the README',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        messageCount: 0,
      },
    ],
    conversationLookups: {
      ...DEFAULT_CONVERSATION_LOOKUPS,
      'conv-2': {
        id: 'conv-2',
        currentSessionId: 'session-2',
        agentSlug: 'dev-agent',
        projectSlug: 'dev',
        title: 'Tidy the README',
      },
    },
  });
  await page.route('**/api/coding/diff**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: '@@ -1 +1 @@\n-console.log("old")\n+console.log("new")\n',
      }),
    }),
  );
}

const centreChat = (page: Page) => page.locator('#chat-workspace-pane');
const chatPage = (page: Page) => page.locator('.coding-workbench__page--chat');
const drillInPage = (page: Page) =>
  page.locator('.coding-workbench__page--drill-in');
const crumbs = (page: Page) =>
  codingNavigation(page).getByRole('list', { name: 'Breadcrumb' });
const inbox = (page: Page) =>
  page.getByRole('complementary', { name: 'Inbox chats' });

async function landOnChat(page: Page) {
  await page.goto(`${ROUTE}?chat=conv-1`);
  await dismissSetupLauncher(page);
  await expect(centreChat(page)).toBeVisible({ timeout: 20_000 });
}

async function drillIntoDiff(page: Page) {
  await openCodingView(page, 'Diff');
  await expect(drillInPage(page)).toHaveAttribute('data-active', 'true');
  await expect(crumbs(page)).toContainText('Diff');
}

test.describe('Coding stack — desktop (1280px)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await seed(page);
  });

  test('Chat is the centre, with its inbox, and the dock does not also mount Chat', async ({
    page,
  }) => {
    await landOnChat(page);
    await expect(page.locator('#chat-dock')).toHaveCount(0);
    await expect(page.locator('#chat-workspace-pane')).toHaveCount(1);
    await expect(inbox(page)).toBeVisible();
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await expect(
      codingNavigation(page).getByRole('button', { name: 'Back' }),
    ).toBeDisabled();
    // The Coding occurrence is the Chat page, never a tab.
    await expect(
      page.getByRole('tab', { name: 'Coding', exact: true }),
    ).toHaveCount(0);
  });

  test('choosing another conversation in the inbox is not a history entry', async ({
    page,
  }) => {
    await landOnChat(page);
    const length = await page.evaluate(() => window.history.length);
    await inbox(page)
      .getByRole('button', { name: /Tidy the README/ })
      .first()
      .click();
    await expect(page).toHaveURL(/chat=conv-2|chat=session-2/);
    expect(await page.evaluate(() => window.history.length)).toBe(length);
    await expect(
      codingNavigation(page).getByRole('button', { name: 'Back' }),
    ).toBeDisabled();
  });

  test('a drill-in is a history entry: browser Back returns to the conversation, Forward re-enters', async ({
    page,
  }) => {
    await landOnChat(page);
    await drillIntoDiff(page);
    await expect(page).toHaveURL(/[?&]pane=/);
    await expect(centreChat(page)).toBeHidden();
    // The conversation stays mounted behind the pane.
    await expect(centreChat(page)).toHaveCount(1);

    await page.goBack();
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await expect(centreChat(page)).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]pane=/);

    await page.goForward();
    await expect(drillInPage(page)).toHaveAttribute('data-active', 'true');
    await expect(crumbs(page)).toContainText('Diff');

    // The stack bar's own Back is the same history step.
    await codingNavigation(page).getByRole('button', { name: 'Back' }).click();
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await expect(
      codingNavigation(page).getByRole('button', { name: 'Forward' }),
    ).toBeEnabled();
  });

  test('the stack chords go back and forward', async ({ page }) => {
    await landOnChat(page);
    const mac = await page.evaluate(() =>
      navigator.platform.toUpperCase().includes('MAC'),
    );
    await drillIntoDiff(page);
    // Off the composer, as a reader browsing the pane would be.
    await crumbs(page).click();
    await page.keyboard.press(mac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft');
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await crumbs(page).click();
    await page.keyboard.press(mac ? 'Meta+BracketRight' : 'Alt+ArrowRight');
    await expect(drillInPage(page)).toHaveAttribute('data-active', 'true');
  });

  test('a reload on a drill-in lands on that drill-in', async ({ page }) => {
    await landOnChat(page);
    await drillIntoDiff(page);
    await page.reload();
    await expect(drillInPage(page)).toHaveAttribute('data-active', 'true', {
      timeout: 20_000,
    });
    await expect(crumbs(page)).toContainText('Diff');
    await expect(centreChat(page)).toBeHidden();
  });

  test('⌘D on a drill-in returns to the conversation with the composer focused', async ({
    page,
  }) => {
    await landOnChat(page);
    await drillIntoDiff(page);
    await crumbs(page).click();
    const mac = await page.evaluate(() =>
      navigator.platform.toUpperCase().includes('MAC'),
    );
    await page.keyboard.press(mac ? 'Meta+KeyD' : 'Control+KeyD');
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await expect(
      centreChat(page).locator('.chat-input textarea'),
    ).toBeFocused();
    await expect(page.locator('#chat-dock')).toHaveCount(0);
  });

  test('the inbox collapses and stays collapsed across a reload, and expands again', async ({
    page,
  }) => {
    await landOnChat(page);
    await expect(inbox(page)).toBeVisible();
    // The conversation has resolved (its title reaches the breadcrumb), so
    // the header's menu is not rebuilt under the click.
    await expect(crumbs(page)).toContainText('Dev Agent Chat');
    await page.getByRole('button', { name: 'More dock actions' }).click();
    await page
      .getByRole('menuitemcheckbox', { name: 'Collapse chat list' })
      .click();
    await expect(inbox(page)).toHaveCount(0);

    await page.reload();
    await expect(centreChat(page)).toBeVisible({ timeout: 20_000 });
    await expect(crumbs(page)).toContainText('Dev Agent Chat');
    await expect(inbox(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'More dock actions' }).click();
    await page
      .getByRole('menuitemcheckbox', { name: 'Expand chat list' })
      .click();
    await expect(inbox(page)).toBeVisible();
  });

  test('page transitions slide in by default and not at all under reduced motion', async ({
    page,
  }) => {
    await landOnChat(page);
    await drillIntoDiff(page);
    expect(
      await drillInPage(page).evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toBe('coding-stack-enter-push');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goBack();
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    expect(
      await chatPage(page).evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toBe('none');
    expect(
      await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) =>
              String(
                (animation as CSSAnimation).animationName ?? '',
              ).startsWith('coding-stack'),
            ).length,
      ),
    ).toBe(0);
  });
});

test.describe('Coding stack — phone (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await seed(page);
  });

  test('the phone keeps Chat in its maximized dock; the centre mounts no second Chat', async ({
    page,
  }) => {
    await page.goto(`${ROUTE}?chat=conv-1`);
    await dismissSetupLauncher(page);
    await expect(page.locator('#chat-dock')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#chat-dock')).toHaveClass(/is-maximized/);
    await expect(page.locator('#chat-workspace-pane')).toHaveCount(0);
  });
});
