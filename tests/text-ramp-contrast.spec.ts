import { expect, test } from '@playwright/test';
import { contrastRatio } from './helpers/color-contrast';

/**
 * The four-rung text ramp — primary / secondary / tertiary / muted — and the
 * two shared chrome rules that carry it, measured on the surfaces they
 * actually land on.
 *
 * `status-token-contrast.spec.ts` owns the *semantic* families (error, danger,
 * success). Nothing owned the *neutral* ramp, and station#3140 is what that
 * gap produced: `.engine-chip__pill` shipped `--text-muted` on `--bg-tertiary`
 * at 10px and measured 4.38:1 dark / 4.33:1 light, under 1.4.3's 4.5:1 in both
 * themes. It is the label that names the engine — "Claude Code", "Codex",
 * "Muse Code" — in agent lists, session tabs, hub cards and chat attribution,
 * so it was simultaneously one of the most repeated strings in the product and
 * one of the least legible. Nothing failed, because nothing was looking.
 *
 * Two properties of this spec are deliberate and worth keeping:
 *
 * **It measures rules, not tokens.** A token matrix would have passed #3140
 * happily: `--text-muted` clears 4.5:1 on `--bg-primary` (5.16:1 dark). The
 * defect only exists at the pairing — that token on *that* fill — so the probe
 * mounts the real shipped class and lets the cascade choose the colour.
 *
 * **Every probe carries an anti-inert guard.** A renamed or deleted class
 * leaves an unstyled element inheriting the host's `--text-primary`, which
 * measures beautifully and proves nothing. This repo has shipped that failure
 * five times, so each probe asserts it is painting a colour of its own before
 * it asserts a ratio.
 *
 * ## What the `.button--link` case pins, and why it is not a fix
 *
 * station#3140 also reported `.button--link` at 3.25:1 in light. It does not
 * reproduce: that number belongs to Console Kit's `.theme-console` palette
 * (light `--k-brand` `#6c9400`), and Station deliberately applies no `.theme-*`
 * class — it is the host, not one product (`docs/strategy/kontour-integration-
 * surface.md`). Against the palette Station actually resolves, light
 * `--accent-primary` is `#0e7c64` and the rule measures 4.67:1 on the page and
 * 5.14:1 on panels and modals. It passes, so it was not repainted.
 *
 * It is pinned here anyway, because 4.67:1 is a 0.17 margin held by a vendor
 * token this repo does not own. If `--k-brand` moves — or if a `.theme-*`
 * class is ever applied to the shell — the link colour fails silently and
 * everywhere at once. That is precisely the change this spec should catch, and
 * catching it is worth more than the repaint would have been.
 */

const THEMES = ['light', 'dark'] as const;

/**
 * The opaque surfaces a text rule can land on. `--bg-elevated`, `--bg-hover`,
 * `--bg-active`, `--bg-selected` and `--bg-highlight` are the tinted and
 * interactive-state surfaces; they are the floor of the ramp and are included
 * only where the rule under test genuinely renders on one, so the spec cannot
 * be satisfied by surfaces the rule never meets or failed by ones it never
 * touches.
 */
const PANEL_BACKDROPS = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-modal',
];

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
 * Mount `className` inside a backdrop painted with `backdropToken`, beside an
 * unclassed sibling that inherits the host colour. The sibling is the control
 * the anti-inert guard compares against.
 */
