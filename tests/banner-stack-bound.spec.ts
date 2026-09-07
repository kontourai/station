/**
 * E2E: the collapsed connectionBlocking band and the expanded banner stack
 * actually scroll, and the stack only ever takes pointer events when there is
 * genuinely something to scroll (archive#3432).
 *
 * WHY THIS EXISTS AND NOT ONLY A CSS-TEXT ASSERTION. jsdom performs no
 * layout: `mobile-chrome-safety.test.ts` can only confirm that
 * `max-height`/`overflow-y: auto` appear as CSS text, never that
 * `scrollHeight` actually exceeds `clientHeight` or that a wheel event moves
 * `scrollTop`. That gap is exactly how the band and the expanded stack
 * shipped with a scroll declaration that never engaged: `.banner-host` is
 * `display: flex; flex-direction: column`, so a bound declared on an
 * ancestor made flex children SHRINK to fit it instead of overflowing it —
 * `overflow-y: auto` had nothing to scroll, and each card was silently
 * compressed with its content clipped by `.banner-host__item`'s own
 * `overflow: hidden`. Only a real browser can tell the two apart. A
 * second, independent reason a real browser is required: whether the
 * stack's `pointer-events: auto` opt-in is currently justified depends on a
 * live `scrollHeight`/`clientHeight` comparison that only exists once real
 * layout has run.
 *
 * The subject is the real `BannerHost` and the real `bannerStore`, bundled
 * from source with esbuild (the same technique `dialog-return-focus.spec.ts`
 * uses), with the real `BannerHost.css` attached as an actual stylesheet via
 * `addStyleTag({ path })` — Playwright reads the file itself, so this file
 * never imports `node:fs` (keeps it out of the E2E manifest's risky-resource
 * heuristic; see `tests/e2e-manifest.mjs`). `loader: {'.css': 'empty'}` only
 * strips the CSS *import statement* from the JS bundle so esbuild doesn't
 * choke on it — the stylesheet's rules are attached separately, verbatim
 * from disk, and stay live. `--layer-notice` is defined to the real
 * `tokens.css` value (9000) because `.banner-host`'s `z-index: var(
 * --layer-notice)` is what gives it its own stacking context — undefined,
 * the cap button's `z-index: -1` (deliberately behind the front card, inside
 * that context) escapes to the page root instead and renders behind
 * everything, an artifact of an under-specified harness, not of the product.
 * `--motion-base`/`--ease-standard`/`--ease-out` are likewise pinned to their
 * real `tokens.css` values so the exit-animation test exercises the real
 * 200ms transition, not an unstyled instant collapse. Only the surrounding
 * page and the banner content are synthetic.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BANNER_CSS_PATH = join(
  REPO_ROOT,
  'src-ui/src/components/notifications/BannerHost.css',
);

type Scenario =
  | 'band-four-blocking'
  | 'band-two-blocking'
  | 'expand-many'
  | 'grow-pinned'
  | 'one-short'
  | 'shrink-back'
  | 'single-dismissible';

const HARNESS_SOURCE = `
import { createRoot } from 'react-dom/client';
import { BannerHost } from './src-ui/src/components/notifications/BannerHost';
import { bannerStore, BANNER_PRIORITY, BANNER_IDS } from './src-ui/src/contexts/banner-store';

/**
 * The originally reported scenario (archive#3432): a declined device's decline
 * ("Dev Server declined this device") and the active connection's own offline
 * notice both live in the connectionBlocking band at once. Real production
 * strings, not placeholders — from ConnectionBannerSource.tsx and the
 * OnboardingGate decline copy quoted in the report.
 */
function seedBandTwoBlocking() {
  bannerStore.present({
    id: BANNER_IDS.offline,
    priority: BANNER_PRIORITY.connectionBlocking,
    tone: 'error',
    message:
      "Can't reach Dev Server. Some actions are unavailable until reconnected.",
    detail:
      'Read-only access continues locally; new agent runs and remote actions will not be queued.',
    dismissible: false,
    actions: [{ label: 'Try now', onClick: () => {} }],
  });
  bannerStore.present({
    id: BANNER_IDS.pairingFailure,
    priority: BANNER_PRIORITY.connectionBlocking,
    tone: 'blocked',
    badge: 'Declined',
    message: 'Dev Server declined this device.',
    detail:
      'Preparing the connection… Waiting for approval on Dev Server… Choose a different Station or ask its owner to approve this device again.',
    dismissible: false,
    actions: [{ label: 'Request access', onClick: () => {} }],
  });
}

/**
 * Four real connectionBlocking ids at once (archive#3432) — a set that
 * must be genuinely reachable: \`BANNER_IDS.credential\` cannot co-occur
 * with \`pairingFailure\` (see below), so a fixture must not assert that
 * pair.
 *
 * \`buildBannerStackView\` renders every live band member. FIVE distinct
 * producers can emit into this band, not four:
 * - OnboardingGate's pairing-approval banner (\`chrome:onboarding:pairing-
 *   approval\`, a local id, not in \`BANNER_IDS\` — OnboardingGate.tsx:66,
 *   presented at :330)
 * - OnboardingGate's credential banner (\`BANNER_IDS.credential\`)
 * - OnboardingGate's pairing-failure banner (\`BANNER_IDS.pairingFailure\`)
 * - ConnectionBannerSource's offline banner (\`BANNER_IDS.offline\`)
 * - the bundled-service banner (\`BANNER_IDS.bundledService\`)
 *
 * But OnboardingGate presents at most ONE of {pairing-approval, credential,
 * pairing-failure} at a time: \`showCredentialChrome\` (OnboardingGate.tsx:
 * 398-403) is gated \`!pendingApproval && !pairingFailure\`, and the
 * pairing-approval effect (:324-369) only presents while \`pendingApproval\`
 * is set — so credential and pairing-failure are mutually exclusive by
 * construction, and pairing-approval is mutually exclusive with both. A
 * genuinely reachable 4-set is pairing-approval + pairingFailure + offline +
 * bundledService — that is what this fixture asserts. Two-card fixtures
 * (seedBandTwoBlocking) fit comfortably under the portrait 40vh cap and only
 * ever exercise the non-overflow branch there; four real cards is what
 * actually overflows it.
 */
