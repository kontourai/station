import { expect, type Page, type Route } from '@playwright/test';
import { test } from './helpers/fixture-audit';

/**
 * The white-label theme's first-paint path (#2836): `main.tsx` applies the
 * last validated branding theme from localStorage before the first render,
 * re-validating it, and BrandingThemeBridge replaces it once
 * `/api/branding` answers. Unit tests cover the helpers; this proves the
 * built app actually calls them, in order, on `<html>`.
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

/** Holds every `/api/branding` request until `release` answers them. */
async function holdBranding(page: Page) {
  const held: Route[] = [];
  let answer: unknown = null;
  await page.route('**/api/branding', async (route) => {
    if (answer) {
      await route.fulfill({ json: answer });
      return;
    }
    held.push(route);
  });
  return {
    requested: () => held.length > 0,
    async release(theme: unknown) {
      answer = {
        success: true,
        data: { name: 'Station', logo: null, theme, welcomeMessage: null },
      };
      for (const route of held.splice(0)) await route.fulfill({ json: answer });
    },
  };
}

const inlineFocus = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--k-focus'),
  );

test('applies the cached branding theme before /api/branding answers, then the live one', async ({
  page,
}) => {
  await seedCache(page, { dark: { '--k-focus': '#93c5fd' } });
  const branding = await holdBranding(page);
  await page.goto('/');

  // The request is still held, so only the pre-render path can have set it.
  await expect.poll(branding.requested).toBe(true);
  expect(await inlineFocus(page)).toBe('#93c5fd');

  await branding.release({ dark: { '--k-focus': '#fbbf24' } });
  await expect.poll(() => inlineFocus(page)).toBe('#fbbf24');
});

test('re-validates the cache and applies nothing from a hostile one', async ({
  page,
}) => {
  await seedCache(page, {
    dark: { '--k-focus': 'red; background:url(x)', '--k-brand': '#60a5fa' },
  });
  const branding = await holdBranding(page);
  await page.goto('/');

  await expect.poll(branding.requested).toBe(true);
  expect(await inlineFocus(page)).toBe('');
  expect(
    await page.evaluate(
      () => document.documentElement.getAttribute('style') ?? '',
    ),
  ).not.toContain('--k-brand');
  await branding.release(null);
});