async function mountProbe(
  page: import('@playwright/test').Page,
  className: string,
  backdropToken: string,
  text: string,
) {
  await page.evaluate(
    ({ className, backdropToken, text }) => {
      document.getElementById('ramp-probe-host')?.remove();
      const host = document.createElement('div');
      host.id = 'ramp-probe-host';
      host.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;padding:24px;background:var(${backdropToken});color:var(--text-primary)`;
      host.innerHTML = '<span data-testid="ramp-probe-control">Control</span>';
      const probe = document.createElement('span');
      probe.setAttribute('data-testid', 'ramp-probe');
      probe.className = className;
      probe.textContent = text;
      host.appendChild(probe);
      document.body.appendChild(host);
    },
    { className, backdropToken, text },
  );
  return {
    probe: page.getByTestId('ramp-probe'),
    control: page.getByTestId('ramp-probe-control'),
  };
}

test.describe('neutral text ramp contrast', () => {
  test.beforeEach(async ({ page }) => {
    await mockReady(page);
    await page.goto('/');
    await expect(page.locator('#root')).toBeAttached();
    // Colour and background transitions mean a reading taken on the frame
    // after a theme flip reports the previous theme's surface. Same instrument
    // as status-token-contrast.spec.ts.
    await page.addStyleTag({
      content: '*, *::before, *::after { transition: none !important; }',
    });
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() =>
      document.getElementById('ramp-probe-host')?.remove(),
    );
  });

  /**
   * station#3140's actual defect. The chip paints its own opaque
   * `--bg-tertiary`, so its ratio is fixed by the token pair alone and does not
   * vary with the host — which is why every backdrop below must report the
   * same number, and why a regression here is a regression everywhere the chip
   * renders at once.
   *
   * The 10px size is the point. `--text-xs` is nowhere near 1.4.3's large-text
   * threshold (18.66px, or 14px bold), so 4.5:1 is the requirement and
   * `--text-muted` missed it in both themes.
   */
  test('.engine-chip__pill meets normal-text contrast on its own fill, both themes', async ({
    page,
  }) => {
    for (const theme of THEMES) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      for (const backdrop of [...PANEL_BACKDROPS, '--bg-highlight']) {
        const { probe, control } = await mountProbe(
          page,
          'engine-chip__pill',
          backdrop,
          'Claude Code',
        );
        const [probeColor, controlColor, fontSize] = await Promise.all([
          probe.evaluate((el) => getComputedStyle(el).color),
          control.evaluate((el) => getComputedStyle(el).color),
          probe.evaluate((el) => getComputedStyle(el).fontSize),
        ]);
        expect(
          probeColor,
          '.engine-chip__pill must set its own colour — got the inherited one, so the rule no longer matches and this measurement is of body copy',
        ).not.toBe(controlColor);
        // Pinned so the assertion below cannot be satisfied by growing the
        // text into the large-text exemption instead of fixing the colour.
        expect(
          Number.parseFloat(fontSize),
          '.engine-chip__pill is normal text under WCAG 1.4.3',
        ).toBeLessThan(18.66);

        expect(
          await contrastRatio(probe),
          `.engine-chip__pill on ${backdrop} in ${theme} theme (WCAG 1.4.3, normal text at ${fontSize})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  /**
   * The chip's fill is opaque, so the host must not move the number. If this
   * ever disagrees, the chip has started inheriting a translucent surface and
   * the single measurement above stops covering every place it renders.
   */
  test('.engine-chip__pill is host-independent, so one measurement covers every surface it renders on', async ({
    page,
  }) => {
    for (const theme of THEMES) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      const ratios: number[] = [];
      for (const backdrop of [...PANEL_BACKDROPS, '--bg-highlight']) {
        const { probe } = await mountProbe(
          page,
          'engine-chip__pill',
          backdrop,
          'Claude Code',
        );
        ratios.push(Number((await contrastRatio(probe)).toFixed(2)));
      }
      expect(
        new Set(ratios).size,
        `.engine-chip__pill measured ${ratios.join('/')} across backdrops in ${theme} theme — its fill is no longer opaque, so the surfaces it renders on now need measuring individually`,
      ).toBe(1);
    }
  });

  /**
   * `.button--link` is every link-styled action in the app: "Edit agent",
   * "Enable", the picker's remedy links, the settings sections' inline
   * actions, the notifications page's filter reset. It paints no background of
   * its own, so the surface behind it is the measurement — see the docblock
   * above for why this pins a passing rule rather than fixing a failing one.
   *
   * The backdrops are the panel and page surfaces these buttons demonstrably
   * render on, including the new-chat picker's hovered/selected agent row,
   * which resolves to `--bg-secondary`.
   */
  test('.button--link meets normal-text contrast on the surfaces it renders on, both themes', async ({
    page,
  }) => {
    for (const theme of THEMES) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      for (const backdrop of PANEL_BACKDROPS) {
        const { probe, control } = await mountProbe(
          page,
          'button button--link',
          backdrop,
          'Edit agent',
        );
        const [probeColor, controlColor] = await Promise.all([
          probe.evaluate((el) => getComputedStyle(el).color),
          control.evaluate((el) => getComputedStyle(el).color),
        ]);
        expect(
          probeColor,
          '.button--link must set its own colour — got the inherited one, so the rule no longer matches',
        ).not.toBe(controlColor);

        expect(
          await contrastRatio(probe),
          `.button--link on ${backdrop} in ${theme} theme (WCAG 1.4.3, normal text)`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  /**
   * The ramp itself, one rung at a time, on the surfaces the ramp is used on.
   *
   * `--text-secondary` was a byte-identical alias of `--text-primary` in both
   * theme blocks until station#3146 — the middle rung did not exist, and ~340
   * call sites saying "this text is subordinate" rendered at full strength.
   * `--text-tertiary` is now the rung the engine chip and the picker's
   * description line both sit on. Neither had a contrast floor anywhere.
   *
   * `--text-muted` is deliberately absent. It is the one rung that does NOT
   * clear 4.5:1 on the tinted surfaces (2.99:1 light on `--bg-highlight`), and
   * asserting it here would either fail honestly on surfaces it should not be
   * used on, or force the assertion down to a threshold that certifies
   * nothing. Its correct use is non-text and inactive chrome; #3140 is the
   * record of what happens when it carries content instead.
   */
  for (const token of [
    '--text-primary',
    '--text-secondary',
    '--text-tertiary',
  ]) {
    test(`${token} is legible as text on every panel surface, both themes`, async ({
      page,
    }) => {
      for (const theme of THEMES) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        for (const backdrop of PANEL_BACKDROPS) {
          await page.evaluate(
            ({ token, backdrop }) => {
              document.getElementById('ramp-probe-host')?.remove();
              const host = document.createElement('div');
              host.id = 'ramp-probe-host';
              host.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;padding:24px;background:var(${backdrop});color:magenta`;
              const probe = document.createElement('span');
              probe.setAttribute('data-testid', 'ramp-probe');
              probe.style.color = `var(${token})`;
              probe.textContent = 'Sample';
              host.appendChild(probe);
              document.body.appendChild(host);
            },
            { token, backdrop },
          );
          const probe = page.getByTestId('ramp-probe');
          // An undefined token leaves `color` inheriting the host's magenta;
          // the ratio would still be plausible and entirely meaningless.
          expect(
            await probe.evaluate((el) => getComputedStyle(el).color),
            `${token} must resolve to a colour of its own in ${theme} theme`,
          ).not.toBe('rgb(255, 0, 255)');

          expect(
            await contrastRatio(probe),
            `${token} on ${backdrop} in ${theme} theme (WCAG 1.4.3, normal text)`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  /**
   * station#3050's contrast half. Five stylesheets referenced `--color-warning`,
   * which was defined in no theme root, so each rendered a hardcoded amber —
   * `#f59e0b` is ~2.2:1 on a light surface, and `.settings__field-warning`
   * renders it at 11px. They now reference `--warning-text`, which is themed
   * and measured; this asserts the token they moved to actually carries text
   * on the surfaces those rules land on.
   *
   * The "is this name real?" half is gated at source level instead, by
   * `src-ui/src/__tests__/undefined-css-custom-properties.test.ts` — the same
   * division of labour status-token-contrast records for `ToolCallDisplay`.
   * It has to be: a foreground whose token does not resolve inherits body copy
   * and measures beautifully, so no ratio assertion can see it.
   */
  for (const token of ['--warning-text', '--success-text']) {
    test(`${token} carries text on every panel surface, both themes`, async ({
      page,
    }) => {
      for (const theme of THEMES) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        for (const backdrop of PANEL_BACKDROPS) {
          await page.evaluate(
            ({ token, backdrop }) => {
              document.getElementById('ramp-probe-host')?.remove();
              const host = document.createElement('div');
              host.id = 'ramp-probe-host';
              host.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;padding:24px;background:var(${backdrop});color:magenta`;
              const probe = document.createElement('span');
              probe.setAttribute('data-testid', 'ramp-probe');
              probe.style.color = `var(${token})`;
              probe.textContent = 'Sample';
              host.appendChild(probe);
              document.body.appendChild(host);
            },
            { token, backdrop },
          );
          const probe = page.getByTestId('ramp-probe');
          expect(
            await probe.evaluate((el) => getComputedStyle(el).color),
            `${token} must resolve to a colour of its own in ${theme} theme`,
          ).not.toBe('rgb(255, 0, 255)');

          expect(
            await contrastRatio(probe),
            `${token} on ${backdrop} in ${theme} theme (WCAG 1.4.3, normal text)`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