function seedBandFourBlocking() {
  // Each carries an action row, matching its real producer (OnboardingGate's
  // pairing-approval and pairing-failure banners and ConnectionBannerSource's
  // offline banner all present \`actions\`) — a collapsed card's \`detail\`
  // stays hidden behind "More", but its action row does not, and is what
  // actually pushes four real cards past the 40vh cap (measured: ~119px/card
  // with an action row present, vs. ~75px/card without one).
  bannerStore.present({
    // OnboardingGate.tsx:66/:330 — not in BANNER_IDS, so hardcoded here to
    // match the real producer's literal id.
    id: 'chrome:onboarding:pairing-approval',
    priority: BANNER_PRIORITY.connectionBlocking,
    tone: 'info',
    message:
      'Preparing the connection to Dev Server. Waiting for approval on Dev Server…',
    actions: [{ label: 'Cancel request', onClick: () => {} }],
  });
  bannerStore.present({
    id: BANNER_IDS.pairingFailure,
    priority: BANNER_PRIORITY.connectionBlocking,
    tone: 'blocked',
    badge: 'Declined',
    message: 'Dev Server declined this device.',
    actions: [{ label: 'Request access', onClick: () => {} }],
  });
  bannerStore.present({
    id: BANNER_IDS.offline,
    priority: BANNER_PRIORITY.connectionBlocking,
    tone: 'error',
    message:
      "Can't reach Dev Server. Some actions are unavailable until reconnected.",
    actions: [{ label: 'Try now', onClick: () => {} }],
  });
  bannerStore.present({
    id: BANNER_IDS.bundledService,
    priority: BANNER_PRIORITY.connectionBlocking,
    tone: 'warning',
    message: 'The bundled service needs attention.',
    actions: [{ label: 'Open connections', onClick: () => {} }],
  });
}

/**
 * One short, non-blocking banner: the common case (archive#3432) — a bounded, connection-slot stack with a single card is nowhere
 * near its 40vh cap, so it must never be scrollable and must never take
 * pointer events over the message/gap area.
 */
function seedOneShort() {
  bannerStore.present({
    id: 'chrome:harness:one-short',
    priority: BANNER_PRIORITY.info,
    tone: 'info',
    message: 'Connected to Dev Server.',
    dismissible: false,
  });
}

/** Same as seedOneShort, but dismissible, for the exit-animation probe. */
function seedSingleDismissible() {
  bannerStore.present({
    id: 'chrome:harness:single-dismissible',
    priority: BANNER_PRIORITY.info,
    tone: 'info',
    message: 'Connected to Dev Server.',
    dismissible: true,
    dismissAriaLabel: 'Dismiss notice',
  });
}

/**
 * Enough banners across bands that the expanded stack overflows its own
 * 48dvh/520px bound at a real desktop viewport. Ten cards at ~62px each
 * (measured: a one-line message + action + dismiss row) is comfortably past
 * both — the count exists to force real overflow, not to claim a real
 * scenario produces exactly ten.
 */
