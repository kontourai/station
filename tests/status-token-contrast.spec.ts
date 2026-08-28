import { expect, test } from '@playwright/test';
import { backgroundPaint, contrastRatio } from './helpers/color-contrast';

/**
 * The semantic status token families — error/danger and success — measured the
 * way a user sees them.
 *
 * Four defects across these families shipped behind green gates, each for a
 * different reason, and this spec exists to close all four routes:
 *
 * 1. **archive#1125** — `--error-text` used as a solid fill under white text
 *    (2.78:1 in dark). Fixed by `--error-fill`.
 * 2. **archive#1167** — `--error-text` used as text on a 6-15% tint OF ITSELF.
 *    The original audit compared the text against the *declared* backdrop
 *    instead of the composited tint, which turns a 3.91:1 failure into a
 *    4.52:1 pass. Only compositing catches it, so every measurement here goes
 *    through `contrastRatio`, which walks the ancestor chain.
 * 3. **archive#1168** — `var(--error-primary)` / `var(--error-secondary)`,
 *    referenced in eight places and defined in none. A `var()` with no
 *    fallback naming an undefined custom property is invalid at
 *    computed-value time: `background` collapses to transparent and `color`
 *    to `inherit`. The rule parses, the bundle builds, nothing fails — the
 *    styling simply never applies. Ratio assertions alone cannot see this
 *    (unpainted white-on-white measures 1:1, but unpainted error *text* just
 *    inherits body copy and measures fine), so every fill surface below also
 *    asserts that it is actually **painted**.
 * 4. **archive#1246** — the same shape again, in the success half of the same
 *    component: `var(--success-primary)` / `var(--success-secondary)`, one CSS
 *    rule above the one archive#1168 fixed, plus `var(--color-bg-tertiary)` (not one
 *    of the `--color-*` aliases) two rules further up. archive#1168's search was
 *    scoped to the `--error-` prefix, so it reached none of them. The
 *    tool-call badge row was measured live before the fix: every chip in it
 *    painted `rgba(0, 0, 0, 0)` and the "User approved" badge rendered in the
 *    same `#eef3f8`/`#202124` body copy as the text beside it.
 *
 * The prefix-scoping failure itself is guarded elsewhere, and has to be:
 * `src-ui/src/__tests__/undefined-css-custom-properties.test.ts` fails on any
 * `var()` in the tree that cannot resolve, for any token family. Contrast
 * assertions cannot substitute for it — an uncoloured foreground inherits body
 * copy and measures beautifully — which is exactly why the success pair
 * survived a spec written for the surfaces one rule below it.
 *
 * The surfaces are injected rather than driven to, so the rules under test are
 * the real, shipped ones; what is synthesised is only the DOM they attach to.
 * Most live in the entry stylesheet. `.workspace-header__dropdown-item` no
 * longer does — archive#883 deferred the SDK barrel out of the entry chunk, so
 * that rule ships in the chunk sheet its component owns, and its test loads it
 * through the app's readiness contract before probing. Each probe therefore carries
 * an explicit "the rule still matches this element" guard — without one, a
 * renamed class produces an unstyled div that measures body-text-on-page and
 * passes, which is the inert-test failure this repo has shipped five times.
 */

const THEMES = ['light', 'dark'] as const;

/** Backdrops a status control can land on. The worst one is what must pass. */
const BACKDROPS = ['--bg-primary', '--bg-secondary', '--bg-tertiary'];

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
 * The composer's Stop button carries `transition: background 0.2s`, so the
 * frame right after a pointer move still reports the *previous* fill while
 * the untransitioned `color` has already snapped. Reading then measures a
 * white glyph against the resting background and reports ~1.2:1 — a failure
 * that is real-looking and entirely an artefact.
 *
 * The fix is to remove the transition rather than to wait it out. A fixed
 * wait is both unsound (it encodes a duration the CSS is free to change) and
 * a `product`-bucket manifest violation, and polling is worse still: it
 * returns on its first *passing* read, so a fill that never arrives is
 * papered over. With transitions off, `:hover` matching and the painted fill
 * land in the same style recalculation, so waiting for the pseudo-class is an
 * exact signal that the surface under test is the settled one.
 */
async function settleHover(
  page: import('@playwright/test').Page,
  hovered: boolean,
) {
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-testid="danger-probe"]')
        ?.matches(':hover') === expected,
    hovered,
  );
}

/**
 * Mount `className` on a probe inside a backdrop of `backdropToken`, plus an
 * unclassed sibling as the control. Returns locators for both.
 */
