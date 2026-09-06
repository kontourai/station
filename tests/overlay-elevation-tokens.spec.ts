import { expect, test } from '@playwright/test';

/**
 * `--radius-overlay` and `--elevation-overlay` must resolve on the **default**
 * document — the one with no `data-theme` attribute at all.
 *
 * #1637: both were declared inside `[data-theme="light"]`, under a comment
 * that said "`--k-elevation-overlay` carries its own light/dark variants, so
 * no per-theme override is needed here". That sentence was true of the
 * *value* and false of the *placement*. Dark is the default and ships no
 * `data-theme`, so on the theme almost every user runs, both names were
 * undefined; `var()` with no fallback is invalid at computed-value time, so
 * the declarations that read them were dropped entirely. Measured live on a
 * `--temp-home` instance before the fix: `--radius-overlay` and
 * `--elevation-overlay` both resolved to `""` while `--k-radius-overlay` sat
 * right there at `10px`, and the real command palette, the real
 * "Report a problem" `Dialog`, and the real ACP add dialog each computed
 * `border-radius: 0px` / `box-shadow: none`. In light they were 10px and a
 * three-layer shadow. Nobody noticed, because a square dialog with no lift
 * reads as a design choice.
 *
 * Why the shape below can actually fail, rather than retiring the question it
 * names:
 *
 *  - It **removes** `data-theme` before measuring, and asserts it is absent.
 *    Setting `data-theme="dark"` instead would pass with the tokens back
 *    inside the light block only if a dark declaration existed — but the
 *    defect's whole point is the *unattributed* document, which is what the
 *    shell serves. Asserting the attribute is gone stops a future edit that
 *    stamps one from making this vacuous.
 *  - It compares `--radius-overlay` against `--k-radius-overlay` **as
 *    resolved in the same document**, so the kit is free to retune 10px
 *    without touching this spec, while an alias that resolves to nothing
 *    still fails. The `not 0px` / `not none` assertions stop the comparison
 *    from passing vacuously if the kit token itself ever went empty or zero
 *    (`.theme-console` sets `--k-radius-overlay: 0`).
 *  - It mounts the **real shipped rules** and reads their computed
 *    `border-radius` / `box-shadow`, so this fails on any route from
 *    declaration to paint — not just on the token name. Each probe carries an
 *    anti-inert guard: a renamed or deleted class leaves a transparent div,
 *    and a transparent div reports exactly the `0px` / `none` the defect did.
 *
 * Scope: the four consumers that live in the entry stylesheet.
 * `.command-palette` (`CommandPalette.css`) and `.acp-add-dialog`
 * (`ACPConnections.css`) read the same two tokens from their own chunk
 * sheets; the token assertions below are what covers them, since the failure
 * is in the custom property and not in any one rule.
 */

/** Every rule in `index.css` that reads either token. */
const ENTRY_SHEET_CONSUMERS = [
  { className: 'station-dialog', radius: true },
  { className: 'modal-dialog', radius: true },
  { className: 'agent-selector__menu', radius: true },
  // `.toast` sets its own literal radius and takes only the elevation.
  { className: 'toast', radius: false },
] as const;

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
 * Mount `className` inside a host that paints `--bg-primary` and sets no
 * radius or shadow of its own, so anything the probe reports came from the
 * rule under test.
 */
async function mountProbe(
  page: import('@playwright/test').Page,
  className: string,
) {
  await page.evaluate((cls) => {
    document.getElementById('overlay-probe-host')?.remove();
    const host = document.createElement('div');
    host.id = 'overlay-probe-host';
    host.style.cssText =
      'position:fixed;top:0;left:0;z-index:2147483647;padding:24px;background:var(--bg-primary)';
    host.innerHTML = '<div data-testid="overlay-probe-control">Control</div>';
    const probe = document.createElement('div');
    probe.setAttribute('data-testid', 'overlay-probe');
    probe.className = cls;
    // `position: static` so `.toast`'s own `position: fixed` cannot move the
    // probe out of the host and change what it composites against.
    probe.style.cssText = 'width:320px;min-height:120px;position:static';
    probe.textContent = 'Overlay surface';
    host.appendChild(probe);
    document.body.appendChild(host);
  }, className);
  return {
    probe: page.getByTestId('overlay-probe'),
    control: page.getByTestId('overlay-probe-control'),
  };
}