function seedExpandMany() {
  const bands = [
    BANNER_PRIORITY.connectionBlocking,
    BANNER_PRIORITY.versionMismatch,
    BANNER_PRIORITY.connectionTransient,
    BANNER_PRIORITY.capabilityFailure,
    BANNER_PRIORITY.info,
  ];
  const total = 10;
  for (let index = 0; index < total; index += 1) {
    const priority = bands[index % bands.length];
    bannerStore.present({
      id: \`chrome:harness:\${index}\`,
      priority,
      tone: index % 2 === 0 ? 'warning' : 'info',
      message: \`Notice \${index + 1} of \${total}: this is a realistic one-line summary that takes real width.\`,
      detail:
        'Extra detail text so the card is a representative height once expanded, matching a real disclosure-bearing banner.',
      dismissible: true,
      dismissAriaLabel: \`Dismiss notice \${index + 1}\`,
      actions: [{ label: 'Act', onClick: () => {} }],
    });
  }
}

/**
 * A single connectionBlocking card (archive#3432). Real
 * growth then happens after mount, through \`window.__present\` below, once
 * the test has measured a real card's height and pinned the cap to an exact
 * multiple of it — that is what puts the box in the "already at the cap"
 * state the deps fix targets.
 */
function seedGrowPinned() {
  bannerStore.present({
    id: 'chrome:harness:grow-pinned-0',
    priority: BANNER_PRIORITY.connectionBlocking,
    tone: 'info',
    message: 'Grow test 0',
  });
}

/**
 * Eight identical connectionBlocking cards — comfortably overflowing the
 * desktop 40vh cap — for the shrink-back-to-non-scrollable case
 * (archive#3432). \`window.__dismiss\` below removes them down to one, a
 * real resize that must clear \`--scrollable\` again.
 */
function seedShrinkBack() {
  const total = 8;
  for (let index = 0; index < total; index += 1) {
    bannerStore.present({
      id: \`chrome:harness:shrink-\${index}\`,
      priority: BANNER_PRIORITY.connectionBlocking,
      tone: 'info',
      message: \`Shrink test \${index}\`,
    });
  }
}

const seeders = {
  'band-four-blocking': seedBandFourBlocking,
  'band-two-blocking': seedBandTwoBlocking,
  'expand-many': seedExpandMany,
  'grow-pinned': seedGrowPinned,
  'one-short': seedOneShort,
  'shrink-back': seedShrinkBack,
  'single-dismissible': seedSingleDismissible,
};

seeders[window.__scenario]();

const stage = document.getElementById('stage');
const underneath = document.createElement('button');
underneath.id = 'underneath';
underneath.textContent = 'Underneath';
underneath.style.position = 'absolute';
underneath.style.top = '0';
underneath.style.left = '0';
underneath.style.width = '100%';
underneath.style.height = '100%';
underneath.style.zIndex = '0';
underneath.style.border = 'none';
underneath.style.margin = '0';
underneath.style.padding = '0';
stage.appendChild(underneath);

const host = document.createElement('div');
host.id = 'host-root';
stage.appendChild(host);
createRoot(host).render(<BannerHost connectionSlot />);

// Post-mount mutation hooks for the growth/shrink tests: these route
// through the real bannerStore.present/dismiss, not a second render
// path. That said, what the shrink-back test below actually PROVES is
// narrower than "store vs DOM": a genuine box shrink clears --scrollable
// regardless of what shrank it — the class is keyed to measured layout,
// not to the removal mechanism. Read the assertion as "a real shrink
// clears the class," not as proof this harness can only shrink through
// the store.
(window as unknown as { __present: typeof bannerStore.present }).__present = (
  item,
) => bannerStore.present(item);
(window as unknown as { __dismiss: typeof bannerStore.dismiss }).__dismiss = (
  id,
  opts,
) => bannerStore.dismiss(id, opts);
`;

let harnessScript = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: HARNESS_SOURCE,
      resolveDir: REPO_ROOT,
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' },
    write: false,
    platform: 'browser',
  });
  harnessScript = result.outputFiles[0].text;
  // A bundle that silently resolved to nothing would make every assertion
  // below vacuous.
  expect(harnessScript).toContain('banner-host__stack');
});

/**
 * The real, live stylesheet's parsed rules, read through the CSSOM rather
 * than a second `node:fs` read of the same file (archive#3432). `page.addStyleTag({ path })` is what actually reads
 * `BannerHost.css` from disk (Playwright-side, not this file), so this stays
 * a pure browser-local assertion: proof the injected stylesheet is real and
 * parsed, not a second copy of the file-reading risk `addStyleTag` already
 * carries. Identifies "our" sheet by the one rule name every scenario
 * mounts.
 */
async function bannerStylesheetRules(
  page: Page,
): Promise<{ selectorText: string; cssText: string }[]> {
  return page.evaluate(() => {
    // Recurse into `@media` blocks too — several of the dock-coexistence
    // rules that target `.banner-host` itself (e.g.
    // `.app__main:has(> [data-region="bottom"]) > .banner-host`) are nested inside one.
    function flatten(rules: CSSRuleList): CSSStyleRule[] {
      const out: CSSStyleRule[] = [];
      for (const rule of Array.from(rules)) {
        if ('selectorText' in rule) {
          out.push(rule as CSSStyleRule);
        } else if ('cssRules' in rule) {
          out.push(...flatten((rule as CSSMediaRule).cssRules));
        }
      }
      return out;
    }
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // Cross-origin sheet; not ours.
      }
      const styleRules = flatten(rules);
      if (
        styleRules.some((rule) => rule.selectorText === '.banner-host__stack')
      ) {
        return styleRules.map((rule) => ({
          selectorText: rule.selectorText,
          cssText: rule.cssText,
        }));
      }
    }
    return [];
  });
}

/**
 * A selector that targets the host's OWN box: its rightmost simple selector
 * (after any combinator — `> .banner-host` inside the dock `:has()` rules
 * counts) is `.banner-host` or `.banner-host--<modifier>`.
 * `.banner-host--connection-slot .banner-host__stack` does NOT (its
 * rightmost selector is the inner `__stack`, a genuine descendant).
 */
function isHostOnlySelector(selectorText: string): boolean {
  return selectorText.split(',').some((part) => {
    const rightmost = part.trim().split(/\s+/).filter(Boolean).pop();
    return !!rightmost && /^\.banner-host(--[\w-]+)?$/.test(rightmost);
  });
}