async function mountProbe(
  page: import('@playwright/test').Page,
  className: string,
  backdropToken: string,
) {
  await page.evaluate(
    ({ className, backdropToken }) => {
      document.getElementById('danger-probe-host')?.remove();
      const host = document.createElement('div');
      host.id = 'danger-probe-host';
      host.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;padding:24px;background:var(${backdropToken});color:var(--text-primary)`;
      host.innerHTML = `<div data-testid="danger-probe-control">Control</div>`;
      const probe = document.createElement('div');
      probe.setAttribute('data-testid', 'danger-probe');
      probe.className = className;
      probe.textContent = 'Remove';
      host.appendChild(probe);
      document.body.appendChild(host);
    },
    { className, backdropToken },
  );
  return {
    probe: page.getByTestId('danger-probe'),
    control: page.getByTestId('danger-probe-control'),
  };
}

test.describe('error/danger token family contrast', () => {
  test.beforeEach(async ({ page }) => {
    await mockReady(page);
    await page.goto('/');
    await expect(page.locator('#root')).toBeAttached();
    // `.button` and `.chat-input__stop-btn` animate `color`/`background`, so a
    // reading taken mid-transition reports the previous state's surface. Every
    // probe below is mounted fresh (a newly inserted element has no
    // before-change style, so it does not transition), but the hover step and
    // any future in-place theme flip do, and a spec that measures colour must
    // not depend on that distinction holding. Same instrument as archive#1217.
    await page.addStyleTag({
      content: '*, *::before, *::after { transition: none !important; }',
    });
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() =>
      document.getElementById('danger-probe-host')?.remove(),
    );
  });

  /**
   * archive#1167. `.button--danger-outline` sets `--error-text` as its own
   * text over a 10% tint of `--error-text`; `.tool-call__status-badge--error`
   * and `.tool-call__code--error` are archive#1168's foregrounds. All are
   * <= 14px, so 1.4.3 asks for 4.5:1 — none of them qualify as large text.
   */
  for (const surface of [
    {
      name: '.button--danger-outline',
      className: 'button button--danger-outline',
    },
    {
      name: '.tool-call__status-badge--error',
      className: 'tool-call__status-badge tool-call__status-badge--error',
    },
    {
      name: '.tool-call__code--error',
      className: 'tool-call__code tool-call__code--error',
    },
  ]) {
    test(`${surface.name} meets 1.4.3 composited on every backdrop, both themes`, async ({
      page,
    }) => {
      for (const theme of THEMES) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        for (const backdrop of BACKDROPS) {
          const { probe, control } = await mountProbe(
            page,
            surface.className,
            backdrop,
          );
          // Anti-inert guard: the rule must still be colouring this element.
          // A renamed or deleted class leaves the probe inheriting the host's
          // colour, which would measure comfortably and mean nothing.
          const [probeColor, controlColor] = await Promise.all([
            probe.evaluate((el) => getComputedStyle(el).color),
            control.evaluate((el) => getComputedStyle(el).color),
          ]);
          expect(
            probeColor,
            `${surface.name} must set its own colour — got the inherited one, so the rule no longer matches`,
          ).not.toBe(controlColor);

          expect(
            await contrastRatio(probe),
            `${surface.name} on ${backdrop} in ${theme} theme (WCAG 1.4.3, normal text)`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  /**
   * The white-on-danger fills. `--error-fill` exists precisely because
   * `--error-text` and its `--status-error` alias cannot carry white text in
   * the dark theme (2.78:1). The opacity assertion is the archive#1168 half:
   * `.chat-input__stop-btn:hover` used to read an undefined token, so its fill
   * collapsed to transparent and a white Stop glyph landed on a white
   * composer.
   */
  for (const surface of [
    { name: '.button--danger', className: 'button button--danger' },
    {
      name: '.app-toolbar__notification-badge',
      className: 'app-toolbar__notification-badge',
    },
  ]) {
    test(`${surface.name} is an opaque fill that carries white text in both themes`, async ({
      page,
    }) => {
      for (const theme of THEMES) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        const { probe } = await mountProbe(
          page,
          surface.className,
          '--bg-primary',
        );
        const paint = await backgroundPaint(probe);
        expect(
          paint.alpha,
          `${surface.name} must paint an opaque fill in ${theme} theme — got ${paint.color}, which is what an undefined token produces`,
        ).toBe(1);
        expect(
          await contrastRatio(probe),
          `${surface.name} in ${theme} theme (WCAG 1.4.3, normal text)`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test('the Stop button stays legible through its hover fill in both themes', async ({
    page,
  }) => {
    for (const theme of THEMES) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      const { probe } = await mountProbe(
        page,
        'chat-input__stop-btn',
        '--bg-primary',
      );

      // Park the pointer away from the probe first: a fresh element mounted
      // under a stationary cursor is hovered from birth, which would measure
      // the hover state and call it the resting one.
      await page.mouse.move(2000, 2000);
      await settleHover(page, false);
      const resting = await backgroundPaint(probe);
      expect(
        resting.alpha,
        `resting Stop fill in ${theme} theme — got ${resting.color}`,
      ).toBe(1);
      expect(
        await contrastRatio(probe),
        `resting Stop button in ${theme} theme`,
      ).toBeGreaterThanOrEqual(4.5);

      await probe.hover();
      await settleHover(page, true);
      const hovered = await backgroundPaint(probe);
      expect(
        hovered.alpha,
        `hovered Stop fill in ${theme} theme — an undefined token collapses this to transparent and leaves a white glyph on the composer (station#1168), and it measured exactly 1.000:1 in light`,
      ).toBe(1);
      expect(
        await contrastRatio(probe),
        `hovered Stop button in ${theme} theme`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * The success half of the tool-call status row (archive#1246).
 *
 * These three chips sit next to each other in the same header, and all three
 * had the same defect: `.tool-call__server-badge` and `.tool-call__status-badge`
 * named `--color-bg-tertiary`, which is not one of the `--color-*` aliases the
 * app defines, and `.tool-call__status-badge--success` named
 * `--success-secondary` / `--success-primary`, which are defined nowhere at
 * all. Measured on the running app before the fix, every one painted
 * `rgba(0, 0, 0, 0)` and the success badge's text was the inherited body copy.
 *
 * All three carry text at 0.7em, so WCAG 1.4.3 asks 4.5:1 — none of them is
 * large text, and none of them is a non-text indicator that 1.4.11's 3:1 would
 * apply to.
 */
test.describe('success token family contrast', () => {
  test.beforeEach(async ({ page }) => {
    await mockReady(page);
    await page.goto('/');
    await expect(page.locator('#root')).toBeAttached();
    await page.addStyleTag({
      content: '*, *::before, *::after { transition: none !important; }',
    });
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() =>
      document.getElementById('danger-probe-host')?.remove(),
    );
  });

  for (const surface of [
    {
      name: '.tool-call__status-badge--success',
      className: 'tool-call__status-badge tool-call__status-badge--success',
      /** The modifier's whole job is to recolour the text green. */
      recolours: true,
    },
    {
      name: '.tool-call__status-badge',
      className: 'tool-call__status-badge',
      recolours: false,
    },
    // `.tool-call__server-badge` used to be measured here as a third member of
    // this family. The tool-call row no longer carries a per-server badge at
    // all — archive#3657 left `.tool-call__status-badge` (and its `--error` /
    // `--warning` modifiers, `ToolCallDisplay.tsx:180-209`) owning every status
    // token in the row, and server identity moved to the MCP UI pill set
    // (`MCPToolUIFrame.tsx:956`). Nothing in src-ui renders or styles the old
    // class, so the probe measured an unpainted chip — the exact reading
    // archive#1246 built this gate to catch, produced here by a class that is
    // simply gone rather than by a token that stopped resolving.
    //
    // Removed rather than rewritten because its replacement is already in this
    // list: the two `.tool-call__status-badge` cases above measure the same
    // family on the same backdrops in both themes, and the `--success` case
    // still proves a modifier that recolours.
  ]) {
    test(`${surface.name} paints an opaque chip and meets 1.4.3 on every backdrop, both themes`, async ({
      page,
    }) => {
      for (const theme of THEMES) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        for (const backdrop of BACKDROPS) {
          const { probe, control } = await mountProbe(
            page,
            surface.className,
            backdrop,
          );

          // archive#1246 itself: an undefined token leaves the chip unpainted,
          // and an unpainted chip against body copy still measures ~16:1. The
          // ratio assertion below cannot see the defect; this one can.
          const paint = await backgroundPaint(probe);
          expect(
            paint.alpha,
            `${surface.name} must paint an opaque chip in ${theme} theme — got ${paint.color}, which is what an undefined token produces`,
          ).toBe(1);

          if (surface.recolours) {
            // Anti-inert guard: a renamed or deleted modifier leaves the probe
            // inheriting the host's colour, which measures comfortably and
            // means nothing.
            const [probeColor, controlColor] = await Promise.all([
              probe.evaluate((el) => getComputedStyle(el).color),
              control.evaluate((el) => getComputedStyle(el).color),
            ]);
            expect(
              probeColor,
              `${surface.name} must set its own colour — got the inherited one, so the rule no longer matches`,
            ).not.toBe(controlColor);
          }

          expect(
            await contrastRatio(probe),
            `${surface.name} on ${backdrop} in ${theme} theme (WCAG 1.4.3, normal text)`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  /**
   * `ToolCallDisplay` also sets `--success-text` inline in two places: the
   * result checkmark and the word "Success" in the expanded detail. Both sit
   * on the tool-call card, whose own inline background is
   * `--color-bg-secondary` — so that, and not the page, is the backdrop to
   * measure against. Asserting these against `--bg-tertiary` as well would be
   * over-strict: the card is never mounted on it.
   *
   * The checkmark is a non-text indicator (1.4.11, 3:1) and the word is normal
   * text (1.4.3, 4.5:1). Both are asserted at the stricter 4.5:1 because both
   * carry the same token and the token clears it — a genuinely separate
   * threshold would only be warranted if the icon needed relief the text did
   * not.
   *
   * **What this does and does not cover**, stated because the difference was
   * measured rather than assumed: this pins `--success-text` itself — that it
   * resolves, and that it is legible on the card. It does **not** see the two
   * JSX call sites, because they carry no class for a probe to mount. Putting
   * `var(--success-primary)` back into `ToolCallDisplay.tsx` leaves this test
   * green; it fails
   * `src-ui/src/__tests__/undefined-css-custom-properties.test.ts`, which
   * reads the source and named both lines when that exact revert was injected.
   */
  test('the inline --success-text foregrounds are legible on the tool-call card, both themes', async ({
    page,
  }) => {
    for (const theme of THEMES) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      await page.evaluate(() => {
        document.getElementById('danger-probe-host')?.remove();
        const host = document.createElement('div');
        host.id = 'danger-probe-host';
        host.style.cssText =
          'position:fixed;top:0;left:0;z-index:2147483647;padding:24px;background:var(--color-bg-secondary);color:var(--text-primary)';
        host.innerHTML =
          '<span data-testid="danger-probe-control">Control</span>';
        const probe = document.createElement('span');
        probe.setAttribute('data-testid', 'danger-probe');
        probe.style.color = 'var(--success-text)';
        probe.textContent = 'Success';
        host.appendChild(probe);
        document.body.appendChild(host);
      });
      const probe = page.getByTestId('danger-probe');
      const control = page.getByTestId('danger-probe-control');

      const [probeColor, controlColor] = await Promise.all([
        probe.evaluate((el) => getComputedStyle(el).color),
        control.evaluate((el) => getComputedStyle(el).color),
      ]);
      expect(
        probeColor,
        `--success-text must resolve to a colour of its own in ${theme} theme — an undefined token leaves this inheriting body copy, which is exactly how station#1246 shipped`,
      ).not.toBe(controlColor);

      expect(
        await contrastRatio(probe),
        `--success-text on the tool-call card in ${theme} theme (WCAG 1.4.3, normal text)`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * archive#1254: the surfaces that were converted off custom properties no rule
 * ever declared.
 *
 * Twenty-four names across eight owning surfaces, every one of them **invalid
 * at computed-value time**, so the declarations never applied. Measured on the
 * running app before the fix: the "✓ UNLOCKED" achievement badge painted
 * `rgba(0, 0, 0, 0)` and set `--text-on-accent` on it — 1.10:1 in light and
 * 1.04:1 in dark, which is white text on the page; the SDK's `success` Button
 * did the same thing with `color: white`; the achievement progress bar drew an
 * **empty track** at every width above 25%; the monitoring dashboard coloured
 * every failing health check while its passing sibling one line above rendered
 * as body copy; and the share-target picker's search field had no border, no
 * background and no colour, because its fallbacks chained one undefined name
 * onto another.
 *
 * Three things here that a ratio alone cannot do:
 *
 * - **The host paints its text `magenta`.** The app never uses it, so a rule
 *   that has stopped matching cannot pass by measuring ordinary body copy
 *   against the page. That is not hypothetical: the first draft of this block
 *   had eleven surfaces measuring a comfortable 15:1 while matching nothing,
 *   because their stylesheet is a lazily-loaded chunk `/` never loads.
 * - **The owning styles are loaded from the running instance.** Most suites use
 *   {@link loadStyleChunk} to resolve and inject the shipped hashed chunk;
 *   Monitoring visits its owning lazy route because Vite now folds that CSS
 *   outside the entry preload table. Either path fails loudly instead of
 *   leaving the probes unstyled. Driving to every owning route would still
 *   need a project layout and a share intent for the remaining surfaces.
 * - **Animations are disabled as well as transitions.**
 *   `.agent-card.status-running` animates its background, and a frame sampled
 *   mid-animation serializes as `oklab(…)`, which the contrast helper
 *   correctly refuses to read rather than guess at.
 */

/**
 * Inject the built CSS chunk whose name starts with `baseName`, resolved from
 * the entry bundle's own preload table so the hash never has to be guessed.
 */
async function loadStyleChunk(
  page: import('@playwright/test').Page,
  baseName: string,
  probeClass: string,
) {
  const url = await page.evaluate(
    async ({ name, selector }) => {
      const entry = [...document.querySelectorAll('script[type="module"]')]
        .map((element) => (element as HTMLScriptElement).src)
        .find((src) => src.includes('/assets/index-'));
      if (!entry) throw new Error('no entry module script on the page');
      const source = await (await fetch(entry)).text();
      // A chunk of this NAME can exist without holding the rule the probe
      // measures: Vite folds a lazy view's CSS into a differently named shared
      // chunk and leaves the same-named one behind carrying something else
      // (`ProjectLayoutRenderer` ships only `.tasks-layout` today, while every
      // coding-layout rule lives in `workspacePaneHostAdmission`). Returning it
      // unchecked injected a stylesheet with none of these rules, and the
      // probes then measured `rgba(0, 0, 0, 0)` — the same reading an undefined
      // token produces, which is exactly what this block claims it cannot be
      // fooled by. Verify before trusting, then fall through to the content
      // search, which still throws when nothing matches.
      const namedMatch = source.match(
        new RegExp(`assets/${name}-[A-Za-z0-9_-]+\\.css`),
      );
      if (namedMatch) {
        const named = await (await fetch(`/${namedMatch[0]}`)).text();
        if (named.includes(`.${selector}`)) return `/${namedMatch[0]}`;
      }

      // Vite may fold a lazy view's CSS into a differently named shared chunk.
      // Resolve that case by content, while still failing loudly if the shipped
      // stylesheet no longer contains the rule the probe intends to measure.
      const cssPaths = [...source.matchAll(/assets\/[A-Za-z0-9_-]+\.css/g)].map(
        (match) => match[0],
      );
      for (const path of [...new Set(cssPaths)]) {
        const css = await (await fetch(`/${path}`)).text();
        if (css.includes(`.${selector}`)) return `/${path}`;
      }
      throw new Error(
        `the built styles contain neither a ${name} chunk nor .${selector} — these probes would measure nothing`,
      );
    },
    { name: baseName, selector: probeClass },
  );
  await page.addStyleTag({ url });
}

async function mountNested(
  page: import('@playwright/test').Page,
  chain: string[],
  backdropToken: string,
) {
  await page.evaluate(
    ({ chain, backdropToken }) => {
      document.getElementById('danger-probe-host')?.remove();
      const host = document.createElement('div');
      host.id = 'danger-probe-host';
      host.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;padding:24px;background:var(${backdropToken});color:magenta`;
      const control = document.createElement('span');
      control.setAttribute('data-testid', 'danger-probe-control');
      control.textContent = 'Control';
      host.appendChild(control);
      let parent: HTMLElement = host;
      chain.forEach((className, index) => {
        const element = document.createElement('div');
        element.className = className;
        if (index === chain.length - 1) {
          element.setAttribute('data-testid', 'danger-probe');
          element.textContent = 'Sample';
        }
        parent.appendChild(element);
        parent = element;
      });
      document.body.appendChild(host);
    },
    { chain, backdropToken },
  );
  return {
    probe: page.getByTestId('danger-probe'),
    control: page.getByTestId('danger-probe-control'),
  };
}

interface ConvertedSurface {
  name: string;
  /** Ancestor classes then the probe's own, so a tinted card is composited. */
  chain: string[];
  /** Its own text colour is what the rule is for. */
  recolours: boolean;
  /** It must paint an opaque fill (a translucent tint sets this false). */
  opaque?: boolean;
  /**
   * It must paint a *translucent* fill. Without this a tint-only surface is
   * an inert assertion: its text colour comes from a token the tint work did not
   * touch, so reverting the tint leaves the ratio comfortable and the test
   * green (`.coding-inspector__cta-action` passed
   * against the pre-fix build until this was added).
   */
  tinted?: boolean;
}

const CONVERTED_SUITES: Array<{
  title: string;
  chunk: string;
  backdrop: string;
  surfaces: ConvertedSurface[];
}> = [
  {
    title: 'the achievements surface',
    chunk: 'ProfilePage',
    backdrop: '--bg-primary',
    surfaces: [
      {
        name: '.achievements-count',
        chain: ['achievements-count'],
        recolours: true,
        opaque: true,
      },
      {
        name: '.achievement-unlocked-badge',
        chain: [
          'achievement-card achievement-card-unlocked',
          'achievement-unlocked-badge',
        ],
        recolours: true,
        opaque: true,
      },
      {
        name: '.achievement-unlocked-date',
        chain: [
          'achievement-card achievement-card-unlocked',
          'achievement-unlocked-date',
        ],
        recolours: true,
      },
      {
        // The card tints and outlines itself and inherits its text, so only
        // the fill is asserted — both of its declarations carried a stray
        // Tailwind opacity suffix as well as an undefined token.
        name: '.achievement-card-unlocked',
        chain: ['achievement-card achievement-card-unlocked'],
        recolours: false,
        opaque: true,
      },
    ],
  },
  {
    title: 'the monitoring dashboard',
    chunk: 'MonitoringView',
    backdrop: '--bg-secondary',
    surfaces: [
      {
        name: '.health-check-value-pass',
        chain: ['health-check-value-pass'],
        recolours: true,
      },
      {
        name: '.health-integration-status-ok',
        chain: ['health-integration-status-ok'],
        recolours: true,
      },
      {
        name: '.health-ok',
        chain: ['pill-badge health-ok'],
        recolours: true,
        opaque: true,
      },
      {
        name: '.tool-badge',
        chain: ['pill-badge tool-badge'],
        recolours: true,
        opaque: true,
      },
      { name: '.artifact-name', chain: ['artifact-name'], recolours: true },
      {
        name: '.agent-status.running',
        chain: ['agent-status running'],
        recolours: true,
        opaque: true,
      },
    ],
  },
  {
    title: 'the coding layout',
    chunk: 'ProjectLayoutRenderer',
    backdrop: '--bg-secondary',
    surfaces: [
      {
        // A 12% accent tint, so asserted translucent-but-painted rather than
        // opaque. Its label is --text-primary, which this issue did not
        // change, so the tint is the only thing this test can be watching.
        name: '.coding-inspector__cta-action',
        chain: ['coding-inspector__cta-action'],
        recolours: true,
        tinted: true,
      },
      {
        name: '.coding-inspector__cta-command',
        chain: ['coding-inspector__cta-command'],
        recolours: true,
        opaque: true,
      },
      {
        // --accent-primary on an 18% tint of itself measured 4.01:1 in light
        // at 11px, so the label is --text-primary. This assertion is what
        // stops it drifting back.
        name: '.workflow-plan-panel__step-badge--in_progress',
        chain: [
          'workflow-plan-panel__step-badge workflow-plan-panel__step-badge--in_progress',
        ],
        recolours: true,
      },
      {
        name: '.workflow-plan-panel__step',
        chain: ['workflow-plan-panel__step'],
        recolours: false,
        opaque: true,
      },
    ],
  },
  {
    title: 'the share-target picker',
    chunk: 'ShareTargetPickerModal',
    backdrop: '--bg-secondary',
    surfaces: [
      {
        name: '.share-target-picker__search',
        chain: ['share-target-picker__search'],
        recolours: true,
        opaque: true,
      },
      {
        name: '.share-target-picker__item',
        chain: ['share-target-picker__items', 'share-target-picker__item'],
        recolours: true,
      },
    ],
  },
];

for (const suite of CONVERTED_SUITES) {
  test.describe(`station#1254 — ${suite.title}`, () => {
    test.beforeEach(async ({ page }) => {
      await mockReady(page);
      // Monitoring's styles now follow the Developer route rather than being
      // named in the entry preload table. Visit the owning route so the test
      // measures the same lazy stylesheet the product loads in practice.
      await page.goto(
        suite.chunk === 'MonitoringView' ? '/developer/telemetry' : '/',
      );
      await expect(page.locator('#root')).toBeAttached();
      await page.addStyleTag({
        content:
          '*, *::before, *::after { transition: none !important; animation: none !important; }',
      });
      if (suite.chunk !== 'MonitoringView') {
        await loadStyleChunk(
          page,
          suite.chunk,
          suite.surfaces[0].chain.at(-1)!,
        );
      }
    });

    test.afterEach(async ({ page }) => {
      await page.evaluate(() =>
        document.getElementById('danger-probe-host')?.remove(),
      );
    });

    for (const surface of suite.surfaces) {
      test(`${surface.name} is styled and legible in both themes`, async ({
        page,
      }) => {
        for (const theme of THEMES) {
          await page.evaluate((value) => {
            document.documentElement.setAttribute('data-theme', value);
          }, theme);
          const { probe, control } = await mountNested(
            page,
            surface.chain,
            suite.backdrop,
          );

          const controlColor = await control.evaluate(
            (el) => getComputedStyle(el).color,
          );
          expect(
            controlColor,
            'the host must paint the sentinel colour, or a rule that stopped matching can pass by inheriting ordinary body copy',
          ).toBe('rgb(255, 0, 255)');

          if (surface.opaque) {
            const paint = await backgroundPaint(probe);
            expect(
              paint.alpha,
              `${surface.name} must paint an opaque fill in ${theme} theme — got ${paint.color}, which is what an undefined token produces`,
            ).toBe(1);
          }
          if (surface.tinted) {
            const paint = await backgroundPaint(probe);
            expect(
              paint.alpha,
              `${surface.name} must paint a translucent tint in ${theme} theme — got ${paint.color}; an undefined token inside color-mix() leaves it unpainted`,
            ).toBeGreaterThan(0);
            expect(
              paint.alpha,
              `${surface.name} is a tint, not a solid fill, in ${theme} theme`,
            ).toBeLessThan(1);
          }
          if (surface.recolours) {
            const probeColor = await probe.evaluate(
              (el) => getComputedStyle(el).color,
            );
            expect(
              probeColor,
              `${surface.name} must set its own colour in ${theme} theme — inheriting the sentinel means the rule no longer matches`,
            ).not.toBe(controlColor);
            expect(
              await contrastRatio(probe),
              `${surface.name} on ${suite.backdrop} in ${theme} theme (WCAG 1.4.3, normal text)`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      });
    }
  });
}

/**
 * The archive#1254 surfaces, plus the two non-text ramps the sweep produced.
 * These used to be entry-stylesheet-only; `.workspace-header__dropdown-item`
 * moved into a lazily injected chunk sheet in archive#883 and now loads its
 * own stylesheet first (see the test).
 */
test.describe('station#1254 — recovered surfaces and the fill ramps', () => {
  test.beforeEach(async ({ page }) => {
    await mockReady(page);
    await page.goto('/');
    await expect(page.locator('#root')).toBeAttached();
    await page.addStyleTag({
      content:
        '*, *::before, *::after { transition: none !important; animation: none !important; }',
    });
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() =>
      document.getElementById('danger-probe-host')?.remove(),
    );
  });

  test('.workspace-header__dropdown-item colours itself and meets 1.4.3, both themes', async ({
    page,
  }) => {
    // This surface no longer ships in the entry stylesheet. archive#883
    // deferred the SDK barrel out of the entry chunk, so `LayoutHeader.css`
    // is injected with the chunk that owns it — and on `/` with empty data no
    // layout route renders, so nothing pulls it in and this probe would read
    // the host's inherited colour instead of the rule.
    //
    // Loading it through the app's own public contract rather than by
    // reaching for a hashed asset path: the readiness handle resolves the SDK
    // barrel, which imports LayoutHeader and therefore its stylesheet. In the
    // product the rule is always present where it matters, because the only
    // markup that carries this class renders inside that same chunk.
    await page.evaluate(async () => {
      await (
        window as unknown as { __station_ai_shared_ready: () => Promise<void> }
      ).__station_ai_shared_ready();
    });
    await expect
      .poll(async () =>
        page.evaluate(() =>
          [...document.styleSheets].some((sheet) => {
            try {
              return [...sheet.cssRules].some((rule) =>
                rule.cssText.includes('.workspace-header__dropdown-item'),
              );
            } catch {
              return false;
            }
          }),
        ),
      )
      .toBe(true);

    for (const theme of THEMES) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      const { probe, control } = await mountNested(
        page,
        ['workspace-header__dropdown-menu', 'workspace-header__dropdown-item'],
        '--bg-primary',
      );
      const [probeColor, controlColor] = await Promise.all([
        probe.evaluate((el) => getComputedStyle(el).color),
        control.evaluate((el) => getComputedStyle(el).color),
      ]);
      expect(controlColor).toBe('rgb(255, 0, 255)');
      expect(
        probeColor,
        `the dropdown item must set its own colour in ${theme} theme — it read --color-text-primary, which is not one of the --color-* aliases this app defines`,
      ).not.toBe(controlColor);
      expect(
        await contrastRatio(probe),
        `.workspace-header__dropdown-item in ${theme} theme (WCAG 1.4.3, normal text)`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  /**
   * `background: var(--primary)` on this button's hover did not fall back to
   * the resting `--bg-secondary` fill — it **removed** it. An invalid
   * declaration resets the property rather than yielding to the rule below, so
   * the control lost its surface at the moment the pointer arrived; it
   * measured `rgba(0, 0, 0, 0)` on hover before archive#1254.
   */
  test('the image-preview nav keeps a fill and a legible glyph through hover, both themes', async ({
    page,
  }) => {
    for (const theme of THEMES) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      await page.evaluate(() => {
        document.getElementById('danger-probe-host')?.remove();
        const host = document.createElement('div');
        host.id = 'danger-probe-host';
        host.style.cssText =
          'position:fixed;top:0;left:0;z-index:2147483647;padding:24px;background:var(--bg-primary);color:magenta';
        const probe = document.createElement('button');
        probe.setAttribute('data-testid', 'danger-probe');
        probe.className = 'image-preview-modal__nav';
        probe.textContent = '‹';
        host.appendChild(probe);
        document.body.appendChild(host);
      });
      const probe = page.getByTestId('danger-probe');

      await page.mouse.move(2000, 2000);
      await settleHover(page, false);
      const resting = await backgroundPaint(probe);
      expect(
        resting.alpha,
        `resting nav fill in ${theme} theme — got ${resting.color}`,
      ).toBe(1);
      expect(
        await contrastRatio(probe),
        `resting nav glyph in ${theme} theme`,
      ).toBeGreaterThanOrEqual(4.5);

      await probe.hover();
      await settleHover(page, true);
      const hovered = await backgroundPaint(probe);
      expect(
        hovered.alpha,
        `hovered nav fill in ${theme} theme — an invalid background declaration resets the property rather than yielding to the resting rule, so this measured rgba(0, 0, 0, 0) before station#1254`,
      ).toBe(1);
      expect(
        await contrastRatio(probe),
        `hovered nav glyph in ${theme} theme (WCAG 1.4.3)`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  /**
   * The achievement progress bar's fill ramp. These are **non-text**
   * indicators, so WCAG 1.4.11 asks 3:1 against what is adjacent — the bar's
   * own `--bg-primary` track — and not 4.5:1. An earlier sweep correctly left
   * `.schedule__rate-fill--low` alone for the same reason, and holding a fill
   * bar to the text threshold would conflate the two.
   *
   * The binding from `getProgressColor()` to these tokens is JSX with no class
   * to mount, so it is pinned by
   * `src-ui/src/__tests__/undefined-css-custom-properties.test.ts` at source
   * level — the same division of labour the `--success-text` test above
   * records for `ToolCallDisplay`.
   */
  for (const token of [
    '--success-text',
    '--warning-text',
    '--accent-primary',
  ]) {
    test(`${token} is a legible non-text fill on the --bg-primary track, both themes`, async ({
      page,
    }) => {
      for (const theme of THEMES) {
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        await page.evaluate((value) => {
          document.getElementById('danger-probe-host')?.remove();
          const host = document.createElement('div');
          host.id = 'danger-probe-host';
          host.style.cssText =
            'position:fixed;top:0;left:0;z-index:2147483647;padding:24px;background:var(--bg-primary);color:magenta';
          const probe = document.createElement('span');
          probe.setAttribute('data-testid', 'danger-probe');
          probe.style.color = `var(${value})`;
          probe.textContent = 'fill';
          host.appendChild(probe);
          document.body.appendChild(host);
        }, token);
        const probe = page.getByTestId('danger-probe');
        expect(
          await probe.evaluate((el) => getComputedStyle(el).color),
          `${token} must resolve to a colour of its own in ${theme} theme — an undefined token leaves the fill transparent, which is how every achievement above 25% progress drew an empty track`,
        ).not.toBe('rgb(255, 0, 255)');
        expect(
          await contrastRatio(probe),
          `${token} against the --bg-primary track in ${theme} theme (WCAG 1.4.11, non-text)`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