test.describe('overlay elevation and radius tokens (#1637)', () => {
  test.beforeEach(async ({ page }) => {
    await mockReady(page);
    await page.goto('/');
    await expect(page.locator('#root')).toBeAttached();
    await page.evaluate(() => {
      // The default document, which is what the shell serves and what the
      // light-scoped declaration left unstyled.
      document.documentElement.removeAttribute('data-theme');
    });
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() =>
      document.getElementById('overlay-probe-host')?.remove(),
    );
  });

  test('both aliases resolve to their kit token with no data-theme set', async ({
    page,
  }) => {
    const resolved = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        dataTheme: document.documentElement.getAttribute('data-theme'),
        radius: style.getPropertyValue('--radius-overlay').trim(),
        kitRadius: style.getPropertyValue('--k-radius-overlay').trim(),
        elevation: style.getPropertyValue('--elevation-overlay').trim(),
        kitElevation: style.getPropertyValue('--k-elevation-overlay').trim(),
      };
    });

    // Guards the premise of every assertion below: this must be the
    // unattributed document, not a themed one.
    expect(
      resolved.dataTheme,
      'this spec measures the document with no data-theme attribute — the default the shell serves',
    ).toBeNull();

    // Not vacuous: if the kit token itself were empty or zero, comparing the
    // alias to it would pass while nothing rendered.
    expect(resolved.kitRadius).not.toBe('');
    expect(resolved.kitRadius).not.toBe('0px');
    expect(resolved.kitElevation).not.toBe('');
    expect(resolved.kitElevation).not.toBe('none');

    expect(
      resolved.radius,
      '--radius-overlay resolved to nothing on the default theme, so every overlay that reads it renders square. It is declared inside a theme-scoped block again (#1637).',
    ).toBe(resolved.kitRadius);
    expect(
      resolved.elevation,
      '--elevation-overlay resolved to nothing on the default theme, so every overlay that reads it renders flat. It is declared inside a theme-scoped block again (#1637).',
    ).toBe(resolved.kitElevation);
  });

  test('the aliases still resolve under both explicit themes', async ({
    page,
  }) => {
    for (const theme of ['dark', 'light'] as const) {
      const resolved = await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
        const style = getComputedStyle(document.documentElement);
        return {
          radius: style.getPropertyValue('--radius-overlay').trim(),
          kitRadius: style.getPropertyValue('--k-radius-overlay').trim(),
          elevation: style.getPropertyValue('--elevation-overlay').trim(),
          kitElevation: style.getPropertyValue('--k-elevation-overlay').trim(),
        };
      }, theme);
      expect(resolved.kitElevation, `${theme}: kit elevation`).not.toBe('');
      expect(resolved.radius, `--radius-overlay in ${theme}`).toBe(
        resolved.kitRadius,
      );
      expect(resolved.elevation, `--elevation-overlay in ${theme}`).toBe(
        resolved.kitElevation,
      );
    }
    // The light variant is a genuinely different shadow, so the one
    // declaration really is resolving per theme rather than pinning one value.
    const perTheme = await page.evaluate(() => {
      const read = (value: string) => {
        document.documentElement.setAttribute('data-theme', value);
        return getComputedStyle(document.documentElement)
          .getPropertyValue('--elevation-overlay')
          .trim();
      };
      return { dark: read('dark'), light: read('light') };
    });
    expect(perTheme.dark).not.toBe(perTheme.light);
  });

  for (const consumer of ENTRY_SHEET_CONSUMERS) {
    test(`.${consumer.className} is lifted and rounded on the default theme`, async ({
      page,
    }) => {
      const { probe, control } = await mountProbe(page, consumer.className);

      // Anti-inert guard: the rule must still be painting this element. A
      // renamed class leaves a transparent div, which reports the same `0px`
      // and `none` the defect produced.
      const [probeBackground, controlBackground] = await Promise.all([
        probe.evaluate((el) => getComputedStyle(el).backgroundColor),
        control.evaluate((el) => getComputedStyle(el).backgroundColor),
      ]);
      expect(
        probeBackground,
        `.${consumer.className} must paint its own surface — it is inheriting the host's, so the rule no longer matches and this probe proves nothing`,
      ).not.toBe(controlBackground);

      const measured = await probe.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          radius: style.borderRadius,
          shadow: style.boxShadow,
          expectedRadius: getComputedStyle(document.documentElement)
            .getPropertyValue('--k-radius-overlay')
            .trim(),
        };
      });

      expect(
        measured.shadow,
        `.${consumer.className} has no elevation on the default theme (#1637)`,
      ).not.toBe('none');
      if (consumer.radius) {
        expect(
          measured.radius,
          `.${consumer.className} renders square on the default theme (#1637)`,
        ).toBe(measured.expectedRadius);
      }
    });
  }
});
