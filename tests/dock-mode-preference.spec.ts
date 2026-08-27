/**
 * E2E: Dock Mode Preference
 *
 * Verifies that layout-declared dock mode preferences apply silently
 * (no URL param) and that explicit user overrides (⌘⇧M, settings panel)
 * write to both URL and sessionStorage.
 */
import { expect, type Page, test } from '@playwright/test';
import {
  installE2EMockedStationConnection,
  installE2EWorkspacePaneCatalog,
} from './helpers/current-station-contract';

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

const TEST_PROJECTS = [
  {
    id: 'p1',
    slug: 'dev',
    name: 'Dev',
    icon: '💻',
    description: 'Dev project',
    hasWorkingDirectory: true,
    layoutCount: 1,
    hasKnowledge: false,
  },
];

const DEV_LAYOUTS = [
  {
    id: 'l1',
    slug: 'code',
    projectSlug: 'dev',
    type: 'coding',
    name: 'Code',
    icon: '🖥️',
  },
];

const DEV_CONFIG = {
  id: 'p1',
  slug: 'dev',
  name: 'Dev',
  icon: '💻',
  description: 'Dev project',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const CODING_LAYOUT = {
  id: 'l1',
  slug: 'code',
  projectSlug: 'dev',
  type: 'coding',
  name: 'Code',
  icon: '🖥️',
  config: { workingDirectory: '/tmp/test', tabs: [], globalSkills: [] },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

async function seedRoutes(page: import('@playwright/test').Page) {
  await installE2EMockedStationConnection(page);
  await installE2EWorkspacePaneCatalog(page, {
    projectSlug: 'dev',
    projectId: DEV_CONFIG.id,
    layoutSlug: CODING_LAYOUT.slug,
  });
  await Promise.all([
    page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    ),
    page.route('**/api/projects', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: TEST_PROJECTS }),
      }),
    ),
    page.route('**/api/projects/dev', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: DEV_CONFIG }),
      }),
    ),
    page.route('**/api/projects/dev/layouts', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: DEV_LAYOUTS }),
      }),
    ),
    page.route('**/api/projects/dev/layouts/code', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CODING_LAYOUT }),
      }),
    ),
    page.route('**/api/agents', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/layouts', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/plugins', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/branding', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      }),
    ),
    page.route('**/api/auth/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true }),
      }),
    ),
    page.route('**/api/config/app', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { defaultModel: 'claude-sonnet', region: 'us-east-1' },
        }),
      }),
    ),
    page.route('**/api/models/**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/projects/dev/git/**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      }),
    ),
    page.route('**/api/projects/dev/files**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/terminal/**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
  ]);
}

async function dismissSetupLauncher(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    document.querySelector('[data-testid="setup-launcher"]')?.remove();
  });
}

async function dragDockTo(page: Page, placement: 'left' | 'right') {
  const handle = page.getByRole('button', { name: 'Move the dock' });
  const handleBox = await handle.boundingBox();
  expect(handleBox, 'Move the dock handle must be measurable').not.toBeNull();
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2,
    handleBox!.y + handleBox!.height / 2,
  );
  await page.mouse.down();
  const target = page.locator(`[data-dock-placement-target="${placement}"]`);
  await expect(target).toBeVisible();
  const targetBox = await target.boundingBox();
  expect(
    targetBox,
    `${placement} drop target must be measurable`,
  ).not.toBeNull();
  await page.mouse.move(
    targetBox!.x + targetBox!.width / 2,
    targetBox!.y + targetBox!.height / 2,
  );
  await page.mouse.up();
}