async function mount(page: Page, scenario: Scenario) {
  await page.setContent(
    // `underneath` fills the whole stage as a full-bleed button so "click-
    // through below the stack" can be asserted against ANY point the stack
    // does not itself cover, at any viewport, without hand-tuning a rect per
    // scenario. `--layer-notice`/`--layer-dock` match tokens.css's real
    // values — see the file docblock for why an undefined `--layer-notice`
    // would misrender the cap. A real `<meta name="viewport">` matches the
    // app's own `src-ui/index.html:6` (archive#3432):
    // without it, Chromium's mobile emulation falls back to a ~980px desktop
    // layout viewport even with `isMobile: true`, so a "phone" test measured
    // desktop CSS the whole time and its overflow-dependent branch never ran.
    `<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0">
<div id="stage" style="position:relative;width:100vw;height:100vh;margin:0;background:#fff;--layer-notice:9000;--layer-dock:9200;--motion-base:0.2s;--ease-standard:cubic-bezier(0.4,0,0.2,1);--ease-out:cubic-bezier(0,0,0.2,1);"></div>
</body>
</html>`,
  );
  await page.addStyleTag({ path: BANNER_CSS_PATH });
  const rules = await bannerStylesheetRules(page);
  expect(
    rules.length,
    'BannerHost.css must have loaded as real, parsed CSSOM rules',
  ).toBeGreaterThan(0);
  await page.evaluate((name) => {
    (window as unknown as { __scenario: string }).__scenario = name;
  }, scenario);
  await page.addScriptTag({ content: harnessScript });
  await expect(page.locator('.banner-host')).toBeVisible();
  // archive#3432: assert the actual subject exists before any
  // caller reaches into it. Without this, a mount defect (e.g. the stack
  // never rendering) surfaced as `locator.evaluate: Test timeout of 30000ms
  // exceeded` from deep inside `stackMetrics`/`wheelScroll` rather than a
  // named assertion pointing at the real cause.
  await expect(stackLocator(page)).toBeVisible();
  // Let the entrance animation (`banner-host-enter`, ~200ms) finish before
  // any caller measures geometry. Mid-animation, `.banner-host__item`'s
  // enter keyframe applies a `translateY` TRANSFORM that shifts its PAINTED
  // position without moving its LAYOUT box (transforms never affect layout),
  // so a rect read during it disagreed with the stack's own layout-derived
  // box by exactly the in-flight animation offset (measured live: ~6.7px) —
  // not a real defect, but exactly the kind of false read
  // `expectStackTightlyWrapsContent` exists to rule out, so it cannot be
  // left racing this. Waits on the real `Animation.finished` promises rather
  // than a fixed sleep, so it holds regardless of `--motion-base`'s value
  // (including reduced-motion's near-zero one) and never trips the E2E
  // audit's fixed-sleep pattern.
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.querySelectorAll('.banner-host__item')).flatMap(
        (el) => el.getAnimations().map((a) => a.finished.catch(() => {})),
      ),
    ),
  );
}

/** The stack wrapper that owns the bound, the scroll and the opt-in pointer events. */
function stackLocator(page: Page) {
  return page.locator('.banner-host__stack');
}

async function stackMetrics(page: Page) {
  return stackLocator(page).evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
  }));
}

/**
 * Real wheel input over the stack, not a scripted `scrollTop` write. Polls
 * rather than reading once immediately after: Chromium applies the wheel
 * input's scroll asynchronously relative to `mouse.wheel`'s own resolution,
 * so an immediate read is a race, not a proof of "did not scroll".
 */
async function wheelScroll(page: Page, deltaY: number) {
  const box = await stackLocator(page).boundingBox();
  expect(box, 'stack has no box').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, deltaY);
  await expect
    .poll(async () => (await stackMetrics(page)).scrollTop)
    .toBeGreaterThan(0);
}

/**
 * A point strictly below the stack's own occupied box (or `null` if the
 * viewport is too short to have one). Proves the collapsed host still does
 * not reserve or cover space its content doesn't occupy — a point there must
 * hit the app content underneath, not the host.
 *
 * archive#3432: deliberately NOT derived from
 * `pointBelowLastCard`'s content-anchored point. This one exists to prove the
 * box tracks its content; `expectStackTightlyWrapsContent` below is the
 * assertion that actually pins that relationship, because a point derived
 * from the stack's own box (as this used to be, alone) moves down WITH the
 * box, so a defect that grows the box (e.g. stray padding) grows the "safe"
 * point right along with it and the probe can never observe the one failure
 * mode it exists to guard — proven live: `padding-bottom: 320px` on the stack
 * produced a 496px box with 277px of empty, click-absorbing space below
 * the content, and the box-derived probe still landed on `underneath`, `3 passed`.
 */
