import { expect, type Page } from '@playwright/test';
import { buildLongSessionTurns } from './fixtures/long-session';
import {
  codingNavigation,
  codingViewItem,
  codingViewRail,
  openCodingView,
} from './helpers/coding-stack';
import { test } from './helpers/fixture-audit';
import {
  DEFAULT_CONVERSATION_LOOKUPS,
  DEFAULT_CONVERSATIONS,
  dismissSetupLauncher,
  installMockOrchestrationEventWindow,
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
  // The Diff pane reads `/api/coding/git/diff` (`fetchCodingDiff`); the
  // shared seed answers it with an empty patch, so this one change is
  // registered after it and wins.
  await page.route('**/api/coding/git/diff?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          diff: 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-console.log("old")\n+console.log("new")\n',
        },
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
  // On its own (no panel head) the Diff draws its own quiet row.
  await expect(
    drillInPage(page).locator('.diff-panel__bar').getByRole('button', {
      name: 'Wrap lines',
    }),
  ).toBeVisible();
  await expect(crumbs(page).getByRole('listitem')).toHaveText([
    'Inbox',
    'Dev Agent Chat',
    'Diff',
  ]);
}

// Below the wide fold (1280px, `codingPanels.ts`) a pane is a full-page
// drill-in; past it the same pane opens beside Chat (the last describe).
test.describe('Coding stack — desktop below the wide fold (1180px)', () => {
  test.use({ viewport: { width: 1180, height: 800 } });

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
    await expect(crumbs(page)).toContainText('Inbox');
  });

  test('a first load is Chat and nothing else: no tabs, no save notice, no pane actions, no pane mounted', async ({
    page,
  }) => {
    const diffReads: string[] = [];
    page.on('request', (request) => {
      if (/\/api\/coding\/git\/diff/.test(request.url()))
        diffReads.push(request.url());
    });
    await landOnChat(page);
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(
      page.getByText('Workspace pane changes are saved in this tab.'),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Pane actions/ }),
    ).toHaveCount(0);
    await expect(
      codingNavigation(page).getByRole('button', { name: 'Back' }),
    ).toHaveCount(0);
    // No drill-in is instantiated until it is picked: no pane renderer in the
    // page, and no Diff read.
    await expect(
      page.locator(
        '.coding-workbench__page--drill-in .file-tree-panel, .coding-workbench__page--drill-in .diff-panel',
      ),
    ).toHaveCount(0);
    // The rail lists what is available, with nothing current.
    await expect(codingViewItem(page, 'Diff')).toBeVisible();
    await expect(codingViewItem(page, 'Files')).toBeVisible();
    await expect(
      codingViewRail(page).locator('[aria-current="page"]'),
    ).toHaveCount(0);
    expect(diffReads).toEqual([]);

    await drillIntoDiff(page);
    await expect(codingViewItem(page, 'Diff')).toHaveAttribute(
      'aria-current',
      'page',
    );
    // A drill-in is the breadcrumb and the pane: still no tab strip.
    await expect(page.getByRole('tab')).toHaveCount(0);
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

    // The conversation's crumb is the same step back.
    await crumbs(page).getByRole('button', { name: 'Dev Agent Chat' }).click();
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await expect(page).not.toHaveURL(/[?&]pane=/);
  });

  test('the stack chords go back and forward', async ({ page }) => {
    await landOnChat(page);
    const mac = await page.evaluate(() =>
      navigator.platform.toUpperCase().includes('MAC'),
    );
    await drillIntoDiff(page);
    // Off the composer, as a reader browsing the pane would be.
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press(mac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft');
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
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
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
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
    await page.getByRole('button', { name: 'Hide inbox' }).click();
    await expect(inbox(page)).toHaveCount(0);

    await page.reload();
    await expect(centreChat(page)).toBeVisible({ timeout: 20_000 });
    await expect(crumbs(page)).toContainText('Dev Agent Chat');
    await expect(inbox(page)).toHaveCount(0);

    await page.getByRole('button', { name: /^Show inbox/ }).click();
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
    // The global reduced-motion rule (tokens.css) collapses the slide to
    // 0.01ms: nothing of it is seen.
    const duration = await chatPage(page).evaluate(
      (element) => getComputedStyle(element).animationDuration,
    );
    expect(
      Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000),
    ).toBeLessThanOrEqual(0.01);
    // A 0.01ms animation is still "current" on the frame it starts; count
    // after the frame it ends in, not during it.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
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

test.describe('Coding stack — the dock is left as the reader had it', () => {
  test.use({ viewport: { width: 1180, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await seed(page);
  });

  test('an open, maximized dock is left exactly as it was by the Coding layout, whatever asks to show Chat there', async ({
    page,
  }) => {
    const mac = await page.evaluate(() =>
      navigator.platform.toUpperCase().includes('MAC'),
    );
    const primary = mac ? 'Meta' : 'Control';
    const savedDock = () =>
      page.evaluate(() => {
        const raw = localStorage.getItem('station-device-settings-v1');
        const record = raw ? JSON.parse(raw)?.values?.regionArrangement : null;
        return JSON.stringify(record?.regions?.bottom ?? null);
      });
    await page.goto('/projects/dev?chat=conv-1&dock=open');
    await dismissSetupLauncher(page);
    const dock = page.locator('#chat-dock');
    await expect(dock).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press(`${primary}+KeyM`);
    await expect(dock).toHaveClass(/is-maximized/);
    await expect.poll(savedDock).toContain('"maximized":true');
    const before = await savedDock();

    // Into the Coding layout by its layout chip, as a reader would.
    await page
      .getByRole('toolbar', { name: 'Dev layouts' })
      .getByRole('button', { name: 'Code' })
      .click();
    await expect(centreChat(page)).toBeVisible({ timeout: 20_000 });
    // One Chat: the centre's. The dock the reader left open mounts no Chat.
    await expect(page.locator('#chat-dock')).toHaveCount(0);

    // Everything that shows Chat goes to the Chat page instead of the dock.
    await openCodingView(page, 'Diff');
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press(`${primary}+KeyD`);
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press(`${primary}+KeyK`);
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('Open chat dock');
    await page.keyboard.press('Enter');
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await expect(page.locator('#chat-dock')).toHaveCount(0);
    // Nothing on the route rewrote the reader's dock.
    expect(await savedDock()).toBe(before);

    // Leaving restores the dock exactly as it was.
    while (new URL(page.url()).pathname !== '/projects/dev') {
      await page.goBack();
    }
    await expect(page.locator('#chat-dock')).toBeVisible();
    await expect(page.locator('#chat-dock')).toHaveClass(/is-maximized/);
    await expect(centreChat(page)).toHaveCount(0);
    expect(await savedDock()).toBe(before);
  });

  test('a closed dock stays closed: showing Chat on the Coding layout never opens it', async ({
    page,
  }) => {
    const mac = await page.evaluate(() =>
      navigator.platform.toUpperCase().includes('MAC'),
    );
    const primary = mac ? 'Meta' : 'Control';
    const savedDock = () =>
      page.evaluate(() => {
        const raw = localStorage.getItem('station-device-settings-v1');
        const record = raw ? JSON.parse(raw)?.values?.regionArrangement : null;
        return JSON.stringify(record?.regions?.bottom ?? null);
      });
    await landOnChat(page);
    expect(new URL(page.url()).searchParams.get('dock')).toBeNull();
    const before = await savedDock();

    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press(`${primary}+KeyK`);
    await page
      .getByRole('combobox', { name: 'Search commands' })
      .fill('Open chat dock');
    await page.keyboard.press('Enter');
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press(`${primary}+KeyD`);
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');

    expect(new URL(page.url()).searchParams.get('dock')).toBeNull();
    expect(await savedDock()).toBe(before);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.locator('#chat-dock')).toHaveClass(/is-collapsed/);
  });

  test('in a plain field the stack chord is the stack’s Back, and the route is kept', async ({
    page,
  }) => {
    const mac = await page.evaluate(() =>
      navigator.platform.toUpperCase().includes('MAC'),
    );
    await landOnChat(page);
    await openCodingView(page, 'Files');
    await expect(drillInPage(page)).toHaveAttribute('data-active', 'true');
    const search = page.locator('.file-tree-panel__search-input');
    await search.fill('two words');
    // Off macOS Alt+← in a field would be the browser's Back and could leave
    // the layout; the stack takes it and stays on the route. (Synthetic keys
    // do not reach the browser's own accelerators, so this proves the stack's
    // handling, not the browser's.)
    await page.keyboard.press(mac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft');
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    expect(new URL(page.url()).pathname).toBe(ROUTE);
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

/**
 * #3040 / #3051: past the wide fold a rail pick opens the tool BESIDE Chat
 * (the same `?pane=`, written in place), the Terminal below both, and each
 * conversation remembers its own panels.
 */
test.describe('Coding stack — wide (1440px): tools beside Chat', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const sidePanel = (page: Page) =>
    page.locator('.coding-workbench__page--drill-in');
  const lowerPanel = (page: Page) => page.locator('.coding-workbench__lower');
  const historyLength = (page: Page) =>
    page.evaluate(() => window.history.length);

  test.beforeEach(async ({ page }) => {
    await seed(page);
  });

  test('a rail pick opens the tool beside Chat, Chat stays visible, and no toggle is a history entry', async ({
    page,
  }) => {
    await landOnChat(page);
    const length = await historyLength(page);
    await expect(sidePanel(page)).toBeHidden();

    await openCodingView(page, 'Diff');
    await expect(sidePanel(page)).toBeVisible();
    await expect(
      sidePanel(page).getByRole('heading', { name: 'Diff' }),
    ).toBeVisible();
    await expect(centreChat(page)).toBeVisible();
    // One head: the Diff's counts and its four icon tools sit in the
    // panel's head row, and the pane draws no bar of its own beneath it.
    const head = sidePanel(page).locator('.coding-workbench__panel-head');
    await expect(head.locator('.diff-stat')).toHaveText(/^1 file\+1−1$/);
    for (const name of [
      'Collapse all files',
      'Expand all files',
      'Split view',
      'Wrap lines',
    ])
      await expect(head.getByRole('button', { name })).toBeVisible();
    await expect(
      head.getByRole('button', { name: 'Split view' }),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(sidePanel(page).locator('.diff-panel__bar')).toHaveCount(0);
    // A file row says its counts once: Station's `+N −N` in the header's
    // metadata slot, not also the library's own `-N +N` beside it.
    const fileHeader = sidePanel(page).locator('[data-diffs-header]').first();
    await expect(fileHeader).toBeVisible();
    const shownCounts = await fileHeader.evaluate((header) => {
      const shown: string[] = [];
      const visit = (el: Element) => {
        if (el instanceof HTMLSlotElement) {
          for (const node of el.assignedElements({ flatten: true }))
            visit(node);
          return;
        }
        if (el.getClientRects().length === 0) return;
        if (el.children.length === 0 || el.shadowRoot) {
          const text = (el.textContent ?? '').trim();
          if (/^[+−-]\d+$/.test(text)) shown.push(text);
        }
        for (const child of Array.from(el.children)) visit(child);
      };
      visit(header);
      return shown;
    });
    expect(shownCounts).toEqual(['+1', '−1']);
    await expect(chatPage(page)).toHaveAttribute('data-active', 'true');
    await expect(page).toHaveURL(/[?&]pane=/);
    expect(await historyLength(page)).toBe(length);
    await expect(codingViewItem(page, 'Diff')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Chat is still the page: the crumbs are the conversation's.
    await expect(crumbs(page).getByRole('listitem')).toHaveText([
      'Inbox',
      'Dev Agent Chat',
    ]);
    // Side by side, not over: the panel starts where Chat ends.
    const chat = (await chatPage(page).boundingBox())!;
    const side = (await sidePanel(page).boundingBox())!;
    expect(side.x).toBeGreaterThanOrEqual(chat.x + chat.width - 1);
    expect(chat.width).toBeGreaterThanOrEqual(480);
    expect(side.width).toBeGreaterThanOrEqual(320);

    // Another item switches; the same item closes. Still no entry.
    await openCodingView(page, 'Files');
    await expect(sidePanel(page).locator('.file-tree-panel')).toBeVisible();
    await expect(codingViewItem(page, 'Diff')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await openCodingView(page, 'Files');
    await expect(sidePanel(page)).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]pane=/);
    await expect(centreChat(page)).toBeVisible();
    expect(await historyLength(page)).toBe(length);
  });

  test('the Terminal opens in the lower panel, under Chat and the side tool together', async ({
    page,
  }) => {
    await landOnChat(page);
    await expect(lowerPanel(page)).toHaveCount(0);
    await openCodingView(page, 'Files');
    await openCodingView(page, 'Terminal');
    await expect(lowerPanel(page)).toBeVisible();
    await expect(lowerPanel(page)).toHaveAttribute('data-active', 'true');
    await expect(codingViewItem(page, 'Terminal')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The shell is the only kind of terminal here, so the panel opens one
    // rather than an empty state and a one-option picker (design audit U7).
    await expect(
      lowerPanel(page).getByRole('tab', { name: 'Shell 1' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      lowerPanel(page).getByRole('dialog', { name: 'New terminal' }),
    ).toHaveCount(0);
    // The strip follows the title, not the row's centre: the first tab
    // starts within a few px of the title's TEXT. (The heading's box is
    // not enough: a heading that took the free space would end right where
    // the strip starts, with its text far to the left.)
    const titleTextEnd = await lowerPanel(page)
      .getByRole('heading', { name: 'Terminal' })
      .evaluate((heading) => {
        const range = document.createRange();
        range.selectNodeContents(heading);
        return range.getBoundingClientRect().right;
      });
    const tab = (await lowerPanel(page)
      .getByRole('tab', { name: 'Shell 1' })
      .boundingBox())!;
    expect(tab.x - titleTextEnd).toBeGreaterThanOrEqual(0);
    expect(tab.x - titleTextEnd).toBeLessThanOrEqual(16);
    await expect(sidePanel(page)).toBeVisible();
    await expect(page).toHaveURL(/[?&]pane=/);
    const chat = (await chatPage(page).boundingBox())!;
    const side = (await sidePanel(page).boundingBox())!;
    const lower = (await lowerPanel(page).boundingBox())!;
    expect(lower.y).toBeGreaterThanOrEqual(chat.y + chat.height - 1);
    expect(lower.y).toBeGreaterThanOrEqual(side.y + side.height - 1);
    expect(lower.width).toBeGreaterThanOrEqual(chat.width + side.width - 1);
    await expect(centreChat(page)).toBeVisible();

    await openCodingView(page, 'Terminal');
    await expect(lowerPanel(page)).toBeHidden();
    await expect(sidePanel(page)).toBeVisible();
  });

  test('the side panel resizes from the keyboard and its width survives a reload', async ({
    page,
  }) => {
    await landOnChat(page);
    await openCodingView(page, 'Diff');
    const separator = page.getByRole('separator', {
      name: 'Resize Diff panel',
    });
    await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    const before = Number(await separator.getAttribute('aria-valuenow'));
    await separator.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(separator).toHaveAttribute(
      'aria-valuenow',
      String(before + 32),
    );
    const side = (await sidePanel(page).boundingBox())!;
    expect(Math.round(side.width)).toBe(before + 32);

    await page.reload();
    await expect(centreChat(page)).toBeVisible({ timeout: 20_000 });
    await expect(sidePanel(page)).toBeVisible();
    await expect(
      page.getByRole('separator', { name: 'Resize Diff panel' }),
    ).toHaveAttribute('aria-valuenow', String(before + 32));
  });

  test('each conversation keeps its own panels; a new one starts closed', async ({
    page,
  }) => {
    await landOnChat(page);
    const length = await historyLength(page);
    await openCodingView(page, 'Diff');
    await openCodingView(page, 'Terminal');
    await expect(lowerPanel(page)).toBeVisible();
    // The Diff folded the inbox (the transcript's floor); unfold it by hand
    // to pick another conversation — the reader's choice for this session.
    await expect(inbox(page)).toHaveCount(0);
    await page.getByRole('button', { name: /^Show inbox/ }).click();
    await expect(inbox(page)).toBeVisible();

    await inbox(page)
      .getByRole('button', { name: /Tidy the README/ })
      .first()
      .click();
    await expect(page).toHaveURL(/chat=conv-2|chat=session-2/);
    await expect(sidePanel(page)).toBeHidden();
    await expect(lowerPanel(page)).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]pane=/);
    await openCodingView(page, 'Files');
    await expect(sidePanel(page).locator('.file-tree-panel')).toBeVisible();
    // This conversation has no choice of its own yet, so Files folded the
    // inbox; unfold it to go back.
    await expect(inbox(page)).toHaveCount(0);
    await page.getByRole('button', { name: /^Show inbox/ }).click();

    // The first conversation's row carries the seeded title until the
    // conversation list's own title arrives; either names conv-1.
    await inbox(page)
      .getByRole('button', { name: /Dev Agent Chat|Fix the login flake/ })
      .first()
      .click();
    await expect(page).toHaveURL(/chat=conv-1|chat=session-1/);
    await expect(
      sidePanel(page).getByRole('heading', { name: 'Diff' }),
    ).toBeVisible();
    await expect(lowerPanel(page)).toBeVisible();
    await expect(codingViewItem(page, 'Diff')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await historyLength(page)).toBe(length);
  });

  test('crossing the fold keeps the conversation as it was: a drill-in becomes the side panel and the draft survives', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await landOnChat(page);
    const composer = centreChat(page).locator('.chat-input textarea');
    await composer.fill('a draft the reader has not sent');
    await openCodingView(page, 'Diff');
    await expect(centreChat(page)).toBeHidden();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(centreChat(page)).toBeVisible();
    await expect(sidePanel(page)).toBeVisible();
    await expect(codingViewItem(page, 'Diff')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(composer).toHaveValue('a draft the reader has not sent');

    await page.setViewportSize({ width: 1180, height: 800 });
    await expect(centreChat(page)).toBeHidden();
    await expect(crumbs(page)).toContainText('Diff');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(composer).toHaveValue('a draft the reader has not sent');
  });
});

/**
 * #3046 / #3047 round: one bar above the transcript, the inbox folding for a
 * tool that would crowd it, and a file opened from Files landing beside Chat.
 */
test.describe('Coding stack — wide (1440px): one bar, the inbox, a file from Files', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const sidePanel = (page: Page) =>
    page.locator('.coding-workbench__page--drill-in');
  const bar = (page: Page) => page.locator('.coding-workbench__bar');
  const historyLength = (page: Page) =>
    page.evaluate(() => window.history.length);

  test.beforeEach(async ({ page }) => {
    await seed(page);
  });

  test('one bar above the transcript: the title once, Chat’s one verb (New) as a named icon beside the breadcrumb', async ({
    page,
  }) => {
    await landOnChat(page);
    await expect(crumbs(page)).toContainText('Dev Agent Chat');
    // No second header row under the bar.
    await expect(centreChat(page).locator('.chat-dock__header')).toHaveCount(0);
    await expect(
      centreChat(page).locator('.chat-dock__header-identity'),
    ).toHaveCount(0);
    await expect(bar(page).getByText('Dev Agent Chat')).toHaveCount(1);
    const create = bar(page).getByRole('button', { name: 'New chat' });
    await expect(create).toBeVisible();
    // No words, and no Open beside it: the inbox sits beside Chat. No
    // session count either; the inbox enumerates the chats.
    await expect(create).toHaveText('');
    await expect(
      bar(page).getByRole('button', { name: /^Open conversation/ }),
    ).toHaveCount(0);
    await expect(bar(page)).not.toContainText(/\bsessions?\b/i);
    await expect(
      bar(page).getByRole('button', { name: 'More dock actions' }),
    ).toBeVisible();
    // The bar is one row: every control shares the breadcrumb's line.
    const crumb = (await crumbs(page).boundingBox())!;
    const verb = (await create.boundingBox())!;
    expect(
      Math.abs(verb.y + verb.height / 2 - (crumb.y + crumb.height / 2)),
    ).toBeLessThan(12);
  });

  test('a tool that would crowd the transcript folds the inbox, unfolds it on close, and never overrides the reader’s own choice', async ({
    page,
  }) => {
    await landOnChat(page);
    await expect(inbox(page)).toBeVisible();
    await openCodingView(page, 'Diff');
    await expect(sidePanel(page)).toBeVisible();
    await expect(inbox(page)).toHaveCount(0);
    const transcript = (await centreChat(page).boundingBox())!;
    expect(transcript.width).toBeGreaterThanOrEqual(640);
    await openCodingView(page, 'Diff');
    await expect(sidePanel(page)).toBeHidden();
    await expect(inbox(page)).toBeVisible();

    // The reader expands it by hand while the tool is open: their choice.
    await openCodingView(page, 'Files');
    await expect(inbox(page)).toHaveCount(0);
    await page.getByRole('button', { name: /^Show inbox/ }).click();
    await expect(inbox(page)).toBeVisible();
    await openCodingView(page, 'Diff');
    await expect(inbox(page)).toBeVisible();
    await openCodingView(page, 'Diff');
    await expect(inbox(page)).toBeVisible();
    await openCodingView(page, 'Files');
    await expect(inbox(page)).toBeVisible();
  });

  test('a file opened from Files lands beside Chat by replace, named by its file and tipped with its path', async ({
    page,
  }) => {
    await page.route('**/api/coding/files**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              name: 'src',
              path: 'src',
              type: 'directory',
              children: [{ name: 'app.ts', path: 'src/app.ts', type: 'file' }],
            },
          ],
        }),
      }),
    );
    await page.route('**/api/projects/dev/file-preview', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            path: 'src/app.ts',
            status: 'ready',
            renderKind: 'text',
            content: 'export const app = true;\n',
          },
        }),
      }),
    );
    await landOnChat(page);
    const length = await historyLength(page);
    await openCodingView(page, 'Files');
    // A root directory opens expanded; the file is one click away.
    await sidePanel(page).getByText('app.ts', { exact: true }).click();
    await expect(
      sidePanel(page).getByRole('heading', { name: 'app.ts' }),
    ).toBeVisible();
    await expect(centreChat(page)).toBeVisible();
    expect(await historyLength(page)).toBe(length);
    await expect(page).toHaveURL(/[?&]pane=/);
    const item = codingViewItem(page, 'app.ts');
    await expect(item).toHaveAttribute('aria-pressed', 'true');
    // The tooltip shows on hover (drawn on the body), and says the whole path.
    await item.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await expect(page.getByRole('tooltip')).toHaveText('src/app.ts');
    // The preview's head offers the way back to Files (design audit U5).
    await sidePanel(page)
      .getByRole('button', { name: 'Back to Files' })
      .click();
    await expect(sidePanel(page).locator('.file-tree-panel')).toBeVisible();
    await expect(codingViewItem(page, 'Files')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      sidePanel(page).getByRole('button', { name: /^Back to/ }),
    ).toHaveCount(0);
    // Back leaves the layout; it does not step through the panel.
    await page.goBack();
    await expect(page).not.toHaveURL(/layouts\/code/);
  });

  test('the Browser flyout opens beside the rail, on screen and under the pointer; the rail’s tooltips are not clipped (D1, U12)', async ({
    page,
  }) => {
    await landOnChat(page);
    const viewport = page.viewportSize()!;
    await page.getByRole('button', { name: 'Open Browser pane' }).click();
    const flyout = page.getByRole('region', { name: 'Browser' });
    await expect(flyout).toBeVisible();
    const rail = (await codingViewRail(page).boundingBox())!;
    const box = (await flyout.boundingBox())!;
    expect(box.width).toBeGreaterThan(200);
    expect(box.height).toBeGreaterThan(40);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(rail.x);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    // Painted, not merely laid out: the point at its centre hits it.
    const hit = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[aria-label="Browser"]') !==
        null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(hit).toBe(true);
    await expect(flyout.getByRole('textbox')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(flyout).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Open Browser pane' }),
    ).toBeFocused();

    // A rail tooltip, whole and to the left of the rail.
    await page.mouse.move(10, 10);
    const item = codingViewItem(page, 'Files');
    await item.hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText('Files');
    const tipBox = (await tip.boundingBox())!;
    expect(tipBox.width).toBeGreaterThan(24);
    expect(tipBox.x).toBeGreaterThanOrEqual(0);
    expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(rail.x + 1);
  });

  test('Escape never leaves the layout: a panel opened from the keyboard takes focus, Escape closes it back to the rail, and Escape on the rail stays put (U6, D5)', async ({
    page,
  }) => {
    await landOnChat(page);
    const item = codingViewItem(page, 'Diff');
    await item.focus();
    await page.keyboard.press('Enter');
    await expect(sidePanel(page)).toBeVisible();
    await expect(
      sidePanel(page).getByRole('heading', { name: 'Diff' }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sidePanel(page)).toBeHidden();
    await expect(item).toBeFocused();
    await expect(page).toHaveURL(/layouts\/code/);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/layouts\/code/);
    await expect(centreChat(page)).toBeVisible();
  });
});