test.describe('Dock Mode Preference', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
  });

  test('dock action controls keep compact, consistent button sizing', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    await dismissSetupLauncher(page);

    await page.locator('.chat-dock__header').click();
    await page.waitForTimeout(300);

    const openButton = page
      .locator('.chat-dock__tab-actions .chat-dock__new')
      .first();
    const newButton = page
      .locator('.chat-dock__tab-actions .chat-dock__new')
      .nth(1);
    const maximizeButton = page.locator('.chat-dock__maximize-btn');

    const [openStyles, newStyles, maximizeStyles] = await Promise.all([
      openButton.evaluate((el) => {
        const styles = getComputedStyle(el);
        return {
          display: styles.display,
          fontSize: styles.fontSize,
          fontWeight: styles.fontWeight,
          height: parseFloat(styles.height),
        };
      }),
      newButton.evaluate((el) => {
        const styles = getComputedStyle(el);
        return {
          display: styles.display,
          fontSize: styles.fontSize,
          fontWeight: styles.fontWeight,
          height: parseFloat(styles.height),
        };
      }),
      maximizeButton.evaluate((el) => {
        const styles = getComputedStyle(el);
        return {
          display: styles.display,
          fontSize: styles.fontSize,
          fontWeight: styles.fontWeight,
          height: parseFloat(styles.height),
        };
      }),
    ]);

    expect(openStyles.display).toBe('flex');
    expect(newStyles.display).toBe('flex');
    expect(maximizeStyles.display).toContain('flex');
    expect(openStyles.fontSize).toBe(newStyles.fontSize);
    expect(openStyles.fontSize).toBe(maximizeStyles.fontSize);
    expect(openStyles.fontWeight).toBe(newStyles.fontWeight);
    expect(openStyles.height).toBeGreaterThan(28);
    expect(newStyles.height).toBeGreaterThan(28);
    expect(maximizeStyles.height).toBeGreaterThan(28);

    const [openShortcutSize, maximizeShortcutSize] = await Promise.all([
      openButton
        .locator('.chat-dock__subtitle')
        .evaluate((el) => getComputedStyle(el).fontSize),
      maximizeButton
        .locator('.chat-dock__subtitle')
        .evaluate((el) => getComputedStyle(el).fontSize),
    ]);

    expect(parseFloat(openShortcutSize)).toBeLessThan(
      parseFloat(openStyles.fontSize),
    );
    expect(parseFloat(maximizeShortcutSize)).toBeLessThan(
      parseFloat(maximizeStyles.fontSize),
    );
  });

  // The current inbox toggle contract unmounts the panel when closed and
  // restores the same landmark when reopened from the tab bar.
  test('bottom-mode inbox toggle unmounts the panel and opens it again', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    await dismissSetupLauncher(page);

    await page.locator('.chat-dock__header').click();
    await page.waitForTimeout(300);

    const initiallyClosed = page.getByRole('button', {
      name: 'Expand chat list',
    });
    if (await initiallyClosed.isVisible()) {
      await initiallyClosed.click();
    }

    const tabBarToggle = page.getByRole('button', {
      name: 'Collapse chat list',
    });
    await expect(tabBarToggle).toHaveAttribute('aria-pressed', 'true');

    const landmark = page.getByRole('complementary', { name: 'Inbox chats' });
    await expect(landmark).toHaveCount(1);
    const openBox = await page.locator('.chat-dock-inbox').boundingBox();
    expect(openBox).not.toBeNull();
    expect(openBox!.width).toBeGreaterThanOrEqual(240);
    expect(openBox!.width).toBeLessThanOrEqual(360);

    await tabBarToggle.click();

    const tabBarToggleCollapsed = page.getByRole('button', {
      name: 'Expand chat list',
    });
    await expect(tabBarToggleCollapsed).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(landmark).toHaveCount(0);
    await expect(page.locator('.chat-dock-inbox')).toHaveCount(0);

    await tabBarToggleCollapsed.click();

    await expect(tabBarToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(landmark).toHaveCount(1);
    await expect
      .poll(
        async () =>
          (await page.locator('.chat-dock-inbox').boundingBox())?.width,
        { timeout: 2000 },
      )
      .toBeGreaterThanOrEqual(240);
    const reopenedBox = await page.locator('.chat-dock-inbox').boundingBox();
    expect(reopenedBox).not.toBeNull();
    expect(reopenedBox!.width).toBeGreaterThanOrEqual(240);
    expect(reopenedBox!.width).toBeLessThanOrEqual(360);
  });

  test('coding layout applies right dock mode without URL param', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/code');
    await page.waitForTimeout(3000);

    // Dock should be in right mode (coding layout preference)
    const chatDock = page.locator('.chat-dock');
    await expect(chatDock).toHaveClass(/chat-dock--right/);

    // URL should NOT contain dockSlotPlacement param
    const url = new URL(page.url());
    expect(url.searchParams.has('dockSlotPlacement')).toBe(false);
  });

  test('right dock mode never renders the inbox chat list or its toggle', async ({
    page,
  }) => {
    // The right-mode dock is a narrow column; the inbox panel's 240px width
    // floor would crush the conversation surface, so the panel and its
    // toggle must not exist in this mode even for users whose persisted
    // preference has the chat list open (the default).
    await page.goto(
      '/projects/dev/layouts/code?dock=open&dockSlotPlacement=right',
    );
    await page.waitForTimeout(3000);
    await dismissSetupLauncher(page);

    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--right/);
    await expect(
      page.getByRole('complementary', { name: 'Inbox chats' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Collapse chat list' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Expand chat list' }),
    ).toHaveCount(0);
  });

  test('left dock mirrors the side-panel geometry, resize edge, and compact inbox policy', async ({
    page,
  }) => {
    await page.goto(
      '/projects/dev/layouts/code?dock=open&dockSlotPlacement=left',
    );
    await page.waitForTimeout(3000);
    await dismissSetupLauncher(page);

    const appMain = page.locator('.app__main');
    const dock = page.locator('.chat-dock');
    const content = page.locator('.main-content');
    await expect(appMain).toHaveClass(/app__main--dock-left/);
    await expect(dock).toHaveClass(/chat-dock--left/);

    const [mainBox, dockBox, contentBox] = await Promise.all([
      appMain.boundingBox(),
      dock.boundingBox(),
      content.boundingBox(),
    ]);
    expect(mainBox).not.toBeNull();
    expect(dockBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    expect(dockBox!.x).toBeLessThanOrEqual(mainBox!.x + 2);
    expect(contentBox!.x).toBeGreaterThanOrEqual(
      dockBox!.x + dockBox!.width - 2,
    );

    const resizeHandle = page.getByRole('separator', {
      name: 'Resize chat dock',
    });
    const resizeBox = await resizeHandle.boundingBox();
    expect(resizeBox).not.toBeNull();
    expect(resizeBox!.x).toBeGreaterThanOrEqual(
      dockBox!.x + dockBox!.width - resizeBox!.width - 2,
    );
    await expect(
      page.getByRole('complementary', { name: 'Inbox chats' }),
    ).toHaveCount(0);
  });

  test('maximized right dock occupies the full main surface without underlying content overlap', async ({
    page,
  }) => {
    // chat-dock-maximize-readiness: maximizing the right dock must make it the
    // sole full available main surface. The grid must collapse to one column
    // and main-content must not consume a column or paint through behind it.
    // A class-only assertion would miss the grid overlap; measure bounds.
    await page.goto(
      '/projects/dev/layouts/code?dock=open&dockSlotPlacement=right',
    );
    await page.waitForTimeout(3000);
    await dismissSetupLauncher(page);

    const dock = page.locator('.chat-dock');
    await expect(dock).toHaveClass(/chat-dock--right/);
    await expect(dock).not.toHaveClass(/is-maximized/);
    await page.getByRole('button', { name: /^Maximize chat dock$/ }).click();
    await expect(dock).toHaveClass(/is-maximized/);

    const mainBox = await page.locator('.app__main').boundingBox();
    const dockBox = await dock.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(dockBox).not.toBeNull();

    // The dock spans the full main width — no 400px side column is reserved.
    // (Against the old behavior the dock was a 400px column, so this fails.)
    expect(dockBox!.width).toBeGreaterThan(mainBox!.width - 24);
    expect(dockBox!.x).toBeLessThanOrEqual(mainBox!.x + 8);

    // The underlying main-content must be removed from the layout entirely.
    const mainContentDisplay = await page
      .locator('.main-content')
      .evaluate((el) => getComputedStyle(el).display);
    expect(mainContentDisplay).toBe('none');
  });

  test('⌘⇧M writes dockSlotPlacement to URL without stealing the Developer shortcut', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/code');
    await page.waitForTimeout(3000);

    // Cycle dock mode with keyboard shortcut
    await page.keyboard.press('Meta+Shift+M');
    await page.waitForTimeout(500);

    // URL should now contain dockSlotPlacement (cycled from 'right' → 'bottom')
    const url = new URL(page.url());
    expect(url.searchParams.has('dockSlotPlacement')).toBe(true);

    // #1989 keeps its documented Developer chord; the two global actions must
    // remain distinct instead of silently resolving by registration priority.
    await page.keyboard.press('Meta+Shift+D');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/developer');
  });

  test('⌘⇧M persists override in sessionStorage', async ({ page }) => {
    await page.goto('/projects/dev/layouts/code');
    await page.waitForTimeout(3000);

    // Cycle dock mode
    await page.keyboard.press('Meta+Shift+M');
    await page.waitForTimeout(500);

    // Check sessionStorage has the override
    const override = await page.evaluate(() =>
      sessionStorage.getItem('station-dock-mode-override:coding'),
    );
    expect(override).toBeTruthy();
  });

  test('sessionStorage override applies without URL param on revisit', async ({
    page,
  }) => {
    // Pre-seed sessionStorage with a legacy 'bottom-inline' override — it
    // must normalize to the renamed 'bottom' (inline) mode
    await page.addInitScript(() => {
      sessionStorage.setItem(
        'station-dock-mode-override:coding',
        'bottom-inline',
      );
    });

    await page.goto('/projects/dev/layouts/code');
    await page.waitForTimeout(3000);

    // Dock should be in bottom (inline) mode (from sessionStorage override)
    const chatDock = page.locator('.chat-dock');
    await expect(chatDock).toHaveClass(/chat-dock--bottom(?!-)/);

    // URL should still NOT contain dockSlotPlacement (override applied quietly)
    const url = new URL(page.url());
    expect(url.searchParams.has('dockSlotPlacement')).toBe(false);
  });

  test('explicit URL dockSlotPlacement is respected over layout preference', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/code?dockSlotPlacement=bottom');
    await page.waitForTimeout(3000);

    // Dock should be in bottom (inline) mode (from URL), not right (layout preference)
    const chatDock = page.locator('.chat-dock');
    await expect(chatDock).toHaveClass(/chat-dock--bottom(?!-)/);

    // URL param should persist
    const url = new URL(page.url());
    expect(url.searchParams.get('dockSlotPlacement')).toBe('bottom');
  });

  test('navigating away from coding layout restores previous dock mode', async ({
    page,
  }) => {
    // Start on home (default bottom dock)
    await page.goto('/');
    await page.waitForTimeout(2000);

    // Navigate to coding layout
    await page.goto('/projects/dev/layouts/code');
    await page.waitForTimeout(3000);

    // Dock should be right
    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--right/);

    // Navigate away
    await page.goto('/');
    await page.waitForTimeout(2000);

    // Dock should be back to the default bottom mode (not --right)
    const chatDock = page.locator('.chat-dock');
    const classes = await chatDock.getAttribute('class');
    expect(classes).not.toContain('chat-dock--right');
    expect(classes).toContain('chat-dock--bottom');
  });

  // station#settings-revamp slice 4 (docs/design/settings-architecture.md
  // §3 S4 "Chat/session", §6 slice 4): the remembered dock-slot placement
  // fallback so it survives a reload of a non-layout route with no URL
  // param and no layout preference in play.
  test('a persisted dock-slot placement is used as the fallback on a route with no URL param and no layout preference', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'station-device-settings-v1',
        JSON.stringify({ version: 2, values: { dockSlotPlacement: 'right' } }),
      );
    });

    await page.goto('/');
    await page.waitForTimeout(2000);

    const chatDock = page.locator('.chat-dock');
    await expect(chatDock).toHaveClass(/chat-dock--right/);

    // No URL param was written just from resolving the fallback.
    const url = new URL(page.url());
    expect(url.searchParams.has('dockSlotPlacement')).toBe(false);
  });

  test('an explicit dock-mode choice from the chat settings panel persists to the device-scope store', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    await dismissSetupLauncher(page);

    await page.locator('.chat-dock__header').click();
    await page.waitForTimeout(300);
    await page.getByTitle('Chat settings').click();

    const modal = page.locator('.chat-settings-modal');
    await expect(modal).toBeVisible();
    await modal.getByRole('menuitemradio', { name: 'Right' }).click();
    await modal.getByRole('button', { name: 'Done' }).click();

    const persistedDockMode = await page.evaluate(() => {
      const raw = localStorage.getItem('station-device-settings-v1');
      const envelope = raw ? JSON.parse(raw) : null;
      return envelope?.values?.dockSlotPlacement ?? null;
    });
    expect(persistedDockMode).toBe('right');

    // And the URL param still wins on this same page (existing behavior),
    // confirming the write-both contract rather than one replacing the
    // other.
    const url = new URL(page.url());
    expect(url.searchParams.get('dockSlotPlacement')).toBe('right');
  });

  test('drag left then right persists across reload, and the keyboard placement menu converges on that state', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await dismissSetupLauncher(page);
    await page.locator('.chat-dock__header').click();

    await dragDockTo(page, 'left');
    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--left/);
    await dragDockTo(page, 'right');
    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--right/);
    const draggedState = await page.evaluate(() => ({
      stored: JSON.parse(
        localStorage.getItem('station-device-settings-v1') ?? '{}',
      ).values?.dockSlotPlacement,
      effective: document.querySelector('.chat-dock')?.className,
    }));
    expect(draggedState).toMatchObject({ stored: 'right' });

    await page.reload();
    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--right/);

    const handle = page.getByRole('button', { name: 'Move the dock' });
    await handle.press('Enter');
    const menu = page.getByRole('menu', { name: 'Dock placement' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitemradio', { name: 'Right' }).click();
    const keyboardState = await page.evaluate(() => ({
      stored: JSON.parse(
        localStorage.getItem('station-device-settings-v1') ?? '{}',
      ).values?.dockSlotPlacement,
      effective: document.querySelector('.chat-dock')?.className,
    }));
    expect(keyboardState).toEqual(draggedState);
  });

  test('the placement menu opens within the window on a BOTTOM dock', async ({
    page,
  }) => {
    // The configuration the defect lived in, and the default one. The handle
    // is in the dock's header and a bottom dock IS the bottom of the viewport,
    // so a menu anchored downward measured y=895 with a height of 102 in a
    // 900px viewport — five pixels on screen.
    //
    // `toBeVisible` cannot see this: Playwright calls a non-empty box with
    // visible CSS visible even when it sits off the bottom of the window, so
    // that assertion passed on a menu nobody could reach. Measure the box.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForTimeout(2000);
    await dismissSetupLauncher(page);
    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--bottom/);

    await page.getByRole('button', { name: 'Move the dock' }).click();
    const menu = page.getByRole('menu', { name: 'Dock placement' });
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    expect(box, 'the placement menu must be measurable').not.toBeNull();
    expect(
      box!.y,
      'the placement menu must not open above the window',
    ).toBeGreaterThanOrEqual(0);
    expect(
      box!.y + box!.height,
      'the placement menu must not open below the window',
    ).toBeLessThanOrEqual(900);
  });

  test('reduced motion shows dock targets without a transform animation', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await dismissSetupLauncher(page);
    await page.locator('.chat-dock__header').click();

    const handle = page.getByRole('button', { name: 'Move the dock' });
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    const target = page.locator('[data-dock-placement-target="right"]');
    await expect(target).toBeVisible();
    expect(
      await target.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          animationName: style.animationName,
          transform: style.transform,
        };
      }),
    ).toEqual({ animationName: 'none', transform: 'none' });
    await page.mouse.up();
  });

  test('a desktop right preference is remembered through a narrow viewport and restored on desktop', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    await dismissSetupLauncher(page);
    await page.locator('.chat-dock__header').click();
    await page.getByTitle('Chat settings').click();
    await page.getByRole('menuitemradio', { name: 'Right' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--right/);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--bottom/);
    await expect(page.locator('.chat-dock')).not.toHaveClass(
      /chat-dock--right/,
    );
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw = localStorage.getItem('station-device-settings-v1');
          return raw ? JSON.parse(raw).values.dockSlotPlacement : null;
        }),
      )
      .toBe('right');

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--right/);
  });
});

