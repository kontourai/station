import { expect, type Page, test } from '@playwright/test';
import {
  expectNoBlockingAccessibilityViolations,
  getBlockingAccessibilityViolations,
} from './helpers/accessibility';
import { contrastRatio } from './helpers/color-contrast';

const project = {
  id: 'project-a11y',
  slug: 'a11y-demo',
  name: 'Accessibility Demo',
  hasWorkingDirectory: true,
  workingDirectory: '/workspace/a11y-demo',
  layoutCount: 0,
  hasKnowledge: false,
  agents: [],
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
};

function json(data: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  };
}

async function mockCoreApp(page: Page, firstRun = false) {
  await page.route('**/events', (route) => route.abort());
  await page.route('**/config/app', (route) => route.fulfill(json({})));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/system/status') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: !firstRun,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configuredChatReady: !firstRun,
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: {
            chat: { ready: !firstRun, source: firstRun ? null : 'fixture' },
          },
          recommendation: firstRun
            ? {
                code: 'unconfigured',
                type: 'connections',
                actionLabel: 'Review connections',
                title: 'No usable AI path is configured yet',
                detail: 'Choose a connection to start using Station.',
              }
            : undefined,
        }),
      });
      return;
    }
    if (path === '/api/projects') {
      await route.fulfill(json(firstRun ? [] : [project]));
      return;
    }
    if (path === `/api/projects/${project.slug}`) {
      await route.fulfill(json(project));
      return;
    }
    if (path === `/api/projects/${project.slug}/layouts`) {
      await route.fulfill(json([]));
      return;
    }
    await route.fulfill(json([]));
  });
}

