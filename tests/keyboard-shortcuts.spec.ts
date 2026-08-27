import { expect, type Page, test } from '@playwright/test';

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

// Open the shortcuts cheatsheet via its real registered ⌘/ shortcut. As with
// ⌘K in command-palette.spec.ts, a genuine key press is intercepted by the
// browser, so we dispatch the keydown the global KeyboardShortcutsContext
// listens for on `window`, retrying until the app shell has registered it.
async function openCheatsheet(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(async () => {
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '/',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

// Minimal boot mocking so the global app shell renders (mirrors
// command-palette.spec.ts).
async function seedRoutes(page: Page) {
  await page.route('**/config/app', async (route) => {
    await route.fulfill(
      json({
        success: true,
        data: { apiBase: '', defaultModel: 'codex-mini' },
      }),
    );
  });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;

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

    await route.fulfill(json({ success: true, data: [] }));
  });
}

test.describe('Keyboard shortcuts cheatsheet', () => {
  test.beforeEach(async ({ page }) => {
    // This suite owns global shortcut behavior, not first-run onboarding.
    // Prevent the engine picker from consuming Escape before route hierarchy.
    await page.addInitScript(() => {
      window.localStorage.setItem('station:onboarding-setup-dismissed', '1');
    });
    await seedRoutes(page);
  });

  test('⌘/ opens the cheatsheet with friendly categories and kbd hints', async ({
    page,
  }) => {
    await page.goto('/');

    // Not mounted until opened.
    await expect(
      page.getByRole('dialog', { name: 'Keyboard shortcuts' }),
    ).toHaveCount(0);

    await openCheatsheet(page);
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();

    // Friendly category label (not the raw "app"/"command-palette" id prefix).
    await expect(
      dialog.getByRole('heading', { name: 'General' }),
    ).toBeVisible();

    // The command-palette shortcut is listed with its description + a kbd hint.
    const paletteRow = dialog
      .locator('.shortcuts-cheatsheet__row')
      .filter({ hasText: 'Open command palette' });
    await expect(paletteRow).toBeVisible();
    await expect(paletteRow.locator('kbd')).not.toBeEmpty();

    // No raw namespace key leaks through as a heading.
    await expect(
      dialog.getByRole('heading', { name: 'command-palette' }),
    ).toHaveCount(0);
  });

  test('Escape closes the cheatsheet', async ({ page }) => {
    await page.goto('/');
    await openCheatsheet(page);

    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('Escape closes a modal before navigating its parent route', async ({
    page,
  }) => {
    // station#3759: `ShortcutsCheatsheet` goes through `ResponsiveDialogSurface`
    // like every other dialog, so the surface owns Escape and the registry
    // suppresses its route-level `app.escapeUp` fallback while a modal is up.
    await page.goto('/settings');
    await openCheatsheet(page);

    await page.keyboard.press('Escape');

    await expect(
      page.getByRole('dialog', { name: 'Keyboard shortcuts' }),
    ).toHaveCount(0, { timeout: 2_000 });
    await expect(page).toHaveURL(/\/settings$/, { timeout: 2_000 });
  });

  test('Escape does not leave a route while editing text', async ({ page }) => {
    await page.goto('/settings');
    const search = page.getByRole('textbox', { name: 'Filter settings' });
    await search.fill('theme');
    await search.press('Escape');

    await expect(page).toHaveURL(/\/settings$/);
    await expect(search).toHaveValue('theme');
  });

  test('Escape follows Station hierarchy instead of browser history', async ({
    page,
  }) => {
    await page.goto('/connections/providers/example-provider');
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName))
      .toBe('BODY');

    // The route can paint before the global shortcut registry finishes
    // subscribing. Exercise the real key repeatedly until that owner is live,
    // as openCheatsheet does for the same app-shell registration boundary.
    await expect(async () => {
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/\/connections\/models$/, {
        timeout: 1_000,
      });
    }).toPass({ timeout: 15_000 });
  });
});
