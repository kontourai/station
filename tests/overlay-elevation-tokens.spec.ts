import { expect, test } from '@playwright/test';

/**
 * `--radius-overlay` and `--elevation-overlay` must resolve on the document
 * the product actually serves.
 *
 * #1637: both were declared inside `[data-theme="light"]`, under a comment
 * saying "`--k-elevation-overlay` carries its own light/dark variants, so no
 * per-theme override is needed here". That sentence was true of the *value*
 * and false of the *placement*. `main.tsx` stamps `data-theme` on the root
 * before first render and it is `dark` by default, so the light block matched
 * nothing, no other block declared these names, and `var()` with no fallback
 * is invalid at computed-value time — the declarations that read them were
 * dropped entirely. Measured live on a `--temp-home` instance before the fix,
 * on the real `data-theme="dark"` document: `--radius-overlay` and
 * `--elevation-overlay` both resolved to `""` while `--k-radius-overlay` sat
 * right there at `10px`, and the real command palette, the real
 * "Report a problem" `Dialog`, and the real ACP add dialog each computed
 * `border-radius: 0px` / `box-shadow: none`. Nobody noticed, because a square
 * dialog with no lift reads as a design choice.
 *
 * What this pins, and why the shape can actually fail rather than retiring
 * the question it names:
 *
 *  - **`data-theme="dark"` is the load-bearing case**, because that is the
 *    attribute the shipped app sets. An earlier draft measured the
 *    *unattributed* document instead, which is a state the product only
 *    occupies for the frame before `main.tsx` runs — a real defect could hide
 *    behind a `:root` declaration that the product never reaches. The
 *    unattributed document is kept as secondary coverage of that frame, and
 *    `light` is checked so the fix cannot have pinned one theme's value.
 *  - Every read **sets the attribute and measures inside the same
 *    `page.evaluate`**. Splitting them across round-trips lets a React commit
 *    or the settings hydration re-stamp `data-theme` in between, which would
 *    red intermittently while the product is fine — and would silently let a
 *    probe measure a themed document under a name claiming otherwise.
 *  - Each alias is compared against `--k-*` **as resolved in the same
 *    document**, so Console Kit is free to retune 10px without touching this
 *    spec, while an alias that resolves to nothing still fails. The
 *    `not ''` / `not 0px` / `not none` assertions stop that comparison from
 *    passing vacuously if the kit token itself ever went empty or zero
 *    (`.theme-console` sets `--k-radius-overlay: 0`).
 *  - It mounts the **real shipped rules** and reads their computed
 *    `border-radius` / `box-shadow`, so it fails on any route from
 *    declaration to paint, not just on the token name. Each probe carries an
 *    anti-inert guard: a renamed or deleted class leaves a transparent div,
 *    and a transparent div reports exactly the `0px` / `none` the defect did.
 *
 * Scope: the three entry-stylesheet consumers with live surfaces.
 * `.command-palette` (`CommandPalette.css`) and `.acp-add-dialog`
 * (`ACPConnections.css`) read the same two tokens from their own chunk
 * sheets; the token assertions below are what covers them, since the failure
 * is in the custom property and not in any one rule. `index.css`'s `.toast`
 * rule reads `--elevation-overlay` as well but is **not** probed: nothing
 * renders `class="toast"` — the notification surface is `.toast-card`, which
 * sets its own literal radius and shadow — so a probe of it would assert
 * against a rule no user can reach.
 */

/** The entry-stylesheet rules that read either token AND have a live surface. */
const ENTRY_SHEET_CONSUMERS = [
  { className: 'station-dialog', radius: true },
  { className: 'modal-dialog', radius: true },
  { className: 'agent-selector__menu', radius: true },
] as const;

/**
 * `dark` first and by itself in the primary test: it is what `main.tsx`
 * stamps, so it is the state the defect actually shipped in. `null` means
 * "remove the attribute" — the pre-script frame.
 */
const THEME_STATES = ['dark', 'light', null] as const;

async function mockReady(page: import('@playwright/test').Page) {
  await page.route('**/events', (route) => route.abort());
  await page.route('**/config/app', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: {} }),
    }),
  );
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === '/api/system/status'
        ? {
            ready: true,
            acp: { connected: false, connections: [] },
            clis: {},
            prerequisites: [],
            providers: {
              configuredChatReady: true,
              configured: [],
              detected: { ollama: false, bedrock: false },
            },
            capabilities: { chat: { ready: true, source: 'fixture' } },
          }
        : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: body }),
    });
  });
}

/**
 * Apply `theme` and read the four tokens in ONE round-trip, so nothing can
 * re-stamp `data-theme` between the write and the read.
 */
