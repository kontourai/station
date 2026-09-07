import { expect, test } from '@playwright/test';
import {
  dismissSetupLauncher,
  openHeaderSettings,
} from './helpers/orchestration';

async function goToSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  await dismissSetupLauncher(page);
  // archive#1009 targeted the gear's accessible name directly. #1552 D1 moved
  // that command into the avatar's menu on a fine pointer, and this suite runs
  // at the default desktop viewport where the gear is `display: none` — so the
  // route, not the control, is what this asks for.
  await openHeaderSettings(page);
  await page.waitForSelector('.settings__section-nav', { timeout: 10_000 });
}

/**
 * Default Model, Default Region, Default Agent Instructions, and Template
 * Variables are de-emphasized fallback values behind a closed <details>
 * disclosure in "Defaults" (formerly "Agent defaults") — open it before interacting with any of
 * those fields.
 */
async function openAgentDefaults(page: import('@playwright/test').Page) {
  // station#settings-revamp slice 3: "Agent defaults" was renamed "Defaults"
  // when it was promoted to its own top-level scope section; the leaf DOM id
  // (#section-agent-defaults) is unchanged.
  await page.getByRole('link', { name: 'Defaults', exact: true }).click();
  await page.locator('#section-agent-defaults summary').click();
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

  test('page load shows the primary settings sections', async ({ page }) => {
    for (const title of [
      'Appearance',
      'Keyboard shortcuts',
      'Notifications',
      'Voice & Features',
      'My knowledge store',
      'Diagnostics',
      'System',
      'Station configuration',
      'Defaults',
    ]) {
      await expect(
        page.getByRole('heading', { name: title }).first(),
      ).toBeVisible();
    }
  });

  test('overview summarizes status and drills into URL-backed settings views', async ({
    page,
  }) => {
    await expect(
      page.getByRole('heading', { name: 'Your settings are ready' }),
    ).toBeVisible();
    await expect(page.getByText('No issues', { exact: true })).toBeVisible();
    const deviceCard = page.locator(
      '.settings-overview__card[href*="view=appearance"]',
    );
    await expect(deviceCard).toContainText('Personal experience');
    await expect(deviceCard).toHaveAttribute('href', /[?&]view=appearance/);
    await deviceCard.click();
    await expect(page).toHaveURL(/[?&]view=appearance/);
    await expect(page.locator('#section-appearance')).toBeInViewport();
  });

  // station#settings-revamp slice 3: the /settings IA restructure — three
  // registry-driven scope groups (Station / Defaults / This device) with a
  // persistence-tier caption each, replacing the flat nav. archive#1826
  // dropped the three-card scope legend (it restated this grouping) and
  // reworded the Defaults/device captions in product terms; the captions are
  // now the only place the persistence tiers are explained, so this test
  // pins them. It also pins that the Station group leads with Station
  // configuration — controls before diagnostics.
  test('nav groups sections under Station / Defaults / This device, each with a persistence-tier caption', async ({
    page,
  }) => {
    const nav = page.locator('.settings__section-nav');
    await expect(
      nav.locator('.settings__nav-group-title', { hasText: 'Station' }),
    ).toBeVisible();
    await expect(
      nav.locator('.settings__nav-group-title', { hasText: 'Defaults' }),
    ).toBeVisible();
    await expect(
      nav.locator('.settings__nav-group-title', { hasText: 'This device' }),
    ).toBeVisible();

    // The Station group's nav leads with what a person changes (archive#1826).
    await expect(
      nav
        .locator('.settings__nav-group')
        .first()
        .locator('.page__section-link')
        .first(),
    ).toHaveText('Station configuration');

    await expect(
      page.getByText(
        'Saved to this Station — every client sees the same values.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Saved to this Station — used when a chat, project, or agent doesn’t set its own value.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Saved to this device only — these choices won’t follow you to another device.',
      ),
    ).toBeVisible();

    // Knowledge sits outside the scope groups; its caption carries the
    // persistence fact the legend used to state (delivery review M2).
    await expect(
      page.getByText(
        'Saved to this Station — available from every device that connects to it.',
      ),
    ).toBeVisible();

    // The old three-card legend must not return (archive#1826).
    await expect(page.getByLabel('Where settings are saved')).toHaveCount(0);
  });

  test('section nav scrolls to section', async ({ page }) => {
    await page.getByRole('link', { name: 'System', exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=system/);
    await expect(page.locator('#section-system')).toBeInViewport();
  });

  test('section query survives reload and browser history', async ({
    page,
  }) => {
    await page.getByRole('link', { name: 'System', exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=system/);
    await page.reload();
    await expect(page.locator('#section-system')).toBeInViewport();

    await page.getByRole('link', { name: 'Defaults', exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=agent-defaults/);
    await page.goBack();
    await expect(page).toHaveURL(/[?&]view=system/);
    await expect(page.locator('#section-system')).toBeInViewport();
  });

  test('invalid view query falls back without losing other query state', async ({
    page,
  }) => {
    await page.goto('/settings?keep=1&view=unknown');
    await page.waitForSelector('.settings__section-nav');
    await expect(page).toHaveURL('/settings?keep=1');
    await expect(page.locator('#section-overview')).toBeVisible();
  });

  test('legacy section deep links remain supported', async ({ page }) => {
    await page.goto('/settings?section=knowledge');
    await page.waitForSelector('.settings__section-nav');
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

  test('changing system prompt shows save pill', async ({ page }) => {
    await openAgentDefaults(page);
    await page.fill('#systemPrompt', 'New prompt text for testing');
    await expect(
      page.getByText('Unsaved changes', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    // Clean up
    await page.locator('.settings__save-pill-discard').first().click();
  });

  // Regression: the settings form must load saved server values into its fields
  // on mount. A stale-closure in the re-sync effect previously left local
  // `config` as `{}` forever, so every field rendered blank even though the
  // server had persisted data (looked like "save doesn't persist" but was
  // really a read-back failure).
  test('loads the saved system prompt from the server into the field', async ({
    page,
  }) => {
    const SENTINEL = 'SENTINEL-READBACK-9c3f-do-not-edit';
    await page.route('**/config/app', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            systemPrompt: SENTINEL,
            defaultChatFontSize: 14,
            region: '',
            userId: 'default-user',
          },
        }),
      }),
    );
    // Re-load so the mocked config is fetched fresh (beforeEach already loaded).
    await goToSettings(page);
    await openAgentDefaults(page);
    await expect(page.locator('#systemPrompt')).toHaveValue(SENTINEL);
  });

  test('save persists changes', async ({ page }) => {
    await openAgentDefaults(page);
    const original = await page.inputValue('#systemPrompt');
    await page.getByRole('link', { name: 'System', exact: true }).click();
    const originalLogLevel = await page.inputValue('#logLevel');
    await page.selectOption('#logLevel', 'debug');
    await openAgentDefaults(page);
    const edited = `${original} [test-edit]`;
    await page.fill('#systemPrompt', edited);
    await expect(
      page.getByText('Unsaved changes', { exact: true }),
    ).toBeVisible();
    await saveSettingsAndVerifyPersistence(page, edited, 'debug');
    await page.reload();
    await expect(page.locator('#logLevel')).toHaveValue('debug');
    // Restore the original through the same proven persistence path; the
    // causal readback inside the helper asserts the server again matches the
    // original, so restoration is verified rather than assumed.
    await page.fill('#systemPrompt', original);
    await page.getByRole('link', { name: 'System', exact: true }).click();
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
    await page.getByRole('link', { name: 'System', exact: true }).click();
    await page.selectOption('#logLevel', 'debug');
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
    await expect(page.locator('#logLevel')).toHaveValue('debug');
    const readback = await page.request.get(
      new URL('/config/app', page.url()).toString(),
    );
    expect((await readback.json()).data?.systemPrompt).toBe(edited);
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

  test('reset to defaults shows confirm modal', async ({ page }) => {
    await page.getByRole('link', { name: 'System', exact: true }).click();
    await page.getByRole('button', { name: 'Reset to Defaults' }).click();
    await expect(
      page.getByText('Are you sure you want to reset'),
    ).toBeVisible();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(
      page.getByText('Are you sure you want to reset'),
    ).not.toBeVisible();
  });

  test('routes provider, service, and computer setup to Connections', async ({
    page,
  }) => {
    await expect(
      page.getByText('Providers, developer services, and computers'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open Connections' }).click();
    await expect(page).toHaveURL(/\/connections$/);
  });

  test('Agent defaults shows the generic region field behind the disclosure', async ({
    page,
  }) => {
    await openAgentDefaults(page);
    await expect(
      page.getByText(
        'Used when a configured connection requires regional routing, such as built-in cloud services.',
        { exact: true },
      ),
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

  test('mobile layout has horizontal scroll nav and read-only shortcuts', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const nav = page.locator('.settings__section-nav');
    const overflowX = await nav.evaluate(
      (el) => getComputedStyle(el).overflowX,
    );
    expect(overflowX).toBe('auto');
    await page
      .getByRole('link', { name: 'Keyboard shortcuts', exact: true })
      .click();
    await expect(
      page.getByText(/Edit them from Station on a computer/i),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Shortcut for Toggle settings' }),
    ).toBeDisabled();
  });

  test('search filters sections', async ({ page }) => {
    await page.fill('.settings__search', 'theme');
    await expect(page.locator('#section-appearance')).toBeVisible();
    await expect(page.locator('#section-agent-defaults')).not.toBeVisible();
    await expect(page.locator('#section-system')).not.toBeVisible();
    // Clear restores all
    await page.fill('.settings__search', '');
    await expect(page.locator('#section-agent-defaults')).toBeVisible();
    await expect(page.locator('#section-system')).toBeVisible();
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

  test('export includes device settings', async ({ page }) => {
    // Slice 2 (archive#1271) unified the raw per-key localStorage settings
    // into one versioned envelope; the export payload carries that envelope
    // instead of the old 4-key `_localStorage` map. Slice 3 review finding 1
    // bumped the envelope to v2 (a v1 -> v2 ladder step backfills the
    // archive#1359 shortcut/model-picker root for already-upgraded devices).
    const envelope = await page.evaluate(() => {
      const raw = localStorage.getItem('station-device-settings-v1');
      return raw ? JSON.parse(raw) : null;
    });
    expect(envelope).toBeTruthy();
    expect(envelope.version).toBe(2);
    // The migrated legacy keys must be gone — the envelope is the only home.
    const legacyTheme = await page.evaluate(() =>
      localStorage.getItem('theme'),
    );
    expect(legacyTheme).toBeNull();
  });

  test('Cmd/Ctrl+X guard prompts before closing with unsaved changes', async ({
    page,
  }) => {
    await openAgentDefaults(page);
    await page.fill('#systemPrompt', 'Dirty edit for close-guard test');
    await expect(
      page.getByText('Unsaved changes', { exact: true }),
    ).toBeVisible();

    // useCloseShortcut listens for keydown on `window`; a genuine
    // `keyboard.press('Control+x')`/`Meta+x` risks being swallowed by the
    // browser's native cut binding before our handler sees it, so dispatch
    // the same keydown directly (mirrors tests/command-palette.spec.ts's
    // ⌘K dispatch for the same reason).
    async function pressCloseShortcut() {
      await page.evaluate(() => {
        const isMac = navigator.platform.toUpperCase().includes('MAC');
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'x',
            metaKey: isMac,
            ctrlKey: !isMac,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }

    await pressCloseShortcut();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'Unsaved Changes' }),
    ).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.settings__section-nav')).toBeVisible();
    await expect(page.locator('#systemPrompt')).toHaveValue(
      'Dirty edit for close-guard test',
    );

    await pressCloseShortcut();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Discard' })
      .click();
    await expect(page.locator('.settings__section-nav')).not.toBeVisible();
  });

  test('toggle has aria-describedby', async ({ page }) => {
    await page
      .getByRole('link', { name: 'Notifications', exact: true })
      .click();
    const toggle = page.locator('#section-notifications [role="switch"]');
    const describedBy = await toggle.getAttribute('aria-describedby');
    expect(describedBy).toBe('notif-desc');
    await expect(page.locator('#notif-desc')).toBeVisible();
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
