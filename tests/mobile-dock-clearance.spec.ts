import { expect, type Page, test } from '@playwright/test';
import { dismissSetupLauncher } from './helpers/orchestration';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

/**
 * station#3902 — the chat dock is shell chrome (`App.tsx`), so no route can
 * reserve space for it, and every route needs the space reserved anyway.
 *
 * `/connections/models/new` is the subject because it is the route the phone
 * first-run journey lands on with nothing between the reader and a grid of
 * provider tiles — but the fix is in the shell (`.content-view` reserves
 * `--dock-bottom-clearance`), so this spec is about the shell's contract and
 * this route is its witness.
 *
 * WHY THE SAFE-AREA INSET IS SET BY HAND. The defect is that the shell
 * reserved `var(--dock-slot-size)` while the dock's rendered bar is
 * `calc(--chat-dock-header-height + --safe-bottom)` tall (`ChatDock.tsx`) —
 * so the overlap is exactly the device's bottom inset, and there is no
 * overlap at all on a device that has none. `env(safe-area-inset-bottom)` is
 * always 0 in headless Chromium and Playwright has no emulation for it, so a
 * spec that did not set it would pass on the broken build: a conditional
 * green. `--safe-bottom` (index.css) is the token whose ONLY source is that
 * env(), so writing it is the faithful stand-in for the phone this is about.
 */

const PHONE_SAFE_AREA_BOTTOM_PX = 34;

async function openProviderPickerOnAPhone(page: Page) {
  await page.addInitScript((inset) => {
    const apply = () =>
      document.documentElement.style.setProperty('--safe-bottom', `${inset}px`);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply, { once: true });
    } else {
      apply();
    }
  }, PHONE_SAFE_AREA_BOTTOM_PX);
  await page.goto('/connections/models/new');
  await dismissSetupLauncher(page);
  await expect(page.locator('.provider-picker-modal')).toBeVisible({
    timeout: 30_000,
  });
  // The premise: a device inset the product actually reads. Without it the
  // measurements below prove nothing.
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--safe-bottom')
          .trim(),
      ),
    )
    .toBe(`${PHONE_SAFE_AREA_BOTTOM_PX}px`);
}

test.describe('The chat dock leaves room for the route beneath it at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('the last provider tile is the thing a tap on it reaches', async ({
    page,
  }) => {
    await openProviderPickerOnAPhone(page);

    const measurement = await page.evaluate(() => {
      const dock = document.querySelector('.chat-dock');
      const tiles = [
        ...document.querySelectorAll(
          '.provider-picker-modal .provider-overview__quickstart-btn',
        ),
      ];
      if (!dock || tiles.length === 0) return null;
      // Scroll whichever ancestor actually scrolls to its end: the tile a
      // reader has to reach past the dock is the LAST one.
      let scroller: Element | null = tiles[tiles.length - 1];
      while (scroller && scroller !== document.body) {
        if (scroller.scrollHeight > scroller.clientHeight + 1) break;
        scroller = scroller.parentElement;
      }
      if (scroller && scroller !== document.body) {
        scroller.scrollTop = scroller.scrollHeight;
      }
      return new Promise<{
        dockTop: number;
        dockHeight: number;
        tile: { top: number; bottom: number; height: number };
        hit: string | null;
        tileOwnsHit: boolean;
      }>((resolve) => {
        requestAnimationFrame(() => {
          const tile = tiles[tiles.length - 1];
          const rect = tile.getBoundingClientRect();
          const dockRect = dock.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          resolve({
            dockTop: dockRect.top,
            dockHeight: dockRect.height,
            tile: { top: rect.top, bottom: rect.bottom, height: rect.height },
            hit: hit
              ? typeof hit.className === 'string' && hit.className
                ? `${hit.tagName.toLowerCase()}.${hit.className.split(' ')[0]}`
                : hit.tagName
              : null,
            tileOwnsHit: !!hit && tile.contains(hit),
          });
        });
      });
    });

    expect(measurement, 'the provider picker must render tiles').not.toBeNull();
    const found = measurement as NonNullable<typeof measurement>;
    // Named separately from the hit test: when this reddens, the failure text
    // says WHICH element took the tap, which is the whole diagnosis.
    expect(found.tileOwnsHit, JSON.stringify(found)).toBe(true);
    expect(found.tile.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    // And the tile is genuinely clear of the dock, not merely scrolled to a
    // spot where the centre happens to miss it.
    expect(found.tile.bottom, JSON.stringify(found)).toBeLessThanOrEqual(
      found.dockTop + 1,
    );
  });

  test('the shell reserves the dock it renders, insets and all', async ({
    page,
  }) => {
    await openProviderPickerOnAPhone(page);

    const shell = await page.evaluate(() => {
      const view = document.querySelector('.content-view');
      const dock = document.querySelector('.chat-dock');
      if (!view || !dock) return null;
      const rect = view.getBoundingClientRect();
      const reserved = Number.parseFloat(
        getComputedStyle(view).paddingBottom || '0',
      );
      return {
        reserved,
        contentEndsAt: rect.bottom - reserved,
        dockTop: dock.getBoundingClientRect().top,
        dockHeight: dock.getBoundingClientRect().height,
        documentScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });

    expect(shell, 'the shell must render its route outlet').not.toBeNull();
    const found = shell as NonNullable<typeof shell>;
    // The reservation is what the dock actually occupies, not what
    // `--dock-slot-size` alone says: on this device those differ by the
    // 34px inset, and that difference was the defect.
    expect(found.reserved, JSON.stringify(found)).toBeGreaterThanOrEqual(
      found.dockHeight,
    );
    expect(found.contentEndsAt, JSON.stringify(found)).toBeLessThanOrEqual(
      found.dockTop + 1,
    );
    expect(found.documentScrollWidth).toBeLessThanOrEqual(found.innerWidth);
  });
});
