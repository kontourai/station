import { expect } from '@playwright/test';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  openHeaderSettings,
} from './helpers/orchestration';

async function goToSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  await dismissSetupLauncher(page);
  // archive#1009 targeted the gear's accessible name directly. #1552 D1 moved
  // that command into the account control's menu, and no Settings gear is
  // left in the header or the sidebar footer — so the route, not the control,
  // is what this asks for.
  await openHeaderSettings(page);
  await expect(page).toHaveURL(/\/settings(?:\?|$)/);
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('searchbox', { name: 'Filter settings' }),
  ).toBeVisible();
}

/**
 * Navigate to "Agent runs", where Default Model, Default Region, Default Agent
 * Instructions, and Template Variables live. They used to sit behind a closed
 * <details> disclosure that had to be opened first; they now render directly
 * under the section intro, so navigating is the whole step.
 */
async function openAgentDefaults(page: import('@playwright/test').Page) {
  // #2182: the section was "Agent defaults", then "Defaults" when it was
  // promoted to its own top-level scope, and is now "Agent runs" — a name for
  // the thing the values apply to rather than for the precedence rule. The
  // leaf DOM id follows the section id (`section-<id>`), so it moved too.
  await page.getByRole('link', { name: 'General', exact: true }).click();
  await page.locator('#section-agent-runs .agent-defaults__panel').waitFor();
}

/**
 * Triggers Save, awaits the exact PUT /config/app (bounded, exact method
 * and pathname), asserts it succeeded, then performs an explicit causal
 * readback: a fresh GET issued only AFTER the PUT resolved (not a
 * pre-registered waiter that could capture unrelated or stale traffic) and
 * asserts the server persisted `expectedSystemPrompt`. Finally waits for
 * query/UI reconciliation so persistence is proven, not an optimistic clear.
 */