test.describe('Dock Mode — Mobile', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
  });

  test('keyboard shortcut text is hidden on mobile', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    const subtitles = page.locator('.chat-dock .chat-dock__subtitle');
    const count = await subtitles.count();
    // The one-row mobile header renders no shortcut hints at all, which meets
    // this test's intent more strongly than rendering-then-hiding them. Any
    // that DO exist must still be hidden, which the loop below enforces.
    for (let i = 0; i < count; i++) {
      const display = await subtitles
        .nth(i)
        .evaluate((el) => getComputedStyle(el).display);
      expect(display).toBe('none');
    }
  });

  test('header controls show icons instead of visible text labels on mobile', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    await dismissSetupLauncher(page);

    // #972 collapsed the mobile chat chrome to the one-row
    // ChatDockMobileHeader, and New/Open/history moved into the header's
    // "Chat actions" overflow sheet (#985). The New/Open button row this test
    // used to inspect (`ChatDockTabBar`) survived on desktop until #3309
    // folded it into the desktop header and deleted it. The original
    // intent — mobile favors icons over rendered text — still holds on the
    // header's own controls (drawer toggle, activity, chat actions): each is
    // an icon-only button whose accessible name lives in `aria-label`, not
    // in visible text.
    const mobileHeader = page.locator(
      '[data-testid="chat-dock-mobile-header"]',
    );
    await expect(mobileHeader).toBeVisible();

    const iconButtons = mobileHeader.locator('.chat-dock__mobile-header-icon');
    const count = await iconButtons.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const button = iconButtons.nth(i);

      // Accessible name comes from aria-label...
      const ariaLabel = await button.getAttribute('aria-label');
      expect(ariaLabel).toBeTruthy();

      // ...an icon glyph is visible...
      const icon = button.locator('svg, span[aria-hidden="true"]').first();
      await expect(icon).toBeVisible();

      // ...and no separate visible text label renders next to it (only
      // aria-hidden icon/badge content is present).
      const visibleText = await button.evaluate((el) => {
        let text = '';
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent ?? '';
          } else if (
            node.nodeType === Node.ELEMENT_NODE &&
            (node as Element).getAttribute('aria-hidden') !== 'true'
          ) {
            text += (node as Element).textContent ?? '';
          }
        }
        return text.trim();
      });
      expect(visibleText).toBe('');
    }
  });

  test('dock height controls stay vertical on mobile even in right dock mode', async ({
    page,
  }) => {
    // Navigate to coding layout which prefers right dock
    await page.goto('/projects/dev/layouts/code');
    await page.waitForTimeout(3000);
    await dismissSetupLauncher(page);

    // The same coding layout's right preference is asserted on desktop above.
    // Mobile intentionally resolves that preference to the bottom renderer.
    const chatDock = page.locator('.chat-dock');
    await expect(chatDock).toHaveClass(/chat-dock--bottom/);
    await expect(chatDock).not.toHaveClass(/chat-dock--right/);

    // ...but on mobile the dock always renders as a fixed bottom sheet
    // regardless of dockMode (index.css: "the bottom dock and the
    // right-mode dock are both rendered as a fixed bottom sheet ...
    // regardless of dockMode"). Confirm the geometry: a full-viewport-width
    // sheet anchored to the bottom edge, not a narrower right-side panel.
    const box = await chatDock.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeLessThan(5);
    expect(box!.width).toBeGreaterThan(370);
    expect(box!.y + box!.height).toBeGreaterThan(800);

    // The mobile resize control remains a horizontal top edge operated by
    // vertical arrow keys. Prove the control changes the snap value in the
    // expected vertical direction without depending on an active chat menu.
    const resizeHandle = page.getByRole('separator', {
      name: 'Resize chat dock',
    });
    await expect(resizeHandle).toHaveAttribute(
      'aria-orientation',
      'horizontal',
    );
    const before = Number(await resizeHandle.getAttribute('aria-valuenow'));
    const key = before < 2 ? 'ArrowUp' : 'ArrowDown';
    await resizeHandle.focus();
    await resizeHandle.press(key);
    await expect(resizeHandle).toHaveAttribute(
      'aria-valuenow',
      String(before < 2 ? before + 1 : before - 1),
    );
  });

  test('a phone states the placement it uses and names the preference it is keeping', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'station-device-settings-v1',
        JSON.stringify({ version: 2, values: { dockSlotPlacement: 'right' } }),
      );
    });
    await page.goto('/');
    await page.waitForTimeout(2000);
    await dismissSetupLauncher(page);

    await expect(page.locator('.chat-dock')).toHaveClass(/chat-dock--bottom/);
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Chat settings' }).click();
    await expect(page.locator('.chat-settings-modal')).toBeVisible();
    // The section stays — an absent one is indistinguishable from a setting
    // Station never had, and this person DID choose Right on a wider screen.
    await expect(page.getByText('Dock Position')).toHaveCount(1);
    // What goes is the choice, not the answer: no button offers a placement
    // this screen cannot use, and none is offered disabled either.
    await expect(
      page.getByRole('menuitemradio', { name: 'Right' }),
    ).toHaveCount(0);
    await expect(page.getByRole('menuitemradio', { name: 'Left' })).toHaveCount(
      0,
    );
    await expect(
      page.getByText('Bottom — the only position this screen can use.'),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Your right preference is remembered for a wider screen.',
        { exact: false },
      ),
    ).toBeVisible();
    expect(
      await page.locator('.chat-settings-modal').evaluate(() => {
        const raw = localStorage.getItem('station-device-settings-v1');
        return raw ? JSON.parse(raw).values.dockSlotPlacement : null;
      }),
    ).toBe('right');
  });

  test('a phone has no move handle or drag targets and stays horizontally contained', async ({
    page,
  }) => {
    await page.goto('/');
    await dismissSetupLauncher(page);

    await expect(
      page.getByRole('button', { name: 'Move the dock' }),
    ).toHaveCount(0);
    await expect(page.locator('[data-dock-placement-target]')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
});
