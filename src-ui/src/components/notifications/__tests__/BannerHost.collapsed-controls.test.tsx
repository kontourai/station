/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { act, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';
import { bannerStore } from '../../../contexts/banner-store';
import { BannerHost } from '../BannerHost';

/**
 * archive#4470 — the collapsed-banner acceptance the
 * three-action identity-mismatch banner failed against a real, cascade-
 * resolved layout: `.banner-host__action` is `flex: none` inside
 * `.banner-host__actions`, which has no `flex-wrap`, and the collapsed card
 * is a fixed `--banner-collapsed-height` (52px) with `overflow: hidden`
 * (BannerHost.css) — three non-shrinkable action buttons plus the
 * chevron/dismiss controls do not fit that row at 390px: the message column
 * clips to 0px width and the third action pushes chevron/dismiss past the
 * clipped edge, unreachable for the rest of the session (the 's
 * probe measured this against the pre-fix three-action set).
 *
 * Fixed by dropping to two actions (archive#4470's fix, mirrored by
 * ConnectionBannerSource.test.tsx's jsdom-level assertion of the exact
 * action list) — this is the real-layout proof the acceptance asked for:
 * render the actual `BannerHost` with the actual two-action shape, force it
 * collapsed, and at a real 390x844 Chromium page assert every control
 * (message, both actions, chevron, dismiss) is visible with a nonzero
 * clipped-safe box AND real-hit-testable (`elementFromPoint` at its own
 * center resolves back to itself, not something clipped in front of it).
 * Compares against the authentication-failed two-action shape too — "the
 * authentication-failed two-action banner proves it" — so a
 * future regression narrowing to one shared fixture cannot silently stop
 * covering the other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const BANNER_CSS_PATH = resolve(HERE, '../BannerHost.css');

function buildFixtureCss(): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(BANNER_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return css;
}

function renderCollapsedFixtureMarkup(input: {
  id: string;
  message: string;
  actionLabels: readonly string[];
}): string {
  act(() => {
    bannerStore.present({
      id: input.id,
      priority: 100,
      tone: 'error',
      message: input.message,
      dismissible: true,
      dismissAriaLabel: 'Dismiss connection notice',
      actions: input.actionLabels.map((label) => ({
        label,
        variant: 'danger' as const,
        onClick: () => {},
      })),
    });
    bannerStore.setCollapsed(input.id, true);
  });
  const { container, unmount } = render(<BannerHost connectionSlot={false} />);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

/**
 * archive#4470 — the armed "Remove" confirm renders THREE
 * actions ("Pair again"/"Confirm"/"Cancel"), which only ever appear once
 * arming has force-expanded the card (ConnectionBannerSource.tsx) — never
 * collapsed, so this deliberately does NOT call `setCollapsed`.
 */
function renderExpandedFixtureMarkup(input: {
  id: string;
  message: string;
  actionLabels: readonly string[];
}): string {
  act(() => {
    bannerStore.present({
      id: input.id,
      priority: 100,
      tone: 'error',
      message: input.message,
      dismissible: true,
      dismissAriaLabel: 'Dismiss connection notice',
      actions: input.actionLabels.map((label) => ({
        label,
        variant: label === 'Confirm' ? ('danger' as const) : undefined,
        onClick: () => {},
      })),
    });
  });
  const { container, unmount } = render(<BannerHost connectionSlot={false} />);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

function buildFixtureHtml(markup: string): string {
  const css = buildFixtureCss();
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${css}</style>
  </head>
  <body style="margin:0">${markup}</body>
</html>`;
}

type Box = { x: number; y: number; width: number; height: number };

// A real clip failure (what this file exists to catch) displaces a control
// by tens of pixels — a whole wrapped row, or a button pushed off the card
// entirely. 2px tolerates ordinary Chromium subpixel/font-hinting rounding
// under concurrent load (observed: a lone run of this file measures exact
// integer boxes; run alongside this repo's other real-Chromium geometry
// tests it can drift ~1px, matching this repo's own documented "shared-host
// sibling sessions are the dominant flake source" — see CLAUDE.md) without
// coming anywhere near masking the tens-of-pixels failures this test is
// built to catch.
function within(inner: Box, outer: Box, epsilon = 2): boolean {
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon
  );
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'BannerHost collapsed-card controls stay visible and hittable at a phone viewport (station#4470 H2)',
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

    test.each([
      [
        'identity-mismatch shape (two actions)',
        'identity-mismatch-collapsed',
        "The Station at station-nightly.example.ts.net isn't the one this device paired with.",
        ['Pair again', 'Remove'],
      ],
      [
        'authentication-failed shape (two actions, the established baseline)',
        'auth-failed-collapsed',
        "Tailnet Station isn't accepting this device's credential.",
        ['Pair again', 'Try now'],
      ],
    ] as const)(
      'every control clears the collapsed clip and hit-tests to itself — %s',
      async (_label, id, message, actionLabels) => {
        const markup = renderCollapsedFixtureMarkup({
          id,
          message,
          actionLabels,
        });
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        try {
          await page.setContent(buildFixtureHtml(markup));

          const item = page.locator('.banner-host__item');
          expect(await item.getAttribute('data-collapsed')).toBe('true');
          const itemBox = await item.boundingBox();
          expect(itemBox, '.banner-host__item not visible').not.toBe(null);
          // The whole point of the collapsed height: one fixed-height bar.
          expect(itemBox!.height).toBeCloseTo(52, 0);

          const messageBox = await page
            .locator('.banner-host__message')
            .boundingBox();
          expect(messageBox, '.banner-host__message not visible').not.toBe(
            null,
          );
          expect(
            messageBox!.width,
            'message column clipped to zero width',
          ).toBeGreaterThan(20);
          expect(within(messageBox!, itemBox!)).toBe(true);

          const actionBoxes = await page.locator('.banner-host__action').all();
          expect(actionBoxes).toHaveLength(actionLabels.length);
          for (const [i, locator] of actionBoxes.entries()) {
            const box = await locator.boundingBox();
            expect(box, `action "${actionLabels[i]}" not visible`).not.toBe(
              null,
            );
            expect(
              within(box!, itemBox!),
              `action "${actionLabels[i]}" ${JSON.stringify(box)} not within the collapsed card ${JSON.stringify(itemBox)}`,
            ).toBe(true);
            const cx = box!.x + box!.width / 2;
            const cy = box!.y + box!.height / 2;
            const hit = await page.evaluate(
              ([cx, cy]) =>
                document.elementFromPoint(cx, cy)?.closest('button')
                  ?.textContent ?? null,
              [cx, cy] as [number, number],
            );
            expect(hit, `action "${actionLabels[i]}" not hittable`).toBe(
              actionLabels[i],
            );
          }

          for (const [testId, selector] of [
            ['chevron', '.banner-host__collapse'],
            ['dismiss', '.banner-host__dismiss'],
          ] as const) {
            const locator = page.locator(selector);
            const box = await locator.boundingBox();
            expect(box, `${testId} control not visible`).not.toBe(null);
            expect(
              within(box!, itemBox!),
              `${testId} ${JSON.stringify(box)} not within the collapsed card ${JSON.stringify(itemBox)}`,
            ).toBe(true);
            const cx = box!.x + box!.width / 2;
            const cy = box!.y + box!.height / 2;
            const hitSelector = await page.evaluate(
              ([cx, cy, selector]) =>
                document
                  .elementFromPoint(cx as number, cy as number)
                  ?.closest(selector as string) !== null,
              [cx, cy, selector] as [number, number, string],
            );
            expect(hitSelector, `${testId} control not hittable`).toBe(true);
          }
        } finally {
          await page.close();
        }
      },
    );

    /**
     * archive#4470 — the armed "Remove" confirm's three
     * actions ("Pair again"/"Confirm"/"Cancel") render in the row's
     * EXPANDED width (~345px) rather than the collapsed bar's constrained
     * ~244px: arming force-expands a collapsed card, and
     * closed the remaining way an armed card could still end up collapsed
     * collapsing the chevron while armed now disarms
     * (ConnectionBannerSource.tsx's `onCollapse`) instead of leaving this
     * row reachable behind the 52px bar. Proves the three-button row fits
     * on one line, unclipped and hittable, at 390px.
     */
    test('the armed three-action row (Pair again / Confirm / Cancel) fits on one line, expanded, at 390px', async () => {
      const actionLabels = ['Pair again', 'Confirm', 'Cancel'] as const;
      const markup = renderExpandedFixtureMarkup({
        id: 'identity-mismatch-armed',
        message:
          "The Station at station-nightly.example.ts.net isn't the one this device paired with.",
        actionLabels,
      });
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      try {
        await page.setContent(buildFixtureHtml(markup));

        const item = page.locator('.banner-host__item');
        expect(await item.getAttribute('data-collapsed')).toBe(null);
        const itemBox = await item.boundingBox();
        expect(itemBox, '.banner-host__item not visible').not.toBe(null);

        const actionsRow = await page
          .locator('.banner-host__actions')
          .boundingBox();
        expect(actionsRow, '.banner-host__actions not visible').not.toBe(null);
        // Single line: three actions did not wrap to a second row (the
        // failure mode). One row of 44px-tall buttons is ~44px tall, not
        // ~96px (two wrapped rows) or ~140px (three).
        expect(actionsRow!.height).toBeLessThan(60);

        const actionBoxes = await page.locator('.banner-host__action').all();
        expect(actionBoxes).toHaveLength(actionLabels.length);
        for (const [i, locator] of actionBoxes.entries()) {
          const box = await locator.boundingBox();
          expect(box, `action "${actionLabels[i]}" not visible`).not.toBe(null);
          expect(
            within(box!, itemBox!),
            `action "${actionLabels[i]}" ${JSON.stringify(box)} not within the card ${JSON.stringify(itemBox)}`,
          ).toBe(true);
          const cx = box!.x + box!.width / 2;
          const cy = box!.y + box!.height / 2;
          const hit = await page.evaluate(
            ([cx, cy]) =>
              document.elementFromPoint(cx, cy)?.closest('button')
                ?.textContent ?? null,
            [cx, cy] as [number, number],
          );
          expect(hit, `action "${actionLabels[i]}" not hittable`).toBe(
            actionLabels[i],
          );
        }
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'BannerHost collapsed-card controls — Chromium not installed, cannot verify (station#4470 H2)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'collapsed-banner control fix (station#4470 H2) could not be ' +
        'checked — this is a missing precondition, not a passing check. ' +
        'Install it with `npm run install:playwright` and re-run.',
    );
  },
);
