/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { act, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';
import {
  bannerReservedHeight,
  bannerStore,
} from '../../../contexts/banner-store';
import { BANNER_RESERVED_HEIGHT_PROPERTY, BannerHost } from '../BannerHost';

/**
 * The banner stack reserves the space it occupies, and a collapse is a real
 * height tween that the app-wide reduced-motion primitive refuses.
 *
 * `BannerHost.reserve.test.tsx` proves the host PUBLISHES the reserved height
 * (jsdom, stubbed geometry). This file proves what the published height DOES
 * under the real cascade — `index.css` (which inlines `tokens.css` and its
 * motion primitive) plus `BannerHost.css` — in Chromium, where a rule lost to
 * specificity, the wrong ancestor chain, or a reduced-motion override would
 * show up as geometry or as a missing transition, not as a regex miss.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const BANNER_CSS_PATH = resolve(HERE, '../BannerHost.css');

function buildFixtureHtml(bannerMarkup: string): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(BANNER_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  // The shell's shape around the host: `.app__main` holds a toolbar-height
  // band, the absolutely positioned host, and `.main-content`. `#probe` is the
  // first thing a view paints, so its top is where content starts.
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${css}</style>
  </head>
  <body style="margin:0">
    <div class="app__main" style="height:700px;--app-toolbar-total-height:46px">
      <div style="height:46px;flex:none"></div>
      ${bannerMarkup}
      <div class="main-content"><div id="probe" style="height:20px"></div></div>
    </div>
  </body>
</html>`;
}

function renderBannerMarkup(): string {
  act(() => {
    bannerStore.present({
      id: 'test:blocking',
      priority: 100,
      tone: 'blocked',
      badge: 'Credential required',
      message: 'Station cannot reach this host until you pair again.',
      actions: [{ label: 'Pair again', onClick: () => {} }],
    });
  });
  const { container, unmount } = render(<BannerHost />);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

async function top(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .evaluate((el) => el.getBoundingClientRect().top);
}

/** Durations of the running CSS transitions on `selector`, by property. */
async function transitions(
  page: Page,
  selector: string,
): Promise<Record<string, number>> {
  return page.locator(selector).evaluate((el) =>
    Object.fromEntries(
      el
        .getAnimations()
        .filter((animation) => 'transitionProperty' in animation)
        .map((animation) => [
          (animation as CSSTransition).transitionProperty,
          Number(animation.effect?.getTiming().duration ?? 0),
        ]),
    ),
  );
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'BannerHost reservation and collapse tween under the real cascade',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    afterEach(() => {
      act(() => bannerStore.reset());
    });

    async function openFixture(reducedMotion: 'reduce' | 'no-preference') {
      const page = await browser.newPage({
        viewport: { width: 1024, height: 768 },
      });
      await page.emulateMedia({ reducedMotion });
      await page.setContent(buildFixtureHtml(renderBannerMarkup()));
      return page;
    }

    async function publishReservation(page: Page) {
      // Measure the settled card, not a frame of its entrance animation.
      await page.waitForFunction(
        () =>
          document.querySelector('.banner-host__item')?.getAnimations()
            .length === 0,
        undefined,
        { timeout: 2_000 },
      );
      const hostTop = await top(page, '.banner-host');
      const cardBottom = await page
        .locator('.banner-host__item')
        .evaluate((el) => el.getBoundingClientRect().bottom);
      const reserved = bannerReservedHeight(hostTop, [
        { reserves: true, bottom: cardBottom },
      ]);
      expect(reserved).toBeGreaterThan(0);
      // What `BannerHost` writes onto its container once it has measured.
      await page.evaluate(
        ([property, value]) =>
          document
            .querySelector<HTMLElement>('.app__main')
            ?.style.setProperty(property, value),
        [BANNER_RESERVED_HEIGHT_PROPERTY, `${reserved}px`],
      );
      return cardBottom;
    }

    test.each(['no-preference', 'reduce'] as const)(
      'content starts below the banner once its height is published (%s motion)',
      async (reducedMotion) => {
        const page = await openFixture(reducedMotion);
        try {
          // Negative control: with nothing published the content sits under
          // the absolutely positioned card, so the inset below is not free.
          const cardBottomBefore = await page
            .locator('.banner-host__item')
            .evaluate((el) => el.getBoundingClientRect().bottom);
          expect(await top(page, '#probe')).toBeLessThan(cardBottomBefore - 20);

          const cardBottom = await publishReservation(page);
          // Reduced motion refuses the move into place, never the inset.
          await page.waitForFunction(
            (bottom) =>
              Math.abs(
                (document.querySelector('#probe')?.getBoundingClientRect()
                  .top ?? 0) - bottom,
              ) < 1,
            cardBottom,
            { timeout: 2_000 },
          );
          expect(
            Math.abs((await top(page, '#probe')) - cardBottom),
          ).toBeLessThan(1);
        } finally {
          await page.close();
        }
      },
    );

    test('the inset and a collapse tween, and reduced motion refuses both tweens', async () => {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        const page = await openFixture(reducedMotion);
        try {
          await publishReservation(page);
          const inset = await transitions(page, '.main-content');

          // The expanded end is a measured length (`BannerHost` writes it
          // from the content row), so collapsing interpolates `height`. At
          // least 120px so the collapsed bar is visibly shorter at this width.
          const card = page.locator('.banner-host__item');
          const naturalHeight = Math.max(
            120,
            await card.evaluate((el) => el.getBoundingClientRect().height),
          );
          await card.evaluate((el, height) => {
            (el as HTMLElement).style.setProperty(
              '--banner-natural-height',
              `${height}px`,
            );
            el.getBoundingClientRect();
            el.classList.add('banner-host__item--collapsed');
          }, naturalHeight);
          const collapse = await transitions(page, '.banner-host__item');

          if (reducedMotion === 'no-preference') {
            expect(
              inset['padding-top'] ?? 0,
              'no padding-top transition on the content inset',
            ).toBeGreaterThan(1);
            expect(
              collapse.height ?? 0,
              'no height transition on collapse',
            ).toBeGreaterThan(1);
          } else {
            expect(
              inset['padding-top'] ?? 0,
              'reduced motion must refuse the inset tween',
            ).toBeLessThan(1);
            expect(
              collapse.height ?? 0,
              'reduced motion must refuse the collapse tween',
            ).toBeLessThan(1);
          }
          // Either way the collapsed card settles on a non-zero bar.
          await page.waitForFunction(
            () => {
              const el = document.querySelector('.banner-host__item');
              return el !== null && el.getAnimations().length === 0;
            },
            undefined,
            { timeout: 2_000 },
          );
          const collapsed = await card.evaluate(
            (el) => el.getBoundingClientRect().height,
          );
          expect(collapsed).toBeGreaterThan(0);
          expect(collapsed).toBeLessThan(naturalHeight);
        } finally {
          await page.close();
        }
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'BannerHost reservation cascade — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the banner ' +
        'content inset and collapse tween could not be measured — this is a ' +
        'missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