/**
 * #3046 round 3: the folded inbox's edge strip, and the fold judged again
 * when the window is resized.
 */
test.describe('Coding stack — wide (1440px): the folded inbox’s edge', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const sidePanel = (page: Page) =>
    page.locator('.coding-workbench__page--drill-in');
  // Pointer-only (aria-hidden, out of the tab order): located by its test
  // id, not by a role a screen reader never meets.
  const edge = (page: Page) => page.getByTestId('coding-inbox-edge');
  // The ONE control a keyboard or screen reader meets for the folded inbox.
  const showInbox = (page: Page) =>
    page.getByRole('button', { name: /^Show inbox/ });

  test.beforeEach(async ({ page }) => {
    await seed(page);
  });

  test('a folded inbox leaves a pointer-only strip that widens on hover, one accessible Show inbox control, and a click brings the inbox back as the reader’s choice', async ({
    page,
  }) => {
    await landOnChat(page);
    await expect(edge(page)).toHaveCount(0);
    await openCodingView(page, 'Diff');
    await expect(inbox(page)).toHaveCount(0);
    await expect(edge(page)).toBeVisible();
    const rest = (await edge(page).boundingBox())!;
    expect(rest.width).toBeLessThanOrEqual(8);
    expect(rest.height).toBeGreaterThanOrEqual(44);
    const chat = (await chatPage(page).boundingBox())!;
    expect(Math.abs(rest.x - chat.x)).toBeLessThan(2);
    // One control, one name: the bar's toggle is the only "Show inbox" a
    // keyboard or screen reader meets; the strip is hidden from both.
    await expect(showInbox(page)).toHaveCount(1);
    await expect(
      page
        .locator('.coding-workbench__bar')
        .getByRole('button', { name: 'Show inbox' }),
    ).toHaveCount(1);
    await expect(edge(page)).toHaveAttribute('aria-hidden', 'true');
    await expect(edge(page)).toHaveAttribute('tabindex', '-1');
    // Nothing needs the reader here, so the strip's rule is the neutral
    // border at rest and the accent only under the pointer.
    const ruleColours = () =>
      page.evaluate(() => {
        const strip = document.querySelector<HTMLElement>(
          '.coding-workbench__inbox-edge',
        )!;
        const resolve = (token: string) => {
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`;
          strip.parentElement!.append(probe);
          const value = getComputedStyle(probe).color;
          probe.remove();
          return value;
        };
        return {
          rule: getComputedStyle(strip).borderRightColor,
          neutral: resolve('--border-primary'),
          accent: resolve('--accent-primary'),
        };
      });
    const atRest = await ruleColours();
    expect(atRest.neutral).not.toBe(atRest.accent);
    expect(atRest.rule).toBe(atRest.neutral);
    // Settle the pointer in the transcript first, then come to the edge.
    await page.mouse.move(chat.x + chat.width / 2, chat.y + chat.height / 2);
    await edge(page).hover();
    await expect
      .poll(async () => {
        const now = await ruleColours();
        return now.rule === now.accent;
      })
      .toBe(true);
    await expect
      .poll(async () => {
        const box = (await edge(page).boundingBox())!;
        const hovered = await page.evaluate(
          () =>
            document.querySelector('.coding-workbench__inbox-edge:hover') !==
            null,
        );
        return `${Math.round(box.width)} hover=${hovered}`;
      })
      .toMatch(/^(2\d|3\d) hover=true$/);
    // The pointer's shortcut: a click on the strip brings the inbox back.
    await edge(page).click();
    await expect(inbox(page)).toBeVisible();
    await expect(edge(page)).toHaveCount(0);
    // The reader's choice: the tool closing and reopening leaves it.
    await openCodingView(page, 'Diff');
    await expect(sidePanel(page)).toBeHidden();
    await openCodingView(page, 'Diff');
    await expect(inbox(page)).toBeVisible();
  });

  test('a window dragged narrower folds the inbox once it rests, and wider unfolds it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 2000, height: 900 });
    await landOnChat(page);
    await openCodingView(page, 'Diff');
    await expect(inbox(page)).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(inbox(page)).toHaveCount(0);
    await expect(edge(page)).toBeVisible();
    await page.setViewportSize({ width: 2000, height: 900 });
    await expect(inbox(page)).toBeVisible();
  });
});

/**
 * Review round (#3040 M1, M2, M5): a file link from the transcript opens
 * beside Chat whatever tool is there; a fold the layout made survives a
 * reload; one Terminal across the fold.
 */
test.describe('Coding stack — wide (1440px): links, reloads and the Terminal across the fold', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const sidePanel = (page: Page) =>
    page.locator('.coding-workbench__page--drill-in');
  const lowerPanel = (page: Page) => page.locator('.coding-workbench__lower');
  const historyLength = (page: Page) =>
    page.evaluate(() => window.history.length);

  async function seedWithTranscriptLink(page: Page) {
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
    ]);
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page, {
      conversations: DEFAULT_CONVERSATIONS,
      conversationLookups: DEFAULT_CONVERSATION_LOOKUPS,
    });
    // The transcript is the conversation's event window: one completed turn
    // whose reply names a file in the Project, as an agent's answer would.
    await installMockOrchestrationEventWindow(page, 'codex', {
      'session-1': buildLongSessionTurns({
        threadId: 'session-1',
        provider: 'codex',
        turnCount: 1,
        promptText: () => 'Where does the app start?',
        replyText: () => 'The entry point is [src/app.ts](src/app.ts).',
      }).flat(),
    });
    await page.route('**/api/projects/dev/file-preview', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            path: 'src/app.ts',
            status: 'ready',
            renderKind: 'text',
            content: 'export const app = true;\n',
          },
        }),
      }),
    );
  }

  test('a file link in the transcript opens beside Chat with Diff open, with Files open, and with nothing open — never as a history entry', async ({
    page,
  }) => {
    await seedWithTranscriptLink(page);
    await landOnChat(page);
    // The transcript renders the path as a file chip: a link named by the
    // file, titled with the path.
    const link = centreChat(page).getByRole('link', { name: 'app.ts' });
    await expect(link).toBeVisible();
    const length = await historyLength(page);

    // Diff beside Chat.
    await openCodingView(page, 'Diff');
    await expect(
      sidePanel(page).getByRole('heading', { name: 'Diff' }),
    ).toBeVisible();
    await link.click();
    await expect(
      sidePanel(page).getByRole('heading', { name: 'app.ts' }),
    ).toBeVisible();
    await expect(centreChat(page)).toBeVisible();
    expect(await historyLength(page)).toBe(length);
    await expect(page).not.toHaveURL(/previewPath=/);
    await expect(codingViewItem(page, 'app.ts')).toHaveCount(1);

    // Files beside Chat: a link is not the pane's own row; the preview that
    // is already open is shown, not opened again.
    await openCodingView(page, 'Files');
    await expect(sidePanel(page).locator('.file-tree-panel')).toBeVisible();
    await link.click();
    await expect(
      sidePanel(page).getByRole('heading', { name: 'app.ts' }),
    ).toBeVisible();
    await expect(codingViewItem(page, 'app.ts')).toHaveCount(1);
    expect(await historyLength(page)).toBe(length);

    // Nothing beside Chat.
    await codingViewItem(page, 'app.ts').click();
    await expect(sidePanel(page)).toBeHidden();
    await link.click();
    await expect(sidePanel(page)).toBeVisible();
    await expect(
      sidePanel(page).getByRole('heading', { name: 'app.ts' }),
    ).toBeVisible();
    expect(await historyLength(page)).toBe(length);
  });

  test('a fold the layout made comes back after a reload once the tool closes, and after leaving and returning', async ({
    page,
  }) => {
    await seed(page);
    await landOnChat(page);
    await openCodingView(page, 'Diff');
    await expect(inbox(page)).toHaveCount(0);

    await page.reload();
    await expect(centreChat(page)).toBeVisible({ timeout: 20_000 });
    await expect(sidePanel(page)).toBeVisible();
    await expect(inbox(page)).toHaveCount(0);
    await openCodingView(page, 'Diff');
    await expect(sidePanel(page)).toBeHidden();
    await expect(inbox(page)).toBeVisible();

    // Leave with the tool open and the inbox folded, return, close the tool.
    await openCodingView(page, 'Diff');
    await expect(inbox(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(centreChat(page)).toHaveCount(0);
    await page.goBack();
    await expect(centreChat(page)).toBeVisible({ timeout: 20_000 });
    await expect(sidePanel(page)).toBeVisible();
    await openCodingView(page, 'Diff');
    await expect(inbox(page)).toBeVisible();
  });

  test('one Terminal across the fold: a drill-in below it becomes the lower panel above it, and never both', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await seed(page);
    await landOnChat(page);
    await openCodingView(page, 'Terminal');
    await expect(drillInPage(page)).toHaveAttribute('data-active', 'true');
    await expect(page.locator('.coding-layout__terminal')).toHaveCount(1);
    await expect(page).toHaveURL(/[?&]pane=/);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(lowerPanel(page)).toBeVisible();
    await expect(centreChat(page)).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]pane=/);
    // The host's own selection is still the Terminal; it draws nothing for
    // it past the fold, so there is exactly one terminal on the page.
    await expect(page.locator('.coding-layout__terminal')).toHaveCount(1);
    await openCodingView(page, 'Files');
    await expect(sidePanel(page)).toBeVisible();
    await expect(page.locator('.coding-layout__terminal')).toHaveCount(1);

    // Back below the fold with the lower panel open: the Terminal is the
    // page, in place, not gone.
    await codingViewItem(page, 'Files').click();
    await page.setViewportSize({ width: 1180, height: 800 });
    await expect(drillInPage(page)).toHaveAttribute('data-active', 'true');
    await expect(crumbs(page)).toContainText('Terminal');
    await expect(page.locator('.coding-layout__terminal')).toHaveCount(1);
  });
});