async function saveSettingsAndVerifyPersistence(
  page: import('@playwright/test').Page,
  expectedSystemPrompt: string,
  expectedLogLevel?: string,
): Promise<void> {
  const putResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/config/app',
    { timeout: 10_000 },
  );
  const logLevelPut = expectedLogLevel
    ? page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          new URL(response.url()).pathname === '/config/app/log-level',
        { timeout: 10_000 },
      )
    : undefined;
  await page.locator('.settings__save-pill-btn').first().click();
  const saved = await putResponse;
  expect(saved.ok()).toBe(true);
  if (logLevelPut) expect((await logLevelPut).ok()).toBe(true);
  // Causal readback: a fresh GET after the PUT resolved — it cannot match
  // unrelated/stale traffic the way a pre-registered GET waiter could.
  const readback = await page.request.get(
    new URL('/config/app', page.url()).toString(),
  );
  expect(readback.ok()).toBe(true);
  const persisted = (await readback.json()) as {
    data?: { systemPrompt?: string };
  };
  expect(persisted.data?.systemPrompt).toBe(expectedSystemPrompt);
  if (expectedLogLevel) {
    const logLevel = await page.request.get(
      new URL('/config/app/log-level', page.url()).toString(),
    );
    expect(logLevel.ok()).toBe(true);
    expect((await logLevel.json()).value).toBe(expectedLogLevel);
  }
  // Wait for the ['config'] invalidate refetch to clear the dirty pill —
  // query/UI reconciliation, not an optimistic clear.
  await expect(
    page.getByText('Unsaved changes', { exact: true }),
  ).not.toBeVisible({ timeout: 10_000 });
}

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
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
                id: 'settings-test-runtime',
                type: 'codex',
                enabled: true,
                capabilities: ['llm'],
              },
            ],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: {
            chat: {
              ready: true,
              source: 'settings-test-runtime',
            },
          },
        }),
      }),
    );
    await goToSettings(page);
  });

  test.describe('mobile Customize', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('Customize offers management links at a thumb-sized target', async ({
      page,
    }) => {
      // Chromium can report 43.99998 for a 44px CSS border box.
      const cssSubpixelEpsilon = 0.001;
      const touchFloor = 44;
      await page.getByRole('button', { name: 'Toggle menu' }).click();
      await page
        .getByRole('button', { name: 'Customize', exact: true })
        .click();
      const chooser = page.getByRole('dialog', { name: 'Customize' });
      for (const label of [
        'Agents',
        'Skills',
        'Connections',
        'Plugins',
        'Appearance',
        'Settings',
      ]) {
        const entry = chooser.getByRole('link', { name: label, exact: true });
        await expect(entry).toBeVisible();
        await entry.scrollIntoViewIfNeeded();
        expect(
          await entry.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).minHeight),
          ),
          `${label} CSS touch floor`,
        ).toBeGreaterThanOrEqual(touchFloor);
        await expect
          .poll(
            async () => {
              const box = await entry.boundingBox();
              return box ? Math.min(box.width, box.height) : 0;
            },
            { message: `${label} rendered touch target` },
          )
          .toBeGreaterThanOrEqual(touchFloor - cssSubpixelEpsilon);
        await expect
          .poll(
            () =>
              entry.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                return [rect.top + 1, rect.bottom - 1].every((y) =>
                  element.contains(document.elementFromPoint(x, y)),
                );
              }),
            { message: `${label} hit area` },
          )
          .toBe(true);
      }
      await expect(
        chooser.getByRole('link', { name: 'Registry', exact: true }),
      ).toHaveCount(0);
      await expect(
        chooser.getByRole('link', { name: 'Developer', exact: true }),
      ).toHaveCount(0);
    });
  });

  test('desktop Settings has one rail of topics that stay within Settings', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav).toBeVisible();
    expect(
      await nav.evaluate((element) => getComputedStyle(element).flexDirection),
    ).toBe('column');
    expect(
      await nav.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await expect(nav.getByRole('link')).toHaveCount(10);
    for (const link of await nav.getByRole('link').all()) {
      await expect(link).toHaveAttribute('href', /\/settings\?view=/);
      const box = (await link.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
  });

  test('Customize opens Plugins and Settings remains easy to return to', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Customize', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Customize' })
      .getByRole('link', { name: 'Plugins', exact: true })
      .click();
    await expect(page).toHaveURL(/\/plugins$/);
    // The way back is the sidebar footer's account menu, which stays on
    // screen beside Plugins.
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: /^Profile and settings:/ })
      .click();
    await page.getByRole('menuitem', { name: 'Open settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator('#section-agent-runs')).toBeVisible();
  });

  test('page load shows General instead of every setting', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: 'Agent runs', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Permissions', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#section-system')).toHaveCount(0);
    await expect(page.locator('#section-appearance')).toHaveCount(0);
  });

  test('topic navigation keeps persistence scopes visible beside the controls', async ({
    page,
  }) => {
    await expect(
      page.getByText('Saved to this Station.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Appearance', exact: true }).click();
    await expect(
      page.getByText('Saved to this device.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'My knowledge', exact: true }).click();
    await expect(
      page.getByText(
        'Saved to this Station — available from every device that connects to it.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByLabel('Where settings are saved')).toHaveCount(0);
  });

  test('section query survives reload and browser history', async ({
    page,
  }) => {
    await page.getByRole('link', { name: 'Advanced', exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=advanced/);
    await expect(page.locator('#section-system')).toBeInViewport();
    await page.reload();
    await expect(page.locator('#section-system')).toBeInViewport();

    await page.getByRole('link', { name: 'General', exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=general/);
    await page.goBack();
    await expect(page).toHaveURL(/[?&]view=advanced/);
    await expect(page.locator('#section-system')).toBeInViewport();
  });

  test('invalid view query falls back without losing other query state', async ({
    page,
  }) => {
    await page.goto('/settings?keep=1&view=unknown');
    await page
      .getByRole('navigation', { name: 'Settings sections', exact: true })
      .waitFor();
    await expect(page).toHaveURL('/settings?keep=1');
    await expect(
      page.getByRole('link', { name: 'General', exact: true }),
    ).toHaveAttribute('aria-current', 'location');
    await expect(
      page.getByRole('heading', { name: 'Agent runs', exact: true }),
    ).toBeVisible();
  });

  for (const width of [320, 390]) {
    test(`keeps the phone frame visible while Settings content scrolls (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/settings?view=advanced');
      await expect(page.locator('#section-system')).toBeInViewport();
      const frame = page.locator('.app__main');
      const content = page.locator('.content-view');
      await expect
        .poll(() => frame.evaluate((element) => element.scrollTop))
        .toBe(0);
      await expect
        .poll(() =>
          frame.evaluate((element) => element.getBoundingClientRect().bottom),
        )
        .toBeLessThanOrEqual(844.1);
      await expect(page.locator('.app-toolbar')).toBeInViewport();
      await expect
        .poll(() =>
          content.evaluate(
            (element) => element.scrollHeight - element.clientHeight,
          ),
        )
        .toBeGreaterThan(0);
      const before = await content.evaluate((element) => element.scrollTop);
      await content.hover();
      await page.mouse.wheel(0, 350);
      await expect
        .poll(() => content.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(before);
      await expect
        .poll(() => frame.evaluate((element) => element.scrollTop))
        .toBe(0);
      await expect(page.locator('.app-toolbar')).toBeInViewport();
    });
  }

  test('legacy section deep links remain supported', async ({ page }) => {
    await page.goto('/settings?section=knowledge');
    await page
      .getByRole('navigation', { name: 'Settings sections', exact: true })
      .waitFor();
    await expect(page.locator('#section-knowledge')).toBeInViewport();
  });

  test('Approval guardian has a click-safe explanation', async ({ page }) => {
    await page
      .getByRole('button', { name: 'More about Approval guardian' })
      .click();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText(
      'Review asks you to decide when the guardian objects.',
    );
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
  });

  // Regression: the settings form must load saved server values into its fields
  // on mount. A stale-closure in the re-sync effect previously left local
  // `config` as `{}` forever, so every field rendered blank even though the
  // server had persisted data (looked like "save doesn't persist" but was
  // really a read-back failure). This proves the round-trip against REAL
  // saved server state: write a sentinel through the supported save path
  // (with causal PUT+GET readback), reload, and assert the field loads it.
  // No route mock: beforeEach already loaded fresh defaults, and a mock
  // installed afterwards would only prove the mock is returned.
  test('loads the saved system prompt from the server into the field', async ({
    page,
  }) => {
    await openAgentDefaults(page);
    const original = await page.inputValue('#systemPrompt');
    const SENTINEL = `SENTINEL-READBACK-9c3f ${Date.now()}`;
    try {
      await page.fill('#systemPrompt', SENTINEL);
      await saveSettingsAndVerifyPersistence(page, SENTINEL);
      await page.reload();
      await page
        .getByRole('navigation', { name: 'Settings sections', exact: true })
        .waitFor({
          timeout: 10_000,
        });
      await openAgentDefaults(page);
      await expect(page.locator('#systemPrompt')).toHaveValue(SENTINEL);
    } finally {
      await openAgentDefaults(page);
      const current = await page.inputValue('#systemPrompt');
      if (current !== original) {
        await page.fill('#systemPrompt', original);
        await saveSettingsAndVerifyPersistence(page, original);
      }
    }
  });

  test('save persists changes', async ({ page }) => {
    await openAgentDefaults(page);
    const original = await page.inputValue('#systemPrompt');
    await page.getByRole('link', { name: 'Advanced', exact: true }).click();
    const originalLogLevel = await page.inputValue('#logLevel');
    const targetLogLevel = originalLogLevel === 'debug' ? 'trace' : 'debug';
    await page.selectOption('#logLevel', targetLogLevel);
    await openAgentDefaults(page);
    const edited = `${original} [test-edit]`;
    await page.fill('#systemPrompt', edited);
    await expect(
      page.getByText('Unsaved changes', { exact: true }),
    ).toBeVisible();
    await saveSettingsAndVerifyPersistence(page, edited, targetLogLevel);
    await page.reload();
    await page.getByRole('link', { name: 'Advanced', exact: true }).click();
    await expect(page.locator('#logLevel')).toHaveValue(targetLogLevel);
    await openAgentDefaults(page);
    // Restore the original through the same proven persistence path; the
    // causal readback inside the helper asserts the server again matches the
    // original, so restoration is verified rather than assumed.
    await page.fill('#systemPrompt', original);
    await page.getByRole('link', { name: 'Advanced', exact: true }).click();
    await page.selectOption('#logLevel', originalLogLevel);
    await openAgentDefaults(page);
    await saveSettingsAndVerifyPersistence(page, original, originalLogLevel);
  });

  test('keeps Log Level pending when only its revisioned save fails', async ({
    page,
  }) => {
    await openAgentDefaults(page);
    const original = await page.inputValue('#systemPrompt');
    const edited = `${original} [partial-save]`;
    await page.fill('#systemPrompt', edited);
    await page.getByRole('link', { name: 'Advanced', exact: true }).click();
    const originalLogLevel = await page.inputValue('#logLevel');
    const targetLogLevel = originalLogLevel === 'debug' ? 'trace' : 'debug';
    await page.selectOption('#logLevel', targetLogLevel);
    await page.route('**/config/app/log-level', (route) => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'internal contract' }),
        });
      }
      return route.fallback();
    });
    const plainPut = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/config/app',
    );
    await page.locator('.settings__save-pill-btn').first().click();
    expect((await plainPut).ok()).toBe(true);
    await expect(
      page.getByText(
        /Log Level could not be saved\. Other settings were saved/,
      ),
    ).toBeVisible();
    await expect(page.locator('#logLevel')).toHaveValue(targetLogLevel);
    const readback = await page.request.get(
      new URL('/config/app', page.url()).toString(),
    );
    expect((await readback.json()).data?.systemPrompt).toBe(edited);
    await page.unroute('**/config/app/log-level');
    await page.selectOption('#logLevel', originalLogLevel);
    await openAgentDefaults(page);
    await page.fill('#systemPrompt', original);
    await saveSettingsAndVerifyPersistence(page, original);
  });

  test('discard reverts changes', async ({ page }) => {
    await openAgentDefaults(page);
    const original = await page.inputValue('#systemPrompt');
    await page.fill(
      '#systemPrompt',
      'Temporary change that should be discarded',
    );
    await expect(
      page.getByText('Unsaved changes', { exact: true }),
    ).toBeVisible();
    await page.locator('.settings__save-pill-discard').first().click();
    await expect(page.locator('#systemPrompt')).toHaveValue(original);
    await expect(
      page.getByText('Unsaved changes', { exact: true }),
    ).not.toBeVisible();
  });

  test('reset shows a confirm modal that states what it does and does not touch', async ({
    page,
  }) => {
    await page.getByRole('link', { name: 'Advanced', exact: true }).click();
    await page.getByRole('button', { name: 'Reset Station settings' }).click();
    const dialog = page.getByRole('alertdialog', {
      name: 'Reset Station settings',
    });
    await expect(dialog).toBeVisible();
    // The one sentence that holds whatever this Station currently stores: the
    // list of cleared labels varies with the instance, the device-scope
    // carve-out does not.
    await expect(
      dialog.getByText('Settings on this device are not affected.', {
        exact: false,
      }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('Agent runs shows the generic region field', async ({ page }) => {
    await openAgentDefaults(page);
    await expect(
      page.getByText('Region for connections that use regional routing.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByLabel('Default Region', { exact: true }),
    ).toBeVisible();
  });

  test('template variable add and remove', async ({ page }) => {
    await openAgentDefaults(page);
    const initialCount = await page.locator('.settings__var-row').count();
    await page.getByRole('button', { name: '+ Add Variable' }).click();
    await expect(page.locator('.settings__var-row')).toHaveCount(
      initialCount + 1,
    );
    const type = page.getByRole('combobox', {
      name: `Template variable ${initialCount + 1} type`,
    });
    await type.selectOption('date');
    await expect(
      page
        .locator('.settings__var-row')
        .last()
        .getByPlaceholder('Format (optional)'),
    ).toBeVisible();
    // Remove the last one
    await page.locator('.settings__var-remove').last().click();
    await expect(page.locator('.settings__var-row')).toHaveCount(initialCount);
    // Discard if needed
    const pill = page.getByText('Unsaved changes', { exact: true });
    if (await pill.isVisible()) {
      await page.locator('.settings__save-pill-discard').first().click();
    }
  });

  test('theme toggle switches mode', async ({ page }) => {
    await page.getByRole('link', { name: 'Appearance', exact: true }).click();
    const themeBtn = page.locator('.theme-toggle').first();
    const initialTheme = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    await themeBtn.click();
    const newTheme = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    expect(newTheme).not.toBe(initialTheme);
    // Toggle back
    await themeBtn.click();
  });

  test('captures and resolves a shortcut conflict before persisting', async ({
    page,
  }) => {
    await page
      .getByRole('link', { name: 'Keyboard shortcuts', exact: true })
      .click();
    const settingsShortcut = page.getByRole('button', {
      name: 'Shortcut for Toggle settings',
    });
    await settingsShortcut.click();
    await page.keyboard.press('Meta+K');

    const conflict = page.getByRole('dialog', {
      name: 'Shortcut already in use',
    });
    await expect(conflict).toContainText('Open command palette');
    await conflict.getByRole('button', { name: 'Cancel' }).click();

    await settingsShortcut.click();
    await page.keyboard.press('Meta+K');
    await page
      .getByRole('dialog', { name: 'Shortcut already in use' })
      .getByRole('button', { name: 'Replace' })
      .click();

    // station#settings-revamp slice 3 (archive#1359 convergence): shortcut
    // overrides now live in the registry-driven device-settings envelope's
    // `shortcutOverrides` entry, not the retired `station.device-settings`
    // root.
    const bindings = await page.evaluate(() => {
      const envelope = JSON.parse(
        localStorage.getItem('station-device-settings-v1') ?? '{}',
      );
      return envelope.values.shortcutOverrides;
    });
    expect(bindings['app.settings']).toEqual({
      key: 'k',
      modifiers: ['cmd'],
    });
    expect(bindings['command-palette']).toBeNull();

    const row = page.getByText('Toggle settings').locator('..').locator('..');
    await row.getByRole('button', { name: 'Restore default' }).click();
  });

  test('mobile section picker stays within Settings', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const filter = page.getByRole('searchbox', { name: 'Filter settings' });
    await expect(filter).toHaveCSS('font-size', '16px');
    await filter.focus();
    await filter.fill('theme');
    await filter.blur();
    await expect(filter).toHaveCSS('font-size', '16px');
    await filter.fill('');
    await expect(
      page.getByRole('navigation', { name: 'Settings sections', exact: true }),
    ).toBeHidden();
    const picker = page.getByRole('combobox', { name: 'Settings section' });
    await expect(picker).toBeVisible();
    expect((await picker.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await picker.selectOption({ label: 'Notifications & voice' });
    await expect(page).toHaveURL(/view=alerts/);
    await page
      .locator('summary')
      .filter({ hasText: /^Notification sounds$/ })
      .click();
    for (const name of ['Agent notifications', 'Approval requests sound']) {
      expect(
        (await page.getByRole('combobox', { name }).boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
    }
    await picker.selectOption({ label: 'Keyboard shortcuts' });
    await expect(page).toHaveURL(/view=keyboard-shortcuts/);
    await expect(
      page.getByText(/Edit them from Station on a computer/i),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Shortcut for Toggle settings' }),
    ).toBeDisabled();
    await expect(picker.locator('option', { hasText: 'Agents' })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(() =>
        Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        ),
      ),
    ).toBeLessThanOrEqual(page.viewportSize()!.width);
  });

  test('search filters sections', async ({ page }) => {
    await page.fill('.settings__search', 'theme');
    await expect(page.locator('#section-appearance')).toBeVisible();
    await expect(page.locator('#section-agent-runs')).not.toBeVisible();
    await expect(page.locator('#section-system')).not.toBeVisible();
    // Clear restores General
    await page.fill('.settings__search', '');
    await expect(page.locator('#section-agent-runs')).toBeVisible();
    await expect(page.locator('#section-system')).toHaveCount(0);
  });

  test('accent color picker applies color', async ({ page }) => {
    await page.getByRole('link', { name: 'Appearance', exact: true }).click();
    const swatch = page.locator('.settings__accent-swatch').first();
    await swatch.click();
    const accent = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--accent-primary'),
    );
    expect(accent).toBeTruthy();
    // Reset
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    const cleared = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--accent-primary'),
    );
    expect(cleared).toBe('');
  });

  test('Cmd/Ctrl+X guard prompts before closing with unsaved changes', async ({
    page,
  }) => {
    await openAgentDefaults(page);
    await page.fill('#systemPrompt', 'Dirty edit for close-guard test');
    await expect(
      page.getByText('Unsaved changes', { exact: true }),
    ).toBeVisible();

    async function pressCloseShortcut() {
      await page
        .getByRole('heading', { name: 'Settings', exact: true })
        .click();
      await page.keyboard.press('ControlOrMeta+x');
    }

    await pressCloseShortcut();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'Unsaved Changes' }),
    ).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Settings sections', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#systemPrompt')).toHaveValue(
      'Dirty edit for close-guard test',
    );

    await pressCloseShortcut();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Discard' })
      .click();
    await expect(
      page.getByRole('navigation', { name: 'Settings sections', exact: true }),
    ).not.toBeVisible();
  });

  test('notifications switch announces its description', async ({ page }) => {
    await page
      .getByRole('link', { name: 'Notifications & voice', exact: true })
      .click();
    const toggle = page.locator('#section-notifications [role="switch"]');
    await expect(toggle).toHaveAccessibleDescription(
      'Browser push notifications for tool approvals and high-priority alerts',
    );
  });
});

test('Save remains clickable above an open resized dock', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings?dock=open');
  await dismissSetupLauncher(page);
  await openAgentDefaults(page);
  const prompt = page.locator('#systemPrompt');
  await prompt.fill(`${await prompt.inputValue()}\nDock occlusion check`);
  const save = page.locator('.settings__save-pill-btn');
  const dock = page.locator('.chat-dock');
  const resize = page.getByRole('separator', { name: 'Resize chat dock' });
  await expect(save).toBeVisible();
  await expect(dock).toBeVisible();
  await expect(resize).toBeVisible();
  for (const delta of [80, -40]) {
    const before = (await dock.boundingBox())!;
    const handle = (await resize.boundingBox())!;
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2 - delta,
      { steps: 4 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await dock.boundingBox())?.height)
      .not.toBe(before.height);
    const saveBox = (await save.boundingBox())!;
    const dockBox = (await dock.boundingBox())!;
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(dockBox.y);
    expect(
      await save.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ),
        );
      }),
    ).toBe(true);
  }
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/config/app',
  );
  await save.click();
  expect((await saved).ok()).toBe(true);
  await expect(page.locator('.settings__save-pill')).toBeHidden();
});

test.describe('Settings scope and provenance', () => {
  for (const [width, theme] of [
    [390, 'light'],
    [390, 'dark'],
    [1440, 'light'],
    [1440, 'dark'],
  ] as const) {
    test(`shows personal store scope and only meaningful provenance at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.route(/\/config\/app(?:\?|$)/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        const envelope = await response.json();
        await route.fulfill({
          response,
          json: {
            ...envelope,
            provenance: {
              ...envelope.provenance,
              region: { source: 'env', envVar: 'AWS_REGION' },
              defaultWorkspaceIsolation: { source: 'default' },
            },
          },
        });
      });

      await page.goto('/settings?view=agent-runs');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const region = page.locator('#default-region');
      await expect(
        region.getByText('Set by operator: AWS_REGION', { exact: true }),
      ).toBeVisible();
      await region.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath('operator-environment.png'),
        animations: 'disabled',
      });

      const workspace = page.locator('#default-workspace-isolation');
      await expect(workspace).toBeVisible();
      await workspace.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath('built-in-default.png'),
        animations: 'disabled',
      });
      await expect.soft(workspace.locator('.provenance-badge')).toHaveCount(0);
      await workspace
        .getByRole('button', { name: /Where .* comes from/ })
        .click();
      await expect(
        page.getByText('Built-in default', { exact: true }),
      ).toBeVisible();
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: /Search or jump to/ }).click();
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      await palette.getByRole('combobox').fill('my knowledge store');
      const target = palette.getByRole('option', {
        name: /Settings: My knowledge store/,
      });
      await expect(target).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('personal-store-scope.png'),
        animations: 'disabled',
      });
      await expect
        .soft(target)
        .toContainText('Managed by the Station operator.');
      const scopeDetail = target.getByText('Managed by the Station operator.', {
        exact: true,
      });
      await expect(scopeDetail).toBeVisible();
      expect(
        await scopeDetail.evaluate(
          (detail) => detail.scrollWidth - detail.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      await target.click();
      await expect(page.locator('#personal-knowledge-store')).toBeInViewport();
    });
  }
});