async function pointBelowStack(
  page: Page,
  viewportHeight: number,
): Promise<{ x: number; y: number } | null> {
  const box = await stackLocator(page).boundingBox();
  expect(box, 'stack has no box').not.toBeNull();
  const y = box!.y + box!.height + 20;
  if (y >= viewportHeight) return null;
  return { x: box!.x + 10, y };
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * The stack's and its last card's `getBoundingClientRect()`s, read together
 * in ONE `page.evaluate` rather than two separate `locator.boundingBox()`
 * calls. `boundingBox()` goes through Playwright's own CDP box-model
 * conversion per call, which measured a spurious ~2.5px of "overhang"
 * between two boxes that a single native `getBoundingClientRect()` read (no
 * conversion, same frame) measured as byte-for-byte equal — comparing two
 * independently-converted rects is not the same precision as comparing two
 * rects read in the same JS turn.
 */
async function stackAndLastCardRects(
  page: Page,
): Promise<{ stack: Rect | null; lastCard: Rect | null; count: number }> {
  return page.evaluate(() => {
    const toRect = (el: Element | null): Rect | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const stack = document.querySelector('.banner-host__stack');
    const cards = document.querySelectorAll('.banner-host__item');
    return {
      stack: toRect(stack),
      lastCard: toRect(cards[cards.length - 1] ?? null),
      count: cards.length,
    };
  });
}

/**
 * A point strictly below the stack's own CONTENT — the last visible card's
 * bottom — rather than the stack's bounding box. archive#3432: this is the
 * probe that actually discriminates a stray-padding
 * defect, because it does not move when the box grows without the content
 * growing. Paired with `expectStackTightlyWrapsContent`, which asserts the
 * box SHOULD equal this point's origin; together they prove both that the
 * box is the right size, and that a point just past the content reaches the
 * app underneath.
 */
async function pointBelowLastCard(
  page: Page,
  viewportHeight: number,
): Promise<{ x: number; y: number } | null> {
  const { lastCard, count } = await stackAndLastCardRects(page);
  expect(count, 'no cards to derive a probe point from').toBeGreaterThan(0);
  expect(lastCard, 'last card has no box').not.toBeNull();
  const y = lastCard!.y + lastCard!.height + 20;
  if (y >= viewportHeight) return null;
  return { x: lastCard!.x + 10, y };
}

/**
 * `.banner-host__stack` has no padding of its own (only `gap` between
 * cards — see `BannerHost.css`), so its box must tightly wrap its own last
 * card, modulo sub-pixel layout rounding. archive#3432: this
 * is the direct guard against the class of defect `pointBelowStack` cannot
 * see (a stray `padding`/`min-height` that grows the box past its content) —
 * asserted here as an upper bound on the box itself, not only inferred from
 * where a click happens to land. The 1px tolerance is real sub-pixel layout
 * rounding, not a fudge for the defect this exists to catch: that defect
 * (`padding-bottom: 320px` on the stack) measures 277px of
 * overhang, two orders of magnitude past this tolerance.
 */
async function expectStackTightlyWrapsContent(page: Page) {
  const { stack, lastCard, count } = await stackAndLastCardRects(page);
  expect(stack, 'stack has no box').not.toBeNull();
  expect(count, 'no cards to compare against').toBeGreaterThan(0);
  expect(lastCard, 'last card has no box').not.toBeNull();
  const overhang = stack!.y + stack!.height - (lastCard!.y + lastCard!.height);
  expect(
    overhang,
    `stack box must not extend past its own last card (measured ${overhang}px of overhang)`,
  ).toBeLessThanOrEqual(1);
}

async function elementIdAt(page: Page, point: { x: number; y: number }) {
  return page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.id ?? 'none',
    [point.x, point.y],
  );
}

test.describe('the connectionBlocking band never collapses and always scrolls (station#3432)', () => {
  test.use({
    viewport: { width: 915, height: 412 },
    hasTouch: true,
    isMobile: true,
  });

  test('phone landscape: two blocking banners overflow, scroll by wheel, and the last action stays hit-testable', async ({
    page,
  }) => {
    await mount(page, 'band-two-blocking');

    const before = await stackMetrics(page);
    expect(
      before.scrollHeight,
      'stack must genuinely overflow its own bound for this to be a real test of scrolling',
    ).toBeGreaterThan(before.clientHeight);

    // Both blocking banners are in the DOM at once — the band-collapse
    // contract — and neither is clipped: querying each card's own
    // scrollHeight vs clientHeight would show clipping if `.banner-host__item`
    // were still compressing content instead of the stack overflowing.
    const cards = page.locator('.banner-host__item');
    await expect(cards).toHaveCount(2);
    for (let i = 0; i < 2; i += 1) {
      const inner = cards.nth(i).locator('.banner-host__item-inner');
      const metrics = await inner.evaluate((el) => ({
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }));
      expect(
        metrics.scrollHeight,
        `card ${i} content must not be clipped (its own overflow:hidden must never need to hide anything)`,
      ).toBeLessThanOrEqual(metrics.clientHeight + 1);
    }

    await wheelScroll(page, 600);
    const after = await stackMetrics(page);
    expect(after.scrollTop, 'wheel input must move the stack').toBeGreaterThan(
      0,
    );

    // The second banner's own action button — the one the original report
    // named as unreachable — must be genuinely hit-testable at its own
    // center, not just present in the accessibility tree.
    const secondAction = cards.nth(1).getByRole('button', {
      name: 'Request access',
    });
    await expect(secondAction).toBeVisible();
    const actionBox = await secondAction.boundingBox();
    expect(actionBox, 'action button has no box').not.toBeNull();
    // Not asserting >= MIN_TOUCH_TARGET_PX here: the mobile breakpoint
    // deliberately sets `.banner-host__action { min-height: 42px }` (below
    // the 44px floor used elsewhere), a pre-existing, unrelated product
    // choice. The claim under test is reachability
    // (hit-testable at its own center), not target sizing.
    const owner = await page.evaluate(
      ([x, y]) => {
        const element = document.elementFromPoint(x, y);
        return element
          ? `${element.tagName.toLowerCase()}.${(typeof element.className === 'string' ? element.className : '').trim().split(/\s+/).join('.')}`
          : 'none';
      },
      [
        actionBox!.x + actionBox!.width / 2,
        actionBox!.y + actionBox!.height / 2,
      ],
    );
    expect(owner).toContain('banner-host__action');
    await secondAction.click({ trial: true, timeout: 3_000 });

    // The stack's box must not extend past its own content (archive#3432),
    // and a point just past the last card — not the box —
    // must resolve to the app content beneath it, not to the host.
    await expectStackTightlyWrapsContent(page);
    const belowBox = await pointBelowStack(page, 412);
    if (belowBox) {
      expect(await elementIdAt(page, belowBox)).toBe('underneath');
    }
    const belowContent = await pointBelowLastCard(page, 412);
    if (belowContent) {
      expect(await elementIdAt(page, belowContent)).toBe('underneath');
    }
  });

  test('portrait phone: the band renders on the real mobile layout, scrolls if it overflows, and stays click-through beneath either way', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await mount(page, 'band-two-blocking');
    const metrics = await stackMetrics(page);
    // archive#3432: with the real viewport meta in place,
    // `window.innerHeight` is the real 915px (measured) — WITHOUT it,
    // Chromium's `isMobile: true` fallback reported innerHeight 2195, so
    // `max-height: 40vh` was actually computing against a viewport that does
    // not exist (≈878px), not the 366px this test's own comment always
    // claimed, and the mobile two-row card layout that renders at a real
    // ~412px width (vs. a runaway ~980px fallback width) never applied
    // either. Real numbers now (measured): two `connectionBlocking` cards in
    // the real mobile layout total 238px — genuinely UNDER 40vh of 915px
    // (366px). That is not a defect: 40vh in portrait is generous enough
    // that two banners in the issue's own scenario don't need to scroll at
    // all; scrolling-when-overflowing is what the landscape test above (a
    // much shorter viewport) and the desktop expanded-stack test below both
    // exercise for real. What matters here is that this is no longer a dead
    // conditional — every path below asserts something concrete about
    // measured reality, none is silently skipped.
    if (metrics.scrollHeight > metrics.clientHeight) {
      await wheelScroll(page, 600);
      const after = await stackMetrics(page);
      expect(after.scrollTop).toBeGreaterThan(0);
      await expect(stackLocator(page)).toHaveClass(
        /banner-host__stack--scrollable/,
      );
    } else {
      await expect(stackLocator(page)).not.toHaveClass(
        /banner-host__stack--scrollable/,
      );
      await expect(stackLocator(page)).toHaveCSS('pointer-events', 'none');
    }

    await expectStackTightlyWrapsContent(page);
    const below = await pointBelowLastCard(page, 915);
    expect(
      below,
      'portrait must have room below a 2-banner band',
    ).not.toBeNull();
    expect(await elementIdAt(page, below!)).toBe('underneath');
  });

  test('portrait phone: four real connectionBlocking banners overflow the 40vh cap and the stack scrolls (station#3432 round 3, LOW-4)', async ({
    page,
  }) => {
    // The two-banner fixture above measures 238px against a 366px cap — it
    // proves only the non-overflow `else` branch. `buildBannerStackView`
    // renders every live connectionBlocking member, and (see
    // seedBandFourBlocking's docblock) a genuinely reachable 4-set is
    // OnboardingGate's pairing-approval banner + its pairingFailure banner +
    // ConnectionBannerSource's offline banner + BundledServiceBanner's
    // BANNER_IDS.bundledService — OnboardingGate's credential and
    // pairingFailure banners cannot co-occur, so they are not both in this
    // set. This fixture makes the `if` (scrollable) branch live rather than
    // dead-by-measurement.
    await page.setViewportSize({ width: 412, height: 915 });
    await mount(page, 'band-four-blocking');

    const metrics = await stackMetrics(page);
    expect(
      metrics.scrollHeight,
      'four real connectionBlocking banners must overflow the 40vh cap for this to exercise the scrollable branch',
    ).toBeGreaterThan(metrics.clientHeight);

    await expect(stackLocator(page)).toHaveClass(
      /banner-host__stack--scrollable/,
    );
    await expect(stackLocator(page)).toHaveCSS('pointer-events', 'auto');

    await wheelScroll(page, 600);
    const after = await stackMetrics(page);
    expect(after.scrollTop).toBeGreaterThan(0);

    await expectStackTightlyWrapsContent(page);
  });
});

