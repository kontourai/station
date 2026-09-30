import { expect, type Page, type Route } from '@playwright/test';
import { test } from './helpers/fixture-audit';

/**
 * The white-label theme's first-paint path (#2836): `main.tsx` applies the
 * last validated branding theme from localStorage before the first render,
 * re-validating it, and BrandingThemeBridge replaces it once the server's
 * branding answer arrives. Unit tests cover the helpers; this proves the
 * built app actually calls them, in order, on `<html>`.
 *
 * The server's branding answer reaches the app two ways: `GET /api/branding`
 * and the `branding` section of the aggregate `GET /api/boot`, which
 * AuthorityQueryContext seeds into the same query. Both are held back here —
 * the boot section is answered as an error section, which the seeder skips —
 * so until `release`, the only thing that can put a theme on `<html>` is the
 * pre-render path. Without holding the boot section, the seeded
 * `theme: null` clears the cached theme within about a second and the first
 * assertion becomes a race.
 */

const CACHE_KEY = 'station-branding-theme-v1';

async function seedCache(page: Page, value: unknown) {
  await page.addInitScript(
    ([key, raw]) => {
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
      localStorage.setItem(key, raw);
    },
    [CACHE_KEY, JSON.stringify(value)] as const,
  );
}

/**
 * Holds every `/api/branding` request until `release` answers them, and
 * strips the `branding` section from `/api/boot` (answered as an error
 * section) so the boot seed cannot stand in for the held answer.
 */
async function holdBranding(page: Page) {
  const held: Route[] = [];
  let answer: unknown = null;
  let bootStripped = false;
  await page.route('**/api/boot', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    if (payload?.sections && typeof payload.sections === 'object') {
      payload.sections.branding = { error: 'held by branding-theme-boot.spec' };
      bootStripped = true;
    }
    await route.fulfill({ response, json: payload });
  });
  await page.route('**/api/branding', async (route) => {
    if (answer) {
      await route.fulfill({ json: answer });
      return;
    }
    held.push(route);
  });
  return {
    requested: () => held.length > 0,
    bootStripped: () => bootStripped,
    async release(theme: unknown) {
      answer = {
        success: true,
        data: { name: 'Station', logo: null, theme, welcomeMessage: null },
      };
      for (const route of held.splice(0)) await route.fulfill({ json: answer });
    },
  };
}

/**
 * Records, from inside the page and from before the first render, every
 * value the inline `--k-focus` and `--k-brand` on `<html>` take. A cached
 * theme cleared early (and re-applied later) shows up as a `''` in the
 * history instead of depending on when a poll happens to read.
 */
async function recordInlineHistory(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __brandingHistory?: string[] };
    w.__brandingHistory = [];
    // Neither property set; other inline-style writes on <html> are ignored.
    let last = '|';
    const record = () => {
      const style = document.documentElement?.style;
      if (!style) return;
      const value = `${style.getPropertyValue('--k-focus')}|${style.getPropertyValue('--k-brand')}`;
      if (value === last) return;
      last = value;
      w.__brandingHistory?.push(value);
    };
    new MutationObserver(record).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
  });
}

const inlineFocus = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--k-focus'),
  );

const brandFocusMarked = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.hasAttribute('data-brand-focus'),
  );

const inlineHistory = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __brandingHistory?: string[] })
        .__brandingHistory ?? [],
  );

test('applies the cached branding theme before the server answers, then the live one', async ({
  page,
}) => {
  await seedCache(page, { dark: { '--k-focus': '#93c5fd' } });
  await recordInlineHistory(page);
  const branding = await holdBranding(page);
  await page.goto('/');

  // The app has mounted and asked for branding; both answers are held, so
  // only the pre-render path can have set the theme.
  await expect.poll(branding.requested).toBe(true);
  await expect.poll(branding.bootStripped).toBe(true);
  expect(await inlineFocus(page)).toBe('#93c5fd');
  // The pre-render path also marks the root, so the theme's focus colour
  // (not the device accent) paints the ring from first paint.
  expect(await brandFocusMarked(page)).toBe(true);

  await branding.release({ dark: { '--k-focus': '#fbbf24' } });
  await expect.poll(() => inlineFocus(page)).toBe('#fbbf24');
  // Applied at first paint and never cleared before the live answer.
  expect(await inlineHistory(page)).toEqual(['#93c5fd|', '#fbbf24|']);
});

test('re-validates the cache and applies nothing from a hostile one', async ({
  page,
}) => {
  // `--k-brand` alone is valid for dark; the hostile focus value makes the
  // whole cached theme invalid, so neither may ever be written.
  await seedCache(page, {
    dark: { '--k-focus': 'red; background:url(x)', '--k-brand': '#60a5fa' },
  });
  await recordInlineHistory(page);
  const branding = await holdBranding(page);
  await page.goto('/');

  await expect.poll(branding.requested).toBe(true);
  await expect.poll(branding.bootStripped).toBe(true);
  // The pre-render path ran before the app mounted; nothing was ever written.
  expect(await inlineHistory(page)).toEqual([]);
  expect(await brandFocusMarked(page)).toBe(false);
  await branding.release(null);
});