test.describe('Settings discovery and preferences', () => {
  const destinations = [
    {
      query: 'local accounts',
      title: 'Accounts and sign-in',
      id: 'local-accounts',
    },
    {
      query: 'usage disclosure',
      title: 'What usage sharing includes',
      id: 'usage-disclosure',
    },
    {
      query: 'skill shortcuts',
      title: 'Skill shortcuts',
      id: 'skill-shortcuts',
    },
    {
      query: 'model picker preferences',
      title: 'Model picker preferences',
      id: 'model-picker-preferences',
    },
  ];

  test('discovers the four rows through Settings search and the palette', async ({
    page,
  }, testInfo) => {
    await goToSettings(page);
    for (const destination of destinations) {
      const target = page.locator(`[data-catalog-id="${destination.id}"]`);
      const search = page.getByRole('searchbox', { name: 'Filter settings' });
      await search.fill(destination.query);
      await expect(target).toBeVisible();
      await search.clear();

      await page.getByRole('button', { name: /Search or jump to/ }).click();
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      await palette.getByRole('combobox').fill(destination.title);
      await palette
        .getByRole('option', {
          name: new RegExp(`Settings: ${destination.title}`),
        })
        .click();
      await expect(
        page.getByText(`${destination.title} revealed in Settings.`, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(target).toBeInViewport();

      if (destination.id === 'usage-disclosure') {
        const original = page.viewportSize();
        if (!original)
          throw new Error('Settings discovery requires a viewport.');
        const summary = target.getByText('View included fields', {
          exact: true,
        });
        for (const width of [320, 390, 1440]) {
          await page.setViewportSize({ width, height: 844 });
          await summary.scrollIntoViewIfNeeded();
          if (width <= 390) {
            await expect
              .poll(async () => (await summary.boundingBox())?.height ?? 0)
              .toBeGreaterThanOrEqual(44);
          }
          await summary.click();
          await expect(
            target.getByRole('region', { name: 'Anonymous usage counts' }),
          ).toBeVisible();
          await expect(target.getByRole('radio')).toHaveCount(0);
          await summary.click();
          await expect(
            target.getByRole('region', { name: 'Anonymous usage counts' }),
          ).toBeHidden();
        }
        await page.setViewportSize(original);
      }
    }

    const picker = page.locator('[data-catalog-id="model-picker-preferences"]');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await picker.scrollIntoViewIfNeeded();
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme,
        );
        await page.screenshot({
          path: testInfo.outputPath(`settings-catalog-${width}-${theme}.png`),
          animations: 'disabled',
        });
      }
    }
  });

  test('edits a prior skill binding and only clears model recents', async ({
    page,
  }) => {
    const modelKey = (model: string) => `settings-models\u001f${model}`;
    const priorModels = {
      favorites: [modelKey('alpha')],
      hidden: [modelKey('beta')],
      order: [modelKey('beta'), modelKey('alpha')],
      recents: [modelKey('alpha')],
    };
    let accountModels: typeof priorModels | undefined;
    let revision = 'before-import';
    await page.route('**/api/me/preferences*', async (route) => {
      const request = route.request();
      if (request.method() === 'PATCH') {
        const onlyMissing = new URL(request.url()).searchParams.get(
          'onlyMissing',
        );
        if (onlyMissing === 'true') {
          expect(accountModels).toBeUndefined();
          expect(request.postDataJSON()).toEqual({
            modelPickerPreferences: priorModels,
          });
          accountModels = priorModels;
          revision = 'imported';
        } else {
          expect(request.headers()['if-match']).toBe('imported');
          expect(request.postDataJSON()).toEqual({
            modelPickerPreferences: { ...priorModels, recents: [] },
          });
          accountModels = { ...priorModels, recents: [] };
          revision = 'cleared';
        }
      } else if (request.method() !== 'GET') {
        return rejectUnexpectedFixtureRequest(route);
      }
      return route.fulfill({
        json: {
          success: true,
          data: {
            schemaVersion: 1,
            revision,
            values: accountModels
              ? { modelPickerPreferences: accountModels }
              : {},
          },
        },
      });
    });
    await page.addInitScript((preferences) => {
      if (localStorage.getItem('settings-discovery-seeded')) return;
      localStorage.setItem('settings-discovery-seeded', '1');
      localStorage.setItem(
        'station-device-settings-v1',
        JSON.stringify({
          version: 2,
          values: {
            skillShortcuts: {
              'settings-probe': { key: 'F7', modifiers: ['alt'] },
              'unavailable-skill': { key: 'F6', modifiers: ['alt'] },
            },
            modelPickerPreferences: preferences,
          },
        }),
      );
    }, priorModels);
    await page.route('**/api/system/skills', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              name: 'settings-probe',
              description: 'Command skill for Settings verification',
              command: { enabled: true, name: 'settings-probe' },
            },
          ],
        },
      }),
    );
    await page.route('**/api/connections/models', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              kind: 'model',
              id: 'settings-models',
              type: 'openai-compat',
              name: 'Settings test models',
              enabled: true,
              status: 'ready',
              capabilities: ['llm'],
              config: {
                baseUrl: 'https://settings-models.example.test/v1',
                modelOptions: [
                  { id: 'alpha', name: 'Alpha' },
                  { id: 'beta', name: 'Beta' },
                ],
              },
              prerequisites: [],
              lastCheckedAt: null,
            },
          ],
        },
      }),
    );
    await goToSettings(page);
    await page
      .getByRole('link', { name: 'Keyboard shortcuts', exact: true })
      .click();
    const skills = page.locator('[data-catalog-id="skill-shortcuts"]');
    const shortcut = skills.getByRole('button', {
      name: 'Shortcut for Run /settings-probe',
    });
    await expect(shortcut).toContainText('F7');
    await expect(
      skills.getByRole('list', {
        name: 'Saved shortcuts for unavailable skills',
      }),
    ).toContainText('unavailable-skill');
    await shortcut.click();
    await page.keyboard.press('Alt+F8');
    await expect(shortcut).toContainText('F8');

    const readValues = () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('station-device-settings-v1') ?? '{}')
            .values,
      );
    await expect.poll(readValues).toMatchObject({
      skillShortcuts: {
        'settings-probe': { key: 'F8', modifiers: ['alt'] },
        'unavailable-skill': { key: 'F6', modifiers: ['alt'] },
      },
      modelPickerPreferences: priorModels,
    });
    await page.reload();
    await expect(shortcut).toContainText('F8');

    const search = page.getByRole('searchbox', { name: 'Filter settings' });
    await search.fill('model picker preferences');
    const models = page.locator('[data-catalog-id="model-picker-preferences"]');
    await expect(models).toContainText(
      'Previous model picker choices are saved on this device.',
    );
    await models
      .getByRole('button', { name: 'Review preference import' })
      .click();
    const importButton = page.getByRole('button', {
      name: 'Import previous preferences',
    });
    await expect(importButton).toBeInViewport();
    await importButton.click();
    await expect.poll(() => accountModels).toEqual(priorModels);
    await search.fill('model picker preferences');
    await expect(models).toContainText('Favorites: 1');
    await expect(models).toContainText('Hidden: 1');
    await expect(models).toContainText('Ordered: 2');
    await expect(models).toContainText('Recent: 1');
    await models.getByRole('button', { name: 'Clear recent models' }).click();
    await expect
      .poll(() => accountModels)
      .toEqual({ ...priorModels, recents: [] });
    await expect
      .poll(readValues)
      .toMatchObject({ modelPickerPreferences: priorModels });
    await page.reload();
    await search.fill('model picker preferences');
    await expect(
      models.getByRole('button', { name: 'Clear recent models' }),
    ).toBeDisabled();
    await models
      .getByRole('button', { name: 'Open model connections' })
      .click();
    await expect(page).toHaveURL(/\/connections\/models$/);
    await page
      .getByRole('button', { name: 'Settings test models', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Remove Alpha from favorites' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show Beta' })).toBeVisible();
  });
});