test.describe('the stack only takes pointer events when it is genuinely scrollable (station#3432 round 2, HIGH-1)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('one short banner never becomes scrollable, and the whole card area stays click-through', async ({
    page,
  }) => {
    await mount(page, 'one-short');

    const metrics = await stackMetrics(page);
    expect(
      metrics.scrollHeight,
      'a single short banner must not overflow the 40vh bound',
    ).toBeLessThanOrEqual(metrics.clientHeight + 1);
    await expect(stackLocator(page)).not.toHaveClass(
      /banner-host__stack--scrollable/,
    );
    await expect(stackLocator(page)).toHaveCSS('pointer-events', 'none');

    // The message area is deliberately not a control (archive#3432):
    // probing its own center must reach the app underneath, not an
    // invisible wrapper — the exact regression this guards is
    // `.banner-host__stack` having `pointer-events: auto`
    // unconditionally, which made this probe resolve to
    // `div.banner-host__stack` instead of `#underneath`.
    const message = page.locator('.banner-host__message').first();
    const box = await message.boundingBox();
    expect(box, 'message has no box').not.toBeNull();
    const center = {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
    };
    expect(await elementIdAt(page, center)).toBe('underneath');

    // And the gap below the single card, still inside the stack's bound,
    // must also be click-through.
    await expectStackTightlyWrapsContent(page);
    const below = await pointBelowLastCard(page, 900);
    expect(below, 'desktop must have room below one card').not.toBeNull();
    expect(await elementIdAt(page, below!)).toBe('underneath');
  });

  test('a dismissed card never traps a click while it exits (station#3432 round 2, LOW-3)', async ({
    page,
  }) => {
    await mount(page, 'single-dismissible');
    const metrics = await stackMetrics(page);
    expect(
      metrics.scrollHeight,
      'fixture must be non-overflowing for this to test the click-through case',
    ).toBeLessThanOrEqual(metrics.clientHeight + 1);

    const message = page.locator('.banner-host__message').first();
    const box = await message.boundingBox();
    expect(box, 'message has no box').not.toBeNull();
    const probe = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

    const dismiss = page.getByRole('button', { name: 'Dismiss notice' });
    await expect(dismiss).toBeVisible();

    // Sample every real animation frame across the whole ~200ms exit
    // transition (`--motion-base`), not just before/after: an 8px
    // overhang was measured at t+1ms and t+144ms (0 at t+170ms) where the
    // item's exit TRANSFORM had visually moved its content while the
    // collapsing layout box had not yet caught up — a moment
    // `.banner-host__stack--scrollable` must never be true for a fixture
    // that never overflows, so the message-area point must stay
    // click-through at every sampled instant, not just at rest. Sampling via
    // `requestAnimationFrame` inside one `page.evaluate` (rather than
    // `page.waitForTimeout` polling from the Playwright side) both avoids the
    // E2E product-suite audit's fixed-sleep pattern and samples at the
    // browser's real frame rate instead of an arbitrary poll interval; the
    // dismiss click happens inside the same evaluate so sampling starts in
    // the same task as the click, with no round-trip gap between them.
    const samples = await page.evaluate(
      ({ x, y, durationMs }) => {
        return new Promise<{ t: number; owner: string; scrollable: boolean }[]>(
          (resolve) => {
            const stack = document.querySelector('.banner-host__stack');
            const dismissButton = document.querySelector(
              '.banner-host__dismiss',
            ) as HTMLButtonElement | null;
            const out: { t: number; owner: string; scrollable: boolean }[] = [];
            const start = performance.now();
            dismissButton?.click();
            function tick() {
              const el = document.elementFromPoint(x, y);
              out.push({
                t: performance.now() - start,
                owner: el?.id ?? 'none',
                scrollable:
                  stack?.classList.contains('banner-host__stack--scrollable') ??
                  false,
              });
              if (performance.now() - start < durationMs) {
                requestAnimationFrame(tick);
              } else {
                resolve(out);
              }
            }
            requestAnimationFrame(tick);
          },
        );
      },
      { x: probe.x, y: probe.y, durationMs: 260 },
    );
    expect(samples.length, 'no animation frames were sampled').toBeGreaterThan(
      0,
    );
    const bad = samples.filter((s) => s.owner !== 'underneath' || s.scrollable);
    expect(
      bad,
      `some animation frame swallowed the point or marked the stack scrollable: ${JSON.stringify(samples)}`,
    ).toEqual([]);
  });
});

