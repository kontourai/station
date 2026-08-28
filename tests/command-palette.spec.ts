import { expect, type Page, test } from '@playwright/test';

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

// Minimal boot mocking so the app shell renders (ChatDock + CommandPalette are
// global). Mirrors the seed approach used by tests/project-lifecycle.spec.ts.
// Open the palette via its real registered ⌘K shortcut. A genuine
// `keyboard.press('Meta+k')` is swallowed by Chromium's native Cmd+K binding on
// macOS before our handler can act on it, so we dispatch the same keydown the
// global KeyboardShortcutsContext listens for on `window`.
async function openPalette(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  // Retry the dispatch until the palette mounts — the global shortcut is only
  // registered once the app shell has rendered.
  await expect(async () => {
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

/**
 * archive#3313: the Developer surfaces (Developer, Monitoring) advertise in
 * the sidebar and palette only while this DEVICE has developer tools enabled
 * — `developerToolsEnabled`, a device setting stored in the one
 * device-settings envelope. Seeded here so Monitoring stays the palette's
 * subject AND the gate itself gets end-to-end coverage in both directions
 * (see the "hides Monitoring" test below).
 */
async function seedDeveloperTools(page: Page) {
  await page.addInitScript(() => {
    const key = 'station-device-settings-v1';
    const raw = localStorage.getItem(key);
    const envelope = raw
      ? (JSON.parse(raw) as {
          version: number;
          values: Record<string, unknown>;
        })
      : { version: 2, values: {} };
    envelope.values = { ...envelope.values, developerToolsEnabled: true };
    localStorage.setItem(key, JSON.stringify(envelope));
  });
}

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
    const url = new URL(route.request().url());
    const path = url.pathname;

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
    if (path === '/api/projects') {
      await route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'p-demo',
              slug: 'demo',
              name: 'Demo Project',
              type: 'coding',
            },
          ],
        }),
      );
      return;
    }
    if (path === '/api/projects/demo/layouts') {
      await route.fulfill(
        json({
          success: true,
          data: [{ id: 'l1', slug: 'coding', name: 'Coding', type: 'coding' }],
        }),
      );
      return;
    }
    if (path === '/api/agents') {
      await route.fulfill(
        json({
          success: true,
          data: [
            { slug: 'helper-bot', name: 'Helper Bot' },
            { slug: 'coder', name: 'Coder Agent' },
          ],
        }),
      );
      return;
    }
    if (path === '/api/system/skills') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }

    await route.fulfill(json({ success: true, data: [] }));
  });
}

test.describe('Command palette', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
  });

  test('⌘K opens the palette, typing filters, Enter navigates', async ({
    page,
  }) => {
    await seedDeveloperTools(page);
    await page.goto('/');

    // Palette is not mounted until opened.
    await expect(
      page.getByRole('dialog', { name: 'Command palette' }),
    ).toHaveCount(0);

    // Open via the global ⌘K shortcut.
    await openPalette(page);

    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    const input = page.getByRole('combobox', { name: 'Search commands' });
    await expect(input).toBeVisible();

    // Default list shows navigation entries.
    await expect(
      page.getByRole('option', { name: /Monitoring/ }),
    ).toBeVisible();

    // Typing filters to the Monitoring nav command.
    await input.fill('monitoring');
    await expect(
      page.getByRole('option', { name: /Monitoring/ }),
    ).toBeVisible();
    await expect(page.getByRole('option', { name: /^Agents/ })).toHaveCount(0);

    // Enter runs the highlighted command → navigates.
    await input.press('Enter');
    await expect(page).toHaveURL(/\/developer\/telemetry$/);
    await expect(
      page.getByRole('dialog', { name: 'Command palette' }),
    ).toHaveCount(0);
  });

  test('hides Monitoring until this device enables developer tools', async ({
    page,
  }) => {
    // The other direction of the same gate. Without it, seeding the setting
    // above would make the gating itself invisible: a registry that ignored
    // `previewFlag` entirely would pass every other assertion here.
    await page.goto('/');
    await openPalette(page);

    const input = page.getByRole('combobox', { name: 'Search commands' });

    // Establish the palette is answering queries at all BEFORE asserting an
    // absence — otherwise a palette that resolved nothing would read as a
    // working gate.
    await input.fill('settings');
    await expect(
      page.getByRole('option', { name: /^Settings/ }).first(),
    ).toBeVisible();

    await input.fill('monitoring');
    await expect(page.getByRole('option', { name: /Monitoring/ })).toHaveCount(
      0,
    );
  });

  test('Esc closes the palette and filters agents from the registry', async ({
    page,
  }) => {
    await page.goto('/');

    await openPalette(page);
    const input = page.getByRole('combobox', { name: 'Search commands' });
    await expect(input).toBeVisible();

    // Seeded agent appears in results when searched.
    await input.fill('helper');
    await expect(
      page.getByRole('option', { name: /Helper Bot/ }),
    ).toBeVisible();

    await input.press('Escape');
    await expect(
      page.getByRole('dialog', { name: 'Command palette' }),
    ).toHaveCount(0);
  });

  test('persists a literal-match preference across reload and resets it locally', async ({
    page,
  }) => {
    await page.goto('/');
    await openPalette(page);
    const input = page.getByRole('combobox', { name: 'Search commands' });

    // Record the longer of two literal prefix matches. A small history boost
    // may reorder this tier, but it cannot escape it into a fuzzy result.
    await input.fill('activity');
    await page.getByRole('option', { name: /^Activity/ }).click();
    await expect(page).toHaveURL(/\/activity$/);

    await page.reload();
    await openPalette(page);
    const reloadedInput = page.getByRole('combobox', {
      name: 'Search commands',
    });
    await reloadedInput.fill('a');
    const preferredOrder = await page
      .getByRole('option')
      .evaluateAll((options) =>
        options
          .map((option) => option.textContent ?? '')
          .filter(
            (text) => text.startsWith('Agents') || text.startsWith('Activity'),
          ),
      );
    expect(preferredOrder.indexOf('ActivityNavigation')).toBeLessThan(
      preferredOrder.indexOf('AgentsNavigation'),
    );

    await reloadedInput.fill('reset command history');
    await page.getByRole('option', { name: /Reset command history/ }).click();
    await expect(
      page.getByRole('dialog', { name: 'Command palette' }).getByRole('status'),
    ).toContainText('Command history reset on this device.');

    await reloadedInput.fill('a');
    const resetOrder = await page
      .getByRole('option')
      .evaluateAll((options) =>
        options
          .map((option) => option.textContent ?? '')
          .filter(
            (text) => text.startsWith('Agents') || text.startsWith('Activity'),
          ),
      );
    expect(resetOrder.indexOf('AgentsNavigation')).toBeLessThan(
      resetOrder.indexOf('ActivityNavigation'),
    );
  });
});