test.describe('core journey accessibility gate', () => {
  test('first-run setup has no unaccepted serious or critical violations', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('station:onboarding-setup-dismissed');
    });
    await mockCoreApp(page, true);
    await page.goto('/');
    await expect(page.getByTestId('setup-launcher')).toBeVisible();
    await expectNoBlockingAccessibilityViolations(page, 'first-run');
  });

  for (const surface of [
    {
      name: 'shell',
      path: `/projects/${project.slug}`,
      // views/project-page/ProjectPageHeader.tsx:74
      ready: (page: Page) =>
        page.getByRole('heading', { name: project.name, level: 2 }),
    },
    {
      name: 'agents',
      path: '/agents',
      // views/AgentsView.tsx — SplitPaneLayout searchPlaceholder
      ready: (page: Page) => page.getByPlaceholder('Search agents...'),
    },
    {
      name: 'connections',
      path: '/connections',
      // `ConnectionsHub` resolves this entry route to a section. The shared
      // rail is the stable surface that proves that resolution completed,
      // rather than auditing the otherwise-empty resolver frame.
      ready: (page: Page) =>
        page.getByRole('tablist', { name: 'Connection sections' }),
    },
    {
      name: 'guidance',
      path: '/guidance',
      // Guidance is one route with tabbed Skills and Commands content; this
      // tablist is owned by the route, not the shell chrome.
      ready: (page: Page) =>
        page.getByRole('tablist', { name: 'Agent resource type' }),
    },
    {
      name: 'settings',
      path: '/settings',
      // The Station-config section heading; its ⚙ span is aria-hidden, so the
      // accessible name is the bare title.
      ready: (page: Page) =>
        page.getByRole('heading', { name: 'Station configuration', level: 2 }),
    },
  ]) {
    test(`${surface.name} has no unaccepted serious or critical violations`, async ({
      page,
    }) => {
      // The route body mounts inside `.route-transition`, whose `route-enter`
      // entrance starts at `opacity: 0`
      // (`app-shell/route-transition.css:14-33`), and axe multiplies a text
      // node's foreground alpha by every ancestor's accumulated opacity. An
      // audit that lands mid-entrance reports the whole route body at ~1:1 —
      // Settings produced 22 `color-contrast` "violations" for token pairs that
      // measure 4.7:1 to 15.9:1, and the flagged set was exactly the visible
      // subtree of that one wrapper. Reduced motion pins it at `opacity: 1`
      // outright. This removes a measurement artifact; it weakens no assertion
      // and allowlists nothing (`helpers/accessibility-exceptions.ts` stays
      // empty).
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await mockCoreApp(page);
      await page.goto(surface.path);
      await expect(page.locator('.app-toolbar')).toBeVisible();
      // `.app-toolbar` is shell chrome on every route and resolves before the
      // audited route's own chunk mounts, so it proves nothing about the
      // surface axe is about to read. Anchor on something the surface itself
      // renders, so a route that never arrives fails here instead of being
      // audited as an empty frame.
      await expect(surface.ready(page)).toBeVisible({ timeout: 15_000 });
      await expectNoBlockingAccessibilityViolations(page, surface.name);
    });
  }

  test('the gate rejects a seeded critical semantic violation', async ({
    page,
  }) => {
    await page.setContent(
      '<main><button id="seeded-violation"></button></main>',
    );
    const violations = await getBlockingAccessibilityViolations(
      page,
      'negative-control',
    );
    expect(violations.map((violation) => violation.id)).toContain(
      'button-name',
    );
  });

  test('keyboard focus has a visible indicator in the shell', async ({
    page,
  }) => {
    await mockCoreApp(page);
    await page.goto(`/projects/${project.slug}`);
    const trigger = page.getByRole('button', { name: 'New Project' });
    await trigger.focus();
    await expect(trigger).toBeFocused();
    expect(
      await trigger.evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          element.matches(':focus-visible') &&
          ((style.outlineStyle !== 'none' &&
            Number.parseFloat(style.outlineWidth) > 0) ||
            style.boxShadow !== 'none')
        );
      }),
    ).toBe(true);
  });

  test('New Project traps focus, closes with Escape, and restores its trigger', async ({
    page,
  }) => {
    await mockCoreApp(page);
    await page.goto(`/projects/${project.slug}`);
    const trigger = page.getByRole('button', { name: 'New Project' });
    await trigger.focus();
    await trigger.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'New Project' });
    await expect(dialog).toBeVisible();
    await expectNoBlockingAccessibilityViolations(page, 'new-project-modal');

    // Read focus once per keypress rather than polling, and press until a
    // containment boundary is actually reached. Both halves are load-bearing;
    // station#1149 proved this test passed with focus containment removed from
    // `ResponsiveDialogSurface` outright, and measured why:
    //
    //   - `expect.poll` re-samples, so it reports success for any escape a
    //     background re-render happens to undo before the next sample. One
    //     immediate read per press is the shape that observes the state the
    //     user actually lands in. (This was #1149's stated cause and it was
    //     NOT what masked this test — see below. It is still the right shape.)
    //   - The old sequence never left the interior. This dialog opens with
    //     focus on its working-directory input, which is the SECOND control;
    //     the close button precedes it. A single Shift+Tab therefore just
    //     steps from control 2 to control 1 — an ordinary move that stays
    //     inside whether or not a trap exists. Measured with containment
    //     disabled, every read of the old sequence returned "inside".
    //
    // Review of #1173 found the first replacement inherited the same
    // structural flaw it fixed: it assumed two Shift+Tabs reach control 0, and
    // asserted nothing about where focus actually was. Adding ONE ordinary
    // button to the form — with containment removed entirely — made it pass
    // again (trajectory 2 -> 1 -> 0 -> 1, inside at every read, boundary never
    // touched). A press COUNT is not a position.
    //
    // So walk to the boundary by measured index rather than by assumption, and
    // fail loudly if the starting position drifts. `evaluate`, not
    // `toBeFocused()` — that assertion auto-retries, which would smuggle the
    // re-sampling semantics back into the one test that exists to avoid them.
    const focusPosition = () =>
      dialog.evaluate((panel) => {
        const FOCUSABLE =
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';
        const controls = Array.from(
          panel.querySelectorAll<HTMLElement>('*'),
        ).filter((el) => el.matches(FOCUSABLE));
        return {
          index: controls.indexOf(document.activeElement as HTMLElement),
          count: controls.length,
        };
      });

    let position = await focusPosition();
    expect(
      position.index,
      'focus enters the dialog on a real control',
    ).toBeGreaterThanOrEqual(0);

    for (let step = position.index; step > 0; step -= 1) {
      await page.keyboard.press('Shift+Tab');
      position = await focusPosition();
    }
    // The precondition the previous version assumed. Drift now fails here,
    // naming itself, instead of quietly disarming the two assertions below.
    expect(position.index, 'parked on the first control').toBe(0);

    await page.keyboard.press('Shift+Tab');
    position = await focusPosition();
    expect(
      position.index,
      'Shift+Tab off the first control wraps to the last',
    ).toBe(position.count - 1);

    await page.keyboard.press('Tab');
    expect(
      (await focusPosition()).index,
      'Tab off the last control wraps to the first',
    ).toBe(0);

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test('ConfirmModal traps focus, closes with Escape, and restores its trigger', async ({
    page,
  }) => {
    // The assertion shape above, applied to the app's most-used dialog. Until
    // station#1110 not one of ConfirmModal's 22 call sites had focus coverage,
    // which is why `aria-modal="true"` sat on a dialog whose second Tab landed
    // in the app chrome behind it and whose close stranded focus on <body>.
    // Settings' "Reset to Defaults" is a plain, hermetic instance of it.
    await mockCoreApp(page);
    await page.goto('/settings');
    await expect(page.locator('.app-toolbar')).toBeVisible();

    const trigger = page.getByRole('button', { name: 'Reset to Defaults' });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    await trigger.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Reset to Defaults' });
    await expect(dialog).toBeVisible();
    // Armed by station#1125, which #1110 filed rather than buried: this audit
    // used to report `.button--danger` at 2.78:1 (#ffffff on dark's
    // --error-text, #ff6b6b) and so was left out with a pointer to the token
    // decision. `--error-fill` settles it, and running the audit here is what
    // pins the only danger-button surface any audited spec renders.
    await expectNoBlockingAccessibilityViolations(page, 'confirm-modal-danger');
    // ...in BOTH themes. Review of #1187 pointed out `--error-fill` is declared
    // inside the block that opens `:root, [data-theme="dark"]`, and the light
    // block deliberately omits it. It resolves correctly today — but if that
    // selector is ever split, or a light override of the error family is added,
    // `var(--error-fill)` becomes undefined in light, the whole `background`
    // declaration is invalid at computed-value time, and you get white text on
    // a transparent fill. The audit above runs the default theme only, so
    // nothing would have caught it. This is what makes "both themes" a claim
    // the suite enforces rather than one the PR body asserts.
    // `exact` matters here, and only started to. Every `Dialog` now renders a
    // close button whose accessible name is `Close ${title}`
    // (`ConfirmModal.tsx:90` → `Dialog.tsx:127`), so inside the "Reset to
    // Defaults" dialog the substring match that `getByRole` does by default
    // resolves BOTH `Close Reset to Defaults` and the danger button, and
    // `contrastRatio` fails on strict mode rather than measuring anything.
    // Anchoring on the exact confirm label keeps this pointed at the button
    // whose contrast station#1246 is about.
    const dangerButton = dialog.getByRole('button', {
      name: 'Reset',
      exact: true,
    });
    // `.button` animates `color` and `background-color` over `--motion-base`,
    // so a reading taken immediately after the `data-theme` flip returns the
    // PREVIOUS theme's button. That made this loop inert for exactly the
    // regression the comment above describes: injecting a light-only
    // `--error-fill: initial` — white text on a transparent fill, a measured
    // 1.0:1 — left this test green, because the light iteration was still
    // measuring the dark button. Removing the transition makes each iteration
    // measure the theme it names.
    await page.addStyleTag({
      content: '*, *::before, *::after { transition: none !important; }',
    });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      expect(
        await contrastRatio(dangerButton),
        `danger button contrast in ${theme} theme`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    // Read focus once per keypress rather than polling. `expect.poll` is the
    // wrong instrument here: the pre-fix component re-ran `firstBtn.focus()` on
    // every render (its effect depended on an inline `onCancel`), so a poll
    // reports "focus is contained" for an escape that a background re-render
    // happened to undo. Measured against origin/main, polling passed every one
    // of these presses; a single immediate read fails on the first.
    const focusIsInDialog = () =>
      dialog.evaluate((node) => node.contains(document.activeElement));
    expect(await focusIsInDialog(), 'focus enters the dialog').toBe(true);

    // Measured on origin/main: Shift+Tab from the control focused on open lands
    // on the chat dock behind the dialog, and the third Tab lands on <body>.
    await page.keyboard.press('Shift+Tab');
    expect(await focusIsInDialog(), 'Shift+Tab stays inside').toBe(true);
    for (let press = 1; press <= 3; press += 1) {
      await page.keyboard.press('Tab');
      expect(await focusIsInDialog(), `Tab ${press} stays inside`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test('mobile browser Back dismisses New Project before its parent project', async ({
    page,
  }) => {
    await mockCoreApp(page);
    await page.goto(`/projects/${project.slug}`);
    await page.getByRole('button', { name: 'New Project' }).click();
    await page.setViewportSize({ width: 390, height: 844 });

    const dialog = page.getByRole('dialog', { name: 'New Project' });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/new$/);

    await page.goBack();

    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}$`));
  });

  test('New Project primary action meets normal-text contrast in light and dark themes', async ({
    page,
  }) => {
    await mockCoreApp(page);
    await page.goto(`/projects/${project.slug}`);
    await page.getByRole('button', { name: 'New Project' }).click();
    const name = page.getByPlaceholder('My Project');
    const close = page.getByRole('button', { name: 'Close new project' });
    await expect
      .poll(async () => (await name.boundingBox())?.width ?? 0)
      .toBeGreaterThan(300);
    await expect
      .poll(async () => (await close.boundingBox())?.width ?? 0)
      .toBe(44);
    await name.fill('Contrast proof');
    const create = page.getByRole('button', { name: 'Create', exact: true });

    // `.editor-btn` animates `color` and `background-color`, so a measurement
    // taken right after the `data-theme` flip reads the PREVIOUS theme's
    // button — and because `expect.poll` returns on its first *passing* read,
    // the light iteration settled for the dark button's ratio and never looked
    // again. Proven inert: injecting a light-theme-only regression that drops
    // the real ratio to 1.0 left this test green. Killing transitions makes
    // each iteration measure the theme it names.
    await page.addStyleTag({
      content: '*, *::before, *::after { transition: none !important; }',
    });

    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      await expect
        .poll(() => contrastRatio(create))
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  test('the .form-group placeholder token meets normal-text contrast in both themes', async ({
    page,
  }) => {
    // Placeholders are content, not inactive chrome, so 1.4.3 applies.
    //
    // This asserts a *token contract* against the real stylesheet, and the
    // markup is constructed on purpose: `--text-subtle` is consumed only by
    // `.form-group input::placeholder`, and no `.form-group` input is reachable
    // from this spec's flows — the New Project field is a bare input showing the
    // browser default. A journey-shaped version of this test measured that
    // default and passed against the exact value it was written to catch.
    //
    // It exists because #1062 nearly shipped a light `--text-subtle` of #bdbdbd
    // (1.55:1 on the real input surface). The token had been shadowed by a later
    // `:root` block since it was written, so its declared value had never once
    // rendered and had never been looked at.
    await mockCoreApp(page);
    await page.goto(`/projects/${project.slug}`);
    await expect(page.locator('.app-toolbar')).toBeVisible();

    await page.evaluate(() => {
      const group = document.createElement('div');
      group.className = 'form-group';
      const input = document.createElement('input');
      input.setAttribute('data-testid', 'placeholder-contrast-probe');
      input.placeholder = 'contrast probe';
      group.appendChild(input);
      document.body.appendChild(group);
    });
    const probe = page.getByTestId('placeholder-contrast-probe');

    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      await expect
        .poll(() => contrastRatio(probe, { pseudo: '::placeholder' }), {
          message: `.form-group placeholder contrast in ${theme} theme`,
        })
        .toBeGreaterThanOrEqual(4.5);
    }
  });
});