test.describe('the host itself never grants pointer-events, in any mode (station#3432 round 2, MEDIUM-2)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no `.banner-host`/`.banner-host--*` rule sets pointer-events: auto on the host's own box", async ({
    page,
  }) => {
    await mount(page, 'band-two-blocking');
    const rules = await bannerStylesheetRules(page);
    const hostRules = rules.filter((rule) =>
      isHostOnlySelector(rule.selectorText),
    );
    expect(
      hostRules.length,
      'expected at least the base .banner-host rule',
    ).toBeGreaterThan(0);
    for (const rule of hostRules) {
      expect(rule.cssText, rule.selectorText).not.toMatch(
        /pointer-events:\s*auto/,
      );
    }
    await expect(page.locator('.banner-host')).toHaveCSS(
      'pointer-events',
      'none',
    );
  });

  test('only `.banner-host__stack--scrollable` grants pointer-events: auto to the stack', async ({
    page,
  }) => {
    await mount(page, 'band-two-blocking');
    const rules = await bannerStylesheetRules(page);
    for (const rule of [
      '.banner-host--connection-slot .banner-host__stack',
      '.banner-host--expanded .banner-host__stack',
    ]) {
      const match = rules.find((r) => r.selectorText === rule);
      expect(match, `missing rule: ${rule}`).toBeDefined();
      expect(match!.cssText, rule).not.toMatch(/pointer-events:\s*auto/);
    }
    const scrollable = rules.find(
      (r) => r.selectorText === '.banner-host__stack--scrollable',
    );
    expect(scrollable, 'missing .banner-host__stack--scrollable').toBeDefined();
    expect(scrollable!.cssText).toMatch(/pointer-events:\s*auto/);
  });
});

test.describe('the expanded stack scrolls internally (station#3432, pre-existing gap)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('desktop: five banners overflow the expanded bound and scroll by wheel', async ({
    page,
  }) => {
    await mount(page, 'expand-many');
    // Trigger expansion through the real control, matching how a user
    // reaches this state, not by poking React state directly.
    const cap = page.getByTestId('banner-stack-cap');
    await expect(cap).toBeVisible();
    await cap.click();
    await expect(page.locator('.banner-host')).toHaveAttribute(
      'data-expanded',
      'true',
    );

    const metrics = await stackMetrics(page);
    expect(
      metrics.scrollHeight,
      'five real banners in the expanded stack must overflow its bound for this to test scrolling',
    ).toBeGreaterThan(metrics.clientHeight);
    await expect(stackLocator(page)).toHaveClass(
      /banner-host__stack--scrollable/,
    );

    await wheelScroll(page, 800);
    const after = await stackMetrics(page);
    expect(after.scrollTop).toBeGreaterThan(0);

    // The last card's dismiss control must be reachable once scrolled.
    const lastDismiss = page
      .locator('.banner-host__item')
      .last()
      .getByRole('button', { name: /Dismiss/ });
    await expect(lastDismiss).toBeVisible();
    await lastDismiss.click({ trial: true, timeout: 3_000 });

    // archive#3432: the stack must not extend past its own
    // last card even while expanded. Scroll to the true programmatic max
    // first (a script write here, not another real-wheel proof — that proof
    // already happened above) so the check is not confounded by how far the
    // one wheel event above happened to move `scrollTop`: at anything short
    // of true max scroll, "the last card isn't at the bottom yet" and "a
    // stray padding is holding it away from the bottom" are indistinguishable.
    await stackLocator(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expectStackTightlyWrapsContent(page);
  });
});

