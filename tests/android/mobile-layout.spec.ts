/**
 * Mobile layout regression tests — verifies mobile-first CSS changes at Pixel 7 viewport.
 */

import { expect, test } from '@playwright/test';
import { mockEmptyKnowledgeRegistry } from '../helpers/knowledge-setup';
import { dismissSetupLauncher } from '../helpers/orchestration';
import { MIN_TOUCH_TARGET_PX } from '../helpers/touch-target';

test.describe('Android — Mobile Layout', () => {
  test('optional knowledge setup does not overlay or intercept the mobile app shell', async ({
    page,
  }) => {
    await mockEmptyKnowledgeRegistry(page, 'mobile-knowledge-runtime');

    await page.goto('/');

    await expect(page.getByTestId('knowledge-nudge')).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);

    const settings = page.locator('.app-toolbar').getByTitle(/Settings/);
    await expect(settings).toBeVisible({ timeout: 10_000 });
    const bounds = await settings.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(
      await page.evaluate(
        ({ x, y }) =>
          Boolean(
            document.elementFromPoint(x, y)?.closest('[title*="Settings"]'),
          ),
        {
          x: (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
          y: (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
        },
      ),
    ).toBe(true);
    await settings.click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByTestId('knowledge-nudge')).toHaveCount(0);

    await page
      .getByRole('link', { name: 'My knowledge store', exact: true })
      .click();
    await expect(page).toHaveURL(/[?&]view=knowledge/);
    const section = page.locator('#section-knowledge');
    await expect(section).toBeVisible();
    await expect(section.getByText(/^Optional\./)).toBeVisible();

    for (const control of [
      section.getByRole('button', { name: 'Create recommended store' }),
      section.getByRole('button', {
        name: 'Connect an existing Obsidian vault instead',
      }),
    ]) {
      await expect(control).toBeVisible();
      const controlBounds = await control.boundingBox();
      expect(controlBounds).not.toBeNull();
      expect(controlBounds?.height ?? 0).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET_PX,
      );
    }

    const knowledgeLayout = await section.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        documentOverflows:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        left: bounds.left,
        right: bounds.right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(knowledgeLayout.documentOverflows).toBe(false);
    expect(knowledgeLayout.left).toBeGreaterThanOrEqual(0);
    expect(knowledgeLayout.right).toBeLessThanOrEqual(
      knowledgeLayout.viewportWidth,
    );
  });

  test('Settings shows deployed provenance without horizontal overflow', async ({
    page,
  }) => {
    await page.route('**/api/system/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configuredChatReady: true,
            configured: [
              {
                id: 'mobile-provenance-runtime',
                type: 'codex',
                enabled: true,
                capabilities: ['llm'],
              },
            ],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: {
            chat: { ready: true, source: 'mobile-provenance-runtime' },
          },
          build: {
            fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
            shortSha: 'abcdef0',
            branch: 'main',
            builtAt: '2026-07-10T18:00:00.000Z',
            ageSeconds: 120,
            instanceId: 'phone-dogfood',
          },
        }),
      }),
    );

    await page.goto('/');
    const settingsButton = page.locator(
      '.app-toolbar button[title^="Settings"]',
    );
    await expect(settingsButton).toBeVisible();
    await settingsButton.evaluate((element) =>
      element.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    await expect(page.locator('.settings__section-nav')).toBeVisible();
    await page.getByRole('link', { name: 'System', exact: true }).click();

    // #1063 renamed the group and renders the timestamp as `date · age` with
    // a separate screen-reader description that repeats the age, so match the
    // visible line whole rather than the age substring.
    const provenance = page.getByRole('group', {
      name: 'Connected Station build provenance',
    });
    await expect(provenance).toBeVisible();
    await expect(provenance.getByText('abcdef0')).toBeVisible();
    await expect(
      provenance.getByText('Jul 10, 2026 18:00 UTC · 2 minutes ago'),
    ).toBeVisible();
    await expect(provenance.getByText('phone-dogfood')).toBeVisible();
    await expect(
      provenance.getByTitle('abcdef0123456789abcdef0123456789abcdef01'),
    ).toBeVisible();

    const layout = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>(
        '.settings__provenance-list',
      );
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return {
        columns:
          getComputedStyle(element).gridTemplateColumns.split(' ').length,
        documentOverflows:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        left: bounds.left,
        right: bounds.right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(layout).not.toBeNull();
    expect(layout?.columns).toBe(1);
    expect(layout?.documentOverflows).toBe(false);
    expect(layout?.left).toBeGreaterThanOrEqual(0);
    expect(layout?.right).toBeLessThanOrEqual(layout?.viewportWidth ?? 0);
  });

  test('safe area CSS variables are defined in stylesheet', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(1500);
    const hasSafeVar = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.cssText?.includes('--safe-top')) return true;
          }
        } catch {
          /* cross-origin sheets */
        }
      }
      return false;
    });
    expect(hasSafeVar).toBe(true);
  });

  test('viewport meta includes viewport-fit=cover', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(500);
    const content = await page.evaluate(
      () =>
        document
          .querySelector('meta[name="viewport"]')
          ?.getAttribute('content') ?? '',
    );
    expect(content).toContain('viewport-fit=cover');
  });

  test('hamburger + Station logo visible in toolbar on mobile', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const toggle = page.locator('.app-toolbar__sidebar-toggle');
    const brand = page.locator('.app-toolbar__brand');
    if ((await toggle.count()) > 0) {
      await expect(toggle).toBeVisible();
      await expect(brand).toBeVisible();
      const brandText = await brand.textContent();
      expect(brandText).toContain('Station');
    }
  });

  test('hamburger opens sidebar drawer', async ({ page }) => {
    await page.goto('/settings');
    await dismissSetupLauncher(page);
    const toggle = page.locator('.app-toolbar__sidebar-toggle');
    await expect(toggle).toBeVisible();

    await toggle.click();
    const sidebar = page.locator('.sidebar--expanded');
    await expect(sidebar).toBeVisible();
  });

  test('sidebar drawer has navigation items', async ({ page }) => {
    await page.goto('/settings');
    // The first-run setup launcher's backdrop covers the toolbar and swallows
    // this click. Dismiss it first, as the other specs in this suite do —
    // whether it had rendered yet is what made these two intermittently red.
    await dismissSetupLauncher(page);
    const toggle = page.locator('.app-toolbar__sidebar-toggle');
    await expect(toggle).toBeVisible();

    await toggle.click();
    const navBtns = page.locator('.sidebar__nav-btn');
    await expect(navBtns.first()).toBeVisible();
  });

  test('sidebar drawer is named navigation with contained, restorable focus', async ({
    page,
  }) => {
    await page.goto('/');
    // Same first-run backdrop that made this spec's siblings intermittent.
    await dismissSetupLauncher(page);
    const toggle = page.getByRole('button', { name: 'Toggle menu' });
    await expect(toggle).toBeVisible();
    await toggle.focus();
    await toggle.press('Enter');

    const navigation = page.getByRole('navigation', {
      name: 'Mobile navigation',
    });
    await expect(navigation).toBeVisible();
    expect(await navigation.ariaSnapshot()).toContain(
      '- navigation "Mobile navigation"',
    );
    await expect(navigation.getByTitle('Close navigation')).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() =>
        navigation.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      )
      .toBe(true);

    await page.keyboard.press('Escape');
    await expect(navigation).not.toBeVisible();
    await expect(toggle).toBeFocused();
  });

  test('header nav is hidden on mobile', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const nav = page.locator('.header-nav');
    if ((await nav.count()) > 0) {
      const isVisible = await nav.evaluate(
        (el) => getComputedStyle(el).display !== 'none',
      );
      expect(isVisible).toBe(false);
    }
  });

  test('no visible interactive element has touch target smaller than 44px', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    const tooSmall = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll(
          'button, a[href], [role="button"], input, select, textarea',
        ),
      );
      return buttons
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width === 0 || rect.height === 0) return false;
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
          )
            return false;
          const parent = el.closest(
            '.sidebar--collapsed, .header-nav, [style*="display: none"]',
          );
          if (parent) return false;
          if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
          if (rect.right < 0 || rect.left > window.innerWidth) return false;
          return rect.width < 44 || rect.height < 44;
        })
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return `${el.tagName}.${el.className.toString().slice(0, 50)} ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`;
        })
        .slice(0, 20);
    });
    if (tooSmall.length > 0)
      console.warn('Touch targets under 44px:', tooSmall);
    expect(tooSmall).toHaveLength(0);
  });

  test('chat dock respects safe area', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1500);
    const dock = page.locator('.chat-dock');
    if ((await dock.count()) > 0) {
      const pb = await dock.evaluate(
        (el) => getComputedStyle(el).paddingBottom,
      );
      expect(pb).toBeTruthy();
    }
  });

  test('sidebar status footer is anchored to the viewport bottom and decoupled from chat-dock-height', async ({
    page,
  }) => {
    // chat-dock-maximize-readiness: the mobile sidebar is a full-viewport
    // overlay drawer that already covers the chat dock, so the status footer
    // must use the device safe-area bottom inset — not --dock-slot-size,
    // which would float the footer above an invisible dock.
    await page.goto('/');
    await page.waitForTimeout(2000);
    await dismissSetupLauncher(page);
    const toggle = page.locator('.app-toolbar__sidebar-toggle');
    await expect(toggle).toBeVisible();

    await toggle.click();
    await page.waitForTimeout(300);
    const sidebar = page.locator('.sidebar--expanded');
    await expect(sidebar).toBeVisible();

    const status = page.locator('.sidebar__status');
    await expect(status).toBeVisible();

    // The padding-bottom must not be inflated by the chat dock height.
    // In a desktop browser --safe-bottom resolves to 0px, so the resolved
    // padding-bottom is just the base 4px — never 4px + dock height.
    const paddingBottom = await status.evaluate((el) =>
      parseFloat(getComputedStyle(el).paddingBottom),
    );
    expect(paddingBottom).toBeLessThan(20);

    // The footer sits at the bottom of the full-height fixed drawer.
    const box = await status.boundingBox();
    expect(box).not.toBeNull();
    expect((box!.y ?? 0) + (box!.height ?? 0)).toBeGreaterThan(
      page.viewportSize()!.height - 20,
    );
  });
});