async function resolveTokens(
  page: import('@playwright/test').Page,
  theme: 'dark' | 'light' | null,
) {
  return page.evaluate((value) => {
    if (value === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', value);
    const style = getComputedStyle(document.documentElement);
    return {
      // Read back rather than assume: this is the document the numbers below
      // were measured on, and the assertions name it.
      dataTheme: document.documentElement.getAttribute('data-theme'),
      radius: style.getPropertyValue('--radius-overlay').trim(),
      kitRadius: style.getPropertyValue('--k-radius-overlay').trim(),
      elevation: style.getPropertyValue('--elevation-overlay').trim(),
      kitElevation: style.getPropertyValue('--k-elevation-overlay').trim(),
    };
  }, theme);
}

/**
 * Mount `className` inside a host that paints `--bg-primary` and sets no
 * radius or shadow of its own, apply `theme`, and measure — all in one
 * round-trip, for the same reason as {@link resolveTokens}.
 */
async function measureConsumer(
  page: import('@playwright/test').Page,
  className: string,
  theme: 'dark' | 'light' | null,
) {
  return page.evaluate(
    ({ cls, value }) => {
      if (value === null)
        document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', value);

      document.getElementById('overlay-probe-host')?.remove();
      const host = document.createElement('div');
      host.id = 'overlay-probe-host';
      host.style.cssText =
        'position:fixed;top:0;left:0;z-index:2147483647;padding:24px;background:var(--bg-primary)';
      const control = document.createElement('div');
      control.textContent = 'Control';
      const probe = document.createElement('div');
      probe.className = cls;
      probe.style.cssText = 'width:320px;min-height:120px;position:static';
      probe.textContent = 'Overlay surface';
      host.append(control, probe);
      document.body.appendChild(host);

      const probeStyle = getComputedStyle(probe);
      return {
        dataTheme: document.documentElement.getAttribute('data-theme'),
        radius: probeStyle.borderRadius,
        shadow: probeStyle.boxShadow,
        background: probeStyle.backgroundColor,
        controlBackground: getComputedStyle(control).backgroundColor,
        expectedRadius: getComputedStyle(document.documentElement)
          .getPropertyValue('--k-radius-overlay')
          .trim(),
      };
    },
    { cls: className, value: theme },
  );
}

test.describe('overlay elevation and radius tokens (#1637)', () => {
  test.beforeEach(async ({ page }) => {
    await mockReady(page);
    await page.goto('/');
    await expect(page.locator('#root')).toBeAttached();
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() =>
      document.getElementById('overlay-probe-host')?.remove(),
    );
  });

  test('the shipped app stamps data-theme before first render', async ({
    page,
  }) => {
    // The premise the rest of this file rests on, and the exact claim an
    // earlier version of the fix's own comment got wrong: the product does not
    // serve an unattributed document past its first frame. If this ever stops
    // being true, the "dark is load-bearing" framing below needs revisiting
    // rather than silently testing a state nobody occupies.
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.getAttribute('data-theme'),
        ),
      )
      .toBe('dark');
  });

  test('both aliases resolve on the real data-theme="dark" document', async ({
    page,
  }) => {
    const resolved = await resolveTokens(page, 'dark');
    expect(resolved.dataTheme).toBe('dark');

    // Not vacuous: if the kit token itself were empty or zero, comparing the
    // alias to it would pass while nothing rendered.
    expect(resolved.kitRadius).not.toBe('');
    expect(resolved.kitRadius).not.toBe('0px');
    expect(resolved.kitElevation).not.toBe('');
    expect(resolved.kitElevation).not.toBe('none');

    expect(
      resolved.radius,
      '--radius-overlay resolved to nothing on the theme the app actually stamps, so every overlay that reads it renders square. It has been removed from the `:root, [data-theme="dark"]` block again (#1637).',
    ).toBe(resolved.kitRadius);
    expect(
      resolved.elevation,
      '--elevation-overlay resolved to nothing on the theme the app actually stamps, so every overlay that reads it renders flat. It has been removed from the `:root, [data-theme="dark"]` block again (#1637).',
    ).toBe(resolved.kitElevation);
  });

  test('both aliases resolve under light and on an unattributed document', async ({
    page,
  }) => {
    for (const theme of THEME_STATES) {
      const resolved = await resolveTokens(page, theme);
      const label = theme ?? 'no data-theme attribute (pre-script frame)';
      expect(resolved.dataTheme, `${label}: document state`).toBe(theme);
      expect(resolved.kitElevation, `${label}: kit elevation`).not.toBe('');
      expect(resolved.radius, `--radius-overlay under ${label}`).toBe(
        resolved.kitRadius,
      );
      expect(resolved.elevation, `--elevation-overlay under ${label}`).toBe(
        resolved.kitElevation,
      );
    }

    // The one declaration really is an indirection resolving per theme, not a
    // single pinned value: Console Kit overrides --k-elevation-overlay under
    // [data-theme="light"], and that override has to reach the alias.
    const dark = await resolveTokens(page, 'dark');
    const light = await resolveTokens(page, 'light');
    expect(dark.elevation).not.toBe(light.elevation);
  });

  for (const consumer of ENTRY_SHEET_CONSUMERS) {
    test(`.${consumer.className} is lifted and rounded on data-theme="dark"`, async ({
      page,
    }) => {
      const measured = await measureConsumer(page, consumer.className, 'dark');

      // Names what was measured, so this cannot pass while reporting on a
      // document other than the one the title claims.
      expect(measured.dataTheme).toBe('dark');

      // Anti-inert guard: the rule must still be painting this element. A
      // renamed class leaves a transparent div, which reports the same `0px`
      // and `none` the defect produced.
      expect(
        measured.background,
        `.${consumer.className} must paint its own surface — it is inheriting the host's, so the rule no longer matches and this probe proves nothing`,
      ).not.toBe(measured.controlBackground);

      expect(
        measured.shadow,
        `.${consumer.className} has no elevation on data-theme="dark" (#1637)`,
      ).not.toBe('none');
      if (consumer.radius) {
        expect(
          measured.radius,
          `.${consumer.className} renders square on data-theme="dark" (#1637)`,
        ).toBe(measured.expectedRadius);
      }
    });
  }
});