test.describe('the derivation re-runs on every banner-set change, not only when the box resizes (station#3432 round 3)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('content added after the box is already pinned at the cap makes the stack scrollable (MEDIUM-1)', async ({
    page,
  }) => {
    await mount(page, 'grow-pinned');

    // Measure one real card's own height and the stack's own gap, uncapped
    // (a single card is nowhere near 40vh of 900px), then pin the cap to an
    // EXACT multiple of that height via an injected override. That puts the
    // stack's own border-box size at the cap from the moment it has that
    // many cards — no epsilon-hunting required, because CSS `max-height`
    // clamps the box to the same pixel value regardless of how far the
    // (uncapped) content would otherwise exceed it.
    const { cardHeight, gap } = await page.evaluate(() => {
      const item = document.querySelector('.banner-host__item');
      const stack = document.querySelector('.banner-host__stack');
      if (!item || !stack) throw new Error('fixture did not render');
      const rowGap = Number.parseFloat(getComputedStyle(stack).rowGap || '0');
      return { cardHeight: item.getBoundingClientRect().height, gap: rowGap };
    });
    expect(cardHeight, 'card has no measurable height').toBeGreaterThan(0);

    const CARDS_AT_CAP = 3;
    const capPx = Math.round(
      CARDS_AT_CAP * cardHeight + (CARDS_AT_CAP - 1) * gap,
    );
    await page.addStyleTag({
      content: `.banner-host--connection-slot .banner-host__stack { max-height: ${capPx}px !important; }`,
    });

    // Grow to exactly fill the (now pinned) cap. This IS a real resize —
    // the box moves from its single-card size to `capPx` — so ResizeObserver
    // catches it correctly regardless of the deps bug; it is the baseline
    // this test's "stuck" step below is contrasted against.
    await page.evaluate((count) => {
      for (let index = 1; index < count; index += 1) {
        (
          window as unknown as {
            __present: (item: unknown) => void;
          }
        ).__present({
          id: `chrome:harness:grow-pinned-${index}`,
          priority: 100,
          tone: 'info',
          message: `Grow test ${index}`,
        });
      }
    }, CARDS_AT_CAP);
    await expect(page.locator('.banner-host__item')).toHaveCount(CARDS_AT_CAP);
    await expect
      .poll(async () => (await stackMetrics(page)).clientHeight)
      .toBe(capPx);

    const atCap = await stackMetrics(page);
    expect(
      atCap.scrollHeight - atCap.clientHeight,
      'the box must be pinned exactly at the cap for this to test the stuck case',
    ).toBeLessThanOrEqual(1);
    await expect(stackLocator(page)).not.toHaveClass(
      /banner-host__stack--scrollable/,
    );

    // One more card: content overflows well past the cap now, but the
    // stack's own border-box size is already clamped at `capPx` and does
    // NOT change — no ResizeObserver callback fires for this addition. Only
    // the effect re-running on the `banners` dep (a real store change, not a
    // resize) can catch this.
    await page.evaluate(() => {
      (window as unknown as { __present: (item: unknown) => void }).__present({
        id: 'chrome:harness:grow-pinned-overflow',
        priority: 100,
        tone: 'info',
        message: 'Grow test overflow',
      });
    });
    await expect(page.locator('.banner-host__item')).toHaveCount(
      CARDS_AT_CAP + 1,
    );

    const grown = await stackMetrics(page);
    expect(
      grown.clientHeight,
      'the box must not have resized — this is what makes RO alone insufficient',
    ).toBe(capPx);
    expect(
      grown.scrollHeight - grown.clientHeight,
      'content must genuinely overflow now',
    ).toBeGreaterThan(cardHeight * 0.5);

    await expect(stackLocator(page)).toHaveClass(
      /banner-host__stack--scrollable/,
    );
    await expect(stackLocator(page)).toHaveCSS('pointer-events', 'auto');
    await wheelScroll(page, 200);
  });

  test('an overflowing stack that shrinks back stops being scrollable (MEDIUM-2)', async ({
    page,
  }) => {
    await mount(page, 'shrink-back');

    const overflowing = await stackMetrics(page);
    expect(
      overflowing.scrollHeight,
      'eight real cards must overflow the desktop 40vh cap to start scrollable',
    ).toBeGreaterThan(overflowing.clientHeight);
    await expect(stackLocator(page)).toHaveClass(
      /banner-host__stack--scrollable/,
    );

    // Remove cards down to one — a genuine shrink (the box is no longer
    // capped once content fits, so `clientHeight` follows content back
    // down), which must clear the class again. A write-once derivation
    // (`prev || measure()`) passes every test that only ever grows and is
    // caught only here.
    await page.evaluate(() => {
      const dismiss = (
        window as unknown as {
          __dismiss: (id: string, opts?: { reason?: string }) => void;
        }
      ).__dismiss;
      for (let index = 1; index < 8; index += 1) {
        dismiss(`chrome:harness:shrink-${index}`);
      }
    });
    await expect(page.locator('.banner-host__item')).toHaveCount(1);

    const shrunk = await stackMetrics(page);
    expect(
      shrunk.scrollHeight,
      'one card must fit under the cap for this to test the reverse transition',
    ).toBeLessThanOrEqual(shrunk.clientHeight + 1);
    await expect(stackLocator(page)).not.toHaveClass(
      /banner-host__stack--scrollable/,
    );
    await expect(stackLocator(page)).toHaveCSS('pointer-events', 'none');
  });
});
